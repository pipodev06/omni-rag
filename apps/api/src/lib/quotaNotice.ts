import { config } from "../config.js";
import { sqlOwner } from "../db/client.js";
import { sendEmail, emailEnabled } from "./mailer.js";
import { getTenantPlan, questionsToday, quotaLevel } from "./plans.js";

/**
 * Avisa por correo a los administradores de la organización cuando se acerca (QUOTA_WARN_PERCENT) o
 * llega al límite diario de preguntas. Una sola vez por día y nivel. Sin SMTP no hace nada (el aviso
 * dentro del chat sigue funcionando). Nunca falla la petición que lo dispara: solo deja un registro.
 */
export async function notifyQuota(tenantId: string): Promise<void> {
  try {
    if (!emailEnabled()) return;
    const plan = await getTenantPlan(tenantId);
    const used = await questionsToday(tenantId);
    const level = quotaLevel(used, plan.dailyQuestionLimit, config.QUOTA_WARN_PERCENT);
    if (level !== "warn" && level !== "full") return;

    // El INSERT es el cerrojo: si ya se avisó hoy de este nivel (o dos preguntas coinciden), no devuelve fila.
    const [first] = await sqlOwner<{ ok: number }[]>`
      INSERT INTO quota_notices (tenant_id, day, level)
      VALUES (${tenantId}, (now() AT TIME ZONE 'UTC')::date, ${level})
      ON CONFLICT DO NOTHING RETURNING 1 AS ok`;
    if (!first) return;

    const admins = await sqlOwner<{ email: string; name: string }[]>`
      SELECT email, name FROM users
       WHERE tenant_id = ${tenantId} AND role = 'admin' AND is_active AND email IS NOT NULL AND support_for IS NULL`;
    const [tenant] = await sqlOwner<{ name: string }[]>`SELECT name FROM tenants WHERE id = ${tenantId}`;
    const org = tenant?.name ?? "tu organización";
    const full = level === "full";
    const pct = Math.round((used / plan.dailyQuestionLimit) * 100);

    await Promise.all(
      admins.map((a) =>
        sendEmail({
          to: a.email,
          subject: full
            ? `${config.APP_NAME}: ${org} alcanzó su límite diario de preguntas`
            : `${config.APP_NAME}: ${org} ha usado el ${pct}% de su límite diario`,
          intro: full
            ? `Hola ${a.name}: «${org}» alcanzó hoy el límite de ${plan.dailyQuestionLimit} preguntas de su plan ${plan.name}. Hasta que se renueve (a las 00:00 UTC) solo responderán las preguntas que ya estén en caché.`
            : `Hola ${a.name}: «${org}» lleva ${used} de ${plan.dailyQuestionLimit} preguntas hoy (${pct}%) en su plan ${plan.name}. Si se agota, nadie podrá preguntar hasta que se renueve a las 00:00 UTC.`,
          outro: "Si necesitas más capacidad, pide un plan mayor al administrador de la plataforma. Puedes ver el uso en Consumo.",
        }),
      ),
    );
  } catch (err) {
    console.error("[cuota] no se pudo enviar el aviso:", err);
  }
}
