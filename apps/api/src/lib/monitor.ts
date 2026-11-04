import { readdir, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { sqlOwner } from "../db/client.js";
import { BACKUP_DIR, BACKUP_STATUS_DIR, readJson, type B2Status, type LocalStatus } from "./backupStatus.js";
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
  /** Aún no se puede saber si es un problema (p. ej. el worker acaba de arrancar): no se avisa, pero si ya estaba abierto sigue abierto. */
  hold?: boolean;
}

const GB = 1024 ** 3;
const REMIND_AFTER_MS = 24 * 3600 * 1000;
/** Tras arrancar el worker, la primera muestra de los contenedores tarda hasta un minuto en llegar. */
const METRICS_GRACE_SECONDS = 180;

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
  if (newest === 0 || hours > config.ALERT_BACKUP_HOURS) {
    return {
      key: "backup",
      message: newest === 0 ? "No hay ninguna copia de seguridad de la base de datos." : `La última copia de seguridad tiene ${Math.round(hours)} horas (máximo ${config.ALERT_BACKUP_HOURS}). Revisa «docker compose logs backup».`,
    };
  }
  // Hay una copia reciente, pero el último intento falló (p. ej. no llegó a la carpeta externa).
  const status = await readJson<LocalStatus>(join(dir, ".estado.json"));
  if (status && status.ok === false) return { key: "backup", message: `Falló la última copia de seguridad: ${status.error}. Revisa «docker compose logs backup».` };
  return null;
}

/**
 * La subida a Backblaze B2 falla o no está configurada. Solo cuenta un estado de las últimas 26 h (o dos ciclos):
 * si se quita el perfil «backblaze», el archivo de estado se queda viejo y deja de avisar.
 */
