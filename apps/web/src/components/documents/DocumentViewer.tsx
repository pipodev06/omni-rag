import { createContext, lazy, Suspense, useCallback, useContext, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Layers, Loader2, MessageSquareText, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage, formatBytes, timeAgo, type DocumentInfo } from "@/api";
import { ExcerptMarkdown } from "@/components/chat/Answer";
import { pagesLabel } from "@/lib/format";
import { FileTypeIcon, StatusBadge } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// PDF.js pesa ~1 MB: solo se descarga al abrir un PDF.
const PdfViewer = lazy(() => import("./PdfViewer"));

export interface DocumentDetail extends DocumentInfo {
  summary: string | null;
  suggestedQuestions: string[];
  summaryModel: string | null;
  summaryAt: string | null;
}

interface Chunk {
  index: number;
  heading: string;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
}

type Tab = "view" | "summary" | "chunks";

interface OpenOptions {
  documentId: string;
  page?: number | null;
  highlight?: string;
  tab?: Tab;
}

const ViewerContext = createContext<(o: OpenOptions) => void>(() => {});

/** Abre el panel de un documento desde cualquier pantalla: `openDocument({ documentId, page, highlight })`. */
export const useOpenDocument = () => useContext(ViewerContext);

const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];
const extOf = (filename: string) => filename.split(".").pop()?.toLowerCase() ?? "";

export function DocumentViewerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(OpenOptions & { tab: Tab }) | null>(null);
  const open = useCallback((o: OpenOptions) => setState({ ...o, tab: o.tab ?? "view" }), []);
  return (
    <ViewerContext.Provider value={open}>
      {children}
      <DocumentSheet state={state} onTab={(tab) => setState((s) => (s ? { ...s, tab } : s))} onClose={() => setState(null)} />
    </ViewerContext.Provider>
  );
}

