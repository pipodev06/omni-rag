import { closeDb, sqlOwner } from "../db/client.js";
import { enqueueIngest, stopBoss } from "../queue.js";

/**
 * Vuelve a procesar documentos (p. ej. tras cambiar el modelo de embeddings
 * o los parámetros de fragmentación).
 *
 *   pnpm reindex                 → todos los documentos
 *   pnpm reindex <slug>          → solo los de una organización
 *   pnpm reindex --failed        → solo los que fallaron
 *
 * En Docker:  docker compose exec api node dist/scripts/reindex.js [slug|--failed]
 */
const arg = process.argv[2];
const onlyFailed = arg === "--failed";
const slug = arg && !onlyFailed ? arg : null;

const docs = await sqlOwner<{ id: string; tenant_id: string }[]>`
  SELECT d.id, d.tenant_id FROM documents d JOIN tenants t ON t.id = d.tenant_id
   WHERE d.deleted_at IS NULL AND (${slug}::text IS NULL OR t.slug = ${slug})
     AND (${onlyFailed} = false OR d.status = 'failed')`;

for (const d of docs) {
  await sqlOwner`UPDATE documents SET status = 'pending', error = NULL, updated_at = now() WHERE id = ${d.id}`;
  await enqueueIngest({ tenantId: d.tenant_id, documentId: d.id });
}
console.log(`[reindex] ${docs.length} documento(s) en cola. Sigue el progreso con: docker compose logs -f worker`);
await stopBoss();
await closeDb();
