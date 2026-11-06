import { randomInt, timingSafeEqual } from "node:crypto";

/**
 * Código de un solo uso de la configuración inicial. Mientras no haya ningún usuario, la API genera uno al arrancar y
 * lo escribe en sus registros («docker compose logs api»): quien abre la web debe escribirlo para crear el
 * superadministrador. Así, aunque el servidor esté expuesto, solo puede configurarlo quien tiene acceso al servidor.
 * Vive en memoria: si la API se reinicia, sale uno nuevo.
 *
 * No se cambia tras varios fallos: un contador global dejaría que cualquiera bloqueara la configuración mandando
 * códigos malos. Lo protege su entropía (12 caracteres de 32 posibles, 60 bits) más el límite por IP de las peticiones
 * sin sesión; cada fallo queda en los registros con su IP.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin 0/O ni 1/I

let current: string | null = null;

function generate(): string {
  const pick = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${pick()}-${pick()}-${pick()}`;
}

/** Genera un código nuevo y lo escribe en los registros. */
export function announceSetupCode(log: (msg: string) => void = console.log): string {
  current = generate();
  const line = "=".repeat(64);
  log(`\n${line}\n  CONFIGURACIÓN INICIAL DE OMNI RAG\n  Abre la web y escribe este código de un solo uso: ${current}\n${line}\n`);
  return current;
}

const normalize = (s: string) => s.trim().toUpperCase().replace(/[\s-]/g, "");

/** ¿Es el código vigente? Comparación en tiempo constante. */
export function checkSetupCode(input: string): boolean {
  if (!current) return false;
  const a = Buffer.from(normalize(input));
  const b = Buffer.from(normalize(current));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Ya se usó: no vale para nada más. */
export function clearSetupCode(): void {
  current = null;
}
