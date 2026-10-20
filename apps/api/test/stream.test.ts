import { describe, expect, it } from "vitest";
import "./env.js";
import { sseData } from "../src/rag/llm.js";
import { splitPages, PAGE_BREAK } from "../src/ingest/extract.js";
import { formatFor } from "../src/ingest/formats.js";

const streamOf = (...parts: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(new TextEncoder().encode(p));
      c.close();
    },
  });

describe("sseData", () => {
  it("une líneas partidas entre paquetes e ignora comentarios", async () => {
    const out: string[] = [];
    for await (const d of sseData(streamOf(": OPENROUTER PROCESSING\n\ndata: {\"a\"", ":1}\n\ndata: [DONE]\n\n"))) out.push(d);
    expect(out).toEqual(['{"a":1}', "[DONE]"]);
  });
});

describe("splitPages", () => {
  it("numera las páginas de formatos paginados", () => {
    expect(splitPages(`uno${PAGE_BREAK}dos`, true)).toEqual({
      pages: [{ page: 1, text: "uno" }, { page: 2, text: "dos" }],
      pageCount: 2,
    });
  });
  it("no inventa páginas en formatos sin paginación", () => {
    expect(splitPages(`uno${PAGE_BREAK}dos`, false).pageCount).toBeNull();
  });
});

describe("formatFor", () => {
  it("reconoce extensiones sin importar mayúsculas", () => {
    expect(formatFor("Informe.PDF")).toMatchObject({ ext: ".pdf", via: "docling", paged: true });
    expect(formatFor("notas.txt")).toMatchObject({ via: "text" });
    expect(formatFor("virus.exe")).toBeNull();
    expect(formatFor("sin_extension")).toBeNull();
  });
});
