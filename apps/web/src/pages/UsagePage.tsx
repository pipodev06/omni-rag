import { useEffect, useState } from "react";
import { api } from "../api";

interface Usage {
  daily: { day: string; questions: number; promptTokens: number; completionTokens: number }[];
  byModel: { model: string; questions: number }[];
  totals: { documents: number; chunks: number; users: number };
}

export function UsagePage() {
  const [data, setData] = useState<Usage | null>(null);
  useEffect(() => void api.get<Usage>("/usage").then(setData), []);
  if (!data) return <div className="page muted">Cargando…</div>;
  const max = Math.max(1, ...data.daily.map((d) => d.questions));

  return (
    <div className="page">
      <h1>Consumo (últimos 30 días)</h1>
      <div className="stats">
        <div className="card stat">
          <div className="stat-value">{data.daily.reduce((n, d) => n + d.questions, 0)}</div>
          <div className="muted small">preguntas</div>
        </div>
        <div className="card stat">
          <div className="stat-value">{data.totals.documents}</div>
          <div className="muted small">documentos</div>
        </div>
        <div className="card stat">
          <div className="stat-value">{data.totals.chunks}</div>
          <div className="muted small">trozos indexados</div>
        </div>
        <div className="card stat">
          <div className="stat-value">{data.totals.users}</div>
          <div className="muted small">usuarios</div>
        </div>
      </div>

      <h2>Preguntas por día</h2>
      <table className="table">
        <thead>
          <tr>
            <th>Día (UTC)</th>
            <th>Preguntas</th>
            <th></th>
            <th>Tokens entrada</th>
            <th>Tokens salida</th>
          </tr>
        </thead>
        <tbody>
          {data.daily.map((d) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              <td>{d.questions}</td>
              <td className="bar-cell">
                <div className="bar" style={{ width: `${(d.questions / max) * 100}%` }} />
              </td>
              <td>{d.promptTokens.toLocaleString("es")}</td>
              <td>{d.completionTokens.toLocaleString("es")}</td>
            </tr>
          ))}
          {data.daily.length === 0 && (
            <tr>
              <td colSpan={5} className="muted center-text">
                Sin preguntas todavía.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>Modelos usados</h2>
      <table className="table">
        <tbody>
          {data.byModel.map((m) => (
            <tr key={m.model}>
              <td>{m.model}</td>
              <td>{m.questions}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
