import { describe, expect, it, vi } from "vitest";
import "./env.js";
import { hashRecoveryCode, hotp, encryptSecret } from "../src/lib/totp.js";

/**
 * Reconfirmación de identidad (lib/reauth.ts) con la lógica real de TOTP y códigos de recuperación. No hay base:
 * `sqlOwner` es una fila en memoria que entiende las consultas del módulo; la comparación de contraseña se simula
 * (bcrypt tiene su propio test) para no gastar 250 ms por intento.
 */
interface Row {
  id: string;
  totp_enabled_at: string | null;
  totp_secret: string | null;
  totp_last_step: string | null;
  totp_recovery_hashes: string[];
  password_hash: string | null;
}
const users = new Map<string, Row>();

vi.mock("../src/auth/password.js", () => ({ verifyPassword: async (plain: string, hash: string) => hash === `hash:${plain}` }));
vi.mock("../src/db/client.js", () => {
  const run = (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ").trim();
    if (q.startsWith("id, tenant_id")) return "cols";
    if (q.startsWith("SELECT ?, password_hash FROM users u")) {
      const row = users.get(vals[1] as string);
      return Promise.resolve(row ? [row] : []);
    }
    if (q.startsWith('SELECT (totp_enabled_at IS NOT NULL) AS "on"')) {
      const row = users.get(vals[0] as string);
      return Promise.resolve(row ? [{ on: row.totp_enabled_at !== null }] : []);
    }
    if (q.startsWith("UPDATE users SET totp_last_step")) {
      const row = users.get(vals[1] as string)!;
      const step = vals[0] as number;
      if (row.totp_last_step !== null && Number(row.totp_last_step) >= step) return Promise.resolve([]);
      row.totp_last_step = String(step);
      return Promise.resolve([{ id: row.id }]);
    }
    if (q.startsWith("UPDATE users SET totp_recovery_hashes")) {
      const row = users.get(vals[1] as string)!;
      if (!row.totp_recovery_hashes.includes(vals[0] as string)) return Promise.resolve([]);
      row.totp_recovery_hashes = row.totp_recovery_hashes.filter((h) => h !== vals[0]);
      return Promise.resolve([{ id: row.id }]);
    }
    throw new Error(`consulta no prevista: ${q}`);
  };
  return { sqlOwner: run };
});

const { reauthenticate, hasTotp } = await import("../src/lib/reauth.js");

const SECRET = "JBSWY3DPEHPK3PXP";
const now = () => Math.floor(Date.now() / 1000 / 30);
let n = 0;
/** Usuario nuevo en cada prueba (el límite de intentos es por usuario y vive en el módulo). */
function user(opts: { totp?: boolean; recovery?: string[]; password?: string | null } = {}): string {
  const id = `u${++n}`;
  users.set(id, {
    id,
    totp_enabled_at: opts.totp ? "2026-01-01" : null,
    totp_secret: opts.totp ? encryptSecret(SECRET) : null,
    totp_last_step: null,
    totp_recovery_hashes: (opts.recovery ?? []).map(hashRecoveryCode),
    password_hash: opts.password === undefined ? "hash:buena-clave" : opts.password,
  });
  return id;
}
const good = { password: "buena-clave" };
const failure = (p: Promise<void>) => p.then(() => null, (e: { status: number; code?: string; message: string }) => e);

describe("reauthenticate", () => {
  it("sin confirm: 403 REAUTH_REQUIRED", async () => {
    const e = await failure(reauthenticate(user(), undefined));
    expect(e).toMatchObject({ status: 403, code: "REAUTH_REQUIRED" });
  });

  it("sin 2FA basta la contraseña; mala, vacía o de un usuario sin contraseña: 403 REAUTH_FAILED", async () => {
    await expect(reauthenticate(user(), good)).resolves.toBeUndefined();
    for (const password of ["mala", ""]) {
      expect(await failure(reauthenticate(user(), { password }))).toMatchObject({ status: 403, code: "REAUTH_FAILED" });
    }
    expect(await failure(reauthenticate(user({ password: null }), good))).toMatchObject({ status: 403, code: "REAUTH_FAILED" });
  });

  it("un usuario inexistente o inactivo da REAUTH_FAILED (sin detalle)", async () => {
    expect(await failure(reauthenticate("no-existe", good))).toMatchObject({ status: 403, code: "REAUTH_FAILED" });
  });

  it("hasTotp refleja si el usuario tiene la verificación en dos pasos", async () => {
    expect(await hasTotp(user({ totp: true }))).toBe(true);
    expect(await hasTotp(user())).toBe(false);
    expect(await hasTotp("no-existe")).toBe(false);
  });

  it("con 2FA y sin código: REAUTH_FAILED «Escribe el código de verificación.» sin gastar intentos", async () => {
    const id = user({ totp: true });
    for (let i = 0; i < 8; i++) {
      expect(await failure(reauthenticate(id, good))).toMatchObject({ status: 403, code: "REAUTH_FAILED", message: "Escribe el código de verificación." });
    }
    await expect(reauthenticate(id, { ...good, code: hotp(SECRET, now()) })).resolves.toBeUndefined();
  });

  it("con 2FA: contraseña y código correctos pasan; el mismo código no vale dos veces", async () => {
    const id = user({ totp: true });
    const code = hotp(SECRET, now());
    await expect(reauthenticate(id, { ...good, code })).resolves.toBeUndefined();
    expect(await failure(reauthenticate(id, { ...good, code }))).toMatchObject({ status: 403, code: "REAUTH_FAILED" });
  });

  it("código mal o contraseña mal con código bueno: REAUTH_FAILED, y el código no se consume si la contraseña ya falló", async () => {
    const id = user({ totp: true });
    const code = hotp(SECRET, now());
    expect(await failure(reauthenticate(id, { ...good, code: "000000" === code ? "111111" : "000000" }))).toMatchObject({ code: "REAUTH_FAILED" });
    expect(await failure(reauthenticate(id, { password: "mala", code }))).toMatchObject({ code: "REAUTH_FAILED" });
    await expect(reauthenticate(id, { ...good, code })).resolves.toBeUndefined();
  });

  it("un código de recuperación sirve una vez", async () => {
    const id = user({ totp: true, recovery: ["abcde-fghjk"] });
    await expect(reauthenticate(id, { ...good, code: "ABCDE-FGHJK" })).resolves.toBeUndefined();
    expect(await failure(reauthenticate(id, { ...good, code: "abcde-fghjk" }))).toMatchObject({ code: "REAUTH_FAILED" });
  });

  it("5 intentos fallidos por usuario: el sexto da 429 aunque los datos sean buenos", async () => {
    const id = user();
    for (let i = 0; i < 5; i++) expect(await failure(reauthenticate(id, { password: "mala" }))).toMatchObject({ code: "REAUTH_FAILED" });
    expect(await failure(reauthenticate(id, good))).toMatchObject({ status: 429 });
    // Otro usuario no se ve afectado.
    await expect(reauthenticate(user(), good)).resolves.toBeUndefined();
  });

  it("un éxito reinicia la cuenta de intentos", async () => {
    const id = user();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 4; i++) await failure(reauthenticate(id, { password: "mala" }));
      await expect(reauthenticate(id, good)).resolves.toBeUndefined();
    }
  });
});
