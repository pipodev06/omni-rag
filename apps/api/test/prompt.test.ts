import { describe, expect, it } from "vitest";
import { buildMessages, citedSources, formatContext, formatPages, retrievalQuery, SYSTEM_PROMPT } from "../src/rag/prompt.js";

const chunk = { documentTitle: "Contrato", heading: "Plazos", content: "4 horas.", pageStart: 2, pageEnd: 3 };

describe("prompt", () => {
  it("numera los fragmentos e incluye documento, páginas y sección", () => {
    expect(formatContext([chunk, { ...chunk, pageStart: null, pageEnd: null, heading: "" }])).toBe(
      "[1] Documento: Contrato | págs. 2-3 | Sección: Plazos\n4 horas.\n\n---\n\n[2] Documento: Contrato\n4 horas.",
    );
  });

  it("formatea páginas", () => {
    expect(formatPages(null, null)).toBe("");
    expect(formatPages(4, 4)).toBe("pág. 4");
    expect(formatPages(4, 6)).toBe("págs. 4-6");
  });

  it("coloca sistema, historial y pregunta con contexto en orden", () => {
    const msgs = buildMessages("¿Plazo?", [chunk], [
      { role: "user", content: "hola" },
      { role: "assistant", content: "hola, ¿en qué te ayudo?" },
    ]);
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(msgs[0]!.content).toBe(SYSTEM_PROMPT);
    expect(msgs.at(-1)!.content).toContain("<documentos>\n[1] Documento: Contrato");
    expect(msgs.at(-1)!.content.endsWith("Pregunta: ¿Plazo?")).toBe(true);
  });

  it("enriquece preguntas cortas de seguimiento con la pregunta anterior", () => {
    const history = [
      { role: "user" as const, content: "¿Cuánto cuesta el plan premium?" },
      { role: "assistant" as const, content: "2.400 € [1]" },
    ];
    expect(retrievalQuery("¿y el básico?", history)).toBe("¿Cuánto cuesta el plan premium?\n¿y el básico?");
    expect(retrievalQuery("¿y el básico?", [])).toBe("¿y el básico?");
    const long = "x".repeat(100);
    expect(retrievalQuery(long, history)).toBe(long);
  });

  it("detecta las citas usadas", () => {
    expect([...citedSources("Dato [1] y otro [3][1]. Año [2024] no.")].sort()).toEqual([1, 3]);
  });
});
