import type { Context } from "hono";
import { config } from "../config.js";
import { isRealDomain } from "./secrets.js";

/**
 * IP del cliente. La calcula el nginx de la web (módulo realip: salta los proxies de redes privadas que haya delante y
 * se queda con la primera IP pública) y la envía en X-Real-IP, reescribiendo lo que mande el cliente. La API no publica
 * puerto, así que solo le llegan peticiones de ese nginx y la cabecera es de fiar.
 */
export function clientIp(c: Context): string {
  return c.req.header("x-real-ip")?.trim() || "local";
}

/** ¿La petición llegó por HTTPS? (directamente o a través del proxy). */
export function isHttps(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  return proto === "https" || new URL(c.req.url).protocol === "https:";
}

/** Marca de "Secure" para la cookie de sesión según COOKIE_SECURE (auto/true/false). */
export function secureCookie(c: Context): boolean {
  // Con un dominio público el sitio solo se sirve por HTTPS: la cookie siempre es segura,
  // aunque el .env copiado de desarrollo diga COOKIE_SECURE=false.
  if (isRealDomain(config.DOMAIN)) return true;
  if (config.COOKIE_SECURE === "true") return true;
  if (config.COOKIE_SECURE === "false") return false;
  return isHttps(c);
}
