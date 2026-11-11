import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { verifySession } from "../auth/jwt.js";
import { SESSION_COOKIE } from "../auth/middleware.js";
import { HttpError } from "./errors.js";
import { RateLimiter } from "./rateLimit.js";
import { clientIp, ipLimitKey } from "./request.js";
import { setting } from "./settings.js";

/**
 * Límite global por IP para las peticiones que NO traen una sesión válida (bots, escaneos, fuerza bruta de
 * enlaces, inundación de la API). Quien ya inició sesión no cuenta aquí: tiene sus propios límites por usuario.
 * La comprobación del token es solo criptográfica (sin base de datos), así que un token falso no esquiva el límite.
 * `/api/health` queda fuera para no cortar a los monitores externos.
 */
export function ipRateLimit(fixedMax?: number): MiddlewareHandler {
  let limiter: RateLimiter | null = null;
  let limiterMax = 0;
  return async (c, next) => {
    // El tope se lee en cada petición: cambia desde Sistema → Configuración sin reiniciar.
    const max = fixedMax ?? setting("IP_RATE_LIMIT_PER_MIN");
    if (max === 0 || c.req.path === "/api/health") return next();
    const header = c.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : getCookie(c, SESSION_COOKIE);
    if (token && (await verifySession(token))) return next();
    if (!limiter || limiterMax !== max) {
      limiter = new RateLimiter(max, 60_000);
      limiterMax = max;
    }
    if (!limiter.hit(ipLimitKey(clientIp(c)))) {
      c.header("retry-after", "60");
      throw new HttpError(429, "Demasiadas peticiones desde tu red. Espera un minuto e inténtalo de nuevo.");
    }
    return next();
  };
}
