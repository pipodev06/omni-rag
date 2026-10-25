import { describe, expect, it } from "vitest";
import { csvToMarkdown, decodeText, detectDelimiter, parseCsv, splitTables } from "../src/ingest/csv.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("CSV sin Docling", () => {
  it("comillas, comas y saltos de línea dentro de un campo, CRLF", () => {
    expect(parseCsv('a,"b, c","d ""x""\ny"\r\n1,2,3', ",")).toEqual([
      ["a", "b, c", 'd "x"\ny'],
      ["1", "2", "3"],
    ]);
  });

  it("detecta el separador: coma, punto y coma (Excel en español) y tabulador", () => {
    expect(detectDelimiter("a,b,c\n1,2,3")).toBe(",");
    expect(detectDelimiter("nombre;monto\nAna;1,5\nLuis;2,0")).toBe(";");
    expect(detectDelimiter("a\tb\n1\t2")).toBe("\t");
  });

  it("quita el BOM y lee Windows-1252 si no es UTF-8", () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("a");
    expect(decodeText(new Uint8Array([0x61, 0xf1, 0x6f]))).toBe("año");
  });

  it("dos tablas de distinto ancho en un mismo archivo (lo que rompía Docling)", () => {
    const tables = splitTables(parseCsv("a,b\n1,2\n3,4\nx,y,z\n5,6,7", ","));
    expect(tables).toEqual([
      [["a", "b"], ["1", "2"], ["3", "4"]],
      [["x", "y", "z"], ["5", "6", "7"]],
    ]);
  });

  it("una fila suelta más corta se rellena y una fila vacía separa tablas", () => {
    expect(splitTables(parseCsv("a,b,c\n1,2\n3,4,5\n\nx,y\n6,7", ","))).toEqual([
      [["a", "b", "c"], ["1", "2", ""], ["3", "4", "5"]],
      [["x", "y"], ["6", "7"]],
    ]);
  });

  it("genera tablas Markdown con BOM y escapa | en las celdas", () => {
    const md = csvToMarkdown(enc("﻿equipo,estado\nONU 1,ok | activo\n\nzona,clientes,olt\nComas,16,1"));
    expect(md).toBe(
      "| equipo | estado |\n| --- | --- |\n| ONU 1 | ok \\| activo |\n\n| zona | clientes | olt |\n| --- | --- | --- |\n| Comas | 16 | 1 |",
    );
  });
});
