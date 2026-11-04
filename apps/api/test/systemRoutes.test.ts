import { beforeEach, describe, expect, it, vi } from "vitest";
import "./env.js";

/**
 * Rutas nuevas de Sistema (ajustes y órdenes de copias). Sin base: sqlOwner es una tabla en memoria que entiende las
 * sentencias de estas rutas, la sesión se simula con una cabecera y la auditoría se espía. La autorización
 * (requireSuperadmin) y la validación (zod) son las reales.
 */
const audit = vi.fn(async () => {});
const state = { pendingOrder: false, nextId: 1, orders: [] as { kind: string; payload: unknown }[], settings: new Map<string, unknown>() };

function fakeSql() {
  const run = (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ").trim();
    if (q.startsWith("INSERT INTO backup_requests")) {
      if (state.pendingOrder) return Promise.resolve([]);
      state.orders.push({ kind: vals[0] as string, payload: vals[1] });
      state.pendingOrder = true;
      return Promise.resolve([{ id: String(state.nextId++) }]);
    }
    if (q.startsWith("SELECT id, kind, payload")) {
      return Promise.resolve([{ id: "9", kind: "backup", payload: {}, requested_by: "root", created_at: new Date(0), started_at: null, finished_at: null, ok: null, message: null }]);
    }
    if (q.startsWith("SELECT key, value, secret FROM settings")) return Promise.resolve([...state.settings].map(([key, value]) => ({ key, value, secret: null })));
    if (q.startsWith("INSERT INTO settings")) {
      state.settings.set(vals[0] as string, q.includes("?::jsonb") ? JSON.parse(vals[1] as string) : "cifrado");
      return Promise.resolve([]);
    }
    if (q.startsWith("DELETE FROM settings")) {
      state.settings.delete(vals[0] as string);
      return Promise.resolve([]);
    }
    // Fragmento reutilizable (PENDING): se interpola dentro de otra consulta.
    if (q.startsWith("finished_at IS NULL")) return q;
    throw new Error(`consulta no prevista: ${q}`);
  };
  return Object.assign(run, { json: (v: unknown) => JSON.stringify(v), begin: async (fn: (tx: typeof run) => Promise<void>) => fn(run) });
}

vi.mock("../src/db/client.js", () => ({ sqlOwner: fakeSql() }));
vi.mock("../src/lib/audit.js", () => ({ audit: (...a: unknown[]) => (audit as (...x: unknown[]) => Promise<void>)(...a) }));
vi.mock("../src/auth/middleware.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/auth/middleware.js")>();
  return {
    ...real,
    requireAuth: async (c: { req: { header: (n: string) => string | undefined }; set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      const who = c.req.header("x-test-user");
      if (!who) throw new Error("sin sesión");
      c.set("user", { id: "u1", tenantId: "t1", username: who, email: null, name: who, role: "admin", isSuperadmin: who === "root", support: null, sessionId: null });
      await next();
    },
  };
});

async function makeApp() {
  const { Hono } = await import("hono");
  const { HttpError } = await import("../src/lib/errors.js");
  const { systemRoutes } = await import("../src/routes/system.js");
  const app = new Hono();
  app.route("/api/system", systemRoutes);
  app.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status) : c.json({ error: "interno" }, 500)));
  return app;
}

const call = async (method: string, path: string, body?: unknown, user: string | null = "root") => {
  const app = await makeApp();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-test-user"] = user;
  return app.request(`/api/system${path}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
};

beforeEach(() => {
  audit.mockClear();
  state.pendingOrder = false;
  state.nextId = 1;
  state.orders = [];
  state.settings = new Map();
});

describe("POST /system/backups/destination: validación de la ruta", () => {
  const SQ = String.fromCharCode(39);
  const GOOD = ["usb1/omni", "", "mi disco/copias_2026-11.v1", "a", "x".repeat(200), "usb1/omni/"];
  const BAD = [
    "..", "../x", "a/../b", "a/..", "a..b", "/etc", "/", "/usb1", "a//b", "a;b", "a$b", "a" + SQ + "b", "a\\b", "C:\\x", "C:/x",
    "ñandú", "a\nb", "a\tb", "a|b", "a&b", "a`b", "a*b", "a?b", "a~b", "x".repeat(201),
  ];

  it.each(GOOD)("acepta %j", async (path) => {
    const res = await call("POST", "/backups/destination", { path, moveExisting: false });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ id: 1 });
    expect(state.orders[0]).toMatchObject({ kind: "destination" });
  });

  it.each(BAD)("rechaza %j con 400 y no crea ninguna orden", async (path) => {
    const res = await call("POST", "/backups/destination", { path, moveExisting: true });
    expect(res.status).toBe(400);
    expect(state.orders).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("los segmentos «.» sueltos se rechazan aquí igual que en backup.sh (si no, la orden fallaría después)", async () => {
    for (const path of [".", "./x", "a/./b", "a/."]) {
      const res = await call("POST", "/backups/destination", { path, moveExisting: false });
      expect(res.status, path).toBe(400);
    }
  });

  it("exige path y moveExisting con su tipo", async () => {
    for (const body of [{}, { path: "a" }, { moveExisting: true }, { path: "a", moveExisting: "true" }, { path: 5, moveExisting: false }, { path: null, moveExisting: false }]) {
      expect((await call("POST", "/backups/destination", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call("POST", "/backups/destination", "no es json")).status).toBe(400);
    expect(state.orders).toHaveLength(0);
  });

  it("audita la ruta y la opción de mover", async () => {
    await call("POST", "/backups/destination", { path: "usb1/omni", moveExisting: true });
    expect(audit).toHaveBeenCalledWith(expect.anything(), "backup.destination_requested", expect.objectContaining({ targetId: "1", details: { path: "usb1/omni", moveExisting: true } }));
  });

  it("409 si ya hay una orden pendiente o en curso", async () => {
    expect((await call("POST", "/backups/destination", { path: "a", moveExisting: false })).status).toBe(200);
    const second = await call("POST", "/backups/destination", { path: "b", moveExisting: false });
    expect(second.status).toBe(409);
    expect(state.orders).toHaveLength(1);
  });
});

describe("POST /system/backups/run", () => {
  it("crea una orden de copia y la audita; la segunda mientras haya una pendiente da 409", async () => {
    const first = await call("POST", "/backups/run");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ id: 1 });
    expect(state.orders[0]).toMatchObject({ kind: "backup" });
    expect(audit).toHaveBeenCalledWith(expect.anything(), "backup.run_requested", expect.objectContaining({ targetId: "1" }));
    expect((await call("POST", "/backups/run")).status).toBe(409);
  });
});

