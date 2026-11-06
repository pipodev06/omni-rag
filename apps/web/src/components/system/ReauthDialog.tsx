import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { ApiError, errorMessage } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Reconfirmación de identidad que la API exige en `confirm` al guardar ajustes y cambiar el destino de las copias. */
export interface Confirm {
  password: string;
  code?: string;
}

interface Props {
  open: boolean;
  onCancel: () => void;
  /** El usuario tiene la verificación en dos pasos activa: se pide también el código. */
  totp: boolean;
  /** Qué se va a hacer, si conviene recordarlo (p. ej. al borrar algo). */
  action?: string;
  /** Envía la acción con `confirm`; si falla con REAUTH_*, el mensaje se muestra aquí y el modal sigue abierto. Quien llama lo cierra al terminar bien. */
  onConfirm: (confirm: Confirm) => Promise<unknown>;
}

const REAUTH_REQUIRED_TEXT = "Confirma tu identidad para continuar";

export function ReauthDialog({ open, onCancel, totp, action, onConfirm }: Props) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-sm">
        {/* Se desmonta al cerrar: cada apertura empieza vacía. */}
        <ReauthForm totp={totp} action={action} onCancel={onCancel} onConfirm={onConfirm} />
      </DialogContent>
    </Dialog>
  );
}

function ReauthForm({ totp, action, onCancel, onConfirm }: Omit<Props, "open">) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // El formulario está en un portal: sin esto, el submit subiría al formulario que abrió el modal.
    e.stopPropagation();
    setPending(true);
    setError(null);
    try {
      await onConfirm({ password, ...(totp ? { code: code.trim() } : {}) });
    } catch (err) {
      if (err instanceof ApiError && err.code === "REAUTH_FAILED") setError(err.message);
      else if (err instanceof ApiError && err.code === "REAUTH_REQUIRED") setError(REAUTH_REQUIRED_TEXT);
      else toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>Confirma tu identidad</DialogTitle>
        <DialogDescription>
          {action && `${action} `}
          {totp ? "Escribe tu contraseña y el código de verificación." : "Escribe tu contraseña."}
        </DialogDescription>
      </DialogHeader>
      <div className="grid items-start gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="reauth-password">Contraseña</Label>
          <Input id="reauth-password" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={error !== null} />
        </div>
        {totp && (
          <div className="space-y-1.5">
            <Label htmlFor="reauth-code">Código</Label>
            <Input id="reauth-code" autoComplete="one-time-code" inputMode="text" maxLength={20} placeholder="6 dígitos o de recuperación" value={code} onChange={(e) => setCode(e.target.value)} aria-invalid={error !== null} />
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
        <Button type="submit" disabled={password === "" || (totp && code.trim() === "") || pending}>
          {pending && <Loader2 className="animate-spin" />} Confirmar
        </Button>
      </DialogFooter>
    </form>
  );
}
