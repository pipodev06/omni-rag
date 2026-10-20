import { describe, expect, it } from "vitest";
import { chunkDocument, embeddingText, splitLong, tail, toBlocks } from "../src/ingest/chunker.js";

const opts = { chunkSize: 300, overlap: 50 };

describe("toBlocks", () => {
  it("asigna la ruta de títulos y la página a cada párrafo", () => {
    const blocks = toBlocks([
      { page: 1, text: "# Manual\n\n## Vacaciones\n\nTienes 23 días.\n\n## Bajas\n\nAvisa a RRHH." },
      { page: 2, text: "Continúa la sección de bajas." },
    ]);
    expect(blocks.map((b) => [b.heading, b.page, b.text])).toEqual([
      ["Manual > Vacaciones", 1, "Tienes 23 días."],
      ["Manual > Bajas", 1, "Avisa a RRHH."],
      ["Manual > Bajas", 2, "Continúa la sección de bajas."],
    ]);
  });

  it("mantiene las tablas como un bloque propio y elimina marcadores de imagen", () => {
    const blocks = toBlocks([{ page: null, text: "Texto antes\n| a | b |\n|---|---|\n| 1 | 2 |\n<!-- image -->\nDespués" }]);
    expect(blocks.map((b) => b.isTable)).toEqual([false, true, false]);
    expect(blocks[1]!.text).toBe("| a | b |\n|---|---|\n| 1 | 2 |");
  });

  it("al subir de nivel de título descarta los subtítulos anteriores", () => {
    const blocks = toBlocks([{ page: null, text: "# A\n## B\n### C\ntexto c\n## D\ntexto d" }]);
    expect(blocks.map((b) => b.heading)).toEqual(["A > B > C", "A > D"]);
  });
});

describe("splitLong", () => {
  it("corta por oraciones sin superar el máximo", () => {
    const text = Array.from({ length: 20 }, (_, i) => `Esta es la oración número ${i}.`).join(" ");
    const parts = splitLong(text, 100, false);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(100);
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(text);
  });

  it("repite la cabecera al cortar tablas", () => {
    const rows = Array.from({ length: 30 }, (_, i) => `| fila ${i} | valor ${i} |`);
    const table = ["| col1 | col2 |", "|---|---|", ...rows].join("\n");
    const parts = splitLong(table, 120, true);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.startsWith("| col1 | col2 |\n|---|---|")).toBe(true);
  });

  it("corta en duro las palabras/cadenas larguísimas", () => {
    expect(splitLong("x".repeat(250), 100, false)).toHaveLength(3);
  });
});

describe("tail", () => {
  it("devuelve el final empezando en un límite de palabra", () => {
    expect(tail("uno dos tres cuatro cinco", 12)).toBe("cuatro cinco");
    expect(tail("corto", 50)).toBe("corto");
    expect(tail("algo", 0)).toBe("");
  });
});

describe("chunkDocument", () => {
  it("no produce trozos más grandes que chunkSize (salvo el separador)", () => {
    const text = Array.from({ length: 50 }, (_, i) => `Párrafo ${i} con algo de contenido de relleno para la prueba.`).join("\n\n");
    const chunks = chunkDocument([{ page: 1, text }], opts);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(opts.chunkSize + 10);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it("solapa trozos consecutivos de la misma sección", () => {
    const text = Array.from({ length: 30 }, (_, i) => `Frase número ${i} del documento.`).join(" ");
    const [a, b] = chunkDocument([{ page: 1, text }], opts);
    expect(a && b).toBeTruthy();
    const end = a!.content.slice(-20);
    expect(b!.content).toContain(end.trim().split(" ").at(-1)!);
  });

  it("empieza un trozo nuevo al cambiar de sección cuando el actual es grande", () => {
    const long = "Contenido extenso de la sección. ".repeat(4);
    const chunks = chunkDocument([{ page: 1, text: `## Uno\n${long}\n## Dos\n${long}` }], opts);
    expect(chunks.map((c) => c.heading)).toEqual(["Uno", "Dos"]);
    expect(chunks[1]!.content.startsWith("Contenido")).toBe(true); // sin solape entre secciones
  });

  it("une secciones cortas conservando el título inicial y escribiendo los siguientes", () => {
    const chunks = chunkDocument([{ page: 1, text: "## Objeto\nCorto.\n## Plazos\nTambién corto." }], opts);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.heading).toBe("Objeto");
    expect(chunks[0]!.content).toBe("Corto.\n\n## Plazos\n\nTambién corto.");
  });

  it("registra el rango de páginas de cada trozo", () => {
    const chunks = chunkDocument(
      [
        { page: 1, text: "Texto de la página uno." },
        { page: 2, text: "Texto de la página dos." },
      ],
      opts,
    );
    expect(chunks[0]).toMatchObject({ pageStart: 1, pageEnd: 2 });
  });

  it("ignora documentos vacíos", () => {
    expect(chunkDocument([{ page: 1, text: "  \n\n <!-- image --> \n" }], opts)).toEqual([]);
  });

  it("rechaza un solape mayor o igual al tamaño", () => {
    expect(() => chunkDocument([], { chunkSize: 100, overlap: 100 })).toThrow();
  });
});

describe("embeddingText", () => {
  it("antepone prefijo, título y sección", () => {
    expect(embeddingText("passage: ", "Contrato", { heading: "Precio", content: "1.250 €" })).toBe(
      "passage: Contrato — Precio\n\n1.250 €",
    );
  });
});
