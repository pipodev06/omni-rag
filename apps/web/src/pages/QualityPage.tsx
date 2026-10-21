import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleCheck, Inbox, MessageSquareQuote, RotateCcw, ThumbsDown, ThumbsUp, Trash2, Zap, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage, timeAgo, type Source } from "@/api";
import { cn } from "@/lib/utils";
import { EmptyState, Page, PageHeader } from "@/components/common";
import { useConfirm } from "@/components/ConfirmProvider";
import { AnswerMarkdown } from "@/components/chat/Answer";
import { pagesLabel } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface FeedbackItem {
  id: string;
  rating: 1 | -1;
  comment: string;
  question: string;
  answer: string;
  sources: Source[];
  model: string | null;
  fromCache: boolean;
  resolved: boolean;
  createdAt: string;
  userName: string;
  userEmail: string;
}

interface Quality {
  summary: { positive: number; negative: number; pendingNegative: number };
  usage: { questions: number; cacheHits: number };
  cache: { entries: number };
  items: FeedbackItem[];
}

type Filter = "pending" | "negative" | "positive" | "all";

const FILTERS: Record<Filter, string> = {
  pending: "rating=-1&status=pending",
  negative: "rating=-1&status=all",
  positive: "rating=1&status=all",
  all: "status=all",
};

const nf = new Intl.NumberFormat("es");

function Tile({ icon: Icon, label, value, hint, className }: { icon: LucideIcon; label: string; value: string; hint?: string; className?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className={cn("size-4", className)} />
        {label}
      </div>
      <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function FeedbackCard({ item, onResolve }: { item: FeedbackItem; onResolve: (resolved: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const cited = item.sources.filter((s) => s.cited);
  return (
    <div className={cn("rounded-xl border bg-card p-4", item.resolved && "opacity-60")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-full",
              item.rating === 1 ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive",
            )}
          >
            {item.rating === 1 ? <ThumbsUp className="size-4" /> : <ThumbsDown className="size-4" />}
          </div>
          <div className="min-w-0">
            <p className="font-medium">{item.question || "(pregunta no disponible)"}</p>
            <p className="text-xs text-muted-foreground">
              {item.userName} · {timeAgo(item.createdAt)}
              {item.model && ` · ${item.model}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {item.fromCache && (
            <Badge variant="outline" className="gap-1">
              <Zap className="size-3" /> Desde caché
            </Badge>
          )}
          {item.rating === -1 &&
            (item.resolved ? (
              <Button variant="ghost" size="sm" onClick={() => onResolve(false)}>
                <RotateCcw /> Reabrir
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => onResolve(true)}>
                <Check /> Marcar revisada
              </Button>
            ))}
        </div>
      </div>

      {item.comment && (
        <div className="mt-3 flex gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm">
          <MessageSquareQuote className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p>{item.comment}</p>
        </div>
      )}

      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button className="mt-3 text-sm font-medium text-primary hover:underline">{open ? "Ocultar respuesta" : "Ver respuesta y fuentes"}</button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 space-y-3 border-t pt-3">
          <AnswerMarkdown content={item.answer} sources={item.sources} onCite={() => {}} />
          {cited.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {cited.map((s) => (
                <Badge key={s.n} variant="secondary" className="font-normal">
                  [{s.n}] {s.documentTitle}
                  {pagesLabel(s) && ` · ${pagesLabel(s)}`}
                </Badge>
              ))}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/** Indicadores: satisfacción, pendientes, uso de la caché. */
function QualityStats({ data }: { data: Quality | undefined }) {
  if (!data) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    );
  }
  const s = data.summary;
  const rated = s.positive + s.negative;
  const satisfaction = rated ? `${Math.round((s.positive / rated) * 100)} %` : "—";
  const answered = data.usage.questions + data.usage.cacheHits;
  const cacheRate = answered ? `${Math.round((data.usage.cacheHits / answered) * 100)} %` : "—";
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile icon={ThumbsUp} label="Satisfacción" value={satisfaction} hint={`${s.positive} 👍 · ${s.negative} 👎`} className="text-success" />
      <Tile icon={ThumbsDown} label="Pendientes de revisar" value={nf.format(s.pendingNegative)} hint="Respuestas con 👎 sin revisar" className="text-destructive" />
      <Tile icon={Zap} label="Respondidas desde caché" value={cacheRate} hint={`${nf.format(data.usage.cacheHits)} de ${nf.format(answered)} respuestas, sin gastar cupo`} />
      <Tile icon={CircleCheck} label="Respuestas en caché" value={nf.format(data.cache.entries)} hint="Se borran al cambiar los documentos" />
    </div>
  );
}

/** Lista de valoraciones, o su estado de carga / vacío. */
function FeedbackList({ loading, items, filter, onResolve }: {
  loading: boolean;
  items: FeedbackItem[];
  filter: Filter;
  onResolve: (item: FeedbackItem, resolved: boolean) => void;
}) {
  if (loading) return <Skeleton className="h-32 w-full" />;
  if (items.length === 0) {
    return (
      <EmptyState
        icon={filter === "pending" ? CircleCheck : Inbox}
        title={filter === "pending" ? "Todo revisado" : "Sin valoraciones"}
        description={filter === "pending" ? "No hay respuestas con 👎 pendientes de revisar." : "Cuando los usuarios valoren respuestas, aparecerán aquí."}
      />
    );
  }
  return (
    <>
      {items.map((item) => (
        <FeedbackCard key={item.id} item={item} onResolve={(r) => onResolve(item, r)} />
      ))}
    </>
  );
}

export function QualityPage() {
  const [filter, setFilter] = useState<Filter>("pending");
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data, isLoading } = useQuery({
    queryKey: ["quality", filter],
    queryFn: () => api.get<Quality>(`/quality?${FILTERS[filter]}`),
  });

  const resolve = async (item: FeedbackItem, resolved: boolean) => {
    try {
      await api.patch(`/quality/feedback/${item.id}`, { resolved });
      void qc.invalidateQueries({ queryKey: ["quality"] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const clearCache = async () => {
    const ok = await confirm({
      title: "¿Vaciar la caché de respuestas?",
      description: "Las próximas preguntas se responderán de nuevo con el LLM (consumen cupo). Úsalo si cambiaste el modelo o las instrucciones.",
      confirmText: "Vaciar caché",
    });
    if (!ok) return;
    try {
      const r = await api.del<{ deleted: number }>("/quality/cache");
      toast.success(`Caché vaciada (${r.deleted} respuestas)`);
      void qc.invalidateQueries({ queryKey: ["quality"] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Page>
      <PageHeader
        title="Calidad"
        description="Valoraciones de los usuarios y uso de la caché en los últimos 30 días. Revisa las respuestas con 👎 para detectar documentos que faltan o están mal."
        actions={
          <Button variant="outline" onClick={() => void clearCache()}>
            <Trash2 /> Vaciar caché
          </Button>
        }
      />

      <QualityStats data={data} />

      <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)} className="mt-6">
        <TabsList>
          <TabsTrigger value="pending">Pendientes</TabsTrigger>
          <TabsTrigger value="negative">Negativas</TabsTrigger>
          <TabsTrigger value="positive">Positivas</TabsTrigger>
          <TabsTrigger value="all">Todas</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="mt-4 space-y-3">
        <FeedbackList loading={isLoading} items={data?.items ?? []} filter={filter} onResolve={(item, r) => void resolve(item, r)} />
      </div>
    </Page>
  );
}
