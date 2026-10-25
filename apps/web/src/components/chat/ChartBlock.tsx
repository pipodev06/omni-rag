import { useMemo, useState } from "react";
import { BarChart3, Download, Table2 } from "lucide-react";
import { formatValue, niceScale, parseChart, type ChartSpec } from "@/lib/chartSpec";
import { safeCell, toCsv } from "@/lib/tableExport";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/*
 * Gráfico de una respuesta (bloque ```chart). SVG propio: sin librería de gráficos ni nada que ejecutar, solo los datos
 * ya validados por parseChart. Reglas de la guía de visualización: una sola escala, colores en orden fijo (--series-n),
 * barras con el extremo de datos redondeado (4 px) y 2 px de separación, líneas de 2 px con marcadores de 8 px, rejilla
 * discreta, leyenda con 2 series o más, tooltip al pasar el ratón y la tabla de datos a un clic.
 */
const W = 640;
const H = 260;
const PAD = { top: 12, right: 12, bottom: 34 };
const color = (i: number) => `var(--series-${(i % 8) + 1})`;
const short = (s: string, max = 14) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

interface Tip {
  x: number;
  y: number;
  title: string;
  rows: { label: string; value: string; color: string }[];
}

function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div
      className="pointer-events-none absolute z-10 min-w-36 -translate-x-1/2 -translate-y-full rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md"
      style={{ left: `${(tip.x / W) * 100}%`, top: `calc(${(tip.y / H) * 100}% - 8px)` }}
    >
      <p className="mb-0.5 font-medium text-foreground">{tip.title}</p>
      {tip.rows.map((r) => (
        <p key={r.label} className="flex items-center justify-between gap-3 text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-sm" style={{ background: r.color }} />
            {r.label}
          </span>
          <span className="font-medium text-foreground tabular-nums">{r.value}</span>
        </p>
      ))}
    </div>
  );
}

/** Eje Y y rejilla discreta; devuelve la escala y el margen izquierdo según el largo de las marcas. */
function useAxis(chart: ChartSpec) {
  return useMemo(() => {
    const values = chart.series.flatMap((s) => s.data.filter((d): d is number => d !== null));
    const scale = niceScale(Math.min(...values), Math.max(...values));
    const ticks: number[] = [];
    for (let v = scale.min; v <= scale.max + scale.step / 2; v += scale.step) ticks.push(Number(v.toFixed(10)));
    const labels = ticks.map((t) => formatValue(t));
    const left = Math.max(34, Math.max(...labels.map((l) => l.length)) * 6.5 + 10);
    const plotH = H - PAD.top - PAD.bottom;
    const y = (v: number) => PAD.top + plotH - ((v - scale.min) / (scale.max - scale.min)) * plotH;
    return { ticks, labels, left, y, plotW: W - left - PAD.right };
  }, [chart]);
}

function Grid({ axis }: { axis: ReturnType<typeof useAxis> }) {
  return (
    <g className="text-muted-foreground">
      {axis.ticks.map((t, i) => (
        <g key={t}>
          <line x1={axis.left} x2={W - PAD.right} y1={axis.y(t)} y2={axis.y(t)} stroke="var(--border)" strokeDasharray={t === 0 ? undefined : "3 3"} />
          <text x={axis.left - 6} y={axis.y(t)} dy="0.32em" textAnchor="end" fontSize="11" fill="currentColor">
            {axis.labels[i]}
          </text>
        </g>
      ))}
    </g>
  );
}

function XLabels({ chart, x }: { chart: ChartSpec; x: (i: number) => number }) {
  const every = Math.ceil(chart.labels.length / 8); // como mucho ~8 etiquetas visibles; todas salen en el tooltip
  return (
    <g className="text-muted-foreground">
      {chart.labels.map((l, i) =>
        i % every === 0 ? (
          <text key={i} x={x(i)} y={H - PAD.bottom + 18} textAnchor="middle" fontSize="11" fill="currentColor">
            {short(l)}
          </text>
        ) : null,
      )}
    </g>
  );
}

/** Barra con el extremo de datos redondeado y la base recta, apoyada en la línea del cero. */
function barPath(x: number, w: number, yValue: number, yZero: number): string {
  const h = Math.abs(yZero - yValue);
  const r = Math.min(4, w / 2, h);
  if (yValue <= yZero) {
    return `M${x},${yZero}V${yValue + r}Q${x},${yValue} ${x + r},${yValue}H${x + w - r}Q${x + w},${yValue} ${x + w},${yValue + r}V${yZero}Z`;
  }
  return `M${x},${yZero}V${yValue - r}Q${x},${yValue} ${x + r},${yValue}H${x + w - r}Q${x + w},${yValue} ${x + w},${yValue - r}V${yZero}Z`;
}

