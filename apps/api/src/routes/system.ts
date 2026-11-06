import { Hono, type Context } from "hono";
import { z } from "zod";
import { requireAuth, requireSuperadmin, type AppEnv } from "../auth/middleware.js";
import { config } from "../config.js";
import { sqlOwner } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { HttpError, badRequest } from "../lib/errors.js";
import { configuredProviders, getProvider, isConfigured, parseModelRef, probeProvider } from "../lib/llmProviders.js";
import { notifyChange } from "../lib/changeNotice.js";
import { captureMailer, emailEnabled, sendEmail, smtpErrorMessage, verifyEmail } from "../lib/mailer.js";
import { ConfirmSchema, hasTotp, reauthenticate, type Confirm } from "../lib/reauth.js";
import { applySettings, b2Configured, backupDestination, SettingsError, setting, settingsView } from "../lib/settings.js";
import { parse } from "../lib/validate.js";
import type { HostInfo } from "../lib/containerMetrics.js";
import type { BackupInfo } from "../lib/backupStatus.js";

/**
 * Pantalla Sistema (solo superadministrador): stack, recursos asignados a cada contenedor frente a lo que consume y
 * el historial de alertas. Los datos los recoge el worker (lib/containerMetrics.ts); la API nunca habla con Docker.
 */
export const systemRoutes = new Hono<AppEnv>();
systemRoutes.use("*", requireAuth, requireSuperadmin);

/** Valores que dejó `deploy/autotune.sh` en el .env (o vacíos si no se ejecutó), para compararlos con lo aplicado. */
const AUTOTUNED = ["embeddings", "reranker", "docling", "worker"] as const;
function autotuneValues() {
  const env = (k: string) => process.env[k]?.trim() || null;
  return AUTOTUNED.map((service) => {
    const p = service.toUpperCase();
    return { service, cpus: env(`${p}_CPUS`), memLimit: env(`${p}_MEM_LIMIT`), cpuShares: env(`${p}_CPU_SHARES`) };
  });
}

