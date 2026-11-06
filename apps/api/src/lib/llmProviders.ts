import { config } from "../config.js";
import { setting } from "./settings.js";

/**
 * Proveedores de LLM. Todos hablan el formato «compatible con OpenAI» (`/chat/completions` con streaming);
 * OpenRouter añade unos parámetros propios. Cada modelo de un plan puede llevar un prefijo de proveedor
 * (`groq:openai/gpt-oss-120b`); sin prefijo se usa LLM_DEFAULT_PROVIDER (OpenRouter por defecto, así que los
 * planes anteriores siguen funcionando igual). Para añadir un proveedor nuevo con ese formato basta una línea aquí.
 */
export type ProviderKind = "openrouter" | "openai";

export interface LlmProvider {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  /** Variable del .env que falta cuando no está configurado (la clave; en el servidor propio, la dirección). */
  keyVar: string;
}

interface ProviderDef {
  id: string;
  label: string;
  kind: ProviderKind;
  keyVar: string;
  baseUrl: () => string;
  apiKey: () => string;
}

// Se leen de `config` en cada llamada (no al cargar el módulo) para poder probarlos cambiando la configuración.
const DEFS: ProviderDef[] = [
  { id: "openrouter", label: "OpenRouter", kind: "openrouter", keyVar: "OPENROUTER_API_KEY", baseUrl: () => config.OPENROUTER_BASE_URL, apiKey: () => setting("OPENROUTER_API_KEY") },
  { id: "groq", label: "Groq", kind: "openai", keyVar: "GROQ_API_KEY", baseUrl: () => "https://api.groq.com/openai/v1", apiKey: () => setting("GROQ_API_KEY") },
  { id: "google", label: "Google (Gemini)", kind: "openai", keyVar: "GOOGLE_API_KEY", baseUrl: () => "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: () => setting("GOOGLE_API_KEY") },
  { id: "openai", label: "OpenAI", kind: "openai", keyVar: "OPENAI_API_KEY", baseUrl: () => "https://api.openai.com/v1", apiKey: () => setting("OPENAI_API_KEY") },
  { id: "deepseek", label: "DeepSeek", kind: "openai", keyVar: "DEEPSEEK_API_KEY", baseUrl: () => "https://api.deepseek.com", apiKey: () => setting("DEEPSEEK_API_KEY") },
  { id: "custom", label: "Servidor propio", kind: "openai", keyVar: "LLM_CUSTOM_BASE_URL", baseUrl: () => setting("LLM_CUSTOM_BASE_URL"), apiKey: () => setting("LLM_CUSTOM_API_KEY") },
];

export const PROVIDER_IDS = DEFS.map((d) => d.id);

export function getProvider(id: string): LlmProvider | undefined {
  const d = DEFS.find((x) => x.id === id);
  return d && { id: d.id, label: d.label, kind: d.kind, baseUrl: d.baseUrl().replace(/\/$/, ""), apiKey: d.apiKey(), keyVar: d.keyVar };
}

/** ¿Se puede usar? Hace falta la clave (en el servidor propio, la dirección; la clave es opcional: Ollama no la pide). */
export function isConfigured(p: LlmProvider): boolean {
  return p.id === "custom" ? p.baseUrl !== "" : p.apiKey !== "";
}

/** Proveedores listos para usar. */
export const configuredProviders = (): LlmProvider[] => PROVIDER_IDS.map((id) => getProvider(id)!).filter(isConfigured);

export interface ModelRef {
  providerId: string;
  /** Nombre del modelo tal como lo entiende ese proveedor. */
  model: string;
}

/**
 * «groq:openai/gpt-oss-120b» → proveedor groq. Sin prefijo, o si lo que va antes de «:» no es un proveedor
 * (p. ej. «google/gemma-4-31b-it:free», cuyos «:free» son parte del nombre en OpenRouter) → proveedor por defecto.
 */
export function parseModelRef(ref: string): ModelRef {
  const i = ref.indexOf(":");
  if (i > 0) {
    const head = ref.slice(0, i);
    if (PROVIDER_IDS.includes(head)) return { providerId: head, model: ref.slice(i + 1) };
  }
  return { providerId: setting("LLM_DEFAULT_PROVIDER"), model: ref };
}

/** ¿El proveedor de este modelo («groq:…», o sin prefijo = el por defecto) existe y tiene clave? */
export function refConfigured(ref: string): boolean {
  const p = getProvider(parseModelRef(ref).providerId);
  return p !== undefined && isConfigured(p);
}

/** Nombre con el que se guarda y se muestra el modelo usado: sin prefijo si es de OpenRouter (como siempre). */
export const modelLabel = (providerId: string, model: string): string => (providerId === "openrouter" ? model : `${providerId}:${model}`);

/**
 * Comprobación mínima de un proveedor, sin gastar cuota: OpenRouter tiene un endpoint que valida la clave
 * (su catálogo es público) y los demás responden a `/models` solo con una clave válida. Devuelve un texto fijo apto para mostrar
 * (nunca el código HTTP ni el texto del servidor).
 */
export async function probeProvider(p: LlmProvider): Promise<{ ok: boolean; message: string }> {
  const url = p.kind === "openrouter" ? `${p.baseUrl}/auth/key` : `${p.baseUrl}/models`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : undefined });
    if (res.ok) return { ok: true, message: `${p.label}: responde correctamente.` };
    console.warn(`[${p.id}] la comprobación recibió HTTP ${res.status}`);
    if (res.status === 401 || res.status === 403) return { ok: false, message: `${p.label}: rechaza la clave.` };
    return { ok: false, message: `${p.label}: error del servidor.` };
  } catch (err) {
    console.warn(`[${p.id}] la comprobación falló:`, err instanceof Error ? err.message : err);
    return { ok: false, message: `${p.label}: no responde.` };
  }
}
