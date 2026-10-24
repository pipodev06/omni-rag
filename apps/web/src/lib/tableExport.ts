/**
 * Exportación de las tablas de las respuestas: copiar (se pega en Excel o Sheets) y descargar como CSV.
 * El contenido de una tabla puede venir de un documento ajeno, así que se neutralizan las celdas que Excel interpretaría como
 * fórmulas (empiezan por = + - @ o por un tabulador o un retorno): se les antepone una comilla simple.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const NUMBER = /^[-+]?\d[\d.,\s]*%?$/;

/** Texto de la celda listo para una hoja de cálculo: sin fórmulas ejecutables (los números, incluso negativos, se dejan igual). */
export function safeCell(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return FORMULA_START.test(text) && !NUMBER.test(text) ? `'${text}` : text;
}

/** Filas de una tabla del documento, sin los marcadores de cita ni los dominios de los enlaces (`data-export-skip`). */
export function tableToRows(table: HTMLTableElement): string[][] {
  return [...table.rows].map((row) =>
    [...row.cells].map((cell) => {
      const copy = cell.cloneNode(true) as HTMLElement;
      copy.querySelectorAll("[data-export-skip]").forEach((el) => el.remove());
      return safeCell(copy.textContent ?? "");
    }),
  );
}

/** Texto separado por tabuladores: al pegarlo en Excel o Google Sheets cada dato cae en su celda, sea cual sea el idioma de la hoja. */
export const toTsv = (rows: string[][]): string => rows.map((r) => r.join("\t")).join("\n");

/** CSV con comas, comillas dobles donde hace falta y BOM, para que Excel lea bien los acentos. */
export function toCsv(rows: string[][]): string {
  const field = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `﻿${rows.map((r) => r.map(field).join(",")).join("\r\n")}\r\n`;
}
