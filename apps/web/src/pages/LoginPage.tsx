import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Lock, User } from "lucide-react";
import { api, errorMessage } from "@/api";
import { AuthLayout, FormError, IconInput } from "@/components/AuthLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginPage() {
  const [login, setLogin] = useState("");
  // Segundo paso (solo si la cuenta tiene verificación en dos pasos).
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mfaToken) await api.post("/auth/login/totp", { mfaToken, code });
      else {
        const r = await api.post<{ mfaRequired?: boolean; mfaToken?: string }>("/auth/login", { login, password });
        if (r.mfaRequired && r.mfaToken) {
          setMfaToken(r.mfaToken);
          return;
        }
      }
      // Al cargar la sesión, la ruta /login lleva sola a la página que se quería ver.
      await qc.refetchQueries({ queryKey: ["session"] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <form onSubmit={submit} className="w-full max-w-sm space-y-6">
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">{mfaToken ? "Verificación en dos pasos" : "Inicia sesión"}</h1>
          <p className="text-sm text-muted-foreground">
            {mfaToken ? "Escribe el código de 6 dígitos de tu app autenticadora, o un código de recuperación." : "Introduce tus credenciales para continuar."}
          </p>
        </div>
        <div className="space-y-4">
          {mfaToken ? (
            <div className="space-y-2">
              <Label htmlFor="code">Código</Label>
              <Input id="code" inputMode="text" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
            </div>
          ) : (
          <>
          <div className="space-y-2">
            <Label htmlFor="login">Usuario o correo</Label>
            <IconInput icon={User} id="login" value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Contraseña</Label>
            <IconInput icon={Lock} id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </div>
          </>
          )}
          {error && (
            <FormError>{error}</FormError>
          )}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            {busy ? "Entrando…" : mfaToken ? "Verificar" : "Entrar"}
          </Button>
        </div>
        <p className="text-center text-sm">
          {mfaToken ? (
            <button type="button" className="text-primary hover:underline" onClick={() => { setMfaToken(null); setCode(""); setError(""); }}>
              Volver
            </button>
          ) : (
            <Link to="/recuperar" className="text-primary hover:underline">
              ¿Olvidaste la contraseña?
            </Link>
          )}
        </p>
      </form>
    </AuthLayout>
  );
}
