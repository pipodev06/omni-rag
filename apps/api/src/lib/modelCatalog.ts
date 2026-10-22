import { getProvider, isConfigured, parseModelRef, type LlmProvider } from "./llmProviders.js";

/**
 * Catálogo de modelos de cada proveedor (`GET {base}/models`), para comprobar al guardar un plan que cada modelo
 * existe. Se guarda en memoria una hora por proveedor; si se pide un modelo que no está, se vuelve a descargar una
 * vez (por si es nuevo). Si el proveedor no responde o no tiene catálogo (servidor propio), no se bloquea nada.
 */
const TTL_MS = 60 * 60 * 1000;
const REFRESH_AFTER_MS = 60 * 1000;

const caches = new Map<string, { at: number; ids: Set<string> }>();

async function fetchCatalog(p: LlmProvider): Promise<Set<string> | null> {
  try {
    const res = await fetch(`${p.baseUrl}/models`, {
      signal: AbortSignal.timeout(6000),
      headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { id?: string }[] };
    // Google devuelve «models/gemini-…» pero se pide como «gemini-…».
    const ids = new Set((body.data ?? []).map((m) => m.id?.replace(/^models\//, "")).filter((id): id is string => typeof id === "string"));
    if (ids.size === 0) throw new Error("catálogo vacío");
    caches.set(p.id, { at: Date.now(), ids });
    return ids;
  } catch (err) {
    console.warn(`[${p.id}] no se pudo descargar el catálogo de modelos:`, err instanceof Error ? err.message : err);
    return caches.get(p.id)?.ids ?? null;
  }
}

// Variantes de enrutado de OpenRouter: se piden como «modelo:variante» y no siempre salen en el catálogo.
const ROUTING_SUFFIXES = new Set(["nitro", "floor", "online", "exacto", "extended", "thinking"]);

/** Modelos de la lista que no están en el catálogo (pura, para poder probarla). */
export function findUnknown(models: string[], catalog: Set<string>, routingSuffixes = true): string[] {
  return models.filter((m) => {
    if (catalog.has(m)) return false;
    const i = m.lastIndexOf(":");
    return !(routingSuffixes && i > 0 && ROUTING_SUFFIXES.has(m.slice(i + 1)) && catalog.has(m.slice(0, i)));
  });
}

async function catalogFor(p: LlmProvider): Promise<Set<string> | null> {
  const c = caches.get(p.id);
  return c && Date.now() - c.at < TTL_MS ? c.ids : fetchCatalog(p);
}

export interface ModelCheck {
  /** Proveedores usados en la lista que no tienen clave configurada. */
  unconfigured: string[];
  /** Modelos (como los escribió el usuario) que no existen en el catálogo de su proveedor. */
  unknown: string[];
}

/**
 * Comprueba una lista de modelos de un plan. Un proveedor sin catálogo accesible se acepta sin comprobar
 * (se avisa en el log): no se bloquea al administrador por una caída de red.
 */
export async function checkModels(refs: string[]): Promise<ModelCheck> {
  const parsed = refs.map((ref) => ({ ref, ...parseModelRef(ref) }));
  const result: ModelCheck = { unconfigured: [], unknown: [] };
  for (const providerId of new Set(parsed.map((p) => p.providerId))) {
    const provider = getProvider(providerId);
    if (!provider || !isConfigured(provider)) {
      result.unconfigured.push(provider ? `${provider.label} (${provider.keyVar})` : providerId);
      continue;
    }
    const mine = parsed.filter((p) => p.providerId === providerId);
    let catalog = await catalogFor(provider);
    if (!catalog) continue;
    const names = mine.map((m) => m.model);
    let unknown = findUnknown(names, catalog, provider.kind === "openrouter");
    // Un modelo recién publicado puede no estar aún en la copia guardada: se refresca una vez.
    const cached = caches.get(provider.id);
    if (unknown.length > 0 && cached && Date.now() - cached.at > REFRESH_AFTER_MS) {
      catalog = (await fetchCatalog(provider)) ?? catalog;
      unknown = findUnknown(names, catalog, provider.kind === "openrouter");
    }
    for (const m of mine) if (unknown.includes(m.model)) result.unknown.push(m.ref);
  }
  return result;
}
