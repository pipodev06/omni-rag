import { describe, expect, it } from "vitest";
import { safeCell, toCsv, toTsv } from "./tableExport";

describe("safeCell", () => {
  it("neutraliza lo que Excel ejecutaría como fórmula", () => {
    expect(safeCell("=HYPERLINK(\"http://malo\",\"x\")")).toBe("'=HYPERLINK(\"http://malo\",\"x\")");
    expect(safeCell("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
    expect(safeCell("@SUM(1+1)")).toBe("'@SUM(1+1)");
    expect(safeCell("-2+3")).toBe("'-2+3");
  });

  it("deja intactos los textos normales y los números, también los negativos", () => {
    expect(safeCell("Plazo de entrega")).toBe("Plazo de entrega");
    expect(safeCell("-15,5%")).toBe("-15,5%");
    expect(safeCell("+51")).toBe("+51");
    expect(safeCell("1 250.00")).toBe("1 250.00");
  });

  it("colapsa espacios y saltos de línea", () => {
    expect(safeCell("  30\n días  ")).toBe("30 días");
  });
});

describe("toCsv / toTsv", () => {
  const rows = [
    ["Concepto", "Monto"],
    ['Caja "chica", S/', "1,200"],
  ];

  it("entrecomilla lo que lleva comas, comillas o saltos y añade BOM", () => {
    expect(toCsv(rows)).toBe('﻿Concepto,Monto\r\n"Caja ""chica"", S/","1,200"\r\n');
  });

  it("une con tabuladores para pegar en una hoja de cálculo", () => {
    expect(toTsv(rows)).toBe('Concepto\tMonto\nCaja "chica", S/\t1,200');
  });
});
