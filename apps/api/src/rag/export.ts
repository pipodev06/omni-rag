/**
 * Exportación de una conversación a Markdown. Módulo puro (sin base de datos ni red), para poder probarlo.
 */
import { formatPages } from "./prompt.js";

export interface ExportSource {
  n: number;
  documentTitle: string;
  heading?: string;
  pageStart: number | null;
  pageEnd: number | null;
  cited?: boolean;
  /** Resultado de internet (modo híbrido). */
  kind?: "web";
  url?: string;
}

export interface ExportMessage {
  role: string;
  content: string;
  sources: ExportSource[];
  model: string | null;
  createdAt: Date;
}

const dateTime = (d: Date) =>
  new Intl.DateTimeFormat("es-PE", { dateStyle: "long", timeStyle: "short", timeZone: "America/Lima" }).format(d);

/** Fuentes que respaldan la respuesta: las citadas en el texto; si ninguna lo está, todas las consultadas. */
function listedSources(sources: ExportSource[]): ExportSource[] {
  const cited = sources.filter((s) => s.cited);
  return cited.length > 0 ? cited : sources;
}

function sourceLine(s: ExportSource): string {
  if (s.kind === "web") return `- [${s.n}] Internet: ${s.documentTitle}${s.url ? ` — <${s.url}>` : ""}`;
  const detail = [formatPages(s.pageStart, s.pageEnd), s.heading && `sección «${s.heading}»`].filter(Boolean).join(", ");
  return `- [${s.n}] ${s.documentTitle}${detail ? ` (${detail})` : ""}`;
}

/** Convierte la conversación en un documento Markdown legible: preguntas, respuestas y las fuentes de cada una. */
export function conversationToMarkdown(opts: { title: string; appName: string; exportedAt: Date; messages: ExportMessage[] }): string {
  const lines = [`# ${opts.title}`, "", `_Exportada de ${opts.appName} el ${dateTime(opts.exportedAt)}_`, ""];
  for (const m of opts.messages) {
    if (m.role === "user") {
      lines.push("## Pregunta", "", m.content.trim(), "");
      continue;
    }
    lines.push("## Respuesta", "", m.content.trim(), "");
    const sources = listedSources(m.sources ?? []);
    if (sources.length > 0) lines.push("**Fuentes**", "", ...sources.map(sourceLine), "");
    lines.push(`_${[dateTime(m.createdAt), m.model && `modelo: ${m.model}`].filter(Boolean).join(" · ")}_`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Nombre de archivo seguro (sin caracteres que rompan rutas) a partir del título de la conversación. */
export function exportFilename(title: string): string {
  const base = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 _-]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
  return `${base || "conversacion"}.md`;
}
