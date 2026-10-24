import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// deploy/autotune.sh calcula los límites de CPU y memoria según el hardware. Se prueba con --simular (no toca el sistema ni el .env).
const script = resolve(__dirname, "../../../deploy/autotune.sh").split(String.fromCharCode(92)).join("/");
const hasBash = spawnSync("bash", ["--version"]).status === 0;

const run = (...args: string[]) => spawnSync("bash", [script, ...args], { encoding: "utf8" }).stdout;
const value = (out: string, key: string) => out.match(new RegExp(String.raw`^\s+${key}=(.*)$`, "m"))?.[1];

describe.skipIf(!hasBash)("deploy/autotune.sh", () => {
  it("servidor compartido (14 GB, 6 núcleos / 12 hilos): deja núcleos a los demás y conserva el re-ranker", () => {
    const out = run("--simular=ram=14,hilos=12,nucleos=6,otros=2300");
    expect(out).toContain("modo COMPARTIDO");
    expect(value(out, "RERANKER_CPUS")).toBe("4"); // ≈ dos tercios de los núcleos reales, no los 12 hilos
    expect(value(out, "RERANKER_CPU_SHARES")).toBe("512"); // cede CPU a los otros servicios
    expect(value(out, "DOCLING_OOM_SCORE_ADJ")).toBe("500");
    expect(out).not.toMatch(/^\s+RERANKER_URL=/m);
    expect(out).toContain("CABE");
  });

  it("VPS dedicado de 8 GB y 4 vCPU: mantiene el re-ranker y recorta embeddings y Docling para caber", () => {
    const out = run("--simular=ram=8,hilos=4,nucleos=4");
    expect(out).toContain("modo DEDICADO");
    expect(value(out, "RERANKER_CPUS")).toBe("2");
    expect(value(out, "EMBEDDINGS_CPUS")).toBe("1");
    expect(Number(value(out, "DOCLING_MEM_LIMIT")?.replace("m", ""))).toBeLessThan(3800);
    expect(out).toContain("Docling queda limitado"); // avisa de que un PDF muy grande puede fallar
    expect(out).not.toContain("NO CABE");
  });

  it("con más RAM y núcleos dedicados convierte dos documentos a la vez", () => {
    const out = run("--simular=ram=32,hilos=16,nucleos=8");
    expect(value(out, "DOCLING_WORKERS")).toBe("2");
  });

  it("avisa cuando no cabe y solo quita el re-ranker si se pide", () => {
    const out = run("--simular=ram=4,hilos=2");
    expect(out).toContain("NO CABE");
    expect(out).not.toMatch(/^\s+RERANKER_URL=/m);
    const sin = run("--simular=ram=4,hilos=2", "--sin-reranker");
    expect(sin).toMatch(/^\s+RERANKER_REPLICAS=0$/m);
  });

  it("rechaza parámetros de simulación desconocidos", () => {
    expect(run("--simular=gpu=1,ram=8,hilos=4")).toContain("desconocido");
  });
});
