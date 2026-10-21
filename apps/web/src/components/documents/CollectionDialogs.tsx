import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage, initials, ROLE_LABELS, type Collection, type TenantUser } from "@/api";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";

/** Crear o editar una colección. */
export function CollectionFormDialog({ open, onOpenChange, collection, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collection?: Collection;
  onSaved: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName(collection?.name ?? "");
      setDescription(collection?.description ?? "");
    }
  }, [open, collection]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (collection) {
        await api.patch(`/collections/${collection.id}`, { name, description });
        toast.success("Colección actualizada");
        onSaved(collection.id);
      } else {
        const r = await api.post<{ id: string }>("/collections", { name, description });
        toast.success(`Colección «${name}» creada`);
        onSaved(r.id);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{collection ? "Editar colección" : "Nueva colección"}</DialogTitle>
            <DialogDescription>Las colecciones agrupan documentos y sirven para decidir quién puede verlos.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="col-name">Nombre</Label>
            <Input id="col-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="p. ej. Contratos 2026" maxLength={120} required autoFocus />
          </div>
          <div className="space-y-2">
            <Label htmlFor="col-desc">Descripción (opcional)</Label>
            <Textarea id="col-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} rows={3} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy && <Loader2 className="animate-spin" />}
              {collection ? "Guardar" : "Crear colección"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Elegir qué editores y lectores pueden ver una colección. */
export function MembersDialog({ open, onOpenChange, collection, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collection: Collection;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.get<{ users: TenantUser[] }>("/users"),
    enabled: open,
  });
  const users = (data?.users ?? []).filter((u) => u.role !== "admin");
  const selectedSet = new Set(selected);

  useEffect(() => {
    if (open) setSelected(collection.memberIds);
  }, [open, collection]);

  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/collections/${collection.id}/members`, { userIds: selected });
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Acceso a «{collection.name}»</DialogTitle>
          <DialogDescription>Los administradores siempre ven todas las colecciones. Elige qué editores y lectores pueden ver esta.</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        ) : users.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            No hay editores ni lectores. Créalos en la sección Usuarios.
          </p>
        ) : (
          <ScrollArea className="max-h-80">
            <div className="space-y-1">
              {users.map((u) => (
                <label key={u.id} className="flex cursor-pointer items-center gap-3 rounded-lg p-2 hover:bg-muted">
                  <Checkbox
                    checked={selectedSet.has(u.id)}
                    onCheckedChange={(v) => setSelected((s) => (v ? [...s, u.id] : s.filter((x) => x !== u.id)))}
                  />
                  <Avatar className="size-8">
                    <AvatarFallback className="text-xs">{initials(u.name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{u.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{u.username}</p>
                  </div>
                  <span className="text-xs text-muted-foreground">{ROLE_LABELS[u.role]}</span>
                </label>
              ))}
            </div>
          </ScrollArea>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={busy || users.length === 0}>
            {busy && <Loader2 className="animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
