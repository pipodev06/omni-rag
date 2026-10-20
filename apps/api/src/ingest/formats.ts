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
