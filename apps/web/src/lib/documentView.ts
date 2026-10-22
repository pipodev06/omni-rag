import type { DocumentInfo } from "@/api";

/** Cómo se ve la lista de documentos: filtros y orden (todo en el navegador; la API entrega hasta 1000 por colección). */
export type StatusFilter = "all" | "ready" | "busy" | "failed";
export type SortKey = "title" | "status" | "size" | "pages" | "chunks" | "created";
export type SortDir = "asc" | "desc";

export interface DocumentView {
  status: StatusFilter;
  /** Extensión sin punto («pdf») o «all». */
  type: string;
  sort: { key: SortKey; dir: SortDir };
}

export const DEFAULT_VIEW: DocumentView = { status: "all", type: "all", sort: { key: "created", dir: "desc" } };

/** Sentido con el que empieza cada columna al ordenarla por primera vez. */
export const FIRST_DIR: Record<SortKey, SortDir> = { title: "asc", status: "asc", size: "desc", pages: "desc", chunks: "desc", created: "desc" };

export const fileExtension = (filename: string): string => /\.([^.]+)$/.exec(filename)?.[1]?.toLowerCase() ?? "";

export const isFiltered = (view: DocumentView): boolean => view.status !== "all" || view.type !== "all";

/** Extensiones presentes en la lista, para el filtro por tipo. */
export const availableTypes = (docs: DocumentInfo[]): string[] => [...new Set(docs.map((d) => fileExtension(d.filename)).filter(Boolean))].sort();

// Con errores primero y listos al final: al ordenar por estado lo que necesita atención queda arriba.
const STATUS_RANK: Record<DocumentInfo["status"], number> = { failed: 0, pending: 1, processing: 2, ready: 3 };

const matchesStatus = (d: DocumentInfo, f: StatusFilter): boolean =>
  f === "all" || (f === "ready" && d.status === "ready") || (f === "failed" && d.status === "failed") || (f === "busy" && (d.status === "pending" || d.status === "processing"));

function sortValue(d: DocumentInfo, key: SortKey): string | number {
  switch (key) {
    case "title":
      return d.title;
    case "status":
      return STATUS_RANK[d.status];
    case "size":
      return d.sizeBytes;
    case "pages":
      return d.pageCount ?? -1;
    case "chunks":
      return d.chunkCount;
    case "created":
      return Date.parse(d.createdAt);
  }
}

/** Aplica filtro y orden. No modifica la lista original. */
export function applyView(docs: DocumentInfo[], view: DocumentView): DocumentInfo[] {
  const sign = view.sort.dir === "asc" ? 1 : -1;
  return docs
    .filter((d) => matchesStatus(d, view.status) && (view.type === "all" || fileExtension(d.filename) === view.type))
    .sort((a, b) => {
      const x = sortValue(a, view.sort.key);
      const y = sortValue(b, view.sort.key);
      const cmp = typeof x === "string" && typeof y === "string" ? x.localeCompare(y, "es", { numeric: true, sensitivity: "base" }) : Number(x) - Number(y);
      return cmp !== 0 ? sign * cmp : a.title.localeCompare(b.title, "es", { numeric: true, sensitivity: "base" });
    });
}
