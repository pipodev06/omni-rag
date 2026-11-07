import { describe, expect, it } from "vitest";
import "./env.js";
import { Hono } from "hono";
import { signSession } from "../src/auth/jwt.js";
import { HttpError } from "../src/lib/errors.js";
import { ipRateLimit } from "../src/lib/ipLimit.js";
import { buildLine, splitLogArgs, withRequestId } from "../src/lib/logger.js";
import { twoFactorRequired } from "../src/lib/limits.js";

function appWith(max: number) {
  const app = new Hono();
  app.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status) : c.json({ error: "x" }, 500)));
  app.use("*", ipRateLimit(max));
  app.get("/api/ping", (c) => c.text("ok"));
  app.get("/api/health", (c) => c.text("ok"));
  return app;
}
const from = (ip: string, headers: Record<string, string> = {}) => ({ headers: { "x-real-ip": ip, ...headers } });

describe("límite global por IP", () => {
  it("corta a una IP sin sesión al superar el tope y no afecta a otra", async () => {
    const app = appWith(3);
    for (let i = 0; i < 3; i++) expect((await app.request("/api/ping", from("1.1.1.1"))).status).toBe(200);
    const blocked = await app.request("/api/ping", from("1.1.1.1"));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect((await app.request("/api/ping", from("2.2.2.2"))).status).toBe(200);
  });

  it("no cuenta las peticiones con una sesión válida", async () => {
    const app = appWith(2);
    const token = await signSession({ userId: "u", tenantId: "t", role: "admin" });
    for (let i = 0; i < 10; i++) expect((await app.request("/api/ping", from("3.3.3.3", { authorization: `Bearer ${token}` }))).status).toBe(200);
  });

  it("un token falso no esquiva el límite", async () => {
    const app = appWith(2);
    for (let i = 0; i < 2; i++) await app.request("/api/ping", from("4.4.4.4", { authorization: "Bearer falso" }));
    expect((await app.request("/api/ping", from("4.4.4.4", { authorization: "Bearer falso" }))).status).toBe(429);
  });

  it("deja pasar siempre /api/health y con 0 se desactiva", async () => {
    const app = appWith(1);
    for (let i = 0; i < 5; i++) expect((await app.request("/api/health", from("5.5.5.5"))).status).toBe(200);
    const off = appWith(0);
    for (let i = 0; i < 5; i++) expect((await off.request("/api/ping", from("6.6.6.6"))).status).toBe(200);
  });
});

describe("registros estructurados", () => {
  it("separa la etiqueta [componente] y el error del mensaje", () => {
    const err = new Error("falló");
    const r = splitLogArgs(["[llm] modelo caído:", err]);
    expect(r.component).toBe("llm");
    expect(r.msg).toBe("modelo caído: falló");
    expect(r.err?.message).toBe("falló");
    expect(splitLogArgs(["sin etiqueta", 3]).component).toBeUndefined();
  });

  it("genera una línea JSON con hora, nivel y requestId", () => {
    const fixed = new Date("2026-10-23T10:00:00Z");
    expect(JSON.parse(buildLine("warn", "hola", { a: 1 }, fixed, undefined))).toEqual({ time: "2026-10-23T10:00:00.000Z", level: "warn", msg: "hola", a: 1 });
    const inside = withRequestId("abc12345", () => JSON.parse(buildLine("info", "x", {}, fixed)));
    expect(inside.requestId).toBe("abc12345");
  });
});

describe("2FA obligatorio", () => {
  it("por defecto solo el superadministrador (y solo con dominio real); los administradores no", () => {
    expect(twoFactorRequired({ isSuperadmin: false, role: "admin" })).toBe(false);
    expect(twoFactorRequired({ isSuperadmin: false, role: "editor" })).toBe(false);
  });
});

