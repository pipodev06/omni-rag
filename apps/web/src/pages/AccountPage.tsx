import { useState, type FormEvent } from "react";
import { Loader2, LogOut, Monitor, Moon, ShieldAlert, Sun, type LucideIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { api, errorMessage, initials, ROLE_LABELS } from "@/api";
import { clearSession, useCurrentUser } from "@/hooks/useSession";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Page, PageHeader } from "@/components/common";
import { TwoFactorCard } from "@/components/account/TwoFactorCard";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const THEMES: { value: Theme; label: string; icon: LucideIcon }[] = [
  { value: "light", label: "Claro", icon: Sun },
  { value: "dark", label: "Oscuro", icon: Moon },
  { value: "system", label: "Automático", icon: Monitor },
];

export function AccountPage() {
  const { user, tenant, support, mfaSetupRequired } = useCurrentUser();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [closing, setClosing] = useState(false);
  const { theme, setTheme } = useTheme();
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [confirmPassword, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) return toast.error("Las contraseñas nuevas no coinciden");
    setBusy(true);
    try {
      await api.post("/auth/change-password", { currentPassword, newPassword });
      toast.success("Contraseña actualizada");
      setCurrent("");
      setNew("");
      setConfirm("");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const logoutEverywhere = async () => {
    setClosing(true);
    try {
      await api.post("/auth/logout-all");
      clearSession(qc);
      navigate("/login", { replace: true });
    } catch (err) {
      toast.error(errorMessage(err));
      setClosing(false);
    }
  };

  return (
    <Page className="max-w-3xl">
      <PageHeader title="Mi cuenta" />
      <div className="space-y-4">
        {mfaSetupRequired && (
          <div role="alert" className="flex gap-3 rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
            <ShieldAlert className="mt-0.5 size-5 shrink-0" />
            <p>La cuenta de superadministrador debe activar la verificación en dos pasos para seguir usando la plataforma. Actívala aquí abajo.</p>
          </div>
        )}
        <Card>
          <CardContent className="flex items-center gap-4">
            <Avatar className="size-14">
              <AvatarFallback className="bg-primary/10 text-lg font-medium text-primary">{initials(user.name)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="text-lg font-semibold">{user.name}</p>
              <p className="truncate text-sm text-muted-foreground">{user.username}{user.email && ` · ${user.email}`}</p>
              <p className="text-sm text-muted-foreground">
                {ROLE_LABELS[user.role]}
                {user.isSuperadmin && " · Superadministrador"} · {tenant.name}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Apariencia</CardTitle>
            <CardDescription>Se guarda en este navegador.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-2">
              {THEMES.map((t) => (
                <button
                  key={t.value}
                  onClick={() => setTheme(t.value)}
                  className={cn(
                    "flex flex-col items-center gap-2 rounded-lg border p-4 text-sm transition-colors hover:bg-muted",
                    theme === t.value && "border-primary bg-primary/5 text-primary",
                  )}
                >
                  <t.icon className="size-5" />
                  {t.label}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {!support && <TwoFactorCard enabled={user.totpEnabled === true} recommended={user.isSuperadmin} />}

        {!support && (
          <Card>
            <CardHeader>
              <CardTitle>Sesiones</CardTitle>
              <CardDescription>Cierra la sesión en todos tus dispositivos, también en este. Úsalo si perdiste un equipo o sospechas de un acceso ajeno.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={() => void logoutEverywhere()} disabled={closing}>
                {closing ? <Loader2 className="animate-spin" /> : <LogOut />} Cerrar todas las sesiones
              </Button>
            </CardContent>
          </Card>
        )}

        {!support && (
        <Card>
          <CardHeader>
            <CardTitle>Cambiar contraseña</CardTitle>
            <CardDescription>Usa al menos 10 caracteres.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="max-w-sm space-y-4">
              <div className="space-y-2">
                <Label htmlFor="cur">Contraseña actual</Label>
                <Input id="cur" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrent(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new">Nueva contraseña</Label>
                <Input id="new" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNew(e.target.value)} minLength={10} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="conf">Repite la nueva contraseña</Label>
                <Input id="conf" type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirm(e.target.value)} minLength={10} required />
              </div>
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 className="animate-spin" />}
                Guardar contraseña
              </Button>
            </form>
          </CardContent>
        </Card>
        )}
      </div>
    </Page>
  );
}
