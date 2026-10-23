import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

interface DocumentEvent {
  op: "insert" | "update" | "delete";
  documentId: string;
  collectionId: string;
  title: string;
  status: "pending" | "processing" | "ready" | "failed";
  error: string | null;
  mine: boolean;
}

/**
 * Escucha los avisos de cambios de documentos (Server-Sent Events) y:
 *  - refresca al instante las listas de documentos y colecciones;
 *  - avisa al usuario cuando un documento que subió está listo o falló.
 * Si la conexión se corta, el navegador la reabre solo (EventSource). Con `enabled = false` no se conecta.
 */
export function useDocumentEvents(enabled = true) {
  const qc = useQueryClient();
  const connected = useRef(false);

  useEffect(() => {
    if (!enabled) return; // sin permiso aún (p. ej. falta activar el 2FA obligatorio) la API responde 403 y el navegador no reintenta
    const source = new EventSource("/api/documents/events");
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    // Agrupa avisos seguidos (p. ej. al subir 20 archivos) en un solo refresco.
    const refresh = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void qc.invalidateQueries({ queryKey: ["documents"] });
        void qc.invalidateQueries({ queryKey: ["collections"] });
        void qc.invalidateQueries({ queryKey: ["suggestions"] });
      }, 300);
    };

    source.addEventListener("ready", () => {
      // Tras una reconexión puede haberse perdido algún aviso: refrescar.
      if (connected.current) refresh();
      connected.current = true;
    });

    source.addEventListener("document", (msg) => {
      const e = JSON.parse((msg as MessageEvent<string>).data) as DocumentEvent;
      refresh();
      void qc.invalidateQueries({ queryKey: ["document", e.documentId] });
      if (e.op !== "update" || !e.mine) return;
      if (e.status === "ready") toast.success(`«${e.title}» está listo`, { description: "Ya puedes preguntar sobre él en el chat." });
      if (e.status === "failed") toast.error(`No se pudo procesar «${e.title}»`, { description: e.error ?? undefined });
    });

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      source.close();
    };
  }, [qc, enabled]);
}
