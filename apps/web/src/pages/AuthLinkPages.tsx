import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CircleCheck, KeyRound, Loader2, Mail, TriangleAlert } from "lucide-react";
import { api, errorMessage } from "@/api";
import { Logo } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Marco común de las pantallas públicas (sin sesión). */
function AuthShell({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col p-6 sm:p-10">
      <Logo />
      <div className="flex flex-1 items-center justify-center py-10">
        <div className="w-full max-w-sm space-y-6">
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

const BackToLogin = () => (
  <Link to="/login" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
    <ArrowLeft className="size-4" /> Volver a iniciar sesión
  </Link>
);

/** /recuperar — pedir un enlace para restablecer la contraseña. */
export function ForgotPasswordPage() {
  const [login, setLogin] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ message: string; emailEnabled: boolean } | null>(null);
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setResult(await api.post<{ message: string; emailEnabled: boolean }>("/auth/forgot", { login }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <AuthShell title={result.emailEnabled ? "Revisa tu correo" : "Pide ayuda a tu administrador"}>
        <div className="flex gap-3 rounded-lg border bg-muted/40 p-4 text-sm">
          {result.emailEnabled ? <Mail className="mt-0.5 size-5 shrink-0 text-primary" /> : <KeyRound className="mt-0.5 size-5 shrink-0 text-primary" />}
          <p>{result.message}</p>
        </div>
        <BackToLogin />
      </AuthShell>
    );
  }

  return (
    <AuthShell title="¿Olvidaste la contraseña?" description="Escribe tu usuario o correo y, si la cuenta tiene un correo registrado, te enviaremos un enlace para elegir una nueva.">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="login">Usuario o correo</Label>
          <Input id="login" value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          Enviar enlace
        </Button>
      </form>
      <BackToLogin />
    </AuthShell>
  );
}

interface LinkInfo {
  kind: "invite" | "reset";
  username: string;
  email: string | null;
  name: string;
}

/** /activar y /restablecer — usar un enlace de invitación o de restablecimiento. */
export function LinkPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [invalid, setInvalid] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setInvalid("Falta el código del enlace.");
      return;
    }
    api
      .get<LinkInfo>(`/auth/link?token=${encodeURIComponent(token)}`)
      .then((d) => {
        setInfo(d);
        setName(d.name);
      })
      .catch((err) => setInvalid(errorMessage(err)));
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError("Las contraseñas no coinciden");
    setBusy(true);
    setError("");
    try {
      await api.post("/auth/link", { token, password, name: info?.kind === "invite" ? name : undefined });
      await qc.invalidateQueries({ queryKey: ["session"] });
      navigate("/chat", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (invalid) {
    return (
      <AuthShell title="Enlace no válido">
        <div className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-5 shrink-0" />
          <p>{invalid}</p>
        </div>
        <p className="text-sm text-muted-foreground">
          Los enlaces caducan y solo se pueden usar una vez. Pide uno nuevo a tu administrador o desde «¿Olvidaste la contraseña?».
        </p>
        <BackToLogin />
      </AuthShell>
    );
  }

  if (!info) {
    return (
      <div className="grid h-full place-items-center text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }

  const invite = info.kind === "invite";
  return (
    <AuthShell
      title={invite ? "Activa tu cuenta" : "Elige una nueva contraseña"}
      description={
        <>
          {invite ? "Te han invitado con el usuario " : "Cuenta: "}
          <b className="font-medium text-foreground">{info.username}</b>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {invite && (
          <div className="space-y-2">
            <Label htmlFor="name">Tu nombre</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="pass">Contraseña</Label>
          <Input id="pass" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} placeholder="Mín. 10 caracteres" required autoFocus={!invite} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="conf">Repite la contraseña</Label>
          <Input id="conf" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={10} required />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <CircleCheck />}
          {invite ? "Activar cuenta y entrar" : "Guardar y entrar"}
        </Button>
      </form>
    </AuthShell>
  );
}
