import { useState } from "react";
import { Check, Copy, MailCheck, MailX } from "lucide-react";
import { toast } from "sonner";
import type { LinkResult } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/**
 * Muestra el enlace de invitación o de restablecimiento recién creado.
 * Si el correo no está configurado (o falló), el administrador lo copia y lo
 * envía por otro medio.
 */
export function LinkResultDialog({ result, email, onClose }: { result: LinkResult | null; email?: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const invite = result?.kind === "invite";

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("No se pudo copiar; selecciona el enlace y cópialo a mano");
    }
  };

  return (
    <Dialog open={result !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{invite ? "Invitación creada" : "Enlace para restablecer la contraseña"}</DialogTitle>
          <DialogDescription>
            {invite
              ? "Con este enlace la persona elige su contraseña y entra por primera vez."
              : "Con este enlace la persona elige una nueva contraseña. El anterior deja de funcionar."}
          </DialogDescription>
        </DialogHeader>
        {result && (
          <>
            <div className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${result.emailSent ? "border-success/30 bg-success/10" : "bg-muted/50"}`}>
              {result.emailSent ? <MailCheck className="mt-0.5 size-4 shrink-0 text-success" /> : <MailX className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
              <p>
                {result.emailSent
                  ? `Se envió por correo${email ? ` a ${email}` : ""}. También puedes copiarlo:`
                  : "El envío de correos no está configurado (o falló). Copia el enlace y envíaselo por un canal seguro:"}
              </p>
            </div>
            <div className="flex gap-2">
              <Input readOnly value={result.url} onFocus={(e) => e.target.select()} className="font-mono text-xs" aria-label="Enlace" />
              <Button variant="outline" onClick={() => void copy()} aria-label="Copiar enlace">
                {copied ? <Check className="text-success" /> : <Copy />}
                {copied ? "Copiado" : "Copiar"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Es de un solo uso y caduca; no lo publiques en sitios abiertos.</p>
          </>
        )}
        <DialogFooter>
          <Button onClick={onClose}>Listo</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
