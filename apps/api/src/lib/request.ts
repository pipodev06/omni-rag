import type { Context } from "hono";
import { config } from "../config.js";
import { isRealDomain } from "./secrets.js";

/**
 * IP del cliente según X-Forwarded-For. Los primeros valores los puede escribir el propio cliente, así que se cuenta
 * desde el final: el último lo añade nuestro nginx interno (la dirección del proxy que tiene delante) y cada proxy de
 * confianza añade uno más. Con `TRUSTED_PROXY_HOPS` proxies delante (1 = Caddy o un nginx; 2 = túnel de Cloudflare +
 * Nginx Proxy Manager) el cliente real está en la posición `longitud - 1 - hops`. Si se pone de menos, todos los
 * usuarios aparecen con la IP del último proxy (y comparten el límite por IP); si se pone de más, se puede falsificar.
 */
export function clientIp(c: Context, hops = config.TRUSTED_PROXY_HOPS): string {
  const ips = (c.req.header("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const i = ips.length - 1 - hops;
  return (i >= 0 ? ips[i] : ips[0]) || "local";
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
