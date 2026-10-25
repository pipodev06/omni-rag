import { Hono } from "hono";
import { config } from "../config.js";
import { webSearchEnabled } from "../lib/webSearch.js";
import { sqlOwner } from "../db/client.js";
import { antivirusEnabled, pingAntivirus } from "../lib/antivirus.js";
import { configuredProviders } from "../lib/llmProviders.js";

/** Estado de los servicios de los que depende el RAG. */
export const healthRoutes = new Hono();

async function check(fn: () => Promise<unknown>): Promise<"ok" | string> {
  try {
    await fn();
    return "ok";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const ping = async (url: string) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
};

healthRoutes.get("/", async (c) => {
  const [database, embeddings, reranker] = await Promise.all([
    check(() => sqlOwner`SELECT 1`),
    check(() => ping(`${config.EMBEDDINGS_URL.replace(/\/$/, "")}/health`)),
    config.RERANKER_URL ? check(() => ping(`${config.RERANKER_URL.replace(/\/$/, "")}/health`)) : Promise.resolve("desactivado"),
  ]);
  const services = {
    database,
    embeddings,
    // Docling vive en una red interna que solo alcanza el worker: la API no puede comprobarlo.
    // Su estado se ve con `docker compose ps` (tiene su propio healthcheck).
    docling: "aislado (ver docker compose ps)",
    reranker,
    antivirus: antivirusEnabled() ? await pingAntivirus() : "desactivado",
    // Proveedores de LLM con clave (o dirección) configurada. Vacío = el chat no puede responder.
    llm: configuredProviders().map((p) => p.id),
    // Buscador para el modo híbrido: el nombre del proveedor, o «desactivado».
    webSearch: webSearchEnabled() ? config.WEB_SEARCH_PROVIDER : "desactivado",
  };
  const ok = database === "ok";
  return c.json({ ok, services }, ok ? 200 : 503);
});
