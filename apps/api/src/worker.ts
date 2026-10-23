import { closeDb } from "./db/client.js";
import { MAINTENANCE_QUEUE, runMaintenance } from "./maintenance.js";
import { migrate } from "./db/migrate.js";
import { ingestDocument, markIngestError } from "./ingest/pipeline.js";
import { runMonitor } from "./lib/monitor.js";
import { getBoss, INGEST_QUEUE, INGEST_RETRY_LIMIT, stopBoss, type IngestJob } from "./queue.js";
import { installLogger } from "./lib/logger.js";

installLogger();

/**
 * Proceso worker: toma documentos de la cola y los indexa.
 * Se ejecuta como contenedor separado para que el procesamiento pesado
 * (OCR, embeddings) no haga lenta la API.
 */
const MONITOR_QUEUE = "monitor";
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 2);

async function main() {
  await migrate();
  const boss = await getBoss();

  await boss.work<IngestJob>(INGEST_QUEUE, { batchSize: 1, localConcurrency: concurrency }, async ([job]) => {
    if (!job) return;
    const { tenantId, documentId } = job.data;
    try {
      return await ingestDocument(tenantId, documentId, job.signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const willRetry = job.retryCount < INGEST_RETRY_LIMIT;
      console.error(`[ingest] error en documento ${documentId} (intento ${job.retryCount + 1}):`, message);
      await markIngestError(tenantId, documentId, message, willRetry).catch((e) =>
        console.error("[ingest] no se pudo guardar el error:", e),
      );
      if (willRetry) throw err; // pg-boss lo reintentará
      return { error: message };
    }
  });

  // Mantenimiento diario (03:15 UTC): limpia datos caducados.
  await boss.createQueue(MAINTENANCE_QUEUE);
  await boss.schedule(MAINTENANCE_QUEUE, "15 3 * * *");
  await boss.work(MAINTENANCE_QUEUE, async () => {
    const result = await runMaintenance();
    console.log("[mantenimiento]", JSON.stringify(result));
    return result;
  });

  // Monitorización cada 5 minutos: disco, cola, copias de seguridad y errores del modelo (avisa por correo si hay ALERT_EMAIL).
  await boss.createQueue(MONITOR_QUEUE);
  await boss.schedule(MONITOR_QUEUE, "*/5 * * * *");
  await boss.work(MONITOR_QUEUE, async () => {
    const result = await runMonitor();
    if (result.opened.length || result.reminded.length || result.resolved.length) console.log("[monitor]", JSON.stringify(result));
    return result;
  });

  console.log(`[worker] escuchando la cola "${INGEST_QUEUE}" (concurrencia ${concurrency})`);
}

async function shutdown(signal: string) {
  console.log(`[worker] ${signal} recibido, cerrando…`);
  await stopBoss().catch(() => {});
  await closeDb().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((err) => {
  console.error("[worker] error fatal:", err);
  process.exit(1);
});
