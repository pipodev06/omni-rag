import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Activity, BellRing, Cpu, HardDrive, MemoryStick, Server, type LucideIcon } from "lucide-react";
import { api, formatBytes, formatDate, timeAgo } from "@/api";
import { cn } from "@/lib/utils";
import type { ChartSpec } from "@/lib/chartSpec";
import { ChartFigure } from "@/components/chat/ChartBlock";
import { EmptyState, Page, PageHeader, TableCard } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface Container {
  name: string;
  own: boolean;
  image: string;
  state: string;
  health: string | null;
  cpuCores: number;
  cpuLimit: number | null;
  cpuShares: number | null;
  memBytes: number;
  memLimit: number | null;
  restarts: number | null;
  oomKilled: boolean;
  memPeak24h: number | null;
  memPeak7d: number | null;
  cpuAvg24h: number | null;
  cpuP95_24h: number | null;
  cpuMax24h: number | null;
  historyHours: number;
  alerts: string[];
}

interface Resources {
  collecting: boolean;
  sampledAt: string | null;
  host: { cpus: number; memBytes: number; dockerVersion: string; os: string; kernel: string; arch: string } | null;
  stack: {
    node: string;
    postgres: string | null;
    pgvector: string | null;
    embeddingModel: string;
    rerankerModel: string | null;
    llmProviders: string[];
    antivirus: boolean;
    webSearch: string | null;
  };
  autotune: { service: string; cpus: string | null; memLimit: string | null; cpuShares: string | null }[];
  containers: Container[];
}

interface Alerts {
  open: { key: string; since: string; message: string }[];
  events: { id: number; at: string; key: string; event: "opened" | "reminded" | "resolved"; message: string }[];
}

const TONE = {
  bad: "text-destructive bg-destructive/10 border-destructive/20",
  warn: "text-warning bg-warning/10 border-warning/20",
  ok: "text-success bg-success/10 border-success/20",
  muted: "text-muted-foreground",
} as const;

function Tag({ tone, children, title }: { tone: keyof typeof TONE; children: string; title?: string }) {
  return (
    <Badge variant="outline" className={cn("font-medium", TONE[tone])} title={title}>
      {children}
    </Badge>
  );
}

const cores = (n: number) => n.toLocaleString("es", { maximumFractionDigits: 2, minimumFractionDigits: n < 10 ? 2 : 0 });

const SIGNALS: Record<string, string> = { mem: "RAM al límite", cpu: "CPU al límite", restart: "Se reinició", health: "No responde" };
const CHECKS: Record<string, string> = { disk: "Disco", queue: "Cola de documentos", backup: "Copias de seguridad", llm: "Modelo de lenguaje", metrics: "Métricas" };

/** «container:api:mem» → { source: "api", label: "RAM al límite" }; «disk» → { source: "Disco", … }. */
function describeKey(key: string): { source: string; label: string } {
  const [kind, name, signal] = key.split(":");
  if (kind === "container" && name) return { source: name, label: SIGNALS[signal ?? ""] ?? signal ?? "" };
  return { source: CHECKS[key] ?? key, label: "" };
}

