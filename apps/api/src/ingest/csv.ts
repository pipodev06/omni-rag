/**
 * CSV → Markdown sin Docling. El lector de Docling exige que todas las filas tengan las mismas columnas y falla sin decir
 * por qué; en la práctica llegan CSV «unidos» (dos tablas seguidas con distinto ancho), con BOM, separados por «;» (Excel
 * en español) o en Windows-1252. Aquí cada bloque de filas con el mismo ancho se convierte en su propia tabla Markdown.
 */
const DELIMITERS = [",", ";", "\t", "|"] as const;

/** UTF-8 (sin BOM) y, si no es UTF-8 válido, Windows-1252, que es lo que exporta Excel en español. */
export function decodeText(data: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(data);
  }
}

/** Filas y campos según RFC 4180: comillas dobles, "" dentro de comillas, saltos de línea dentro de un campo, CRLF. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** El separador que da el mismo número de columnas (mayor que 1) en más de las primeras filas. */
export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20).join("\n");
  let best: { d: string; score: number } = { d: ",", score: 0 };
  for (const d of DELIMITERS) {
    const widths = parseCsv(sample, d).map((r) => r.length).filter((w) => w > 1);
    if (!widths.length) continue;
    const counts = new Map<number, number>();
    for (const w of widths) counts.set(w, (counts.get(w) ?? 0) + 1);
    const score = Math.max(...counts.values());
    if (score > best.score) best = { d, score };
  }
  return best.d;
}

const trimRow = (r: string[]) => {
  const cells = r.map((c) => c.trim());
  while (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells;
};

/**
 * Agrupa las filas en tablas. Una fila vacía cierra la tabla. Un cambio de ancho abre una tabla nueva solo si se
 * mantiene en la fila siguiente; una fila suelta más corta (celdas finales vacías) se rellena en la tabla actual.
 */
export function splitTables(rows: string[][]): string[][][] {
  const cleaned = rows.map(trimRow);
  const tables: string[][][] = [];
  let current: string[][] = [];
  let width = 0;
  const close = () => {
    if (current.length) tables.push(current.map((r) => [...r, ...Array<string>(width - r.length).fill("")]));
    current = [];
    width = 0;
  };
  cleaned.forEach((r, i) => {
    if (r.length === 0) return close();
    const next = cleaned[i + 1];
    const changes = current.length > 0 && r.length !== width && (r.length > width || next?.length === r.length);
    if (changes) close();
    if (!current.length) width = r.length;
    current.push(r);
  });
  close();
  return tables;
}

const cell = (s: string) => s.replace(/\s*\r?\n\s*/g, " ").replace(/\|/g, "\\|");

/** Una tabla Markdown por bloque; la primera fila de cada bloque es la cabecera. Un bloque de una sola columna es texto. */
export function csvToMarkdown(data: Uint8Array): string {
  const text = decodeText(data);
  const tables = splitTables(parseCsv(text, detectDelimiter(text)));
  return tables
    .map((t) => {
      if (t[0]!.length === 1) return t.map((r) => r[0]).join("\n");
      const [head, ...body] = t;
      return [`| ${head!.map(cell).join(" | ")} |`, `|${head!.map(() => " --- ").join("|")}|`, ...body.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
    })
    .join("\n\n");
}
