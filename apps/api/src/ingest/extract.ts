import { config } from "../config.js";
import { formatFor } from "./formats.js";

export interface ExtractedPage {
  /** Número de página (1, 2, …) o null si el formato no tiene páginas (Word, HTML…). */
  page: number | null;
  text: string;
}

export interface Extracted {
  pages: ExtractedPage[];
  pageCount: number | null;
}

/** Marcador que pedimos a Docling entre páginas para poder citar números de página. */
export const PAGE_BREAK = "<!-- rag-page-break -->";

/** Extrae el texto de un archivo como Markdown, separado por páginas cuando es posible. */
export async function extractText(filename: string, data: Uint8Array, signal?: AbortSignal): Promise<Extracted> {
  const format = formatFor(filename);
  if (!format) throw new Error(`Formato no soportado: ${filename}`);

  if (format.via === "text") {
    const text = new TextDecoder("utf-8").decode(data);
    return { pages: [{ page: null, text }], pageCount: null };
  }

  const markdown = await convertWithDocling(filename, format.mime, data, signal);
  return splitPages(markdown, format.paged === true);
}

/** Divide el Markdown de Docling por el marcador de salto de página. */
export function splitPages(markdown: string, paged: boolean): Extracted {
  if (!paged) return { pages: [{ page: null, text: markdown.replaceAll(PAGE_BREAK, "\n\n") }], pageCount: null };
  const parts = markdown.split(PAGE_BREAK);
  return {
    pages: parts.map((text, i) => ({ page: i + 1, text })),
    pageCount: parts.length,
  };
}

// ---------------------------------------------------------------------------
// Cliente de docling-serve (API asíncrona: enviar → consultar estado → resultado)
// https://github.com/docling-project/docling-serve/blob/main/docs/usage.md
// ---------------------------------------------------------------------------

interface DoclingTask {
  task_id: string;
  task_status: "pending" | "started" | "success" | "failure";
}

interface DoclingResult {
  document?: { md_content?: string | null };
  status?: string;
  errors?: unknown[];
}

async function convertWithDocling(
  filename: string,
  mime: string,
  data: Uint8Array,
  signal?: AbortSignal,
): Promise<string> {
  const base = config.DOCLING_URL.replace(/\/$/, "");
  const form = new FormData();
  form.append("files", new Blob([data as Uint8Array<ArrayBuffer>], { type: mime }), filename);
  form.append("to_formats", "md");
  form.append("do_ocr", "true");
  for (const lang of config.DOCLING_OCR_LANGS.split(",").map((l) => l.trim()).filter(Boolean)) {
    form.append("ocr_lang", lang);
  }
  form.append("image_export_mode", "placeholder");
  form.append("table_mode", "accurate");
  form.append("md_page_break_placeholder", PAGE_BREAK);
  form.append("document_timeout", String(config.DOCLING_TIMEOUT_SECONDS));

  const submit = await fetch(`${base}/v1/convert/file/async`, { method: "POST", body: form, signal });
  if (!submit.ok) throw new Error(`Docling rechazó el archivo (HTTP ${submit.status}): ${await submit.text()}`);
  let task = (await submit.json()) as DoclingTask;

  const deadline = Date.now() + config.DOCLING_TIMEOUT_SECONDS * 1000;
  while (task.task_status === "pending" || task.task_status === "started") {
    if (Date.now() > deadline) throw new Error("Docling tardó demasiado en convertir el documento");
    const poll = await fetch(`${base}/v1/status/poll/${task.task_id}?wait=5`, { signal });
    if (!poll.ok) throw new Error(`Error consultando a Docling (HTTP ${poll.status})`);
    task = (await poll.json()) as DoclingTask;
  }
  if (task.task_status !== "success") throw new Error("Docling no pudo convertir el documento");

  const res = await fetch(`${base}/v1/result/${task.task_id}`, { signal });
  if (!res.ok) throw new Error(`Error obteniendo el resultado de Docling (HTTP ${res.status})`);
  const result = (await res.json()) as DoclingResult;
  const md = result.document?.md_content ?? "";
  if (!md.trim()) {
    throw new Error(`Docling no extrajo texto (estado: ${result.status ?? "desconocido"})`);
  }
  return md;
}
