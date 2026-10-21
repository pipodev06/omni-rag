import { describe, expect, it } from "vitest";
import { buildSummaryMessages, parseSummary, SUMMARY_INPUT_CHARS } from "../src/rag/summary.js";

describe("parseSummary", () => {
  it("lee el JSON aunque venga envuelto en ```json y con texto alrededor", () => {
    const raw = 'Claro:\n```json\n{"resumen": "Contrato de soporte.", "preguntas": ["¿Cuánto cuesta?", "¿Qué plazo hay?"]}\n```';
    expect(parseSummary(raw)).toEqual({ summary: "Contrato de soporte.", questions: ["¿Cuánto cuesta?", "¿Qué plazo hay?"] });
  });
  it("acepta claves en inglés y descarta preguntas vacías o enormes", () => {
    const raw = JSON.stringify({ summary: "Resumen", questions: ["", "ok?", "¿Pregunta válida?", "x".repeat(400)] });
    expect(parseSummary(raw)).toEqual({ summary: "Resumen", questions: ["¿Pregunta válida?"] });
  });
  it("si no hay JSON usa el texto como resumen", () => {
    expect(parseSummary("Este documento trata de vacaciones.")).toEqual({ summary: "Este documento trata de vacaciones.", questions: [] });
  });
});

describe("buildSummaryMessages", () => {
  it("limita el texto enviado y conserva los títulos", () => {
    const chunks = Array.from({ length: 50 }, (_, i) => ({ heading: `Sección ${i}`, content: "x".repeat(500) }));
    const [system, user] = buildSummaryMessages("Manual", chunks);
    expect(system!.role).toBe("system");
    expect(user!.content).toContain("## Sección 0");
    expect(user!.content.length).toBeLessThan(SUMMARY_INPUT_CHARS + 200);
  });
});
