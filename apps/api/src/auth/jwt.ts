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
}

export async function signSession(claims: SessionClaims): Promise<string> {
  return new SignJWT({ tid: claims.tenantId, role: claims.role, ...(claims.actorId && { act: claims.actorId }) })
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
    return { userId: payload.sub, tenantId: payload.tid, role: payload.role as Role, actorId };
  } catch {
    return null;
  }
}
