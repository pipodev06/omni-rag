import type { Message } from "@/api";

/** Clave estable de un mensaje: la local (si se creó en esta pantalla) o la del servidor. */
export const messageKey = (m: Message, index: number) => m.localId ?? m.id ?? `i${index}`;
