import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import { decodeJwt } from "jose";
import { sqlOwner } from "../db/client.js";
import { clientIp, secureCookie } from "../lib/request.js";
import { signSession, type SessionClaims } from "./jwt.js";
import { SESSION_COOKIE } from "./middleware.js";

/**
 * Firma la sesión, la registra (para listarla y cerrarla desde Mi cuenta), pone la cookie httpOnly y devuelve el
 * token. Las sesiones de soporte (con `actorId`) no se registran: dependen de la del superadministrador.
 */
export async function issueSession(c: Context, claims: SessionClaims): Promise<string> {
  await sqlOwner`UPDATE users SET last_login_at = now() WHERE id = ${claims.userId}`;
  const sessionId = claims.actorId ? undefined : randomUUID();
  const token = await signSession({ ...claims, sessionId });
  if (sessionId) {
    const userAgent = c.req.header("user-agent")?.slice(0, 300) ?? null;
    await sqlOwner`
      INSERT INTO user_sessions (id, user_id, expires_at, ip, user_agent)
      VALUES (${sessionId}, ${claims.userId}, to_timestamp(${decodeJwt(token).exp!}), ${clientIp(c)}, ${userAgent})`;
  }
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookie(c),
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return token;
}

/**
 * Invalida todas las sesiones emitidas hasta ahora de un usuario. Se trunca al segundo
 * porque el JWT guarda su fecha en segundos: una sesión creada justo después sigue valiendo.
 */
export async function revokeSessions(userId: string): Promise<void> {
  await sqlOwner`UPDATE users SET sessions_valid_after = date_trunc('second', now()) WHERE id = ${userId}`;
  await sqlOwner`UPDATE user_sessions SET revoked_at = now() WHERE user_id = ${userId} AND revoked_at IS NULL`;
}

/** Cierra una sesión concreta del usuario. Devuelve `false` si no existe, ya estaba cerrada o es de otra persona. */
export async function revokeSession(userId: string, sessionId: string): Promise<boolean> {
  const rows = await sqlOwner`
    UPDATE user_sessions SET revoked_at = now()
     WHERE id = ${sessionId} AND user_id = ${userId} AND revoked_at IS NULL RETURNING id`;
  return rows.length > 0;
}
