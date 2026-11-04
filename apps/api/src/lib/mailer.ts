import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.js";
import { setting } from "./settings.js";

/**
 * Envío de correos (invitaciones y recuperación de contraseña) por SMTP.
 * Si SMTP_HOST está vacío, el correo está desactivado y la API devuelve los
 * enlaces al administrador para que los comparta él.
 */
export const emailEnabled = () => setting("SMTP_HOST") !== "";

// El transporte se recrea si cambia algún dato del servidor (se editan desde Sistema → Configuración).
let transporter: { signature: string; transport: Transporter } | null = null;
function getTransporter(): Transporter {
  const host = setting("SMTP_HOST");
  const port = setting("SMTP_PORT");
  const secure = setting("SMTP_SECURE");
  const user = setting("SMTP_USER");
  const pass = setting("SMTP_PASSWORD");
  const signature = JSON.stringify([host, port, secure, user, pass]);
  if (transporter?.signature !== signature) {
    transporter = { signature, transport: nodemailer.createTransport({ host, port, secure, auth: user ? { user, pass } : undefined }) };
  }
  return transporter.transport;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** Correo sencillo, con un botón si se indica `url`. Devuelve true si se envió. */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  intro: string;
  buttonText?: string;
  url?: string;
  outro: string;
}): Promise<boolean> {
  if (!emailEnabled()) return false;
  const link = opts.url ? { text: opts.buttonText ?? "Abrir", url: opts.url } : null;
  const text = `${opts.intro}\n\n${link ? `${link.text}: ${link.url}\n\n` : ""}${opts.outro}\n\n— ${config.APP_NAME}`;
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#18181b;max-width:520px;margin:0 auto;padding:24px">
<h2 style="margin:0 0 16px">${escapeHtml(config.APP_NAME)}</h2>
<p style="line-height:1.6">${escapeHtml(opts.intro)}</p>
${link ? `<p style="margin:28px 0"><a href="${escapeHtml(link.url)}" style="background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(link.text)}</a></p>` : ""}
<p style="color:#71717a;font-size:13px;line-height:1.6">${escapeHtml(opts.outro)}${link ? `<br>Si el botón no funciona, copia este enlace en el navegador:<br><span style="word-break:break-all">${escapeHtml(link.url)}</span>` : ""}</p>
</body></html>`;
  try {
    await getTransporter().sendMail({ from: setting("SMTP_FROM"), to: opts.to, subject: opts.subject, text, html });
    return true;
  } catch (err) {
    console.error("[correo] error enviando a", opts.to, err);
    return false;
  }
}

/** Comprueba la conexión y las credenciales con el servidor SMTP (sin enviar nada). Lanza el error del servidor si falla. */
export async function verifyEmail(): Promise<void> {
  await getTransporter().verify();
}
