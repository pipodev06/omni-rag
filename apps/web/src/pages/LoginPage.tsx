import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { FileSearch, Loader2, Lock, Quote, ShieldCheck, User } from "lucide-react";
import { api, errorMessage } from "@/api";
import { Logo } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const FEATURES = [
  { icon: FileSearch, title: "Pregunta a tus documentos", text: "PDF, Word, Excel, presentaciones e imágenes escaneadas." },
  { icon: Quote, title: "Respuestas con fuentes", text: "Cada respuesta cita el documento y la página de donde sale." },
  { icon: ShieldCheck, title: "Acceso controlado", text: "Cada persona solo ve los documentos que le corresponden." },
];

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
    <div className="grid min-h-full lg:grid-cols-2">
      <div className="flex flex-col p-6 sm:p-10">
        <Logo />
        <div className="flex flex-1 items-center justify-center py-10">
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
                <div className="relative">
                  <User className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input id="login" className="pl-9" value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Contraseña</Label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input id="password" type="password" className="pl-9" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
                </div>
              </div>
              </>
              )}
              {error && (
                <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
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
        </div>
      </div>

      <div className="relative hidden overflow-hidden bg-zinc-950 p-10 text-zinc-50 lg:flex lg:flex-col lg:justify-center">
        <div className="pointer-events-none absolute -top-32 -right-32 size-96 rounded-full bg-indigo-600/30 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-40 -left-20 size-96 rounded-full bg-violet-600/20 blur-3xl" />
        <div className="relative mx-auto max-w-md space-y-8">
          <h2 className="text-3xl font-semibold tracking-tight">El conocimiento de tu organización, a una pregunta de distancia.</h2>
          <ul className="space-y-5">
            {FEATURES.map((f) => (
              <li key={f.title} className="flex gap-4">
                <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-white/10">
                  <f.icon className="size-5 text-indigo-300" />
                </div>
                <div>
                  <p className="font-medium">{f.title}</p>
                  <p className="text-sm text-zinc-400">{f.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
