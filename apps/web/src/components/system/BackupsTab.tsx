import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, CloudUpload, DatabaseBackup, FolderInput, HardDrive, Loader2, Play, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage, formatBytes, formatDate, timeAgo } from "@/api";
import { EmptyState, TableCard } from "@/components/common";
import { DestinationDialog, type BackupTargets } from "@/components/system/DestinationDialog";
import { ReauthDialog, type Confirm } from "@/components/system/ReauthDialog";
import { SettingsGroups, useReauthTotp } from "@/components/system/SettingsForm";
import { OpenAlerts, Tag, Tile, type OpenAlert } from "@/components/system/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface Backups {
  readAt: string | null;
  info: {
    mounted: boolean;
    copies: { stamp: string; at: string; dbBytes: number; uploadsBytes: number | null }[];
    totalBytes: number;
    failed: number;
    local: { attemptAt: string; ok: boolean; error: string; counts: string; at: string; intervalHours: number; nextAt: string; offsite: boolean; encrypted: boolean; keepDays: number } | null;
    targets: BackupTargets | null;
    destination: string;
    /** Bucket y claves de B2 guardados (en la pantalla o en el entorno). Sin ellos B2 está «no configurado», no fallando. */
    b2Configured: boolean;
    b2: { checkedAt: string; ok: boolean; error: string; lastOkAt: string; at: string; intervalHours: number; nextAt: string; syncUploads: boolean; keepDays: number } | null;
  } | null;
  alerts: OpenAlert[];
}

/** «8, 83, 724» (lo que cuenta la verificación) → texto legible. */
function describeCounts(counts: string): string | undefined {
  const [u, d, f] = counts.split(",").map((x) => x.trim());
  return u && d && f ? `${u} usuarios · ${d} documentos · ${f} fragmentos` : undefined;
}

const schedule = (at: string, hours: number) => (at ? `Diaria a las ${at}` : `Cada ${hours} h`);

interface BackupRequest {
  id: number;
  kind: "backup" | "destination" | "delete";
  payload: { path?: string; moveExisting?: boolean; stamp?: string } | null;
  requestedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  ok: boolean | null;
  message: string | null;
}

const requestState = (r: BackupRequest): { tone: "ok" | "bad" | "warn" | "muted"; label: string } =>
  r.finishedAt ? (r.ok ? { tone: "ok", label: "Correcta" } : { tone: "bad", label: "Falló" }) : r.startedAt ? { tone: "warn", label: "En curso" } : { tone: "muted", label: "En cola" };

const requestTitle = (r: BackupRequest) =>
  r.kind === "backup" ? "Copia manual" : r.kind === "delete" ? `Borrar la copia ${r.payload?.stamp ?? ""}` : `Cambio de destino${r.payload?.path ? ` a «${r.payload.path}»` : " a la carpeta clásica"}${r.payload?.moveExisting ? " (moviendo las copias)" : ""}`;

/** Órdenes enviadas al servicio de copias; se consulta cada 5 s mientras alguna no haya terminado. */
function useBackupRequests() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["system", "backups", "requests"],
    queryFn: () => api.get<{ requests: BackupRequest[] }>("/system/backups/requests"),
    refetchInterval: (q) => (q.state.data?.requests.some((r) => !r.finishedAt) ? 5_000 : false),
  });
  const pending = query.data?.requests.some((r) => !r.finishedAt) ?? false;
  const wasPending = useRef(false);
  // Al terminar una orden, la lista de copias y el destino cambian: se recargan una vez.
  useEffect(() => {
    if (wasPending.current && !pending) {
      void qc.invalidateQueries({ queryKey: ["system", "backups"], exact: true });
      void qc.invalidateQueries({ queryKey: ["system", "settings"] });
    }
    wasPending.current = pending;
  }, [pending, qc]);
  return { ...query, pending };
}

