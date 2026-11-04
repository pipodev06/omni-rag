import { BellRing, type LucideIcon } from "lucide-react";
import { formatDate } from "@/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export type OpenAlert = { key: string; since: string; message: string };

export const TONE = {
  bad: "text-destructive bg-destructive/10 border-destructive/20",
  warn: "text-warning bg-warning/10 border-warning/20",
  ok: "text-success bg-success/10 border-success/20",
  muted: "text-muted-foreground",
} as const;

export function Tag({ tone, children, title }: { tone: keyof typeof TONE; children: string; title?: string }) {
  return (
    <Badge variant="outline" className={cn("font-medium", TONE[tone])} title={title}>
      {children}
    </Badge>
  );
}

export const SIGNALS: Record<string, string> = { mem: "RAM al límite", cpu: "CPU al límite", restart: "Se reinició", health: "No responde" };
const CHECKS: Record<string, string> = { disk: "Disco", queue: "Cola de documentos", backup: "Copias de seguridad", "backup-b2": "Copias en B2", "backup-offsite": "Destino externo de copias", llm: "Modelo de lenguaje", metrics: "Métricas" };

/** «container:api:mem» → { source: "api", label: "RAM al límite" }; «disk» → { source: "Disco", … }. */
export function describeKey(key: string): { source: string; label: string } {
  const [kind, name, signal] = key.split(":");
  if (kind === "container" && name) return { source: name, label: SIGNALS[signal ?? ""] ?? signal ?? "" };
  return { source: CHECKS[key] ?? key, label: "" };
}

export function Tile({ icon: Icon, label, value, hint }: { icon: LucideIcon; label: string; value: string; hint?: string }) {
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

/** Alertas abiertas en recuadros rojos (pestañas Métricas y Copias). */
export function OpenAlerts({ alerts }: { alerts: OpenAlert[] }) {
  if (alerts.length === 0) return null;
  return (
    <div className="mb-4 shrink-0 space-y-2">
      {alerts.map((a) => {
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
  );
}
