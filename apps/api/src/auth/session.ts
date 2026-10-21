import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import { sqlOwner } from "../db/client.js";
import { secureCookie } from "../lib/request.js";
import { signSession, type SessionClaims } from "./jwt.js";
import { SESSION_COOKIE } from "./middleware.js";

/** Firma la sesión, pone la cookie httpOnly y devuelve el token. */
export async function issueSession(c: Context, claims: SessionClaims): Promise<string> {
  await sqlOwner`UPDATE users SET last_login_at = now() WHERE id = ${claims.userId}`;
  const token = await signSession(claims);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookie(c),
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return token;
}
