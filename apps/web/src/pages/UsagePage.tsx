import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, Files, Layers, MessagesSquare, Users, Zap, type LucideIcon } from "lucide-react";
import { api } from "@/api";
import { cn } from "@/lib/utils";
import { Page, PageHeader } from "@/components/common";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface Usage {
  daily: { day: string; questions: number; cacheHits: number; promptTokens: number; completionTokens: number }[];
  byModel: { model: string; questions: number }[];
  totals: { documents: number; chunks: number; users: number };
  plan: { name: string; dailyQuestionLimit: number; maxUsers: number | null; maxDocuments: number | null; usedToday: number };
}

const nf = new Intl.NumberFormat("es");
const dayLabel = (iso: string, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("es", { ...opts, timeZone: "UTC" });

/** Barra de uso frente al tope del plan. `max` null/0 = sin tope. */
function PlanMeter({ label, used, max }: { label: string; used: number; max: number | null }) {
  const limited = max !== null && max > 0;
  const pct = limited ? Math.min(100, (used / max) * 100) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">
          {nf.format(used)}
          <span className="text-muted-foreground"> / {limited ? nf.format(max) : "sin tope"}</span>
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", pct >= 90 ? "bg-destructive" : "bg-primary")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function StatTile({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: number }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="size-4" />
        {label}
      </div>
      <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">{nf.format(value)}</p>
    </div>
  );
}

/** Últimos 30 días, rellenando con 0 los días sin preguntas. */
function last30(daily: Usage["daily"]) {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const out: Usage["daily"] = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    out.push(byDay.get(key) ?? { day: key, questions: 0, cacheHits: 0, promptTokens: 0, completionTokens: 0 });
  }
  return out;
}

