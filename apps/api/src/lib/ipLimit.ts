import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { verifySession } from "../auth/jwt.js";
import { SESSION_COOKIE } from "../auth/middleware.js";
import { config } from "../config.js";
import { HttpError } from "./errors.js";
import { RateLimiter } from "./rateLimit.js";
import { clientIp } from "./request.js";



/**
 * Límite global por IP para las peticiones que NO traen una sesión válida (bots, escaneos, fuerza bruta de
 * enlaces, inundación de la API). Quien ya inició sesión no cuenta aquí: tiene sus propios límites por usuario.
 * La comprobación del token es solo criptográfica (sin base de datos), así que un token falso no esquiva el límite.
 * `/api/health` queda fuera para no cortar a los monitores externos.
 */
export function ipRateLimit(max = config.IP_RATE_LIMIT_PER_MIN): MiddlewareHandler {
  const limiter = new RateLimiter(Math.max(max, 1), 60_000);
  return async (c, next) => {
    if (max === 0 || c.req.path === "/api/health") return next();
    const header = c.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : getCookie(c, SESSION_COOKIE);
    if (token && (await verifySession(token))) return next();
    if (!limiter.hit(clientIp(c))) {
      c.header("retry-after", "60");
      throw new HttpError(429, "Demasiadas peticiones desde tu red. Espera un minuto e inténtalo de nuevo.");
    }
    return next();
  };
}
