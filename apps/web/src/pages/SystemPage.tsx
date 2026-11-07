import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Activity, BellRing, CircleCheck, CircleMinus, CircleX, Clock, Cpu, MailX, MemoryStick, Server, TriangleAlert, type LucideIcon } from "lucide-react";
import { api, formatBytes, formatDate } from "@/api";
import { cn } from "@/lib/utils";
import type { ChartSpec } from "@/lib/chartSpec";
import { ChartFigure } from "@/components/chat/ChartBlock";
import { EmptyState, Page, PageHeader, TableCard } from "@/components/common";
import { BackupsTab } from "@/components/system/BackupsTab";
import { ConfigTab } from "@/components/system/ConfigTab";
import { OpenAlerts, SIGNALS, Tag, Tile, TONE, describeKey, type OpenAlert } from "@/components/system/shared";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface Container {
  name: string;
  state: string;
  cpuCores: number;
  cpuLimit: number | null;
  memBytes: number;
  memLimit: number | null;
  restarts: number | null;
  oomKilled: boolean;
  memPeak7d: number | null;
  cpuP95_24h: number | null;
  historyHours: number;
  alerts: string[];
}

interface Resources {
  collecting: boolean;
  sampledAt: string | null;
  host: { cpus: number; memBytes: number; dockerVersion: string; os: string; kernel: string; arch: string } | null;
  openAlerts: number;
  containers: Container[];
}

type CheckState = "ok" | "bad" | "wait" | "off" | "error";
interface Alerts {
  open: OpenAlert[];
  /** Un problema por fila; `until` null = sigue abierto. */
  incidents: { id: number; key: string; since: string; until: string | null; message: string }[];
  checks: { at: string; checks: { id: string; state: CheckState; detail: string | null }[] } | null;
  /** Hay destinatarios y SMTP para avisar por correo. */
  email: boolean;
}

const cores = (n: number) => n.toLocaleString("es", { maximumFractionDigits: 2, minimumFractionDigits: n < 10 ? 2 : 0 });

/** Lectura de los datos: ¿el tope se queda corto, sobra o está bien? Sin tope, solo se avisa de lo que falla. */
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
  if (out.length === 0) out.push(!c.memLimit && !c.cpuLimit ? { tone: "muted", label: "Sin tope" } : { tone: "ok", label: "Bien" });
  if (!enoughHistory) out.push({ tone: "muted", label: `${c.historyHours} h de datos`, title: "Con menos de 24 h de muestras el diagnóstico aún no es fiable" });
  return out;
}

/**
 * Uso frente a tope: valor actual en texto y una barra con el pico (p95 de 24 h en CPU, máximo de 7 días en RAM). Sin
 * tope, la barra se compara con el total del servidor. El pico se ve al pasar el ratón por la barra.
 */
