import { readdir, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { sqlOwner } from "../db/client.js";
import { configuredProviders } from "./llmProviders.js";
import { emailEnabled, sendEmail } from "./mailer.js";

/**
 * Monitorización básica: el worker llama a `runMonitor()` cada 5 minutos. Cada comprobación devuelve el problema
 * (texto) o `null` si todo está bien. Con ALERT_EMAIL y SMTP se envía un correo al empezar un problema, un
 * recordatorio cada 24 h mientras siga y otro al resolverse. Sin correo, los problemas quedan en los registros.
 */
export interface Problem {
  key: string;
  message: string;
}

const GB = 1024 ** 3;
const BACKUP_DIR = process.env.BACKUP_DIR ?? "/backups";
const REMIND_AFTER_MS = 24 * 3600 * 1000;

/** Poco espacio libre en el disco donde se guardan los archivos subidos. */
export async function checkDisk(dir = config.STORAGE_DIR): Promise<Problem | null> {
  const s = await statfs(dir).catch(() => null);
  if (!s || s.blocks === 0) return null;
  const freePct = (s.bavail / s.blocks) * 100;
  if (freePct >= config.ALERT_DISK_FREE_PERCENT) return null;
  return { key: "disk", message: `Queda poco espacio en el disco de archivos: ${freePct.toFixed(1)} % libre (${((s.bavail * s.bsize) / GB).toFixed(1)} GB).` };
}

/** Documentos que llevan demasiado tiempo en cola o procesándose: la cola está atascada o el worker no responde. */
export async function checkQueue(): Promise<Problem | null> {
  const [row] = await sqlOwner<{ n: number }[]>`
    SELECT count(*)::int AS n FROM documents
     WHERE deleted_at IS NULL AND status IN ('pending', 'processing')
       AND updated_at < now() - ${`${config.ALERT_QUEUE_MINUTES} minutes`}::interval`;
  if (!row || row.n === 0) return null;
  return { key: "queue", message: `${row.n} documento(s) llevan más de ${config.ALERT_QUEUE_MINUTES} minutos en cola o procesándose. Revisa «docker compose logs worker» y el servicio docling.` };
}

/** La última copia de seguridad es demasiado antigua. Si la carpeta no está montada en el worker, no se comprueba. */
export async function checkBackups(dir = BACKUP_DIR, now = Date.now()): Promise<Problem | null> {
  const names = await readdir(dir).catch(() => null);
  if (!names) return null;
  const dumps = names.filter((n) => n.startsWith("db_") && n.endsWith(".dump"));
  let newest = 0;
  for (const n of dumps) newest = Math.max(newest, (await stat(join(dir, n))).mtimeMs);
  const hours = (now - newest) / 3_600_000;
  if (newest > 0 && hours <= config.ALERT_BACKUP_HOURS) return null;
  return {
    key: "backup",
    message: newest === 0 ? "No hay ninguna copia de seguridad de la base de datos." : `La última copia de seguridad tiene ${Math.round(hours)} horas (máximo ${config.ALERT_BACKUP_HOURS}). Revisa «docker compose logs backup».`,
  };
}

/** El modelo no está respondiendo: varios fallos seguidos en los últimos 15 minutos y ninguna respuesta correcta. */
export async function checkLlm(): Promise<Problem | null> {
  if (configuredProviders().length === 0) return null;
  const [row] = await sqlOwner<{ errors: number; ok: number }[]>`
    SELECT count(*) FILTER (WHERE kind = 'llm_error')::int AS errors,
           count(*) FILTER (WHERE kind IN ('question', 'summary'))::int AS ok
      FROM usage_events WHERE created_at > now() - interval '15 minutes'`;
  if (!row || row.errors < 3 || row.ok > 0) return null;
  return { key: "llm", message: `El modelo de lenguaje no responde: ${row.errors} preguntas fallaron en los últimos 15 minutos y ninguna se contestó. Revisa las claves y la cuota de los proveedores («docker compose logs api | grep llm»).` };
}

const recipients = () => config.ALERT_EMAIL.split(/[,;\s]+/).filter(Boolean);

async function notify(subject: string, intro: string): Promise<void> {
  if (!emailEnabled() || recipients().length === 0) return;
  await Promise.all(recipients().map((to) => sendEmail({ to, subject: `[${config.APP_NAME}] ${subject}`, intro, outro: "Aviso automático de monitorización." })));
}

/** Compara los problemas actuales con los ya conocidos, avisa de lo nuevo, recuerda lo antiguo y avisa de lo resuelto. */
export async function applyProblems(problems: Problem[], now = new Date()): Promise<{ opened: string[]; reminded: string[]; resolved: string[] }> {
  const known = await sqlOwner<{ key: string; last_sent: Date; message: string }[]>`SELECT key, last_sent, message FROM alert_state`;
  const knownByKey = new Map(known.map((k) => [k.key, k]));
  const current = new Set(problems.map((p) => p.key));
  const out = { opened: [] as string[], reminded: [] as string[], resolved: [] as string[] };

  for (const p of problems) {
    const prev = knownByKey.get(p.key);
    if (!prev) {
      await sqlOwner`INSERT INTO alert_state (key, message) VALUES (${p.key}, ${p.message}) ON CONFLICT (key) DO NOTHING`;
      out.opened.push(p.key);
      console.warn(`[monitor] PROBLEMA ${p.key}: ${p.message}`);
      await notify(`Problema: ${p.key}`, p.message);
    } else if (now.getTime() - prev.last_sent.getTime() >= REMIND_AFTER_MS) {
      await sqlOwner`UPDATE alert_state SET last_sent = ${now}, message = ${p.message} WHERE key = ${p.key}`;
      out.reminded.push(p.key);
      console.warn(`[monitor] sigue el problema ${p.key}: ${p.message}`);
      await notify(`Sigue el problema: ${p.key}`, p.message);
    }
  }
  for (const k of known) {
    if (current.has(k.key)) continue;
    await sqlOwner`DELETE FROM alert_state WHERE key = ${k.key}`;
    out.resolved.push(k.key);
    console.log(`[monitor] resuelto ${k.key}`);
    await notify(`Resuelto: ${k.key}`, `El problema ya no se detecta. Era: ${k.message}`);
  }
  return out;
}

export async function runMonitor(): Promise<{ problems: number } & Awaited<ReturnType<typeof applyProblems>>> {
  const checks = [checkDisk, checkQueue, checkBackups, checkLlm];
  const problems: Problem[] = [];
  for (const check of checks) {
    try {
      const p = await check();
      if (p) problems.push(p);
    } catch (err) {
      console.error(`[monitor] falló la comprobación ${check.name}:`, err);
    }
  }
  return { problems: problems.length, ...(await applyProblems(problems)) };
}
