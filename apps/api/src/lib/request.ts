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

/**
 * Clave de IP para los limitadores de intentos: IPv4 tal cual; IPv6 agrupada por su /64 (una conexión doméstica o un
 * servidor reciben un /64 entero, así que cada dirección suelta no es «otro cliente»). Solo para limitar: los registros
 * guardan la IP completa.
 */
export function ipLimitKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const full = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${full.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
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
