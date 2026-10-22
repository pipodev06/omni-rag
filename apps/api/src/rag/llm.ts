import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";
import { configuredProviders, getProvider, isConfigured, modelLabel, parseModelRef, type LlmProvider, type ProviderKind } from "../lib/llmProviders.js";
import type { ChatMessage } from "./prompt.js";

/**
 * Cliente de LLM con streaming para cualquier proveedor «compatible con OpenAI» (OpenRouter, Groq, Google, OpenAI,
 * DeepSeek o un servidor propio). Ver lib/llmProviders.ts.
 *
 * Respaldo entre modelos: se prueba cada modelo del plan de la organización en orden, y pueden ser de proveedores
 * distintos. Si uno falla ANTES de emitir texto (límite de uso, modelo caído, retirado, clave inválida…), se pasa al
 * siguiente. Los modelos gratuitos se saturan a menudo, así que esto es clave: si un proveedor se cae, responde otro.
 */

export type LlmEvent =
  | { type: "token"; text: string }
  | { type: "done"; model: string; promptTokens: number | null; completionTokens: number | null };

/** Errores en los que vale la pena probar con otro modelo. */
const RETRYABLE = new Set([402, 404, 408, 429, 500, 502, 503, 504]);

class ModelError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function* streamChat(messages: ChatMessage[], models: string[], signal?: AbortSignal): AsyncGenerator<LlmEvent> {
  if (models.length === 0) throw new HttpError(503, "El plan de la organización no tiene modelos configurados");
  const refs = models.map(parseModelRef);
  if (!refs.some((r) => { const p = getProvider(r.providerId); return p && isConfigured(p); })) {
    const needed = [...new Set(refs.map((r) => getProvider(r.providerId)?.keyVar ?? r.providerId))].join(" o ");
    throw new HttpError(503, `Falta la clave del proveedor de LLM en la configuración del servidor (${needed})`);
  }

  const failures: string[] = [];
  const badKeys = new Set<string>(); // proveedores cuya clave fue rechazada en esta petición
  let attempted = 0;

  for (const ref of refs) {
    const provider = getProvider(ref.providerId);
    const name = modelLabel(ref.providerId, ref.model);
    if (!provider || !isConfigured(provider)) {
      failures.push(`${name}: proveedor sin configurar`);
      continue;
    }
    if (badKeys.has(provider.id)) continue;
    attempted++;
    let emitted = false;
    try {
      for await (const ev of streamOne(provider, ref.model, messages, signal)) {
        emitted = true;
        yield ev;
      }
      return;
    } catch (err) {
      if (signal?.aborted) throw err;
      // Si ya se envió parte de la respuesta, no se puede cambiar de modelo.
      if (emitted) throw err;
      const status = err instanceof ModelError ? err.status : 502;
      if (status === 401 || status === 403) {
        badKeys.add(provider.id);
        console.error(`[llm] ${provider.label} rechazó la clave (${provider.keyVar}): ${err instanceof Error ? err.message : err}`);
      } else {
        console.warn(`[llm] ${name} falló (${status}), probando el siguiente modelo`);
      }
      failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.error("[llm] todos los modelos fallaron:\n  " + failures.join("\n  "));
  if (attempted > 0 && badKeys.size > 0 && failures.filter((f) => !f.includes("sin configurar")).length === badKeys.size) {
    const labels = [...badKeys].map((id) => getProvider(id)?.label ?? id).join(", ");
    throw new HttpError(503, `La clave de ${labels} no es válida. Avisa al administrador.`);
  }
  const allRateLimited = failures.length > 0 && failures.every((f) => f.includes("429"));
  throw new HttpError(
    allRateLimited ? 429 : 502,
    allRateLimited
      ? "Los modelos están saturados o se alcanzó el límite diario del proveedor. Intenta de nuevo en unos minutos."
      : "No se pudo obtener respuesta de ningún modelo de lenguaje. Intenta de nuevo más tarde.",
  );
}

interface StreamChunk {
  model?: string;
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  /** Groq entrega los tokens aquí. */
  x_groq?: { usage?: { prompt_tokens?: number; completion_tokens?: number } };
  error?: { code?: number; message?: string };
}

// Los modelos de razonamiento de OpenAI (o1, o3, gpt-5…) no admiten `temperature`.
const noTemperature = (providerId: string, model: string) => providerId === "openai" && /^(o\d|gpt-5)/.test(model);

/**
 * Cuerpo de la petición. OpenRouter acepta `reasoning` (para no recibir el razonamiento); el resto de proveedores
 * piden los tokens con `stream_options` y OpenAI usa `max_completion_tokens`. Pura, para poder probarla.
 */
export function buildRequestBody(kind: ProviderKind, providerId: string, model: string, messages: ChatMessage[], withUsageOption = true): Record<string, unknown> {
  const base = { model, messages, stream: true };
  if (kind === "openrouter") {
    // Si el modelo «razona», no enviar el razonamiento: solo la respuesta final.
    return { ...base, temperature: config.LLM_TEMPERATURE, max_tokens: config.LLM_MAX_TOKENS, reasoning: { exclude: true } };
  }
  return {
    ...base,
    ...(withUsageOption && { stream_options: { include_usage: true } }),
    ...(providerId === "openai" ? { max_completion_tokens: config.LLM_MAX_TOKENS } : { max_tokens: config.LLM_MAX_TOKENS }),
    ...(noTemperature(providerId, model) ? {} : { temperature: config.LLM_TEMPERATURE }),
  };
}

async function post(provider: LlmProvider, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  return fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(provider.apiKey && { authorization: `Bearer ${provider.apiKey}` }),
      // Identificación opcional de la app en OpenRouter.
      ...(provider.kind === "openrouter" && { "http-referer": config.APP_PUBLIC_URL, "x-title": config.APP_NAME }),
    },
    body: JSON.stringify(body),
  });
}

