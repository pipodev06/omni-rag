import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import "./env.js";
import { config } from "../src/config.js";
import { configuredProviders, getProvider, isConfigured, modelLabel, parseModelRef } from "../src/lib/llmProviders.js";
import { completeChat, buildRequestBody, streamChat } from "../src/rag/llm.js";

const MSGS = [{ role: "user" as const, content: "hola" }];

describe("modelo con prefijo de proveedor", () => {
  it("el prefijo conocido elige el proveedor", () => {
    expect(parseModelRef("groq:llama-3.3-70b-versatile")).toEqual({ providerId: "groq", model: "llama-3.3-70b-versatile" });
    expect(parseModelRef("google:gemini-2.0-flash")).toEqual({ providerId: "google", model: "gemini-2.0-flash" });
    expect(parseModelRef("custom:mi-modelo:7b")).toEqual({ providerId: "custom", model: "mi-modelo:7b" });
  });
  it("sin prefijo usa el proveedor por defecto (OpenRouter), también con el «:free» del nombre", () => {
    expect(parseModelRef("google/gemma-4-31b-it:free")).toEqual({ providerId: "openrouter", model: "google/gemma-4-31b-it:free" });
    expect(parseModelRef("minimax/minimax-m3.1-flash:free").providerId).toBe("openrouter");
    expect(parseModelRef("gpt-4o-mini").providerId).toBe("openrouter");
  });
  it("se puede forzar OpenRouter con prefijo", () => {
    expect(parseModelRef("openrouter:google/gemma-4-31b-it:free")).toEqual({ providerId: "openrouter", model: "google/gemma-4-31b-it:free" });
  });
  it("un prefijo que no es proveedor (error de escritura) se trata como nombre completo", () => {
    expect(parseModelRef("grok:llama-3")).toEqual({ providerId: "openrouter", model: "grok:llama-3" });
  });
  it("respeta LLM_DEFAULT_PROVIDER", () => {
    const original = config.LLM_DEFAULT_PROVIDER;
    config.LLM_DEFAULT_PROVIDER = "groq";
    try {
      expect(parseModelRef("llama-3.3-70b-versatile")).toEqual({ providerId: "groq", model: "llama-3.3-70b-versatile" });
    } finally {
      config.LLM_DEFAULT_PROVIDER = original;
    }
  });
  it("el nombre guardado lleva prefijo salvo en OpenRouter (como siempre)", () => {
    expect(modelLabel("openrouter", "google/gemma-4-31b-it:free")).toBe("google/gemma-4-31b-it:free");
    expect(modelLabel("groq", "llama-3.3-70b-versatile")).toBe("groq:llama-3.3-70b-versatile");
  });
});

