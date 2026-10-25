import { useRef, type KeyboardEvent, type RefObject } from "react";
import { ArrowUp, Globe, ListFilter, Square, X } from "lucide-react";
import type { Collection } from "@/api";
import { FileTypeIcon } from "@/components/common";
import { nextHistoryIndex } from "@/lib/promptHistory";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

function CollectionFilter({ collections, selected, onChange }: { collections: Collection[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const selectedSet = new Set(selected);
  const label =
    selected.length === 0
      ? "Todas las colecciones"
      : selected.length === 1
        ? (collections.find((c) => c.id === selected[0])?.name ?? "1 colección")
        : `${selected.length} colecciones`;
  const toggle = (id: string) => onChange(selectedSet.has(id) ? selected.filter((c) => c !== id) : [...selected, id]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 max-w-[60%] text-xs text-muted-foreground">
          <ListFilter />
          <span className="truncate">{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Buscar en</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {collections.map((c) => (
          <DropdownMenuCheckboxItem key={c.id} checked={selectedSet.has(c.id)} onCheckedChange={() => toggle(c.id)} onSelect={(e) => e.preventDefault()}>
            <span className="truncate">{c.name}</span>
            <span className="ml-auto text-xs text-muted-foreground">{c.documentCount}</span>
          </DropdownMenuCheckboxItem>
        ))}
        {selected.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange([])}>Todas las colecciones</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DocumentFilterChip({ title, filename, onOpen, onClear }: { title?: string; filename?: string; onOpen: () => void; onClear: () => void }) {
  return (
    <div className="mb-2 flex items-center gap-2 rounded-xl border bg-accent/60 px-3 py-2 text-sm">
      <FileTypeIcon filename={filename ?? ""} className="size-7" />
      <span className="min-w-0 flex-1 truncate">
        Preguntando solo sobre <b className="font-medium">«{title ?? "…"}»</b>
      </span>
      <Button variant="ghost" size="sm" className="h-7" onClick={onOpen}>
        Abrir
      </Button>
      <Button variant="ghost" size="icon" className="size-7" onClick={onClear} aria-label="Quitar filtro de documento">
        <X />
      </Button>
    </div>
  );
}

/** Activa la búsqueda en internet para las próximas preguntas. Solo se envía la pregunta, nunca los documentos. */
function WebSearchToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={on}
          onClick={() => onChange(!on)}
          className={cn("h-8 gap-1.5 text-xs", on ? "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary" : "text-muted-foreground")}
        >
          <Globe className="size-3.5" /> Internet
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {on ? "Buscando también en internet. " : "Buscar también en internet. "}
        Solo se envía tu pregunta al buscador, nunca tus documentos. Las fuentes de internet se marcan aparte.
      </TooltipContent>
    </Tooltip>
  );
}

/** Caja de texto del chat con filtros (colecciones / documento) y enviar / detener. */
export function Composer(props: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  collections: Collection[];
  selectedCollections: string[];
  onSelectedCollections: (ids: string[]) => void;
  documentFilter: { title?: string; filename?: string } | null;
  onOpenDocument: () => void;
  onClearDocument: () => void;
  /** Preguntas anteriores, de la más antigua a la más reciente, para recuperarlas con ↑ y ↓. */
  history: string[];
  /** Interruptor «Buscar también en internet»; null si el plan no lo permite o no hay buscador en el servidor. */
  webSearch: { on: boolean; onChange: (on: boolean) => void } | null;
}) {
  // Posición en el historial (null = escribiendo un texto propio) y el borrador que se tenía antes de pulsar ↑.
  // Solo la leen los manejadores de teclado: un ref basta y no provoca renders.
  const histIndex = useRef<number | null>(null);
  const draft = useRef("");

  const showHistory = (index: number | null) => {
    histIndex.current = index;
    const text = index === null ? draft.current : (props.history[index] ?? "");
    props.onChange(text);
    requestAnimationFrame(() => props.textareaRef.current?.setSelectionRange(text.length, text.length));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      props.onSend();
      return;
    }
    // ↑ / ↓ recorren las preguntas anteriores, pero solo si el cursor está en la primera / última línea: en un texto de
    // varias líneas siguen moviendo el cursor como siempre.
    if ((e.key !== "ArrowUp" && e.key !== "ArrowDown") || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    const el = e.currentTarget;
    if (el.selectionStart !== el.selectionEnd || props.history.length === 0) return;
    // Si el texto ya no es el recuperado (se envió o se borró), se vuelve a escribir un texto propio.
    if (histIndex.current !== null && props.value !== props.history[histIndex.current]) histIndex.current = null;
    const index = histIndex.current;
    if (e.key === "ArrowUp") {
      const firstLine = !el.value.slice(0, el.selectionStart).includes("\n");
      if (firstLine && (props.value === "" || index !== null || el.selectionStart === 0)) {
        e.preventDefault();
        if (index === null) draft.current = props.value;
        showHistory(nextHistoryIndex(props.history.length, index, "up"));
      }
    } else if (index !== null && !el.value.slice(el.selectionEnd).includes("\n")) {
      e.preventDefault();
      showHistory(nextHistoryIndex(props.history.length, index, "down"));
    }
  };

  return (
    <div className="shrink-0 px-4 pb-4 sm:px-6">
      <div className="mx-auto w-full max-w-3xl">
        {props.documentFilter && (
          <DocumentFilterChip {...props.documentFilter} onOpen={props.onOpenDocument} onClear={props.onClearDocument} />
        )}
        <div className="rounded-2xl border bg-card shadow-sm transition-colors focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-ring/20">
          {/* field-sizing-content: el cuadro crece con el texto sin JavaScript (hasta 200 px). */}
          <Textarea
            ref={props.textareaRef}
            value={props.value}
            onChange={(e) => {
              props.onChange(e.target.value);
              histIndex.current = null; // si edita lo recuperado, deja de recorrer el historial
            }}
            onKeyDown={onKeyDown}
            placeholder="Escribe tu pregunta…"
            rows={1}
            maxLength={4000}
            className="field-sizing-content max-h-[200px] min-h-[52px] resize-none border-0 bg-transparent px-4 py-3.5 text-[15px] shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            <div className="flex min-w-0 items-center gap-1">
              {props.collections.length > 1 && (
                <CollectionFilter collections={props.collections} selected={props.selectedCollections} onChange={props.onSelectedCollections} />
              )}
              {props.webSearch && <WebSearchToggle {...props.webSearch} />}
            </div>
            {props.busy ? (
              <Button size="icon" variant="secondary" className="size-8 rounded-full" onClick={props.onStop} aria-label="Detener">
                <Square className="size-3.5 fill-current" />
              </Button>
            ) : (
              <Button size="icon" className="size-8 rounded-full" disabled={!props.value.trim()} onClick={props.onSend} aria-label="Enviar">
                <ArrowUp />
              </Button>
            )}
          </div>
        </div>
        <p className="mt-2 text-center text-[11px] text-muted-foreground">
          Las respuestas pueden contener errores. Comprueba las fuentes citadas. · Enter para enviar, Shift+Enter para nueva línea
        </p>
      </div>
    </div>
  );
}
