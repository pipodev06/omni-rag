import { config } from "../config.js";
import type { EmailOptions } from "./mailer.js";

/**
 * Aviso por correo de un cambio de ajustes hecho desde Sistema: va a los destinatarios de ALERT_EMAIL de ANTES del cambio
 * (y, si cambió el propio ALERT_EMAIL, también a los nuevos). Lleva las claves tocadas, quién y cuándo; nunca valores.
 * Nunca hace fallar la petición: un error de envío solo queda en el registro.
 */
const list = (value: string) => value.split(/[,;\s]+/).filter(Boolean);

export async function notifyChange(opts: {
  /** Envío ya fijado con la configuración de correo de antes del cambio (`captureMailer`). */
  send: (o: EmailOptions) => Promise<boolean>;
  previousRecipients: string;
  /** ALERT_EMAIL nuevo, solo si este cambio lo modificó (si no, vacío). */
  newRecipients: string;
  /** Claves cambiadas. */
  what: string[];
  by: string;
}): Promise<void> {
  const to = [...new Set([...list(opts.previousRecipients), ...list(opts.newRecipients)].map((a) => a.toLowerCase()))];
  if (to.length === 0 || opts.what.length === 0) return;
  const intro = `Se cambió la configuración de ${config.APP_NAME}. Quién: ${opts.by}. Cuándo: ${new Date().toISOString()}. Ajustes: ${opts.what.join(", ")}.`;
  const outro = "Si no reconoces este cambio, cambia tu contraseña, cierra todas las sesiones y revisa Sistema → Configuración.";
  await Promise.all(
    to.map((address) =>
      opts.send({ to: address, subject: `[${config.APP_NAME}] Cambio en la configuración`, intro, outro }).catch((err) => {
        console.error("[ajustes] no se pudo enviar el aviso de cambio:", err instanceof Error ? err.message : err);
        return false;
      }),
    ),
  );
}
