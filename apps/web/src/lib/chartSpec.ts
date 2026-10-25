/**
 * Gráficos en las respuestas: el modelo escribe un bloque ```chart con JSON y la pantalla lo dibuja. El JSON viene de un
 * modelo (y, de rebote, de documentos ajenos), así que se valida a fondo: si algo no encaja no se dibuja nada y se
 * muestra el texto, en vez de romper la pantalla o dibujar datos dudosos.
 *
 *   {"type":"bar","title":"Ventas por año","unit":"S/","labels":["2023","2024"],"series":[{"name":"Ventas","data":[120,150]}]}
 *
 * También acepta las claves en español (tipo, titulo, unidad, etiquetas, series[].nombre/valores) y los tipos barras,
 * lineas y torta, porque los modelos pequeños a veces las traducen.
 */
export type ChartType = "bar" | "line" | "pie";

export interface ChartSeries {
  name: string;
  /** Un valor por etiqueta; null = sin dato (la línea se corta). */
  data: (number | null)[];
}

export interface ChartSpec {
  type: ChartType;
  title: string;
  unit: string;
  labels: string[];
  series: ChartSeries[];
}

export const MAX_SERIES = 8;
export const MAX_LABELS = 40;
const MAX_PIE_SLICES = 8;

const TYPES: Record<string, ChartType> = {
  bar: "bar", bars: "bar", barra: "bar", barras: "bar", column: "bar", columnas: "bar",
  line: "line", lines: "line", linea: "line", lineas: "line", "línea": "line", "líneas": "line",
  pie: "pie", donut: "pie", torta: "pie", pastel: "pie", dona: "pie",
};

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Número finito, o una cadena con un número simple («150», «-3.5»). «1,200» es ambiguo y se rechaza. */
function toNumber(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return undefined;
}

export type ChartResult = { ok: true; chart: ChartSpec } | { ok: false; error: string };

export function parseChart(source: string): ChartResult {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return { ok: false, error: "El bloque del gráfico no es un JSON válido" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "El gráfico no tiene el formato esperado" };
  const o = raw as Record<string, unknown>;

  const type = TYPES[text(o.type ?? o.tipo, 20).toLowerCase()];
  if (!type) return { ok: false, error: "Tipo de gráfico desconocido (usa bar, line o pie)" };

  const rawLabels = o.labels ?? o.etiquetas;
  if (!Array.isArray(rawLabels) || rawLabels.length === 0) return { ok: false, error: "Faltan las etiquetas del gráfico" };
  if (rawLabels.length > MAX_LABELS) return { ok: false, error: `Demasiadas etiquetas (máximo ${MAX_LABELS})` };
  const labels = rawLabels.map((l) => (typeof l === "number" ? String(l) : text(l, 40)));
  if (labels.some((l) => !l)) return { ok: false, error: "Hay etiquetas vacías" };
  if (new Set(labels).size !== labels.length) return { ok: false, error: "Hay etiquetas repetidas" };

  const rawSeries = o.series;
  if (!Array.isArray(rawSeries) || rawSeries.length === 0) return { ok: false, error: "Faltan los datos del gráfico" };
  if (rawSeries.length > MAX_SERIES) return { ok: false, error: `Demasiadas series (máximo ${MAX_SERIES})` };

  const series: ChartSeries[] = [];
  for (const [i, s] of rawSeries.entries()) {
    if (!s || typeof s !== "object") return { ok: false, error: "Una serie no tiene el formato esperado" };
    const so = s as Record<string, unknown>;
    const values = so.data ?? so.valores ?? so.values;
    if (!Array.isArray(values) || values.length !== labels.length) {
      return { ok: false, error: "Cada serie debe tener un valor por etiqueta" };
    }
    const data = values.map(toNumber);
    if (data.some((d) => d === undefined)) return { ok: false, error: "Hay valores que no son números" };
    // Nombres únicos: la leyenda y la tabla los usan para identificar cada serie.
    const base = text(so.name ?? so.nombre, 60) || `Serie ${i + 1}`;
    let name = base;
    for (let n = 2; series.some((x) => x.name === name); n++) name = `${base} (${n})`;
    series.push({ name, data: data as (number | null)[] });
  }
  if (series.every((s) => s.data.every((d) => d === null))) return { ok: false, error: "El gráfico no tiene datos" };

  if (type === "pie") {
    if (series.length !== 1) return { ok: false, error: "Un gráfico circular lleva una sola serie" };
    if (labels.length > MAX_PIE_SLICES) return { ok: false, error: `Un gráfico circular admite hasta ${MAX_PIE_SLICES} partes` };
    if (series[0]!.data.some((d) => d === null || d < 0)) return { ok: false, error: "Un gráfico circular solo admite valores positivos" };
  }

  return { ok: true, chart: { type, title: text(o.title ?? o.titulo, 120), unit: text(o.unit ?? o.unidad, 12), labels, series } };
}

/** Escala «redonda» para el eje: de 0 (o del mínimo negativo) a un máximo legible, con 4-5 marcas. */
export function niceScale(min: number, max: number, ticks = 4): { min: number; max: number; step: number } {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  if (lo === hi) return { min: 0, max: 1, step: 0.25 };
  const rough = (hi - lo) / ticks;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? 10 * power;
  return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step, step };
}

const NUMBER_FORMAT = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 2 });

/** Número con separador de miles según el idioma (es-PE) y la unidad, si la hay. */
export function formatValue(value: number, unit = ""): string {
  const n = NUMBER_FORMAT.format(value);
  if (!unit) return n;
  return unit === "%" ? `${n} %` : /^[A-Za-z$€£S/]{1,4}\.?$/.test(unit) ? `${unit} ${n}` : `${n} ${unit}`;
}
