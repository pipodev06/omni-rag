import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDropzone } from "react-dropzone";
import {
  CloudUpload,
  Download,
  EllipsisVertical,
  Eye,
  FolderOpen,
  FolderPlus,
  Loader2,
  Pencil,
  RotateCw,
  Search,
  Trash2,
  UserRoundCog,
} from "lucide-react";
import { toast } from "sonner";
import {
  api,
  errorMessage,
  formatBytes,
  timeAgo,
  uploadDocuments,
  type Collection,
  type DocumentInfo,
} from "@/api";
import { useCurrentUser } from "@/hooks/useSession";
import { cn } from "@/lib/utils";
import { EmptyState, FileTypeIcon, Page, PageHeader, StatusBadge } from "@/components/common";
import { useConfirm } from "@/components/ConfirmProvider";
import { ChunksSheet } from "@/components/documents/ChunksSheet";
import { CollectionFormDialog, MembersDialog } from "@/components/documents/CollectionDialogs";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

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

export function DocumentsPage() {
  const { user } = useCurrentUser();
  const canEdit = user.role === "admin" || user.role === "editor";
  const isAdmin = user.role === "admin";
  const { collectionId: routeCollection } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();

  const [search, setSearch] = useState("");
  const [collectionDialog, setCollectionDialog] = useState<"new" | "edit" | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [chunksDoc, setChunksDoc] = useState<DocumentInfo | null>(null);

  const collectionsQuery = useQuery({
    queryKey: ["collections"],
    queryFn: () => api.get<{ collections: Collection[] }>("/collections"),
  });
  const collections = collectionsQuery.data?.collections ?? [];
  const current = collections.find((c) => c.id === routeCollection) ?? collections[0];

  const docsQuery = useQuery({
    queryKey: ["documents", current?.id],
    queryFn: () => api.get<{ documents: DocumentInfo[]; supportedExtensions: string[] }>(`/documents?collectionId=${current!.id}`),
    enabled: !!current,
    // Mientras haya documentos procesándose, refrescar cada 3 segundos.
    refetchInterval: (q) => (q.state.data?.documents.some((d) => d.status === "pending" || d.status === "processing") ? 3000 : false),
  });
  const documents = docsQuery.data?.documents ?? [];
  const filtered = search
    ? documents.filter((d) => `${d.title} ${d.filename}`.toLowerCase().includes(search.toLowerCase()))
    : documents;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["documents"] });
    void qc.invalidateQueries({ queryKey: ["collections"] });
  };

  const run = async (fn: () => Promise<unknown>, success: string) => {
    try {
      await fn();
      toast.success(success);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const removeDocument = async (d: DocumentInfo) => {
    const ok = await confirm({
      title: `¿Borrar «${d.title}»?`,
      description: "Se eliminará el archivo y dejará de aparecer en las respuestas. No se puede deshacer.",
      confirmText: "Borrar",
      destructive: true,
    });
    if (ok) await run(() => api.del(`/documents/${d.id}`), "Documento borrado");
  };

  const removeCollection = async (c: Collection) => {
    const ok = await confirm({
      title: `¿Borrar la colección «${c.name}»?`,
      description: `Se borrarán también sus ${c.documentCount} documentos. No se puede deshacer.`,
      confirmText: "Borrar colección",
      destructive: true,
    });
    if (!ok) return;
    await run(() => api.del(`/collections/${c.id}`), "Colección borrada");
    navigate("/documentos");
  };

  if (collectionsQuery.isLoading) {
    return (
      <Page>
        <Skeleton className="mb-6 h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Documentos"
        description="Los documentos se procesan automáticamente al subirlos y quedan disponibles en el chat."
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
        <div className="space-y-5">
          {/* Selector de colección y acciones */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Select value={current.id} onValueChange={(id) => navigate(`/documentos/${id}`)}>
              <SelectTrigger className="w-full justify-start sm:w-72 [&>svg:last-child]:ml-auto">
                <FolderOpen className="text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {collections.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} <span className="text-muted-foreground">({c.documentCount})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isAdmin && (
              <div className="flex gap-1">
                <Button variant="outline" size="sm" onClick={() => setMembersOpen(true)}>
                  <UserRoundCog /> Acceso
                  <span className="text-muted-foreground">({current.memberIds.length})</span>
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon" className="size-8" aria-label="Más acciones de la colección">
                      <EllipsisVertical />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setCollectionDialog("edit")}>
                      <Pencil /> Renombrar
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => void removeCollection(current)}>
                      <Trash2 /> Borrar colección
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
            <div className="relative sm:ml-auto sm:w-64">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nombre…" className="pl-9" />
            </div>
          </div>
          {current.description && <p className="-mt-2 text-sm text-muted-foreground">{current.description}</p>}

          {canEdit && <UploadZone collectionId={current.id} extensions={docsQuery.data?.supportedExtensions ?? []} onUploaded={refresh} />}

          {/* Tabla de documentos */}
          {docsQuery.isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={search ? Search : FolderOpen}
              title={search ? "Sin resultados" : "Esta colección está vacía"}
              description={search ? `Ningún documento coincide con «${search}».` : canEdit ? "Sube el primer documento con el recuadro de arriba." : undefined}
            />
          ) : (
            <div className="overflow-hidden rounded-xl border bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-4">Documento</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead className="hidden md:table-cell">Tamaño</TableHead>
                    <TableHead className="hidden md:table-cell">Páginas</TableHead>
                    <TableHead className="hidden lg:table-cell">Fragmentos</TableHead>
                    <TableHead className="hidden sm:table-cell">Subido</TableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="pl-4">
                        <div className="flex items-center gap-3">
                          <FileTypeIcon filename={d.filename} />
                          <div className="min-w-0">
                            <p className="max-w-[16rem] truncate font-medium lg:max-w-sm">{d.title}</p>
                            <p className="max-w-[16rem] truncate text-xs text-muted-foreground lg:max-w-sm">{d.filename}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {d.error ? (
                          <Tooltip>
                            <TooltipTrigger>
                              <StatusBadge status={d.status} />
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">{d.error}</TooltipContent>
                          </Tooltip>
                        ) : (
                          <StatusBadge status={d.status} />
                        )}
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground md:table-cell">{formatBytes(d.sizeBytes)}</TableCell>
                      <TableCell className="hidden text-muted-foreground md:table-cell">{d.pageCount ?? "—"}</TableCell>
                      <TableCell className="hidden text-muted-foreground lg:table-cell">{d.chunkCount}</TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <p className="text-sm">{timeAgo(d.createdAt)}</p>
                        {d.createdBy && <p className="text-xs text-muted-foreground">{d.createdBy}</p>}
                      </TableCell>
                      <TableCell className="pr-3">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-8" aria-label="Acciones">
                              <EllipsisVertical />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem asChild>
                              <a href={`/api/documents/${d.id}/file`}>
                                <Download /> Descargar original
                              </a>
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={d.status !== "ready"} onSelect={() => setChunksDoc(d)}>
                              <Eye /> Ver fragmentos
                            </DropdownMenuItem>
                            {canEdit && (
                              <>
                                <DropdownMenuItem onSelect={() => void run(() => api.post(`/documents/${d.id}/reprocess`), "Reprocesando documento")}>
                                  <RotateCw /> Reprocesar
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem variant="destructive" onSelect={() => void removeDocument(d)}>
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
            </div>
          )}
          {docsQuery.isFetching && !docsQuery.isLoading && (
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
      {current && <MembersDialog open={membersOpen} onOpenChange={setMembersOpen} collection={current} onSaved={refresh} />}
      <ChunksSheet document={chunksDoc} onOpenChange={(o) => !o && setChunksDoc(null)} />
    </Page>
  );
}
