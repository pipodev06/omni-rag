import { config } from "./config.js";
import { sqlOwner } from "./db/client.js";

export const MAINTENANCE_QUEUE = "mantenimiento";

/**
 * Limpieza periódica (la programa el worker una vez al día):
 *  - auditoría más antigua que AUDIT_RETENTION_DAYS;
 *  - enlaces de invitación/restablecimiento usados o caducados hace más de 7 días;
 *  - respuestas en caché más antiguas que CACHE_TTL_HOURS (ya no se usarían).
 */
export async function runMaintenance() {
  const audit = await sqlOwner`
    DELETE FROM audit_log WHERE created_at < now() - ${`${config.AUDIT_RETENTION_DAYS} days`}::interval RETURNING id`;
  const tokens = await sqlOwner`
    DELETE FROM user_tokens
     WHERE (used_at IS NOT NULL OR expires_at < now()) AND created_at < now() - interval '7 days' RETURNING id`;
  const cache = await sqlOwner`
    DELETE FROM answer_cache WHERE created_at < now() - ${`${config.CACHE_TTL_HOURS} hours`}::interval RETURNING id`;
  return { auditDeleted: audit.length, tokensDeleted: tokens.length, cacheDeleted: cache.length };
}