function UsageCell({ now, peak, limit, total, format, peakLabel }: { now: number; peak: number | null; limit: number | null; total: number | null; format: (n: number) => string; peakLabel: string }) {
  const base = limit ?? total;
  const value = peak ?? now;
  const pct = base ? Math.min(100, (value / base) * 100) : null;
  return (
    <div className="min-w-40 space-y-1">
      <div className="flex items-baseline justify-between gap-2 font-mono text-xs tabular-nums">
        <span>{format(now)}</span>
        <span className="text-muted-foreground">/ {limit ? format(limit) : "sin tope"}</span>
      </div>
      {pct !== null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" title={`${peakLabel}: ${format(value)} (${Math.round(pct)} % ${limit ? "del tope" : "del servidor"})`}>
          <div className={cn("h-full rounded-full", !limit ? "bg-success" : pct >= 90 ? "bg-destructive" : pct >= 75 ? "bg-warning" : "bg-primary")} style={{ width: `${Math.max(pct, 1)}%` }} />
        </div>
      )}
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
  const running = data.containers.filter((c) => c.state === "running").length;
  const memUsed = data.containers.reduce((s, c) => s + c.memBytes, 0);
  const cpuUsed = data.containers.reduce((s, c) => s + c.cpuCores, 0);

  return (
    <>
      <div className="mb-4 grid shrink-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile icon={MemoryStick} label="RAM en uso" value={`${formatBytes(memUsed)}${data.host ? ` de ${formatBytes(data.host.memBytes)}` : ""}`} />
        <Tile icon={Cpu} label="CPU en uso" value={`${cores(cpuUsed)}${data.host ? ` de ${data.host.cpus}` : ""} núcl.`} />
        <Tile icon={Server} label="Contenedores en marcha" value={`${running} / ${data.containers.length}`} />
        <Tile icon={BellRing} label="Alertas abiertas" value={String(data.openAlerts)} />
      </div>
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
                <TableHead className="hidden md:table-cell text-center">Reinicios</TableHead>
                <TableHead>Diagnóstico</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.containers.map((c) => (
                <TableRow key={c.name}>
                  <TableCell className="pl-4">
                    <p className="font-medium">{c.name}</p>
                  </TableCell>
                  <TableCell>
                    <UsageCell now={c.cpuCores} peak={c.cpuP95_24h} limit={c.cpuLimit} total={data.host?.cpus ?? null} format={cores} peakLabel="Uso alto habitual (p95 de 24 h)" />
                  </TableCell>
                  <TableCell>
                    <UsageCell now={c.memBytes} peak={c.memPeak7d} limit={c.memLimit} total={data.host?.memBytes ?? null} format={formatBytes} peakLabel="Pico de 7 días" />
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

type Range = "1h" | "24h" | "7d" | "14d";
type Stat = { now: number | null; avg: number | null; max: number | null };
interface Metrics {
  points: { at: string; mem: number | null; memLimit: number | null; cpu: number | null; cpuLimit: number | null }[];
  summary: { mem: Stat; cpu: Stat } | null;
}

const RANGE_FORMAT: Record<Range, Intl.DateTimeFormat> = {
  "1h": new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  "24h": new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit" }),
  "7d": new Intl.DateTimeFormat("es", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
  "14d": new Intl.DateTimeFormat("es", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
};

/** Ahora, media y pico de todo el periodo, sobre el gráfico. */
function Summary({ stat, format }: { stat: Stat | undefined; format: (n: number) => string }) {
  if (!stat) return null;
  const items = [["Ahora", stat.now], ["Media", stat.avg], ["Pico", stat.max]] as const;
  return (
    <dl className="mb-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
      {items.map(([label, v]) => (
        <div key={label} className="flex items-baseline gap-1.5">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="font-mono tabular-nums">{v === null ? "—" : format(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

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

function MetricsTab() {
  const resources = useQuery({ queryKey: ["system", "resources"], queryFn: () => api.get<Resources>("/system/resources"), refetchInterval: 60_000 });
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
            <TabsTrigger value="14d">14 días</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className={cn("mb-4 grid shrink-0 gap-3 lg:grid-cols-2", metrics.isPlaceholderData && "opacity-60 transition-opacity")}>
        {charts ? (
          <>
            <ChartFigure chart={charts.mem} tools={false} summary={<Summary stat={metrics.data?.summary?.mem} format={formatBytes} />} />
            <ChartFigure chart={charts.cpu} tools={false} summary={<Summary stat={metrics.data?.summary?.cpu} format={(n) => `${cores(n)} núcl.`} />} />
          </>
        ) : metrics.isLoading ? (
          <Skeleton className="h-64 w-full lg:col-span-2" />
        ) : (
          <p className="text-sm text-muted-foreground lg:col-span-2">Sin muestras de «{name}» en este periodo.</p>
        )}
      </div>
    </>
  );
}

/** Etiqueta y tono de cada comprobación del monitor (ids de CHECKS en apps/api/src/lib/monitor.ts). */
const CHECK_LABELS: Record<string, string> = {
  disk: "Disco",
  queue: "Cola de documentos",
  backup: "Copias",
  "backup-offsite": "Copia externa",
  "backup-b2": "Backblaze B2",
  llm: "Modelo de lenguaje",
  containers: "Contenedores",
  "host-mem": "RAM del servidor",
};
const CHECK_STATES: Record<CheckState, { icon: LucideIcon; className: string; text: string }> = {
  ok: { icon: CircleCheck, className: "text-success", text: "Bien" },
  bad: { icon: CircleX, className: "text-destructive", text: "Con problema" },
  wait: { icon: Clock, className: "text-warning", text: "Comprobando (acaba de arrancar)" },
  off: { icon: CircleMinus, className: "text-muted-foreground", text: "Sin configurar" },
  error: { icon: TriangleAlert, className: "text-warning", text: "No se pudo comprobar (ver «docker compose logs worker»)" },
};
/** Tras 15 minutos sin revisión (se hace cada 5), el monitor no está corriendo. */
const MONITOR_STALE_MS = 15 * 60_000;

function duration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

const timeFormat = new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit" });

/** Qué vigila el monitor y cómo estaba en su última revisión, más el aviso si no hay correo de alertas. */
function Watched({ checks, email }: { checks: Alerts["checks"]; email: boolean }) {
  const stale = !checks || Date.now() - new Date(checks.at).getTime() > MONITOR_STALE_MS;
  return (
    <section className="mb-4 shrink-0 rounded-xl border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-medium">Qué se vigila</h2>
        <p className="text-xs text-muted-foreground">
          Cada 5 minutos{checks && ` · última revisión: ${timeFormat.format(new Date(checks.at))}`}
        </p>
      </div>
      {checks ? (
        <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-4">
          {checks.checks.map((c) => {
            const st = CHECK_STATES[c.state];
            return (
              <li key={c.id} className="flex min-w-0 items-center gap-2 text-sm" title={st.text}>
                <st.icon className={cn("size-4 shrink-0", st.className)} aria-label={st.text} />
                <span className="truncate">{CHECK_LABELS[c.id] ?? c.id}</span>
                {(c.detail || c.state === "off") && <span className="truncate font-mono text-xs text-muted-foreground tabular-nums">{c.detail ?? "sin configurar"}</span>}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">El monitor aún no ha hecho su primera revisión.</p>
      )}
      {(stale && checks) || !email ? (
        <div className="mt-3 space-y-1 border-t pt-3 text-sm">
          {stale && checks && (
            <p className="flex items-center gap-2 text-warning">
              <TriangleAlert className="size-4 shrink-0" /> El monitor no revisa desde las {timeFormat.format(new Date(checks.at))}: revisa «docker compose logs worker».
            </p>
          )}
          {!email && (
            <p className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
              <MailX className="size-4 shrink-0" /> Sin correo de alertas: los problemas solo se ven aquí.
              <Link to="/sistema/configuracion" className="text-primary underline-offset-4 hover:underline">
                Configurar destinatarios y SMTP
              </Link>
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

function AlertsTab() {
  const alerts = useQuery({ queryKey: ["system", "alerts"], queryFn: () => api.get<Alerts>("/system/alerts"), refetchInterval: 60_000 });
  if (alerts.isLoading || !alerts.data) return <Skeleton className="h-64 w-full" />;
  const { open, incidents, checks, email } = alerts.data;
  return (
    <>
      <Watched checks={checks} email={email} />
      <OpenAlerts alerts={open} />
      {incidents.length === 0 ? (
        <EmptyState icon={BellRing} title="Sin problemas registrados" description="Cuando el monitor detecte uno aparecerá aquí, una fila por problema, con cuánto duró." />
      ) : (
        <TableCard>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Estado</TableHead>
                <TableHead>Origen</TableHead>
                <TableHead>Desde</TableHead>
                <TableHead>Duración</TableHead>
                <TableHead className="hidden md:table-cell">Detalle</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {incidents.map((e) => {
                const d = describeKey(e.key);
                const end = e.until ? new Date(e.until).getTime() : Date.now();
                return (
                  <TableRow key={e.id}>
                    <TableCell className="pl-4">{e.until ? <Tag tone="ok">Resuelta</Tag> : <Tag tone="bad">Abierta</Tag>}</TableCell>
                    <TableCell className="text-sm">
                      <span className="font-medium">{d.source}</span>
                      {d.label && <span className="text-muted-foreground"> · {d.label}</span>}
                    </TableCell>
                    <TableCell className="font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">{formatDate(e.since)}</TableCell>
                    <TableCell className="font-mono text-xs whitespace-nowrap tabular-nums" title={e.until ? `Hasta ${formatDate(e.until)}` : "Sigue abierta"}>
                      {duration(end - new Date(e.since).getTime())}
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

const TABS = { recursos: "Recursos", metricas: "Métricas", alertas: "Alertas", copias: "Copias", configuracion: "Configuración" } as const;
type Tab = keyof typeof TABS;

export function SystemPage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const current: Tab = tab && tab in TABS ? (tab as Tab) : "recursos";
  return (
    <Page fill>
      <PageHeader
        title="Sistema"
        description="Recursos del servidor y de cada contenedor de Omni RAG (los demás servicios del servidor no se miden): lo que consumen frente a su tope de CPU y RAM, si lo tienen, o frente al total del servidor, el historial de alertas del monitor (copias, disco, cola, modelos y contenedores) y el estado de las copias de seguridad (locales, carpeta externa y Backblaze B2) y la configuración editable del sistema (alertas, correo, límites, modelos, búsqueda y copias), salvo lo que esté fijado en el archivo de entorno del servidor. El worker toma una muestra por minuto a través de un proxy de Docker que solo responde a consultas de consumo."
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
      {current === "metricas" ? <MetricsTab /> : current === "alertas" ? <AlertsTab /> : current === "copias" ? <BackupsTab /> : current === "configuracion" ? <ConfigTab /> : <ResourcesTab />}
    </Page>
  );
}
