import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, EllipsisVertical, Gauge, Loader2, Plus, Power } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage, timeAgo, type LinkResult } from "@/api";
import { LinkResultDialog } from "@/components/LinkResultDialog";
import { AccessModeTabs, type AccessMode } from "@/components/AccessModeTabs";
import { useCurrentUser } from "@/hooks/useSession";
import { cn } from "@/lib/utils";
import { EmptyState, Page, PageHeader } from "@/components/common";
import { useConfirm } from "@/components/ConfirmProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  dailyQuestionLimit: number | null;
  createdAt: string;
  users: number;
  documents: number;
}

const slugify = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

function NewTenantDialog({ open, onOpenChange, onCreated }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (link: LinkResult | null, email: string) => void;
}) {
  const empty = { name: "", slug: "", adminName: "", adminEmail: "", adminPassword: "" };
  const [form, setForm] = useState(empty);
  const [mode, setMode] = useState<AccessMode>("invite");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post<{ inviteUrl: string | null; emailSent: boolean }>("/platform/tenants", {
        name: form.name,
        slug: form.slug,
        admin: { name: form.adminName, email: form.adminEmail, password: mode === "password" ? form.adminPassword : undefined },
      });
      toast.success(`Organización «${form.name}» creada`);
      onCreated(r.inviteUrl ? { kind: "invite", url: r.inviteUrl, emailSent: r.emailSent } : null, form.adminEmail);
      setForm(empty);
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>Nueva organización</DialogTitle>
            <DialogDescription>Cada organización es un cliente con sus propios usuarios y documentos, aislados del resto.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="t-name">Nombre</Label>
              <Input id="t-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value, slug: slugify(e.target.value) })} required autoFocus />
            </div>
            <div className="space-y-2">
              <Label htmlFor="t-slug">Identificador</Label>
              <Input id="t-slug" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} pattern="[a-z0-9][a-z0-9-]{1,62}" title="Minúsculas, números y guiones" required />
            </div>
          </div>
          <Separator />
          <p className="text-sm font-medium">Administrador de la organización</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="t-aname">Nombre</Label>
              <Input id="t-aname" value={form.adminName} onChange={(e) => setForm({ ...form, adminName: e.target.value })} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="t-aemail">Email</Label>
              <Input id="t-aemail" type="email" value={form.adminEmail} onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} required />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <AccessModeTabs value={mode} onChange={setMode} />
              {mode === "password" && (
                <Input id="t-apass" value={form.adminPassword} onChange={(e) => setForm({ ...form, adminPassword: e.target.value })} minLength={10} placeholder="Contraseña inicial (mín. 10 caracteres)" required aria-label="Contraseña inicial" />
              )}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              Crear organización
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LimitDialog({ tenant, onOpenChange, onSaved }: { tenant: TenantRow | null; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async (limit: number | null) => {
    if (!tenant) return;
    setBusy(true);
    try {
      await api.patch(`/platform/tenants/${tenant.id}`, { dailyQuestionLimit: limit });
      toast.success("Límite actualizado");
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={tenant !== null}
      onOpenChange={(o) => {
        if (o && tenant) setValue(tenant.dailyQuestionLimit?.toString() ?? "");
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Límite diario de «{tenant?.name}»</DialogTitle>
          <DialogDescription>Preguntas al LLM por día. Vacío = usar el valor global del servidor; 0 = sin límite.</DialogDescription>
        </DialogHeader>
        <Input type="number" min={0} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Global" autoFocus />
        <DialogFooter>
          <Button variant="outline" onClick={() => void save(null)} disabled={busy}>
            Usar global
          </Button>
          <Button onClick={() => void save(value.trim() === "" ? null : Number(value))} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PlatformPage() {
  const { tenant: myTenant } = useCurrentUser();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [newOpen, setNewOpen] = useState(false);
  const [limitTenant, setLimitTenant] = useState<TenantRow | null>(null);
  const [linkResult, setLinkResult] = useState<{ result: LinkResult; email: string } | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["tenants"],
    queryFn: () => api.get<{ tenants: TenantRow[] }>("/platform/tenants"),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["tenants"] });

  const toggle = async (t: TenantRow) => {
    if (t.isActive) {
      const ok = await confirm({
        title: `¿Desactivar «${t.name}»?`,
        description: "Sus usuarios no podrán entrar hasta que la reactives. No se borra ningún dato.",
        confirmText: "Desactivar",
        destructive: true,
      });
      if (!ok) return;
    }
    try {
      await api.patch(`/platform/tenants/${t.id}`, { isActive: !t.isActive });
      toast.success(t.isActive ? "Organización desactivada" : "Organización activada");
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const tenants = data?.tenants ?? [];

  return (
    <Page>
      <PageHeader
        title="Organizaciones"
        description="Clientes de la plataforma. Los datos de cada organización están aislados en la base de datos."
        actions={
          <Button onClick={() => setNewOpen(true)}>
            <Plus /> Nueva organización
          </Button>
        }
      />
      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : tenants.length === 0 ? (
        <EmptyState icon={Building2} title="Sin organizaciones" />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Organización</TableHead>
                <TableHead className="text-right">Usuarios</TableHead>
                <TableHead className="text-right">Documentos</TableHead>
                <TableHead className="hidden md:table-cell">Límite diario</TableHead>
                <TableHead className="hidden md:table-cell">Creada</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tenants.map((t) => (
                <TableRow key={t.id} className={cn(!t.isActive && "opacity-60")}>
                  <TableCell className="pl-4">
                    <div className="flex items-center gap-3">
                      <div className="grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground">
                        <Building2 className="size-4" />
                      </div>
                      <div>
                        <p className="flex items-center gap-2 font-medium">
                          {t.name}
                          {t.slug === myTenant.slug && <Badge variant="secondary">La tuya</Badge>}
                          {!t.isActive && <Badge variant="outline">Inactiva</Badge>}
                        </p>
                        <p className="text-xs text-muted-foreground">{t.slug}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{t.users}</TableCell>
                  <TableCell className="text-right tabular-nums">{t.documents}</TableCell>
                  <TableCell className="hidden text-sm md:table-cell">
                    {t.dailyQuestionLimit === null ? <span className="text-muted-foreground">Global</span> : t.dailyQuestionLimit === 0 ? "Sin límite" : `${t.dailyQuestionLimit} / día`}
                  </TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{timeAgo(t.createdAt)}</TableCell>
                  <TableCell className="pr-3">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="size-8" aria-label="Acciones">
                          <EllipsisVertical />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setLimitTenant(t)}>
                          <Gauge /> Límite diario
                        </DropdownMenuItem>
                        {t.slug !== myTenant.slug && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant={t.isActive ? "destructive" : "default"} onSelect={() => void toggle(t)}>
                              <Power /> {t.isActive ? "Desactivar" : "Activar"}
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <NewTenantDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={(link, email) => {
          refresh();
          if (link) setLinkResult({ result: link, email });
        }}
      />
      <LinkResultDialog result={linkResult?.result ?? null} email={linkResult?.email} onClose={() => setLinkResult(null)} />
      <LimitDialog tenant={limitTenant} onOpenChange={(o) => !o && setLimitTenant(null)} onSaved={refresh} />
    </Page>
  );
}