function SummaryTab({ doc, onLeave }: { doc: DocumentDetail; onLeave: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const generate = async () => {
    setBusy(true);
    try {
      await api.post(`/documents/${doc.id}/summary`);
      await qc.invalidateQueries({ queryKey: ["document", doc.id] });
      void qc.invalidateQueries({ queryKey: ["suggestions"] });
      toast.success("Resumen generado");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const ask = (q?: string) => {
    const params = new URLSearchParams({ documento: doc.id });
    if (q) params.set("q", q);
    onLeave(); // cerrar el panel para ver el chat
    navigate(`/chat?${params}`);
  };

  if (!doc.summary) {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
        <div className="grid size-11 place-items-center rounded-full bg-primary/10 text-primary">
          <Sparkles className="size-5" />
        </div>
        <div className="space-y-1">
          <p className="font-medium">Aún no hay resumen</p>
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            El asistente puede leer el documento y escribir un resumen con preguntas sugeridas. Usa una consulta del cupo diario.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => void generate()} disabled={busy || doc.status !== "ready"}>
            {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {busy ? "Leyendo el documento…" : "Generar resumen"}
          </Button>
          <Button variant="outline" onClick={() => ask()} disabled={doc.status !== "ready"}>
            <MessageSquareText /> Preguntar sobre este documento
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-5">
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Resumen</h3>
        <p className="text-[15px] leading-7">{doc.summary}</p>
        <p className="text-xs text-muted-foreground">
          Generado {doc.summaryAt && timeAgo(doc.summaryAt)}
          {doc.summaryModel && ` con ${doc.summaryModel}`} ·{" "}
          <button className="text-primary hover:underline disabled:opacity-50" onClick={() => void generate()} disabled={busy}>
            {busy ? "regenerando…" : "regenerar"}
          </button>
        </p>
      </section>
      {doc.suggestedQuestions.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Preguntas sugeridas</h3>
          <div className="grid gap-2">
            {doc.suggestedQuestions.map((q) => (
              <button
                key={q}
                onClick={() => ask(q)}
                className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2.5 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent"
              >
                <MessageSquareText className="size-4 shrink-0 text-primary" />
                {q}
              </button>
            ))}
          </div>
        </section>
      )}
      <Button variant="outline" onClick={() => ask()}>
        <MessageSquareText /> Hacer otra pregunta sobre este documento
      </Button>
    </div>
  );
}

function ChunksTab({ documentId, onOpenPage, paged }: { documentId: string; onOpenPage: (page: number, text: string) => void; paged: boolean }) {
  const { data, isLoading } = useQuery({
    queryKey: ["chunks", documentId],
    queryFn: () => api.get<{ chunks: Chunk[] }>(`/documents/${documentId}/chunks`),
  });
  return (
    <div className="space-y-3 p-4">
      <p className="text-xs text-muted-foreground">Así es como el sistema "lee" el documento al buscar: cada fragmento se indexa por separado.</p>
      {isLoading && <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />}
      {data?.chunks.map((c) => (
        <div key={c.index} className="rounded-lg border bg-card p-3">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">#{c.index + 1}</Badge>
            {pagesLabel(c) &&
              (paged && c.pageStart ? (
                <button onClick={() => onOpenPage(c.pageStart!, c.content)}>
                  <Badge variant="outline" className="hover:bg-accent">
                    {pagesLabel(c)} · ver
                  </Badge>
                </button>
              ) : (
                <Badge variant="outline">{pagesLabel(c)}</Badge>
              ))}
            {c.heading && <span className="truncate text-xs text-muted-foreground">{c.heading}</span>}
          </div>
          <ExcerptMarkdown text={c.content} />
        </div>
      ))}
    </div>
  );
}

function DocumentSheet({ state, onTab, onClose }: { state: (OpenOptions & { tab: Tab }) | null; onTab: (t: Tab) => void; onClose: () => void }) {
  const [override, setOverride] = useState<{ page: number; highlight: string } | null>(null);
  const id = state?.documentId;
  const { data, isLoading } = useQuery({
    queryKey: ["document", id],
    queryFn: () => api.get<{ document: DocumentDetail }>(`/documents/${id}`),
    enabled: !!id,
  });
  const doc = data?.document;
  const ext = doc ? extOf(doc.filename) : "";
  const fileUrl = id ? `/api/documents/${id}/file` : "";
  const page = override?.page ?? state?.page ?? 1;
  const highlight = override?.highlight ?? state?.highlight;

  return (
    <Sheet
      open={!!state}
      onOpenChange={(o) => {
        if (!o) {
          setOverride(null);
          onClose();
        }
      }}
    >
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl">
        <SheetHeader className="border-b pr-12">
          {doc ? (
            <div className="flex items-center gap-3">
              <FileTypeIcon filename={doc.filename} />
              <div className="min-w-0">
                <SheetTitle className="truncate">{doc.title}</SheetTitle>
                <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="truncate">{doc.filename}</span>
                  <span>· {formatBytes(doc.sizeBytes)}</span>
                  {doc.pageCount && <span>· {doc.pageCount} págs.</span>}
                  <StatusBadge status={doc.status} />
                </SheetDescription>
              </div>
              <Button variant="outline" size="sm" className="ml-auto shrink-0" asChild>
                <a href={fileUrl}>
                  <Download /> Descargar
                </a>
              </Button>
            </div>
          ) : (
            <>
              <SheetTitle>Documento</SheetTitle>
              <SheetDescription>{isLoading ? "Cargando…" : "No disponible"}</SheetDescription>
            </>
          )}
        </SheetHeader>

        {doc && state && (
          <Tabs value={state.tab} onValueChange={(v) => onTab(v as Tab)} className="flex min-h-0 flex-1 flex-col gap-0">
            <div className="border-b px-4 py-2">
              <TabsList>
                <TabsTrigger value="view">
                  <FileText /> Documento
                </TabsTrigger>
                <TabsTrigger value="summary">
                  <Sparkles /> Resumen
                </TabsTrigger>
                <TabsTrigger value="chunks">
                  <Layers /> Fragmentos
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="view" className="min-h-0 flex-1">
              {ext === "pdf" ? (
                <Suspense fallback={<Loader2 className="mx-auto mt-16 size-5 animate-spin text-muted-foreground" />}>
                  <PdfViewer url={fileUrl} initialPage={page ?? 1} highlight={highlight} />
                </Suspense>
              ) : IMAGE_EXT.includes(ext) ? (
                <div className="h-full overflow-auto bg-muted/50 p-4">
                  <img src={fileUrl} alt={doc.title} className="mx-auto max-w-full rounded shadow-md" />
                </div>
              ) : (
                <ScrollArea className="h-full">
                  <div className="space-y-3 p-4">
                    <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                      La vista previa está disponible para PDF e imágenes. Para este formato se muestra el texto extraído; descarga el original para verlo completo.
                    </p>
                    {highlight && (
                      <div className="rounded-lg border-2 border-yellow-300/70 bg-yellow-100/40 p-3 dark:bg-yellow-300/10">
                        <p className="mb-1 text-xs font-medium text-muted-foreground">Fragmento citado</p>
                        <ExcerptMarkdown text={highlight} />
                      </div>
                    )}
                    <ChunksTab documentId={doc.id} paged={false} onOpenPage={() => {}} />
                  </div>
                </ScrollArea>
              )}
            </TabsContent>
            <TabsContent value="summary" className="min-h-0 flex-1">
              <ScrollArea className="h-full">
                <SummaryTab
                  doc={doc}
                  onLeave={() => {
                    setOverride(null);
                    onClose();
                  }}
                />
              </ScrollArea>
            </TabsContent>
            <TabsContent value="chunks" className="min-h-0 flex-1">
              <ScrollArea className="h-full">
                <ChunksTab
                  documentId={doc.id}
                  paged={ext === "pdf"}
                  onOpenPage={(p, text) => {
                    setOverride({ page: p, highlight: text });
                    onTab("view");
                  }}
                />
              </ScrollArea>
            </TabsContent>
          </Tabs>
        )}
      </SheetContent>
    </Sheet>
  );
}
