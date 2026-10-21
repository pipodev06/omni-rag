import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EllipsisVertical, Layers, Loader2, Pencil, Star, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage, type Plan } from "@/api";
import { EmptyState, TableCard } from "@/components/common";
import { useConfirm } from "@/components/ConfirmProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

export function usePlans() {
  return useQuery({ queryKey: ["plans"], queryFn: () => api.get<{ plans: Plan[] }>("/platform/plans") });
}

const isFree = (model: string) => model.endsWith(":free");
const limitText = (n: number | null, unit = "") => (n === null ? "Sin tope" : n === 0 ? "Sin límite" : `${n}${unit}`);

interface PlanForm {
  name: string;
  description: string;
  models: string;
  dailyQuestionLimit: string;
  maxUsers: string;
  maxDocuments: string;
}

const toForm = (p?: Plan): PlanForm => ({
  name: p?.name ?? "",
  description: p?.description ?? "",
  models: p?.llmModels.join("\n") ?? "",
  dailyQuestionLimit: String(p?.dailyQuestionLimit ?? 200),
  maxUsers: p?.maxUsers?.toString() ?? "",
  maxDocuments: p?.maxDocuments?.toString() ?? "",
});

/** Crear o editar un plan. `plan` = null crea uno nuevo; `undefined` mantiene el diálogo cerrado. */
export function PlanDialog({ plan, open, onOpenChange, onSaved }: {
  plan: Plan | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<PlanForm>(toForm());
  const [busy, setBusy] = useState(false);
  const models = form.models.split(/[\n,]/).map((m) => m.trim()).filter(Boolean);
  const hasFree = models.some(isFree);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const payload = {
      name: form.name,
      description: form.description,
      llmModels: models,
      dailyQuestionLimit: Number(form.dailyQuestionLimit),
      maxUsers: form.maxUsers.trim() === "" ? null : Number(form.maxUsers),
      maxDocuments: form.maxDocuments.trim() === "" ? null : Number(form.maxDocuments),
    };
    try {
      if (plan) await api.put(`/platform/plans/${plan.id}`, payload);
      else await api.post("/platform/plans", payload);
      toast.success(plan ? "Plan actualizado" : "Plan creado");
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
      open={open}
      onOpenChange={(o) => {
        if (o) setForm(toForm(plan ?? undefined));
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{plan ? `Editar plan «${plan.name}»` : "Nuevo plan"}</DialogTitle>
            <DialogDescription>Define con qué modelos responde la organización y cuánto puede usar. Los cambios aplican a todas las organizaciones con este plan.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="p-name">Nombre</Label>
              <Input id="p-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={60} required autoFocus />
            </div>
            <div className="space-y-2">
              <Label htmlFor="p-desc">Descripción (opcional)</Label>
              <Input id="p-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={300} />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="p-models">Modelos, en orden de preferencia</Label>
              <Textarea id="p-models" value={form.models} onChange={(e) => setForm({ ...form, models: e.target.value })} rows={3} placeholder={"openai/gpt-4o-mini\ngoogle/gemini-2.0-flash-001"} className="font-mono text-xs" required />
              <p className="text-xs text-muted-foreground">Uno por línea. Si el primero falla o está saturado, se prueba el siguiente.</p>
              {hasFree && (
                <p className="flex gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  Los modelos «:free» tienen un cupo por cuenta de OpenRouter que comparten todas las organizaciones. Con varios clientes se saturan; para producción usa un modelo de pago.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="p-limit">Preguntas por día</Label>
              <Input id="p-limit" type="number" min={0} value={form.dailyQuestionLimit} onChange={(e) => setForm({ ...form, dailyQuestionLimit: e.target.value })} required />
              <p className="text-xs text-muted-foreground">0 = sin límite.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="p-users">Usuarios máximos</Label>
              <Input id="p-users" type="number" min={1} value={form.maxUsers} onChange={(e) => setForm({ ...form, maxUsers: e.target.value })} placeholder="Sin tope" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="p-docs">Documentos máximos</Label>
              <Input id="p-docs" type="number" min={1} value={form.maxDocuments} onChange={(e) => setForm({ ...form, maxDocuments: e.target.value })} placeholder="Sin tope" />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              {plan ? "Guardar" : "Crear plan"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Pestaña «Planes» de la plataforma. */
export function PlansTab({ onEdit }: { onEdit: (p: Plan) => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data, isLoading } = usePlans();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["plans"] });
    void qc.invalidateQueries({ queryKey: ["tenants"] });
  };

  const makeDefault = async (p: Plan) => {
    try {
      await api.post(`/platform/plans/${p.id}/default`);
      toast.success(`«${p.name}» es ahora el plan por defecto`);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const remove = async (p: Plan) => {
    const ok = await confirm({ title: `¿Borrar el plan «${p.name}»?`, description: "Solo se puede borrar si ninguna organización lo usa.", confirmText: "Borrar", destructive: true });
    if (!ok) return;
    try {
      await api.del(`/platform/plans/${p.id}`);
      toast.success("Plan borrado");
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  if (isLoading) return <Skeleton className="h-48 w-full" />;
  const plans = data?.plans ?? [];
  if (plans.length === 0) return <EmptyState icon={Layers} title="Sin planes" />;

  return (
    <TableCard>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-4">Plan</TableHead>
            <TableHead>Modelos</TableHead>
            <TableHead className="text-center">Preguntas / día</TableHead>
            <TableHead className="hidden text-center md:table-cell">Usuarios</TableHead>
            <TableHead className="hidden text-center md:table-cell">Documentos</TableHead>
            <TableHead className="text-center">Organizaciones</TableHead>
            <TableHead className="w-12" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {plans.map((p) => (
            <TableRow key={p.id}>
              <TableCell className="pl-4">
                <p className="flex items-center gap-2 font-medium">
                  {p.name}
                  {p.isDefault && <Badge variant="secondary">Por defecto</Badge>}
                </p>
                {p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}
              </TableCell>
              <TableCell>
                <p className="max-w-xs truncate font-mono text-xs" title={p.llmModels.join("\n")}>
                  {p.llmModels[0]}
                </p>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {p.llmModels.length > 1 && `+${p.llmModels.length - 1} de respaldo`}
                  {p.llmModels.some(isFree) && <Badge variant="outline" className="border-warning/30 font-normal text-warning">Incluye gratis</Badge>}
                </p>
              </TableCell>
              <TableCell className="text-center text-sm tabular-nums">{limitText(p.dailyQuestionLimit)}</TableCell>
              <TableCell className="hidden text-center text-sm tabular-nums md:table-cell">{limitText(p.maxUsers)}</TableCell>
              <TableCell className="hidden text-center text-sm tabular-nums md:table-cell">{limitText(p.maxDocuments)}</TableCell>
              <TableCell className="text-center text-sm tabular-nums">{p.tenants}</TableCell>
              <TableCell className="pr-3">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-8" aria-label="Acciones">
                      <EllipsisVertical />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onEdit(p)}>
                      <Pencil /> Editar
                    </DropdownMenuItem>
                    {!p.isDefault && (
                      <>
                        <DropdownMenuItem onSelect={() => void makeDefault(p)}>
                          <Star /> Marcar por defecto
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => void remove(p)}>
                          <Trash2 /> Borrar
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
  );
}
