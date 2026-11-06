import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sqlOwner } from "../db/client.js";
import { b2Configured, backupSettingsForScripts } from "./settings.js";

/**
 * Estado de las copias de seguridad para la pantalla Sistema → Copias. El worker llama a `collectBackupStatus()` cada
 * 5 minutos (junto al monitor): lista la carpeta de copias y lee el estado que dejan deploy/backup.sh
 * (`/backups/.estado.json`) y deploy/b2-sync.sh (`/backup-status/b2.json`). Lo guarda en `backup_snapshot` para que la
 * API lo lea sin montar la carpeta de copias.
 *
 * En sentido contrario, `writeBackupConfig()` deja en `/backup-config/b2.env` los ajustes de copias y de B2 editados en la
 * pantalla (con las claves descifradas), para que los scripts de copia los lean.
 */

export const BACKUP_DIR = process.env.BACKUP_DIR ?? "/backups";
export const BACKUP_STATUS_DIR = process.env.BACKUP_STATUS_DIR ?? "/backup-status";
export const BACKUP_CONFIG_DIR = process.env.BACKUP_CONFIG_DIR ?? "/backup-config";
const MAX_COPIES = 30;

/** Lo que escribe backup.sh tras cada intento y antes de esperar a la próxima copia. */
export interface LocalStatus {
  attemptAt: string;
  ok: boolean;
  error: string;
  counts: string;
  at: string;
  intervalHours: number;
  nextAt: string;
  offsite: boolean;
  encrypted: boolean;
  keepDays: number;
  /** Texto si la carpeta externa elegida no está conectada o no se puede escribir; vacío si todo va bien. */
  offsiteError?: string;
  /** Carpeta externa en uso (ruta dentro de /targets) o vacío. */
  destination?: string;
}

/** Lo que escribe b2-sync.sh tras cada subida (o al fallar la configuración). */
export interface B2Status {
  checkedAt: string;
  ok: boolean;
  error: string;
  lastOkAt: string;
  at: string;
  intervalHours: number;
  nextAt: string;
  syncUploads: boolean;
  keepDays: number;
}

export interface BackupCopy {
  /** Marca de la copia en UTC, tal cual el nombre del archivo (AAAA-MM-DD_HHMM). */
  stamp: string;
  at: string;
  dbBytes: number;
  uploadsBytes: number | null;
}

/** Lo que escribe backup.sh en `.destinos.json`: carpetas donde se pueden dejar las copias externas. */
export interface BackupTargets {
  root: string;
  available: boolean;
  dirs: { path: string; sameDisk: boolean; freeBytes: number; writable: boolean }[];
}

export interface BackupInfo {
  /** false = la carpeta de copias no está montada en el worker. */
  mounted: boolean;
  copies: BackupCopy[];
  totalBytes: number;
  failed: number;
  local: LocalStatus | null;
  b2: B2Status | null;
  /** null = backup.sh aún no lo ha escrito (o no hay carpeta de copias). */
  targets: BackupTargets | null;
}

/** Lee un JSON de estado; null si falta o está a medio escribir. */
export async function readJson<T>(file: string): Promise<T | null> {
  const text = await readFile(file, "utf8").catch(() => null);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function readBackupInfo(dir = BACKUP_DIR, statusDir = BACKUP_STATUS_DIR): Promise<BackupInfo> {
  const names = await readdir(dir).catch(() => null);
  if (!names) return { mounted: false, copies: [], totalBytes: 0, failed: 0, local: null, b2: await readJson<B2Status>(join(statusDir, "b2.json")), targets: null };
  const size = async (n: string) => (await stat(join(dir, n)).catch(() => null))?.size ?? null;
  const copies: BackupCopy[] = [];
  let totalBytes = 0;
  for (const n of names) {
    const m = n.match(/^db_(\d{4}-\d{2}-\d{2}_\d{4})\.dump$/);
    if (!m) continue;
    const s = await stat(join(dir, n)).catch(() => null);
    if (!s) continue;
    const uploads = names.includes(`uploads_${m[1]}.tgz`) ? await size(`uploads_${m[1]}.tgz`) : null;
    copies.push({ stamp: m[1]!, at: s.mtime.toISOString(), dbBytes: s.size, uploadsBytes: uploads });
    totalBytes += s.size + (uploads ?? 0);
  }
  copies.sort((a, b) => b.at.localeCompare(a.at));
  return {
    mounted: true,
    copies: copies.slice(0, MAX_COPIES),
    totalBytes,
    failed: names.filter((n) => n.endsWith(".dump.fallida")).length,
    local: await readJson<LocalStatus>(join(dir, ".estado.json")),
    b2: await readJson<B2Status>(join(statusDir, "b2.json")),
    targets: await readJson<BackupTargets>(join(dir, ".destinos.json")),
  };
}

/** Valor para un `export CLAVE='valor'` de shell: cada comilla simple se escribe como '\'' (cierra, escapa y reabre). */
const shellQuote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;

/**
 * Escribe `b2.env` con los ajustes de copias y B2 que no están fijados en el .env. Solo si la carpeta existe (sin el perfil
 * backblaze no está montada). Permisos 0600 y escritura atómica (archivo temporal + rename): lleva claves en claro.
 * Solo se escribe si el bucket y las dos claves de B2 tienen valor; si no, se borra el archivo que hubiera para no dejar
 * claves sueltas en disco sin motivo.
 */
export async function writeBackupConfig(dir = BACKUP_CONFIG_DIR): Promise<void> {
  if (!(await stat(dir).catch(() => null))?.isDirectory()) return;
  const file = join(dir, "b2.env");
  if (!b2Configured()) {
    await rm(file, { force: true });
    return;
  }
  const text = backupSettingsForScripts().map(([k, v]) => `export ${k}=${shellQuote(v)}\n`).join("");
  if ((await readFile(file, "utf8").catch(() => null)) === text) return;
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, file);
}

export async function collectBackupStatus(): Promise<BackupInfo> {
  const info = await readBackupInfo();
  await sqlOwner`
    INSERT INTO backup_snapshot (id, at, info) VALUES (1, now(), ${sqlOwner.json(info as never)})
    ON CONFLICT (id) DO UPDATE SET at = EXCLUDED.at, info = EXCLUDED.info`;
  return info;
}
