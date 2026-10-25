import { describe, expect, it } from "vitest";
import { formatValue, niceScale, parseChart } from "./chartSpec";

const bar = { type: "bar", title: "Ventas", unit: "S/", labels: ["2023", "2024"], series: [{ name: "Ventas", data: [120, 150] }] };

describe("parseChart", () => {
  it("acepta un gráfico válido", () => {
    const r = parseChart(JSON.stringify(bar));
    expect(r.ok && r.chart).toEqual({ type: "bar", title: "Ventas", unit: "S/", labels: ["2023", "2024"], series: [{ name: "Ventas", data: [120, 150] }] });
  });

  it("acepta claves y tipos en español, etiquetas numéricas y números como texto simple", () => {
    const r = parseChart(JSON.stringify({ tipo: "lineas", etiquetas: [2023, 2024], series: [{ nombre: "Gasto", valores: ["10", null] }] }));
    expect(r.ok && r.chart.type).toBe("line");
    expect(r.ok && r.chart.labels).toEqual(["2023", "2024"]);
    expect(r.ok && r.chart.series[0]!.data).toEqual([10, null]);
  });

  it("rechaza lo que no se puede dibujar con seguridad", () => {
    const bad = (o: object) => parseChart(JSON.stringify({ ...bar, ...o }));
    expect(parseChart("{no es json").ok).toBe(false);
    expect(bad({ type: "radar" }).ok).toBe(false);
    expect(bad({ series: [{ name: "x", data: [1] }] }).ok).toBe(false); // un valor menos que etiquetas
    expect(bad({ series: [{ name: "x", data: ["1,200", 3] }] }).ok).toBe(false); // ambiguo
    expect(bad({ series: [{ name: "x", data: ["mucho", 3] }] }).ok).toBe(false);
    expect(bad({ labels: Array.from({ length: 41 }, (_, i) => `e${i}`), series: [{ name: "x", data: Array(41).fill(1) }] }).ok).toBe(false);
    expect(bad({ series: Array.from({ length: 9 }, () => ({ name: "s", data: [1, 2] })) }).ok).toBe(false);
  });

  it("un gráfico circular: una serie, partes positivas y como mucho 8", () => {
    const pie = (o: object) => parseChart(JSON.stringify({ type: "pie", labels: ["a", "b"], series: [{ name: "x", data: [1, 2] }], ...o }));
    expect(pie({}).ok).toBe(true);
    expect(pie({ series: [{ name: "x", data: [1, -2] }] }).ok).toBe(false);
    expect(pie({ series: [{ name: "x", data: [1, 2] }, { name: "y", data: [1, 2] }] }).ok).toBe(false);
  });
});

describe("niceScale y formatValue", () => {
  it("escala redonda que incluye el cero", () => {
    expect(niceScale(0, 150)).toEqual({ min: 0, max: 150, step: 50 });
    expect(niceScale(0, 163)).toEqual({ min: 0, max: 200, step: 50 });
    expect(niceScale(-30, 70)).toEqual({ min: -50, max: 75, step: 25 });
  });

  it("formatea con la unidad delante (monedas) o detrás", () => {
    expect(formatValue(1250.5, "S/")).toBe("S/ 1,250.5");
    expect(formatValue(12, "%")).toBe("12 %");
    expect(formatValue(3, "días")).toBe("3 días");
  });
});
