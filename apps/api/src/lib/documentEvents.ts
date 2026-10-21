import { EventEmitter } from "node:events";
import { sqlOwner } from "../db/client.js";

/** Aviso de cambio en un documento (lo emite el trigger de la migración 003). */
export interface DocumentEvent {
  op: "insert" | "update" | "delete";
  tenantId: string;
  collectionId: string;
  documentId: string;
  title: string;
  status: "pending" | "processing" | "ready" | "failed";
  error: string | null;
  createdBy: string | null;
}

/**
 * Escucha el canal `document_events` de PostgreSQL (una sola conexión para
 * toda la API) y reparte los avisos a los suscriptores en memoria.
 * Funciona aunque el cambio lo haga otro proceso (el worker).
 */
const bus = new EventEmitter();
bus.setMaxListeners(0);
let listening: Promise<unknown> | null = null;

function ensureListening() {
  listening ??= sqlOwner
    .listen("document_events", (payload) => {
      try {
        bus.emit("event", JSON.parse(payload) as DocumentEvent);
      } catch {
        /* aviso mal formado: se ignora */
      }
    })
    .catch((err) => {
      console.error("[eventos] no se pudo escuchar document_events:", err);
      listening = null;
    });
  return listening;
}

/** Se suscribe a los avisos. Devuelve la función para cancelar la suscripción. */
export async function subscribeDocumentEvents(fn: (e: DocumentEvent) => void): Promise<() => void> {
  await ensureListening();
  bus.on("event", fn);
  return () => bus.off("event", fn);
}
