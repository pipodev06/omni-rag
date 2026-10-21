import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, ChevronDown, Copy, Download, Eye, FileText } from "lucide-react";
import { toast } from "sonner";
import type { Source } from "@/api";
import { pagesLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Marca de cita [n] dentro del texto, clicable y con el nombre de la fuente al pasar el ratón. */
function CitationChip({ n, source, onClick }: { n: number; source?: Source; onClick: () => void }) {
  const chip = (
    <button
      type="button"
      onClick={onClick}
      className="relative -top-px mx-0.5 inline-flex h-[1.15rem] min-w-[1.15rem] items-center justify-center rounded-md bg-primary/10 px-1 align-middle text-[0.7rem] leading-none font-semibold text-primary no-underline transition-colors hover:bg-primary hover:text-primary-foreground"
    >
      {n}
    </button>
  );
  if (!source) return chip;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent>
        {source.documentTitle}
        {pagesLabel(source) && ` · ${pagesLabel(source)}`}
      </TooltipContent>
    </Tooltip>
  );
}

/** Texto Markdown de la respuesta con las citas convertidas en chips. */
export function AnswerMarkdown({ content, sources, onCite }: { content: string; sources: Source[]; onCite: (n: number) => void }) {
  const prepared = useMemo(
    () => content.replace(/\[(\d{1,2})\](?!\()/g, (m, d: string) => (sources.some((s) => s.n === Number(d)) ? `[${d}](#cite-${d})` : m)),
    [content, sources],
  );
  return (
    <div className="prose prose-zinc max-w-none text-[15px] leading-7 dark:prose-invert prose-p:my-3 prose-pre:bg-muted prose-pre:text-foreground prose-table:text-sm prose-th:px-3 prose-td:px-3">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith("#cite-")) {
              const n = Number(href.slice(6));
              return <CitationChip n={n} source={sources.find((s) => s.n === n)} onClick={() => onCite(n)} />;
            }
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
        }}
      >
        {prepared}
      </ReactMarkdown>
    </div>
  );
}

/** Fragmento de documento renderizado (tablas, listas, títulos) en tamaño compacto. */
export function ExcerptMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={cn(
        "prose prose-sm prose-zinc max-w-none text-muted-foreground dark:prose-invert prose-headings:my-2 prose-headings:text-sm prose-headings:font-semibold prose-headings:text-foreground prose-p:my-2 prose-table:my-2 prose-table:text-xs prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children }) => <span>{children}</span> }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Lista de fuentes: tarjetas compactas que se despliegan para ver el fragmento. */
export function SourcesList({ sources, active, onToggle, onOpen }: {
  sources: Source[];
  active: number | null;
  onToggle: (n: number) => void;
  /** Abre el documento en el visor, en la página de la fuente y con el texto resaltado. */
  onOpen?: (s: Source) => void;
}) {
  if (sources.length === 0) return null;
  const cited = sources.filter((s) => s.cited);
  const shown = cited.length > 0 ? cited : sources;
  const current = shown.find((s) => s.n === active);

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{cited.length > 0 ? "Fuentes citadas" : "Fuentes consultadas"}</p>
      <div className="flex flex-wrap gap-2">
        {shown.map((s) => (
          <button
            key={s.n}
            id={`source-${s.n}`}
            type="button"
            onClick={() => onToggle(s.n)}
            className={cn(
              "flex max-w-full items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 text-left text-xs transition-colors hover:border-primary/40 hover:bg-accent",
              active === s.n && "border-primary/50 bg-accent",
            )}
          >
            <span className="grid size-4.5 shrink-0 place-items-center rounded bg-primary/10 text-[0.65rem] font-semibold text-primary">{s.n}</span>
            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{s.documentTitle}</span>
            {pagesLabel(s) && <span className="shrink-0 text-muted-foreground">{pagesLabel(s)}</span>}
            <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", active === s.n && "rotate-180")} />
          </button>
        ))}
      </div>
      {current && (
        <div className="animate-in fade-in-0 slide-in-from-top-1 rounded-lg border bg-muted/40 p-3">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div className="min-w-0 text-xs">
              <p className="truncate font-medium">{current.documentTitle}</p>
              <p className="truncate text-muted-foreground">{[pagesLabel(current), current.heading].filter(Boolean).join(" · ")}</p>
            </div>
            <div className="flex shrink-0 gap-1">
              {onOpen && (
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => onOpen(current)}>
                  <Eye /> Ver en el documento
                </Button>
              )}
              <Button variant="ghost" size="sm" className="h-7 text-xs" asChild>
                <a href={`/api/documents/${current.documentId}/file`}>
                  <Download /> Original
                </a>
              </Button>
            </div>
          </div>
          <ExcerptMarkdown text={current.excerpt} className="max-h-64 overflow-y-auto" />
        </div>
      )}
    </div>
  );
}

/** Botón para copiar la respuesta. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("No se pudo copiar");
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={copy} aria-label="Copiar respuesta">
          {copied ? <Check className="text-success" /> : <Copy />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copiado" : "Copiar"}</TooltipContent>
    </Tooltip>
  );
}