systemRoutes.get("/resources", async (c) => {
  const [[pg], [vector], [host], containers, alerts] = await Promise.all([
    sqlOwner<{ v: string }[]>`SELECT current_setting('server_version') AS v`,
    sqlOwner<{ v: string | null }[]>`SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`,
    sqlOwner<{ at: Date; info: HostInfo }[]>`SELECT at, info FROM host_snapshot WHERE id = 1`,
    sqlOwner<
      {
        name: string; own: boolean; image: string; state: string; health: string | null; at: Date;
        cpu_cores: number; cpu_limit: number | null; cpu_shares: number | null; mem_bytes: number; mem_limit: number | null;
        restarts: number | null; oom_killed: boolean;
        mem_peak_24h: number | null; mem_peak_7d: number | null; cpu_avg_24h: number | null; cpu_p95_24h: number | null; cpu_max_24h: number | null;
        first_at: Date;
      }[]
    >`
      WITH last AS (
        SELECT DISTINCT ON (name) * FROM container_samples
         WHERE at > now() - interval '5 minutes' ORDER BY name, at DESC
      ), agg AS (
        SELECT name,
               max(mem_bytes) FILTER (WHERE at > now() - interval '24 hours')::float8 AS mem_peak_24h,
               max(mem_bytes)::float8 AS mem_peak_7d,
               avg(cpu_cores) FILTER (WHERE at > now() - interval '24 hours')::float8 AS cpu_avg_24h,
               (percentile_cont(0.95) WITHIN GROUP (ORDER BY cpu_cores) FILTER (WHERE at > now() - interval '24 hours'))::float8 AS cpu_p95_24h,
               max(cpu_cores) FILTER (WHERE at > now() - interval '24 hours')::float8 AS cpu_max_24h,
               min(at) AS first_at
          FROM container_samples WHERE at > now() - interval '7 days' AND state = 'running'
         GROUP BY name
      )
      SELECT l.name, l.own, l.image, l.state, l.health, l.at, l.cpu_cores, l.cpu_limit, l.cpu_shares,
             l.mem_bytes::float8 AS mem_bytes, l.mem_limit::float8 AS mem_limit, l.restarts, l.oom_killed,
             a.mem_peak_24h, a.mem_peak_7d, a.cpu_avg_24h, a.cpu_p95_24h, a.cpu_max_24h, coalesce(a.first_at, l.at) AS first_at
        FROM last l LEFT JOIN agg a USING (name)
       ORDER BY l.own DESC, l.name`,
    sqlOwner<{ key: string }[]>`SELECT key FROM alert_state WHERE key LIKE 'container:%'`,
  ]);

  const openAlerts = (name: string) => alerts.filter((a) => a.key.startsWith(`container:${name}:`)).map((a) => a.key.split(":")[2]!);
  return c.json({
    collecting: Boolean(config.DOCKER_PROXY_URL),
    sampledAt: host?.at ?? null,
    host: host?.info ?? null,
    stack: {
      node: process.version,
      postgres: pg?.v ?? null,
      pgvector: vector?.v ?? null,
      embeddingModel: config.EMBEDDING_MODEL,
      rerankerModel: config.RERANKER_URL ? (process.env.RERANKER_MODEL?.trim() || "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1") : null,
      llmProviders: configuredProviders().map((p) => p.id),
      antivirus: Boolean(config.CLAMAV_HOST),
      webSearch: setting("WEB_SEARCH_PROVIDER") || null,
    },
    autotune: autotuneValues(),
    containers: containers.map((r) => ({
      name: r.name,
      own: r.own,
      image: r.image,
      state: r.state,
      health: r.health,
      cpuCores: r.cpu_cores,
      cpuLimit: r.cpu_limit,
      cpuShares: r.cpu_shares,
      memBytes: r.mem_bytes,
      memLimit: r.mem_limit,
      restarts: r.restarts,
      oomKilled: r.oom_killed,
      memPeak24h: r.mem_peak_24h,
      memPeak7d: r.mem_peak_7d,
      cpuAvg24h: r.cpu_avg_24h,
      cpuP95_24h: r.cpu_p95_24h,
      cpuMax24h: r.cpu_max_24h,
      /** Horas de historial: con menos de 24 h el veredicto aún no es fiable. */
      historyHours: Math.round((Date.now() - new Date(r.first_at).getTime()) / 36e5),
      alerts: openAlerts(r.name),
    })),
  });
});

const POINTS = 48;
const RANGES: Record<string, number> = { "1h": 1, "24h": 24, "7d": 168 };

systemRoutes.get("/metrics", async (c) => {
  const q = z.object({ name: z.string().min(1).max(200), range: z.enum(["1h", "24h", "7d"]).default("24h") }).safeParse(c.req.query());
  if (!q.success) throw badRequest("Parámetros no válidos");
  const hours = RANGES[q.data.range]!;
  const step = (hours * 3600) / POINTS;
  const rows = await sqlOwner<{ b: number; mem: number | null; mem_limit: number | null; cpu: number | null; cpu_limit: number | null }[]>`
    SELECT (floor(extract(epoch FROM at) / ${step}) * ${step})::float8 AS b,
           max(mem_bytes)::float8 AS mem, max(mem_limit)::float8 AS mem_limit,
           avg(cpu_cores)::float8 AS cpu, max(cpu_limit)::float8 AS cpu_limit
      FROM container_samples
     WHERE name = ${q.data.name} AND at > now() - ${`${hours} hours`}::interval
     GROUP BY 1 ORDER BY 1`;
  const byBucket = new Map(rows.map((r) => [r.b, r]));
  const end = Math.floor(Date.now() / 1000 / step) * step;
  const points = Array.from({ length: POINTS }, (_, i) => {
    const b = end - (POINTS - 1 - i) * step;
    const r = byBucket.get(b);
    return { at: new Date(b * 1000).toISOString(), mem: r?.mem ?? null, memLimit: r?.mem_limit ?? null, cpu: r?.cpu ?? null, cpuLimit: r?.cpu_limit ?? null };
  });
  return c.json({ name: q.data.name, range: q.data.range, points });
});

