import { describe, expect, it } from "vitest";
import { findHighlightRanges, normalizeForMatch, phrasesOf } from "./highlight";

describe("normalizeForMatch", () => {
  it("ignora tildes, mayúsculas y signos", () => {
    expect(normalizeForMatch("Las incidencias CRÍTICAS: 4 horas.")).toBe("las incidencias criticas 4 horas");
  });
});

describe("phrasesOf", () => {
  it("separa por oraciones, líneas y celdas de tabla y descarta lo corto", () => {
    expect(phrasesOf("## Plazos\nEl plazo es de 30 días. Fin.\n| Plan | Precio mensual |")).toEqual([
      "el plazo es de 30 dias",
      "precio mensual",
    ]);
  });
});

describe("findHighlightRanges", () => {
  const items = ["2. Tiempos de respuesta", "Las incidencias críticas se atenderán en un plazo", "máximo de 4 horas hábiles.", "", "3. Precio y forma de pago"];

  it("marca los items que contienen el texto citado aunque esté partido en varias líneas", () => {
    const marked = findHighlightRanges(items, "Las incidencias críticas se atenderán en un plazo máximo de 4 horas hábiles.");
    expect([...marked]).toEqual([1, 2]);
  });

  it("no marca nada si el texto no está en la página", () => {
    expect(findHighlightRanges(items, "El precio mensual del servicio es de 1.250 euros.").size).toBe(0);
  });

  it("tolera el formato Markdown del fragmento", () => {
    const marked = findHighlightRanges(items, "## 2. Tiempos de respuesta\n\n**Las incidencias críticas** se atenderán en un plazo…");
    expect([...marked]).toEqual([0, 1]);
  });
});
