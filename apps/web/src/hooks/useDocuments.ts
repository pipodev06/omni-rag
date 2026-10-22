import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, type Collection, type DocumentInfo } from "@/api";
import { useConfirm } from "@/components/ConfirmProvider";

const isProcessing = (d: DocumentInfo) => d.status === "pending" || d.status === "processing";

/** Colecciones visibles, la colección actual y sus documentos (filtrados por `search`). */
export function useCollectionDocuments(routeCollection: string | undefined, search: string) {
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
    // Los cambios llegan en tiempo real (useDocumentEvents). Esto es solo un
    // respaldo por si la conexión en vivo falla mientras hay documentos procesándose.
    refetchInterval: (q) => (q.state.data?.documents.some(isProcessing) ? 20_000 : false),
  });
  const documents = docsQuery.data?.documents ?? [];
  const needle = search.toLowerCase();
  const filtered = needle ? documents.filter((d) => `${d.title} ${d.filename}`.toLowerCase().includes(needle)) : documents;

  return {
    collections,
    current,
    loadingCollections: collectionsQuery.isLoading,
    documents: filtered,
    loadingDocuments: docsQuery.isLoading,
    refreshing: docsQuery.isFetching && !docsQuery.isLoading,
    extensions: docsQuery.data?.supportedExtensions ?? [],
  };
}

/** Acciones sobre documentos y colecciones, con confirmación y avisos. */
export function useDocumentActions() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();

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

  const removeDocuments = async (ds: DocumentInfo[]) => {
    if (ds.length === 0) return false;
    const names = ds.slice(0, 5).map((d) => `«${d.title}»`).join(", ");
    const ok = await confirm({
      title: `¿Borrar ${ds.length} documento${ds.length === 1 ? "" : "s"}?`,
      description: `${names}${ds.length > 5 ? ` y ${ds.length - 5} más` : ""}. Se eliminarán los archivos y dejarán de aparecer en las respuestas. No se puede deshacer.`,
      confirmText: `Borrar ${ds.length}`,
      destructive: true,
    });
    if (!ok) return false;
    try {
      const r = await api.post<{ deleted: number; notFound: number }>("/documents/bulk-delete", { ids: ds.map((d) => d.id) });
      toast.success(`${r.deleted} documento${r.deleted === 1 ? "" : "s"} borrado${r.deleted === 1 ? "" : "s"}`, {
        description: r.notFound > 0 ? `${r.notFound} no se pudieron borrar (ya no existían o no tienes permiso).` : undefined,
      });
      refresh();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };

  const reprocessDocuments = async (ds: DocumentInfo[]) => {
    try {
      const r = await api.post<{ reprocessed: number; skipped: number }>("/documents/reprocess", { ids: ds.map((d) => d.id) });
      toast.success(`${r.reprocessed} documento${r.reprocessed === 1 ? "" : "s"} en cola para reprocesar`, {
        description: r.skipped > 0 ? `${r.skipped} se omitieron porque ya se estaban procesando.` : undefined,
      });
      refresh();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };

  const reprocess = (d: DocumentInfo) => run(() => api.post(`/documents/${d.id}/reprocess`), "Reprocesando documento");

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

  return { refresh, removeDocument, removeDocuments, reprocess, reprocessDocuments, removeCollection };
}
