import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Activity, BellRing, Cpu, MemoryStick, Server } from "lucide-react";
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

interface Alerts {
  open: OpenAlert[];
  events: { id: number; at: string; key: string; event: "opened" | "reminded" | "resolved"; message: string }[];
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
    </>
  );
}

function AlertsTab() {
  const alerts = useQuery({ queryKey: ["system", "alerts"], queryFn: () => api.get<Alerts>("/system/alerts"), refetchInterval: 60_000 });
  if (alerts.isLoading || !alerts.data) return <Skeleton className="h-64 w-full" />;
  return (
    <>
      <OpenAlerts alerts={alerts.data.open} />
      {alerts.data.events.length === 0 ? (
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
              {alerts.data.events.map((e) => {
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
