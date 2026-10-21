import { createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { sqlOwner } from "../db/client.js";
import { sendLinkEmail } from "./mailer.js";

/**
 * Enlaces de un solo uso para invitar usuarios y restablecer contraseñas.
 * El token viaja solo en el enlace; en la base de datos se guarda su SHA-256.
 */
export type TokenKind = "invite" | "reset";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function linkFor(kind: TokenKind, token: string): string {
  const path = kind === "invite" ? "activar" : "restablecer";
  return `${config.APP_PUBLIC_URL}/${path}?token=${encodeURIComponent(token)}`;
}

/** Crea un enlace (anulando los anteriores del mismo tipo) y devuelve su URL. */
export async function createUserLink(opts: { tenantId: string; userId: string; kind: TokenKind; createdBy: string | null }): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expires =
    opts.kind === "invite" ? `${config.INVITE_EXPIRES_HOURS} hours` : `${config.RESET_EXPIRES_MINUTES} minutes`;
  await sqlOwner.begin(async (tx) => {
    await tx`UPDATE user_tokens SET used_at = now()
              WHERE user_id = ${opts.userId} AND kind = ${opts.kind} AND used_at IS NULL`;
    await tx`
      INSERT INTO user_tokens (tenant_id, user_id, kind, token_hash, expires_at, created_by)
      VALUES (${opts.tenantId}, ${opts.userId}, ${opts.kind}, ${hashToken(token)}, now() + ${expires}::interval, ${opts.createdBy})`;
  });
  return linkFor(opts.kind, token);
}

/** Envía el enlace por correo (si está configurado). Devuelve true si se envió. */
export function emailLink(kind: TokenKind, to: { email: string; name: string }, url: string, tenantName: string): Promise<boolean> {
  return kind === "invite"
    ? sendLinkEmail({
        to: to.email,
        subject: `Invitación a ${config.APP_NAME} (${tenantName})`,
        intro: `Hola ${to.name}: te han invitado a ${config.APP_NAME} en la organización «${tenantName}». Allí podrás hacer preguntas sobre los documentos de tu equipo.`,
        buttonText: "Crear mi contraseña",
        url,
        outro: `El enlace caduca en ${config.INVITE_EXPIRES_HOURS} horas.`,
      })
    : sendLinkEmail({
        to: to.email,
        subject: `Restablecer tu contraseña de ${config.APP_NAME}`,
        intro: `Hola ${to.name}: hemos recibido una solicitud para restablecer tu contraseña.`,
        buttonText: "Elegir una nueva contraseña",
        url,
        outro: `El enlace caduca en ${config.RESET_EXPIRES_MINUTES} minutos. Si no lo pediste tú, ignora este correo: tu contraseña no cambiará.`,
      });
}

export interface ValidToken {
  id: string;
  kind: TokenKind;
  userId: string;
  tenantId: string;
  username: string;
  email: string | null;
  name: string;
}

/** Comprueba un token: existe, no se usó, no caducó y el usuario/organización están activos. */
export async function findValidToken(token: string): Promise<ValidToken | null> {
  if (!token || token.length > 200) return null;
  const [row] = await sqlOwner<ValidToken[]>`
    SELECT t.id, t.kind, t.user_id AS "userId", t.tenant_id AS "tenantId", u.username, u.email, u.name
      FROM user_tokens t
      JOIN users u ON u.id = t.user_id
      JOIN tenants o ON o.id = t.tenant_id
     WHERE t.token_hash = ${hashToken(token)} AND t.used_at IS NULL AND t.expires_at > now()
       AND u.is_active AND o.is_active`;
  return row ?? null;
}
