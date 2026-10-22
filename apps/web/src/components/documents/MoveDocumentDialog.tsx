import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage, type Collection, type DocumentInfo } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface MoveResult {
  moved: number;
  skipped: { id: string; title: string; reason: string }[];
}

/** Mueve uno o varios documentos a otra colección (conserva título, resumen y fragmentos; cambia quién puede verlos). */
export function MoveDocumentDialog({ docs, collections, onOpenChange, onMoved }: {
  docs: DocumentInfo[] | null;
  collections: Collection[];
  onOpenChange: (o: boolean) => void;
  onMoved: () => void;
}) {
  // La colección donde ya están todos los documentos elegidos no es un destino válido.
  const targets = collections.filter((c) => !docs?.every((d) => d.collectionId === c.id));
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (docs) setTarget("");
  }, [docs]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!docs || !target) return;
    setBusy(true);
    try {
      const r = await api.post<MoveResult>("/documents/move", { ids: docs.map((d) => d.id), collectionId: target });
      const name = targets.find((c) => c.id === target)?.name;
      // Los que no se pudieron mover se explican (en proceso, ya estaban allí, duplicados…).
      const why = r.skipped.slice(0, 3).map((s) => `${s.title ? `«${s.title}»` : "Un documento"}: ${s.reason}`).join(" · ");
      const more = r.skipped.length > 3 ? ` · y ${r.skipped.length - 3} más` : "";
      if (r.moved > 0) {
        toast.success(`${r.moved} documento${r.moved === 1 ? "" : "s"} movido${r.moved === 1 ? "" : "s"} a «${name}»`, {
          description: r.skipped.length > 0 ? `No se movieron ${r.skipped.length}: ${why}${more}` : undefined,
        });
      } else {
        toast.error("No se movió ningún documento", { description: `${why}${more}` });
      }
      onMoved();
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const many = (docs?.length ?? 0) > 1;
  return (
    <Dialog open={docs !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{many ? `Mover ${docs?.length} documentos` : `Mover «${docs?.[0]?.title}»`}</DialogTitle>
            <DialogDescription>
              Pasan a la colección elegida sin volver a procesarse. A partir de ahora los verán quienes tengan acceso a esa colección, no a la actual. Los que se estén procesando o ya existan en el destino se omiten.
            </DialogDescription>
          </DialogHeader>
          {targets.length === 0 ? (
            <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">No hay otra colección a la que puedas mover documentos.</p>
          ) : (
            <div className="space-y-2">
              <Label>Colección de destino</Label>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Elige una colección" />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name} <span className="text-muted-foreground">({c.documentCount})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy || !target}>
              {busy && <Loader2 className="animate-spin" />}
              Mover
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
