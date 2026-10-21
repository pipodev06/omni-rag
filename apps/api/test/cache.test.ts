import { describe, expect, it } from "vitest";
import "./env.js";
import { normalizeQuestion, questionNumbers, scopeKey } from "../src/rag/cache.js";
import { applyRerank } from "../src/rag/rerank.js";

describe("normalizeQuestion", () => {
  it("ignora mayúsculas, tildes, signos y espacios", () => {
    expect(normalizeQuestion("¿Cuántos DÍAS de   vacaciones tengo?")).toBe("cuantos dias de vacaciones tengo");
    expect(normalizeQuestion("¿cuántos días de vacaciones tengo")).toBe(normalizeQuestion("Cuantos dias de vacaciones tengo?"));
  });
  it("conserva números y letras de otros idiomas", () => {
    expect(normalizeQuestion("Factura nº 2026-0457, ¿vence?")).toBe("factura nº 2026 0457 vence");
  });
});

describe("questionNumbers", () => {
  it("extrae números y códigos, sin duplicados y ordenados", () => {
    expect(questionNumbers("¿Cuándo vence la factura 2026-0457?")).toEqual(["2026-0457"]);
    expect(questionNumbers("Plan de 1.250 € o de 2.400 €, año 2026, 2026")).toEqual(["1.250", "2.400", "2026"]);
    expect(questionNumbers("¿Cuántos días de vacaciones?")).toEqual([]);
    expect(questionNumbers("modelo X200 y art. 5.")).toEqual(["5", "x200"]);
  });
  it("distingue preguntas que solo cambian en un código", () => {
    expect(questionNumbers("factura 2026-0457")).not.toEqual(questionNumbers("factura 2026-0458"));
  });
});

describe("scopeKey", () => {
  it("no depende del orden y cambia con el conjunto", () => {
    expect(scopeKey(["b", "a"])).toBe(scopeKey(["a", "b"]));
    expect(scopeKey(["a"])).not.toBe(scopeKey(["a", "b"]));
    expect(scopeKey([])).toHaveLength(32);
  });
});

describe("applyRerank", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  it("ordena por puntuación, filtra por mínimo y corta en topK", () => {
    const out = applyRerank(items, [0.1, 0.9, 0.01, 0.5], 2, 0.02);
    expect(out.map((x) => [x.id, x.rerankScore])).toEqual([
      ["b", 0.9],
      ["d", 0.5],
    ]);
  });
  it("devuelve vacío si nada supera el mínimo", () => {
    expect(applyRerank(items, [0.001, 0.002, 0.003, 0.004], 5, 0.02)).toEqual([]);
  });
});
