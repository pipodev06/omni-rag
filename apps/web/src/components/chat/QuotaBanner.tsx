import { CircleAlert, TriangleAlert } from "lucide-react";
import { useQuota, type Quota } from "@/hooks/useQuota";
import { cn } from "@/lib/utils";

type Level = Quota["level"];

interface Notice {
  level: "warn" | "full";
  text: string;
}

/** Avisos a mostrar: el de la organización y, si el plan lo define, el de la cuota personal. */
function notices(q: Quota): Notice[] {
  const out: Notice[] = [];
  const bad = (l: Level) => l === "warn" || l === "full";
  if (q.user && bad(q.user.level)) {
    out.push({
      level: q.user.level as "warn" | "full",
      text:
        q.user.level === "full"
          ? `Alcanzaste tu límite personal de ${q.user.limit} preguntas de hoy. Se renueva a las 00:00 UTC.`
          : `Has usado ${q.user.used} de tus ${q.user.limit} preguntas personales de hoy (${Math.round((q.user.used / q.user.limit) * 100)}%).`,
    });
  }
  if (bad(q.level)) {
    out.push({
      level: q.level as "warn" | "full",
      text:
        q.level === "full"
          ? `Tu organización alcanzó el límite de ${q.limit} preguntas de hoy. Se renueva a las 00:00 UTC; mientras tanto solo responderán las que ya estén en caché.`
          : `Tu organización ha usado ${q.used} de ${q.limit} preguntas de hoy (${Math.round((q.used / q.limit) * 100)}%). Se renueva a las 00:00 UTC.`,
    });
  }
  return out;
}

/** Aviso sobre el cuadro de escritura cuando se acerca (o llega) el límite diario de la organización o el personal. */
export function QuotaBanner() {
  const { data } = useQuota();
  const list = data ? notices(data) : [];
  if (list.length === 0) return null;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 sm:px-6">
      {list.map((n) => {
        const Icon = n.level === "full" ? CircleAlert : TriangleAlert;
        return (
          <p
            key={n.text}
            role="status"
            className={cn(
              "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
              n.level === "full" ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-warning/30 bg-warning/10 text-warning",
            )}
          >
            <Icon className="mt-0.5 size-4 shrink-0" />
            <span>{n.text}</span>
          </p>
        );
      })}
    </div>
  );
}
