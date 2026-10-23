import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, type TrashedDocument } from "@/api";
import { useConfirm } from "@/components/ConfirmProvider";

/** Documentos de la papelera. La clave empieza por «documents»: los avisos en vivo y las acciones también la refrescan. */
export function useTrash() {
  const query = useQuery({
    queryKey: ["documents", "trash"],
    queryFn: () => api.get<{ documents: TrashedDocument[]; retentionDays: number }>("/documents/trash"),
  });
  return {
    documents: query.data?.documents ?? [],
    retentionDays: query.data?.retentionDays ?? 30,
    loading: query.isLoading,
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Restaurar y eliminar definitivamente, con confirmación y avisos. Devuelven `true` si se hizo algo. */
export function useTrashActions() {
  const qc = useQueryClient();
  const confirm = useConfirm();

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["documents"] });
    void qc.invalidateQueries({ queryKey: ["collections"] });
  };

  const restore = async (ds: TrashedDocument[]) => {
    try {
      const r = await api.post<{ restored: number; skipped: number; reason: string | null }>("/documents/restore", { ids: ds.map((d) => d.id) });
      if (r.restored > 0) {
        toast.success(`${plural(r.restored, "documento restaurado", "documentos restaurados")}`, {
          description: r.reason ?? "Vuelven a aparecer en su colección y en las respuestas del chat.",
        });
      } else {
        toast.warning("No se restauró ningún documento", { description: r.reason ?? undefined });
      }
      refresh();
      return r.restored > 0;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };

  const purge = async (ds: TrashedDocument[]) => {
    const names = ds.slice(0, 5).map((d) => `«${d.title}»`).join(", ");
    const ok = await confirm({
      title: `¿Eliminar definitivamente ${plural(ds.length, "documento", "documentos")}?`,
      description: `${names}${ds.length > 5 ? ` y ${ds.length - 5} más` : ""}. Se borrarán también sus archivos. No se puede deshacer.`,
      confirmText: `Eliminar ${ds.length}`,
      destructive: true,
    });
    if (!ok) return false;
    try {
      const r = await api.post<{ purged: number }>("/documents/purge", { ids: ds.map((d) => d.id) });
      toast.success(`${plural(r.purged, "documento eliminado", "documentos eliminados")} definitivamente`);
      refresh();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };

  const emptyTrash = async (count: number) => {
    const ok = await confirm({
      title: "¿Vaciar la papelera?",
      description: `Se eliminarán definitivamente ${plural(count, "documento", "documentos")} y sus archivos. No se puede deshacer.`,
      confirmText: "Vaciar papelera",
      destructive: true,
    });
    if (!ok) return false;
    try {
      const r = await api.post<{ purged: number }>("/documents/purge", { all: true });
      toast.success(`Papelera vaciada (${plural(r.purged, "documento", "documentos")})`);
      refresh();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };

  return { restore, purge, emptyTrash };
}
