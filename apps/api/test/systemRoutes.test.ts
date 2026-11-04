import { beforeEach, describe, expect, it, vi } from "vitest";
import "./env.js";

/**
 * Rutas nuevas de Sistema (ajustes y órdenes de copias). Sin base: sqlOwner es una tabla en memoria que entiende las
 * sentencias de estas rutas, la sesión se simula con una cabecera y la auditoría se espía. La autorización
 * (requireSuperadmin) y la validación (zod) son las reales.
 */
const audit = vi.fn(async () => {});
const state = {
  pendingOrder: false,
  nextId: 1,
  orders: [] as { kind: string; payload: unknown }[],
  settings: new Map<string, unknown>(),
  /** Minutos que faltan para poder pedir otra copia manual (null = la última terminó hace más de 15 min). */
  cooldown: null as number | null,
  expired: 0,
  totp: false,
};
const sendMail = vi.fn(async (_o: { to: string; subject: string; intro: string; outro: string }) => true);
const verifyEmail = vi.fn(async () => {});
const sendEmail = vi.fn(async () => true);

function fakeSql() {
  const run = (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ").trim();
    if (q.startsWith("UPDATE backup_requests SET started_at")) {
      state.expired++;
      return Promise.resolve([]);
    }
    if (q.startsWith("SELECT ceil(")) return Promise.resolve(state.cooldown === null ? [] : [{ wait: state.cooldown }]);
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
// La reconfirmación real (contraseña, TOTP, límite de intentos) se prueba en reauth.test.ts; aquí solo el cableado de las rutas.
vi.mock("../src/lib/reauth.js", async () => {
  const { z } = await import("zod");
  const { HttpError } = await import("../src/lib/errors.js");
  return {
    ConfirmSchema: z.object({ password: z.string().max(200), code: z.string().max(32).optional() }),
    hasTotp: async () => state.totp,
    reauthenticate: async (_id: string, confirm?: { password: string; code?: string }) => {
      if (!confirm) throw new HttpError(403, "Confirma tu identidad con tu contraseña para continuar.", "REAUTH_REQUIRED");
      if (confirm.password !== "pass") throw new HttpError(403, "Contraseña o código incorrectos.", "REAUTH_FAILED");
      if (state.totp && confirm.code !== "123456") throw new HttpError(403, "Escribe el código de verificación.", "REAUTH_FAILED");
    },
  };
});
vi.mock("../src/lib/mailer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mailer.js")>()),
  captureMailer: () => sendMail,
  verifyEmail: () => verifyEmail(),
  sendEmail: (o: unknown) => (sendEmail as (x: unknown) => Promise<boolean>)(o),
}));
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
  app.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message, ...(err.code && { code: err.code }) }, err.status) : c.json({ error: "interno" }, 500)));
  return app;
}