describe("proveedores configurados", () => {
  const keys = ["OPENROUTER_API_KEY", "GROQ_API_KEY", "GOOGLE_API_KEY", "LLM_CUSTOM_BASE_URL"] as const;
  const original = Object.fromEntries(keys.map((k) => [k, config[k]]));
  afterEach(() => Object.assign(config, original));

  it("solo cuentan los que tienen clave; el servidor propio, los que tienen dirección", () => {
    Object.assign(config, { OPENROUTER_API_KEY: "", GROQ_API_KEY: "g", GOOGLE_API_KEY: "", LLM_CUSTOM_BASE_URL: "http://ollama:11434/v1" });
    expect(configuredProviders().map((p) => p.id)).toEqual(["groq", "custom"]);
    expect(isConfigured(getProvider("openrouter")!)).toBe(false);
  });
  it("las direcciones de cada proveedor", () => {
    expect(getProvider("groq")!.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(getProvider("google")!.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(getProvider("custom")!.baseUrl).toBe(config.LLM_CUSTOM_BASE_URL.replace(/\/$/, ""));
  });
});

describe("cuerpo de la petición según el proveedor", () => {
  it("OpenRouter: pide ocultar el razonamiento y no usa stream_options", () => {
    const b = buildRequestBody("openrouter", "openrouter", "m", MSGS);
    expect(b.reasoning).toEqual({ exclude: true });
    expect(b.stream_options).toBeUndefined();
    expect(b.max_tokens).toBe(config.LLM_MAX_TOKENS);
  });
  it("compatibles con OpenAI: piden los tokens con stream_options y no envían «reasoning»", () => {
    const b = buildRequestBody("openai", "groq", "llama", MSGS);
    expect(b.stream_options).toEqual({ include_usage: true });
    expect(b.reasoning).toBeUndefined();
    expect(b.max_tokens).toBe(config.LLM_MAX_TOKENS);
    expect(b.temperature).toBe(config.LLM_TEMPERATURE);
  });
  it("sin stream_options (reintento)", () => {
    expect(buildRequestBody("openai", "groq", "llama", MSGS, false).stream_options).toBeUndefined();
  });
  it("OpenAI usa max_completion_tokens, y los modelos de razonamiento no llevan temperature", () => {
    const mini = buildRequestBody("openai", "openai", "gpt-4o-mini", MSGS);
    expect(mini.max_completion_tokens).toBe(config.LLM_MAX_TOKENS);
    expect(mini.max_tokens).toBeUndefined();
    expect(mini.temperature).toBe(config.LLM_TEMPERATURE);
    for (const m of ["o3-mini", "gpt-5"]) expect(buildRequestBody("openai", "openai", m, MSGS).temperature).toBeUndefined();
  });
});

// --- Proveedores de mentira (servidores HTTP locales) --------------------------------------------------
interface Seen {
  auth: string | undefined;
  body: Record<string, unknown>;
}

type Reply = (seen: Seen, res: http.ServerResponse) => void;

function fakeProvider(reply: Reply) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const entry = { auth: req.headers.authorization, body: JSON.parse(raw || "{}") as Record<string, unknown> };
      seen.push(entry);
      reply(entry, res);
    });
  });
  return { server, seen, url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

const sse = (res: http.ServerResponse, chunks: unknown[]) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end("data: [DONE]\n\n");
};
const answer = (text: string, usage?: unknown) => [
  { model: "real-model", choices: [{ delta: { content: text } }] },
  ...(usage ? [usage] : []),
];
const fail = (status: number, message: string): Reply => (_s, res) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message } }));
};

