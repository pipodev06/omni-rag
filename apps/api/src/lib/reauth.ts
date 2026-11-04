import { z } from "zod";
import { verifyPassword } from "../auth/password.js";
import { sqlOwner } from "../db/client.js";
import { HttpError } from "./errors.js";
import { RateLimiter } from "./rateLimit.js";
import { consumeSecondFactor, TOTP_COLS, type TotpRow } from "./secondFactor.js";

/**
 * Reconfirmación de identidad para los cambios delicados de Sistema (guardar ajustes, cambiar el destino de las copias):
 * contraseña y, si el usuario tiene verificación en dos pasos, un código (TOTP o de recuperación, como en el login).
 * Un código TOTP vale una sola vez (`totp_last_step`).
 *
 * Errores: 403 `REAUTH_REQUIRED` si no llega `confirm`; 403 `REAUTH_FAILED` si la contraseña o el código no valen;
 * 429 tras demasiados intentos fallidos.
 */
export const ConfirmSchema = z.object({ password: z.string().max(200), code: z.string().max(32).optional() });
export type Confirm = z.infer<typeof ConfirmSchema>;

/** 5 intentos por usuario cada 15 minutos (el mismo tope que el segundo paso del login). */
const limiter = new RateLimiter(5, 15 * 60 * 1000);

const required = () => new HttpError(403, "Confirma tu identidad con tu contraseña para continuar.", "REAUTH_REQUIRED");
const failed = (msg = "Contraseña o código incorrectos.") => new HttpError(403, msg, "REAUTH_FAILED");

/** ¿Tiene el usuario la verificación en dos pasos activa? (la pantalla decide con esto si pide el código). */
export async function hasTotp(userId: string): Promise<boolean> {
  const [row] = await sqlOwner<{ on: boolean }[]>`SELECT (totp_enabled_at IS NOT NULL) AS "on" FROM users WHERE id = ${userId}`;
  return row?.on ?? false;
}

export async function reauthenticate(userId: string, confirm: Confirm | undefined): Promise<void> {
  if (!confirm) throw required();
  const [row] = await sqlOwner<(TotpRow & { password_hash: string | null })[]>`
    SELECT ${TOTP_COLS}, password_hash FROM users u WHERE u.id = ${userId} AND u.is_active`;
  if (!row) throw failed();
  const code = confirm.code?.trim() ?? "";
  // Falta el código: es un olvido de la pantalla, no un intento de adivinar; no gasta intentos.
  if (row.totp_enabled_at && code === "") throw failed("Escribe el código de verificación.");

  if (!limiter.hit(userId)) throw new HttpError(429, "Demasiados intentos. Espera unos minutos.");
  // Primero la contraseña: un código no se consume si la contraseña ya está mal.
  if (!row.password_hash || !(await verifyPassword(confirm.password, row.password_hash))) throw failed();
  if (row.totp_enabled_at && !(await consumeSecondFactor(row, code))) throw failed();
  limiter.reset(userId);
}
