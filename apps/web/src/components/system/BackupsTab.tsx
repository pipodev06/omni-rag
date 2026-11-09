import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, CalendarClock, ChevronDown, CloudUpload, DatabaseBackup, FolderInput, HardDrive, Loader2, Play, Settings2, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage, formatBytes, formatDate, timeAgo } from "@/api";
import { cn } from "@/lib/utils";
import { EmptyState, SelectionBar, TableCard } from "@/components/common";
import { DestinationDialog, type BackupTargets } from "@/components/system/DestinationDialog";
import { ReauthDialog, type Confirm } from "@/components/system/ReauthDialog";
import { PassphraseTile, type PassphraseSource } from "@/components/system/PassphraseTile";
import { RestoreDialog, type RestoreCopy } from "@/components/system/RestoreDialog";
import { SettingsGroups, useReauthTotp } from "@/components/system/SettingsForm";
import { OpenAlerts, Tile, type OpenAlert } from "@/components/system/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
  /** De dónde sale la frase de cifrado (nunca su valor). */
  passphrase: PassphraseSource;
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
  payload: { path?: string; moveExisting?: boolean; stamp?: string; stamps?: string[] } | null;
  requestedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  ok: boolean | null;
  message: string | null;
}

const requestTitle = (r: BackupRequest) => {
  if (r.kind === "backup") return "Copia manual";
  if (r.kind === "delete") {
    const stamps = r.payload?.stamps ?? (r.payload?.stamp ? [r.payload.stamp] : []);
    return stamps.length === 1 ? `Borrar la copia ${stamps[0]}` : `Borrar ${stamps.length} copias`;
  }
  return `Cambio de destino${r.payload?.path ? ` a «${r.payload.path}»` : " a la carpeta clásica"}${r.payload?.moveExisting ? " (moviendo las copias)" : ""}`;
};

/**
 * Órdenes enviadas al servicio de copias; se consulta cada 5 s mientras alguna no haya terminado. Al terminar una que se
 * vio pendiente, su resultado sale en un aviso (el historial completo queda en la auditoría).
 */
function useBackupRequests() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["system", "backups", "requests"],
    queryFn: () => api.get<{ requests: BackupRequest[] }>("/system/backups/requests"),
    refetchInterval: (q) => (q.state.data?.requests.some((r) => !r.finishedAt) ? 5_000 : false),
  });
  const requests = query.data?.requests ?? [];
  const running = requests.find((r) => !r.finishedAt) ?? null;
  const watching = useRef(new Set<number>());
  useEffect(() => {
    let finished = false;
    for (const r of requests) {
      if (!r.finishedAt) {
        watching.current.add(r.id);
      } else if (watching.current.delete(r.id)) {
        finished = true;
        const text = `${requestTitle(r)}: ${r.message ?? (r.ok ? "hecho" : "falló")}`;
        if (r.ok) toast.success(text);
        else toast.error(text);
      }
    }
    // Al terminar una orden, la lista de copias y el destino cambian: se recargan una vez.
    if (finished) {
      void qc.invalidateQueries({ queryKey: ["system", "backups"], exact: true });
      void qc.invalidateQueries({ queryKey: ["system", "settings"] });
    }
  }, [requests, qc]);
  return { running, pending: running !== null };
}

/** Orden en marcha (o en cola) mientras el servicio de copias la atiende. */
function RunningOrder({ order }: { order: BackupRequest }) {
  return (
    <div className="mb-4 flex shrink-0 items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
      <Loader2 className="size-4 animate-spin text-muted-foreground" />
      <span className="font-medium">{requestTitle(order)}</span>
      <span className="text-muted-foreground">{order.startedAt ? "en curso…" : "en cola: empieza en menos de un minuto"}</span>
    </div>
  );
}

