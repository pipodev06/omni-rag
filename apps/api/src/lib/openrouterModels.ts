import { config } from "../config.js";

/**
 * Catálogo público de modelos de OpenRouter (no pide clave), para comprobar al guardar un plan que
 * cada modelo existe. Se guarda en memoria una hora; si se pide un modelo que no está, se vuelve a
 * descargar una vez (por si es nuevo). Si OpenRouter no responde no se bloquea nada: se avisa en el log.
 */
const TTL_MS = 60 * 60 * 1000;
const REFRESH_AFTER_MS = 60 * 1000;

let cache: { at: number; ids: Set<string> } | null = null;

async function fetchCatalog(): Promise<Set<string> | null> {
  try {
    const res = await fetch(`${config.OPENROUTER_BASE_URL.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { id?: string }[] };
    const ids = new Set((body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string"));
    if (ids.size === 0) throw new Error("catálogo vacío");
    cache = { at: Date.now(), ids };
    return ids;
  } catch (err) {
    console.warn("[openrouter] no se pudo descargar el catálogo de modelos:", err instanceof Error ? err.message : err);
    return cache?.ids ?? null;
  }
}

// Variantes de enrutado de OpenRouter: se piden como «modelo:variante» y no siempre salen en el catálogo.
const ROUTING_SUFFIXES = new Set(["nitro", "floor", "online", "exacto", "extended", "thinking"]);

/** Modelos de la lista que no están en el catálogo (pura, para poder probarla). */
export function findUnknown(models: string[], catalog: Set<string>): string[] {
  return models.filter((m) => {
    if (catalog.has(m)) return false;
    const i = m.lastIndexOf(":");
    return !(i > 0 && ROUTING_SUFFIXES.has(m.slice(i + 1)) && catalog.has(m.slice(0, i)));
  });
}

/**
 * Devuelve los modelos que no existen en OpenRouter, o `null` si no se pudo comprobar
 * (sin conexión): en ese caso se acepta lo que haya escrito el superadministrador.
 */
export async function unknownModels(models: string[]): Promise<string[] | null> {
  let catalog = cache && Date.now() - cache.at < TTL_MS ? cache.ids : await fetchCatalog();
  if (!catalog) return null;
  let unknown = findUnknown(models, catalog);
  // Un modelo recién publicado puede no estar aún en la copia guardada: se refresca una vez.
  if (unknown.length > 0 && cache && Date.now() - cache.at > REFRESH_AFTER_MS) {
    catalog = (await fetchCatalog()) ?? catalog;
    unknown = findUnknown(models, catalog);
  }
  return unknown;
}
