import { randomInt, timingSafeEqual } from "node:crypto";

/**
 * Código de un solo uso de la configuración inicial. Mientras no haya ningún usuario, la API genera uno al arrancar y
 * lo escribe en sus registros («docker compose logs api»): quien abre la web debe escribirlo para crear el
 * superadministrador. Así, aunque el servidor esté expuesto, solo puede configurarlo quien tiene acceso al servidor.
 * Vive en memoria: si la API se reinicia, sale uno nuevo. Mientras falte configurar se vuelve a escribir cada 10 minutos
 * (`reprintSetupCode`), así siempre está en `docker compose logs --since 10m api` aunque alguien llene los registros.
 *
 * No se cambia tras varios fallos: un contador global dejaría que cualquiera bloqueara la configuración mandando
 * códigos malos. Lo que lo protege es su entropía: 12 caracteres de 32 posibles son 60 bits, que no se adivinan ni sin
 * el límite por IP (IP_RATE_LIMIT_PER_MIN, que frena además los intentos pero se puede desactivar). Los fallos quedan en
 * el registro de peticiones (POST /api/setup con 403 y la IP).
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin 0/O ni 1/I

let current: string | null = null;
let reminder: NodeJS.Timeout | null = null;

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

/** Vuelve a escribir el código vigente (el mismo), si lo hay. */
export function reprintSetupCode(log: (msg: string) => void = console.log): void {
  if (current) log(`[setup] la configuración inicial sigue pendiente. Código de un solo uso: ${current}`);
}

/** Repite el código cada `everyMs` hasta que se use (clearSetupCode para el temporizador). */
export function remindSetupCode(everyMs = 10 * 60_000): void {
  if (reminder) clearInterval(reminder);
  reminder = setInterval(() => reprintSetupCode(), everyMs);
  reminder.unref();
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
  if (reminder) clearInterval(reminder);
  reminder = null;
}