systemRoutes.get("/alerts", async (c) => {
  const [open, events] = await Promise.all([
    sqlOwner<{ key: string; since: Date; message: string }[]>`SELECT key, since, message FROM alert_state ORDER BY since DESC`,
    sqlOwner<{ id: number; at: Date; key: string; event: string; message: string }[]>`
      SELECT id, at, key, event, message FROM alert_events ORDER BY at DESC, id DESC LIMIT 300`,
  ]);
  return c.json({ open, events });
});

/** Copias de seguridad: lo que guardó el worker en su última lectura (cada 5 minutos) y las alertas de copias abiertas. */
systemRoutes.get("/backups", async (c) => {
  const [[snap], alerts] = await Promise.all([
    sqlOwner<{ at: Date; info: BackupInfo }[]>`SELECT at, info FROM backup_snapshot WHERE id = 1`,
    sqlOwner<{ key: string; since: Date; message: string }[]>`SELECT key, since, message FROM alert_state WHERE key IN ('backup', 'backup-b2', 'backup-offsite')`,
  ]);
  // Las copias borradas después de la foto del worker (tiene hasta 5 minutos) ya no se muestran.
  const deleted = snap
    ? await sqlOwner<{ stamp: string }[]>`
        SELECT payload->>'stamp' AS stamp FROM backup_requests WHERE kind = 'delete' AND ok AND finished_at >= ${snap.at}`
    : [];
  const gone = new Set(deleted.map((d) => d.stamp));
  const info = snap?.info ? { ...snap.info, copies: snap.info.copies.filter((x) => !gone.has(x.stamp)) } : null;
  // El destino sale de los ajustes (se refrescan cada 30 s), no de la foto del worker.
  return c.json({ readAt: snap?.at ?? null, info: info ? { ...info, destination: backupDestination(), b2Configured: b2Configured() } : null, alerts });
});

// --- Primeros pasos ---------------------------------------------------------------

/**
 * Qué falta tras la configuración inicial, para la lista «Primeros pasos» de Organizaciones. Solo dice si cada cosa está
 * configurada, nunca valores. Lo imprescindible es un proveedor de modelos de lenguaje; correo y copias fuera del
 * servidor son opcionales pero recomendados.
 */
systemRoutes.get("/onboarding", async (c) => {
  const [[row], plans] = await Promise.all([
    sqlOwner<{ n: number }[]>`SELECT count(*)::int AS n FROM tenants WHERE NOT is_platform`,
    sqlOwner<{ name: string; llm_models: string[] }[]>`SELECT name, llm_models FROM plans ORDER BY is_default DESC, name`,
  ]);
  // Planes con algún modelo de un proveedor sin clave: sus organizaciones no podrían preguntar con ese modelo.
  const plansWithoutKey = plans
    .filter((p) => p.llm_models.length === 0 || p.llm_models.some((m) => { const pr = getProvider(parseModelRef(m).providerId); return !pr || !isConfigured(pr); }))
    .map((p) => p.name);
  return c.json({
    llm: configuredProviders().length > 0,
    plansWithoutKey,
    email: emailEnabled(),
    alertEmail: setting("ALERT_EMAIL") !== "",
    b2: b2Configured(),
    tenants: row?.n ?? 0,
  });
});

// --- Ajustes editables (Sistema → Configuración) ---------------------------------------------------------------

/** Vista de los ajustes más lo que necesita la pantalla para la reconfirmación (¿pide código de 2FA?). */
const settingsResponse = async (c: Context<AppEnv>, extra: object = {}) => c.json({ ...settingsView(), reauth: { totp: await hasTotp(c.get("user").id) }, ...extra });

systemRoutes.get("/settings", (c) => settingsResponse(c));

/** Reconfirma contraseña (y código de 2FA): los cambios de ajustes y de destino la exigen. Un fallo queda en la auditoría. */
async function reconfirm(c: Context<AppEnv>, confirm: Confirm | undefined): Promise<void> {
  const me = c.get("user");
  try {
    await reauthenticate(me.id, confirm);
  } catch (err) {
    if (err instanceof HttpError && err.code === "REAUTH_FAILED") await audit(c, "system.reauth_failed", { targetType: "user", targetId: me.id });
    throw err;
  }
}

const SettingsBody = z.object({
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  confirm: ConfirmSchema.optional(),
});

