import { useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/api";
import { ReauthDialog, type Confirm } from "@/components/system/ReauthDialog";
import { Tile } from "@/components/system/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type PassphraseSource = "env" | "generated" | "unreadable" | null;

/**
 * Frase que cifra las copias externas y las de B2. Se genera sola en el primer arranque; «Ver frase» la muestra tras
 * reconfirmar la identidad (queda en la auditoría y se avisa a ALERT_EMAIL) para guardarla fuera del servidor.
 */
export function PassphraseTile({ source, totp }: { source: PassphraseSource; totp: boolean }) {
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
    <>
      <Tile
        icon={KeyRound}
        label="Frase de cifrado"
        value={source === "env" ? "Del entorno" : source === "generated" ? "Generada" : source === "unreadable" ? "No se puede leer" : "No hay"}
        warn={source === "unreadable" || source === null}
        hint={
          source === "unreadable"
            ? "./data/secretos/backup_passphrase no es del usuario 1000. Recrea db."
            : source
              ? "Cifra la copia externa y la de B2. Guárdala fuera del servidor."
              : "Se genera al arrancar db («docker compose up -d»)."
        }
        action={
          source === "env" || source === "generated" ? (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setAsking(true)}>
              Ver frase
            </Button>
          ) : undefined
        }
      />
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
    </>
  );
}
