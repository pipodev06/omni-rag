import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { createApp } from "./app.js";
import { closeDb } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { getBoss, stopBoss } from "./queue.js";
import { ensureInitialAdmin, setupPending } from "./scripts/bootstrap.js";
import { announceSetupCode, clearSetupCode, reprintSetupCode } from "./lib/setupCode.js";
import { installLogger } from "./lib/logger.js";
import { startSettingsRefresh } from "./lib/settings.js";

installLogger();

async function main() {
  await migrate();
  await ensureInitialAdmin();
  // Sin usuarios: la web muestra la configuración inicial, que pide este código (sale en los registros).
  if (await setupPending()) {
    announceSetupCode();
    // Se repite cada 10 minutos mientras falte configurar, para que no se pierda entre otros registros.
    const timer = setInterval(() => {
      void setupPending()
        .then((pending) => {
          if (pending) return reprintSetupCode();
          clearSetupCode();
          clearInterval(timer);
        })
        .catch(() => {});
    }, 10 * 60_000);
    timer.unref();
  }
  await startSettingsRefresh();
  await getBoss(); // prepara la cola para poder encolar documentos

  const server = serve({ fetch: createApp().fetch, port: config.PORT, hostname: "0.0.0.0" }, (info) =>
    console.log(`[api] escuchando en http://localhost:${info.port}`),
  );

  const shutdown = async (signal: string) => {
    console.log(`[api] ${signal} recibido, cerrando…`);
    server.close();
    await stopBoss().catch(() => {});
    await closeDb().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[api] error fatal al arrancar:", err);
  process.exit(1);
});
