import { Hono, type Context } from "hono";
import { deleteCookie } from "hono/cookie";
import { z } from "zod";
import { sqlOwner, type Role } from "../db/client.js";
import { signMfaToken, verifyMfaToken } from "../auth/jwt.js";
import { issueSession, revokeSessions } from "../auth/session.js";
import { requireAuth, SESSION_COOKIE, type AppEnv } from "../auth/middleware.js";
import { hashPassword, passwordProblem, verifyPassword } from "../auth/password.js";
import { audit, auditLog } from "../lib/audit.js";
import { badRequest, HttpError, notFound, unauthorized } from "../lib/errors.js";
import { emailEnabled } from "../lib/mailer.js";
import { RateLimiter } from "../lib/rateLimit.js";
import { superadmin2faRequired } from "../lib/limits.js";
import { clientIp } from "../lib/request.js";
import {
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  otpauthUrl,
  verifyTotp,
} from "../lib/totp.js";
import { createUserLink, emailLink, findValidToken } from "../lib/tokens.js";
import { parse } from "../lib/validate.js";

export const authRoutes = new Hono<AppEnv>();

// Frenos contra fuerza bruta: por IP+usuario y, además, por usuario (por si la IP se falsea).
const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);
const loginEmailLimiter = new RateLimiter(30, 15 * 60 * 1000);
const forgotLimiter = new RateLimiter(5, 60 * 60 * 1000);
const tokenLimiter = new RateLimiter(30, 15 * 60 * 1000);
// Segundo paso del login: pocos intentos por usuario (un código son solo 6 dígitos).
const mfaLimiter = new RateLimiter(5, 15 * 60 * 1000);

// Hash de relleno para que el tiempo de respuesta no revele si el usuario existe.
const dummyHash = hashPassword("contraseña-de-relleno");

interface SessionUser {
  id: string;
  tenant_id: string;
  name: string;
  username: string;
  email: string | null;
  role: Role;
  is_superadmin: boolean;
}

/** Condición SQL para buscar una cuenta por email (si lleva «@») o por nombre de usuario. */
const byLogin = (login: string) =>
  login.includes("@") ? sqlOwner`lower(u.email) = ${login}` : sqlOwner`lower(u.username) = ${login}`;

/** Firma la sesión, pone la cookie y devuelve el cuerpo de respuesta del login. */
async function startSession(c: Context<AppEnv>, user: SessionUser) {
  const token = await issueSession(c, { userId: user.id, tenantId: user.tenant_id, role: user.role });
  return {
    token, // para clientes que no usan cookies (scripts, integraciones)
    user: { id: user.id, username: user.username, email: user.email, name: user.name, role: user.role, isSuperadmin: user.is_superadmin },
  };
}

/** Configuración pública que necesita la pantalla de login. */
authRoutes.get("/config", (c) => c.json({ emailEnabled: emailEnabled() }));

// `login` es el usuario o el email. `email` se sigue aceptando por compatibilidad con scripts anteriores.
const LoginBody = z
  .object({
    login: z.string().trim().min(1).max(254).optional(),
    email: z.string().trim().min(1).max(254).optional(),
    password: z.string().min(1).max(200),
  })
  .refine((b) => b.login ?? b.email, "Falta el usuario");

