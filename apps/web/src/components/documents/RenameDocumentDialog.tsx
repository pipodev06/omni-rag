import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage, type DocumentInfo } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Cambia el título con el que se muestra un documento (no toca el archivo original). */
export function RenameDocumentDialog({ doc, onOpenChange, onSaved }: { doc: DocumentInfo | null; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (doc) setTitle(doc.title);
  }, [doc]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!doc) return;
    setBusy(true);
    try {
      await api.patch(`/documents/${doc.id}`, { title });
      toast.success("Título actualizado");
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={doc !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>Renombrar documento</DialogTitle>
            <DialogDescription>Es el título que se ve en la lista, el visor y las citas. El archivo original no cambia.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="doc-title">Título</Label>
            <Input id="doc-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required autoFocus />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy || title.trim() === "" || title.trim() === doc?.title}>
              {busy && <Loader2 className="animate-spin" />}
              Guardar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
