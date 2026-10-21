import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

/**
 * Almacenamiento de los archivos originales en disco (un volumen de Docker).
 * Estructura: <STORAGE_DIR>/<tenant_id>/<document_id>/<archivo>
 *
 * Si en el futuro se necesita S3 u otro servicio, basta con reimplementar
 * estas tres funciones.
 */
const root = path.resolve(config.STORAGE_DIR);

function resolveKey(key: string): string {
  const full = path.resolve(root, key);
  if (!full.startsWith(root + path.sep)) throw new Error("Ruta de almacenamiento inválida");
  return full;
}

/**
 * Nombre de archivo seguro (sin rutas ni caracteres raros). Los acentos se quitan
 * (Muñoz → Munoz): al separar «ñ» en «n» + tilde, la tilde suelta se convertía en «_».
 */
export function safeFilename(name: string): string {
  const base = path.basename(name).normalize("NFKD").replace(/\p{M}+/gu, "").replace(/[^\w.\-]+/g, "_");
  return base.slice(-150) || "archivo";
}

/** Título legible a partir del nombre original del archivo, conservando acentos y eñes. */
export function titleFromFilename(name: string): string {
  const original = path.basename(name).normalize("NFC");
  const clean = original.replace(/\p{Cc}/gu, "");
  return clean.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || clean;
}

export async function saveFile(key: string, data: Uint8Array): Promise<void> {
  const full = resolveKey(key);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, data);
}

export const readStoredFile = (key: string): Promise<Buffer> => readFile(resolveKey(key));

/** Borra un archivo o una carpeta completa (p. ej. todos los archivos de un documento). */
export async function removeStored(keyOrPrefix: string): Promise<void> {
  await rm(resolveKey(keyOrPrefix), { recursive: true, force: true });
}
