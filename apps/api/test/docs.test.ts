import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Regla del proyecto: toda variable de configuración nueva se documenta en docs/variables.md y en .env.example.
const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("documentación de variables de entorno", () => {
  const keys = [...read("apps/api/src/config.ts").matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!);

  it("encuentra las variables de config.ts", () => {
    expect(keys.length).toBeGreaterThan(50);
  });

  it("todas aparecen en docs/variables.md", () => {
    const doc = read("docs/variables.md");
    expect(keys.filter((k) => !new RegExp(String.raw`\b${k}\b`).test(doc))).toEqual([]);
  });

  it("todas las que se pueden configurar aparecen en .env.example (salvo las internas que fija docker-compose)", () => {
    const internal = new Set(["NODE_ENV", "PORT", "DATABASE_URL", "APP_DATABASE_URL", "STORAGE_DIR", "DOCLING_URL", "EMBEDDINGS_URL"]);
    const example = read(".env.example");
    expect(keys.filter((k) => !internal.has(k) && !new RegExp(String.raw`^#?\s*${k}=`, "m").test(example))).toEqual([]);
  });
});
