import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, EllipsisVertical, KeyRound, Link2, Loader2, Search, Send, ShieldOff, UserPlus, UserRoundCheck, UserRoundX, Users } from "lucide-react";
import { toast } from "sonner";
import {
  api,
  errorMessage,
  initials,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  timeAgo,
  type Collection,
  type LinkResult,
  type Role,
  type TenantUser,
} from "@/api";
import { useConfirm } from "@/components/ConfirmProvider";
import { useCurrentUser } from "@/hooks/useSession";
import { cn } from "@/lib/utils";
import { EmptyState, Page, PageHeader, TableCard } from "@/components/common";
import { LinkResultDialog } from "@/components/LinkResultDialog";
import { AccessModeTabs, type AccessMode } from "@/components/AccessModeTabs";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const ROLES: Role[] = ["admin", "editor", "viewer"];

function RoleSelect({ value, onChange, disabled, className }: { value: Role; onChange: (r: Role) => void; disabled?: boolean; className?: string }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Role)} disabled={disabled}>
      <SelectTrigger className={cn("h-8 w-36", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ROLES.map((r) => (
          <SelectItem key={r} value={r}>
            {ROLE_LABELS[r]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NewUserDialog({ open, onOpenChange, collections, onCreated }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  collections: Collection[];
  onCreated: (link: LinkResult | null, email: string) => void;
}) {
  const empty = { username: "", email: "", name: "", password: "", role: "viewer" as Role };
  const [form, setForm] = useState(empty);
  const [mode, setMode] = useState<AccessMode>("invite");
  const [collectionIds, setCollectionIds] = useState<string[]>([]);
  const selectedCollections = new Set(collectionIds);
  const [busy, setBusy] = useState(false);
  // La invitación necesita email: sin él solo se puede definir una contraseña inicial.
  const hasEmail = form.email.trim() !== "";
  const effectiveMode: AccessMode = hasEmail ? mode : "password";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post<{ inviteUrl: string | null; emailSent: boolean }>("/users", {
        ...form,
        email: hasEmail ? form.email : undefined,
        password: effectiveMode === "password" ? form.password : undefined,
        collectionIds: form.role === "admin" ? [] : collectionIds,
      });
      if (r.inviteUrl) {
        onCreated({ kind: "invite", url: r.inviteUrl, emailSent: r.emailSent }, form.email);
      } else {
        toast.success(`Usuario ${form.username} creado`, { description: "Comparte con él su usuario y contraseña inicial." });
        onCreated(null, form.email);
      }
      setForm(empty);
      setCollectionIds([]);
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
            <DialogTitle>Nuevo usuario</DialogTitle>
            <DialogDescription>Entra con su usuario y contraseña. El email es opcional: con él puedes invitarlo y podrá recuperar su contraseña.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="u-name">Nombre</Label>
              <Input id="u-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus />
            </div>
            <div className="space-y-2">
              <Label htmlFor="u-username">Usuario</Label>
              <Input id="u-username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} pattern="[a-z0-9][a-z0-9._\-]{2,39}" title="3-40 caracteres: minúsculas, números, punto, guion o guion bajo" autoCapitalize="none" spellCheck={false} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="u-email">Email (opcional)</Label>
              <Input id="u-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>Acceso</Label>
              <AccessModeTabs value={effectiveMode} onChange={setMode} inviteDisabled={!hasEmail} />
              {effectiveMode === "invite" ? (
                <p className="text-xs text-muted-foreground">Recibirá un enlace para elegir su propia contraseña. Si el correo no está configurado, verás el enlace para compartirlo tú.</p>
              ) : (
                <Input id="u-pass" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} minLength={10} placeholder="Contraseña inicial (mín. 10 caracteres)" required aria-label="Contraseña inicial" />
              )}
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>Rol</Label>
              <RoleSelect value={form.role} onChange={(role) => setForm({ ...form, role })} className="h-9 w-full" />
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[form.role]}.</p>
          {form.role !== "admin" && (
            <div className="space-y-2">
              <Label>Colecciones a las que tendrá acceso</Label>
              {collections.length === 0 ? (
                <p className="text-sm text-muted-foreground">No hay colecciones todavía.</p>
              ) : (
                <div className="grid max-h-44 gap-1 overflow-y-auto rounded-lg border p-2 sm:grid-cols-2">
                  {collections.map((c) => (
                    <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                      <Checkbox
                        checked={selectedCollections.has(c.id)}
                        onCheckedChange={(v) => setCollectionIds((s) => (v ? [...s, c.id] : s.filter((x) => x !== c.id)))}
                      />
                      <span className="truncate">{c.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              {effectiveMode === "invite" ? "Crear e invitar" : "Crear usuario"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onOpenChange }: { user: TenantUser | null; onOpenChange: (o: boolean) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setBusy(true);
    try {
      await api.patch(`/users/${user.id}`, { password });
      toast.success("Contraseña restablecida", { description: `Comunícale la nueva contraseña a ${user.name}.` });
      setPassword("");
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={user !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>Restablecer contraseña</DialogTitle>
            <DialogDescription>Nueva contraseña para {user?.username}.</DialogDescription>
          </DialogHeader>
          <Input value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} placeholder="Mín. 10 caracteres" required autoFocus />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              Guardar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Cambiar el usuario o añadir/quitar el email (el email permite invitaciones y recuperar la contraseña). */
function EditAccessDialog({ user, onOpenChange, onSaved }: { user: TenantUser | null; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const [form, setForm] = useState({ username: "", email: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user) setForm({ username: user.username, email: user.email ?? "" });
  }, [user]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setBusy(true);
    try {
      await api.patch(`/users/${user.id}`, { username: form.username, email: form.email.trim() === "" ? null : form.email });
      toast.success("Acceso actualizado");
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={user !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>Usuario y email de {user?.name}</DialogTitle>
            <DialogDescription>Con email puede recuperar su contraseña por correo. Vacío = solo entra con usuario y contraseña.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="e-username">Usuario</Label>
              <Input id="e-username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} pattern="[a-z0-9][a-z0-9._\-]{2,39}" title="3-40 caracteres: minúsculas, números, punto, guion o guion bajo" autoCapitalize="none" spellCheck={false} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="e-email">Email (opcional)</Label>
              <Input id="e-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              Guardar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function UsersPage() {
  const { user: me } = useCurrentUser();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [newOpen, setNewOpen] = useState(false);
  const [resetUser, setResetUser] = useState<TenantUser | null>(null);
  const [editUser, setEditUser] = useState<TenantUser | null>(null);
  const [linkResult, setLinkResult] = useState<{ result: LinkResult; email: string } | null>(null);
  const [search, setSearch] = useState("");

  const usersQuery = useQuery({ queryKey: ["users"], queryFn: () => api.get<{ users: TenantUser[] }>("/users") });
  const { data: colData } = useQuery({ queryKey: ["collections"], queryFn: () => api.get<{ collections: Collection[] }>("/collections") });
  const collections = colData?.collections ?? [];
  const users = (usersQuery.data?.users ?? []).filter((u) =>
    `${u.name} ${u.username} ${u.email ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  );

  const update = async (u: TenantUser, patch: Partial<{ role: Role; isActive: boolean }>, message: string) => {
    try {
      await api.patch(`/users/${u.id}`, patch);
      toast.success(message);
      void qc.invalidateQueries({ queryKey: ["users"] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const resetTotp = async (u: TenantUser) => {
    const ok = await confirm({
      title: `¿Quitar la verificación en dos pasos de ${u.name}?`,
      description: "Podrá entrar solo con su contraseña y volver a activarla cuando quiera. Úsalo si perdió el teléfono y los códigos de recuperación.",
      confirmText: "Quitar",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.post(`/users/${u.id}/totp/reset`);
      toast.success("Verificación en dos pasos quitada");
      void qc.invalidateQueries({ queryKey: ["users"] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const colName = (id: string) => collections.find((c) => c.id === id)?.name ?? "?";

  const createLink = async (u: TenantUser) => {
    try {
      const result = await api.post<LinkResult>(`/users/${u.id}/link`);
      setLinkResult({ result, email: u.email ?? "" });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Page fill>
      <PageHeader
        title="Usuarios"
        description="Permite gestionar quién accede a la organización y con qué permisos. El acceso a cada colección también se ajusta desde Documentos → Acceso."
        actions={
          <Button onClick={() => setNewOpen(true)}>
            <UserPlus /> Nuevo usuario
          </Button>
        }
      />

      <div className="mb-4 grid shrink-0 gap-3 sm:grid-cols-3">
        {ROLES.map((r) => (
          <div key={r} className="rounded-xl border bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">{ROLE_LABELS[r]}</p>
              <Badge variant="secondary">{usersQuery.data?.users.filter((u) => u.role === r).length ?? 0}</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[r]}</p>
          </div>
        ))}
      </div>

      <div className="relative mb-4 shrink-0 sm:w-72">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar usuarios…" className="pl-9" />
      </div>

      {usersQuery.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : users.length === 0 ? (
        <EmptyState icon={Users} title="Sin resultados" />
      ) : (
        <TableCard>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Usuario</TableHead>
                <TableHead>Rol</TableHead>
                <TableHead className="hidden lg:table-cell">Colecciones</TableHead>
                <TableHead className="hidden md:table-cell">Último acceso</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id} className={cn(!u.isActive && "opacity-60")}>
                  <TableCell className="pl-4">
                    <div className="flex items-center gap-3">
                      <Avatar className="size-9">
                        <AvatarFallback className="text-xs">{initials(u.name)}</AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 font-medium">
                          {u.name}
                          {u.id === me.id && <Badge variant="secondary">Tú</Badge>}
                          {!u.isActive && <Badge variant="outline">Desactivado</Badge>}
                          {u.pendingInvite && u.isActive && (
                            <Badge variant="outline" className="border-warning/30 bg-warning/10 text-warning">
                              Invitación pendiente
                            </Badge>
                          )}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          @{u.username}
                          {u.email && ` · ${u.email}`}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <RoleSelect
                      value={u.role}
                      disabled={u.id === me.id}
                      onChange={(role) => void update(u, { role }, `${u.name} ahora es ${ROLE_LABELS[role].toLowerCase()}`)}
                    />
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {u.role === "admin" ? (
                      <span className="text-sm text-muted-foreground">Todas</span>
                    ) : u.collectionIds.length === 0 ? (
                      <span className="text-sm text-muted-foreground">Ninguna</span>
                    ) : (
                      <div className="flex max-w-xs flex-wrap gap-1">
                        {u.collectionIds.map((id) => (
                          <Badge key={id} variant="outline" className="font-normal">
                            {colName(id)}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                    {u.lastLoginAt ? timeAgo(u.lastLoginAt) : "Nunca"}
                  </TableCell>
                  <TableCell className="pr-3">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="size-8" aria-label="Acciones">
                          <EllipsisVertical />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setEditUser(u)}>
                          <AtSign /> Cambiar usuario o email
                        </DropdownMenuItem>
                        {u.pendingInvite ? (
                          <DropdownMenuItem disabled={!u.isActive} onSelect={() => void createLink(u)}>
                            <Send /> Reenviar invitación
                          </DropdownMenuItem>
                        ) : (
                          <>
                            <DropdownMenuItem disabled={!u.isActive || u.id === me.id} onSelect={() => void createLink(u)}>
                              <Link2 /> Enviar enlace para restablecer
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setResetUser(u)}>
                              <KeyRound /> Definir contraseña
                            </DropdownMenuItem>
                          </>
                        )}
                        {u.totpEnabled && u.id !== me.id && (
                          <DropdownMenuItem onSelect={() => void resetTotp(u)}>
                            <ShieldOff /> Quitar verificación en dos pasos
                          </DropdownMenuItem>
                        )}
                        {u.id !== me.id && (
                          <>
                            <DropdownMenuSeparator />
                            {u.isActive ? (
                              <DropdownMenuItem variant="destructive" onSelect={() => void update(u, { isActive: false }, `${u.name} desactivado`)}>
                                <UserRoundX /> Desactivar
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem onSelect={() => void update(u, { isActive: true }, `${u.name} activado`)}>
                                <UserRoundCheck /> Activar
                              </DropdownMenuItem>
                            )}
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

      <NewUserDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        collections={collections}
        onCreated={(link, email) => {
          void qc.invalidateQueries({ queryKey: ["users"] });
          if (link) setLinkResult({ result: link, email });
        }}
      />
      <LinkResultDialog result={linkResult?.result ?? null} email={linkResult?.email} onClose={() => setLinkResult(null)} />
      <ResetPasswordDialog user={resetUser} onOpenChange={(o) => !o && setResetUser(null)} />
      <EditAccessDialog
        user={editUser}
        onOpenChange={(o) => !o && setEditUser(null)}
        onSaved={() => void qc.invalidateQueries({ queryKey: ["users"] })}
      />
    </Page>
  );
}
