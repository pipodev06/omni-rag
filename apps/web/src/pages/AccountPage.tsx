import { useState, type FormEvent } from "react";
import { Loader2, Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage, initials, ROLE_LABELS } from "@/api";
import { useCurrentUser } from "@/hooks/useSession";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Page, PageHeader } from "@/components/common";
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
  const { user, tenant } = useCurrentUser();
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

  return (
    <Page className="max-w-3xl">
      <PageHeader title="Mi cuenta" />
      <div className="space-y-4">
        <Card>
          <CardContent className="flex items-center gap-4">
            <Avatar className="size-14">
              <AvatarFallback className="bg-primary/10 text-lg font-medium text-primary">{initials(user.name)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="text-lg font-semibold">{user.name}</p>
              <p className="truncate text-sm text-muted-foreground">{user.email}</p>
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
      </div>
    </Page>
  );
}
