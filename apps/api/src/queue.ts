import { PgBoss } from "pg-boss";
import { config } from "./config.js";

/**
 * Cola de trabajos en segundo plano usando pg-boss (guarda los trabajos en
 * PostgreSQL, en el esquema `pgboss`; no hace falta Redis).
 */
export const INGEST_QUEUE = "ingest-document";
export const INGEST_RETRY_LIMIT = 2;

export interface IngestJob {
  tenantId: string;
  documentId: string;
}

let boss: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  const instance = new PgBoss({ connectionString: config.DATABASE_URL, max: 4 });
  instance.on("error", (err) => console.error("[queue] error:", err));
  await instance.start();
  await instance.createQueue(INGEST_QUEUE, {
    retryLimit: INGEST_RETRY_LIMIT,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: config.DOCLING_TIMEOUT_SECONDS + 600,
  });
  boss = instance;
  return instance;
}

export async function enqueueIngest(job: IngestJob): Promise<void> {
  const b = await getBoss();
  await b.send(INGEST_QUEUE, job);
}

export async function stopBoss(): Promise<void> {
  if (boss) await boss.stop({ graceful: true });
  boss = null;
}
