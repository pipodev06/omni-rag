import { config } from "../config.js";

/** Un resultado de internet tal como se le da al modelo y se muestra como fuente. */
export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Búsqueda en internet para el modo híbrido (documentos + web). Un buscador propio en vez de la búsqueda de cada
 * proveedor de modelos, para que funcione igual con cualquier modelo del plan:
 *   - tavily   POST https://api.tavily.com/search           (WEB_SEARCH_API_KEY)
 *   - brave    GET  https://api.search.brave.com/res/v1/web/search  (WEB_SEARCH_API_KEY)
 *   - searxng  GET  <WEB_SEARCH_URL>/search?format=json   (servidor propio; sin clave)
 * Solo se envía la pregunta: nunca fragmentos de los documentos.
 */
export function webSearchEnabled(): boolean {
  const p = config.WEB_SEARCH_PROVIDER;
  if (p === "searxng") return config.WEB_SEARCH_URL !== "";
  return (p === "tavily" || p === "brave") && config.WEB_SEARCH_API_KEY !== "";
}

const clip = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Solo enlaces http(s) completos: un resultado con `javascript:` u otro esquema se descarta. */
function clean(results: { title?: unknown; url?: unknown; snippet?: unknown }[], max: number): WebResult[] {
  const out: WebResult[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    const url = typeof r.url === "string" ? r.url.trim() : "";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || seen.has(parsed.href)) continue;
    seen.add(parsed.href);
    out.push({ title: clip(r.title, 200) || parsed.hostname, url: parsed.href, snippet: clip(r.snippet, 700) });
    if (out.length >= max) break;
  }
  return out;
}

export async function searchWeb(query: string, signal?: AbortSignal): Promise<WebResult[]> {
  const max = config.WEB_SEARCH_MAX_RESULTS;
  const timeout = AbortSignal.timeout(10_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const q = query.slice(0, 400);

  if (config.WEB_SEARCH_PROVIDER === "tavily") {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.WEB_SEARCH_API_KEY}` },
      body: JSON.stringify({ api_key: config.WEB_SEARCH_API_KEY, query: q, max_results: max, search_depth: "basic", include_answer: false }),
      signal: combined,
    });
    if (!res.ok) throw new Error(`Tavily respondió HTTP ${res.status}`);
    const body = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
    return clean((body.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })), max);
  }

  if (config.WEB_SEARCH_PROVIDER === "brave") {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${max}`;
    const res = await fetch(url, { headers: { accept: "application/json", "x-subscription-token": config.WEB_SEARCH_API_KEY }, signal: combined });
    if (!res.ok) throw new Error(`Brave Search respondió HTTP ${res.status}`);
    const body = (await res.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    return clean((body.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description?.replace(/<[^>]+>/g, "") })), max);
  }

  if (config.WEB_SEARCH_PROVIDER === "searxng") {
    const url = `${config.WEB_SEARCH_URL.replace(/\/$/, "")}/search?q=${encodeURIComponent(q)}&format=json`;
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: combined });
    if (!res.ok) throw new Error(`SearXNG respondió HTTP ${res.status} (¿está activado el formato json en su settings.yml?)`);
    const body = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
    return clean((body.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })), max);
  }

  return [];
}
