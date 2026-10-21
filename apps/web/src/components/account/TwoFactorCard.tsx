import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Download, Loader2, ShieldCheck, ShieldOff } from "lucide-react";
import QRCode from "qrcode";
import { toast } from "sonner";
import { api, errorMessage } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Step = { kind: "idle" } | { kind: "scan"; secret: string; qr: string } | { kind: "codes"; codes: string[] };

/** Códigos de recuperación: se muestran una sola vez al activar el 2FA. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("No se pudo copiar; selecciónalos y cópialos a mano");
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([`Códigos de recuperación\n\n${text}\n`], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "codigos-de-recuperacion.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Guarda estos códigos en un lugar seguro. Cada uno sirve <b className="font-medium text-foreground">una sola vez</b> si pierdes el teléfono. No volverán a mostrarse.
      </p>
      <ul className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-4 font-mono text-sm">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => void copy()}>
          {copied ? <Check className="text-success" /> : <Copy />} {copied ? "Copiados" : "Copiar"}
        </Button>
        <Button variant="outline" onClick={download}>
          <Download /> Descargar
        </Button>
        <Button onClick={onDone}>Ya los guardé</Button>
      </div>
    </div>
  );
}

function DisableDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/auth/totp/disable", { password, code });
      toast.success("Verificación en dos pasos desactivada");
      setPassword("");
      setCode("");
      onOpenChange(false);
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>Desactivar la verificación en dos pasos</DialogTitle>
            <DialogDescription>Confirma con tu contraseña y un código de tu app (o uno de recuperación).</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="d-pass">Contraseña</Label>
              <Input id="d-pass" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
            </div>
            <div className="space-y-2">
              <Label htmlFor="d-code">Código</Label>
              <Input id="d-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="destructive" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              Desactivar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Tarjeta «Verificación en dos pasos» de Mi cuenta (opcional). */
export function TwoFactorCard({ enabled, recommended }: { enabled: boolean; recommended: boolean }) {
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["session"] });

  const start = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ secret: string; otpauthUrl: string }>("/auth/totp/setup");
      setStep({ kind: "scan", secret: r.secret, qr: await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 192 }) });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post<{ recoveryCodes: string[] }>("/auth/totp/enable", { code });
      setCode("");
      setStep({ kind: "codes", codes: r.recoveryCodes });
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Verificación en dos pasos
          {enabled && step.kind !== "codes" && <Badge variant="secondary">Activa</Badge>}
        </CardTitle>
        <CardDescription>
          {recommended
            ? "Recomendada para la cuenta del dueño de la plataforma: protege los planes y el acceso a todas las organizaciones."
            : "Añade un código de tu app autenticadora al iniciar sesión. Es opcional."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {step.kind === "codes" ? (
          <RecoveryCodes codes={step.codes} onDone={() => setStep({ kind: "idle" })} />
        ) : step.kind === "scan" ? (
          <form onSubmit={confirm} className="space-y-4">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>Abre tu app autenticadora (Google Authenticator, Aegis, 1Password…).</li>
              <li>Escanea el código QR, o escribe la clave a mano.</li>
              <li>Escribe aquí el código de 6 dígitos que muestra.</li>
            </ol>
            <div className="flex flex-wrap items-center gap-4">
              <img src={step.qr} alt="Código QR para la app autenticadora" className="size-48 rounded-lg border bg-white p-1" />
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Clave manual</p>
                <p className="font-mono text-sm break-all select-all">{step.secret.match(/.{1,4}/g)?.join(" ")}</p>
              </div>
            </div>
            <div className="max-w-xs space-y-2">
              <Label htmlFor="totp-code">Código de 6 dígitos</Label>
              <Input id="totp-code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 className="animate-spin" />}
                Activar
              </Button>
              <Button type="button" variant="outline" onClick={() => setStep({ kind: "idle" })}>
                Cancelar
              </Button>
            </div>
          </form>
        ) : enabled ? (
          <Button variant="outline" onClick={() => setDisableOpen(true)}>
            <ShieldOff /> Desactivar
          </Button>
        ) : (
          <Button onClick={() => void start()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Activar
          </Button>
        )}
      </CardContent>
      <DisableDialog open={disableOpen} onOpenChange={setDisableOpen} onDone={refresh} />
    </Card>
  );
}