export async function checkB2(dir = BACKUP_STATUS_DIR, now = Date.now()): Promise<Problem | null> {
  const status = await readJson<B2Status>(join(dir, "b2.json"));
  if (!status || status.ok !== false) return null;
  const maxAgeHours = status.at ? 26 : Math.max(26, (status.intervalHours || 6) * 2);
  if (now - Date.parse(status.checkedAt) > maxAgeHours * 3_600_000) return null;
  return { key: "backup-b2", message: `La subida a Backblaze B2 falla: ${status.error}. Revisa «docker compose logs backup-b2».` };
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

/**
 * Señales de que un contenedor está al tope (muestras de `container_samples`, ver lib/containerMetrics.ts): RAM cerca de
 * su tope, CPU pegada a su tope durante 10 minutos, reinicios o muerte por falta de memoria, y salud «unhealthy».
 * Cada contenedor y señal es un problema aparte (`container:<nombre>:<señal>`) para saber cuál falla.
 */
export async function checkContainers(): Promise<Problem[]> {
  if (!config.DOCKER_PROXY_URL) return [];
  const rows = await sqlOwner<
    { name: string; state: string; health: string | null; mem_bytes: number; mem_limit: number | null; oom_killed: boolean; cpu_limit: number | null; cpu_avg: number; cpu_n: number; restarts_delta: number }[]
  >`
    WITH last AS (
      SELECT DISTINCT ON (name) name, state, health, mem_bytes, mem_limit, oom_killed, cpu_limit, at
        FROM container_samples WHERE own AND at > now() - interval '3 minutes'
       ORDER BY name, at DESC
    ), recent AS (
      SELECT name, avg(cpu_cores) FILTER (WHERE at > now() - interval '10 minutes') AS cpu_avg,
             count(*) FILTER (WHERE at > now() - interval '10 minutes')::int AS cpu_n,
             coalesce(max(restarts) - min(restarts), 0)::int AS restarts_delta
        FROM container_samples WHERE own AND at > now() - interval '15 minutes'
       GROUP BY name
    )
    SELECT l.name, l.state, l.health, l.mem_bytes::float8 AS mem_bytes, l.mem_limit::float8 AS mem_limit, l.oom_killed, l.cpu_limit,
           coalesce(r.cpu_avg, 0)::float8 AS cpu_avg, coalesce(r.cpu_n, 0) AS cpu_n, coalesce(r.restarts_delta, 0) AS restarts_delta
      FROM last l LEFT JOIN recent r USING (name)`;
  if (rows.length === 0) {
    const hold = process.uptime() < METRICS_GRACE_SECONDS;
    return [{ key: "metrics", message: "No llegan métricas de los contenedores desde hace más de 3 minutos. Revisa «docker compose logs docker-proxy worker».", hold }];
  }
  const problems: Problem[] = [];
  const mb = (b: number) => `${Math.round(b / 1024 ** 2)} MB`;
  for (const r of rows) {
    const k = `container:${r.name}`;
    if (r.mem_limit && r.mem_bytes / r.mem_limit >= config.ALERT_CONTAINER_MEM_PERCENT / 100) {
      problems.push({ key: `${k}:mem`, message: `«${r.name}» usa ${mb(r.mem_bytes)} de ${mb(r.mem_limit)} de RAM (${Math.round((r.mem_bytes / r.mem_limit) * 100)} %). Si llega al tope, Docker lo reinicia.` });
    }
    if (r.cpu_limit && r.cpu_n >= 5 && r.cpu_avg >= r.cpu_limit * 0.95) {
      problems.push({ key: `${k}:cpu`, message: `«${r.name}» lleva 10 minutos usando toda su CPU (${r.cpu_avg.toFixed(2)} de ${r.cpu_limit} núcleos): responde más lento.` });
    }
    if (r.restarts_delta > 0 || r.oom_killed || r.state === "restarting" || r.state === "dead") {
      const cause = r.oom_killed ? " Lo mató la falta de memoria (OOM): súbele el tope de RAM." : "";
      problems.push({ key: `${k}:restart`, message: `«${r.name}» se reinició${r.restarts_delta > 0 ? ` ${r.restarts_delta === 1 ? "1 vez" : `${r.restarts_delta} veces`} en 15 minutos` : ` (estado: ${r.state})`}.${cause} Revisa «docker compose logs ${r.name}».` });
    }
    if (r.health === "unhealthy") {
      problems.push({ key: `${k}:health`, message: `«${r.name}» no pasa su comprobación de salud. Revisa «docker compose logs ${r.name}».` });
    }
  }
  return problems;
}

const recipients = () => config.ALERT_EMAIL.split(/[,;\s]+/).filter(Boolean);

async function notify(subject: string, intro: string): Promise<void> {
  if (!emailEnabled() || recipients().length === 0) return;
  await Promise.all(recipients().map((to) => sendEmail({ to, subject: `[${config.APP_NAME}] ${subject}`, intro, outro: "Aviso automático de monitorización." })));
}

/** Historial para la pantalla Sistema (alert_state solo guarda los problemas abiertos). */
const logEvent = (key: string, event: "opened" | "reminded" | "resolved", message: string) =>
  sqlOwner`INSERT INTO alert_events (key, event, message) VALUES (${key}, ${event}, ${message})`;

/** Compara los problemas actuales con los ya conocidos, avisa de lo nuevo, recuerda lo antiguo y avisa de lo resuelto. */
export async function applyProblems(problems: Problem[], now = new Date()): Promise<{ opened: string[]; reminded: string[]; resolved: string[] }> {
  const known = await sqlOwner<{ key: string; last_sent: Date; message: string }[]>`SELECT key, last_sent, message FROM alert_state`;
  const knownByKey = new Map(known.map((k) => [k.key, k]));
  const current = new Set(problems.map((p) => p.key));
  const out = { opened: [] as string[], reminded: [] as string[], resolved: [] as string[] };

  for (const p of problems) {
    if (p.hold) continue;
    const prev = knownByKey.get(p.key);
    if (!prev) {
      await sqlOwner`INSERT INTO alert_state (key, message) VALUES (${p.key}, ${p.message}) ON CONFLICT (key) DO NOTHING`;
      await logEvent(p.key, "opened", p.message);
      out.opened.push(p.key);
      console.warn(`[monitor] PROBLEMA ${p.key}: ${p.message}`);
      await notify(`Problema: ${p.key}`, p.message);
    } else if (now.getTime() - prev.last_sent.getTime() >= REMIND_AFTER_MS) {
      await sqlOwner`UPDATE alert_state SET last_sent = ${now}, message = ${p.message} WHERE key = ${p.key}`;
      await logEvent(p.key, "reminded", p.message);
      out.reminded.push(p.key);
      console.warn(`[monitor] sigue el problema ${p.key}: ${p.message}`);
      await notify(`Sigue el problema: ${p.key}`, p.message);
    }
  }
  for (const k of known) {
    if (current.has(k.key)) continue;
    await sqlOwner`DELETE FROM alert_state WHERE key = ${k.key}`;
    await logEvent(k.key, "resolved", k.message);
    out.resolved.push(k.key);
    console.log(`[monitor] resuelto ${k.key}`);
    await notify(`Resuelto: ${k.key}`, `El problema ya no se detecta. Era: ${k.message}`);
  }
  return out;
}

export async function runMonitor(): Promise<{ problems: number } & Awaited<ReturnType<typeof applyProblems>>> {
  const checks: (() => Promise<Problem | Problem[] | null>)[] = [checkDisk, checkQueue, checkBackups, checkB2, checkLlm, checkContainers];
  const problems: Problem[] = [];
  for (const check of checks) {
    try {
      const p = await check();
      if (p) problems.push(...(Array.isArray(p) ? p : [p]));
    } catch (err) {
      console.error(`[monitor] falló la comprobación ${check.name}:`, err);
    }
  }
  return { problems: problems.filter((p) => !p.hold).length, ...(await applyProblems(problems)) };
}