systemRoutes.put("/settings", async (c) => {
  const body = parse(SettingsBody, await c.req.json().catch(() => ({})));
  // El aviso de cambio sale con el correo y los destinatarios de antes del cambio.
  const send = captureMailer();
  const previousRecipients = setting("ALERT_EMAIL");
  let result: Awaited<ReturnType<typeof applySettings>>;
  try {
    // La reconfirmación va tras validar los valores y antes de guardar.
    result = await applySettings(body.values, c.get("user").username, () => reconfirm(c, body.confirm));
  } catch (err) {
    if (err instanceof SettingsError) throw badRequest(err.message);
    throw err;
  }
  const changed = [...result.keys, ...result.cleared.filter((k) => !result.keys.includes(k))];
  // Solo las claves: los valores (y menos los de los secretos) no van a la auditoría ni al correo.
  if (changed.length > 0) {
    await audit(c, "settings.updated", { targetType: "settings", details: { keys: result.keys, cleared: result.cleared } });
    void notifyChange({ send, previousRecipients, newRecipients: result.keys.includes("ALERT_EMAIL") ? setting("ALERT_EMAIL") : "", what: changed, by: c.get("user").username });
  }
  return settingsResponse(c, { cleared: result.cleared });
});

systemRoutes.post("/settings/test-email", async (c) => {
  const { to } = parse(z.object({ to: z.string().trim().email().max(254).optional() }), await c.req.json().catch(() => ({})));
  if (!emailEnabled()) return c.json({ ok: false, message: "El correo está desactivado: indica el servidor SMTP." });
  const target = to ?? setting("ALERT_EMAIL").split(/[,;\s]+/).find(Boolean) ?? c.get("user").email;
  if (!target) throw badRequest("Indica un destinatario para el correo de prueba.");
  try {
    await verifyEmail();
  } catch (err) {
    // Texto fijo según el tipo de fallo; el detalle ya quedó en el registro (mailer.ts).
    return c.json({ ok: false, message: smtpErrorMessage(err) });
  }
  const sent = await sendEmail({
    to: target,
    subject: `Prueba de correo de ${config.APP_NAME}`,
    intro: "Si lees este mensaje, el correo saliente está bien configurado.",
    buttonText: `Abrir ${config.APP_NAME}`,
    url: config.APP_PUBLIC_URL,
    outro: "Es un mensaje de prueba; no hace falta responder.",
  });
  return c.json(sent ? { ok: true, message: `Correo de prueba enviado a ${target}. Revisa la bandeja de entrada y el spam.` } : { ok: false, message: "El servidor rechazó el envío. El detalle está en los registros." });
});

systemRoutes.post("/settings/test-llm", async (c) => {
  const { provider } = parse(z.object({ provider: z.string().max(40) }), await c.req.json().catch(() => ({})));
  const p = getProvider(provider);
  if (!p) throw badRequest("Proveedor desconocido");
  if (!isConfigured(p)) return c.json({ ok: false, message: `${p.label} no está configurado.` });
  return c.json(await probeProvider(p));
});

// --- Órdenes al servicio de copias ---------------------------------------------------------------

/** Una orden sin terminar tras tantas horas se da por caducada: si el servicio de copias está caído no debe bloquear las nuevas. */
const STALE_HOURS = 6;
/** Tiempo mínimo entre una copia manual terminada y la siguiente. */
const MANUAL_COOLDOWN_MIN = 15;

/**
 * Crea una orden salvo que haya otra sin terminar (409). Lo garantiza la base: un índice único parcial
 * (`backup_requests_una_abierta`, migración 021) admite una sola fila con `finished_at IS NULL`, así que dos clics
 * simultáneos no pueden crear dos.
 */
async function requestBackupOrder(c: Context<AppEnv>, kind: "backup" | "destination" | "delete", payload: object): Promise<{ id: number }> {
  await sqlOwner`
    UPDATE backup_requests SET started_at = coalesce(started_at, now()), finished_at = now(), ok = false, message = 'caducada'
     WHERE finished_at IS NULL AND created_at < now() - ${`${STALE_HOURS} hours`}::interval`;
  const [row] = await sqlOwner<{ id: number }[]>`
    INSERT INTO backup_requests (kind, payload, requested_by) VALUES (${kind}, ${sqlOwner.json(payload as never)}, ${c.get("user").username})
    ON CONFLICT DO NOTHING RETURNING id`;
  if (!row) throw new HttpError(409, "Ya hay una orden de copias pendiente o en curso. Espera a que termine.");
  return { id: Number(row.id) };
}

