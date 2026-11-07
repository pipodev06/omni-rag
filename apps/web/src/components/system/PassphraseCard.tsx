import { useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/api";
import { ReauthDialog, type Confirm } from "@/components/system/ReauthDialog";
import { Tag } from "@/components/system/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type PassphraseSource = "env" | "generated" | "unreadable" | null;

/**
 * Frase que cifra las copias externas y las de B2. Se genera sola en el primer arranque; «Ver frase» la muestra tras
 * reconfirmar la identidad (queda en la auditoría y se avisa a ALERT_EMAIL) para guardarla fuera del servidor.
 */
export function PassphraseCard({ source, totp }: { source: PassphraseSource; totp: boolean }) {
  const [asking, setAsking] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reveal = async (confirm: Confirm) => {
    const r = await api.post<{ passphrase: string }>("/system/backups/passphrase", { confirm });
    setAsking(false);
    setShown(r.passphrase);
  };
  const copy = async () => {
    if (!shown) return;
    try {
      await navigator.clipboard.writeText(shown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("No se pudo copiar; selecciónala y cópiala a mano");
    }
  };

  return (
    <div className="mb-4 flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border bg-card p-4 text-sm">
      <span className="flex items-center gap-2 font-medium">
        <KeyRound className="size-4 text-muted-foreground" /> Frase de cifrado
      </span>
      {source === "unreadable" ? (
        <Tag tone="bad">No se puede leer</Tag>
      ) : source ? (
        <Tag tone="ok">{source === "env" ? "Fijada en el archivo de entorno" : "Generada en el servidor"}</Tag>
      ) : (
        <Tag tone="bad">No hay</Tag>
      )}
      <span className="min-w-0 flex-1 text-muted-foreground">
        {source === "unreadable"
          ? "El archivo ./data/secretos/backup_passphrase existe pero no es del usuario 1000: B2 no sube nada. Recrea db con «docker compose up -d db»."
          : source
            ? "Cifra la copia externa y la de Backblaze B2. Guárdala en tu gestor de contraseñas: si se pierde el servidor, sin ella esas copias no se pueden abrir."
            : "Se genera al arrancar el servicio db. Recrea los contenedores con «docker compose up -d»."}
      </span>
      {(source === "env" || source === "generated") && (
        <Button size="sm" variant="outline" onClick={() => setAsking(true)}>
          Ver frase
        </Button>
      )}
      <ReauthDialog open={asking} onCancel={() => setAsking(false)} totp={totp} action="Vas a ver la frase que cifra las copias de seguridad. Quedará en la auditoría y se avisará por correo a los destinatarios de las alertas." onConfirm={reveal} />
      <Dialog open={shown !== null} onOpenChange={(o) => !o && (setShown(null), setCopied(false))}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Frase de cifrado de las copias</DialogTitle>
            <DialogDescription>Guárdala en un gestor de contraseñas, fuera de este servidor. No la compartas: con ella y las copias se lee toda la base.</DialogDescription>
          </DialogHeader>
          <pre className="rounded-md border bg-muted p-3 font-mono text-sm break-all whitespace-pre-wrap">{shown}</pre>
          <div className="flex justify-end">
            <Button type="button" size="sm" onClick={copy}>
              {copied ? <Check /> : <Copy />} {copied ? "Copiada" : "Copiar"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
