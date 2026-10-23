import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, LogOut, Monitor, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage, timeAgo } from "@/api";
import { describeDevice } from "@/lib/device";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface SessionInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

/** Dispositivos con la cuenta abierta, con «Cerrar» en cada uno y «Cerrar todas las sesiones» (también esta). */
export function SessionsCard({ closingAll, onCloseAll }: { closingAll: boolean; onCloseAll: () => void }) {
  const qc = useQueryClient();
  const [closing, setClosing] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api.get<{ sessions: SessionInfo[] }>("/auth/sessions"),
    refetchInterval: 60_000,
  });
  const sessions = data?.sessions ?? [];

  const close = async (s: SessionInfo) => {
    setClosing(s.id);
    try {
      await api.del(`/auth/sessions/${s.id}`);
      toast.success("Sesión cerrada");
      await qc.invalidateQueries({ queryKey: ["sessions"] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setClosing(null);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-1">
            <CardTitle>Sesiones</CardTitle>
            <CardDescription>Dispositivos en los que tienes la cuenta abierta. Cierra los que no reconozcas o los que ya no uses.</CardDescription>
          </div>
          <Button variant="outline" onClick={onCloseAll} disabled={closingAll}>
            {closingAll ? <Loader2 className="animate-spin" /> : <LogOut />} Cerrar todas las sesiones
          </Button>
        </div>

        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No hay otras sesiones registradas. Las abiertas antes de la última actualización aparecerán al volver a iniciar sesión.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {sessions.map((s) => {
              const device = describeDevice(s.userAgent);
              const Icon = device.mobile ? Smartphone : Monitor;
              return (
                <li key={s.id} className="flex items-center gap-3 px-3 py-2.5">
                  <Icon className="size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {device.label}
                      {s.current && <Badge variant="secondary">Esta sesión</Badge>}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {s.ip ?? "IP desconocida"} · iniciada {timeAgo(s.createdAt)} · activa {timeAgo(s.lastSeenAt)}
                    </p>
                  </div>
                  {!s.current && (
                    <Button size="sm" variant="outline" disabled={closing === s.id} onClick={() => void close(s)}>
                      {closing === s.id && <Loader2 className="animate-spin" />} Cerrar
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
