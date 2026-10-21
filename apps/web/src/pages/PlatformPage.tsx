import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, EllipsisVertical, Gauge, Layers, LifeBuoy, Loader2, Plus, Power } from "lucide-react";
import { toast } from "sonner";
import { api, dailyLimitLabel, errorMessage, timeAgo, type LinkResult, type Plan } from "@/api";
import { LinkResultDialog } from "@/components/LinkResultDialog";
import { AccessModeTabs, type AccessMode } from "@/components/AccessModeTabs";
import { PlanDialog, PlansTab, usePlans } from "@/components/platform/PlansTab";
import { switchOrganization, useCurrentUser } from "@/hooks/useSession";
import { cn } from "@/lib/utils";
import { EmptyState, Page, PageHeader, TableCard } from "@/components/common";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  /** Excepción puntual de esta organización; null = rige el límite de su plan. */
  dailyQuestionLimit: number | null;
  planId: string;
  planName: string;
  planDailyQuestionLimit: number;
  createdAt: string;
  users: number;
  documents: number;
  questions30d: number;
}

const slugify = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

function NewTenantDialog({ open, onOpenChange, onCreated }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (link: LinkResult | null, email: string) => void;
}) {
  const empty = { name: "", slug: "", adminName: "", adminUsername: "", adminEmail: "", adminPassword: "" };
  const [form, setForm] = useState(empty);
  const [mode, setMode] = useState<AccessMode>("invite");
  const [busy, setBusy] = useState(false);
  const [planId, setPlanId] = useState("");
  const plans = usePlans().data?.plans ?? [];
  const selectedPlan = planId || plans.find((p) => p.isDefault)?.id;
  // La invitación necesita email: sin él solo se puede definir una contraseña inicial.
  const hasEmail = form.adminEmail.trim() !== "";
  const effectiveMode: AccessMode = hasEmail ? mode : "password";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post<{ inviteUrl: string | null; emailSent: boolean }>("/platform/tenants", {
        name: form.name,
        slug: form.slug,
        planId: selectedPlan,
        admin: {
          name: form.adminName,
          username: form.adminUsername,
          email: hasEmail ? form.adminEmail : undefined,
          password: effectiveMode === "password" ? form.adminPassword : undefined,
        },
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
          <div className="space-y-2">
            <Label>Plan</Label>
            <Select value={selectedPlan ?? ""} onValueChange={setPlanId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Plan" />
              </SelectTrigger>
              <SelectContent>
                {plans.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                    {p.isDefault && " (por defecto)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Separator />
          <p className="text-sm font-medium">Administrador de la organización</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="t-aname">Nombre</Label>
              <Input id="t-aname" value={form.adminName} onChange={(e) => setForm({ ...form, adminName: e.target.value })} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="t-ausername">Usuario</Label>
              <Input id="t-ausername" value={form.adminUsername} onChange={(e) => setForm({ ...form, adminUsername: e.target.value.toLowerCase() })} pattern="[a-z0-9][a-z0-9._\-]{2,39}" title="3-40 caracteres: minúsculas, números, punto, guion o guion bajo" autoCapitalize="none" spellCheck={false} required />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="t-aemail">Email (opcional)</Label>
              <Input id="t-aemail" type="email" value={form.adminEmail} onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <AccessModeTabs value={effectiveMode} onChange={setMode} inviteDisabled={!hasEmail} />
              {effectiveMode === "password" && (
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
  const defaultLimit = tenant?.planDailyQuestionLimit ?? 0;
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
          <DialogDescription>
            Preguntas al LLM por día. Vacío = límite del plan {tenant?.planName} ({defaultLimit === 0 ? "sin límite" : defaultLimit}); 0 = sin límite.
          </DialogDescription>
        </DialogHeader>
        <Input
          type="number"
          min={0}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={`Del plan: ${defaultLimit === 0 ? "sin límite" : defaultLimit}`}
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => void save(null)} disabled={busy}>
            Usar el del plan
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

function ChangePlanDialog({ tenant, onOpenChange, onSaved }: { tenant: TenantRow | null; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const plans = usePlans().data?.plans ?? [];
  const [planId, setPlanId] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!tenant || !planId) return;
    setBusy(true);
    try {
      await api.patch(`/platform/tenants/${tenant.id}`, { planId });
      toast.success("Plan actualizado");
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
        if (o && tenant) setPlanId(tenant.planId);
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Plan de «{tenant?.name}»</DialogTitle>
          <DialogDescription>Define los modelos y los topes de la organización. El cambio aplica a partir de la siguiente pregunta.</DialogDescription>
        </DialogHeader>
        <Select value={planId} onValueChange={setPlanId}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Plan" />
          </SelectTrigger>
          <SelectContent>
            {plans.map((p: Plan) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={busy || !planId || planId === tenant?.planId}>
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
  const [planTenant, setPlanTenant] = useState<TenantRow | null>(null);
  const [tab, setTab] = useState<"orgs" | "plans">("orgs");
  const [planDialog, setPlanDialog] = useState<{ plan: Plan | null } | null>(null);
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

  const enter = async (t: TenantRow) => {
    const ok = await confirm({
      title: `¿Entrar en «${t.name}» como soporte?`,
      description:
        "Verás sus documentos, usuarios y conversaciones con permisos de administrador. La entrada y lo que hagas quedan registrados en su auditoría. Para volver, usa el aviso de arriba.",
      confirmText: "Entrar",
    });
    if (!ok) return;
    try {
      await api.post(`/platform/tenants/${t.id}/enter`);
      switchOrganization("/chat");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const tenants = data?.tenants ?? [];

  return (
    <Page fill>
      <PageHeader
        title="Organizaciones"
        description="Clientes de la plataforma. Los datos de cada organización permanecen aislados entre sí en la base de datos."
        actions={
          tab === "orgs" ? (
            <Button onClick={() => setNewOpen(true)}>
              <Plus /> Nueva organización
            </Button>
          ) : (
            <Button onClick={() => setPlanDialog({ plan: null })}>
              <Plus /> Nuevo plan
            </Button>
          )
        }
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as "orgs" | "plans")} className="mb-4 shrink-0">
        <TabsList>
          <TabsTrigger value="orgs">Organizaciones</TabsTrigger>
          <TabsTrigger value="plans">Planes</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "plans" ? (
        <PlansTab onEdit={(plan) => setPlanDialog({ plan })} />
      ) : isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : tenants.length === 0 ? (
        <EmptyState icon={Building2} title="Sin organizaciones" />
      ) : (
        <TableCard>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Organización</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead className="text-center">Usuarios</TableHead>
                <TableHead className="text-center">Documentos</TableHead>
                <TableHead className="hidden text-center lg:table-cell">Preguntas (30 días)</TableHead>
                <TableHead className="hidden text-center md:table-cell">Límite diario</TableHead>
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
                  <TableCell>
                    <Badge variant="outline" className="font-normal">
                      {t.planName}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-center tabular-nums">{t.users}</TableCell>
                  <TableCell className="text-center tabular-nums">{t.documents}</TableCell>
                  <TableCell className="hidden text-center tabular-nums lg:table-cell">{t.questions30d}</TableCell>
                  <TableCell className="hidden text-center text-sm md:table-cell">
                    <span title={t.dailyQuestionLimit === null ? `Límite del plan ${t.planName}` : "Excepción de esta organización"}>{dailyLimitLabel(t.dailyQuestionLimit ?? t.planDailyQuestionLimit)}</span>
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
                        {t.slug !== myTenant.slug && t.isActive && (
                          <DropdownMenuItem onSelect={() => void enter(t)}>
                            <LifeBuoy /> Entrar como soporte
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onSelect={() => setPlanTenant(t)}>
                          <Layers /> Cambiar plan
                        </DropdownMenuItem>
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
        </TableCard>
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
      <ChangePlanDialog tenant={planTenant} onOpenChange={(o) => !o && setPlanTenant(null)} onSaved={refresh} />
      <PlanDialog
        plan={planDialog?.plan ?? null}
        open={planDialog !== null}
        onOpenChange={(o) => !o && setPlanDialog(null)}
        onSaved={() => {
          void qc.invalidateQueries({ queryKey: ["plans"] });
          refresh();
        }}
      />
    </Page>
  );
}
