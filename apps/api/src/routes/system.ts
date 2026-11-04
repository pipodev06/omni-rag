import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireSuperadmin, type AppEnv } from "../auth/middleware.js";
import { config } from "../config.js";
import { sqlOwner } from "../db/client.js";
import { badRequest } from "../lib/errors.js";
import { configuredProviders } from "../lib/llmProviders.js";
import type { HostInfo } from "../lib/containerMetrics.js";

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
      webSearch: config.WEB_SEARCH_PROVIDER || null,
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
