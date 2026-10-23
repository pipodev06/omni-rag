import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Modal para cambiar el nombre de algo (documento, conversación…): un solo campo, Enter guarda y Escape cierra.
 * `current` es el nombre actual (`null` = cerrado). `onSave` hace la petición; si lanza un error se muestra y el modal sigue abierto.
 */
export function RenameDialog({ current, title, description, label = "Título", maxLength = 120, successMessage = "Título actualizado", onOpenChange, onSave }: {
  current: string | null;
  title: string;
  description?: string;
  label?: string;
  maxLength?: number;
  successMessage?: string;
  onOpenChange: (open: boolean) => void;
  onSave: (value: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (current !== null) setValue(current);
  }, [current]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave(value.trim());
      toast.success(successMessage);
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={current !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rename-value">{label}</Label>
            <Input id="rename-value" value={value} onChange={(e) => setValue(e.target.value)} maxLength={maxLength} required autoFocus onFocus={(e) => e.currentTarget.select()} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy || value.trim() === "" || value.trim() === current}>
              {busy && <Loader2 className="animate-spin" />}
              Guardar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
