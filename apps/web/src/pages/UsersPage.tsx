import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EllipsisVertical, KeyRound, Loader2, Search, UserPlus, UserRoundCheck, UserRoundX, Users } from "lucide-react";
import { toast } from "sonner";
import {
  api,
  errorMessage,
  initials,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  timeAgo,
  type Collection,
  type Role,
  type TenantUser,
} from "@/api";
import { useCurrentUser } from "@/hooks/useSession";
import { cn } from "@/lib/utils";
import { EmptyState, Page, PageHeader } from "@/components/common";
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
  onCreated: () => void;
}) {
  const empty = { email: "", name: "", password: "", role: "viewer" as Role };
  const [form, setForm] = useState(empty);
  const [collectionIds, setCollectionIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/users", { ...form, collectionIds: form.role === "admin" ? [] : collectionIds });
      toast.success(`Usuario ${form.email} creado`, { description: "Comparte con él su email y contraseña inicial." });
      setForm(empty);
      setCollectionIds([]);
      onCreated();
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
            <DialogDescription>Podrá entrar con este email y la contraseña inicial, y cambiarla después.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="u-name">Nombre</Label>
              <Input id="u-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus />
            </div>
            <div className="space-y-2">
              <Label htmlFor="u-email">Email</Label>
              <Input id="u-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="u-pass">Contraseña inicial</Label>
              <Input id="u-pass" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} minLength={10} placeholder="Mín. 10 caracteres" required />
            </div>
            <div className="space-y-2">
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
                        checked={collectionIds.includes(c.id)}
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
              Crear usuario
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
            <DialogDescription>Nueva contraseña para {user?.email}.</DialogDescription>
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

export function UsersPage() {
  const { user: me } = useCurrentUser();
  const qc = useQueryClient();
  const [newOpen, setNewOpen] = useState(false);
  const [resetUser, setResetUser] = useState<TenantUser | null>(null);
  const [search, setSearch] = useState("");

  const usersQuery = useQuery({ queryKey: ["users"], queryFn: () => api.get<{ users: TenantUser[] }>("/users") });
  const { data: colData } = useQuery({ queryKey: ["collections"], queryFn: () => api.get<{ collections: Collection[] }>("/collections") });
  const collections = colData?.collections ?? [];
  const users = (usersQuery.data?.users ?? []).filter((u) =>
    `${u.name} ${u.email}`.toLowerCase().includes(search.toLowerCase()),
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

  const colName = (id: string) => collections.find((c) => c.id === id)?.name ?? "?";

  return (
    <Page>
      <PageHeader
        title="Usuarios"
        description="Gestiona quién accede a tu organización y con qué permisos. El acceso a cada colección se ajusta también desde Documentos → Acceso."
        actions={
          <Button onClick={() => setNewOpen(true)}>
            <UserPlus /> Nuevo usuario
          </Button>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
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

      <div className="relative mb-4 sm:w-72">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar usuarios…" className="pl-9" />
      </div>

      {usersQuery.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : users.length === 0 ? (
        <EmptyState icon={Users} title="Sin resultados" />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
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
                        </p>
                        <p className="truncate text-xs text-muted-foreground">{u.email}</p>
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
                        <DropdownMenuItem onSelect={() => setResetUser(u)}>
                          <KeyRound /> Restablecer contraseña
                        </DropdownMenuItem>
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
        </div>
      )}

      <NewUserDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        collections={collections}
        onCreated={() => void qc.invalidateQueries({ queryKey: ["users"] })}
      />
      <ResetPasswordDialog user={resetUser} onOpenChange={(o) => !o && setResetUser(null)} />
    </Page>
  );
}
