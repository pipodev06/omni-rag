import { config } from "../config.js";
import { configuredProviders, modelLabel, type LlmProvider } from "../lib/llmProviders.js";
import { completeChat } from "../rag/llm.js";

/**
 * Lista los modelos que ofrece cada proveedor configurado (con las claves del .env) y, con --probar, comprueba
 * con un mensaje mínimo cuáles responden de verdad: aparecer en el catálogo no garantiza que el modelo sirva
 * (p. ej. Google lista modelos que devuelven 404, y los planes gratuitos tienen topes de tokens por minuto).
 *
 *   docker compose exec api node dist/scripts/models.js [proveedor…] [opciones]
 *
 * Opciones:
 *   --probar        envía un mensaje a cada modelo y muestra si responde y en cuánto tiempo
 *   --ok            (implica --probar) muestra solo los que responden, del más rápido al más lento
 *   --max-ms=1000   (implica --ok) solo los que responden en menos de ese tiempo
 *   --filtro=texto  solo los modelos cuyo nombre contiene ese texto (se aplica antes de probar: ahorra tiempo y cuota)
 *   --gratis        en OpenRouter, solo los gratuitos
 *   --todos         incluye también los que no son de chat (voz, imágenes, embeddings…)
 *   --forzar        permite probar más de 60 modelos de una vez
 *
 * Sin proveedores indicados usa todos los configurados salvo OpenRouter (su catálogo tiene cientos de modelos:
 * pásalo explícitamente, mejor con --gratis o --filtro).
 */
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--") && !a.includes("=")));
const options = new Map(args.filter((a) => a.startsWith("--") && a.includes("=")).map((a) => [a.slice(2, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] as const));
const wanted = args.filter((a) => !a.startsWith("--"));

const maxMs = options.has("max-ms") ? Number(options.get("max-ms")) : null;
if (maxMs !== null && !(maxMs > 0)) {
  console.log("--max-ms debe ser un número de milisegundos, por ejemplo --max-ms=1000");
  process.exit(1);
}
const onlyOk = flags.has("--ok") || maxMs !== null;
const probing = flags.has("--probar") || onlyOk;
const needle = options.get("filtro")?.toLowerCase() ?? "";
const MAX_PROBES = 60;

// Nombres que indican modelos que no sirven para responder preguntas (voz, imagen, vídeo, embeddings, moderación…).
const NOT_CHAT = /whisper|orpheus|tts|transcribe|live|audio|embed|imagen|image|veo|lyria|guard|safeguard|moderation|aqa|robotics|computer-use|deep-research|antigravity|nano-banana|omni|translate/i;

interface CatalogModel {
  id: string;
  free: boolean;
}

async function catalog(p: LlmProvider): Promise<CatalogModel[]> {
  const res = await fetch(`${p.baseUrl}/models`, {
    headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { id?: string; pricing?: { prompt?: string; completion?: string } }[] };
  return (body.data ?? [])
    .flatMap((m) => {
      const id = m.id?.replace(/^models\//, "");
      if (!id) return [];
      const free = id.endsWith(":free") || (m.pricing?.prompt !== undefined && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion ?? 0) === 0);
      return [{ id, free }];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

// El cliente de LLM deja el motivo exacto del fallo en el log («HTTP 404», «402 Insufficient Balance»…): aquí se recoge.
let lastLog = "";
const quiet = () => {
  console.warn = () => {};
  console.error = (...a: unknown[]) => void (lastLog = a.join(" "));
};

interface Probe {
  ref: string;
  ok: boolean;
  ms: number;
  why: string;
}

async function probe(ref: string, modelId: string, providerId: string): Promise<Probe> {
  const t0 = Date.now();
  lastLog = "";
  try {
    await completeChat([{ role: "user", content: "Responde solo con la palabra: listo" }], [providerId === "openrouter" ? modelId : `${providerId}:${modelId}`]);
    return { ref, ok: true, ms: Date.now() - t0, why: "" };
  } catch (err) {
    const why = /HTTP \d{3}.*/.exec(lastLog)?.[0] ?? (err instanceof Error ? err.message : String(err));
    return { ref, ok: false, ms: Date.now() - t0, why: why.replace(/\s+/g, " ").replace(/org_\w+/g, "org_…").slice(0, 95) };
  }
}

const show = (r: Probe) => `${r.ref.padEnd(40)} ${r.ok ? `OK     ${String(r.ms).padStart(6)} ms` : `FALLA  ${r.why}`}`;

const providers = configuredProviders().filter((p) => (wanted.length ? wanted.includes(p.id) : p.id !== "openrouter"));
if (providers.length === 0) {
  console.log(wanted.length ? `Ninguno de estos proveedores está configurado: ${wanted.join(", ")}` : "No hay proveedores configurados aparte de OpenRouter. Indica uno: … models.js openrouter");
  process.exit(1);
}
// Al probar, los mensajes de «[llm] … falló» del cliente sobran: aquí se muestra el resultado de cada modelo.
if (probing) quiet();

for (const p of providers) {
  let all: CatalogModel[];
  try {
    all = await catalog(p);
  } catch (err) {
    console.log(`\n## ${p.label}: no se pudo leer el catálogo (${err instanceof Error ? err.message : err})`);
    continue;
  }
  const models = all
    .filter((m) => flags.has("--todos") || !NOT_CHAT.test(m.id))
    .filter((m) => p.id !== "openrouter" || !flags.has("--gratis") || m.free)
    .filter((m) => !needle || m.id.toLowerCase().includes(needle));
  const refOf = (id: string) => (p.id === config.LLM_DEFAULT_PROVIDER ? id : modelLabel(p.id, id));

  const notes = [flags.has("--gratis") && p.id === "openrouter" && "solo gratuitos", needle && `que contienen «${needle}»`].filter(Boolean).join(", ");
  console.log(`\n## ${p.label}: ${models.length} modelos de chat${notes ? ` (${notes})` : ""} de ${all.length} en el catálogo`);

  if (!probing) {
    for (const m of models) console.log(refOf(m.id));
    continue;
  }
  if (models.length > MAX_PROBES && !flags.has("--forzar")) {
    console.log(`Son demasiados para probarlos todos (${models.length}): es lento y gasta cuota. Acota con --filtro=texto${p.id === "openrouter" ? " o --gratis" : ""}, o añade --forzar.`);
    continue;
  }

  const results: Probe[] = [];
  for (const [i, m] of models.entries()) {
    const r = await probe(refOf(m.id), m.id, p.id);
    results.push(r);
    // Sin filtros se muestra cada resultado a medida que llega; con filtros se ordena al final.
    if (!onlyOk) console.log(show(r));
    else if (process.stderr.isTTY) process.stderr.write(`\r  probando ${i + 1}/${models.length}…`);
  }
  if (onlyOk) {
    if (process.stderr.isTTY) process.stderr.write("\r".padEnd(40) + "\r");
    const good = results.filter((r) => r.ok && (maxMs === null || r.ms < maxMs)).sort((a, b) => a.ms - b.ms);
    for (const r of good) console.log(show(r));
    const limit = maxMs === null ? "" : ` en menos de ${maxMs} ms`;
    console.log(`→ ${good.length} de ${results.length} responden${limit}`);
  }
}
process.exit(0);