export function BackupsTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["system", "backups"], queryFn: () => api.get<Backups>("/system/backups"), refetchInterval: 60_000 });
  const requests = useBackupRequests();
  const [destOpen, setDestOpen] = useState(false);
  const totp = useReauthTotp();
  // Copias a borrar (una desde su fila o varias desde la barra de selección) y su texto para la reconfirmación.
  const [toDelete, setToDelete] = useState<{ stamps: string[]; label: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [toRestore, setToRestore] = useState<RestoreCopy | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const remove = useMutation({
    mutationFn: ({ stamps, confirm }: { stamps: string[]; confirm: Confirm }) => api.post<{ id: number }>("/system/backups/delete", { stamps, confirm }),
    onSuccess: (_r, { stamps }) => {
      setToDelete(null);
      setSelected(new Set());
      toast.success(`Orden enviada. ${stamps.length === 1 ? "La copia se borra" : `Las ${stamps.length} copias se borran`} en menos de un minuto.`);
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
  // La más reciente no se borra (siempre queda al menos una).
  const deletable = info.copies.slice(1);
  // Sin copia externa (B2 la necesita) todas las copias viven en el mismo disco que los datos.
  const onlyHere = local !== null && !local.offsite;

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto pr-3">
      <OpenAlerts alerts={data.alerts} />
      <div className="mb-4 flex shrink-0 flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => run.mutate()} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Play />} Hacer copia ahora
        </Button>
        {/* Solo con carpetas que elegir (BACKUP_TARGETS_DIR en el servidor): si no, no hay nada que cambiar. */}
        {targets && (
          <>
            <Button size="sm" variant="outline" onClick={() => setDestOpen(true)} disabled={requests.pending}>
              <FolderInput /> Cambiar destino
            </Button>
            <span className="font-mono text-xs text-muted-foreground">Destino: {destination || "carpeta clásica (./offsite)"}</span>
          </>
        )}
      </div>
      {requests.running && <RunningOrder order={requests.running} />}
      <div className="mb-4 grid shrink-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Tile icon={DatabaseBackup} label="Última copia" value={last ? timeAgo(last.at) : "Ninguna"} hint={last ? `${formatDate(last.at)} · ${formatBytes(last.dbBytes + (last.uploadsBytes ?? 0))}` : undefined} />
        <Tile
          icon={ShieldCheck}
          label="Último intento"
          value={local ? (local.ok ? "Correcto" : "Falló") : "—"}
          hint={local ? (local.ok ? (describeCounts(local.counts) ?? "Restaurada en una base de prueba") : local.error) : "backup.sh aún no anotó ningún intento"}
        />
        <Tile icon={CalendarClock} label="Próxima copia" value={local?.nextAt ? formatDate(local.nextAt) : "—"} hint={local ? `${schedule(local.at, local.intervalHours)} · se guardan ${local.keepDays} días` : undefined} />
        <Tile
          icon={HardDrive}
          label="Fuera del servidor"
          value={offsite}
          warn={onlyHere}
          hint={onlyHere ? "Si se pierde el disco, se pierden también las copias. Actívala en «Ajustes»." : `${info.copies.length} copia(s) · ${formatBytes(info.totalBytes)} en ./backups`}
        />
        <Tile
          icon={CloudUpload}
          label="Backblaze B2"
          value={!info.b2Configured ? "No configurado" : !b2 ? "Esperando" : b2.ok ? "Funciona" : "Falla"}
          warn={info.b2Configured && b2 !== null && !b2.ok}
          hint={
            !info.b2Configured
              ? "Opcional: copia cifrada en la nube. Se activa en «Ajustes»."
              : !b2
                ? "backup-b2 aún no anotó ningún intento."
                : !b2.ok
                  ? b2.error
                  : `Última: ${b2.lastOkAt ? formatDate(b2.lastOkAt) : "ninguna"}${b2.nextAt ? ` · próxima: ${formatDate(b2.nextAt)}` : ""} · ${b2.keepDays} días`
          }
        />
        <PassphraseTile source={data.passphrase} totp={totp} />
      </div>

      {info.copies.length === 0 ? (
        <EmptyState icon={DatabaseBackup} title="No hay copias en ./backups" description="Pulsa «Hacer copia ahora» para crear la primera." className="mb-4" />
      ) : (
        <>
        <SelectionBar count={selected.size} onClear={() => setSelected(new Set())} className="mb-2">
          <Button
            size="sm"
            variant="destructive"
            disabled={requests.pending}
            onClick={() => setToDelete({ stamps: [...selected], label: `Vas a eliminar ${selected.size === 1 ? "1 copia" : `${selected.size} copias`} de este servidor y de la carpeta externa (en Backblaze B2 se conservan hasta caducar).` })}
          >
            <Trash2 /> Eliminar
          </Button>
        </SelectionBar>
        <TableCard className="mb-4">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10 pl-4">
                  <Checkbox
                    aria-label="Seleccionar todas las copias que se pueden borrar"
                    checked={selected.size === 0 ? false : selected.size === deletable.length ? true : "indeterminate"}
                    onCheckedChange={(v) => setSelected(v === true ? new Set(deletable.map((c) => c.stamp)) : new Set())}
                    disabled={deletable.length === 0}
                  />
                </TableHead>
                <TableHead>Fecha</TableHead>
                <TableHead className="hidden sm:table-cell">Archivo</TableHead>
                <TableHead className="text-right">Base de datos</TableHead>
                <TableHead className="text-right">Archivos subidos</TableHead>
                <TableHead className="w-24 pr-4">
                  <span className="sr-only">Acciones</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {info.copies.map((c, i) => (
                <TableRow key={c.stamp} data-state={selected.has(c.stamp) ? "selected" : undefined}>
                  <TableCell className="w-10 pl-4">
                    <Checkbox
                      aria-label={i === 0 ? "La copia más reciente no se puede borrar" : `Seleccionar la copia del ${formatDate(c.at)}`}
                      checked={selected.has(c.stamp)}
                      disabled={i === 0}
                      onCheckedChange={(v) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (v === true) next.add(c.stamp);
                          else next.delete(c.stamp);
                          return next;
                        })
                      }
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-nowrap tabular-nums">{formatDate(c.at)}</TableCell>
                  <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">db_{c.stamp}.dump</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{formatBytes(c.dbBytes)}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{c.uploadsBytes === null ? "—" : formatBytes(c.uploadsBytes)}</TableCell>
                  <TableCell className="pr-4 text-right whitespace-nowrap">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8 text-muted-foreground hover:text-foreground"
                      aria-label={`Cómo restaurar la copia del ${formatDate(c.at)}`}
                      title="Cómo restaurar esta copia"
                      onClick={() => setToRestore({ stamp: c.stamp, at: c.at, hasUploads: c.uploadsBytes !== null })}
                    >
                      <ArchiveRestore />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8 text-muted-foreground hover:text-destructive"
                      aria-label={`Eliminar la copia del ${formatDate(c.at)}`}
                      title={i === 0 ? "La copia más reciente no se puede eliminar" : "Eliminar esta copia"}
                      disabled={i === 0 || requests.pending}
                      onClick={() => setToDelete({ stamps: [c.stamp], label: `Vas a eliminar la copia del ${formatDate(c.at)} de este servidor y de la carpeta externa (en Backblaze B2 se conserva hasta caducar).` })}
                    >
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableCard>
        </>
      )}
      {info.failed > 0 && <p className="mb-4 shrink-0 text-xs text-muted-foreground">{info.failed} copia(s) fallida(s) apartada(s) como «.dump.fallida»; se borran a los {local?.keepDays ?? 7} días.</p>}

      <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen} className="mb-4">
        <CollapsibleTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2">
            <Settings2 /> Ajustes de copias y Backblaze B2
            <ChevronDown className={cn("transition-transform", settingsOpen && "rotate-180")} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-4">
          <SettingsGroups ids={["backup", "b2"]} />
        </CollapsibleContent>
      </Collapsible>
      <RestoreDialog copy={toRestore} onClose={() => setToRestore(null)} />
      <ReauthDialog
        open={toDelete !== null}
        onCancel={() => setToDelete(null)}
        totp={totp}
        action={toDelete?.label}
        onConfirm={(confirm) => remove.mutateAsync({ stamps: toDelete!.stamps, confirm })}
      />
      {targets && <DestinationDialog open={destOpen} onOpenChange={setDestOpen} targets={targets} current={destination} />}
    </div>
  );
}

