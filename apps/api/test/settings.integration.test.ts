/**
 * Ajustes contra PostgreSQL real: el driver convierte a JSON por su cuenta y una columna jsonb no se puede simular del
 * todo (settings.test.ts usa una tabla en memoria). Se ejecuta solo con base de prueba, como rls.integration.test.ts:
 *   RUN_DB_TESTS=1 DATABASE_URL=... APP_DATABASE_URL=... APP_DB_PASSWORD=... pnpm test
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "./env.js";

const enabled = process.env.RUN_DB_TESTS === "1";

describe.skipIf(!enabled)("ajustes en PostgreSQL real", async () => {
  const { migrate } = await import("../src/db/migrate.js");
  const { sqlOwner, closeDb } = await import("../src/db/client.js");
  const settings = await import("../src/lib/settings.js");
  const tag = Date.now().toString(36).toUpperCase();
  const k = (name: string) => `ZZ_PRUEBA_${tag}_${name}`;

  beforeAll(async () => {
    await migrate();
  });

  afterAll(async () => {
    await sqlOwner`DELETE FROM settings WHERE key LIKE ${`ZZ_PRUEBA_${tag}_%`} OR key IN ('WEB_SEARCH_PROVIDER', 'HISTORY_MESSAGES', 'SMTP_SECURE')`;
    await closeDb();
  });

  it("lo guardado desde la pantalla queda como valor JSON y se lee igual (sin doble conversión)", async () => {
    for (const key of ["WEB_SEARCH_PROVIDER", "HISTORY_MESSAGES", "SMTP_SECURE"]) delete process.env[key];
    await settings.refreshSettings();
    await settings.applySettings({ WEB_SEARCH_PROVIDER: "tavily", HISTORY_MESSAGES: 4, SMTP_SECURE: true }, "prueba");

    const rows = await sqlOwner<{ key: string; t: string; v: string }[]>`
      SELECT key, jsonb_typeof(value) AS t, value #>> '{}' AS v FROM settings WHERE key IN ('WEB_SEARCH_PROVIDER', 'HISTORY_MESSAGES', 'SMTP_SECURE') ORDER BY key`;
    expect(rows).toEqual([
      { key: "HISTORY_MESSAGES", t: "number", v: "4" },
      { key: "SMTP_SECURE", t: "boolean", v: "true" },
      { key: "WEB_SEARCH_PROVIDER", t: "string", v: "tavily" },
    ]);
    await settings.refreshSettings();
    expect(settings.setting("WEB_SEARCH_PROVIDER")).toBe("tavily");
    expect(settings.setting("HISTORY_MESSAGES")).toBe(4);
  });

  it("la migración 022 desenvuelve las filas con doble conversión y deja intacto un texto bien guardado", async () => {
    // Filas como las dejaba la versión con JSON.stringify(...)::jsonb, más una ruta bien guardada (como la de backup.sh).
    await sqlOwner`
      INSERT INTO settings (key, value) VALUES
        (${k("TEXTO")}, to_jsonb('"tavily"'::text)),
        (${k("HORA")}, to_jsonb('"03:00"'::text)),
        (${k("NUMERO")}, to_jsonb('9'::text)),
        (${k("BOOLEANO")}, to_jsonb('false'::text)),
        (${k("BIEN")}, to_jsonb('/backups-targets/disco'::text))`;

    const fix = readFileSync(join(__dirname, "../src/db/migrations/022_ajustes_json.sql"), "utf8");
    await sqlOwner.unsafe(fix);

    const rows = await sqlOwner<{ key: string; t: string; v: string }[]>`
      SELECT key, jsonb_typeof(value) AS t, value #>> '{}' AS v FROM settings WHERE key LIKE ${`ZZ_PRUEBA_${tag}_%`} ORDER BY key`;
    const byName = Object.fromEntries(rows.map((r) => [r.key.slice(`ZZ_PRUEBA_${tag}_`.length), { t: r.t, v: r.v }]));
    expect(byName).toEqual({
      TEXTO: { t: "string", v: "tavily" },
      HORA: { t: "string", v: "03:00" },
      NUMERO: { t: "number", v: "9" },
      BOOLEANO: { t: "boolean", v: "false" },
      BIEN: { t: "string", v: "/backups-targets/disco" },
    });

    // Aplicarla otra vez no cambia nada: lo ya reparado no es texto JSON con un valor JSON dentro.
    await sqlOwner.unsafe(fix);
    const again = await sqlOwner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM settings WHERE key LIKE ${`ZZ_PRUEBA_${tag}_%`} AND jsonb_typeof(value) = 'string' AND value #>> '{}' IN ('tavily', '03:00', '/backups-targets/disco')`;
    expect(again[0]!.n).toBe(3);
  });
});
