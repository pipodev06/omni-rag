import type { Context } from "hono";
import { config } from "../config.js";
import { isRealDomain } from "./secrets.js";

/**
 * IP del cliente según X-Forwarded-For. El primer valor lo puede escribir el propio cliente, así
 * que se toma el penúltimo: el último lo añade nuestro nginx interno (la dirección del proxy
 * externo) y el penúltimo es la que ese proxy vio del cliente, con Caddy o con otro nginx.
 */
export function clientIp(c: Context): string {
  const ips = (c.req.header("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return (ips.length >= 2 ? ips[ips.length - 2] : ips[0]) || "local";
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
