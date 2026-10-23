import { describe, expect, it } from "vitest";
import { conversationToMarkdown, exportFilename, type ExportMessage } from "../src/rag/export.js";

const at = new Date("2026-10-23T15:00:00Z");
const msg = (over: Partial<ExportMessage>): ExportMessage => ({ role: "assistant", content: "x", sources: [], model: null, createdAt: at, ...over });

describe("exportar conversación a Markdown", () => {
  const md = conversationToMarkdown({
    title: "Plazos del contrato",
    appName: "Omni RAG",
    exportedAt: at,
    messages: [
      msg({ role: "user", content: "¿Cuál es el plazo?" }),
      msg({
        content: "El plazo es de 30 días [1].",
        model: "google:gemini-3.5-flash",
        sources: [
          { n: 1, documentTitle: "Contrato", heading: "Plazos", pageStart: 2, pageEnd: 3, cited: true },
          { n: 2, documentTitle: "Anexo", pageStart: null, pageEnd: null, cited: false },
        ],
      }),
    ],
  });

  it("lleva título, origen, pregunta y respuesta en orden", () => {
    expect(md.startsWith("# Plazos del contrato\n")).toBe(true);
    expect(md).toContain("_Exportada de Omni RAG el ");
    expect(md.indexOf("## Pregunta")).toBeLessThan(md.indexOf("## Respuesta"));
    expect(md).toContain("¿Cuál es el plazo?");
    expect(md).toContain("El plazo es de 30 días [1].");
  });

  it("lista solo las fuentes citadas, con páginas y sección", () => {
    expect(md).toContain("- [1] Contrato (págs. 2-3, sección «Plazos»)");
    expect(md).not.toContain("Anexo");
  });

  it("indica el modelo y termina con un salto de línea", () => {
    expect(md).toContain("modelo: google:gemini-3.5-flash");
    expect(md.endsWith("\n")).toBe(true);
  });

  it("si ninguna fuente está marcada como citada, lista todas las consultadas", () => {
    const text = conversationToMarkdown({
      title: "t",
      appName: "App",
      exportedAt: at,
      messages: [msg({ sources: [{ n: 1, documentTitle: "Manual", pageStart: 4, pageEnd: 4 }] })],
    });
    expect(text).toContain("- [1] Manual (pág. 4)");
  });

  it("una conversación vacía no falla", () => {
    expect(conversationToMarkdown({ title: "Vacía", appName: "App", exportedAt: at, messages: [] })).toContain("# Vacía");
  });
});

describe("nombre del archivo exportado", () => {
  it("quita tildes y símbolos", () => {
    expect(exportFilename("¿Cuál es el plazo? / «Contrato» 2026")).toBe("Cual-es-el-plazo-Contrato-2026.md");
  });
  it("no deja que el título escape de la carpeta ni quede vacío", () => {
    expect(exportFilename("../../etc/passwd")).toBe("etc-passwd.md");
    expect(exportFilename("¿¡???")).toBe("conversacion.md");
  });
  it("acorta los títulos largos", () => {
    expect(exportFilename("a".repeat(200)).length).toBeLessThanOrEqual(63);
  });
});
