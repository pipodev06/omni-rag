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

  return { refresh, removeDocument, reprocess, removeCollection };
}
