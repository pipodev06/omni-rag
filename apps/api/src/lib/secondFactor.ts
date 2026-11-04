import { sqlOwner, type Role } from "../db/client.js";
import { decryptSecret, hashRecoveryCode, verifyTotp } from "./totp.js";

/** Segundo paso de la identidad (TOTP o código de recuperación): lo comparten el login, «Mi cuenta» y la reconfirmación. */

export interface TotpRow {
  id: string;
  tenant_id: string;
  name: string;
  username: string;
  email: string | null;
  role: Role;
  is_superadmin: boolean;
  totp_secret: string | null;
  totp_enabled_at: string | null;
  totp_last_step: string | null;
  totp_recovery_hashes: string[];
}

export const TOTP_COLS = sqlOwner`id, tenant_id, name, username, email, role, is_superadmin, totp_secret, totp_enabled_at, totp_last_step, totp_recovery_hashes`;

/**
 * Comprueba un código del segundo paso: TOTP de 6 dígitos o código de recuperación.
 * Consume lo usado (un código TOTP vale una vez; cada código de recuperación, también).
 */
export async function consumeSecondFactor(u: TotpRow, rawCode: string): Promise<"totp" | "recovery" | null> {
  const code = rawCode.replace(/\s/g, "");
  if (/^\d{6}$/.test(code) && u.totp_secret) {
    const last = u.totp_last_step === null ? null : Number(u.totp_last_step);
    const step = verifyTotp(decryptSecret(u.totp_secret), code, last);
    if (step === null) return null;
    // Atómico: si dos peticiones llegan con el mismo código, solo una gana.
    const [won] = await sqlOwner`
      UPDATE users SET totp_last_step = ${step} WHERE id = ${u.id} AND (totp_last_step IS NULL OR totp_last_step < ${step}) RETURNING id`;
    return won ? "totp" : null;
  }
  const hash = hashRecoveryCode(rawCode);
  if (!u.totp_recovery_hashes.includes(hash)) return null;
  const [used] = await sqlOwner`
    UPDATE users SET totp_recovery_hashes = array_remove(totp_recovery_hashes, ${hash})
     WHERE id = ${u.id} AND ${hash} = ANY(totp_recovery_hashes) RETURNING id`;
  return used ? "recovery" : null;
}