function rowsAt(chart: ChartSpec, i: number) {
  return chart.series
    .map((s, k) => ({ label: s.name, value: s.data[i] === null ? "—" : formatValue(s.data[i]!, chart.unit), color: color(k) }))
    .filter((r) => r.value !== "—" || chart.series.length > 1);
}

function Bars({ chart, onTip }: { chart: ChartSpec; onTip: (t: Tip | null) => void }) {
  const axis = useAxis(chart);
  const n = chart.labels.length;
  const k = chart.series.length;
  const band = axis.plotW / n;
  const inner = band * 0.72;
  const barW = Math.min(44, (inner - (k - 1) * 2) / k);
  const groupW = barW * k + (k - 1) * 2;
  const x = (i: number) => axis.left + band * i + band / 2;
  const yZero = axis.y(0);
  return (
    <>
      <Grid axis={axis} />
      {chart.labels.map((label, i) => (
        <g key={i}>
          {chart.series.map((s, j) =>
            s.data[i] === null ? null : <path key={j} d={barPath(x(i) - groupW / 2 + j * (barW + 2), barW, axis.y(s.data[i]!), yZero)} fill={color(j)} />,
          )}
          {/* Zona de hover de toda la columna: más grande que la barra. */}
          <rect
            x={axis.left + band * i}
            y={PAD.top}
            width={band}
            height={H - PAD.top - PAD.bottom}
            fill="transparent"
            onMouseEnter={() => onTip({ x: x(i), y: Math.min(...chart.series.map((s) => axis.y(s.data[i] ?? 0))), title: label, rows: rowsAt(chart, i) })}
            onMouseLeave={() => onTip(null)}
          />
        </g>
      ))}
      <XLabels chart={chart} x={x} />
    </>
  );
}

function Lines({ chart, onTip }: { chart: ChartSpec; onTip: (t: Tip | null) => void }) {
  const axis = useAxis(chart);
  const n = chart.labels.length;
  const [hover, setHover] = useState<number | null>(null);
  const x = (i: number) => (n === 1 ? axis.left + axis.plotW / 2 : axis.left + (axis.plotW * i) / (n - 1));
  const path = (data: (number | null)[]) =>
    data.reduce<{ d: string; open: boolean }>(
      (acc, v, i) => (v === null ? { d: acc.d, open: false } : { d: `${acc.d}${acc.open ? "L" : "M"}${x(i)},${axis.y(v)}`, open: true }),
      { d: "", open: false },
    ).d;
  return (
    <>
      <Grid axis={axis} />
      {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--border)" />}
      {chart.series.map((s, j) => (
        <g key={j}>
          <path d={path(s.data)} fill="none" stroke={color(j)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {s.data.map((v, i) =>
            v === null || (n > 12 && hover !== i) ? null : (
              <circle key={i} cx={x(i)} cy={axis.y(v)} r={4} fill={color(j)} stroke="var(--card)" strokeWidth={2} />
            ),
          )}
        </g>
      ))}
      {chart.labels.map((label, i) => (
        <rect
          key={i}
          x={x(i) - axis.plotW / Math.max(1, n - 1) / 2}
          y={PAD.top}
          width={axis.plotW / Math.max(1, n - 1)}
          height={H - PAD.top - PAD.bottom}
          fill="transparent"
          onMouseEnter={() => {
            setHover(i);
            onTip({ x: x(i), y: Math.min(...chart.series.map((s) => axis.y(s.data[i] ?? 0))), title: label, rows: rowsAt(chart, i) });
          }}
          onMouseLeave={() => {
            setHover(null);
            onTip(null);
          }}
        />
      ))}
      <XLabels chart={chart} x={x} />
    </>
  );
}

function Pie({ chart, onTip }: { chart: ChartSpec; onTip: (t: Tip | null) => void }) {
  const data = chart.series[0]!.data as number[];
  const total = data.reduce((a, b) => a + b, 0) || 1;
  const cx = W / 2;
  const cy = H / 2;
  const R = 110;
  const r = 66;
  let angle = -Math.PI / 2;
  const point = (rad: number, a: number) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)] as const;
  return (
    <>
      {data.map((v, i) => {
        const sweep = (v / total) * Math.PI * 2;
        const start = angle;
        angle += sweep;
        if (v === 0) return null;
        const large = sweep > Math.PI ? 1 : 0;
        const end = Math.min(angle, start + Math.PI * 2 - 0.0001);
        const [x1, y1] = point(R, start);
        const [x2, y2] = point(R, end);
        const [x3, y3] = point(r, end);
        const [x4, y4] = point(r, start);
        const [tx, ty] = point(R, start + sweep / 2);
        const pct = formatValue((v / total) * 100, "%");
        return (
          <path
            key={i}
            d={`M${x1},${y1}A${R},${R} 0 ${large} 1 ${x2},${y2}L${x3},${y3}A${r},${r} 0 ${large} 0 ${x4},${y4}Z`}
            fill={color(i)}
            stroke="var(--card)"
            strokeWidth={2}
            onMouseEnter={() => onTip({ x: tx, y: ty, title: chart.labels[i]!, rows: [{ label: pct, value: formatValue(v, chart.unit), color: color(i) }] })}
            onMouseLeave={() => onTip(null)}
          />
        );
      })}
      <text x={cx} y={cy} dy="0.32em" textAnchor="middle" fontSize="13" className="fill-foreground font-medium">
        {formatValue(total, chart.unit)}
      </text>
    </>
  );
}