systemRoutes.post("/backups/run", async (c) => {
  const [recent] = await sqlOwner<{ wait: number }[]>`
    SELECT ceil(extract(epoch FROM (finished_at + ${`${MANUAL_COOLDOWN_MIN} minutes`}::interval - now())) / 60)::int AS wait
      FROM backup_requests
     WHERE kind = 'backup' AND finished_at > now() - ${`${MANUAL_COOLDOWN_MIN} minutes`}::interval AND coalesce(message, '') NOT ILIKE '%caducada%'
     ORDER BY finished_at DESC LIMIT 1`;
  if (recent) throw new HttpError(429, `La última copia manual terminó hace menos de ${MANUAL_COOLDOWN_MIN} minutos. Vuelve a intentarlo en ${Math.max(1, recent.wait)} min.`);
  const order = await requestBackupOrder(c, "backup", {});
  await audit(c, "backup.run_requested", { targetType: "backup_request", targetId: String(order.id) });
  return c.json(order);
});

/** Ruta relativa dentro de /targets: sin «/» inicial ni «..»; vacío = la carpeta clásica. */
const DestinationBody = z.object({
  path: z.string().regex(/^[A-Za-z0-9 _.\-/]{0,200}$/).refine((p) => !p.includes("..") && !p.startsWith("/") && !p.includes("//") && !/(^|\/)\.(\/|$)/.test(p)),
  moveExisting: z.boolean(),
  confirm: ConfirmSchema.optional(),
});

systemRoutes.post("/backups/destination", async (c) => {
  const { confirm, ...body } = parse(DestinationBody, await c.req.json().catch(() => ({})));
  const send = captureMailer();
  const previousRecipients = setting("ALERT_EMAIL");
  await reconfirm(c, confirm);
  const order = await requestBackupOrder(c, "destination", body);
  await audit(c, "backup.destination_requested", { targetType: "backup_request", targetId: String(order.id), details: { path: body.path, moveExisting: body.moveExisting } });
  void notifyChange({ send, previousRecipients, newRecipients: "", what: ["BACKUP_DESTINATION"], by: c.get("user").username });
  return c.json(order);
});

/** Fecha y hora de una copia tal como va en sus archivos: db_2026-11-06_0340.dump → 2026-11-06_0340. */
const DeleteBody = z.object({ stamp: z.string().regex(/^\d{4}-\d{2}-\d{2}_\d{4}$/), confirm: ConfirmSchema.optional() });

/**
 * Borra una copia (base y archivos de esa fecha) de ./backups y de la carpeta externa. La borra el servicio de copias,
 * que es quien tiene la carpeta; la API nunca la monta. La copia más reciente no se puede borrar. En B2 sigue hasta caducar.
 */
systemRoutes.post("/backups/delete", async (c) => {
  const { stamp, confirm } = parse(DeleteBody, await c.req.json().catch(() => ({})));
  await reconfirm(c, confirm);
  const order = await requestBackupOrder(c, "delete", { stamp });
  await audit(c, "backup.delete_requested", { targetType: "backup_request", targetId: String(order.id), details: { stamp } });
  return c.json(order);
});

systemRoutes.get("/backups/requests", async (c) => {
  const rows = await sqlOwner<
    { id: number; kind: string; payload: unknown; requested_by: string | null; created_at: Date; started_at: Date | null; finished_at: Date | null; ok: boolean | null; message: string | null }[]
  >`SELECT id, kind, payload, requested_by, created_at, started_at, finished_at, ok, message FROM backup_requests ORDER BY id DESC LIMIT 20`;
  return c.json({
    requests: rows.map((r) => ({
      id: Number(r.id),
      kind: r.kind,
      payload: r.payload,
      requestedBy: r.requested_by,
      createdAt: r.created_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      ok: r.ok,
      message: r.message,
    })),
  });
});
