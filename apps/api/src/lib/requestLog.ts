import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../auth/middleware.js";
import { logEvent, withRequestId } from "./logger.js";
import { clientIp } from "./request.js";

// Peticiones que se repiten constantemente y solo meterían ruido.
const QUIET = new Set(["/api/health", "/api/auth/me"]);

/**
 * Da a cada petición un identificador (cabecera `X-Request-Id`, también en los registros que genere) y deja una línea
 * al terminar con método, ruta, estado, duración, IP y, si hay sesión, usuario y organización. No se guarda la
 * query ni el cuerpo: pueden llevar datos sensibles.
 */
export const requestLog: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = randomUUID().slice(0, 8);
  c.header("x-request-id", requestId);
  const started = Date.now();
  await withRequestId(requestId, async () => {
    await next();
    if (QUIET.has(c.req.path)) return;
    const status = c.res.status;
    const user = c.get("user");
    logEvent(status >= 500 ? "error" : status === 429 ? "warn" : "info", "http", {
      method: c.req.method,
      path: c.req.path,
      status,
      ms: Date.now() - started,
      ip: clientIp(c),
      ...(user && { userId: user.id, tenantId: user.tenantId }),
    });
  });
};