describe("GET /system/backups/requests", () => {
  it("devuelve las órdenes con ids numéricos y nombres en camelCase", async () => {
    const res = await call("GET", "/backups/requests");
    expect(res.status).toBe(200);
    const { requests } = (await res.json()) as { requests: Record<string, unknown>[] };
    expect(requests[0]).toMatchObject({ id: 9, kind: "backup", requestedBy: "root", startedAt: null, finishedAt: null, ok: null, message: null });
  });
});

describe("PUT/GET /system/settings", () => {
  it("devuelve el catálogo agrupado", async () => {
    const res = await call("GET", "/settings");
    const body = (await res.json()) as { groups: { id: string; fields: { key: string }[] }[] };
    expect(body.groups.map((g) => g.id)).toEqual(["alerts", "email", "limits", "llm", "web", "search", "backup", "b2"]);
  });

  it("guarda, responde con la vista nueva y audita solo las claves", async () => {
    const res = await call("PUT", "/settings", { values: { ALERT_DISK_FREE_PERCENT: 20, GROQ_API_KEY: "gsk_ultra-secreto" } });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.text()).not.toContain("gsk_ultra-secreto");
    expect(audit).toHaveBeenCalledTimes(1);
    const [, action, info] = audit.mock.calls[0] as unknown as [unknown, string, { details: { keys: string[] } }];
    expect(action).toBe("settings.updated");
    expect(info.details.keys.sort()).toEqual(["ALERT_DISK_FREE_PERCENT", "GROQ_API_KEY"]);
    expect(JSON.stringify(audit.mock.calls)).not.toContain("gsk_ultra-secreto");
  });

  it("400 con valores fuera de rango, claves desconocidas o BACKUP_DESTINATION, sin guardar ni auditar", async () => {
    for (const values of [{ HISTORY_MESSAGES: 999 }, { NO_EXISTE: 1 }, { BACKUP_DESTINATION: "x" }, { ALERT_DISK_FREE_PERCENT: 20, HISTORY_MESSAGES: -1 }]) {
      expect((await call("PUT", "/settings", { values })).status, JSON.stringify(values)).toBe(400);
    }
    expect(state.settings.size).toBe(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("400 con un cuerpo mal formado (tipos no permitidos, sin values, no JSON)", async () => {
    for (const body of [{}, { values: [1] }, { values: { A: [1] } }, { values: { A: { x: 1 } } }, "{no json"]) {
      expect((await call("PUT", "/settings", body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("un cuerpo vacío no audita nada", async () => {
    expect((await call("PUT", "/settings", { values: {} })).status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("autorización", () => {
  it("un administrador que no es superadmin recibe 403 en todas las rutas nuevas", async () => {
    const routes: [string, string, unknown?][] = [
      ["GET", "/settings"],
      ["PUT", "/settings", { values: {} }],
      ["POST", "/settings/test-email", {}],
      ["POST", "/settings/test-llm", { provider: "groq" }],
      ["POST", "/backups/run"],
      ["POST", "/backups/destination", { path: "a", moveExisting: false }],
      ["GET", "/backups/requests"],
    ];
    for (const [m, p, b] of routes) expect((await call(m, p, b, "admin")).status, `${m} ${p}`).toBe(403);
    expect(state.orders).toHaveLength(0);
  });
});