/** Lectura de los datos para contrastar con el autotune: ¿el tope se queda corto, sobra o está bien? */
function diagnose(c: Container): { tone: keyof typeof TONE; label: string; title?: string }[] {
  if (c.state !== "running") return [{ tone: "bad", label: c.state === "exited" ? "Parado" : c.state }];
  const out: { tone: keyof typeof TONE; label: string; title?: string }[] = c.alerts.map((a) => ({ tone: "bad", label: SIGNALS[a] ?? a }));
  if (c.oomKilled && !c.alerts.includes("restart")) out.push({ tone: "bad", label: "Murió por falta de RAM" });
  const memRatio = c.memLimit && c.memPeak7d ? c.memPeak7d / c.memLimit : null;
  const cpuRatio = c.cpuLimit && c.cpuP95_24h !== null ? c.cpuP95_24h / c.cpuLimit : null;
  if (memRatio !== null && memRatio >= 0.85 && !c.alerts.includes("mem")) out.push({ tone: "warn", label: "RAM justa", title: "El pico de 7 días pasa del 85 % del tope" });
  if (cpuRatio !== null && cpuRatio >= 0.85 && !c.alerts.includes("cpu")) out.push({ tone: "warn", label: "CPU justa", title: "El 5 % del tiempo de las últimas 24 h usó más del 85 % de su tope" });
  const enoughHistory = c.historyHours >= 24;
  if (enoughHistory && memRatio !== null && memRatio < 0.35) out.push({ tone: "muted", label: "Le sobra RAM", title: "Su pico de 7 días no llega al 35 % del tope: se le puede bajar" });
  if (out.length === 0) out.push(c.own && !c.memLimit && !c.cpuLimit ? { tone: "muted", label: "Sin tope" } : { tone: "ok", label: "Bien" });
  if (!enoughHistory) out.push({ tone: "muted", label: `${c.historyHours} h de datos`, title: "Con menos de 24 h de muestras el diagnóstico aún no es fiable" });
  return out;
}

/** «3g», «3072m», «1.5» → bytes o núcleos, para comparar lo que fijó el autotune con lo que aplica Docker. */
function parseMem(v: string | null): number | null {
  const m = v?.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([bkmg]?)b?$/);
  if (!m) return null;
  const n = Number(m[1]) * { "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2] as "" | "b" | "k" | "m" | "g"];
  return n > 0 ? n : null;
}

function AutotuneCell({ c, autotune }: { c: Container; autotune: Resources["autotune"] }) {
  const a = autotune.find((x) => x.service === c.name);
  if (!c.own || !a) return <span className="text-muted-foreground">—</span>;
  const memWanted = parseMem(a.memLimit);
  const cpuWanted = a.cpus && Number(a.cpus) > 0 ? Number(a.cpus) : null;
  const sharesWanted = a.cpuShares && Number(a.cpuShares) > 0 ? Number(a.cpuShares) : null;
  const parts = [cpuWanted && `${cpuWanted} núcl.`, memWanted && formatBytes(memWanted), sharesWanted && `peso ${sharesWanted}`].filter(Boolean);
  if (parts.length === 0) return <span className="text-muted-foreground">Sin ajustar</span>;
  // Si el .env dice otra cosa que lo aplicado, falta recrear el contenedor (docker compose up -d).
  const off =
    (memWanted !== null && Math.abs(memWanted - (c.memLimit ?? 0)) > memWanted * 0.01) ||
    (cpuWanted !== null && Math.abs(cpuWanted - (c.cpuLimit ?? 0)) > 0.01) ||
    (sharesWanted !== null && sharesWanted !== c.cpuShares);
  return (
    <span className="flex flex-col gap-1">
      <span className="font-mono text-xs">{parts.join(" · ")}</span>
      {off && <Tag tone="warn" title="El .env pide otros topes que los aplicados: recrea el contenedor con «docker compose up -d»">Sin aplicar</Tag>}
    </span>
  );
}

/** Uso frente a tope: barra con el pico y el valor actual en texto. */
function UsageCell({ now, peak, limit, format, peakLabel }: { now: number; peak: number | null; limit: number | null; format: (n: number) => string; peakLabel: string }) {
  const pct = limit && peak !== null ? Math.min(100, (peak / limit) * 100) : null;
  return (
    <div className="min-w-40 space-y-1">
      <div className="flex items-baseline justify-between gap-2 font-mono text-xs tabular-nums">
        <span>{format(now)}</span>
        <span className="text-muted-foreground">/ {limit ? format(limit) : "sin tope"}</span>
      </div>
      {pct !== null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" title={`${peakLabel}: ${format(peak!)} (${Math.round(pct)} % del tope)`}>
          <div className={cn("h-full rounded-full", pct >= 90 ? "bg-destructive" : pct >= 75 ? "bg-warning" : "bg-primary")} style={{ width: `${pct}%` }} />
        </div>
      )}
      {peak !== null && (
        <p className="font-mono text-xs text-muted-foreground tabular-nums">
          {peakLabel}: {format(peak)}
        </p>
      )}
    </div>
  );
}

