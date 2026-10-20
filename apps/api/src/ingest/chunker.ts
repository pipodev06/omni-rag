/**
 * Fragmentador (chunker) consciente de Markdown.
 *
 * Objetivo: trozos de tamaño parecido que respeten la estructura del documento.
 *  1. Recorre el texto línea a línea y recuerda la ruta de títulos actual
 *     ("Contrato > Cláusulas > Garantía"), que se guarda con cada trozo.
 *  2. Agrupa el texto en bloques: párrafos, listas y tablas completas.
 *  3. Junta bloques hasta llegar a `chunkSize` caracteres. Empieza un trozo
 *     nuevo al cambiar de sección (si el actual no es demasiado pequeño).
 *  4. Los bloques demasiado grandes se cortan por oraciones (o filas de tabla).
 *  5. Entre trozos consecutivos de la misma sección se repite el final del
 *     anterior (`overlap`) para no perder contexto en los cortes.
 *
 * Este módulo es puro (no usa configuración ni red) para poder probarlo fácilmente.
 */

export interface ChunkerPage {
  page: number | null;
  text: string;
}

export interface Chunk {
  index: number;
  heading: string;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
}

export interface ChunkerOptions {
  chunkSize: number;
  overlap: number;
}

interface Block {
  text: string;
  heading: string;
  page: number | null;
  isTable: boolean;
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
// Marcadores que Docling deja en lugar de imágenes u otros elementos sin texto.
const NOISE_RE = /^<!--\s*(image|formula-not-decoded)\s*-->$/i;

/** Convierte las páginas en bloques (párrafos/tablas) con su título y página. */
export function toBlocks(pages: ChunkerPage[]): Block[] {
  const blocks: Block[] = [];
  const headings: string[] = [];
  let buffer: string[] = [];
  let bufferIsTable = false;
  let bufferPage: number | null = null;

  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text) {
      blocks.push({ text, heading: headings.filter(Boolean).join(" > "), page: bufferPage, isTable: bufferIsTable });
    }
    buffer = [];
    bufferIsTable = false;
  };

  for (const { page, text } of pages) {
    flush();
    bufferPage = page;
    for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
      const line = rawLine.trimEnd();
      if (NOISE_RE.test(line.trim())) continue;

      const h = HEADING_RE.exec(line.trim());
      if (h) {
        flush();
        const level = h[1]!.length;
        headings.length = level - 1;
        headings[level - 1] = h[2]!.trim();
        continue;
      }

      const isTableLine = line.trim().startsWith("|");
      if (line.trim() === "" || (buffer.length > 0 && isTableLine !== bufferIsTable)) {
        flush();
        if (line.trim() === "") continue;
      }
      if (buffer.length === 0) {
        bufferIsTable = isTableLine;
        bufferPage = page;
      }
      buffer.push(line);
    }
  }
  flush();
  return blocks;
}

/** Corta un texto largo en piezas de como máximo `max` caracteres, respetando oraciones o líneas. */
export function splitLong(text: string, max: number, isTable: boolean): string[] {
  if (text.length <= max) return [text];

  if (isTable) {
    // Tablas: cortar por filas y repetir la cabecera (2 primeras líneas) en cada pieza.
    const lines = text.split("\n");
    const header = lines.slice(0, 2).join("\n");
    const rows = lines.slice(2);
    const out: string[] = [];
    let cur: string[] = [];
    for (const row of rows) {
      const candidate = [header, ...cur, row].join("\n");
      if (candidate.length > max && cur.length > 0) {
        out.push([header, ...cur].join("\n"));
        cur = [];
      }
      cur.push(row);
    }
    if (cur.length) out.push([header, ...cur].join("\n"));
    return out.flatMap((p) => (p.length > max ? hardSplit(p, max) : [p]));
  }

  const sentences = text.match(/[^.!?¿¡\n]+(?:[.!?]+["')\]]*|\n|$)\s*/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && (cur + s).length > max) {
      out.push(cur.trim());
      cur = "";
    }
    if (s.length > max) {
      out.push(...hardSplit(s.trim(), max));
      continue;
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function hardSplit(text: string, max: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out;
}

/** Últimos ~`size` caracteres de un texto, empezando en un límite de palabra/oración. */
export function tail(text: string, size: number): string {
  if (size <= 0 || text.length <= size) return size <= 0 ? "" : text;
  const slice = text.slice(text.length - size);
  const sentence = slice.search(/[.!?\n]\s+\S/);
  if (sentence >= 0 && sentence < size / 2) return slice.slice(sentence + 1).trim();
  // Si el corte ya cae al inicio de una palabra, no hay que recortar nada.
  if (/\s/.test(text[text.length - size - 1] ?? "")) return slice.trim();
  const space = slice.indexOf(" ");
  return (space >= 0 ? slice.slice(space + 1) : slice).trim();
}

export function chunkDocument(pages: ChunkerPage[], opts: ChunkerOptions): Chunk[] {
  const { chunkSize, overlap } = opts;
  if (overlap >= chunkSize) throw new Error("overlap debe ser menor que chunkSize");

  const chunks: Chunk[] = [];
  let parts: string[] = [];
  let heading = ""; // sección del bloque actual
  let chunkHeading = ""; // sección donde empieza el trozo actual
  let pageStart: number | null = null;
  let pageEnd: number | null = null;
  let hasNewContent = false;

  const size = () => parts.reduce((n, p) => n + p.length + 2, 0);

  const emit = (keepOverlap: boolean) => {
    const content = parts.join("\n\n").trim();
    if (content && hasNewContent) {
      chunks.push({ index: chunks.length, heading: chunkHeading, content, pageStart, pageEnd });
    }
    const carry = keepOverlap ? tail(content, overlap) : "";
    parts = carry ? [carry] : [];
    hasNewContent = false;
    pageStart = carry ? pageEnd : null;
  };

  for (const block of toBlocks(pages)) {
    if (block.heading !== heading) {
      if (hasNewContent && size() >= chunkSize * 0.25) {
        // Cambio de sección con un trozo ya razonable: cerrarlo y empezar otro.
        emit(false);
      } else if (hasNewContent) {
        // Sección anterior muy corta: se sigue en el mismo trozo, pero el
        // subtítulo queda escrito en el texto para no perder la estructura.
        const title = lastHeading(block.heading);
        if (title) parts.push(`## ${title}`);
      } else {
        parts = [];
      }
      heading = block.heading;
    }

    for (const piece of splitLong(block.text, chunkSize - overlap, block.isTable)) {
      if (hasNewContent && size() + piece.length > chunkSize) emit(true);
      if (!hasNewContent) chunkHeading = heading;
      parts.push(piece);
      hasNewContent = true;
      if (pageStart === null) pageStart = block.page;
      pageEnd = block.page ?? pageEnd;
    }
  }
  emit(false);
  return chunks;
}

/** Último nivel de una ruta de títulos: "A > B > C" → "C". */
const lastHeading = (path: string): string => path.split(" > ").at(-1) ?? "";

/**
 * Texto que se envía al modelo de embeddings para un trozo: incluye el título
 * del documento y la sección para dar contexto ("contextual chunk header").
 */
export function embeddingText(prefix: string, title: string, chunk: Pick<Chunk, "heading" | "content">): string {
  const header = [title, chunk.heading].filter(Boolean).join(" — ");
  return `${prefix}${header}\n\n${chunk.content}`;
}