authRoutes.post("/login", async (c) => {
  const body = parse(LoginBody, await c.req.json().catch(() => ({})));
  const login = (body.login ?? body.email)!.toLowerCase();
  const ip = clientIp(c);
  if (!loginLimiter.hit(`${ip}|${login}`) || !loginEmailLimiter.hit(login)) {
    throw new HttpError(429, "Demasiados intentos. Espera unos minutos.");
  }

  const [user] = await sqlOwner<(SessionUser & { password_hash: string | null; totp: boolean })[]>`
    SELECT u.id, u.tenant_id, u.name, u.username, u.email, u.role, u.password_hash, u.is_superadmin,
           (u.totp_enabled_at IS NOT NULL) AS totp
      FROM users u JOIN tenants t ON t.id = u.tenant_id
     WHERE ${byLogin(login)}
       AND u.is_active AND t.is_active`;

  // Los usuarios invitados que aún no aceptaron no tienen contraseña.
  const ok = await verifyPassword(body.password, user?.password_hash ?? (await dummyHash));
  if (!user || !user.password_hash || !ok) {
    if (user) {
      await auditLog({ tenantId: user.tenant_id, userId: user.id, username: user.username, ip }, "auth.login_failed");
    }
    throw unauthorized("Usuario o contraseña incorrectos");
  }

  loginLimiter.reset(`${ip}|${login}`);
  // Con verificación en dos pasos, la contraseña sola no abre sesión: falta el código.
  if (user.totp) return c.json({ mfaRequired: true, mfaToken: await signMfaToken(user.id) });
  const session = await startSession(c, user);
  await auditLog({ tenantId: user.tenant_id, userId: user.id, username: user.username, ip }, "auth.login");
  return c.json(session);
});

interface TotpRow {
  id: string;
  tenant_id: string;
  name: string;
  username: string;
  email: string | null;
  role: Role;
  is_superadmin: boolean;
  totp_secret: string | null;
  totp_enabled_at: string | null;
  totp_last_step: string | null;
  totp_recovery_hashes: string[];
}

const TOTP_COLS = sqlOwner`id, tenant_id, name, username, email, role, is_superadmin, totp_secret, totp_enabled_at, totp_last_step, totp_recovery_hashes`;

/**
 * Comprueba un código del segundo paso: TOTP de 6 dígitos o código de recuperación.
 * Consume lo usado (un código TOTP vale una vez; cada código de recuperación, también).
 */
async function consumeSecondFactor(u: TotpRow, rawCode: string): Promise<"totp" | "recovery" | null> {
  const code = rawCode.replace(/\s/g, "");
  if (/^\d{6}$/.test(code) && u.totp_secret) {
    const last = u.totp_last_step === null ? null : Number(u.totp_last_step);
    const step = verifyTotp(decryptSecret(u.totp_secret), code, last);
    if (step === null) return null;
    // Atómico: si dos peticiones llegan con el mismo código, solo una gana.
    const [won] = await sqlOwner`
      UPDATE users SET totp_last_step = ${step} WHERE id = ${u.id} AND (totp_last_step IS NULL OR totp_last_step < ${step}) RETURNING id`;
    return won ? "totp" : null;
  }
  const hash = hashRecoveryCode(rawCode);
  if (!u.totp_recovery_hashes.includes(hash)) return null;
  const [used] = await sqlOwner`
    UPDATE users SET totp_recovery_hashes = array_remove(totp_recovery_hashes, ${hash})
     WHERE id = ${u.id} AND ${hash} = ANY(totp_recovery_hashes) RETURNING id`;
  return used ? "recovery" : null;
}

const MfaBody = z.object({ mfaToken: z.string().min(10).max(2000), code: z.string().trim().min(6).max(32) });

/** Segundo paso del login: valida el código y abre la sesión. */
authRoutes.post("/login/totp", async (c) => {
  const body = parse(MfaBody, await c.req.json().catch(() => ({})));
  const ip = clientIp(c);
  const userId = await verifyMfaToken(body.mfaToken);
  if (!userId) throw unauthorized("La verificación caducó. Vuelve a iniciar sesión.");
  if (!mfaLimiter.hit(userId)) throw new HttpError(429, "Demasiados intentos. Espera unos minutos.");

  const [u] = await sqlOwner<TotpRow[]>`
    SELECT ${TOTP_COLS} FROM users u
     WHERE u.id = ${userId} AND u.is_active AND u.totp_enabled_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = u.tenant_id AND t.is_active)`;
  const used = u ? await consumeSecondFactor(u, body.code) : null;
  if (!u || !used) {
    if (u) await auditLog({ tenantId: u.tenant_id, userId: u.id, username: u.username, ip }, "auth.login_mfa_failed");
    throw unauthorized("Código incorrecto");
  }
  mfaLimiter.reset(userId);
  const session = await startSession(c, u);
  await auditLog({ tenantId: u.tenant_id, userId: u.id, username: u.username, ip }, "auth.login", { details: { mfa: used } });
  return c.json({ ...session, recoveryCodesLeft: used === "recovery" ? u.totp_recovery_hashes.length - 1 : undefined });
});

