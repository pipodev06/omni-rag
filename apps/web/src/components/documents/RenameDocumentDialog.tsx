import { api, type DocumentInfo } from "@/api";
import { RenameDialog } from "@/components/RenameDialog";

/** Cambia el título con el que se muestra un documento (no toca el archivo original). */
export function RenameDocumentDialog({ doc, onOpenChange, onSaved }: { doc: DocumentInfo | null; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  return (
    <RenameDialog
      current={doc?.title ?? null}
      title="Renombrar documento"
      description="Es el título que se ve en la lista, el visor y las citas. El archivo original no cambia."
      maxLength={200}
      onOpenChange={onOpenChange}
      onSave={async (title) => {
        await api.patch(`/documents/${doc!.id}`, { title });
        onSaved();
      }}
    />
  );
}
