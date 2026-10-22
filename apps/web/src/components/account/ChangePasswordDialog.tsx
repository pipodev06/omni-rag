import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Cambiar la contraseña desde una sesión abierta: contraseña nueva y repetirla. No pide la anterior.
 * Si la cuenta tiene verificación en dos pasos, pide además el código (una sesión robada no basta).
 */
export function ChangePasswordDialog({ open, onOpenChange, needsCode }: { open: boolean; onOpenChange: (o: boolean) => void; needsCode: boolean }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setPassword("");
      setConfirm("");
      setCode("");
    }
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return toast.error("Las contraseñas no coinciden");
    setBusy(true);
    try {
      await api.post("/auth/change-password", { newPassword: password, code: needsCode ? code : undefined });
      toast.success("Contraseña actualizada", { description: "Se cerró la sesión en tus otros dispositivos." });
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>Cambiar contraseña</DialogTitle>
            <DialogDescription>Usa al menos 10 caracteres. Se cerrará tu sesión en los demás dispositivos.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="pw-new">Nueva contraseña</Label>
              <Input id="pw-new" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} required autoFocus />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pw-confirm">Repite la nueva contraseña</Label>
              <Input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={10} required />
            </div>
            {needsCode && (
              <div className="space-y-2">
                <Label htmlFor="pw-code">Código de verificación</Label>
                <Input id="pw-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="6 dígitos de tu app" required />
                <p className="text-xs text-muted-foreground">Tienes la verificación en dos pasos activa: confirma que eres tú con un código.</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              Guardar contraseña
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
