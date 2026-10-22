import { useState } from "react";
import { KeyRound, Loader2, LogOut, Monitor, Moon, ShieldAlert, Sun, type LucideIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { api, errorMessage, initials, ROLE_LABELS } from "@/api";
import { clearSession, useCurrentUser } from "@/hooks/useSession";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Page, PageHeader } from "@/components/common";
import { ChangePasswordDialog } from "@/components/account/ChangePasswordDialog";
import { TwoFactorCard } from "@/components/account/TwoFactorCard";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

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
  const [passwordOpen, setPasswordOpen] = useState(false);

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
            <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <CardTitle>Contraseña</CardTitle>
                <CardDescription>Cámbiala cuando quieras. Se cerrará tu sesión en los demás dispositivos.</CardDescription>
              </div>
              <Button onClick={() => setPasswordOpen(true)}>
                <KeyRound /> Cambiar contraseña
              </Button>
            </CardContent>
          </Card>
        )}

        {!support && (
          <Card>
            <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <CardTitle>Sesiones</CardTitle>
                <CardDescription>Cierra la sesión en todos tus dispositivos, también en este. Úsalo si perdiste un equipo o sospechas de un acceso ajeno.</CardDescription>
              </div>
              <Button variant="outline" onClick={() => void logoutEverywhere()} disabled={closing}>
                {closing ? <Loader2 className="animate-spin" /> : <LogOut />} Cerrar todas las sesiones
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} needsCode={user.totpEnabled === true} />
    </Page>
  );
}
