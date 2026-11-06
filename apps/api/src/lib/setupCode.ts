import { randomInt, timingSafeEqual } from "node:crypto";

/**
 * Código de un solo uso de la configuración inicial. Mientras no haya ningún usuario, la API genera uno al arrancar y
 * lo escribe en sus registros («docker compose logs api»): quien abre la web debe escribirlo para crear el
 * superadministrador. Así, aunque el servidor esté expuesto, solo puede configurarlo quien tiene acceso al servidor.
 * Vive en memoria: si la API se reinicia, sale uno nuevo. Tras 5 intentos fallidos se cambia por otro.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin 0/O ni 1/I
const MAX_ATTEMPTS = 5;

let current: string | null = null;
let failures = 0;

function generate(): string {
  const pick = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${pick()}-${pick()}-${pick()}`;
}

/** Genera un código nuevo y lo escribe en los registros. */
export function announceSetupCode(log: (msg: string) => void = console.log): string {
  current = generate();
  failures = 0;
  const line = "=".repeat(64);
  log(`\n${line}\n  CONFIGURACIÓN INICIAL DE OMNI RAG\n  Abre la web y escribe este código de un solo uso: ${current}\n${line}\n`);
  return current;
}

const normalize = (s: string) => s.trim().toUpperCase().replace(/[\s-]/g, "");

/** ¿Es el código vigente? Cuenta los fallos y, al llegar al máximo, cambia el código (sale de nuevo en los registros). */
export function checkSetupCode(input: string, log?: (msg: string) => void): boolean {
  if (!current) return false;
  const a = Buffer.from(normalize(input));
  const b = Buffer.from(normalize(current));
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (ok) return true;
  failures += 1;
  if (failures >= MAX_ATTEMPTS) announceSetupCode(log);
  return false;
}

/** Ya se usó: no vale para nada más. */
export function clearSetupCode(): void {
  current = null;
  failures = 0;
}
