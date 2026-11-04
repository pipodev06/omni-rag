import { afterEach, describe, expect, it, vi } from "vitest";
import "./env.js";
import { probeProvider, type LlmProvider } from "../src/lib/llmProviders.js";

/** Comprobación de un proveedor desde Sistema: textos fijos, sin el código HTTP ni el texto del servidor. */
const provider = { id: "groq", label: "Groq", kind: "openai", baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk_secreta" } as unknown as LlmProvider;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const answer = (status: number, body = "") => vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));

describe("probeProvider", () => {
  it("200: responde correctamente", async () => {
    answer(200);
    expect(await probeProvider(provider)).toEqual({ ok: true, message: "Groq: responde correctamente." });
  });

  it.each([401, 403])("%i: rechaza la clave", async (status) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    answer(status, "invalid api key gsk_secreta");
    expect(await probeProvider(provider)).toEqual({ ok: false, message: "Groq: rechaza la clave." });
  });

  it.each([400, 404, 429, 500, 502, 503])("%i: error del servidor, sin el código", async (status) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    answer(status, "detalle interno");
    const r = await probeProvider(provider);
    expect(r).toEqual({ ok: false, message: "Groq: error del servidor." });
    expect(r.message).not.toContain(String(status));
  });

  it("sin conexión o tiempo agotado: no responde, sin el texto del error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.groq.com");
    }));
    expect(await probeProvider(provider)).toEqual({ ok: false, message: "Groq: no responde." });
  });
});
