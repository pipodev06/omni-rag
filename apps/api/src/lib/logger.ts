import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";
import { config } from "../config.js";

/**
 * Registros estructurados: con LOG_FORMAT=json (por defecto) cada evento es una línea JSON con hora, nivel, mensaje
 * y campos (`component`, `requestId`, `err`…), fácil de buscar y filtrar. Los `console.log/warn/error` existentes se
 * convierten solos, y dentro de una petición HTTP cada línea lleva el `requestId` que también recibe el cliente en
 * la cabecera `X-Request-Id`. Con LOG_FORMAT=text no se toca la consola.
 */
type Level = "info" | "warn" | "error";
type Fields = Record<string, unknown>;

const context = new AsyncLocalStorage<{ requestId: string }>();

/** Ejecuta `fn` con un identificador de petición que se añade a todos los registros que genere. */
export const withRequestId = <T>(requestId: string, fn: () => T): T => context.run({ requestId }, fn);
export const currentRequestId = (): string | undefined => context.getStore()?.requestId;

/** Separa los argumentos de un `console.*`: el texto, la etiqueta `[componente]` inicial y el primer error. */
export function splitLogArgs(args: unknown[]): { msg: string; component?: string; err?: { name: string; message: string; stack?: string } } {
  const error = args.find((a): a is Error => a instanceof Error);
  const text = format(...args.map((a) => (a instanceof Error ? a.message : a)));
  const tag = /^\[([^\]]+)\]\s*/.exec(text);
  return {
    msg: tag ? text.slice(tag[0].length) : text,
    ...(tag && { component: tag[1] }),
    ...(error && { err: { name: error.name, message: error.message, stack: error.stack } }),
  };
}

export function buildLine(level: Level, msg: string, fields: Fields = {}, now = new Date(), requestId = currentRequestId()): string {
  return JSON.stringify({ time: now.toISOString(), level, msg, ...(requestId && { requestId }), ...fields });
}

const original = { log: console.log, warn: console.warn, error: console.error };

/** Escribe un evento (con campos) en el formato configurado. */
export function logEvent(level: Level, msg: string, fields: Fields = {}): void {
  if (config.LOG_FORMAT === "json") {
    (level === "error" ? process.stderr : process.stdout).write(`${buildLine(level, msg, fields)}\n`);
    return;
  }
  const detail = Object.entries(fields).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" ");
  const rid = currentRequestId();
  original[level === "info" ? "log" : level](`${msg}${detail ? ` ${detail}` : ""}${rid ? ` [${rid}]` : ""}`);
}

/** Convierte `console.log/warn/error` en eventos estructurados. Se llama una vez al arrancar la API y el worker. */
export function installLogger(): void {
  if (config.LOG_FORMAT !== "json") return;
  const emit = (level: Level) => (...args: unknown[]) => {
    const { msg, component, err } = splitLogArgs(args);
    logEvent(level, msg, { ...(component && { component }), ...(err && { err }) });
  };
  console.log = emit("info");
  console.info = emit("info");
  console.warn = emit("warn");
  console.error = emit("error");
}