function RequestsTable({ requests }: { requests: BackupRequest[] }) {
  return (
    <div className="mb-4 shrink-0">
      <h2 className="mb-2 text-sm font-semibold">Órdenes recientes</h2>
      <TableCard className="max-h-56">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Fecha</TableHead>
              <TableHead>Orden</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="hidden md:table-cell">Resultado</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.map((r) => {
              const s = requestState(r);
              return (
                <TableRow key={r.id}>
                  <TableCell className="pl-4 font-mono text-xs whitespace-nowrap tabular-nums">{formatDate(r.createdAt)}</TableCell>
                  <TableCell className="text-sm">{requestTitle(r)}</TableCell>
                  <TableCell>
                    <Tag tone={s.tone}>{s.label}</Tag>
                  </TableCell>
                  <TableCell className="hidden max-w-xl text-sm text-muted-foreground md:table-cell">{r.message ?? "—"}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableCard>
    </div>
  );
}

export function BackupsTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["system", "backups"], queryFn: () => api.get<Backups>("/system/backups"), refetchInterval: 60_000 });
  const requests = useBackupRequests();
  const [destOpen, setDestOpen] = useState(false);
  const totp = useReauthTotp();
  const [toDelete, setToDelete] = useState<{ stamp: string; at: string } | null>(null);
  const remove = useMutation({
    mutationFn: ({ stamp, confirm }: { stamp: string; confirm: Confirm }) => api.post<{ id: number }>("/system/backups/delete", { stamp, confirm }),
    onSuccess: () => {
      setToDelete(null);
      toast.success("Orden enviada. La copia se borra en menos de un minuto.");
      return qc.invalidateQueries({ queryKey: ["system", "backups", "requests"] });
    },
  });
  const run = useMutation({
    mutationFn: () => api.post<{ id: number }>("/system/backups/run"),
    onSuccess: () => {
      toast.success("Orden enviada. La copia empieza en menos de un minuto.");
      return qc.invalidateQueries({ queryKey: ["system", "backups", "requests"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (isLoading || !data) return <Skeleton className="h-64 w-full" />;
  const info = data.info;
  if (!info || !info.mounted) {
    return (
      <EmptyState
        icon={DatabaseBackup}
        title={info ? "La carpeta de copias no está montada en el worker" : "Aún no hay datos de las copias"}
        description={
          info
            ? "El worker lee ./backups en solo lectura para comprobar las copias. Recrea los contenedores con «docker compose up -d»."
            : "El worker lee el estado de las copias cada 5 minutos. Si no aparece nada, revisa «docker compose logs worker backup»."
        }
      />
    );
  }
  const last = info.copies[0];
  const local = info.local;
  const b2 = info.b2;
  const targets = info.targets?.available ? info.targets : null;
  const destination = info.destination ?? "";
  const offsite = local ? (local.offsite ? (local.encrypted ? "Carpeta externa · cifrada" : "Carpeta externa · SIN cifrar") : "Solo en el servidor") : "—";
  const busy = run.isPending || requests.pending;

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <OpenAlerts alerts={data.alerts} />
      <div className="mb-4 flex shrink-0 flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => run.mutate()} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Play />} Hacer copia ahora
        </Button>
        <Button size="sm" variant="outline" onClick={() => setDestOpen(true)} disabled={!targets || requests.pending}>
          <FolderInput /> Cambiar destino
        </Button>
        <span className="font-mono text-xs text-muted-foreground">Destino: {destination || "carpeta clásica (./offsite)"}</span>
      </div>
      {!targets && (
        <div className="mb-4 flex shrink-0 items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <p className="text-muted-foreground">
            Para elegir aquí otro disco o carpeta, el servidor debe indicar una vez qué carpeta pueden usar las copias, porque un contenedor solo ve las carpetas que se le dan al arrancar (por seguridad, nunca el disco entero). Escribe en el archivo de entorno <span className="font-mono text-xs">BACKUP_TARGETS_DIR=/mnt</span> (o la carpeta donde se montan tus discos, p. ej. <span className="font-mono text-xs">/media/usuario</span>) y aplica con «docker compose up -d». Desde ese momento, los discos y carpetas de dentro se eligen con «Cambiar destino». Si ya lo hiciste, espera un minuto: el servicio de copias revisa los destinos cada 5 minutos.
          </p>
        </div>
      )}
      <div className="mb-4 grid shrink-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile icon={DatabaseBackup} label="Última copia" value={last ? timeAgo(last.at) : "Ninguna"} hint={last ? `${formatDate(last.at)} · ${formatBytes(last.dbBytes + (last.uploadsBytes ?? 0))}` : undefined} />
        <Tile
          icon={ShieldCheck}
          label="Último intento"
          value={local ? (local.ok ? "Correcto" : "Falló") : "—"}
          hint={local ? (local.ok ? (describeCounts(local.counts) ?? "Restaurada en una base de prueba") : local.error) : "backup.sh aún no anotó ningún intento"}
        />
        <Tile icon={CalendarClock} label="Próxima copia" value={local?.nextAt ? formatDate(local.nextAt) : "—"} hint={local ? `${schedule(local.at, local.intervalHours)} · se guardan ${local.keepDays} días` : undefined} />
        <Tile icon={HardDrive} label="Fuera del servidor" value={offsite} hint={`${info.copies.length} copia(s) · ${formatBytes(info.totalBytes)} en ./backups`} />
      </div>

      <div className="mb-4 flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border bg-card p-4 text-sm">
        <span className="flex items-center gap-2 font-medium">
          <CloudUpload className="size-4 text-muted-foreground" /> Backblaze B2
        </span>
        {!info.b2Configured ? (
          <>
            <Tag tone="muted">No configurado</Tag>
            <span className="text-muted-foreground">
              Opcional, pero recomendado: guarda una copia cifrada fuera del servidor por si se pierde el disco. Se configura en «Backblaze B2», más abajo, y necesita la copia externa activa y una frase de cifrado (docs/produccion.md).
            </span>
          </>
        ) : b2 ? (
          <>
            <Tag tone={b2.ok ? "ok" : "bad"}>{b2.ok ? "Funciona" : "Falla"}</Tag>
            {!b2.ok && <span className="text-destructive">{b2.error}</span>}
            <span className="text-muted-foreground">
              Última subida: <span className="font-mono text-xs">{b2.lastOkAt ? formatDate(b2.lastOkAt) : "ninguna"}</span>
            </span>
            {b2.nextAt && (
              <span className="text-muted-foreground">
                Próxima: <span className="font-mono text-xs">{formatDate(b2.nextAt)}</span>
              </span>
            )}
            <span className="text-muted-foreground">
              {schedule(b2.at, b2.intervalHours)} · {b2.syncUploads ? "base y archivos subidos" : "solo la base"} · se guardan {b2.keepDays} días
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">Configurado. El servicio backup-b2 aún no anotó ningún intento; si no cambia en unos minutos, revisa «docker compose logs backup-b2».</span>
        )}
      </div>

      {requests.data && requests.data.requests.length > 0 && <RequestsTable requests={requests.data.requests} />}

      {info.copies.length === 0 ? (
        <EmptyState icon={DatabaseBackup} title="No hay copias en ./backups" description="Pulsa «Hacer copia ahora» para crear la primera." className="mb-4" />
      ) : (
        <TableCard className="mb-4 max-h-80">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Fecha</TableHead>
                <TableHead className="hidden sm:table-cell">Archivo</TableHead>
                <TableHead className="text-right">Base de datos</TableHead>
                <TableHead className="text-right">Archivos subidos</TableHead>
                <TableHead className="w-12 pr-4">
                  <span className="sr-only">Acciones</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {info.copies.map((c, i) => (
                <TableRow key={c.stamp}>
                  <TableCell className="pl-4 font-mono text-xs whitespace-nowrap tabular-nums">{formatDate(c.at)}</TableCell>
                  <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">db_{c.stamp}.dump</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{formatBytes(c.dbBytes)}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{c.uploadsBytes === null ? "—" : formatBytes(c.uploadsBytes)}</TableCell>
                  <TableCell className="pr-4 text-right">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8 text-muted-foreground hover:text-destructive"
                      aria-label={`Eliminar la copia del ${formatDate(c.at)}`}
                      title={i === 0 ? "La copia más reciente no se puede eliminar" : "Eliminar esta copia"}
                      disabled={i === 0 || requests.pending}
                      onClick={() => setToDelete({ stamp: c.stamp, at: c.at })}
                    >
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableCard>
      )}
      {info.failed > 0 && <p className="mb-4 shrink-0 text-xs text-muted-foreground">{info.failed} copia(s) fallida(s) apartada(s) como «.dump.fallida»; se borran a los {local?.keepDays ?? 7} días.</p>}

      <SettingsGroups ids={["backup", "b2"]} />
      <ReauthDialog
        open={toDelete !== null}
        onCancel={() => setToDelete(null)}
        totp={totp}
        action={toDelete ? `Vas a eliminar la copia del ${formatDate(toDelete.at)} de este servidor y de la carpeta externa (en Backblaze B2 se conserva hasta caducar).` : undefined}
        onConfirm={(confirm) => remove.mutateAsync({ stamp: toDelete!.stamp, confirm })}
      />
      {targets && <DestinationDialog open={destOpen} onOpenChange={setDestOpen} targets={targets} current={destination} />}
    </div>
  );
}

