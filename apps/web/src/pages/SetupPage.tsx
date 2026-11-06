import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, Lock, Mail, User } from "lucide-react";
import { api, ApiError, errorMessage } from "@/api";
import { AuthLayout, FormError, IconInput } from "@/components/AuthLayout";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

/**
 * Configuración inicial: se muestra en lugar del login mientras no exista ningún usuario. Crea el superadministrador con
 * el código de un solo uso que la API escribe en sus registros y abre la sesión; después, Organizaciones muestra los
 * primeros pasos (modelos de lenguaje, correo, copias y la primera organización).
 */
/** Lo que devuelve GET /api/setup (la misma consulta que decide en App.tsx si se muestra esta página). */
export interface SetupStatus {
  pending: boolean;
  /** Mínimo de la contraseña del superadministrador, el mismo que exige la API. */
  minPassword: number;
}

export function SetupPage({ minPassword }: { minPassword: number }) {
  const qc = useQueryClient();
  const done = () => qc.setQueryData<SetupStatus>(["setup"], (s) => ({ minPassword, ...s, pending: false }));
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
      done();
      await qc.refetchQueries({ queryKey: ["session"] });
    } catch (err) {
      // Otro navegador terminó la configuración antes: se pasa al login.
      if (err instanceof ApiError && err.status === 409) done();
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
            <IconInput icon={KeyRound} id="setup-code" className="font-mono uppercase" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} placeholder="XXXX-XXXX-XXXX" required autoFocus />
            <p className="text-xs text-muted-foreground">
              Sale en los registros del servidor: <span className="font-mono">docker compose logs api</span>
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="setup-username">Usuario</Label>
            <IconInput icon={User} id="setup-username" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="admin" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="setup-email">Correo (opcional)</Label>
            <IconInput icon={Mail} id="setup-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="setup-password">Contraseña</Label>
            <IconInput icon={Lock} id="setup-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={minPassword} required />
            <p className="text-xs text-muted-foreground">Mínimo {minPassword} caracteres. Activa también la verificación en dos pasos en Mi cuenta.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="setup-repeat">Repite la contraseña</Label>
            <IconInput icon={Lock} id="setup-repeat" type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" aria-invalid={mismatch} required />
          </div>
          {error && (
            <FormError>{error}</FormError>
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
