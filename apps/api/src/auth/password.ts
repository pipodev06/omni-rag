import bcrypt from "bcryptjs";

const ROUNDS = 12;

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, ROUNDS);
export const verifyPassword = (plain: string, hash: string): Promise<boolean> => bcrypt.compare(plain, hash);

/** Mínimo general. */
export const MIN_PASSWORD = 10;
/**
 * Mínimo del superadministrador: puede quedar sin 2FA (en local no se exige) y sin segundo factor NIST 800-63B rev. 4
 * pide 15 caracteres. Vale al crearlo, al cambiar la contraseña y al restablecerla.
 */
export const SUPERADMIN_MIN_PASSWORD = 15;

/** Reglas mínimas de contraseña. Devuelve un mensaje de error o null si es válida. */
export function passwordProblem(plain: string, opts: { superadmin?: boolean } = {}): string | null {
  const min = opts.superadmin ? SUPERADMIN_MIN_PASSWORD : MIN_PASSWORD;
  if (plain.length < min) return `La contraseña debe tener al menos ${min} caracteres${opts.superadmin ? " (superadministrador)" : ""}`;
  if (plain.length > 200) return "La contraseña es demasiado larga";
  return null;
}