describe("respaldo entre proveedores (servidores de prueba)", () => {
  const limited = fakeProvider(fail(429, "rate limit"));
  const good = fakeProvider((_s, res) => sse(res, answer("Hola desde otro proveedor", { choices: [], usage: { prompt_tokens: 11, completion_tokens: 5 } })));
  const rejectsUsage = fakeProvider((seen, res) => {
    if (seen.body.stream_options) return fail(400, "Unrecognized request argument supplied: stream_options")(seen, res);
    sse(res, answer("Sin tokens informados"));
  });
  const groqStyle = fakeProvider((_s, res) => sse(res, [...answer("Respuesta estilo Groq"), { choices: [], x_groq: { usage: { prompt_tokens: 7, completion_tokens: 3 } } }]));
  const badKey = fakeProvider(fail(401, "invalid api key"));

  const keys = ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "LLM_CUSTOM_BASE_URL", "LLM_CUSTOM_API_KEY"] as const;
  const original = Object.fromEntries(keys.map((k) => [k, config[k]]));

  beforeAll(async () => {
    for (const p of [limited, good, rejectsUsage, groqStyle, badKey]) await new Promise<void>((r) => p.server.listen(0, "127.0.0.1", r));
  });
  afterAll(() => {
    for (const p of [limited, good, rejectsUsage, groqStyle, badKey]) p.server.close();
  });
  afterEach(() => Object.assign(config, original));

  const use = (openrouter: string, custom: string, customKey = "ck") =>
    Object.assign(config, { OPENROUTER_API_KEY: "ok", OPENROUTER_BASE_URL: openrouter, LLM_CUSTOM_BASE_URL: custom, LLM_CUSTOM_API_KEY: customKey });

  it("si el primer proveedor está saturado, responde el segundo (otro proveedor) y lo indica en el modelo", async () => {
    use(limited.url(), good.url());
    const r = await completeChat(MSGS, ["some/model:free", "custom:mi-modelo"]);
    expect(r.text).toBe("Hola desde otro proveedor");
    expect(r.model).toBe("custom:real-model");
    expect([r.promptTokens, r.completionTokens]).toEqual([11, 5]);
    // Cada proveedor recibió su propia clave y el nombre de modelo sin prefijo.
    expect(limited.seen.at(-1)!.auth).toBe("Bearer ok");
    expect(good.seen.at(-1)!.auth).toBe("Bearer ck");
    expect(good.seen.at(-1)!.body.model).toBe("mi-modelo");
  });

  it("con el primero funcionando no toca al segundo, y un modelo de OpenRouter se guarda sin prefijo", async () => {
    use(good.url(), limited.url());
    const before = limited.seen.length;
    const r = await completeChat(MSGS, ["some/model:free", "custom:otro"]);
    expect(r.model).toBe("real-model");
    expect(limited.seen.length).toBe(before);
  });

  it("si el servidor no conoce stream_options, reintenta sin él (los tokens quedan sin informar)", async () => {
    use(limited.url(), rejectsUsage.url());
    const r = await completeChat(MSGS, ["custom:m"]);
    expect(r.text).toBe("Sin tokens informados");
    expect(r.promptTokens).toBeNull();
    expect(rejectsUsage.seen).toHaveLength(2);
    expect(rejectsUsage.seen[0]!.body.stream_options).toBeDefined();
    expect(rejectsUsage.seen[1]!.body.stream_options).toBeUndefined();
  });

  it("lee los tokens de x_groq.usage", async () => {
    use(limited.url(), groqStyle.url());
    const r = await completeChat(MSGS, ["custom:m"]);
    expect([r.promptTokens, r.completionTokens]).toEqual([7, 3]);
  });

  it("una clave rechazada en un proveedor pasa al siguiente", async () => {
    use(badKey.url(), good.url());
    const r = await completeChat(MSGS, ["some/model:free", "custom:m"]);
    expect(r.text).toBe("Hola desde otro proveedor");
  });

  it("si la única clave es inválida, lo dice (no «saturado»)", async () => {
    use(badKey.url(), "");
    await expect(completeChat(MSGS, ["some/model:free"])).rejects.toMatchObject({ status: 503, message: expect.stringContaining("no es válida") });
  });

  it("todos saturados: 429 con mensaje de saturación", async () => {
    use(limited.url(), limited.url());
    await expect(completeChat(MSGS, ["some/model:free", "custom:m"])).rejects.toMatchObject({ status: 429 });
  });

  it("sin ningún proveedor configurado para los modelos del plan: 503 que nombra la variable", async () => {
    Object.assign(config, { OPENROUTER_API_KEY: "", LLM_CUSTOM_BASE_URL: "" });
    await expect(completeChat(MSGS, ["some/model:free"])).rejects.toMatchObject({ status: 503, message: expect.stringContaining("OPENROUTER_API_KEY") });
  });

  it("un modelo cuyo proveedor no está configurado se salta y responde el siguiente", async () => {
    use(good.url(), "");
    const r = await completeChat(MSGS, ["groq:llama", "some/model:free"]);
    expect(r.text).toBe("Hola desde otro proveedor");
  });

  it("streamChat entrega los trozos de texto antes del final", async () => {
    use(good.url(), "");
    const parts: string[] = [];
    for await (const ev of streamChat(MSGS, ["some/model:free"])) if (ev.type === "token") parts.push(ev.text);
    expect(parts.join("")).toBe("Hola desde otro proveedor");
  });
});
