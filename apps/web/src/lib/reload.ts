/** ¿El error es porque falta un archivo de la app (se publicó una versión nueva)? */
export const isChunkError = (err: unknown) =>
  /dynamically imported module|Importing a module script failed|ChunkLoadError/i.test(String((err as Error)?.message ?? err));

const RELOAD_KEY = "rag:recarga-automatica";
const MIN_INTERVAL_MS = 30_000;

/**
 * Recarga la página cuando falla la descarga de una parte de la app (pasa al
 * publicar una versión nueva con la pestaña abierta). Como mucho una vez cada
 * 30 s, para no entrar en bucle si el archivo de verdad no existe.
 */
export function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < MIN_INTERVAL_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false; // sin sessionStorage no se puede evitar el bucle: mostrar el aviso
  }
  window.location.reload();
  return true;
}