authRoutes.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

authRoutes.get("/me", requireAuth, async (c) => {
  const u = c.get("user");
  const [tenant] = await sqlOwner<{ name: string; slug: string }[]>`SELECT name, slug FROM tenants WHERE id = ${u.tenantId}`;
  const [mfa] = await sqlOwner<{ on: boolean }[]>`SELECT (totp_enabled_at IS NOT NULL) AS "on" FROM users WHERE id = ${u.id}`;
  return c.json({
    user: { id: u.id, username: u.username, email: u.email, name: u.name, role: u.role, isSuperadmin: u.isSuperadmin, totpEnabled: mfa?.on ?? false },
    mfaSetupRequired: u.isSuperadmin && !u.support && !(mfa?.on ?? false) && superadmin2faRequired(),
    tenant,
    support: u.support ? { name: u.support.name, username: u.support.username } : null,
  });
});

/** Sale del modo soporte y vuelve a la sesión normal del superadministrador. */
authRoutes.post("/exit-support", requireAuth, async (c) => {
  const u = c.get("user");
  if (!u.support) throw badRequest("No estás en modo soporte");
  const [actor] = await sqlOwner<SessionUser[]>`
    SELECT id, tenant_id, name, username, email, role, is_superadmin FROM users WHERE id = ${u.support.id}`;
  if (!actor) throw unauthorized();
  await audit(c, "support.exited");
  return c.json(await startSession(c, actor));
});

const ChangePasswordBody = z.object({ newPassword: z.string(), code: z.string().trim().max(32).optional() });

/**
 * Cambia la contraseña de la sesión abierta. No pide la contraseña anterior: basta la sesión. Si la
 * cuenta tiene verificación en dos pasos, exige un código (TOTP o de recuperación) para que una sesión
 * robada no pueda quedarse con la cuenta.
 */
authRoutes.post("/change-password", requireAuth, async (c) => {
  const body = parse(ChangePasswordBody, await c.req.json().catch(() => ({})));
  const problem = passwordProblem(body.newPassword);
  if (problem) throw badRequest(problem);
  const u = c.get("user");
  if (u.support) throw badRequest("En modo soporte no se puede cambiar la contraseña");
  const mfa = await loadTotp(u.id);
  if (mfa?.totp_enabled_at) {
    if (!mfaLimiter.hit(u.id)) throw new HttpError(429, "Demasiados intentos. Espera unos minutos.");
    if (!body.code) throw badRequest("Escribe el código de tu app autenticadora para cambiar la contraseña");
    if (!(await consumeSecondFactor(mfa, body.code))) throw badRequest("Código de verificación incorrecto");
    mfaLimiter.reset(u.id);
  }
  await sqlOwner`UPDATE users SET password_hash = ${await hashPassword(body.newPassword)} WHERE id = ${u.id}`;
  // Las sesiones abiertas en otros dispositivos dejan de valer; esta se renueva para no sacar al usuario.
  await revokeSessions(u.id);
  await issueSession(c, { userId: u.id, tenantId: u.tenantId, role: u.role });
  await audit(c, "auth.password_changed", { targetType: "user", targetId: u.id });
  return c.json({ ok: true });
});

