import { config } from "../config.js";

/**
 * Proveedores de LLM. Todos hablan el formato «compatible con OpenAI» (`/chat/completions` con streaming);
 * OpenRouter añade unos parámetros propios. Cada modelo de un plan puede llevar un prefijo de proveedor
 * (`groq:llama-3.3-70b-versatile`); sin prefijo se usa LLM_DEFAULT_PROVIDER (OpenRouter por defecto, así que los
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
  { id: "openrouter", label: "OpenRouter", kind: "openrouter", keyVar: "OPENROUTER_API_KEY", baseUrl: () => config.OPENROUTER_BASE_URL, apiKey: () => config.OPENROUTER_API_KEY },
  { id: "groq", label: "Groq", kind: "openai", keyVar: "GROQ_API_KEY", baseUrl: () => "https://api.groq.com/openai/v1", apiKey: () => config.GROQ_API_KEY },
  { id: "google", label: "Google (Gemini)", kind: "openai", keyVar: "GOOGLE_API_KEY", baseUrl: () => "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: () => config.GOOGLE_API_KEY },
  { id: "openai", label: "OpenAI", kind: "openai", keyVar: "OPENAI_API_KEY", baseUrl: () => "https://api.openai.com/v1", apiKey: () => config.OPENAI_API_KEY },
  { id: "deepseek", label: "DeepSeek", kind: "openai", keyVar: "DEEPSEEK_API_KEY", baseUrl: () => "https://api.deepseek.com", apiKey: () => config.DEEPSEEK_API_KEY },
  { id: "custom", label: "Servidor propio", kind: "openai", keyVar: "LLM_CUSTOM_BASE_URL", baseUrl: () => config.LLM_CUSTOM_BASE_URL, apiKey: () => config.LLM_CUSTOM_API_KEY },
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
 * «groq:llama-3.3-70b-versatile» → proveedor groq. Sin prefijo, o si lo que va antes de «:» no es un proveedor
 * (p. ej. «google/gemma-4-31b-it:free», cuyos «:free» son parte del nombre en OpenRouter) → proveedor por defecto.
 */
export function parseModelRef(ref: string): ModelRef {
  const i = ref.indexOf(":");
  if (i > 0) {
    const head = ref.slice(0, i);
    if (PROVIDER_IDS.includes(head)) return { providerId: head, model: ref.slice(i + 1) };
  }
  return { providerId: config.LLM_DEFAULT_PROVIDER, model: ref };
}

/** Nombre con el que se guarda y se muestra el modelo usado: sin prefijo si es de OpenRouter (como siempre). */
export const modelLabel = (providerId: string, model: string): string => (providerId === "openrouter" ? model : `${providerId}:${model}`);
