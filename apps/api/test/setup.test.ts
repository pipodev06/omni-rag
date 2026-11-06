import { beforeEach, describe, expect, it, vi } from "vitest";
import "./env.js";

/**
 * Configuración inicial: código de un solo uso (lib/setupCode.ts) y la ruta /api/setup. La creación real del usuario
 * (bloqueo de la tabla, Plataforma) va contra la base: aquí se simula y se prueba el cableado y las protecciones.
 */
const state = { pending: true, created: [] as unknown[], audits: [] as string[] };

vi.mock("../src/scripts/bootstrap.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/scripts/bootstrap.js")>();
  return {
    initialAdminProblem: real.initialAdminProblem,
    setupPending: async () => state.pending,
    createInitialAdmin: async (a: { username: string; email: string | null }) => {
      if (!state.pending) return null;
      state.pending = false;
      state.created.push(a);
      return { id: "u1", tenant_id: "t1", username: a.username, email: a.email, name: "Administrador" };
    },
  };
});
vi.mock("../src/routes/auth.js", () => ({ startSession: async (_c: unknown, u: { username: string }) => ({ token: "t", user: { username: u.username } }) }));
vi.mock("../src/lib/audit.js", () => ({ auditLog: async (_a: unknown, action: string) => void state.audits.push(action) }));

const quiet = () => {};

async function call(body: unknown, method = "POST") {
  const { Hono } = await import("hono");
  const { HttpError } = await import("../src/lib/errors.js");
  const { setupRoutes } = await import("../src/routes/setup.js");
  const app = new Hono();
  app.route("/api/setup", setupRoutes);
  app.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status) : c.json({ error: String(err) }, 500)));
  return app.request("/api/setup", { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify(body) });
}

const GOOD = { username: "admin", email: "", password: "Una-clave-larga-2026" };

beforeEach(async () => {
  state.pending = true;
  state.created = [];
  state.audits = [];
  (await import("../src/lib/setupCode.js")).clearSetupCode();
});

describe("código de un solo uso", () => {
  it("se escribe en los registros, no distingue mayúsculas ni guiones y los fallos no lo cambian (nadie puede bloquear la configuración)", async () => {
    const m = await import("../src/lib/setupCode.js");
    const logs: string[] = [];
    const code = m.announceSetupCode((l) => logs.push(l));
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(logs.join("")).toContain(code);
    for (let i = 0; i < 20; i++) expect(m.checkSetupCode("MALO-MALO-MALO")).toBe(false);
    expect(m.checkSetupCode(code.toLowerCase().replaceAll("-", " "))).toBe(true);
    expect(logs).toHaveLength(1);
  });

  it("sin código anunciado nada vale", async () => {
    const m = await import("../src/lib/setupCode.js");
    expect(m.checkSetupCode("")).toBe(false);
    expect(m.checkSetupCode("AAAA-AAAA-AAAA")).toBe(false);
  });
});

describe("POST /api/setup", () => {
  it("GET dice si falta configurar", async () => {
    expect(await (await call(undefined, "GET")).json()).toEqual({ pending: true });
    state.pending = false;
    expect(await (await call(undefined, "GET")).json()).toEqual({ pending: false });
  });

  it("con el código crea el superadmin, abre la sesión, lo audita y el código deja de valer", async () => {
    const code = (await import("../src/lib/setupCode.js")).announceSetupCode(quiet);
    const res = await call({ ...GOOD, code });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ user: { username: "admin" } });
    expect(state.created).toEqual([{ username: "admin", email: null, password: GOOD.password }]);
    expect(state.audits).toEqual(["setup.completed"]);
    state.pending = true; // aunque volviera a faltar, el código ya se gastó
    expect((await call({ ...GOOD, code })).status).toBe(403);
  });

  it("código incorrecto: 403 y no crea nada", async () => {
    (await import("../src/lib/setupCode.js")).announceSetupCode(quiet);
    const res = await call({ ...GOOD, code: "AAAA-BBBB-CCCC" });
    expect(res.status).toBe(403);
    expect(state.created).toHaveLength(0);
  });

  it("ya configurado: 409 aunque el código sea bueno", async () => {
    const code = (await import("../src/lib/setupCode.js")).announceSetupCode(quiet);
    state.pending = false;
    expect((await call({ ...GOOD, code })).status).toBe(409);
  });

  it("usuario o contraseña no válidos: 400 y el código sigue valiendo", async () => {
    const code = (await import("../src/lib/setupCode.js")).announceSetupCode(quiet);
    expect((await call({ ...GOOD, username: "a", code })).status).toBe(400);
    expect((await call({ ...GOOD, password: "corta", code })).status).toBe(400);
    expect((await call({ ...GOOD, password: "Catorce-letra1", code })).status).toBe(400); // 14: el superadmin pide 15
    expect((await call({ ...GOOD, email: "no-es-correo", code })).status).toBe(400);
    expect((await call({ ...GOOD, code })).status).toBe(200);
  });
});