/** Cierra la sesión en todos los dispositivos (incluido este). */
authRoutes.post("/logout-all", requireAuth, async (c) => {
  const u = c.get("user");
  if (u.support) throw badRequest("En modo soporte no se pueden cerrar las sesiones");
  await revokeSessions(u.id);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  await audit(c, "auth.sessions_revoked", { targetType: "user", targetId: u.id });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Verificación en dos pasos (opcional): activar, confirmar y desactivar
// ---------------------------------------------------------------------------

const loadTotp = async (id: string) => (await sqlOwner<TotpRow[]>`SELECT ${TOTP_COLS} FROM users u WHERE u.id = ${id}`)[0];

/** Empieza la configuración: genera un secreto (aún inactivo) y devuelve lo que muestra el código QR. */
authRoutes.post("/totp/setup", requireAuth, async (c) => {
  const me = c.get("user");
  if (me.support) throw badRequest("En modo soporte no se puede configurar la verificación en dos pasos");
  const row = await loadTotp(me.id);
  if (row?.totp_enabled_at) throw badRequest("La verificación en dos pasos ya está activa");
  const secret = generateSecret();
  await sqlOwner`UPDATE users SET totp_secret = ${encryptSecret(secret)}, totp_last_step = NULL WHERE id = ${me.id}`;
  return c.json({ secret, otpauthUrl: otpauthUrl(secret, me.username) });
});

const CodeBody = z.object({ code: z.string().trim().min(6).max(32) });

/** Confirma el primer código de la app, activa el 2FA y entrega los códigos de recuperación (solo esta vez). */
authRoutes.post("/totp/enable", requireAuth, async (c) => {
  const { code } = parse(CodeBody, await c.req.json().catch(() => ({})));
  const me = c.get("user");
  if (!mfaLimiter.hit(me.id)) throw new HttpError(429, "Demasiados intentos. Espera unos minutos.");
  const row = await loadTotp(me.id);
  if (!row?.totp_secret || row.totp_enabled_at) throw badRequest("Empieza la configuración primero");
  const step = verifyTotp(decryptSecret(row.totp_secret), code.replace(/\s/g, ""), null);
  if (step === null) throw badRequest("El código no es correcto. Revisa que la hora del teléfono sea automática.");
  const recoveryCodes = generateRecoveryCodes();
  await sqlOwner`
    UPDATE users SET totp_enabled_at = now(), totp_last_step = ${step},
           totp_recovery_hashes = ${recoveryCodes.map(hashRecoveryCode)}
     WHERE id = ${me.id}`;
  mfaLimiter.reset(me.id);
  await audit(c, "auth.totp_enabled", { targetType: "user", targetId: me.id });
  return c.json({ recoveryCodes });
});

const DisableBody = z.object({ password: z.string().min(1).max(200), code: z.string().trim().min(6).max(32) });

/** Desactiva el 2FA: exige la contraseña y un código (TOTP o de recuperación). */
authRoutes.post("/totp/disable", requireAuth, async (c) => {
  const body = parse(DisableBody, await c.req.json().catch(() => ({})));
  const me = c.get("user");
  if (!mfaLimiter.hit(me.id)) throw new HttpError(429, "Demasiados intentos. Espera unos minutos.");
  const [pw] = await sqlOwner<{ password_hash: string | null }[]>`SELECT password_hash FROM users WHERE id = ${me.id}`;
  const row = await loadTotp(me.id);
  if (!row?.totp_enabled_at) throw badRequest("La verificación en dos pasos no está activa");
  if (!pw?.password_hash || !(await verifyPassword(body.password, pw.password_hash)) || !(await consumeSecondFactor(row, body.code))) {
    throw badRequest("Contraseña o código incorrectos");
  }
  mfaLimiter.reset(me.id);
  await sqlOwner`
    UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, totp_recovery_hashes = '{}' WHERE id = ${me.id}`;
  await audit(c, "auth.totp_disabled", { targetType: "user", targetId: me.id });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Recuperación de contraseña e invitaciones (enlaces de un solo uso)
// ---------------------------------------------------------------------------

// Usuario o email: el enlace solo se puede enviar si la cuenta tiene un email registrado.
const ForgotBody = z
  .object({ login: z.string().trim().min(1).max(254).optional(), email: z.string().trim().min(1).max(254).optional() })
  .refine((b) => b.login ?? b.email, "Falta el usuario o el email");

/**
 * Pide un enlace para restablecer la contraseña. Responde siempre lo mismo,
 * exista o no la cuenta, para no revelar quién la tiene.
 */
authRoutes.post("/forgot", async (c) => {
  const body = parse(ForgotBody, await c.req.json().catch(() => ({})));
  const login = (body.login ?? body.email)!.toLowerCase();
  const ip = clientIp(c);
  const generic = {
    ok: true,
    emailEnabled: emailEnabled(),
    message: emailEnabled()
      ? "Si la cuenta existe y tiene un email registrado, recibirás un enlace para elegir una nueva contraseña. Si no lo recibes, pide a un administrador que la restablezca."
      : "El envío de correos no está configurado. Pide a un administrador que restablezca tu contraseña.",
  };
  if (!emailEnabled() || !forgotLimiter.hit(`${ip}|${login}`)) return c.json(generic);

  const [user] = await sqlOwner<{ id: string; tenant_id: string; name: string; username: string; email: string; tenant_name: string }[]>`
    SELECT u.id, u.tenant_id, u.name, u.username, u.email, t.name AS tenant_name
      FROM users u JOIN tenants t ON t.id = u.tenant_id
     WHERE ${byLogin(login)}
       AND u.email IS NOT NULL AND u.is_active AND t.is_active AND u.password_hash IS NOT NULL`;
  if (user) {
    const url = await createUserLink({ tenantId: user.tenant_id, userId: user.id, kind: "reset", createdBy: null });
    await emailLink("reset", user, url, user.tenant_name);
    await auditLog({ tenantId: user.tenant_id, userId: user.id, username: user.username, ip }, "auth.reset_requested");
  }
  return c.json(generic);
});

/** Comprueba un enlace antes de mostrar el formulario. */
authRoutes.get("/link", async (c) => {
  const token = c.req.query("token") ?? "";
  if (!tokenLimiter.hit(clientIp(c))) throw new HttpError(429, "Demasiados intentos. Espera unos minutos.");
  const valid = await findValidToken(token);
  if (!valid) throw notFound("El enlace no es válido o ha caducado. Pide uno nuevo.");
  return c.json({ kind: valid.kind, username: valid.username, email: valid.email, name: valid.name });
});

const AcceptBody = z.object({
  token: z.string().min(10).max(200),
  password: z.string(),
  name: z.string().trim().min(1).max(120).optional(),
});

/** Usa el enlace: fija la contraseña (y el nombre, si es una invitación) e inicia sesión. */
authRoutes.post("/link", async (c) => {
  const body = parse(AcceptBody, await c.req.json().catch(() => ({})));
  if (!tokenLimiter.hit(clientIp(c))) throw new HttpError(429, "Demasiados intentos. Espera unos minutos.");
  const problem = passwordProblem(body.password);
  if (problem) throw badRequest(problem);
  const valid = await findValidToken(body.token);
  if (!valid) throw notFound("El enlace no es válido o ha caducado. Pide uno nuevo.");

  const hash = await hashPassword(body.password);
  const user = await sqlOwner.begin(async (tx) => {
    // Marcar como usado de forma atómica: si dos peticiones llegan a la vez, solo una gana.
    const [used] = await tx`UPDATE user_tokens SET used_at = now() WHERE id = ${valid.id} AND used_at IS NULL RETURNING id`;
    if (!used) throw notFound("El enlace ya se ha utilizado.");
    const [u] = await tx<SessionUser[]>`
      UPDATE users SET password_hash = ${hash}, sessions_valid_after = date_trunc('second', now()),
             name = CASE WHEN ${valid.kind} = 'invite' THEN coalesce(${body.name ?? null}, name) ELSE name END
       WHERE id = ${valid.userId}
      RETURNING id, tenant_id, name, username, email, role, is_superadmin`;
    // Anular cualquier otro enlace pendiente de este usuario.
    await tx`UPDATE user_tokens SET used_at = now() WHERE user_id = ${valid.userId} AND used_at IS NULL`;
    return u!;
  });

  const session = await startSession(c, user);
  await auditLog(
    { tenantId: user.tenant_id, userId: user.id, username: user.username, ip: clientIp(c) },
    "auth.link_used",
    { details: { kind: valid.kind } },
  );
  return c.json(session);
});
