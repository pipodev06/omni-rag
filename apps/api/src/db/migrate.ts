import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { config } from "../config.js";

/**
 * Migraciones simples basadas en archivos SQL numerados (001_*.sql, 002_*.sql…).
 * Cada archivo se aplica una sola vez, dentro de una transacción, y queda
 * registrado en la tabla `schema_migrations`.
 *
 * Antes de migrar se crea (o actualiza) el usuario `rag_app` con APP_DB_PASSWORD.
 */
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

const GRANTS = `
  GRANT USAGE ON SCHEMA public TO rag_app;
  GRANT SELECT ON tenants TO rag_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON
    users, collections, collection_members, documents, chunks,
    conversations, messages, usage_events, answer_cache, message_feedback
  TO rag_app;
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO rag_app;
  GRANT SELECT ON audit_log TO rag_app;
  REVOKE ALL ON FUNCTION app_can_access_collection(uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION app_can_access_collection(uuid) TO rag_app;
`;

const quoteLiteral = (s: string) => `'${s.replaceAll("'", "''")}'`;

export function renderMigration(sqlText: string): string {
  if (!/^[a-z_]+$/.test(config.FTS_LANGUAGE)) throw new Error("FTS_LANGUAGE inválido");
  return sqlText
    .replaceAll("{{EMBEDDING_DIM}}", String(config.EMBEDDING_DIM))
    .replaceAll("{{FTS_LANGUAGE}}", config.FTS_LANGUAGE)
    .replaceAll("{{LLM_MODELS}}", config.LLM_MODELS.replaceAll("'", "''"))
    .replaceAll("{{TENANT_DAILY_QUESTION_LIMIT}}", String(config.TENANT_DAILY_QUESTION_LIMIT));
}

export async function migrate(): Promise<string[]> {
  const sql = postgres(config.DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    // Evita que dos procesos (api y worker) migren a la vez.
    try {
      await sql`SELECT pg_advisory_lock(727274)`;
    } catch (err) {
      // La base conserva la contraseña con la que se creó el volumen: si el .env cambió después, no coinciden.
      if ((err as { code?: string }).code === "28P01") {
        throw new Error(
          "La base de datos rechazó la contraseña de POSTGRES_PASSWORD (la base conserva la que tenía al crearse). " +
            "Iguálala con: docker compose exec -T db sh < deploy/sync-db-password.sh   y luego: docker compose up -d api worker backup",
        );
      }
      throw err;
    }

    const [role] = await sql`SELECT 1 FROM pg_roles WHERE rolname = 'rag_app'`;
    const verb = role ? "ALTER" : "CREATE";
    await sql.unsafe(
      `${verb} ROLE rag_app WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${quoteLiteral(config.APP_DB_PASSWORD)}`,
    );

    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`;
    const done = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));

    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const text = renderMigration(await readFile(path.join(dir, file), "utf8"));
      await sql.begin(async (tx) => {
        await tx.unsafe(text);
        await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      });
      applied.push(file);
      console.log(`[migrate] aplicada ${file}`);
    }
    // Permisos de `rag_app`: se reaplican siempre (idempotente). Así funcionan
    // también tras restaurar una copia de seguridad en un servidor nuevo.
    await sql.unsafe(GRANTS);
    if (applied.length === 0) console.log("[migrate] la base de datos ya está al día");
    return applied;
  } finally {
    await sql`SELECT pg_advisory_unlock(727274)`.catch(() => {});
    await sql.end({ timeout: 5 });
  }
}

// Ejecutado directamente: `pnpm migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate().catch((err) => {
    console.error("[migrate] error:", err);
    process.exit(1);
  });
}
