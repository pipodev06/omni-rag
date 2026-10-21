/**
 * Encuentra qué trozos de texto de una página PDF corresponden a un fragmento
 * citado, para resaltarlos. Tolera diferencias de mayúsculas, tildes, signos,
 * saltos de línea y formato Markdown (títulos, tablas, negritas).
 */

/** Minúsculas, sin tildes, solo letras y números separados por un espacio. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Frases del fragmento que merece la pena buscar (las muy cortas darían falsos positivos). */
export function phrasesOf(excerpt: string, minLength = 12): string[] {
  const clean = excerpt.replace(/…$/, "").replace(/^#{1,6}\s+/gm, "").replace(/\*\*/g, "");
  const parts = clean.split(/(?<=[.!?:;])\s+|\n+|\|/);
  const out = new Set<string>();
  for (const part of parts) {
    const n = normalizeForMatch(part);
    if (n.length >= minLength) out.add(n);
  }
  return [...out];
}

/**
 * Devuelve los índices de `items` (textos de la capa de texto de PDF.js, en orden)
 * que se solapan con alguna frase del fragmento.
 */
export function findHighlightRanges(items: string[], excerpt: string): Set<number> {
  // Texto normalizado de la página + posición de cada item dentro de él.
  let page = "";
  const spans: [number, number][] = [];
  for (const raw of items) {
    const n = normalizeForMatch(raw);
    if (!n) {
      spans.push([-1, -1]);
      continue;
    }
    if (page) page += " ";
    const start = page.length;
    page += n;
    spans.push([start, page.length]);
  }

  const ranges: [number, number][] = [];
  for (const phrase of phrasesOf(excerpt)) {
    let from = 0;
    let idx: number;
    while ((idx = page.indexOf(phrase, from)) >= 0) {
      ranges.push([idx, idx + phrase.length]);
      from = idx + phrase.length;
    }
  }

  const marked = new Set<number>();
  spans.forEach(([s, e], i) => {
    if (s < 0) return;
    if (ranges.some(([rs, re]) => s < re && e > rs)) marked.add(i);
  });
  return marked;
}
