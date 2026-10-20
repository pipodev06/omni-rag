import { config, llmModels } from "../config.js";
import { HttpError } from "../lib/errors.js";
import type { ChatMessage } from "./prompt.js";

/**
 * Cliente mínimo de OpenRouter (API compatible con OpenAI) con streaming.
 *
 * Respaldo entre modelos: se prueba cada modelo de LLM_MODELS en orden. Si uno
 * falla ANTES de emitir texto (límite de uso, modelo caído, retirado…), se pasa
 * al siguiente. Los modelos gratuitos se saturan a menudo, así que esto es clave.
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

export async function* streamChat(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<LlmEvent> {
  if (!config.OPENROUTER_API_KEY) {
    throw new HttpError(503, "Falta OPENROUTER_API_KEY en la configuración del servidor");
  }
  const models = llmModels();
  const failures: string[] = [];

  for (const model of models) {
    let emitted = false;
    try {
      for await (const ev of streamOne(model, messages, signal)) {
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
        console.error(`[llm] OpenRouter rechazó la clave: ${err instanceof Error ? err.message : err}`);
        throw new HttpError(503, "La clave de OpenRouter (OPENROUTER_API_KEY) no es válida. Avisa al administrador.");
      }
      failures.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
      console.warn(`[llm] ${model} falló (${status}), probando el siguiente modelo`);
      if (err instanceof ModelError && !RETRYABLE.has(err.status)) break;
    }
  }

  console.error("[llm] todos los modelos fallaron:\n  " + failures.join("\n  "));
  const allRateLimited = failures.length > 0 && failures.every((f) => f.includes("429"));
  throw new HttpError(
    allRateLimited ? 429 : 502,
    allRateLimited
      ? "Los modelos gratuitos están saturados o se alcanzó el límite diario de OpenRouter. Intenta de nuevo en unos minutos."
      : "No se pudo obtener respuesta de ningún modelo de lenguaje. Intenta de nuevo más tarde.",
  );
}

interface StreamChunk {
  model?: string;
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { code?: number; message?: string };
}

async function* streamOne(model: string, messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<LlmEvent> {
  const res = await fetch(`${config.OPENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
      // Identificación opcional de la app en OpenRouter.
      "http-referer": config.APP_PUBLIC_URL,
      "x-title": config.APP_NAME,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: config.LLM_TEMPERATURE,
      max_tokens: config.LLM_MAX_TOKENS,
      // Si el modelo "razona", no enviar el razonamiento: solo la respuesta final.
      reasoning: { exclude: true },
    }),
  });

  if (!res.ok || !res.body) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) detail += ` ${body.error.message}`;
    } catch {
      /* respuesta sin JSON */
    }
    throw new ModelError(res.status, detail);
  }

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
    if (chunk.usage) {
      promptTokens = chunk.usage.prompt_tokens ?? null;
      completionTokens = chunk.usage.completion_tokens ?? null;
    }
  }
  if (text === 0) throw new ModelError(502, "el modelo devolvió una respuesta vacía");
  yield { type: "done", model: usedModel, promptTokens, completionTokens };
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