describe("monitorización de copias de seguridad", () => {
  const make = async (ageHours: number | null) => {
    const { mkdtemp, writeFile, utimes } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "rag-backups-"));
    if (ageHours !== null) {
      const file = join(dir, "db_2026-10-23_0300.dump");
      await writeFile(file, "x");
      const t = new Date(Date.now() - ageHours * 3_600_000);
      await utimes(file, t, t);
    }
    return dir;
  };

  it("no avisa con una copia reciente", async () => {
    const { checkBackups } = await import("../src/lib/monitor.js");
    expect(await checkBackups(await make(2))).toBeNull();
  });
  it("avisa si la última copia es muy antigua o no hay ninguna", async () => {
    const { checkBackups } = await import("../src/lib/monitor.js");
    expect((await checkBackups(await make(60)))?.key).toBe("backup");
    expect((await checkBackups(await make(null)))?.key).toBe("backup");
  });
  it("no comprueba nada si la carpeta no está montada", async () => {
    const { checkBackups } = await import("../src/lib/monitor.js");
    expect(await checkBackups("/no/existe/rag")).toBeNull();
  });
});

describe("monitorización de contenedores y de la RAM del servidor", () => {
  const row = (over: Partial<import("../src/lib/monitor.js").ContainerRow> = {}) => ({
    name: "docling", state: "running", health: null, mem_bytes: 500, mem_limit: null, oom_killed: false, cpu_limit: null, cpu_avg: 0, cpu_n: 10, restarts_delta: 0, ...over,
  });
  const GB = 1024 ** 3;

  it("avisa de un contenedor parado, y no si está en marcha", async () => {
    const { containerProblems } = await import("../src/lib/monitor.js");
    expect(containerProblems([row()], 90)).toEqual([]);
    expect(containerProblems([row({ state: "exited" })], 90).map((p) => p.key)).toEqual(["container:docling:stopped"]);
  });
  it("un reinicio no se cuenta además como «parado»", async () => {
    const { containerProblems } = await import("../src/lib/monitor.js");
    expect(containerProblems([row({ state: "exited", restarts_delta: 2 })], 90).map((p) => p.key)).toEqual(["container:docling:restart"]);
  });
  it("sin tope no hay alerta de RAM del contenedor; con tope, al pasar el porcentaje", async () => {
    const { containerProblems } = await import("../src/lib/monitor.js");
    expect(containerProblems([row({ mem_bytes: 10 * GB })], 90)).toEqual([]);
    expect(containerProblems([row({ mem_bytes: 95, mem_limit: 100 })], 90).map((p) => p.key)).toEqual(["container:docling:mem"]);
  });
  it("RAM del servidor: avisa solo si lleva 5 minutos por encima del porcentaje", async () => {
    const { hostMemProblem } = await import("../src/lib/monitor.js");
    const total = 8 * GB;
    expect(hostMemProblem({ now: 7.5 * GB, low: 7.4 * GB, samples: 5, total }, 90)?.key).toBe("host-mem");
    // Un pico de un momento (la más baja de los 5 minutos queda por debajo) no avisa.
    expect(hostMemProblem({ now: 7.8 * GB, low: 6 * GB, samples: 5, total }, 90)).toBeNull();
    // Con menos de 3 muestras aún no se puede saber.
    expect(hostMemProblem({ now: 7.8 * GB, low: 7.8 * GB, samples: 2, total }, 90)).toBeNull();
    expect(hostMemProblem(null, 90)).toBeNull();
  });
  it("estado de una comprobación según sus problemas", async () => {
    const { checkState } = await import("../src/lib/monitor.js");
    expect(checkState([])).toBe("ok");
    expect(checkState([{ key: "metrics", message: "", hold: true }])).toBe("wait");
    expect(checkState([{ key: "metrics", message: "", hold: true }, { key: "container:api:health", message: "" }])).toBe("bad");
  });
});

describe("texto que se envía al re-ranker", () => {
  const hit = { documentTitle: "Contrato", heading: "Plazos", content: "x".repeat(2000) };
  it("une título, sección y contenido", async () => {
    const { rerankText } = await import("../src/rag/rerank.js");
    expect(rerankText({ ...hit, content: "texto" }, 0)).toBe("Contrato — Plazos\ntexto");
    expect(rerankText({ documentTitle: "T", heading: "", content: "c" }, 0)).toBe("T\nc");
  });
  it("recorta solo si se pide un máximo", async () => {
    const { rerankText } = await import("../src/rag/rerank.js");
    expect(rerankText(hit, 0).length).toBeGreaterThan(2000);
    expect(rerankText(hit, 600).length).toBe(600);
  });
});
