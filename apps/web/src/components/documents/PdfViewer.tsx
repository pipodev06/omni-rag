import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Minus, Plus, TriangleAlert } from "lucide-react";
// Versión "legacy" de PDF.js: incluye polyfills para navegadores que aún no
// soportan las APIs de JavaScript más recientes que usa la versión estándar.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { Button } from "@/components/ui/button";
import { findHighlightRanges } from "@/lib/highlight";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Visor de PDF: dibuja una página con PDF.js, añade la capa de texto y resalta
 * las frases del fragmento citado (`highlight`).
 */
export default function PdfViewer({ url, initialPage = 1, highlight }: { url: string; initialPage?: number; highlight?: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(initialPage);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState("");
  const [rendering, setRendering] = useState(true);
  const [matches, setMatches] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  useEffect(() => setPage(initialPage), [initialPage]);

  // Cargar el documento.
  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setError("");
    const task = pdfjs.getDocument({ url, withCredentials: true });
    task.promise
      .then((d) => !cancelled && setDoc(d))
      .catch((err: Error) => !cancelled && setError(err.message || "No se pudo abrir el PDF"));
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [url]);

  // Dibujar la página actual.
  useEffect(() => {
    if (!doc || !pageRef.current || !wrapRef.current) return;
    let cancelled = false;
    const container = pageRef.current;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | null = null;
    let textLayer: pdfjs.TextLayer | null = null;
    setRendering(true);

    (async () => {
      const p = await doc.getPage(Math.min(Math.max(1, page), doc.numPages));
      if (cancelled) return;
      const available = wrapRef.current!.clientWidth - 32;
      const base = p.getViewport({ scale: 1 });
      const scale = Math.max(0.5, (available / base.width) * zoom);
      const viewport = p.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;

      container.replaceChildren();
      container.style.width = `${viewport.width}px`;
      container.style.height = `${viewport.height}px`;
      container.style.setProperty("--scale-factor", String(scale));
      container.style.setProperty("--total-scale-factor", String(scale));

      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      container.appendChild(canvas);
      renderTask = p.render({
        canvas,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      await renderTask.promise;
      if (cancelled) return;

      const layerDiv = document.createElement("div");
      layerDiv.className = "textLayer";
      container.appendChild(layerDiv);
      textLayer = new pdfjs.TextLayer({ textContentSource: p.streamTextContent(), container: layerDiv, viewport });
      await textLayer.render();
      if (cancelled) return;

      // Resaltar el fragmento citado.
      let found = 0;
      if (highlight) {
        const marked = findHighlightRanges(textLayer.textContentItemsStr, highlight);
        textLayer.textDivs.forEach((div, i) => {
          if (marked.has(i)) {
            div.classList.add("rag-highlight");
            found++;
          }
        });
        const first = layerDiv.querySelector(".rag-highlight");
        first?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      setMatches(found);
      setRendering(false);
    })().catch((err: Error) => {
      if (!cancelled && err?.name !== "RenderingCancelledException") setError(err.message);
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [doc, page, zoom, highlight]);

  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center text-sm text-muted-foreground">
        <TriangleAlert className="size-5 text-destructive" />
        No se pudo mostrar el PDF: {error}
      </div>
    );
  }

  const total = doc?.numPages ?? 0;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-8" onClick={() => setPage((p) => p - 1)} disabled={page <= 1} aria-label="Página anterior">
            <ChevronLeft />
          </Button>
          <span className="min-w-24 text-center text-sm tabular-nums">
            {total ? `Página ${page} de ${total}` : "Cargando…"}
          </span>
          <Button variant="ghost" size="icon" className="size-8" onClick={() => setPage((p) => p + 1)} disabled={!total || page >= total} aria-label="Página siguiente">
            <ChevronRight />
          </Button>
        </div>
        {highlight && !rendering && (
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {matches > 0 ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block size-2.5 rounded-sm bg-yellow-300/80" /> Texto citado resaltado
              </span>
            ) : (
              "El texto citado no está en esta página"
            )}
          </span>
        )}
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-8" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} aria-label="Alejar">
            <Minus />
          </Button>
          <span className="w-12 text-center text-xs text-muted-foreground tabular-nums">{Math.round(zoom * 100)}%</span>
          <Button variant="ghost" size="icon" className="size-8" onClick={() => setZoom((z) => Math.min(3, z + 0.25))} aria-label="Acercar">
            <Plus />
          </Button>
        </div>
      </div>
      <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-auto bg-muted/50 p-4">
        {(rendering || !doc) && (
          <div className="absolute inset-0 z-10 grid place-items-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
        <div ref={pageRef} className="pdf-page relative mx-auto bg-white shadow-md" />
      </div>
    </div>
  );
}
