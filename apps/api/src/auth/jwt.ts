import { SignJWT, jwtVerify } from "jose";
import { config } from "../config.js";
import type { Role } from "../db/client.js";

const key = new TextEncoder().encode(config.JWT_SECRET);
const ISSUER = "rag-project";

export interface SessionClaims {
  userId: string;
  tenantId: string;
  role: Role;
  /** Superadministrador que usa esta sesión como soporte (cuenta de soporte). */
  actorId?: string;
  /** Identificador de esta sesión (`jti`): permite verla y cerrarla individualmente. Las de soporte no lo llevan. */
  sessionId?: string;
  /** Cuándo se emitió (segundos Unix); solo al verificar. */
  iat?: number;
}

export async function signSession(claims: SessionClaims): Promise<string> {
  return new SignJWT({ tid: claims.tenantId, role: claims.role, ...(claims.actorId && { act: claims.actorId }), ...(claims.sessionId && { jti: claims.sessionId }) })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(config.JWT_EXPIRES_IN)
    .sign(key);
}

export async function verifySession(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || typeof payload.tid !== "string") return null;
    const actorId = typeof payload.act === "string" ? payload.act : undefined;
    const sessionId = typeof payload.jti === "string" ? payload.jti : undefined;
    return { userId: payload.sub, tenantId: payload.tid, role: payload.role as Role, actorId, sessionId, iat: payload.iat };
  } catch {
    return null;
  }
}

const MFA_PURPOSE = "mfa";

/** Token de 5 minutos que solo sirve para completar el segundo paso del login (no abre sesión). */
export async function signMfaToken(userId: string): Promise<string> {
  return new SignJWT({ purpose: MFA_PURPOSE })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}

export async function verifyMfaToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, algorithms: ["HS256"] });
    return payload.purpose === MFA_PURPOSE && typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}
