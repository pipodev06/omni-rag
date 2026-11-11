import { readdir, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { sqlOwner } from "../db/client.js";
import { BACKUP_DIR, BACKUP_STATUS_DIR, backupPassphrase, readJson, type B2Status, type LocalStatus } from "./backupStatus.js";
import { configuredProviders } from "./llmProviders.js";
import { emailEnabled, sendEmail } from "./mailer.js";
import { b2Configured, setting } from "./settings.js";

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
/** «7,6 GB»: con coma, como el resto de la pantalla. */
const gb = (b: number) => `${(b / GB).toLocaleString("es", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`;
const REMIND_AFTER_MS = 24 * 3600 * 1000;
/** Tras arrancar el worker, la primera muestra de los contenedores tarda hasta un minuto en llegar. */
const METRICS_GRACE_SECONDS = 180;
/**
 * Tras encender el servidor (o arrancar el worker) no se avisa de una copia antigua durante una hora: si estuvo apagado
 * a la hora fijada, el servicio de copias hace la que falta al arrancar y tarda unos minutos. Si esa copia falla, se
 * avisa al momento.
 */
const BACKUP_GRACE_SECONDS = 3600;

/** Espacio libre del disco de archivos, o null si no se puede leer. */
async function diskFree(dir = config.STORAGE_DIR): Promise<{ pct: number; bytes: number } | null> {
  const s = await statfs(dir).catch(() => null);
  if (!s || s.blocks === 0) return null;
  return { pct: (s.bavail / s.blocks) * 100, bytes: s.bavail * s.bsize };
}

/** Poco espacio libre en el disco donde se guardan los archivos subidos. */
export async function checkDisk(dir = config.STORAGE_DIR): Promise<Problem | null> {
  const free = await diskFree(dir);
  if (!free || free.pct >= setting("ALERT_DISK_FREE_PERCENT")) return null;
  return { key: "disk", message: `Queda poco espacio en el disco de archivos: ${free.pct.toFixed(1)} % libre (${gb(free.bytes)}).` };
}

/** Documentos que llevan demasiado tiempo en cola o procesándose: la cola está atascada o el worker no responde. */
export async function checkQueue(): Promise<Problem | null> {
  const [row] = await sqlOwner<{ n: number }[]>`
    SELECT count(*)::int AS n FROM documents
     WHERE deleted_at IS NULL AND status IN ('pending', 'processing')
       AND updated_at < now() - ${`${setting("ALERT_QUEUE_MINUTES")} minutes`}::interval`;
  if (!row || row.n === 0) return null;
  return { key: "queue", message: `${row.n} documento(s) llevan más de ${setting("ALERT_QUEUE_MINUTES")} minutos en cola o procesándose. Revisa «docker compose logs worker» y el servicio docling.` };
}

/** La última copia de seguridad es demasiado antigua. Si la carpeta no está montada en el worker, no se comprueba. */
export async function checkBackups(dir = BACKUP_DIR, now = Date.now(), uptimeSeconds = process.uptime()): Promise<Problem | null> {
  const names = await readdir(dir).catch(() => null);
  if (!names) return null;
  const dumps = names.filter((n) => n.startsWith("db_") && n.endsWith(".dump"));
  let newest = 0;
  for (const n of dumps) newest = Math.max(newest, (await stat(join(dir, n))).mtimeMs);
  const hours = (now - newest) / 3_600_000;
  const status = await readJson<LocalStatus>(join(dir, ".estado.json"));
  if (newest === 0 || hours > setting("ALERT_BACKUP_HOURS")) {
    const startedAt = now - uptimeSeconds * 1000;
    const failedSinceStart = status?.ok === false && Date.parse(status.attemptAt) >= startedAt;
    if (failedSinceStart) return { key: "backup", message: `Falló la última copia de seguridad: ${status.error}. Revisa «docker compose logs backup».` };
    return {
      key: "backup",
      message: newest === 0 ? "No hay ninguna copia de seguridad de la base de datos." : `La última copia de seguridad tiene ${Math.round(hours)} horas (máximo ${setting("ALERT_BACKUP_HOURS")}). Revisa «docker compose logs backup».`,
      hold: uptimeSeconds < BACKUP_GRACE_SECONDS,
    };
  }
  // Hay una copia reciente, pero el último intento falló (p. ej. no llegó a la carpeta externa).
  if (status && status.ok === false) return { key: "backup", message: `Falló la última copia de seguridad: ${status.error}. Revisa «docker compose logs backup».` };
  return null;
}

/**
 * La subida a Backblaze B2 falla. B2 es opcional: sin bucket ni claves no se avisa (la pantalla lo muestra como «no
 * configurado»). Solo cuenta un estado de las últimas 26 h (o dos ciclos): si backup-b2 se para, deja de avisar.
 */
export async function checkB2(dir = BACKUP_STATUS_DIR, now = Date.now(), configured = b2Configured()): Promise<Problem | null> {
  if (!configured) return null;
  const status = await readJson<B2Status>(join(dir, "b2.json"));
  if (!status || status.ok !== false) return null;
  const maxAgeHours = status.at ? 26 : Math.max(26, (status.intervalHours || 6) * 2);
  if (now - Date.parse(status.checkedAt) > maxAgeHours * 3_600_000) return null;
  return { key: "backup-b2", message: `La subida a Backblaze B2 falla: ${status.error}. Revisa «docker compose logs backup-b2».` };
}

/** La copia externa no llega a su destino (p. ej. el disco USB elegido está desconectado); la copia local sigue haciéndose. */
export async function checkOffsite(dir = BACKUP_DIR): Promise<Problem | null> {
  const status = await readJson<LocalStatus>(join(dir, ".estado.json"));
  if (!status?.offsiteError) return null;
  return { key: "backup-offsite", message: `La copia externa no se está guardando: ${status.offsiteError}. Revisa «docker compose logs backup».` };
}

/**
 * Con la copia externa activa, la frase que la cifra (y la de B2) tiene que estar guardada fuera del servidor: se avisa
 * mientras nadie la haya visto en Sistema → Copias (o si cambió de origen desde entonces), y si no se puede leer.
 */
export function passphraseProblem(pass: ReturnType<typeof backupPassphrase>, seenSource: string | null): Problem | null {
  if (!pass) return { key: "backup-passphrase", message: "La copia externa está activa pero no hay frase de cifrado: recrea db con «docker compose up -d db» para que se genere." };
  if (!pass.value) return { key: "backup-passphrase", message: "La frase de cifrado de las copias no se puede leer (./data/secretos/backup_passphrase debe ser del usuario 1000): B2 no sube nada y la pantalla no puede mostrarla. Recrea db con «docker compose up -d db»." };
  if (seenSource === pass.source) return null;
  return { key: "backup-passphrase", message: "La frase que cifra las copias externas y las de B2 aún no se ha guardado: ábrela en Sistema → Copias → «Ver frase» y guárdala en tu gestor de contraseñas. Sin ella, si se pierde el servidor, esas copias no se pueden abrir." };
}

async function offsiteActive(): Promise<boolean> {
  return (await readJson<LocalStatus>(join(BACKUP_DIR, ".estado.json")))?.offsite === true;
}

export async function checkPassphrase(): Promise<Problem | null> {
  const [seen] = await sqlOwner<{ source: string }[]>`SELECT source FROM secret_views WHERE name = 'backup_passphrase'`;
  return passphraseProblem(backupPassphrase(), seen?.source ?? null);
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

/** Última muestra de un contenedor y su resumen de los últimos 15 minutos (consulta de checkContainers). */
export interface ContainerRow {
  name: string;
  state: string;
  health: string | null;
  mem_bytes: number;
  mem_limit: number | null;
  oom_killed: boolean;
  cpu_limit: number | null;
  cpu_avg: number;
  cpu_n: number;
  restarts_delta: number;
}

/**
 * Señales de que un contenedor falla o está al tope: RAM cerca de su tope, CPU pegada a su tope durante 10 minutos,
 * reinicios o muerte por falta de memoria, parado (`exited`) y salud «unhealthy». Cada contenedor y señal es un
 * problema aparte (`container:<nombre>:<señal>`) para saber cuál falla.
 */
export function containerProblems(rows: ContainerRow[], memPercent = setting("ALERT_CONTAINER_MEM_PERCENT")): Problem[] {
  const problems: Problem[] = [];
  const mb = (b: number) => `${Math.round(b / 1024 ** 2)} MB`;
  for (const r of rows) {
    const k = `container:${r.name}`;
    if (r.mem_limit && r.mem_bytes / r.mem_limit >= memPercent / 100) {
      problems.push({ key: `${k}:mem`, message: `«${r.name}» usa ${mb(r.mem_bytes)} de ${mb(r.mem_limit)} de RAM (${Math.round((r.mem_bytes / r.mem_limit) * 100)} %). Si llega al tope, Docker lo reinicia.` });
    }
    if (r.cpu_limit && r.cpu_n >= 5 && r.cpu_avg >= r.cpu_limit * 0.95) {
      problems.push({ key: `${k}:cpu`, message: `«${r.name}» lleva 10 minutos usando toda su CPU (${r.cpu_avg.toFixed(2)} de ${r.cpu_limit} núcleos): responde más lento.` });
    }
    if (r.restarts_delta > 0 || r.oom_killed || r.state === "restarting" || r.state === "dead") {
      const cause = r.oom_killed ? " Lo mató la falta de memoria (OOM): súbele el tope de RAM o libera memoria en el servidor." : "";
      problems.push({ key: `${k}:restart`, message: `«${r.name}» se reinició${r.restarts_delta > 0 ? ` ${r.restarts_delta === 1 ? "1 vez" : `${r.restarts_delta} veces`} en 15 minutos` : ` (estado: ${r.state})`}.${cause} Revisa «docker compose logs ${r.name}».` });
    } else if (r.state === "exited") {
      problems.push({ key: `${k}:stopped`, message: `«${r.name}» está parado. Si no lo paraste a propósito, revisa «docker compose logs ${r.name}» y arráncalo con «docker compose up -d ${r.name}».` });
    }
    if (r.health === "unhealthy") {
      problems.push({ key: `${k}:health`, message: `«${r.name}» no pasa su comprobación de salud. Revisa «docker compose logs ${r.name}».` });
    }
  }
  return problems;
}

export async function checkContainers(): Promise<Problem[]> {
  if (!config.DOCKER_PROXY_URL) return [];
  const rows = await sqlOwner<ContainerRow[]>`
    WITH last AS (
      SELECT DISTINCT ON (name) name, state, health, mem_bytes, mem_limit, oom_killed, cpu_limit, at
        FROM container_samples WHERE at > now() - interval '3 minutes'
       ORDER BY name, at DESC
    ), recent AS (
      SELECT name, avg(cpu_cores) FILTER (WHERE at > now() - interval '10 minutes') AS cpu_avg,
             count(*) FILTER (WHERE at > now() - interval '10 minutes')::int AS cpu_n,
             coalesce(max(restarts) - min(restarts), 0)::int AS restarts_delta
        FROM container_samples WHERE at > now() - interval '15 minutes'
       GROUP BY name
    )
    SELECT l.name, l.state, l.health, l.mem_bytes::float8 AS mem_bytes, l.mem_limit::float8 AS mem_limit, l.oom_killed, l.cpu_limit,
           coalesce(r.cpu_avg, 0)::float8 AS cpu_avg, coalesce(r.cpu_n, 0) AS cpu_n, coalesce(r.restarts_delta, 0) AS restarts_delta
      FROM last l LEFT JOIN recent r USING (name)`;
  if (rows.length === 0) {
    const hold = process.uptime() < METRICS_GRACE_SECONDS;
    return [{ key: "metrics", message: "No llegan métricas de los contenedores desde hace más de 3 minutos. Revisa «docker compose logs docker-filter docker-proxy worker».", hold }];
  }
  return containerProblems(rows);
}

/**
 * RAM que usan los contenedores de Omni RAG frente a la que ve Docker (la del servidor o, en Docker Desktop, la de la
 * máquina virtual). `now` es la última muestra; `low`, la más baja de los últimos 5 minutos (para no avisar de un pico
 * de un momento, como una conversión de Docling). Los demás servicios del servidor no se cuentan.
 */
export interface HostMemUsage {
  now: number;
  low: number;
  samples: number;
  total: number;
}

async function hostMemUsage(): Promise<HostMemUsage | null> {
  if (!config.DOCKER_PROXY_URL) return null;
  const [row] = await sqlOwner<{ now: number | null; low: number | null; samples: number; total: number | null }[]>`
    WITH per_minute AS (
      SELECT at, sum(mem_bytes)::float8 AS used FROM container_samples WHERE at > now() - interval '5 minutes' GROUP BY at
    )
    SELECT (SELECT used FROM per_minute ORDER BY at DESC LIMIT 1) AS now, min(used) AS low, count(*)::int AS samples,
           (SELECT (info->>'memBytes')::float8 FROM host_snapshot WHERE id = 1) AS total
      FROM per_minute`;
  if (!row || row.now === null || row.low === null || !row.total) return null;
  return { now: row.now, low: row.low, samples: row.samples, total: row.total };
}

/** Omni RAG lleva 5 minutos usando más del ALERT_HOST_MEM_PERCENT % de la RAM: si se agota, el sistema cierra algún contenedor. */
export function hostMemProblem(u: HostMemUsage | null, percent = setting("ALERT_HOST_MEM_PERCENT")): Problem | null {
  if (!u || u.samples < 3 || u.low / u.total < percent / 100) return null;
  return {
    key: "host-mem",
    message: `Omni RAG usa ${gb(u.now)} de ${gb(u.total)} de RAM (${Math.round((u.now / u.total) * 100)} %) desde hace 5 minutos o más. Si se agota, el sistema cierra algún contenedor (primero docling). Dale más RAM al servidor o a Docker, o apaga el re-ranker (RERANKER_URL= y RERANKER_REPLICAS=0).`,
  };
}

export async function checkHostMem(): Promise<Problem | null> {
  return hostMemProblem(await hostMemUsage());
}

const recipients = () => setting("ALERT_EMAIL").split(/[,;\s]+/).filter(Boolean);

/** Hay a quién avisar y con qué: si no, las alertas solo se ven en Sistema → Alertas y en los registros. */
export const alertEmailReady = () => emailEnabled() && recipients().length > 0;

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

/** Estado de cada comprobación en la última revisión (panel «Qué se vigila» de Sistema → Alertas). */
export type CheckState = "ok" | "bad" | "wait" | "off" | "error";
export interface CheckStatus {
  id: string;
  state: CheckState;
  detail: string | null;
}

interface Check {
  id: string;
  run: () => Promise<Problem | Problem[] | null>;
  /** Desactivada (sin B2, sin copia externa, sin proxy de Docker…): no se ejecuta. */
  off?: () => boolean | Promise<boolean>;
  detail?: () => Promise<string | null>;
}

const noProxy = () => !config.DOCKER_PROXY_URL;

const CHECKS: Check[] = [
  { id: "disk", run: () => checkDisk(), detail: async () => { const f = await diskFree(); return f ? `${Math.round(f.pct)} % libre` : null; } },
  { id: "queue", run: checkQueue },
  { id: "backup", run: () => checkBackups(), off: async () => (await readJson<LocalStatus>(join(BACKUP_DIR, ".estado.json")))?.auto === false },
  { id: "backup-offsite", run: () => checkOffsite(), off: async () => !(await offsiteActive()) },
  { id: "backup-passphrase", run: checkPassphrase, off: async () => !(await offsiteActive()) },
  { id: "backup-b2", run: () => checkB2(), off: () => !b2Configured() },
  { id: "llm", run: checkLlm, off: () => configuredProviders().length === 0 },
  {
    id: "containers",
    run: checkContainers,
    off: noProxy,
    detail: async () => {
      const [r] = await sqlOwner<{ running: number; total: number }[]>`
        SELECT count(*) FILTER (WHERE state = 'running')::int AS running, count(*)::int AS total
          FROM (SELECT DISTINCT ON (name) state FROM container_samples WHERE at > now() - interval '3 minutes' ORDER BY name, at DESC) s`;
      return r && r.total > 0 ? `${r.running} de ${r.total} en marcha` : null;
    },
  },
  { id: "host-mem", run: checkHostMem, off: noProxy, detail: async () => { const u = await hostMemUsage(); return u ? `${Math.round((u.now / u.total) * 100)} % de ${gb(u.total)}` : null; } },
];

/** De los problemas de una comprobación a su estado: alguno confirmado → bad; solo en espera → wait; ninguno → ok. */
export function checkState(problems: Problem[]): CheckState {
  if (problems.some((p) => !p.hold)) return "bad";
  return problems.length > 0 ? "wait" : "ok";
}

export async function runMonitor(): Promise<{ problems: number } & Awaited<ReturnType<typeof applyProblems>>> {
  const problems: Problem[] = [];
  const statuses: CheckStatus[] = [];
  for (const check of CHECKS) {
    try {
      if (await check.off?.()) {
        statuses.push({ id: check.id, state: "off", detail: null });
        continue;
      }
      const p = await check.run();
      const found = p ? (Array.isArray(p) ? p : [p]) : [];
      problems.push(...found);
      statuses.push({ id: check.id, state: checkState(found), detail: (await check.detail?.().catch(() => null)) ?? null });
    } catch (err) {
      console.error(`[monitor] falló la comprobación ${check.id}:`, err);
      statuses.push({ id: check.id, state: "error", detail: null });
    }
  }
  const result = { problems: problems.filter((p) => !p.hold).length, ...(await applyProblems(problems)) };
  await sqlOwner`
    INSERT INTO monitor_snapshot (id, at, checks) VALUES (1, now(), ${sqlOwner.json(statuses as never)})
    ON CONFLICT (id) DO UPDATE SET at = excluded.at, checks = excluded.checks`;
  return result;
}
