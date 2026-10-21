import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useDropzone } from "react-dropzone";
import { CloudUpload, FolderOpen, FolderPlus, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { errorMessage, uploadDocuments, type DocumentInfo } from "@/api";
import { useCollectionDocuments, useDocumentActions } from "@/hooks/useDocuments";
import { useCurrentUser } from "@/hooks/useSession";
import { cn } from "@/lib/utils";
import { EmptyState, Page, PageHeader } from "@/components/common";
import { CollectionFormDialog, MembersDialog } from "@/components/documents/CollectionDialogs";
import { CollectionToolbar } from "@/components/documents/CollectionToolbar";
import { DocumentsTable } from "@/components/documents/DocumentsTable";
import { RenameDocumentDialog } from "@/components/documents/RenameDocumentDialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

function UploadZone({ collectionId, extensions, onUploaded }: { collectionId: string; extensions: string[]; onUploaded: () => void }) {
  const [progress, setProgress] = useState<number | null>(null);

  const upload = async (files: File[]) => {
    if (files.length === 0) return;
    setProgress(0);
    try {
      const { results } = await uploadDocuments(collectionId, files, setProgress);
      const queued = results.filter((r) => r.status === "queued").length;
      if (queued) toast.success(`${queued} archivo${queued > 1 ? "s" : ""} en cola para procesar`);
      for (const r of results.filter((x) => x.status !== "queued")) {
        toast.warning(`${r.filename}: ${r.reason}`);
      }
      onUploaded();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setProgress(null);
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (files) => void upload(files),
    disabled: progress !== null,
    // Sin filtro aquí: el servidor valida y explica por qué rechaza cada archivo.
  });

  return (
    <div
      {...getRootProps()}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors",
        isDragActive ? "border-primary bg-primary/5" : "hover:border-primary/40 hover:bg-muted/40",
        progress !== null && "pointer-events-none",
      )}
    >
      <input {...getInputProps()} />
      {progress === null ? (
        <>
          <div className="grid size-10 place-items-center rounded-full bg-primary/10 text-primary">
            <CloudUpload className="size-5" />
          </div>
          <p className="text-sm font-medium">{isDragActive ? "Suelta los archivos aquí" : "Arrastra archivos o haz clic para elegirlos"}</p>
          <p className="text-xs text-muted-foreground" title={extensions.join(" ")}>
            PDF, Word, PowerPoint, Excel, CSV, HTML, imágenes y texto
          </p>
        </>
      ) : (
        <div className="w-full max-w-xs space-y-2">
          <p className="text-sm font-medium">Subiendo… {Math.round(progress * 100)}%</p>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Tabla de documentos, o su estado de carga / vacío. */
function DocumentsSection({ loading, documents, search, canEdit, onRename, onReprocess, onDelete }: {
  loading: boolean;
  documents: DocumentInfo[];
  search: string;
  canEdit: boolean;
  onRename: (d: DocumentInfo) => void;
  onReprocess: (d: DocumentInfo) => void;
  onDelete: (d: DocumentInfo) => void;
}) {
  if (loading) return <Skeleton className="h-48 w-full" />;
  if (documents.length === 0) {
    return (
      <EmptyState
        icon={search ? Search : FolderOpen}
        title={search ? "Sin resultados" : "Esta colección está vacía"}
        description={search ? `Ningún documento coincide con «${search}».` : canEdit ? "Sube el primer documento con el recuadro de arriba." : undefined}
      />
    );
  }
  return <DocumentsTable documents={documents} canEdit={canEdit} onRename={onRename} onReprocess={onReprocess} onDelete={onDelete} />;
}

export function DocumentsPage() {
  const { user } = useCurrentUser();
  const canEdit = user.role === "admin" || user.role === "editor";
  const isAdmin = user.role === "admin";
  const { collectionId: routeCollection } = useParams();
  const navigate = useNavigate();

  const [search, setSearch] = useState("");
  const [collectionDialog, setCollectionDialog] = useState<"new" | "edit" | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [renameDoc, setRenameDoc] = useState<DocumentInfo | null>(null);

  const { collections, current, loadingCollections, documents, loadingDocuments, refreshing, extensions } =
    useCollectionDocuments(routeCollection, search);
  const { refresh, removeDocument, reprocess, removeCollection } = useDocumentActions();

  if (loadingCollections) {
    return (
      <Page>
        <Skeleton className="mb-6 h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </Page>
    );
  }

  return (
    <Page fill>
      <PageHeader
        title="Documentos"
        description="Los documentos se procesan automáticamente al subirse y quedan disponibles para consultar en el chat."
        actions={
          isAdmin && (
            <Button onClick={() => setCollectionDialog("new")}>
              <FolderPlus /> Nueva colección
            </Button>
          )
        }
      />

      {!current ? (
        <EmptyState
          icon={FolderOpen}
          title={isAdmin ? "Crea tu primera colección" : "Aún no tienes acceso a ninguna colección"}
          description={isAdmin ? "Las colecciones son carpetas de documentos con su propio control de acceso." : "Pide a un administrador que te dé acceso."}
          action={isAdmin && <Button onClick={() => setCollectionDialog("new")}><FolderPlus /> Nueva colección</Button>}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-5">
          <CollectionToolbar
            collections={collections}
            current={current}
            isAdmin={isAdmin}
            search={search}
            onSearch={setSearch}
            onMembers={() => setMembersOpen(true)}
            onRename={() => setCollectionDialog("edit")}
            onDelete={() => void removeCollection(current)}
          />
          {current.description && <p className="-mt-2 text-sm text-muted-foreground">{current.description}</p>}

          {canEdit && <UploadZone collectionId={current.id} extensions={extensions} onUploaded={refresh} />}

          <DocumentsSection
            loading={loadingDocuments}
            documents={documents}
            search={search}
            canEdit={canEdit}
            onRename={setRenameDoc}
            onReprocess={(d) => void reprocess(d)}
            onDelete={(d) => void removeDocument(d)}
          />
          {refreshing && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Actualizando…
            </p>
          )}
        </div>
      )}

      <CollectionFormDialog
        open={collectionDialog !== null}
        onOpenChange={(o) => !o && setCollectionDialog(null)}
        collection={collectionDialog === "edit" ? current : undefined}
        onSaved={(id) => {
          refresh();
          navigate(`/documentos/${id}`);
        }}
      />
      <RenameDocumentDialog doc={renameDoc} onOpenChange={(o) => !o && setRenameDoc(null)} onSaved={refresh} />
      {current && <MembersDialog open={membersOpen} onOpenChange={setMembersOpen} collection={current} onSaved={refresh} />}
    </Page>
  );
}