function DataTable({ chart }: { chart: ChartSpec }) {
  return (
    <div className="mt-2 overflow-x-auto rounded-lg border">
      <table className="my-0! w-full text-xs">
        <thead>
          <tr>
            <th className="px-3 py-1.5 text-left"> </th>
            {chart.series.map((s) => (
              <th key={s.name} className="px-3 py-1.5 text-right">
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {chart.labels.map((l, i) => (
            <tr key={i}>
              <td className="px-3 py-1">{l}</td>
              {chart.series.map((s) => (
                <td key={s.name} className="px-3 py-1 text-right tabular-nums">
                  {s.data[i] === null ? "—" : formatValue(s.data[i]!, chart.unit)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function downloadCsv(chart: ChartSpec) {
  const rows = [["", ...chart.series.map((s) => s.name)], ...chart.labels.map((l, i) => [l, ...chart.series.map((s) => (s.data[i] === null ? "" : String(s.data[i])))])];
  const url = URL.createObjectURL(new Blob([toCsv(rows.map((r) => r.map(safeCell)))], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${(chart.title || "grafico").replace(/[^\p{L}\d]+/gu, "-").slice(0, 60)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/** Bloque ```chart de una respuesta. Mientras llega la respuesta muestra un aviso; si el JSON no sirve, el texto tal cual. */
export function ChartBlock({ source, streaming }: { source: string; streaming?: boolean }) {
  const parsed = useMemo(() => parseChart(source), [source]);
  const [tip, setTip] = useState<Tip | null>(null);
  const [table, setTable] = useState(false);

  if (!parsed.ok) {
    if (streaming) {
      return (
        <p className="my-3 flex items-center gap-2 text-sm text-muted-foreground">
          <BarChart3 className="size-4" /> Preparando el gráfico…
        </p>
      );
    }
    return (
      <div className="my-3 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        <p className="mb-1 font-medium">No se pudo dibujar el gráfico ({parsed.error}).</p>
        <pre className="my-0! max-h-40 overflow-auto bg-transparent! p-0! text-foreground! whitespace-pre-wrap">{source}</pre>
      </div>
    );
  }

  const { chart } = parsed;
  const legend = chart.type === "pie" ? chart.labels : chart.series.length > 1 ? chart.series.map((s) => s.name) : [];
  return (
    <figure className="viz not-prose my-4 rounded-lg border bg-card p-3">
      {chart.title && <figcaption className="mb-2 text-sm font-medium text-foreground">{chart.title}</figcaption>}
      {legend.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {legend.map((name, i) => (
            <span key={`${name}-${i}`} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm" style={{ background: color(i) }} />
              {name}
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={chart.title || "Gráfico"}>
          {chart.type === "bar" && <Bars chart={chart} onTip={setTip} />}
          {chart.type === "line" && <Lines chart={chart} onTip={setTip} />}
          {chart.type === "pie" && <Pie chart={chart} onTip={setTip} />}
        </svg>
        <Tooltip tip={tip} />
      </div>
      {table && <DataTable chart={chart} />}
      <div className="mt-1 flex justify-end gap-1">
        <Button type="button" variant="ghost" size="sm" className={cn("h-7 gap-1 px-2 text-xs text-muted-foreground", table && "text-foreground")} onClick={() => setTable(!table)}>
          <Table2 /> {table ? "Ocultar datos" : "Ver datos"}
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground" onClick={() => downloadCsv(chart)}>
          <Download /> Descargar CSV
        </Button>
      </div>
    </figure>
  );
}