const call = async (method: string, path: string, body?: unknown, user: string | null = "root") => {
  const app = await makeApp();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-test-user"] = user;
  return app.request(`/api/system${path}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
};

beforeEach(async () => {
  audit.mockClear();
  state.pendingOrder = false;
  state.nextId = 1;
  state.orders = [];
  state.settings = new Map();
  state.cooldown = null;
  state.expired = 0;
  state.totp = false;
  sendMail.mockClear();
  verifyEmail.mockReset();
  sendEmail.mockClear();
  // La memoria de ajustes del módulo vuelve a coincidir con la base simulada (vacía).
  await (await import("../src/lib/settings.js")).refreshSettings();
});

const CONFIRM = { password: "pass" };


describe("POST /system/backups/destination: validación de la ruta", () => {
  const SQ = String.fromCharCode(39);
  const GOOD = ["usb1/omni", "", "mi disco/copias_2026-11.v1", "a", "x".repeat(200), "usb1/omni/"];
  const BAD = [
    "..", "../x", "a/../b", "a/..", "a..b", "/etc", "/", "/usb1", "a//b", "a;b", "a$b", "a" + SQ + "b", "a\\b", "C:\\x", "C:/x",
    "ñandú", "a\nb", "a\tb", "a|b", "a&b", "a`b", "a*b", "a?b", "a~b", "x".repeat(201),
  ];

  it.each(GOOD)("acepta %j", async (path) => {
    const res = await call("POST", "/backups/destination", { path, moveExisting: false, confirm: CONFIRM });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ id: 1 });
    expect(state.orders[0]).toMatchObject({ kind: "destination" });
  });

  it.each(BAD)("rechaza %j con 400 y no crea ninguna orden", async (path) => {
    const res = await call("POST", "/backups/destination", { path, moveExisting: true, confirm: CONFIRM });
    expect(res.status).toBe(400);
    expect(state.orders).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("los segmentos «.» sueltos se rechazan aquí igual que en backup.sh (si no, la orden fallaría después)", async () => {
    for (const path of [".", "./x", "a/./b", "a/."]) {
      const res = await call("POST", "/backups/destination", { path, moveExisting: false, confirm: CONFIRM });
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
    await call("POST", "/backups/destination", { path: "usb1/omni", moveExisting: true, confirm: CONFIRM });
    expect(audit).toHaveBeenCalledWith(expect.anything(), "backup.destination_requested", expect.objectContaining({ targetId: "1", details: { path: "usb1/omni", moveExisting: true } }));
  });

  it("409 si ya hay una orden pendiente o en curso", async () => {
    expect((await call("POST", "/backups/destination", { path: "a", moveExisting: false, confirm: CONFIRM })).status).toBe(200);
    const second = await call("POST", "/backups/destination", { path: "b", moveExisting: false, confirm: CONFIRM });
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
    const res = await call("PUT", "/settings", { values: { ALERT_DISK_FREE_PERCENT: 20, GROQ_API_KEY: "gsk_ultra-secreto" }, confirm: CONFIRM });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.text()).not.toContain("gsk_ultra-secreto");
    expect(audit).toHaveBeenCalledTimes(1);
    const [, action, info] = audit.mock.calls[0] as unknown as [unknown, string, { details: { keys: string[] } }];
    expect(action).toBe("settings.updated");
    expect(info.details.keys.sort()).toEqual(["ALERT_DISK_FREE_PERCENT", "GROQ_API_KEY"]);
    expect(info.details).toMatchObject({ cleared: [] });
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
    expect((await call("PUT", "/settings", { values: {}, confirm: CONFIRM })).status).toBe(200);
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


describe("reconfirmación de identidad (contrato con la pantalla)", () => {
  const VALUES = { ALERT_DISK_FREE_PERCENT: 20 };

  it("PUT /settings sin confirm: 403 REAUTH_REQUIRED, no guarda, no audita, no avisa", async () => {
    const res = await call("PUT", "/settings", { values: VALUES });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "REAUTH_REQUIRED", error: expect.any(String) });
    expect(state.settings.size).toBe(0);
    expect(audit).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("PUT /settings con contraseña mala: 403 REAUTH_FAILED, no guarda y deja constancia del fallo", async () => {
    const res = await call("PUT", "/settings", { values: VALUES, confirm: { password: "mala" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "REAUTH_FAILED" });
    expect(state.settings.size).toBe(0);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.anything(), "system.reauth_failed", expect.anything());
  });

  it("con 2FA activo y sin code: REAUTH_FAILED «Escribe el código…»; con el código correcto guarda", async () => {
    state.totp = true;
    const sin = await call("PUT", "/settings", { values: VALUES, confirm: CONFIRM });
    expect(sin.status).toBe(403);
    expect(await sin.json()).toMatchObject({ code: "REAUTH_FAILED", error: "Escribe el código de verificación." });
    expect(state.settings.size).toBe(0);
    const con = await call("PUT", "/settings", { values: VALUES, confirm: { password: "pass", code: "123456" } });
    expect(con.status).toBe(200);
    expect(state.settings.size).toBe(1);
  });

  it("una petición inválida da 400 antes de pedir la reconfirmación (no se gasta un código en un cambio que no vale)", async () => {
    const res = await call("PUT", "/settings", { values: { HISTORY_MESSAGES: 999 } });
    expect(res.status).toBe(400);
    expect(audit).not.toHaveBeenCalled();
  });

  it("un confirm mal formado da 400", async () => {
    for (const confirm of [{}, { password: 5 }, { password: "x", code: 123456 }, "pass"]) {
      expect((await call("PUT", "/settings", { values: VALUES, confirm })).status, JSON.stringify(confirm)).toBe(400);
    }
  });

  it("POST /backups/destination sin confirm o con datos malos: 403 y no crea la orden", async () => {
    const sin = await call("POST", "/backups/destination", { path: "usb1/omni", moveExisting: false });
    expect(sin.status).toBe(403);
    expect(await sin.json()).toMatchObject({ code: "REAUTH_REQUIRED" });
    const mala = await call("POST", "/backups/destination", { path: "usb1/omni", moveExisting: false, confirm: { password: "mala" } });
    expect(mala.status).toBe(403);
    expect(await mala.json()).toMatchObject({ code: "REAUTH_FAILED" });
    expect(state.orders).toHaveLength(0);
    expect(audit).not.toHaveBeenCalledWith(expect.anything(), "backup.destination_requested", expect.anything());
  });

  it("el confirm no se guarda en la orden ni en la auditoría", async () => {
    await call("POST", "/backups/destination", { path: "usb1/omni", moveExisting: true, confirm: { password: "pass" } });
    expect(JSON.stringify(state.orders)).not.toContain("pass");
    expect(JSON.stringify(audit.mock.calls)).not.toContain("pass");
  });

  it("GET /settings dice si hay que pedir el código de 2FA (reauth.totp)", async () => {
    expect(((await (await call("GET", "/settings")).json()) as { reauth: unknown }).reauth).toEqual({ totp: false });
    state.totp = true;
    expect(((await (await call("GET", "/settings")).json()) as { reauth: unknown }).reauth).toEqual({ totp: true });
  });

  it("la respuesta del PUT lleva la vista, reauth y cleared", async () => {
    const body = (await (await call("PUT", "/settings", { values: VALUES, confirm: CONFIRM })).json()) as { groups: unknown[]; reauth: unknown; cleared: unknown };
    expect(body.groups).toHaveLength(8);
    expect(body).toMatchObject({ reauth: { totp: false }, cleared: [] });
  });
});

describe("PUT /settings: secretos atados al servidor", () => {
  it("cambiar SMTP_HOST sin enviar la contraseña la borra y lo dice en cleared; la auditoría lleva solo claves", async () => {
    const put = (values: object) => call("PUT", "/settings", { values, confirm: CONFIRM });
    expect((await put({ SMTP_HOST: "smtp.uno.com", SMTP_PASSWORD: "clave-smtp-secreta" })).status).toBe(200);
    audit.mockClear();
    const res = await put({ SMTP_HOST: "smtp.otro.com" });
    const body = (await res.json()) as { cleared: string[]; groups: { fields: { key: string; configured: boolean }[] }[] };
    expect(body.cleared).toEqual(["SMTP_PASSWORD"]);
    expect(body.groups.flatMap((g) => g.fields).find((f) => f.key === "SMTP_PASSWORD")!.configured).toBe(false);
    expect(state.settings.has("SMTP_PASSWORD")).toBe(false);
    const [, , info] = audit.mock.calls[0] as unknown as [unknown, string, { details: { keys: string[]; cleared: string[] } }];
    expect(info.details).toEqual({ keys: ["SMTP_HOST"], cleared: ["SMTP_PASSWORD"] });
    expect(JSON.stringify(audit.mock.calls)).not.toContain("clave-smtp-secreta");
  });
});

describe("aviso por correo de un cambio de ajustes", () => {
  const settings = () => import("../src/lib/settings.js");
  const waitMails = (n: number) => vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(n));

  it("avisa a los destinatarios de ANTES del cambio con las claves, quién y cuándo, sin valores", async () => {
    state.settings.set("ALERT_EMAIL", "viejo@x.com, otro@x.com");
    await (await settings()).refreshSettings();
    await call("PUT", "/settings", { values: { ALERT_DISK_FREE_PERCENT: 33, GROQ_API_KEY: "gsk_valor-secreto" }, confirm: CONFIRM });
    await waitMails(2);
    const mails = sendMail.mock.calls.map((c) => c[0]);
    expect(mails.map((m) => m.to).sort()).toEqual(["otro@x.com", "viejo@x.com"]);
    const text = JSON.stringify(mails);
    expect(text).toContain("ALERT_DISK_FREE_PERCENT");
    expect(text).toContain("GROQ_API_KEY");
    expect(text).toContain("root");
    expect(text).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(text).not.toContain("gsk_valor-secreto");
    expect(text).not.toContain("33");
  });

  it("si cambia el propio ALERT_EMAIL avisa al anterior y al nuevo", async () => {
    state.settings.set("ALERT_EMAIL", "viejo@x.com");
    await (await settings()).refreshSettings();
    await call("PUT", "/settings", { values: { ALERT_EMAIL: "nuevo@x.com" }, confirm: CONFIRM });
    await waitMails(2);
    expect(sendMail.mock.calls.map((c) => c[0].to).sort()).toEqual(["nuevo@x.com", "viejo@x.com"]);
  });

  it("sin correo configurado no envía nada, y un cambio rechazado tampoco avisa", async () => {
    await (await settings()).refreshSettings();
    await call("PUT", "/settings", { values: { ALERT_DISK_FREE_PERCENT: 20 }, confirm: CONFIRM });
    state.settings.set("ALERT_EMAIL", "viejo@x.com");
    await (await settings()).refreshSettings();
    await call("PUT", "/settings", { values: { ALERT_DISK_FREE_PERCENT: 21 } });
    await call("PUT", "/settings", { values: { HISTORY_MESSAGES: 999 }, confirm: CONFIRM });
    await new Promise((r) => setTimeout(r, 20));
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("también avisa del cambio de destino de las copias", async () => {
    state.settings.set("ALERT_EMAIL", "viejo@x.com");
    await (await settings()).refreshSettings();
    await call("POST", "/backups/destination", { path: "usb1/omni", moveExisting: false, confirm: CONFIRM });
    await waitMails(1);
    expect(sendMail.mock.calls[0]![0].intro).toContain("BACKUP_DESTINATION");
  });
});

describe("POST /settings/test-email: mensajes fijos", () => {
  const arm = async () => {
    state.settings.set("SMTP_HOST", "smtp.prueba.com");
    await (await import("../src/lib/settings.js")).refreshSettings();
  };
  const probe = async () => (await (await call("POST", "/settings/test-email", { to: "a@b.com" })).json()) as { ok: boolean; message: string };

  it.each([
    [{ code: "ECONNREFUSED" }, /rechazó la conexión/],
    [{ code: "ETIMEDOUT" }, /no respondió a tiempo/],
    [{ code: "ENOTFOUND" }, /No se encontró el servidor/],
    [{ code: "EAUTH", responseCode: 535 }, /usuario o la contraseña/],
    [{ responseCode: 535 }, /usuario o la contraseña/],
    [{ code: "ESOCKET" }, /conexión cifrada/],
    [{ code: "ETLS" }, /conexión cifrada/],
    [{ code: "ERR_SSL_WRONG_VERSION_NUMBER" }, /conexión cifrada/],
    [{ code: "EOTRA" }, /No se pudo enviar el correo/],
    [{}, /No se pudo enviar el correo/],
  ])("%j da un texto fijo y no reenvía el crudo del servidor", async (extra, expected) => {
    await arm();
    verifyEmail.mockRejectedValueOnce(Object.assign(new Error("535 5.7.8 Username and Password not accepted for user pepe@x.com pass=hunter2 10.0.0.9"), extra));
    const body = await probe();
    expect(body.ok).toBe(false);
    expect(body.message).toMatch(expected);
    for (const leak of ["535", "hunter2", "pepe@x.com", "10.0.0.9", "Username"]) expect(body.message).not.toContain(leak);
  });

  it("si la conexión va bien y el envío falla, mensaje fijo que remite al registro", async () => {
    await arm();
    sendEmail.mockResolvedValueOnce(false);
    const body = await probe();
    expect(body).toEqual({ ok: false, message: "El servidor rechazó el envío. El detalle está en los registros." });
  });

  it("correo desactivado: lo dice sin intentar nada", async () => {
    const body = await probe();
    expect(body.ok).toBe(false);
    expect(verifyEmail).not.toHaveBeenCalled();
  });
});

describe("POST /backups/run: órdenes atómicas y espera entre copias manuales", () => {
  it("429 con el texto de la API si la última copia manual terminó hace menos de 15 minutos, sin crear orden", async () => {
    state.cooldown = 7;
    const res = await call("POST", "/backups/run");
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/15 minutos/);
    expect(body.error).toMatch(/7 min/);
    expect(state.orders).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("pasados los 15 minutos se crea la orden", async () => {
    state.cooldown = null;
    expect((await call("POST", "/backups/run")).status).toBe(200);
  });

  it("antes de crear una orden se cierran como caducadas las que llevan 6 horas sin terminar", async () => {
    await call("POST", "/backups/run");
    expect(state.expired).toBe(1);
  });

  it("si la base rechaza la orden por el índice único (otra abierta o carrera), 409", async () => {
    state.pendingOrder = true;
    const res = await call("POST", "/backups/run");
    expect(res.status).toBe(409);
    expect(state.orders).toHaveLength(0);
  });

  it("dos peticiones simultáneas crean una sola orden", async () => {
    const [a, b] = await Promise.all([call("POST", "/backups/run"), call("POST", "/backups/run")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(state.orders).toHaveLength(1);
  });
});