function Tile({ icon: Icon, label, value, hint }: { icon: LucideIcon; label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="size-4" /> {label}
      </div>
      <p className="mt-1 font-mono text-xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function NotCollecting({ collecting }: { collecting: boolean }) {
  return (
    <EmptyState
      icon={Activity}
      title={collecting ? "Aún no hay muestras" : "Las métricas están desactivadas"}
      description={
        collecting
          ? "El worker toma una muestra por minuto. Si no aparece nada en unos minutos, revisa «docker compose logs docker-proxy worker»."
          : "Falta DOCKER_PROXY_URL o el servicio docker-proxy. Con la configuración por defecto se activan solos al recrear los contenedores («docker compose up -d»)."
      }
    />
  );
}

function ResourcesTab() {
  const { data, isLoading } = useQuery({ queryKey: ["system", "resources"], queryFn: () => api.get<Resources>("/system/resources"), refetchInterval: 60_000 });
  if (isLoading || !data) return <Skeleton className="h-64 w-full" />;
  const own = data.containers.filter((c) => c.own);
  const memAssigned = own.reduce((s, c) => s + (c.memLimit ?? 0), 0);
  const unlimited = own.filter((c) => !c.memLimit).length;
  const memUsed = data.containers.reduce((s, c) => s + c.memBytes, 0);
  const cpuUsed = data.containers.reduce((s, c) => s + c.cpuCores, 0);
  const st = data.stack;
  const stack = [
    ["Node.js", st.node],
    ["PostgreSQL", st.postgres],
    ["pgvector", st.pgvector],
    ["Embeddings", st.embeddingModel],
    ["Re-ranker", st.rerankerModel ?? "desactivado"],
    ["Modelos de lenguaje", st.llmProviders.join(", ") || "ninguno"],
    ["Antivirus", st.antivirus ? "ClamAV" : "desactivado"],
    ["Internet", st.webSearch ?? "desactivado"],
    ...(data.host ? [["Docker", `${data.host.dockerVersion} · ${data.host.os} · ${data.host.arch}`]] : []),
  ] as const;

  return (
    <>
      <div className="mb-4 grid shrink-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile icon={Server} label="Servidor" value={data.host ? `${formatBytes(data.host.memBytes)} · ${data.host.cpus} núcl.` : "—"} hint={data.host ? `Kernel ${data.host.kernel}` : undefined} />
        <Tile icon={MemoryStick} label="RAM con tope (Omni RAG)" value={formatBytes(memAssigned)} hint={`${data.host ? `${Math.round((memAssigned / data.host.memBytes) * 100)} % del servidor · ` : ""}${unlimited} contenedor(es) sin tope`} />
        <Tile icon={HardDrive} label="RAM en uso (todo el servidor)" value={formatBytes(memUsed)} hint={data.host ? `${Math.round((memUsed / data.host.memBytes) * 100)} % del total` : undefined} />
        <Tile icon={Cpu} label="CPU en uso" value={`${cores(cpuUsed)} núcl.`} hint={data.sampledAt ? `Muestra ${timeAgo(data.sampledAt)}` : undefined} />
      </div>
      <dl className="mb-4 flex shrink-0 flex-wrap gap-x-5 gap-y-1 text-xs">
        {stack.map(([k, v]) => (
          <div key={k} className="flex gap-1.5">
            <dt className="text-muted-foreground">{k}:</dt>
            <dd className="font-mono">{v ?? "—"}</dd>
          </div>
        ))}
      </dl>
      {data.containers.length === 0 ? (
        <NotCollecting collecting={data.collecting} />
      ) : (
        <TableCard>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Contenedor</TableHead>
                <TableHead>CPU (núcleos)</TableHead>
                <TableHead>RAM</TableHead>
                <TableHead className="hidden xl:table-cell">Autotune</TableHead>
                <TableHead className="hidden md:table-cell text-center">Reinicios</TableHead>
                <TableHead>Diagnóstico</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.containers.map((c) => (
                <TableRow key={c.name}>
                  <TableCell className="pl-4">
                    <p className="font-medium">{c.name}</p>
                    <p className="max-w-56 truncate font-mono text-xs text-muted-foreground" title={c.image}>
                      {c.own ? c.image : `Otro proyecto · ${c.image}`}
                    </p>
                  </TableCell>
                  <TableCell>
                    <UsageCell now={c.cpuCores} peak={c.cpuP95_24h} limit={c.cpuLimit} format={cores} peakLabel="p95 24 h" />
                  </TableCell>
                  <TableCell>
                    <UsageCell now={c.memBytes} peak={c.memPeak7d} limit={c.memLimit} format={formatBytes} peakLabel="Pico 7 días" />
                  </TableCell>
                  <TableCell className="hidden xl:table-cell">
                    <AutotuneCell c={c} autotune={data.autotune} />
                  </TableCell>
                  <TableCell className="hidden text-center font-mono text-xs tabular-nums md:table-cell">{c.restarts ?? "—"}</TableCell>
                  <TableCell>
                    <div className="flex max-w-56 flex-wrap gap-1">
                      {diagnose(c).map((d) => (
                        <Tag key={d.label} tone={d.tone} title={d.title}>
                          {d.label}
                        </Tag>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableCard>
      )}
    </>
  );
}

type Range = "1h" | "24h" | "7d";
interface Metrics {
  points: { at: string; mem: number | null; memLimit: number | null; cpu: number | null; cpuLimit: number | null }[];
}

const RANGE_FORMAT: Record<Range, Intl.DateTimeFormat> = {
  "1h": new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  "24h": new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit" }),
  "7d": new Intl.DateTimeFormat("es", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
};

/** Series de uso y tope para ChartFigure (el mismo gráfico de las respuestas del chat). */
function toCharts(points: Metrics["points"], range: Range): { mem: ChartSpec; cpu: ChartSpec } | null {
  if (!points.some((p) => p.mem !== null)) return null;
  const labels = points.map((p) => RANGE_FORMAT[range].format(new Date(p.at)));
  const MB = 1024 ** 2;
  const round = (n: number | null, k = 1) => (n === null ? null : Math.round(n * k) / k);
  const series = (name: string, data: (number | null)[]) => (data.some((v) => v !== null) ? [{ name, data }] : []);
  return {
    mem: { type: "line", title: "RAM (MB)", unit: "MB", labels, series: [...series("Uso (pico)", points.map((p) => round(p.mem && p.mem / MB))), ...series("Tope", points.map((p) => round(p.memLimit && p.memLimit / MB)))] },
    cpu: { type: "line", title: "CPU (núcleos)", unit: "", labels, series: [...series("Uso (promedio)", points.map((p) => round(p.cpu, 100))), ...series("Tope", points.map((p) => round(p.cpuLimit, 100)))] },
  };
}

const EVENTS: Record<Alerts["events"][number]["event"], { label: string; tone: keyof typeof TONE }> = {
  opened: { label: "Empezó", tone: "bad" },
  reminded: { label: "Sigue", tone: "warn" },
  resolved: { label: "Resuelto", tone: "ok" },
};

function MetricsTab() {
  const resources = useQuery({ queryKey: ["system", "resources"], queryFn: () => api.get<Resources>("/system/resources"), refetchInterval: 60_000 });
  const alerts = useQuery({ queryKey: ["system", "alerts"], queryFn: () => api.get<Alerts>("/system/alerts"), refetchInterval: 60_000 });
  const names = resources.data?.containers.map((c) => c.name) ?? [];
  // Por defecto, el primer contenedor con una alerta abierta; si no hay, el primero de la lista.
  const firstWithAlert = resources.data?.containers.find((c) => c.alerts.length > 0)?.name;
  const [picked, setPicked] = useState<string | null>(null);
  const name = picked ?? firstWithAlert ?? names[0] ?? null;
  const [range, setRange] = useState<Range>("24h");
  const metrics = useQuery({
    queryKey: ["system", "metrics", name, range],
    queryFn: () => api.get<Metrics>(`/system/metrics?${new URLSearchParams({ name: name!, range })}`),
    enabled: name !== null,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
  const charts = useMemo(() => (metrics.data ? toCharts(metrics.data.points, range) : null), [metrics.data, range]);

  if (resources.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!resources.data || names.length === 0) return <NotCollecting collecting={resources.data?.collecting ?? false} />;

  return (
    <>
      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
        <Select value={name ?? undefined} onValueChange={setPicked}>
          <SelectTrigger className="w-56" aria-label="Contenedor">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {resources.data.containers.map((c) => (
              <SelectItem key={c.name} value={c.name}>
                {c.name}
                {c.alerts.length > 0 && " · con alerta"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Tabs value={range} onValueChange={(v) => setRange(v as Range)}>
          <TabsList>
            <TabsTrigger value="1h">1 hora</TabsTrigger>
            <TabsTrigger value="24h">24 horas</TabsTrigger>
            <TabsTrigger value="7d">7 días</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className={cn("mb-4 grid shrink-0 gap-3 lg:grid-cols-2", metrics.isPlaceholderData && "opacity-60 transition-opacity")}>
        {charts ? (
          <>
            <ChartFigure chart={charts.mem} />
            <ChartFigure chart={charts.cpu} />
          </>
        ) : metrics.isLoading ? (
          <Skeleton className="h-64 w-full lg:col-span-2" />
        ) : (
          <p className="text-sm text-muted-foreground lg:col-span-2">Sin muestras de «{name}» en este periodo.</p>
        )}
      </div>

      {alerts.data && alerts.data.open.length > 0 && (
        <div className="mb-4 shrink-0 space-y-2">
          {alerts.data.open.map((a) => {
            const d = describeKey(a.key);
            return (
              <div key={a.key} className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
                <BellRing className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="min-w-0">
                  <p className="font-medium">
                    {d.source}
                    {d.label && ` · ${d.label}`} <span className="font-mono text-xs font-normal text-muted-foreground">desde {formatDate(a.since)}</span>
                  </p>
                  <p className="text-muted-foreground">{a.message}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {alerts.data && alerts.data.events.length === 0 ? (
        <EmptyState icon={BellRing} title="Sin alertas registradas" description="Cuando el monitor detecte un problema (cada 5 minutos) aparecerá aquí, con el contenedor afectado." />
      ) : (
        <TableCard>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Fecha</TableHead>
                <TableHead>Origen</TableHead>
                <TableHead>Evento</TableHead>
                <TableHead className="hidden md:table-cell">Detalle</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(alerts.data?.events ?? []).map((e) => {
                const d = describeKey(e.key);
                return (
                  <TableRow key={e.id}>
                    <TableCell className="pl-4 font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">{formatDate(e.at)}</TableCell>
                    <TableCell className="text-sm">
                      <span className="font-medium">{d.source}</span>
                      {d.label && <span className="text-muted-foreground"> · {d.label}</span>}
                    </TableCell>
                    <TableCell>
                      <Tag tone={EVENTS[e.event].tone}>{EVENTS[e.event].label}</Tag>
                    </TableCell>
                    <TableCell className="hidden max-w-xl text-sm text-muted-foreground md:table-cell">{e.message}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableCard>
      )}
    </>
  );
}

const TABS = { recursos: "Recursos", metricas: "Métricas y alertas" } as const;

export function SystemPage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const current = tab === "metricas" ? "metricas" : "recursos";
  return (
    <Page fill>
      <PageHeader
        title="Sistema"
        description="Recursos del servidor y de cada contenedor: lo que el autotune asignó (topes de CPU y RAM) frente a lo que consumen, con picos de 24 horas y 7 días, y el historial de alertas del monitor. El worker toma una muestra por minuto a través de un proxy de Docker que solo responde a consultas de consumo."
      />
      <Tabs value={current} onValueChange={(v) => navigate(`/sistema/${v}`)} className="mb-4 shrink-0">
        <TabsList>
          {Object.entries(TABS).map(([k, label]) => (
            <TabsTrigger key={k} value={k}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {current === "metricas" ? <MetricsTab /> : <ResourcesTab />}
    </Page>
  );
}
