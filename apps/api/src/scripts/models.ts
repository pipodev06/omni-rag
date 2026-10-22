import { config } from "../config.js";
import { configuredProviders, modelLabel, type LlmProvider } from "../lib/llmProviders.js";
import { completeChat } from "../rag/llm.js";

/**
 * Lista los modelos que ofrece cada proveedor configurado (con las claves del .env) y, con --probar, comprueba
 * con un mensaje mínimo cuáles responden de verdad: aparecer en el catálogo no garantiza que el modelo sirva
 * (p. ej. Google lista modelos que devuelven 404, y los planes gratuitos tienen topes de tokens por minuto).
 *
 *   docker compose exec api node dist/scripts/models.js [proveedor…] [--probar] [--todos]
 *
 * Sin proveedores indicados usa todos los configurados salvo OpenRouter (su catálogo tiene cientos de modelos:
 * pásalo explícitamente). Por defecto oculta los que no son de chat (voz, imágenes, embeddings, moderación…).
 */
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const wanted = args.filter((a) => !a.startsWith("--"));

// Nombres que indican modelos que no sirven para responder preguntas (voz, imagen, vídeo, embeddings, moderación…).
const NOT_CHAT = /whisper|orpheus|tts|transcribe|live|audio|embed|imagen|image|veo|lyria|guard|safeguard|moderation|aqa|robotics|computer-use|deep-research|antigravity|nano-banana|omni|translate/i;

async function catalog(p: LlmProvider): Promise<string[]> {
  const res = await fetch(`${p.baseUrl}/models`, {
    headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { id?: string }[] };
  return (body.data ?? []).map((m) => m.id?.replace(/^models\//, "")).filter((id): id is string => !!id).sort();
}

// El cliente de LLM deja el motivo exacto del fallo en el log («HTTP 404», «402 Insufficient Balance»…): aquí se recoge.
let lastLog = "";
const quiet = () => {
  console.warn = () => {};
  console.error = (...a: unknown[]) => void (lastLog = a.join(" "));
};

async function probe(ref: string): Promise<string> {
  const t0 = Date.now();
  lastLog = "";
  try {
    await completeChat([{ role: "user", content: "Responde solo con la palabra: listo" }], [ref]);
    return `OK     ${String(Date.now() - t0).padStart(6)} ms`;
  } catch (err) {
    const why = /HTTP \d{3}.*/.exec(lastLog)?.[0] ?? (err instanceof Error ? err.message : String(err));
    return `FALLA  ${why.replace(/\s+/g, " ").replace(/org_\w+/g, "org_…").slice(0, 95)}`;
  }
}

const providers = configuredProviders().filter((p) => (wanted.length ? wanted.includes(p.id) : p.id !== "openrouter"));
if (providers.length === 0) {
  console.log(wanted.length ? `Ninguno de estos proveedores está configurado: ${wanted.join(", ")}` : "No hay proveedores configurados aparte de OpenRouter. Indica uno: … models.js openrouter");
  process.exit(1);
}
// Con --probar los mensajes de «[llm] … falló» del cliente sobran: aquí se muestra el resultado de cada modelo.
if (flags.has("--probar")) quiet();

for (const p of providers) {
  let ids: string[];
  try {
    ids = await catalog(p);
  } catch (err) {
    console.log(`\n## ${p.label}: no se pudo leer el catálogo (${err instanceof Error ? err.message : err})`);
    continue;
  }
  const chat = flags.has("--todos") ? ids : ids.filter((m) => !NOT_CHAT.test(m));
  console.log(`\n## ${p.label}: ${chat.length} modelos de chat (${ids.length} en el catálogo${flags.has("--todos") ? "" : "; usa --todos para verlos todos"})`);
  for (const m of chat) {
    const ref = p.id === config.LLM_DEFAULT_PROVIDER ? m : modelLabel(p.id, m);
    console.log(flags.has("--probar") ? `${ref.padEnd(40)} ${await probe(p.id === "openrouter" ? m : `${p.id}:${m}`)}` : ref);
  }
}
process.exit(0);
