import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../auth/middleware.js";
import { config } from "../config.js";
import { isRealDomain } from "./secrets.js";
import { HttpError } from "./errors.js";
import { RateLimiter } from "./rateLimit.js";

/**
 * Limita cuántas veces por ventana puede llamar un usuario a una ruta cara
 * (chat, búsqueda, subidas, resúmenes). Se mide por usuario autenticado y no por IP:
 * la IP puede falsearse con X-Forwarded-For. Va después de `requireAuth`.
 */
export function userRateLimit(max: number, windowMs: number, what: string): MiddlewareHandler<AppEnv> {
  const limiter = new RateLimiter(max, windowMs);
  return async (c, next) => {
    if (!limiter.hit(c.get("user").id)) throw new HttpError(429, `Demasiadas ${what} seguidas. Espera un momento.`);
    await next();
  };
}

/** ¿Se exige verificación en dos pasos al superadministrador? `auto` = solo con dominio público. */
export const superadmin2faRequired = (): boolean =>
  config.REQUIRE_SUPERADMIN_2FA === "true" || (config.REQUIRE_SUPERADMIN_2FA === "auto" && isRealDomain(config.DOMAIN));
