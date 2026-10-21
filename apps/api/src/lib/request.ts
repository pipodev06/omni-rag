import type { Context } from "hono";
import { config } from "../config.js";

/** IP del cliente (primer valor de X-Forwarded-For, que añaden Caddy/nginx). */
export function clientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

/** ¿La petición llegó por HTTPS? (directamente o a través del proxy). */
export function isHttps(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  return proto === "https" || new URL(c.req.url).protocol === "https:";
}

/** Marca de "Secure" para la cookie de sesión según COOKIE_SECURE (auto/true/false). */
export function secureCookie(c: Context): boolean {
  if (config.COOKIE_SECURE === "true") return true;
  if (config.COOKIE_SECURE === "false") return false;
  return isHttps(c);
}
