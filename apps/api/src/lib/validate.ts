import { z } from "zod";
import { badRequest } from "./errors.js";

/** Valida datos con un esquema zod; si fallan, responde 400 con un mensaje legible. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const msg = r.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
    throw badRequest(msg);
  }
  return r.data;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Nombre de usuario para iniciar sesión: minúsculas, números, punto, guion y guion bajo. */
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/;

export const UsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(USERNAME_RE, "el usuario debe tener 3-40 caracteres: minúsculas, números, punto, guion o guion bajo");

/** Email opcional: vacío o ausente = sin email. */
export const OptionalEmailSchema = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.string().trim().email().max(254).nullable().optional(),
);
