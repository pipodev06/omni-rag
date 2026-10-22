import { describe, expect, it } from "vitest";
import type { DocumentInfo } from "@/api";
import { applyView, availableTypes, DEFAULT_VIEW, fileExtension, isFiltered, type DocumentView } from "./documentView";

const doc = (over: Partial<DocumentInfo> & { title: string }): DocumentInfo => ({
  id: over.title,
  collectionId: "c",
  filename: `${over.title}.pdf`,
  mimeType: "application/pdf",
  sizeBytes: 100,
  status: "ready",
  error: null,
  pageCount: 1,
  chunkCount: 1,
  createdAt: "2026-10-01T00:00:00Z",
  ...over,
});

const view = (over: Partial<DocumentView> = {}, sort?: DocumentView["sort"]): DocumentView => ({ ...DEFAULT_VIEW, ...over, sort: sort ?? DEFAULT_VIEW.sort });
const titles = (docs: DocumentInfo[]) => docs.map((d) => d.title);

describe("vista de documentos", () => {
  const docs = [
    doc({ title: "b", sizeBytes: 300, createdAt: "2026-10-02T00:00:00Z", pageCount: null }),
    doc({ title: "a", sizeBytes: 100, createdAt: "2026-10-03T00:00:00Z", status: "failed", filename: "a.docx" }),
    doc({ title: "C", sizeBytes: 200, createdAt: "2026-10-01T00:00:00Z", status: "processing", pageCount: 9 }),
  ];

  it("por defecto: lo más reciente primero", () => {
    expect(titles(applyView(docs, DEFAULT_VIEW))).toEqual(["a", "b", "C"]);
  });
  it("ordena por título sin distinguir mayúsculas, y numéricamente", () => {
    expect(titles(applyView(docs, view({}, { key: "title", dir: "asc" })))).toEqual(["a", "b", "C"]);
    const nums = [doc({ title: "doc 10" }), doc({ title: "doc 2" })];
    expect(titles(applyView(nums, view({}, { key: "title", dir: "asc" })))).toEqual(["doc 2", "doc 10"]);
  });
  it("ordena por tamaño en ambos sentidos", () => {
    expect(titles(applyView(docs, view({}, { key: "size", dir: "desc" })))).toEqual(["b", "C", "a"]);
    expect(titles(applyView(docs, view({}, { key: "size", dir: "asc" })))).toEqual(["a", "C", "b"]);
  });
  it("los documentos sin páginas van al final al ordenar de mayor a menor", () => {
    expect(titles(applyView(docs, view({}, { key: "pages", dir: "desc" })))).toEqual(["C", "a", "b"]);
  });
  it("al ordenar por estado, lo que tiene error queda arriba", () => {
    expect(titles(applyView(docs, view({}, { key: "status", dir: "asc" })))[0]).toBe("a");
  });
  it("filtra por estado", () => {
    expect(titles(applyView(docs, view({ status: "failed" })))).toEqual(["a"]);
    expect(titles(applyView(docs, view({ status: "busy" })))).toEqual(["C"]);
    expect(titles(applyView(docs, view({ status: "ready" })))).toEqual(["b"]);
  });
  it("filtra por tipo y lista los tipos disponibles", () => {
    expect(titles(applyView(docs, view({ type: "docx" })))).toEqual(["a"]);
    expect(availableTypes(docs)).toEqual(["docx", "pdf"]);
  });
  it("no modifica la lista original", () => {
    const copy = [...docs];
    applyView(docs, view({}, { key: "title", dir: "asc" }));
    expect(docs).toEqual(copy);
  });
  it("detecta si hay filtros activos y lee extensiones", () => {
    expect(isFiltered(DEFAULT_VIEW)).toBe(false);
    expect(isFiltered(view({ type: "pdf" }))).toBe(true);
    expect(fileExtension("Informe.Final.PDF")).toBe("pdf");
    expect(fileExtension("sin-extension")).toBe("");
  });
});
