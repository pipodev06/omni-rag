/**
 * Formatos de archivo admitidos.
 * - "text": se leen directamente como UTF-8 (rápido, sin Docling).
 * - "docling": se convierten a Markdown con Docling (PDF, Office, HTML, imágenes con OCR…).
 */
export const FORMATS: Record<string, { mime: string; via: "text" | "docling"; paged?: boolean }> = {
  ".txt": { mime: "text/plain", via: "text" },
  ".md": { mime: "text/markdown", via: "text" },
  ".markdown": { mime: "text/markdown", via: "text" },
  ".json": { mime: "application/json", via: "text" },
  ".log": { mime: "text/plain", via: "text" },
  ".pdf": { mime: "application/pdf", via: "docling", paged: true },
  ".docx": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", via: "docling" },
  ".pptx": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", via: "docling", paged: true },
  ".xlsx": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", via: "docling" },
  ".csv": { mime: "text/csv", via: "docling" },
  ".html": { mime: "text/html", via: "docling" },
  ".htm": { mime: "text/html", via: "docling" },
  ".xhtml": { mime: "application/xhtml+xml", via: "docling" },
  ".adoc": { mime: "text/asciidoc", via: "docling" },
  ".png": { mime: "image/png", via: "docling" },
  ".jpg": { mime: "image/jpeg", via: "docling" },
  ".jpeg": { mime: "image/jpeg", via: "docling" },
  ".tif": { mime: "image/tiff", via: "docling" },
  ".tiff": { mime: "image/tiff", via: "docling" },
  ".bmp": { mime: "image/bmp", via: "docling" },
  ".webp": { mime: "image/webp", via: "docling" },
};

export const SUPPORTED_EXTENSIONS = Object.keys(FORMATS);

export function formatFor(filename: string) {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : "";
  const f = FORMATS[ext];
  return f ? { ext, ...f } : null;
}

const startsWith = (d: Uint8Array, sig: number[], at = 0) => sig.every((b, i) => d[at + i] === b);
const ascii = (d: Uint8Array, from: number, to: number) => String.fromCharCode(...d.subarray(from, to));
const ZIP = (d: Uint8Array) => startsWith(d, [0x50, 0x4b, 0x03, 0x04]);

/** Comprobación de la «firma» de cada formato binario. */
const SIGNATURES: Record<string, (d: Uint8Array) => boolean> = {
  ".pdf": (d) => ascii(d, 0, 1024).includes("%PDF-"),
  ".docx": ZIP,
  ".pptx": ZIP,
  ".xlsx": ZIP,
  ".png": (d) => startsWith(d, [0x89, 0x50, 0x4e, 0x47]),
  ".jpg": (d) => startsWith(d, [0xff, 0xd8, 0xff]),
  ".jpeg": (d) => startsWith(d, [0xff, 0xd8, 0xff]),
  ".tif": (d) => startsWith(d, [0x49, 0x49, 0x2a, 0x00]) || startsWith(d, [0x4d, 0x4d, 0x00, 0x2a]),
  ".tiff": (d) => startsWith(d, [0x49, 0x49, 0x2a, 0x00]) || startsWith(d, [0x4d, 0x4d, 0x00, 0x2a]),
  ".bmp": (d) => startsWith(d, [0x42, 0x4d]),
  ".webp": (d) => ascii(d, 0, 4) === "RIFF" && ascii(d, 8, 12) === "WEBP",
};

/**
 * ¿El contenido corresponde a la extensión? Evita que un ejecutable o un archivo raro
 * llegue a Docling renombrado como «.pdf». Los formatos de texto no pueden llevar bytes nulos.
 */
export function contentMatchesFormat(ext: string, data: Uint8Array): boolean {
  const check = SIGNATURES[ext];
  if (check) return check(data);
  return !data.subarray(0, 8000).includes(0);
}
