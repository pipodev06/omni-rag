import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { api, formatBytes } from "@/api";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ConfirmProvider";
import { ReauthDialog, type Confirm } from "@/components/system/ReauthDialog";
import { useReauthTotp } from "@/components/system/SettingsForm";
import { Tag } from "@/components/system/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface BackupTargets {
  root: string;
  available: boolean;
  dirs: { path: string; sameDisk: boolean; freeBytes: number; writable: boolean }[];
}

const CLASSIC = "\0classic";
const PATH_RE = /^[A-Za-z0-9 _.\-/]{0,200}$/;

function validate(path: string): string | null {
  if (!PATH_RE.test(path)) return "Usa solo letras, números, espacios y los signos _ . - /";
  if (path.startsWith("/") || path.split("/").includes("..")) return "La ruta debe ser relativa y sin «..»";
  return null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targets: BackupTargets;
  /** Destino efectivo ahora: ruta relativa dentro de los destinos, o vacío si usa la carpeta clásica. */
  current: string;
}

export function DestinationDialog({ open, onOpenChange, targets, current }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* Se desmonta al cerrar: cada apertura empieza con el destino actual. */}
        <DestinationForm targets={targets} current={current} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function DestinationForm({ targets, current, onClose }: Omit<Props, "open" | "onOpenChange"> & { onClose: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [base, setBase] = useState<string>(current === "" ? CLASSIC : (targets.dirs.find((d) => d.path === current)?.path ?? current));
  const [sub, setSub] = useState("");
  const [move, setMove] = useState(false);
  const totp = useReauthTotp();
  const [reauth, setReauth] = useState(false);
  const change = useMutation({
    mutationFn: (body: { path: string; moveExisting: boolean; confirm: Confirm }) => api.post<{ id: number }>("/system/backups/destination", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["system", "backups"] });
      toast.success("Orden enviada. El servicio de copias la atiende en menos de un minuto.");
      onClose();
    },
  });

  const classic = base === CLASSIC;
  const path = classic ? "" : [base, sub.trim().replace(/^\/+|\/+$/g, "")].filter(Boolean).join("/");
  const problem = classic ? null : validate(path);
  const unchanged = path === current;
  const picked = targets.dirs.find((d) => d.path === base);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (move && !(await confirm({ title: "¿Llevar las copias existentes?", description: "Se copiarán a la nueva carpeta y, solo si la comparación sale exacta, se borrarán de la anterior.", confirmText: "Cambiar y mover" }))) return;
    setReauth(true);
  };

  return (
    <>
    <form onSubmit={submit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>Cambiar destino de las copias</DialogTitle>
        <DialogDescription>Carpeta externa donde se guardan las copias.</DialogDescription>
      </DialogHeader>

      <div role="radiogroup" aria-label="Destino" className="max-h-56 space-y-1.5 overflow-y-auto">
        {[{ value: CLASSIC, title: "Carpeta clásica del servidor", note: "./offsite", disabled: false, tags: [] as string[] }, ...targets.dirs.map((d) => ({ value: d.path, title: d.path, note: `${formatBytes(d.freeBytes)} libres`, disabled: !d.writable, tags: [...(d.sameDisk ? ["Mismo disco que el servidor"] : []), ...(d.writable ? [] : ["Sin permiso de escritura"])] }))].map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={base === o.value}
            disabled={o.disabled}
            onClick={() => setBase(o.value)}
            className={cn("flex w-full items-center gap-3 rounded-lg border p-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", base === o.value ? "border-primary bg-primary/5" : "hover:bg-muted/50")}
          >
            {base === o.value ? <Check className="size-4 shrink-0 text-primary" /> : <FolderOpen className="size-4 shrink-0 text-muted-foreground" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{o.title}</span>
              <span className="block font-mono text-xs text-muted-foreground">{o.note}</span>
            </span>
            {o.value === (current === "" ? CLASSIC : current) && <Tag tone="muted">Actual</Tag>}
            {o.tags.map((t) => (
              <Tag key={t} tone="warn">
                {t}
              </Tag>
            ))}
          </button>
        ))}
      </div>

      {!classic && (
        <div className="space-y-1.5">
          <Label htmlFor="dest-sub">Subcarpeta nueva</Label>
          <Input id="dest-sub" value={sub} onChange={(e) => setSub(e.target.value)} placeholder="copias-omni" maxLength={100} />
          <p className="font-mono text-xs text-muted-foreground">Ruta: {path || "(raíz de los destinos)"}</p>
          {problem && <p className="text-xs text-destructive">{problem}</p>}
          {picked?.sameDisk && <p className="text-xs text-warning">Este destino está en el mismo disco que el servidor: no protege si el disco falla.</p>}
        </div>
      )}

      <div className="flex items-start gap-2">
        <Checkbox id="dest-move" checked={move} onCheckedChange={(c) => setMove(c === true)} className="mt-0.5" />
        <div className="space-y-1">
          <Label htmlFor="dest-move">Llevar las copias existentes a la nueva carpeta</Label>
          <p className="text-xs text-muted-foreground">Si no la marcas, las copias anteriores se quedan donde están y solo las nuevas se crean en el destino elegido.</p>
        </div>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancelar
        </Button>
        <Button type="submit" disabled={problem !== null || unchanged || reauth}>
          Cambiar destino
        </Button>
      </DialogFooter>
    </form>
    {/* Fuera del <form>: los eventos de React suben por los portales y un submit interno enviaría este formulario. */}
    <ReauthDialog open={reauth} onCancel={() => setReauth(false)} totp={totp} onConfirm={(confirm) => change.mutateAsync({ path, moveExisting: move, confirm })} />
    </>
  );
}
