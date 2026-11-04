import { describe, expect, it, vi } from "vitest";
import "./env.js";

/** Mantenimiento: borra las órdenes de copias terminadas hace más de 90 días (y solo esas). */
const queries: string[] = [];
vi.mock("../src/db/client.js", () => ({
  sqlOwner: (strings: TemplateStringsArray) => {
    queries.push(strings.join("?").replace(/\s+/g, " ").trim());
    return Promise.resolve(Object.assign([], { count: 0 }));
  },
}));
vi.mock("../src/storage/local.js", () => ({ removeStored: async () => {} }));
vi.mock("../src/lib/settings.js", () => ({
  setting: (k: string) => ({ AUDIT_RETENTION_DAYS: 365, CACHE_TTL_HOURS: 168, TRASH_RETENTION_DAYS: 30, METRICS_RETENTION_DAYS: 14 })[k],
}));

describe("runMaintenance: órdenes de copias", () => {
  it("borra backup_requests terminadas de más de 90 días y nunca las que siguen abiertas", async () => {
    const { runMaintenance } = await import("../src/maintenance.js");
    await runMaintenance();
    const q = queries.find((x) => x.startsWith("DELETE FROM backup_requests"));
    expect(q).toBeDefined();
    expect(q).toContain("finished_at IS NOT NULL");
    expect(q).toContain("interval '90 days'");
  });
});
