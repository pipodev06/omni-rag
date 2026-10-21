import { CircleAlert, TriangleAlert } from "lucide-react";
import { useQuota } from "@/hooks/useQuota";
import { cn } from "@/lib/utils";

/** Aviso sobre el cuadro de escritura cuando la organización se acerca (o llega) al límite diario. */
export function QuotaBanner() {
  const { data } = useQuota();
  if (!data || (data.level !== "warn" && data.level !== "full")) return null;
  const full = data.level === "full";
  const Icon = full ? CircleAlert : TriangleAlert;
  return (
    <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
      <p
        role="status"
        className={cn(
          "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
          full ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-warning/30 bg-warning/10 text-warning",
        )}
      >
        <Icon className="mt-0.5 size-4 shrink-0" />
        <span>
          {full
            ? `Tu organización alcanzó el límite de ${data.limit} preguntas de hoy. Se renueva a las 00:00 UTC; mientras tanto solo responderán las que ya estén en caché.`
            : `Tu organización ha usado ${data.used} de ${data.limit} preguntas de hoy (${Math.round((data.used / data.limit) * 100)}%). Se renueva a las 00:00 UTC.`}
        </span>
      </p>
    </div>
  );
}
