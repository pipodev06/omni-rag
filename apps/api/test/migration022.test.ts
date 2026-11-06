import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** La migración 022 se ejercita con una base real en settings.integration.test.ts; aquí se fija su forma. */
describe("migración 022: ajustes guardados con doble conversión a JSON", () => {
  const sql = readFileSync(join(__dirname, "../src/db/migrations/022_ajustes_json.sql"), "utf8");

  it("desenvuelve un nivel solo los textos JSON cuyo contenido es un valor JSON", () => {
    expect(sql).toMatch(/SET value = \(value #>> '\{\}'\)::jsonb/);
    expect(sql).toMatch(/jsonb_typeof\(value\) = 'string'/);
    expect(sql).toMatch(/\(value #>> '\{\}'\) IS JSON SCALAR/);
  });

  it("no toca los secretos", () => {
    expect(sql).toMatch(/WHERE value IS NOT NULL/);
    expect(sql).not.toMatch(/\bsecret\s*=/);
  });
});
