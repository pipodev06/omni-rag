import { Loader2, Sparkles, TriangleAlert, Zap } from "lucide-react";
import type { Message, Source } from "@/api";
import { AnswerMarkdown, CopyButton, SourcesList } from "@/components/chat/Answer";
import { FeedbackButtons } from "@/components/chat/Feedback";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function UserMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-[15px] whitespace-pre-wrap text-primary-foreground">
        {content}
      </div>
    </div>
  );
}

function CachedBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px]">
          <Zap className="size-3" /> Respuesta guardada
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        Esta pregunta ya se había respondido con los mismos documentos, así que se reutilizó la respuesta sin consumir cupo. Si no es correcta,
        márcala con 👎.
      </TooltipContent>
    </Tooltip>
  );
}

function Pending({ hasSources }: { hasSources: boolean }) {
  return (
    <div className="flex items-center gap-2 pt-1 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {hasSources ? "Redactando la respuesta…" : "Buscando en los documentos…"}
    </div>
  );
}

/** Respuesta del asistente: texto con citas, fuentes y acciones (copiar, valorar). */
export function AssistantMessage({
  message: m,
  domId,
  streaming,
  activeSource,
  onCite,
  onOpenSource,
  onFeedback,
}: {
  message: Message;
  domId: string;
  streaming: boolean;
  activeSource: number | null;
  onCite: (n: number) => void;
  onOpenSource: (s: Source) => void;
  onFeedback: (v: 1 | -1 | null) => void;
}) {
  const showActions = !!m.content && !streaming;
  return (
    <div id={domId} className="flex gap-3">
      <div className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
        <Sparkles className="size-4" />
      </div>
      <div className="min-w-0 flex-1 space-y-4">
        {m.content && <AnswerMarkdown content={m.content} sources={m.sources} onCite={onCite} />}
        {!m.content && !m.error && <Pending hasSources={m.sources.length > 0} />}
        {m.error && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            {m.error}
          </div>
        )}
        <SourcesList sources={m.sources} active={activeSource} onToggle={onCite} onOpen={onOpenSource} />
        {showActions && (
          <div className="flex flex-wrap items-center gap-0.5 text-xs text-muted-foreground">
            <CopyButton text={m.content} />
            {m.id && m.sources.length > 0 && <FeedbackButtons messageId={m.id} value={m.feedback} onChange={onFeedback} />}
            {m.fromCache && <CachedBadge />}
            {m.model && <span className="ml-1">{m.model}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
