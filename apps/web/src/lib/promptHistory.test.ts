import { describe, expect, it } from "vitest";
import { mergeHistory, nextHistoryIndex } from "./promptHistory";

describe("nextHistoryIndex", () => {
  it("↑ empieza por la última pregunta y sube hasta la primera sin pasarse", () => {
    expect(nextHistoryIndex(3, null, "up")).toBe(2);
    expect(nextHistoryIndex(3, 2, "up")).toBe(1);
    expect(nextHistoryIndex(3, 0, "up")).toBe(0);
  });

  it("↓ avanza y, tras la última, vuelve al borrador", () => {
    expect(nextHistoryIndex(3, 0, "down")).toBe(1);
    expect(nextHistoryIndex(3, 2, "down")).toBeNull();
    expect(nextHistoryIndex(3, null, "down")).toBeNull();
  });

  it("sin historial no hace nada", () => {
    expect(nextHistoryIndex(0, null, "up")).toBeNull();
  });
});

describe("mergeHistory", () => {
  it("une lo guardado con la conversación, sin repetidos y con la conversación al final", () => {
    expect(mergeHistory(["a", "b", "c"], ["b", "d"])).toEqual(["a", "c", "b", "d"]);
  });

  it("ignora vacíos y espacios", () => {
    expect(mergeHistory([" a ", ""], ["a", "  "])).toEqual(["a"]);
  });
});
