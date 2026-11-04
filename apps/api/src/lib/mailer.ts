import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.js";
import { setting } from "./settings.js";

/**
 * Envío de correos (invitaciones y recuperación de contraseña) por SMTP.
 * Si SMTP_HOST está vacío, el correo está desactivado y la API devuelve los
 * enlaces al administrador para que los comparta él.
 */
export const emailEnabled = () => setting("SMTP_HOST") !== "";

/** Servidores de correo locales (desarrollo): los únicos donde se admite hablar sin cifrar. */
const LOCAL_SMTP_HOSTS = new Set(["mailpit", "localhost", "127.0.0.1", "::1", "[::1]"]);

/** Opciones del transporte SMTP. Sin TLS directo se exige STARTTLS (`requireTLS`), salvo en un servidor local. */
export function smtpOptions(c: { host: string; port: number; secure: boolean; user: string; pass: string }) {
  return {
    host: c.host,
    port: c.port,
    secure: c.secure,
    requireTLS: !c.secure && !LOCAL_SMTP_HOSTS.has(c.host.toLowerCase()),
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
  };
}

/** Texto fijo, apto para mostrar, de un fallo de SMTP: nunca reenvía el texto del servidor ni de la librería. */
export function smtpErrorMessage(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; responseCode?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const rc = typeof e.responseCode === "number" ? e.responseCode : 0;
  if (code === "ECONNREFUSED") return "El servidor rechazó la conexión: revisa el servidor y el puerto.";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || code === "ECONNECTION") return "El servidor no respondió a tiempo: revisa el servidor, el puerto y el cortafuegos.";
  if (code === "ENOTFOUND" || code === "EDNS" || code === "EAI_AGAIN") return "No se encontró el servidor: revisa su nombre.";
  if (code === "EAUTH" || rc === 530 || rc === 534 || rc === 535) return "El servidor rechazó el usuario o la contraseña.";
  if (code === "ESOCKET" || code === "ETLS" || /TLS|SSL|CERT/i.test(code)) return "No se pudo establecer la conexión cifrada: revisa el puerto y la opción «TLS directo».";
  return "No se pudo enviar el correo. El detalle está en los registros.";
}

/** Al registro solo van el código y el mensaje del error (nunca el objeto entero, que puede traer el comando enviado). */
function logMailError(context: string, err: unknown) {
  const e = (err ?? {}) as { code?: unknown; responseCode?: unknown; message?: unknown };
  console.error(`[correo] ${context}:`, { code: e.code, responseCode: e.responseCode, message: typeof e.message === "string" ? e.message.slice(0, 300) : String(err).slice(0, 300) });
}

interface Snapshot {
  host: string;
  from: string;
  transport: Transporter;
}

// El transporte se recrea si cambia algún dato del servidor (se editan desde Sistema → Configuración).
let cached: { signature: string; snap: Snapshot } | null = null;
function currentMailer(): Snapshot {
  const c = {
    host: setting("SMTP_HOST"),
    port: setting("SMTP_PORT"),
    secure: setting("SMTP_SECURE"),
    user: setting("SMTP_USER"),
    pass: setting("SMTP_PASSWORD"),
  };
  const from = setting("SMTP_FROM");
  const signature = JSON.stringify([c, from]);
  if (cached?.signature !== signature) cached = { signature, snap: { host: c.host, from, transport: nodemailer.createTransport(smtpOptions(c)) } };
  return cached.snap;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

export interface EmailOptions {
  to: string;
  subject: string;
  intro: string;
  buttonText?: string;
  url?: string;
  outro: string;
}

/** Texto y HTML del correo, con un botón si se indica `url`. */
function render(opts: EmailOptions) {
  const link = opts.url ? { text: opts.buttonText ?? "Abrir", url: opts.url } : null;
  const text = `${opts.intro}

${link ? `${link.text}: ${link.url}

` : ""}${opts.outro}

— ${config.APP_NAME}`;
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#18181b;max-width:520px;margin:0 auto;padding:24px">
<h2 style="margin:0 0 16px">${escapeHtml(config.APP_NAME)}</h2>
<p style="line-height:1.6">${escapeHtml(opts.intro)}</p>
${link ? `<p style="margin:28px 0"><a href="${escapeHtml(link.url)}" style="background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(link.text)}</a></p>` : ""}
<p style="color:#71717a;font-size:13px;line-height:1.6">${escapeHtml(opts.outro)}${link ? `<br>Si el botón no funciona, copia este enlace en el navegador:<br><span style="word-break:break-all">${escapeHtml(link.url)}</span>` : ""}</p>
</body></html>`;
  return { text, html };
}

/**
 * Fija ahora la configuración de correo y devuelve el envío que la usa. Sirve para avisar de un cambio de ajustes con el
 * servidor de antes del cambio (si alguien apunta el SMTP a otro sitio, el aviso no se le entrega a él).
 */
export function captureMailer(): (opts: EmailOptions) => Promise<boolean> {
  const snap = currentMailer();
  return async (opts) => {
    if (snap.host === "") return false;
    try {
      await snap.transport.sendMail({ from: snap.from, to: opts.to, subject: opts.subject, ...render(opts) });
      return true;
    } catch (err) {
      logMailError(`error enviando a ${opts.to}`, err);
      return false;
    }
  };
}

/** Envía un correo con la configuración vigente. Devuelve true si se envió. */
export const sendEmail = (opts: EmailOptions): Promise<boolean> => captureMailer()(opts);

/** Comprueba la conexión y las credenciales con el servidor SMTP (sin enviar nada). Lanza el error del servidor si falla. */
export async function verifyEmail(): Promise<void> {
  try {
    await currentMailer().transport.verify();
  } catch (err) {
    logMailError("la prueba de conexión falló", err);
    throw err;
  }
}
