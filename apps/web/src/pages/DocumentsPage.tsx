import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useDropzone } from "react-dropzone";
import { CloudUpload, Download, FolderInput, FolderOpen, FolderPlus, Loader2, RotateCw, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { errorMessage, uploadDocuments, type DocumentInfo, type UploadResult } from "@/api";
import { batches, expandUploads } from "@/lib/uploadPrep";
import { useCollectionDocuments, useDocumentActions } from "@/hooks/useDocuments";
import { useCurrentUser } from "@/hooks/useSession";
import { applyView, availableTypes, DEFAULT_VIEW, FIRST_DIR, isFiltered, type DocumentView, type SortKey } from "@/lib/documentView";
import { startDownload } from "@/lib/download";
import { cn } from "@/lib/utils";
import { EmptyState, Page, PageHeader } from "@/components/common";
import { CollectionFormDialog, MembersDialog } from "@/components/documents/CollectionDialogs";
import { CollectionToolbar } from "@/components/documents/CollectionToolbar";
import { DocumentFilters } from "@/components/documents/DocumentFilters";
import { DocumentsTable, type DocumentSelection } from "@/components/documents/DocumentsTable";
import { MoveDocumentDialog } from "@/components/documents/MoveDocumentDialog";
import { RenameDocumentDialog } from "@/components/documents/RenameDocumentDialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

function UploadZone({ collectionId, extensions, onUploaded }: { collectionId: string; extensions: string[]; onUploaded: () => void }) {
  const [progress, setProgress] = useState<number | null>(null);
  const [preparing, setPreparing] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);

  // Archivos sueltos, carpetas o ZIP: se abren los ZIP aquí y se sube en tandas pequeñas; al final, un solo aviso con el resumen.
  const upload = async (picked: File[]) => {
    if (picked.length === 0) return;
    setProgress(0);
    setPreparing(true);
    try {
      const { files, skipped } = await expandUploads(picked, extensions);
      setPreparing(false);
      const results: UploadResult[] = [];
      const total = files.reduce((sum, f) => sum + f.size, 0) || 1;
      let sent = 0;
      for (const batch of batches(files)) {
        const size = batch.reduce((sum, f) => sum + f.size, 0);
        const r = await uploadDocuments(collectionId, batch, (f) => setProgress((sent + f * size) / total));
        sent += size;
        results.push(...r.results);
      }
      const queued = results.filter((r) => r.status === "queued").length;
      const problems = [...results.filter((r) => r.status !== "queued").map((r) => `${r.filename}: ${r.reason}`), ...skipped];
      if (queued) toast.success(`${queued} archivo${queued > 1 ? "s" : ""} en cola para procesar`);
      if (problems.length) {
        toast.warning(`${problems.length} archivo${problems.length > 1 ? "s" : ""} no se subieron`, {
          description: problems.slice(0, 5).join(" · ") + (problems.length > 5 ? ` · y ${problems.length - 5} más` : ""),
          duration: 10_000,
        });
      }
      if (!queued && !problems.length) toast.warning("No había documentos para subir");
      onUploaded();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setProgress(null);
      setPreparing(false);
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (files) => void upload(files),
    disabled: progress !== null,
    // Sin filtro aquí: se descartan los formatos no admitidos al preparar y el servidor valida el resto.
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
      {/* Elegir una carpeta entera (el arrastre ya admite carpetas); webkitdirectory no está en los tipos de React. */}
      <input
        ref={folderInput}
        type="file"
        multiple
        hidden
        {...{ webkitdirectory: "" }}
        onChange={(e) => {
          void upload([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
      {progress === null ? (
        <>
          <div className="grid size-10 place-items-center rounded-full bg-primary/10 text-primary">
            <CloudUpload className="size-5" />
          </div>
          <p className="text-sm font-medium">{isDragActive ? "Suelta los archivos aquí" : "Arrastra archivos, carpetas o un ZIP, o haz clic para elegirlos"}</p>
          <p className="text-xs text-muted-foreground" title={extensions.join(" ")}>
            PDF, Word, PowerPoint, Excel, CSV, HTML, imágenes y texto ·{" "}
            <button
              type="button"
              className="font-medium text-primary hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                folderInput.current?.click();
              }}
            >
              elegir una carpeta
            </button>
          </p>
        </>
      ) : (
        <div className="w-full max-w-xs space-y-2">
          <p className="text-sm font-medium">{preparing ? "Preparando archivos…" : `Subiendo… ${Math.round(progress * 100)}%`}</p>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

function emptyDescription(search: string, filtered: boolean, canEdit: boolean): string | undefined {
  if (search) return `Ningún documento coincide con «${search}»${filtered ? " y los filtros activos" : ""}.`;
  if (filtered) return "Ningún documento cumple los filtros activos.";
  return canEdit ? "Sube el primer documento con el recuadro de arriba." : undefined;
}

/** Selección para acciones en lote: vale para la colección abierta y solo cuenta lo que sigue visible. */
function useDocumentSelection(documents: DocumentInfo[], canEdit: boolean, collectionId: string | undefined) {
  // Se guarda junto a la colección en la que se eligió: al cambiar de colección deja de valer sin efectos ni renders extra.
  const [picked, setPicked] = useState<{ collectionId?: string; ids: Set<string> }>({ ids: new Set() });
  const own = picked.collectionId === collectionId ? picked.ids : new Set<string>();
  const selectedDocs = documents.filter((d) => own.has(d.id));
  const selected = new Set(selectedDocs.map((d) => d.id)); // solo lo visible (con los filtros actuales)
  const update = (change: (ids: Set<string>) => void) =>
    setPicked((prev) => {
      const ids = new Set(prev.collectionId === collectionId ? prev.ids : []);
      change(ids);
      return { collectionId, ids };
    });
  const selection: DocumentSelection | undefined = canEdit
    ? {
        selected,
        onToggle: (id, checked) => update((ids) => (checked ? ids.add(id) : ids.delete(id))),
        onToggleAll: (checked) => update((ids) => (checked ? documents.forEach((d) => ids.add(d.id)) : ids.clear())),
      }
    : undefined;
  return { selectedDocs, selection, clear: () => setPicked({ ids: new Set() }) };
}

/** Barra de acciones en lote, con los botones a la derecha. Solo aparece con algo seleccionado. */
function SelectionBar({ docs, onClear, onMove, onReprocess, onDelete }: {
  docs: DocumentInfo[];
  onClear: () => void;
  onMove: () => void;
  onReprocess: () => void;
  onDelete: () => void;
}) {
  if (docs.length === 0) return null;
  // Los originales en un ZIP. Los topes son los de la API (100 documentos, 1 GB): se comprueban aquí para avisar sin esperar.
  const download = () => {
    if (docs.length > 100) return toast.warning("Se pueden descargar como máximo 100 documentos a la vez");
    if (docs.reduce((sum, d) => sum + d.sizeBytes, 0) > 1024 ** 3) {
      return toast.warning("Los documentos elegidos pasan de 1 GB: descárgalos en varias tandas");
    }
    startDownload(`/api/documents/download?ids=${docs.map((d) => d.id).join(",")}`);
  };
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
      <span className="font-medium">
        {docs.length} seleccionado{docs.length === 1 ? "" : "s"}
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onClear}>
          <X /> Quitar selección
        </Button>
        <Button size="sm" variant="outline" onClick={download}>
          <Download /> Descargar
        </Button>
        <Button size="sm" variant="outline" onClick={onMove}>
          <FolderInput /> Mover
        </Button>
        <Button size="sm" variant="outline" onClick={onReprocess}>
          <RotateCw /> Reprocesar
        </Button>
        <Button size="sm" variant="destructive" onClick={onDelete}>
          <Trash2 /> Enviar a la papelera
        </Button>
      </div>
    </div>
  );
}

/** Tabla de documentos, o su estado de carga / vacío. */
function DocumentsSection({ loading, documents, search, filtered, canEdit, selection, sort, onSort, onRename, onMove, onReprocess, onDelete }: {
  loading: boolean;
  documents: DocumentInfo[];
  search: string;
  canEdit: boolean;
  filtered: boolean;
  selection?: DocumentSelection;
  sort: DocumentView["sort"];
  onSort: (k: SortKey) => void;
  onRename: (d: DocumentInfo) => void;
  onMove: (d: DocumentInfo) => void;
  onReprocess: (d: DocumentInfo) => void;
  onDelete: (d: DocumentInfo) => void;
}) {
  if (loading) return <Skeleton className="h-48 w-full" />;
  if (documents.length === 0) {
    return (
      <EmptyState
        icon={search || filtered ? Search : FolderOpen}
        title={search || filtered ? "Sin resultados" : "Esta colección está vacía"}
        description={emptyDescription(search, filtered, canEdit)}
      />
    );
  }
  return <DocumentsTable documents={documents} canEdit={canEdit} selection={selection} sort={sort} onSort={onSort} onRename={onRename} onMove={onMove} onReprocess={onReprocess} onDelete={onDelete} />;
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
  const [moveDocs, setMoveDocs] = useState<DocumentInfo[] | null>(null);
  const [view, setView] = useState<DocumentView>(DEFAULT_VIEW);

  const { collections, current, loadingCollections, documents: found, loadingDocuments, refreshing, extensions } =
    useCollectionDocuments(routeCollection, search);
  const { refresh, removeDocument, removeDocuments, reprocess, reprocessDocuments, removeCollection } = useDocumentActions();

  // Filtros y orden de la tabla (en el navegador). Los filtros se reinician al cambiar de colección.
  const documents = applyView(found, view);
  const types = availableTypes(found);
  const onSort = (key: SortKey) =>
    setView((v) => ({ ...v, sort: v.sort.key === key ? { key, dir: v.sort.dir === "asc" ? "desc" : "asc" } : { key, dir: FIRST_DIR[key] } }));

  const currentId = current?.id;
  useEffect(() => {
    setView((v) => ({ ...DEFAULT_VIEW, sort: v.sort }));
  }, [currentId]);
  const { selectedDocs, selection, clear } = useDocumentSelection(documents, canEdit, currentId);

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
          <>
            {canEdit && (
              <Button variant="outline" asChild>
                <Link to="/papelera">
                  <Trash2 /> Papelera
                </Link>
              </Button>
            )}
            {isAdmin && (
              <Button onClick={() => setCollectionDialog("new")}>
                <FolderPlus /> Nueva colección
              </Button>
            )}
          </>
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
            filters={<DocumentFilters view={view} types={types} onChange={setView} />}
            onMembers={() => setMembersOpen(true)}
            onRename={() => setCollectionDialog("edit")}
            onDelete={() => void removeCollection(current)}
          />
          {current.description && <p className="-mt-2 text-sm text-muted-foreground">{current.description}</p>}

          {canEdit && <UploadZone collectionId={current.id} extensions={extensions} onUploaded={refresh} />}

          <SelectionBar
            docs={selectedDocs}
            onClear={clear}
            onMove={() => setMoveDocs(selectedDocs)}
            onReprocess={async () => (await reprocessDocuments(selectedDocs)) && clear()}
            onDelete={async () => (await removeDocuments(selectedDocs)) && clear()}
          />

          <DocumentsSection
            loading={loadingDocuments}
            documents={documents}
            search={search}
            filtered={isFiltered(view)}
            canEdit={canEdit}
            selection={selection}
            sort={view.sort}
            onSort={onSort}
            onRename={setRenameDoc}
            onMove={(d) => setMoveDocs([d])}
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
      <MoveDocumentDialog
        docs={moveDocs}
        collections={collections}
        onOpenChange={(o) => !o && setMoveDocs(null)}
        onMoved={() => {
          refresh();
          clear();
        }}
      />
      <RenameDocumentDialog doc={renameDoc} onOpenChange={(o) => !o && setRenameDoc(null)} onSaved={refresh} />
      {current && <MembersDialog open={membersOpen} onOpenChange={setMembersOpen} collection={current} onSaved={refresh} />}
    </Page>
  );
}
