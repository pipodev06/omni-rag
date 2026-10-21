/**
 * Cliente de la API. La sesión viaja en una cookie httpOnly, así que no hace
 * falta guardar ningún token en el navegador.
 */

export type Role = "admin" | "editor" | "viewer";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  isSuperadmin: boolean;
}

export interface Tenant {
  name: string;
  slug: string;
}

export interface Collection {
  id: string;
  name: string;
  description: string;
  documentCount: number;
  memberIds: string[];
}

export interface DocumentInfo {
  id: string;
  collectionId: string;
  title: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: "pending" | "processing" | "ready" | "failed";
  error: string | null;
  pageCount: number | null;
  chunkCount: number;
  createdAt: string;
  createdBy?: string | null;
  hasSummary?: boolean;
}

export interface Source {
  n: number;
  documentId: string;
  documentTitle: string;
  heading: string;
  pageStart: number | null;
  pageEnd: number | null;
  excerpt: string;
  cited: boolean;
}

export interface Message {
  id?: string;
  /** Identificador local (mensajes creados en esta pantalla), estable mientras llega la respuesta. */
  localId?: string;
  role: "user" | "assistant";
  content: string;
  sources: Source[];
  model?: string | null;
  error?: string;
  /** La respuesta salió de la caché (no se llamó al LLM). */
  fromCache?: boolean;
  /** Valoración del usuario: 1 = 👍, -1 = 👎. */
  feedback?: 1 | -1 | null;
}

export interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
}

export interface TenantUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  lastLoginAt: string | null;
  collectionIds: string[];
  /** Invitado que aún no ha elegido contraseña. */
  pendingInvite: boolean;
}

/** Resultado de crear un enlace de invitación o de restablecimiento. */
export interface LinkResult {
  kind: "invite" | "reset";
  url: string;
  emailSent: boolean;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(`/api${url}`, {
    method,
    credentials: "same-origin",
    headers: body && !isForm ? { "content-type": "application/json" } : undefined,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  if (!res.ok) {
    // La API devuelve { error } con un mensaje legible también en los errores.
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && url !== "/auth/login") window.dispatchEvent(new Event("rag:unauthorized"));
    throw new ApiError(res.status, (data as { error?: string }).error ?? `Error ${res.status}`);
  }
  return (await res.json().catch(() => ({}))) as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>("PUT", url, body ?? {}),
  patch: <T>(url: string, body?: unknown) => request<T>("PATCH", url, body ?? {}),
  del: <T>(url: string) => request<T>("DELETE", url),
};

export interface ChatHandlers {
  onMeta: (meta: { conversationId: string; sources: Source[] }) => void;
  onToken: (text: string) => void;
  onDone: (done: { messageId: string; model: string | null; sources: Source[]; fromCache?: boolean }) => void;
  onError: (message: string) => void;
}

/** Envía una pregunta y procesa la respuesta en streaming (Server-Sent Events). */
export async function streamChat(
  body: { question: string; conversationId?: string; collectionIds?: string[]; documentIds?: string[] },
  handlers: ChatHandlers,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) window.dispatchEvent(new Event("rag:unauthorized"));
    handlers.onError((data as { error?: string }).error ?? `Error ${res.status}`);
    return;
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length === 0) continue;
      const payload = JSON.parse(data.join("\n"));
      if (event === "meta") handlers.onMeta(payload);
      else if (event === "token") handlers.onToken(payload);
      else if (event === "done") handlers.onDone(payload);
      else if (event === "error") handlers.onError(payload.message);
    }
  }
}

/**
 * Sube archivos con progreso (fetch no informa del progreso de subida).
 * onProgress recibe un valor entre 0 y 1.
 */
export function uploadDocuments(
  collectionId: string,
  files: File[],
  onProgress: (fraction: number) => void,
): Promise<{ results: { filename: string; id?: string; status: "queued" | "duplicate" | "rejected"; reason?: string }[] }> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("collectionId", collectionId);
    for (const f of files) form.append("file", f);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/documents");
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data: { error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* respuesta sin JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as never);
      else {
        if (xhr.status === 401) window.dispatchEvent(new Event("rag:unauthorized"));
        reject(new ApiError(xhr.status, data.error ?? `Error ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "Error de red al subir los archivos"));
    xhr.send(form);
  });
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : "Error inesperado");

export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;

const dateFormat = new Intl.DateTimeFormat("es", { dateStyle: "short", timeStyle: "short" });
const shortDateFormat = new Intl.DateTimeFormat("es", { day: "numeric", month: "short" });
const relativeFormat = new Intl.RelativeTimeFormat("es", { numeric: "auto" });

export const formatDate = (iso: string | null) => (iso ? dateFormat.format(new Date(iso)) : "—");

/** "hace 5 min", "ayer"… */
export function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  const rtf = relativeFormat;
  if (diff < 60) return "ahora";
  if (diff < 3600) return rtf.format(-Math.round(diff / 60), "minute");
  if (diff < 86400) return rtf.format(-Math.round(diff / 3600), "hour");
  if (diff < 86400 * 7) return rtf.format(-Math.round(diff / 86400), "day");
  return shortDateFormat.format(new Date(iso));
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => /^\p{L}/u.test(w)) // solo palabras que empiezan por letra, p. ej. no "(soporte)"
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

export const ROLE_LABELS: Record<Role, string> = { admin: "Administrador", editor: "Editor", viewer: "Lector" };

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: "Gestiona usuarios, colecciones y todos los documentos",
  editor: "Sube y borra documentos en sus colecciones",
  viewer: "Solo pregunta sobre sus colecciones",
};

export interface Session {
  user: User;
  tenant: Tenant;
  /** Presente cuando el superadministrador está dentro de esta organización como soporte. */
  support: { name: string; email: string } | null;
}