/** Gráfico de barras de una sola serie (preguntas por día) con tooltip al pasar el ratón. */
function DailyChart({ days }: { days: Usage["daily"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((d) => d.questions));
  const h = days[hover ?? -1];

  return (
    <div className="relative">
      <div className="mb-1 flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>{nf.format(max)}</span>
      </div>
      <div className="relative flex h-48 items-end gap-[2px] border-b border-border" onMouseLeave={() => setHover(null)}>
        {/* Línea de referencia del máximo, discreta */}
        <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-border" />
        {days.map((d, i) => (
          <div
            key={d.day}
            className="group relative flex h-full flex-1 items-end"
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            tabIndex={0}
            aria-label={`${dayLabel(d.day)}: ${d.questions} preguntas`}
          >
            <div
              className="w-full rounded-t-[4px] bg-primary transition-opacity"
              style={{ height: `${(d.questions / max) * 100}%`, minHeight: d.questions ? 2 : 0, opacity: hover === null || hover === i ? 1 : 0.45 }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-xs text-muted-foreground">
        <span>{dayLabel(days[0]!.day)}</span>
        <span>{dayLabel(days[14]!.day)}</span>
        <span>Hoy</span>
      </div>
      {h && (
        <div
          className={cn(
            "pointer-events-none absolute top-0 z-10 rounded-lg border bg-popover px-3 py-2 text-xs whitespace-nowrap shadow-md",
            hover! < days.length / 3 ? "translate-x-0" : hover! > (days.length * 2) / 3 ? "-translate-x-full" : "-translate-x-1/2",
          )}
          style={{ left: `${((hover! + 0.5) / days.length) * 100}%` }}
        >
          <p className="font-medium">{dayLabel(h.day, { weekday: "short", day: "numeric", month: "long" })}</p>
          <p className="mt-1 text-muted-foreground">
            <span className="font-semibold text-foreground tabular-nums">{nf.format(h.questions)}</span> preguntas
          </p>
          {h.cacheHits > 0 && (
            <p className="text-muted-foreground tabular-nums">+ {nf.format(h.cacheHits)} desde caché (sin LLM)</p>
          )}
          {h.questions > 0 && (
            <p className="text-muted-foreground tabular-nums">
              {nf.format(h.promptTokens)} tokens entrada · {nf.format(h.completionTokens)} salida
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function UsagePage() {
  const { data, isLoading } = useQuery({ queryKey: ["usage"], queryFn: () => api.get<Usage>("/usage") });
  const days = useMemo(() => (data ? last30(data.daily) : []), [data]);

  if (isLoading || !data) {
    return (
      <Page>
        <Skeleton className="mb-6 h-8 w-48" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      </Page>
    );
  }

  const totalQuestions = data.daily.reduce((n, d) => n + d.questions, 0);
  const maxModel = Math.max(1, ...data.byModel.map((m) => m.questions));

  return (
    <Page>
      <PageHeader title="Consumo" description="Actividad de la organización en los últimos 30 días. Los días se calculan en UTC." />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile icon={MessagesSquare} label="Preguntas al LLM (30 días)" value={totalQuestions} />
        <StatTile icon={Zap} label="Desde caché (30 días)" value={data.daily.reduce((n, d) => n + d.cacheHits, 0)} />
        <StatTile icon={Files} label="Documentos" value={data.totals.documents} />
        <StatTile icon={Layers} label="Fragmentos indexados" value={data.totals.chunks} />
        <StatTile icon={Users} label="Usuarios" value={data.totals.users} />
      </div>

      <section className="mt-6 rounded-xl border bg-card p-5">
        <h2 className="mb-4 font-medium">
          Plan {data.plan.name} <span className="text-sm font-normal text-muted-foreground">· el uso de hoy se reinicia a las 00:00 UTC</span>
        </h2>
        <div className="grid gap-5 sm:grid-cols-3">
          <PlanMeter label="Preguntas hoy" used={data.plan.usedToday} max={data.plan.dailyQuestionLimit} />
          <PlanMeter label="Usuarios activos" used={data.totals.users} max={data.plan.maxUsers} />
          <PlanMeter label="Documentos" used={data.totals.documents} max={data.plan.maxDocuments} />
        </div>
      </section>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <section className="rounded-xl border bg-card p-5 lg:col-span-2">
          <Tabs defaultValue="chart">
            <div className="mb-4 flex items-center justify-between gap-2">
              <h2 className="font-medium">Preguntas por día</h2>
              <TabsList className="h-8">
                <TabsTrigger value="chart" className="text-xs">Gráfico</TabsTrigger>
                <TabsTrigger value="table" className="text-xs">Tabla</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="chart">
              {totalQuestions === 0 ? (
                <p className="py-16 text-center text-sm text-muted-foreground">Todavía no hay preguntas en este periodo.</p>
              ) : (
                <DailyChart days={days} />
              )}
            </TabsContent>
            <TabsContent value="table">
              <div className="max-h-72 overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Día</TableHead>
                      <TableHead className="text-right">Preguntas</TableHead>
                      <TableHead className="text-right">Desde caché</TableHead>
                      <TableHead className="text-right">Tokens entrada</TableHead>
                      <TableHead className="text-right">Tokens salida</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...days].reverse().filter((d) => d.questions > 0 || d.cacheHits > 0).map((d) => (
                      <TableRow key={d.day}>
                        <TableCell>{dayLabel(d.day, { weekday: "short", day: "numeric", month: "short" })}</TableCell>
                        <TableCell className="text-right tabular-nums">{nf.format(d.questions)}</TableCell>
                        <TableCell className="text-right tabular-nums">{nf.format(d.cacheHits)}</TableCell>
                        <TableCell className="text-right tabular-nums">{nf.format(d.promptTokens)}</TableCell>
                        <TableCell className="text-right tabular-nums">{nf.format(d.completionTokens)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
          </Tabs>
        </section>

        <section className="rounded-xl border bg-card p-5">
          <h2 className="mb-4 font-medium">Modelos usados</h2>
          {data.byModel.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Sin datos.</p>
          ) : (
            <ul className="space-y-3">
              {data.byModel.map((m) => (
                <li key={m.model} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Bot className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate" title={m.model}>{m.model}</span>
                    </span>
                    <span className="text-muted-foreground tabular-nums">{nf.format(m.questions)}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${(m.questions / maxModel) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Page>
  );
}
