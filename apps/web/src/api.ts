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
  role: "user" | "assistant";
  content: string;
  sources: Source[];
  model?: string | null;
  error?: string;
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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && url !== "/auth/login") window.dispatchEvent(new Event("rag:unauthorized"));
    throw new ApiError(res.status, (data as { error?: string }).error ?? `Error ${res.status}`);
  }
  return data as T;
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
  onDone: (done: { messageId: string; model: string | null; sources: Source[] }) => void;
  onError: (message: string) => void;
}

/** Envía una pregunta y procesa la respuesta en streaming (Server-Sent Events). */
export async function streamChat(
  body: { question: string; conversationId?: string; collectionIds?: string[] },
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

export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;

export const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("es", { dateStyle: "short", timeStyle: "short" }) : "—";

export const ROLE_LABELS: Record<Role, string> = { admin: "Administrador", editor: "Editor", viewer: "Lector" };