async function errorDetail(res: Response): Promise<string> {
  let detail = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { message?: string } | string };
    const msg = typeof body.error === "string" ? body.error : body.error?.message;
    if (msg) detail += ` ${msg}`;
  } catch {
    /* respuesta sin JSON */
  }
  return detail;
}

async function* streamOne(provider: LlmProvider, model: string, messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<LlmEvent> {
  let res = await post(provider, buildRequestBody(provider.kind, provider.id, model, messages), signal);
  if (!res.ok && res.status === 400 && provider.kind === "openai") {
    // Algunos servidores no conocen `stream_options`: se reintenta una vez sin él (y los tokens quedan sin informar).
    const detail = await errorDetail(res);
    if (!/stream_options|include_usage|unrecognized|unknown|unsupported/i.test(detail)) throw new ModelError(400, detail);
    res = await post(provider, buildRequestBody(provider.kind, provider.id, model, messages, false), signal);
    if (!res.ok) throw new ModelError(res.status, await errorDetail(res));
  } else if (!res.ok || !res.body) {
    throw new ModelError(res.status, await errorDetail(res));
  }
  if (!res.body) throw new ModelError(502, "respuesta sin contenido");

  let usedModel = model;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let text = 0;

  for await (const data of sseData(res.body)) {
    if (data === "[DONE]") break;
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(data) as StreamChunk;
    } catch {
      continue;
    }
    if (chunk.error) throw new ModelError(chunk.error.code ?? 502, chunk.error.message ?? "error del proveedor");
    if (chunk.model) usedModel = chunk.model;
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      text += delta.length;
      yield { type: "token", text: delta };
    }
    const usage = chunk.usage ?? chunk.x_groq?.usage;
    if (usage) {
      promptTokens = usage.prompt_tokens ?? null;
      completionTokens = usage.completion_tokens ?? null;
    }
  }
  if (text === 0) throw new ModelError(502, "el modelo devolvió una respuesta vacía");
  yield { type: "done", model: modelLabel(provider.id, usedModel), promptTokens, completionTokens };
}

/** Lee un flujo Server-Sent Events y devuelve el contenido de cada línea `data:`. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      // Las líneas que empiezan con ":" son comentarios (p. ej. ": OPENROUTER PROCESSING").
      if (line.startsWith("data:")) yield line.slice(5).trimStart();
    }
  }
  const last = buffer.trim();
  if (last.startsWith("data:")) yield last.slice(5).trimStart();
}

/** Llamada sin streaming: devuelve el texto completo, el modelo y los tokens. */
export async function completeChat(messages: ChatMessage[], models: string[], signal?: AbortSignal) {
  let text = "";
  for await (const ev of streamChat(messages, models, signal)) {
    if (ev.type === "token") text += ev.text;
    else return { text, model: ev.model, promptTokens: ev.promptTokens, completionTokens: ev.completionTokens };
  }
  return { text, model: null, promptTokens: null, completionTokens: null };
}

/** ¿Hay algún proveedor de LLM configurado? (para /api/health y los avisos). */
export const hasLlmProvider = (): boolean => configuredProviders().length > 0;
