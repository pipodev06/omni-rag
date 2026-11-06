import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, Lock, Mail, User } from "lucide-react";
import { api, ApiError, errorMessage } from "@/api";
import { AuthLayout } from "@/components/AuthLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Configuración inicial: se muestra en lugar del login mientras no exista ningún usuario. Crea el superadministrador con
 * el código de un solo uso que la API escribe en sus registros y abre la sesión; después, Organizaciones muestra los
 * primeros pasos (modelos de lenguaje, correo, copias y la primera organización).
 */
export function SetupPage() {
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mismatch = repeat !== "" && repeat !== password;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== repeat) return setError("Las contraseñas no coinciden.");
    setBusy(true);
    setError("");
    try {
      await api.post("/setup", { code, username, email, password });
      // Con la sesión abierta, la ruta /login lleva a Organizaciones, donde están los primeros pasos.
      qc.setQueryData(["setup"], { pending: false });
      await qc.refetchQueries({ queryKey: ["session"] });
    } catch (err) {
      // Otro navegador terminó la configuración antes: se pasa al login.
      if (err instanceof ApiError && err.status === 409) qc.setQueryData(["setup"], { pending: false });
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <form onSubmit={submit} className="w-full max-w-sm space-y-6">
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">Configuración inicial</h1>
          <p className="text-sm text-muted-foreground">Crea la cuenta del superadministrador. Después configurarás los modelos de lenguaje y la primera organización.</p>
        </div>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="setup-code">Código de configuración</Label>
            <div className="relative">
              <KeyRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input id="setup-code" className="pl-9 font-mono uppercase" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} placeholder="XXXX-XXXX-XXXX" required autoFocus />
            </div>
            <p className="text-xs text-muted-foreground">
              Sale en los registros del servidor: <span className="font-mono">docker compose logs api</span>
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="setup-username">Usuario</Label>
            <div className="relative">
              <User className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input id="setup-username" className="pl-9" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="admin" required />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="setup-email">Correo (opcional)</Label>
            <div className="relative">
              <Mail className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input id="setup-email" type="email" className="pl-9" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="setup-password">Contraseña</Label>
            <div className="relative">
              <Lock className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input id="setup-password" type="password" className="pl-9" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="setup-repeat">Repite la contraseña</Label>
            <div className="relative">
              <Lock className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input id="setup-repeat" type="password" className="pl-9" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" aria-invalid={mismatch} required />
            </div>
          </div>
          {error && (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={busy || mismatch}>
            {busy && <Loader2 className="animate-spin" />}
            {busy ? "Creando…" : "Crear superadministrador"}
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
