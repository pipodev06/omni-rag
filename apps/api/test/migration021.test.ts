import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** El índice único parcial de la migración 021 solo se puede ejercitar con una base real (rls.integration); aquí se fija su forma. */
describe("migración 021: una sola orden de copias abierta", () => {
  const sql = readFileSync(join(__dirname, "../src/db/migrations/021_ordenes_unicas.sql"), "utf8");

  it("crea un índice único parcial sobre las órdenes sin terminar", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX backup_requests_una_abierta ON backup_requests \(\(true\)\) WHERE finished_at IS NULL;/);
  });

  it("antes de crearlo cierra las sobrantes (deja la más reciente) para que no falle con datos existentes", () => {
    const fix = sql.indexOf("UPDATE backup_requests");
    expect(fix).toBeGreaterThan(-1);
    expect(fix).toBeLessThan(sql.indexOf("CREATE UNIQUE INDEX"));
    expect(sql).toContain("max(id)");
  });
});
