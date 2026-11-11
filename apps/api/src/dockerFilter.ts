import { createServer } from "node:http";
import { hostname } from "node:os";

/*
 * Filtro de Docker (servicio docker-filter). Se pone entre el worker y docker-proxy porque la lista blanca de
 * docker-proxy solo puede filtrar la forma de la ruta, no de quién es el contenedor. Aquí:
 *  - solo se responde por contenedores del propio proyecto de compose (el de este contenedor);
 *  - de cada respuesta salen solo los campos que usa la pantalla Sistema y el monitor (nunca Config.Env, montajes,
 *    redes ni etiquetas ajenas a compose);
 *  - todo lo demás es 403.
 * No usa la base ni secretos: si alguien toma el worker, desde aquí solo ve el consumo de Omni RAG.
 */

const UPSTREAM = (process.env.DOCKER_UPSTREAM_URL || "http://docker-proxy:2375").replace(/\/+$/, "");
const PORT = Number(process.env.PORT || 2375);
const PROJECT_LABEL = "com.docker.compose.project";
const ID = /^[0-9a-f]{64}$/;

interface Listed {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Labels: Record<string, string>;
}

async function upstream<T>(path: string): Promise<T> {
  const res = await fetch(`${UPSTREAM}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return (await res.json()) as T;
}

/** Proyecto de compose de este contenedor (su hostname es el id corto). Se resuelve una vez y se guarda. */
let project: string | null = null;
async function ownProject(): Promise<string> {
  if (project) return project;
  const all = await upstream<Listed[]>("/containers/json?all=1");
  const self = all.find((c) => c.Id.startsWith(hostname()));
  const p = self?.Labels[PROJECT_LABEL];
  if (!p) throw new Error("no encuentro mi propio contenedor");
  return (project = p);
}

/** Contenedores del proyecto, con caché corta: el worker pide stats e inspect de cada uno justo después de listar. */
let cache: { at: number; list: Listed[] } | null = null;
async function projectContainers(): Promise<Listed[]> {
  if (cache && Date.now() - cache.at < 10_000) return cache.list;
  const p = await ownProject();
  const filters = encodeURIComponent(JSON.stringify({ label: [`${PROJECT_LABEL}=${p}`] }));
  const list = (await upstream<Listed[]>(`/containers/json?all=1&filters=${filters}`)).filter((c) => c.Labels[PROJECT_LABEL] === p);
  cache = { at: Date.now(), list };
  return list;
}

const composeLabels = (labels: Record<string, string>) =>
  Object.fromEntries(Object.entries(labels).filter(([k]) => k.startsWith("com.docker.compose.")));

/** Respuesta filtrada para una ruta GET, o null si la ruta no está permitida. Exportada para poder probarla. */
export async function handle(rawPath: string): Promise<unknown | null> {
  const url = new URL(rawPath, "http://x");
  const path = url.pathname.replace(/^\/v[0-9.]+(?=\/)/, "");

  if (path === "/info") {
    const i = await upstream<Record<string, unknown>>("/info");
    return { NCPU: i.NCPU, MemTotal: i.MemTotal, ServerVersion: i.ServerVersion, OperatingSystem: i.OperatingSystem, KernelVersion: i.KernelVersion, Architecture: i.Architecture };
  }
  if (path === "/containers/json") {
    return (await projectContainers()).map((c) => ({ Id: c.Id, Names: c.Names, Image: c.Image, State: c.State, Status: c.Status, Labels: composeLabels(c.Labels) }));
  }
  const m = path.match(/^\/containers\/([^/]+)\/(stats|json)$/);
  const id = m?.[1];
  if (!m || !id || !ID.test(id)) return null;
  if (!(await projectContainers()).some((c) => c.Id === id)) return null; // contenedor ajeno: como si no existiera la ruta

  if (m[2] === "stats") {
    const s = await upstream<Record<string, unknown>>(`/containers/${id}/stats?stream=false`);
    return { cpu_stats: s.cpu_stats, precpu_stats: s.precpu_stats, memory_stats: s.memory_stats };
  }
  const i = await upstream<{
    RestartCount: number;
    State: { OOMKilled: boolean; Health?: { Status: string } };
    HostConfig: { NanoCpus: number; CpuQuota: number; CpuPeriod: number; CpuShares: number; Memory: number };
  }>(`/containers/${id}/json`);
  return {
    RestartCount: i.RestartCount,
    State: { OOMKilled: i.State.OOMKilled, Health: i.State.Health ? { Status: i.State.Health.Status } : undefined },
    HostConfig: { NanoCpus: i.HostConfig.NanoCpus, CpuQuota: i.HostConfig.CpuQuota, CpuPeriod: i.HostConfig.CpuPeriod, CpuShares: i.HostConfig.CpuShares, Memory: i.HostConfig.Memory },
  };
}

// Peticiones a la vez: el worker hace ~2 por contenedor del proyecto cada minuto (~30 en el pico). El tope evita que un
// worker tomado sature el filtro o a Docker con peticiones de stats.
const MAX_IN_FLIGHT = 64;
let inFlight = 0;

if (process.argv[1]?.endsWith("dockerFilter.js")) {
  createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    if (req.method !== "GET" || !req.url) return send(403, { message: "solo GET" });
    if (inFlight >= MAX_IN_FLIGHT) return send(429, { message: "demasiadas consultas a la vez" });
    inFlight++;
    try {
      const out = await handle(req.url);
      if (out === null) return send(403, { message: "ruta no permitida" });
      send(200, out);
    } catch {
      send(502, { message: "Docker no responde" });
    } finally {
      inFlight--;
    }
  }).listen(PORT, "0.0.0.0", () => console.log(JSON.stringify({ msg: "docker-filter escuchando", port: PORT, upstream: UPSTREAM })));
}
