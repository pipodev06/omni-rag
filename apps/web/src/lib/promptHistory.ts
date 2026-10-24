/**
 * Historial de preguntas del chat para recuperarlas con las flechas ↑ ↓ (como en una terminal). Se guarda solo en este
 * navegador, por usuario (`localStorage`), y se borra al cerrar sesión. Si el almacenamiento no está disponible, el chat
 * funciona igual y el historial se limita a los mensajes de la conversación abierta.
 */
const MAX = 50;
const key = (userId: string) => `rag:historial:${userId}`;

export function loadHistory(userId: string): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key(userId)) ?? "[]");
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** Guarda una pregunta enviada (sin repetir la anterior) y conserva las últimas 50. */
export function rememberPrompt(userId: string, text: string): void {
  const prompt = text.trim();
  if (!prompt) return;
  try {
    const items = loadHistory(userId);
    if (items[items.length - 1] === prompt) return;
    localStorage.setItem(key(userId), JSON.stringify([...items, prompt].slice(-MAX)));
  } catch {
    /* sin almacenamiento: no pasa nada */
  }
}

export function clearPromptHistory(userId?: string): void {
  try {
    if (userId) localStorage.removeItem(key(userId));
    else Object.keys(localStorage).filter((k) => k.startsWith("rag:historial:")).forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignorar */
  }
}

/**
 * Une lo guardado con los mensajes del usuario en la conversación abierta, del más antiguo al más reciente y sin repetidos
 * (se conserva la última aparición). Así, en una conversación vieja la primera ↑ trae su último mensaje.
 */
export function mergeHistory(stored: string[], conversation: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const all = [...stored, ...conversation].map((s) => s.trim()).filter(Boolean);
  for (let i = all.length - 1; i >= 0; i--) {
    if (!seen.has(all[i]!)) {
      seen.add(all[i]!);
      out.push(all[i]!);
    }
  }
  return out.reverse();
}

/** Posición del historial tras pulsar ↑ (`up`) o ↓: `null` = el borrador que se estaba escribiendo. */
export function nextHistoryIndex(length: number, index: number | null, direction: "up" | "down"): number | null {
  if (length === 0) return null;
  if (direction === "up") return index === null ? length - 1 : Math.max(0, index - 1);
  if (index === null) return null;
  return index + 1 >= length ? null : index + 1;
}
