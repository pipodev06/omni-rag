import bcrypt from "bcryptjs";

const ROUNDS = 12;

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, ROUNDS);
export const verifyPassword = (plain: string, hash: string): Promise<boolean> => bcrypt.compare(plain, hash);

/** Reglas mínimas de contraseña. Devuelve un mensaje de error o null si es válida. */
export function passwordProblem(plain: string): string | null {
  if (plain.length < 10) return "La contraseña debe tener al menos 10 caracteres";
  if (plain.length > 200) return "La contraseña es demasiado larga";
  return null;
}
