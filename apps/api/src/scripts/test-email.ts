import { config } from "../config.js";
import { emailEnabled, sendEmail, verifyEmail } from "../lib/mailer.js";

/**
 * Prueba el correo saliente con el SMTP del .env: comprueba la conexión y las credenciales y, si se indica un
 * destinatario, envía un mensaje de prueba. Muestra el error real del servidor (en la API solo queda en los registros).
 *
 *   docker compose exec api node dist/scripts/test-email.js [destinatario@correo.com]
 */
const to = process.argv[2];

if (!emailEnabled()) {
  console.log("SMTP_HOST está vacío: el correo está desactivado. Configura SMTP_* en el .env y aplica con «docker compose up -d».");
  process.exit(1);
}

const mode = config.SMTP_SECURE ? "TLS directo" : "STARTTLS si el servidor lo ofrece";
console.log(`Servidor: ${config.SMTP_HOST}:${config.SMTP_PORT} (${mode})`);
console.log(`Usuario:  ${config.SMTP_USER || "(sin autenticación)"}`);
console.log(`Remitente: ${config.SMTP_FROM}`);

try {
  await verifyEmail();
  console.log("Conexión y credenciales: OK");
} catch (err) {
  console.error(`Falló la conexión o el inicio de sesión: ${err instanceof Error ? err.message : err}`);
  console.error("Revisa SMTP_HOST, SMTP_PORT (587 con SMTP_SECURE=false, o 465 con SMTP_SECURE=true), SMTP_USER y SMTP_PASSWORD.");
  process.exit(1);
}

if (!to) {
  console.log("Para enviar un correo de prueba indica un destinatario: … test-email.js tu@correo.com");
  process.exit(0);
}

const ok = await sendEmail({
  to,
  subject: `Prueba de correo de ${config.APP_NAME}`,
  intro: "Si lees este mensaje, el correo saliente está bien configurado.",
  buttonText: `Abrir ${config.APP_NAME}`,
  url: config.APP_PUBLIC_URL,
  outro: "Es un mensaje de prueba; no hace falta responder.",
});
console.log(ok ? `Correo de prueba enviado a ${to}. Revisa la bandeja de entrada y también el spam.` : "El servidor rechazó el envío (el motivo está arriba, en [correo]).");
process.exit(ok ? 0 : 1);
