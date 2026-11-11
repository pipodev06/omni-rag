import { hostname } from "node:os";
import { config } from "../config.js";
import { sqlOwner } from "../db/client.js";

/**
 * Consumo de los contenedores para la pantalla Sistema. El worker llama a `collectContainerMetrics()` cada minuto: lee
 * Docker a través de docker-filter (`dockerFilter.ts`: solo contenedores de este proyecto y solo los campos de abajo),
 * que a su vez pasa por docker-proxy (lista blanca de GET a /info, /containers/json y /containers/<id>/stats|json), y
 * guarda una muestra por contenedor en `container_samples` (consumo, topes y reinicios). Los demás contenedores del
 * servidor no se miden ni se ven: Omni RAG solo vigila lo suyo. Del servidor solo lee el total de RAM y núcleos (/info).
 */

interface ListedContainer {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Labels: Record<string, string>;
}

interface Inspected {
  RestartCount: number;
  State: { OOMKilled: boolean; Health?: { Status: string } };
  HostConfig: { NanoCpus: number; CpuQuota: number; CpuPeriod: number; CpuShares: number; Memory: number };
}

interface Stats {
  cpu_stats: { cpu_usage: { total_usage: number; percpu_usage?: number[] }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number };
  memory_stats: { usage?: number; limit?: number; stats?: Record<string, number> };
}

export interface HostInfo {
  cpus: number;
  memBytes: number;
  dockerVersion: string;
  os: string;
  kernel: string;
  arch: string;
}

export interface Sample {
  name: string;
  image: string;
  state: string;
  health: string | null;
  cpuCores: number;
  cpuLimit: number | null;
  cpuShares: number | null;
  memBytes: number;
  memLimit: number | null;
  restarts: number | null;
  oomKilled: boolean;
}

const PROJECT_LABEL = "com.docker.compose.project";

async function docker<T>(path: string): Promise<T> {
  const res = await fetch(`${config.DOCKER_PROXY_URL.replace(/\/+$/, "")}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Docker ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Núcleos en uso entre las dos lecturas que devuelve Docker (1.0 = un núcleo entero). */
export function cpuCores(s: Stats): number {
  const cpu = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
  const system = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats.system_cpu_usage ?? 0);
  const online = s.cpu_stats.online_cpus || s.cpu_stats.cpu_usage.percpu_usage?.length || 1;
  return cpu > 0 && system > 0 ? (cpu / system) * online : 0;
}

/** RAM en uso como la cuenta `docker stats`: sin la caché de archivos que el sistema puede liberar. */
export function memUsed(s: Stats): number {
  const usage = s.memory_stats.usage ?? 0;
  const cache = s.memory_stats.stats?.inactive_file ?? s.memory_stats.stats?.total_inactive_file ?? 0;
  return Math.max(0, usage - cache);
}

/** Núcleos máximos fijados con `cpus:` (NanoCpus) o con cuota/periodo; null = sin tope. */
export function cpuLimit(h: Inspected["HostConfig"]): number | null {
  if (h.NanoCpus > 0) return h.NanoCpus / 1e9;
  if (h.CpuQuota > 0 && h.CpuPeriod > 0) return h.CpuQuota / h.CpuPeriod;
  return null;
}

/** Nombre a mostrar: el servicio de compose (api, worker…) o, si no es de compose, el nombre del contenedor. */
function displayName(c: ListedContainer): string {
  const service = c.Labels["com.docker.compose.service"];
  const number = Number(c.Labels["com.docker.compose.container-number"] ?? 1);
  if (service) return number > 1 ? `${service}-${number}` : service;
  return (c.Names[0] ?? c.Id.slice(0, 12)).replace(/^\//, "");
}

export async function readContainers(): Promise<{ host: HostInfo; samples: Sample[] }> {
  const [info, list] = await Promise.all([
    docker<{ NCPU: number; MemTotal: number; ServerVersion: string; OperatingSystem: string; KernelVersion: string; Architecture: string }>("/info"),
    docker<ListedContainer[]>("/containers/json?all=1"),
  ]);
  const host: HostInfo = { cpus: info.NCPU, memBytes: info.MemTotal, dockerVersion: info.ServerVersion, os: info.OperatingSystem, kernel: info.KernelVersion, arch: info.Architecture };
  // El proyecto propio es el del contenedor donde corre el worker (su hostname es el id corto del contenedor).
  const self = list.find((c) => c.Id.startsWith(hostname()));
  const project = self?.Labels[PROJECT_LABEL] ?? "rag";

  const samples = await Promise.all(
    list.filter((c) => c.Labels[PROJECT_LABEL] === project).map(async (c): Promise<Sample> => {
      const running = c.State === "running";
      const [stats, inspected] = await Promise.all([
        running ? docker<Stats>(`/containers/${c.Id}/stats?stream=false`).catch(() => null) : null,
        docker<Inspected>(`/containers/${c.Id}/json`).catch(() => null),
      ]);
      const memLimit = inspected?.HostConfig.Memory || null;
      return {
        name: displayName(c),
        image: c.Image,
        state: c.State,
        health: inspected?.State.Health?.Status ?? null,
        cpuCores: stats ? cpuCores(stats) : 0,
        cpuLimit: inspected ? cpuLimit(inspected.HostConfig) : null,
        cpuShares: inspected ? inspected.HostConfig.CpuShares || 1024 : null,
        memBytes: stats ? memUsed(stats) : 0,
        memLimit,
        restarts: inspected?.RestartCount ?? null,
        oomKilled: inspected?.State.OOMKilled ?? false,
      };
    }),
  );
  return { host, samples };
}

export async function collectContainerMetrics(): Promise<{ containers: number } | { skipped: true }> {
  if (!config.DOCKER_PROXY_URL) return { skipped: true };
  const { host, samples } = await readContainers();
  await sqlOwner.begin(async (tx) => {
    await tx`
      INSERT INTO host_snapshot (id, at, info) VALUES (1, now(), ${tx.json(host as never)})
      ON CONFLICT (id) DO UPDATE SET at = excluded.at, info = excluded.info`;
    if (samples.length === 0) return;
    await tx`
      INSERT INTO container_samples ${tx(
        samples.map((s) => ({
          name: s.name,
          image: s.image,
          state: s.state,
          health: s.health,
          cpu_cores: s.cpuCores,
          cpu_limit: s.cpuLimit,
          cpu_shares: s.cpuShares,
          mem_bytes: Math.round(s.memBytes),
          mem_limit: s.memLimit,
          restarts: s.restarts,
          oom_killed: s.oomKilled,
        })),
      )}`;
  });
  return { containers: samples.length };
}
