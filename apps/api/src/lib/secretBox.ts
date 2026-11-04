import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { config } from "../config.js";

/**
 * Cifrado de secretos en la base de datos: AES-256-GCM con una clave derivada de JWT_SECRET. Cada uso lleva su propia
 * etiqueta HKDF (`info`), de modo que un secreto de un uso no se puede descifrar como el de otro.
 * Formato guardado: «iv.tag.datos» en base64. Si cambias JWT_SECRET hay que volver a introducir los secretos.
 */
const key = (info: string) => Buffer.from(hkdfSync("sha256", config.JWT_SECRET, "rag", info, 32));

export function seal(info: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(info), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function open(info: string, stored: string): string {
  const [iv, tag, data] = stored.split(".").map((p) => Buffer.from(p, "base64"));
  if (!iv || !tag || !data) throw new Error("secreto cifrado corrupto");
  const decipher = createDecipheriv("aes-256-gcm", key(info), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
