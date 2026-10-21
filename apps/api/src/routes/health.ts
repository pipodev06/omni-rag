import { Hono } from "hono";
import { config } from "../config.js";
import { sqlOwner } from "../db/client.js";

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
  const [database, embeddings, docling, reranker] = await Promise.all([
    check(() => sqlOwner`SELECT 1`),
    check(() => ping(`${config.EMBEDDINGS_URL.replace(/\/$/, "")}/health`)),
    check(() => ping(`${config.DOCLING_URL.replace(/\/$/, "")}/health`)),
    config.RERANKER_URL ? check(() => ping(`${config.RERANKER_URL.replace(/\/$/, "")}/health`)) : Promise.resolve("desactivado"),
  ]);
  const services = {
    database,
    embeddings,
    docling,
    reranker,
    openrouter: config.OPENROUTER_API_KEY ? "configurado" : "falta OPENROUTER_API_KEY",
  };
  const ok = database === "ok";
  return c.json({ ok, services }, ok ? 200 : 503);
});
