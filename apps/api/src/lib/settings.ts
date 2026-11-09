import type { JSONValue, TransactionSql } from "postgres";
import { z } from "zod";
import { config, DEFAULTS, type Config } from "../config.js";
import { sqlOwner } from "../db/client.js";
import { open, seal } from "./secretBox.js";

/**
 * Ajustes editables desde Sistema → Configuración. Cada ajuste se llama como su variable de entorno y su valor
 * efectivo sale, por orden, de: la variable de entorno (si no está vacía: manda y la pantalla la muestra bloqueada),
 * la fila de la tabla `settings` y el valor por defecto. Los secretos se guardan cifrados (ver secretBox.ts).
 *
 * La API y el worker son procesos distintos: cada uno guarda en memoria lo que hay en la base y lo relee cada 30 s
 * (`startSettingsRefresh`); el proceso que guarda un cambio se refresca al instante. Los consumidores leen con
 * `setting("CLAVE")`, que es síncrono y nunca toca la base. Las copias de seguridad las leen sus scripts (ver
 * lib/backupStatus.ts, que les deja las suyas en un archivo).
 */
export type FieldType = "string" | "number" | "boolean" | "email" | "url" | "time" | "enum" | "secret";

interface Def {
  key: string;
  label: string;
  help: string;
  type: FieldType;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** Solo números: entero obligatorio. */
  int?: boolean;
  /** Solo textos: formato permitido. */
  pattern?: RegExp;
  /** Valor por defecto de los ajustes que no están en config.ts (los demás lo toman de ahí). */
  fallback?: string | number | boolean;
  /** Aviso sobre cuándo o cómo se aplica el cambio. */
  restartNote?: string;
}

interface Group {
  id: string;
  title: string;
  description: string;
  fields: Def[];
}

const PROVIDERS = [
  { value: "openrouter", label: "OpenRouter" },
  { value: "groq", label: "Groq" },
  { value: "google", label: "Google (Gemini)" },
  { value: "openai", label: "OpenAI" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "custom", label: "Servidor propio" },
];

/**
 * Zonas de la hora de las copias, en formato POSIX (lo que entienden `date` y los scripts sin base de zonas horarias).
 * Las que cambian de hora en verano llevan sus reglas. Otra zona: BACKUP_TZ en el archivo de entorno.
 */
const BACKUP_TIMEZONES = [
  { value: "<-05>5", label: "Lima, Bogotá, Quito (UTC−5)" },
  { value: "<-06>6", label: "Ciudad de México, Centroamérica (UTC−6)" },
  { value: "<-04>4", label: "Caracas, La Paz, Santo Domingo (UTC−4)" },
  { value: "<-04>4<-03>,M9.1.6/24,M4.1.6/24", label: "Santiago de Chile (UTC−4, verano −3)" },
  { value: "<-03>3", label: "Buenos Aires, Montevideo, São Paulo (UTC−3)" },
  { value: "EST5EDT,M3.2.0,M11.1.0", label: "Nueva York, Miami (UTC−5, verano −4)" },
  { value: "CET-1CEST,M3.5.0,M10.5.0/3", label: "Madrid (UTC+1, verano +2)" },
  { value: "UTC0", label: "UTC" },
];

const COPIES_NOTE = "Se aplica en la siguiente vuelta del servicio de copias (hasta 5 minutos).";
const NO_CONTROL = /^[^\r\n\0]*$/;

export const GROUPS: Group[] = [
  {
    id: "alerts",
    title: "Alertas",
    description: "Avisos por correo cuando el servidor tiene un problema. Se revisan cada 5 minutos y requieren el correo saliente configurado.",
    fields: [
      { key: "ALERT_EMAIL", label: "Destinatarios", help: "Direcciones separadas por comas. Vacío desactiva los avisos por correo.", type: "email" },
      { key: "ALERT_DISK_FREE_PERCENT", label: "Espacio libre mínimo en disco", help: "Se avisa cuando el disco de archivos baja de este porcentaje libre.", type: "number", min: 1, max: 90, step: 1, unit: "%" },
      { key: "ALERT_BACKUP_HOURS", label: "Antigüedad máxima de la última copia", help: "Se avisa si la copia de seguridad más reciente supera estas horas.", type: "number", min: 1, max: 720, step: 1, unit: "h" },
      { key: "ALERT_QUEUE_MINUTES", label: "Documentos atascados en la cola", help: "Se avisa si un documento lleva más de este tiempo pendiente o procesándose.", type: "number", min: 1, max: 1440, step: 1, unit: "min" },
      { key: "ALERT_CONTAINER_MEM_PERCENT", label: "Uso de memoria de un contenedor", help: "Se avisa cuando un contenedor usa este porcentaje de su tope de memoria.", type: "number", min: 50, max: 100, step: 1, unit: "%" },
      { key: "ALERT_HOST_MEM_PERCENT", label: "Uso de memoria del servidor", help: "Se avisa cuando Omni RAG lleva 5 minutos usando este porcentaje de la memoria que ve Docker.", type: "number", min: 50, max: 100, step: 1, unit: "%" },
    ],
  },
  {
    id: "email",
    title: "Correo saliente (SMTP)",
    description: "Servidor con el que se envían invitaciones, recuperaciones de contraseña, avisos de cuota y alertas.",
    fields: [
      { key: "SMTP_HOST", label: "Servidor", help: "Nombre del servidor SMTP. Vacío desactiva el correo.", type: "string" },
      { key: "SMTP_PORT", label: "Puerto", help: "Habitualmente 587 (STARTTLS) o 465 (TLS directo).", type: "number", min: 1, max: 65535, step: 1, int: true },
      { key: "SMTP_SECURE", label: "TLS directo", help: "Actívalo con el puerto 465. Con 587 déjalo desactivado.", type: "boolean" },
      { key: "SMTP_USER", label: "Usuario", help: "Vacío si el servidor no exige autenticación.", type: "string" },
      { key: "SMTP_PASSWORD", label: "Contraseña", help: "Contraseña o clave de aplicación del usuario.", type: "secret" },
      { key: "SMTP_FROM", label: "Remitente", help: "Dirección que verán los destinatarios, por ejemplo: Omni RAG <no-reply@miempresa.com>.", type: "string" },
    ],
  },
  {
    id: "limits",
    title: "Límites y retención",
    description: "Cuánto tiempo se conservan los datos y qué topes se aplican a las peticiones.",
    fields: [
      { key: "TRASH_RETENTION_DAYS", label: "Retención de la papelera", help: "Días que un documento borrado permanece en la papelera (mínimo 1).", type: "number", min: 1, max: 365, step: 1, int: true, unit: "días" },
      { key: "AUDIT_RETENTION_DAYS", label: "Retención de la auditoría", help: "Días que se conservan el registro de auditoría y el historial de alertas (mínimo 30).", type: "number", min: 30, max: 3650, step: 1, int: true, unit: "días" },
      { key: "METRICS_RETENTION_DAYS", label: "Retención de las métricas", help: "Días que se conservan las muestras de consumo de los contenedores (mínimo 1).", type: "number", min: 1, max: 90, step: 1, int: true, unit: "días" },
      { key: "QUOTA_WARN_PERCENT", label: "Aviso de cuota", help: "Porcentaje del límite diario a partir del cual se avisa en el chat y por correo.", type: "number", min: 1, max: 100, step: 1, int: true, unit: "%" },
      { key: "IP_RATE_LIMIT_PER_MIN", label: "Peticiones por minuto sin sesión", help: "Tope por dirección IP para las peticiones sin sesión iniciada. Con 0 no hay límite.", type: "number", min: 0, max: 100000, step: 1, int: true, unit: "por minuto" },
      { key: "INVITE_EXPIRES_HOURS", label: "Caducidad de las invitaciones", help: "Horas de validez del enlace de invitación (máximo 336, dos semanas).", type: "number", min: 1, max: 336, step: 1, unit: "h" },
      { key: "RESET_EXPIRES_MINUTES", label: "Caducidad de la recuperación de contraseña", help: "Minutos de validez del enlace para restablecer la contraseña (máximo 120).", type: "number", min: 1, max: 120, step: 1, unit: "min" },
    ],
  },
  {
    id: "llm",
    title: "Modelos de lenguaje",
    description: "Claves de los proveedores y parámetros de generación. Basta con configurar un proveedor; los modelos de cada plan indican cuál usar.",
    fields: [
      { key: "OPENROUTER_API_KEY", label: "Clave de OpenRouter", help: "Clave de API de OpenRouter.", type: "secret" },
      { key: "GROQ_API_KEY", label: "Clave de Groq", help: "Clave de API de Groq.", type: "secret" },
      { key: "GOOGLE_API_KEY", label: "Clave de Google (Gemini)", help: "Clave de API de Google AI Studio.", type: "secret" },
      { key: "OPENAI_API_KEY", label: "Clave de OpenAI", help: "Clave de API de OpenAI.", type: "secret" },
      { key: "DEEPSEEK_API_KEY", label: "Clave de DeepSeek", help: "Clave de API de DeepSeek.", type: "secret" },
      { key: "LLM_CUSTOM_BASE_URL", label: "Servidor propio: dirección", help: "Servidor compatible con OpenAI (Ollama, vLLM…), con «/v1» al final.", type: "url" },
      { key: "LLM_CUSTOM_API_KEY", label: "Servidor propio: clave", help: "Opcional; hay servidores que no la piden.", type: "secret" },
      { key: "LLM_DEFAULT_PROVIDER", label: "Proveedor por defecto", help: "Proveedor de los modelos de un plan que se escriben sin prefijo.", type: "enum", options: PROVIDERS },
      { key: "LLM_TEMPERATURE", label: "Temperatura", help: "Más baja da respuestas más estables; más alta, más variadas.", type: "number", min: 0, max: 2, step: 0.1 },
      { key: "LLM_MAX_TOKENS", label: "Longitud máxima de la respuesta", help: "Tope de tokens que puede generar el modelo en cada respuesta.", type: "number", min: 1, max: 32768, step: 1, int: true, unit: "tokens" },
    ],
  },
  {
    id: "web",
    title: "Búsqueda en internet",
    description: "Buscador externo para el modo híbrido del chat. Solo se envía la pregunta, nunca fragmentos de los documentos.",
    fields: [
      {
        key: "WEB_SEARCH_PROVIDER", label: "Buscador", help: "Vacío desactiva la búsqueda en internet.", type: "enum",
        options: [{ value: "", label: "Desactivada" }, { value: "tavily", label: "Tavily" }, { value: "brave", label: "Brave Search" }, { value: "searxng", label: "SearXNG (servidor propio)" }],
      },
      { key: "WEB_SEARCH_API_KEY", label: "Clave del buscador", help: "Necesaria con Tavily y Brave.", type: "secret" },
      { key: "WEB_SEARCH_URL", label: "Dirección de SearXNG", help: "Solo con SearXNG.", type: "url" },
      { key: "WEB_SEARCH_MAX_RESULTS", label: "Resultados por búsqueda", help: "Cuántos resultados de internet se entregan al modelo.", type: "number", min: 1, max: 10, step: 1, int: true },
    ],
  },
  {
    id: "search",
    title: "Búsqueda y caché",
    description: "Cuántos fragmentos se entregan al modelo y cómo se reutilizan las respuestas.",
    fields: [
      { key: "RETRIEVAL_TOP_K", label: "Fragmentos por pregunta", help: "Cuántos fragmentos de los documentos se envían al modelo.", type: "number", min: 1, max: 50, step: 1, int: true },
      { key: "RERANK_MIN_SCORE", label: "Puntuación mínima del re-ranker", help: "Entre 0 y 1. Un fragmento por debajo no se envía; si ninguno la alcanza, se responde que no hay información.", type: "number", min: 0, max: 1, step: 0.01 },
      { key: "CACHE_ENABLED", label: "Caché de respuestas", help: "Reutiliza la respuesta a una primera pregunta idéntica.", type: "boolean" },
      { key: "CACHE_TTL_HOURS", label: "Vigencia de la caché", help: "Horas que se conserva una respuesta guardada.", type: "number", min: 1, max: 8760, step: 1, unit: "h" },
      { key: "HISTORY_MESSAGES", label: "Mensajes de contexto", help: "Mensajes anteriores de la conversación que se envían al modelo.", type: "number", min: 0, max: 50, step: 1, int: true },
    ],
  },
  {
    id: "backup",
    title: "Copias de seguridad",
    description: "Frecuencia, retención y destino de las copias locales y externas.",
    fields: [
      { key: "BACKUP_ENABLED", label: "Copias automáticas", help: "Desactivado: no se hacen copias programadas; «Hacer copia ahora» sigue funcionando.", type: "boolean", fallback: true, restartNote: COPIES_NOTE },
      { key: "BACKUP_AT", label: "Hora de la copia diaria", help: "Formato HH:MM (24 h). No se usa si el intervalo es distinto de 24 h.", type: "time", fallback: "03:00", restartNote: COPIES_NOTE },
      { key: "BACKUP_INTERVAL_HOURS", label: "Intervalo entre copias", help: "24 = una copia al día a la hora fijada. Otro valor: una copia cada N horas, contadas desde la última.", type: "number", min: 1, max: 720, step: 1, int: true, unit: "h", fallback: 24, restartNote: COPIES_NOTE },
      { key: "BACKUP_KEEP_DAYS", label: "Retención", help: "Días que se conservan las copias (mínimo 3).", type: "number", min: 3, max: 3650, step: 1, int: true, unit: "días", fallback: 7, restartNote: COPIES_NOTE },
      { key: "BACKUP_TZ", label: "Zona horaria", help: "Zona de la hora de la copia y de la subida a B2. Otra zona: BACKUP_TZ en el archivo de entorno (formato POSIX).", type: "enum", options: BACKUP_TIMEZONES, fallback: "<-05>5", restartNote: COPIES_NOTE },
      { key: "BACKUP_UPLOADS_TGZ", label: "Comprimir los archivos subidos", help: "Incluye los documentos subidos como un archivo comprimido en cada copia.", type: "boolean", fallback: true, restartNote: COPIES_NOTE },
      { key: "BACKUP_OFFSITE", label: "Copia externa", help: "Duplica cada copia cifrada en la carpeta externa.", type: "boolean", fallback: false, restartNote: COPIES_NOTE },
    ],
  },
  {
    id: "b2",
    title: "Backblaze B2",
    description: "Opcional pero recomendado: sube las copias cifradas a Backblaze B2, fuera del servidor. Necesita la copia externa activada; la frase de cifrado se genera sola (guárdala con «Ver frase» en esta pantalla).",
    fields: [
      { key: "B2_AT", label: "Hora de la subida diaria", help: "Formato HH:MM (24 h), después de la copia. No se usa si el intervalo es distinto de 24 h.", type: "time", fallback: "04:00", restartNote: COPIES_NOTE },
      { key: "B2_INTERVAL_HOURS", label: "Intervalo entre subidas", help: "24 = una subida al día a la hora fijada. Otro valor: una subida cada N horas.", type: "number", min: 1, max: 720, step: 1, int: true, unit: "h", fallback: 24, restartNote: COPIES_NOTE },
      { key: "B2_KEEP_DAYS", label: "Retención", help: "Días que se conservan las copias en B2 (mínimo 7).", type: "number", min: 7, max: 3650, step: 1, int: true, unit: "días", fallback: 30, restartNote: COPIES_NOTE },
      { key: "B2_SYNC_UPLOADS", label: "Subir también los archivos", help: "Sincroniza los documentos subidos, de forma incremental.", type: "boolean", fallback: false, restartNote: COPIES_NOTE },
      { key: "B2_BUCKET", label: "Bucket", help: "Nombre del bucket de B2.", type: "string", pattern: /^[A-Za-z0-9.\-]{0,63}$/, fallback: "", restartNote: COPIES_NOTE },
      { key: "B2_PATH", label: "Carpeta dentro del bucket", help: "Ruta dentro del bucket donde se guardan las copias.", type: "string", pattern: /^(?!.*\.\.)[A-Za-z0-9 _.\-/]{0,200}$/, fallback: "omni-rag", restartNote: COPIES_NOTE },
      { key: "B2_KEY_ID", label: "Identificador de la clave", help: "keyID de la clave de aplicación de B2.", type: "secret", restartNote: COPIES_NOTE },
      { key: "B2_APPLICATION_KEY", label: "Clave de aplicación", help: "applicationKey de B2.", type: "secret", restartNote: COPIES_NOTE },
    ],
  },
];

/** Carpeta externa elegida desde la pantalla: la escribe backup.sh al terminar una orden, no el formulario. */
export const DESTINATION_KEY = "BACKUP_DESTINATION";

const DEFS = new Map(GROUPS.flatMap((g) => g.fields).map((d) => [d.key, d]));
const BACKUP_GROUP_IDS = new Set(["backup", "b2"]);

type ConfigKeys = Extract<keyof Config, string>;
/** Claves del catálogo que además son variables de config.ts (las demás solo las leen los scripts de copia). */
export type SettingKey = Extract<
  | "ALERT_EMAIL" | "ALERT_DISK_FREE_PERCENT" | "ALERT_BACKUP_HOURS" | "ALERT_QUEUE_MINUTES" | "ALERT_CONTAINER_MEM_PERCENT" | "ALERT_HOST_MEM_PERCENT"
  | "SMTP_HOST" | "SMTP_PORT" | "SMTP_USER" | "SMTP_PASSWORD" | "SMTP_FROM" | "SMTP_SECURE"
  | "TRASH_RETENTION_DAYS" | "AUDIT_RETENTION_DAYS" | "METRICS_RETENTION_DAYS" | "QUOTA_WARN_PERCENT"
  | "IP_RATE_LIMIT_PER_MIN" | "INVITE_EXPIRES_HOURS" | "RESET_EXPIRES_MINUTES"
  | "OPENROUTER_API_KEY" | "GROQ_API_KEY" | "GOOGLE_API_KEY" | "OPENAI_API_KEY" | "DEEPSEEK_API_KEY" | "LLM_CUSTOM_API_KEY"
  | "LLM_CUSTOM_BASE_URL" | "LLM_DEFAULT_PROVIDER" | "LLM_TEMPERATURE" | "LLM_MAX_TOKENS"
  | "WEB_SEARCH_PROVIDER" | "WEB_SEARCH_API_KEY" | "WEB_SEARCH_URL" | "WEB_SEARCH_MAX_RESULTS"
  | "RETRIEVAL_TOP_K" | "RERANK_MIN_SCORE" | "CACHE_ENABLED" | "CACHE_TTL_HOURS" | "HISTORY_MESSAGES",
  ConfigKeys
>;

// --- Valor efectivo ---------------------------------------------------------------

/** Lo guardado en la base (secretos ya descifrados). */
let stored = new Map<string, unknown>();

const envRaw = (key: string): string | undefined => process.env[key]?.trim() || undefined;
const inConfig = (key: string): key is ConfigKeys => Object.hasOwn(DEFAULTS, key);

function parseEnv(def: Def, raw: string): unknown {
  if (def.type === "number") return Number(raw);
  if (def.type === "boolean") return raw === "true";
  return raw;
}

function defaultOf(def: Def): unknown {
  if (def.type === "secret") return "";
  return inConfig(def.key) ? DEFAULTS[def.key] : def.fallback;
}

function effective(def: Def): unknown {
  const raw = envRaw(def.key);
  if (raw !== undefined) return inConfig(def.key) ? config[def.key] : parseEnv(def, raw);
  if (stored.has(def.key)) return stored.get(def.key);
  return inConfig(def.key) ? config[def.key] : defaultOf(def);
}

/** Valor efectivo de un ajuste (variable de entorno, ajuste guardado o valor por defecto). Síncrono: lee la memoria. */
export const setting = <K extends SettingKey>(key: K): Config[K] => effective(DEFS.get(key)!) as Config[K];

/** ¿Tienen valor efectivo (entorno o ajuste guardado) el bucket y las dos claves de B2? Sin ellas no hay nada que subir. */
export const b2Configured = (): boolean => ["B2_BUCKET", "B2_KEY_ID", "B2_APPLICATION_KEY"].every((k) => present(effective(DEFS.get(k)!)));

/** Carpeta externa vigente de las copias: ruta relativa dentro de /targets, o vacío para la carpeta clásica. */
export function backupDestination(): string {
  return envRaw(DESTINATION_KEY) ?? (typeof stored.get(DESTINATION_KEY) === "string" ? (stored.get(DESTINATION_KEY) as string) : "");
}

// --- Carga desde la base ---------------------------------------------------------------

const SECRET_INFO = "settings-secret";

/** Secretos guardados que no se pueden descifrar (cambió JWT_SECRET). Se avisan una sola vez, no en cada lectura. */
let undecryptable = new Set<string>();
const warned = new Set<string>();

/** Abre un secreto atado a su clave. Los guardados antes de usar AAD se abren sin él y se reescriben con él. */
function openSecret(key: string, secret: string): { value: string; legacy: boolean } {
  try {
    return { value: open(SECRET_INFO, secret, key), legacy: false };
  } catch {
    return { value: open(SECRET_INFO, secret), legacy: true };
  }
}

export async function refreshSettings(): Promise<void> {
  const rows = await sqlOwner<{ key: string; value: unknown; secret: string | null }[]>`SELECT key, value, secret FROM settings`;
  const next = new Map<string, unknown>();
  const broken = new Set<string>();
  for (const r of rows) {
    if (r.secret !== null) {
      try {
        const { value, legacy } = openSecret(r.key, r.secret);
        next.set(r.key, value);
        if (legacy) {
          // Mejora al vuelo: se vuelve a guardar atado a su clave. Si falla, se reintenta en la próxima lectura.
          const sealed = seal(SECRET_INFO, value, r.key);
          await sqlOwner`UPDATE settings SET secret = ${sealed} WHERE key = ${r.key} AND secret = ${r.secret}`.catch(() => {});
        }
      } catch {
        broken.add(r.key);
        if (!warned.has(r.key)) {
          warned.add(r.key);
          console.error(`[ajustes] no se pudo descifrar ${r.key} (¿cambió JWT_SECRET?); se ignora hasta que se vuelva a escribir`);
        }
      }
    } else if (r.value !== null) {
      next.set(r.key, r.value);
    }
  }
  for (const k of warned) if (!broken.has(k)) warned.delete(k);
  undecryptable = broken;
  stored = next;
}

/** Carga los ajustes y los relee cada 30 s. Se llama una vez al arrancar la API y el worker. */
export async function startSettingsRefresh(): Promise<void> {
  const tick = () => refreshSettings().catch((err) => console.error("[ajustes] no se pudieron leer:", err instanceof Error ? err.message : err));
  await tick();
  setInterval(tick, 30_000).unref();
}

// --- Vista y edición (pantalla Sistema → Configuración) ---------------------------------------------------------------

const present = (v: unknown) => v !== "" && v !== null && v !== undefined;

function toField(def: Def) {
  const secret = def.type === "secret";
  const value = effective(def);
  return {
    key: def.key,
    label: def.label,
    help: def.help,
    type: def.type,
    ...(def.options && { options: def.options }),
    ...(def.min !== undefined && { min: def.min }),
    ...(def.max !== undefined && { max: def.max }),
    ...(def.step !== undefined && { step: def.step }),
    ...(def.unit && { unit: def.unit }),
    value: secret ? null : value,
    default: secret ? null : defaultOf(def),
    lockedByEnv: envRaw(def.key) !== undefined,
    configured: present(value),
    ...(secret && undecryptable.has(def.key) && envRaw(def.key) === undefined && { undecryptable: true }),
    ...(def.restartNote && { restartNote: def.restartNote }),
  };
}

export const settingsView = () => ({
  groups: GROUPS.map((g) => ({ id: g.id, title: g.title, description: g.description, fields: g.fields.map(toField) })),
});

const emailList = z.string().max(500).regex(NO_CONTROL).refine((s) => s.split(/[,;\s]+/).filter(Boolean).every((a) => z.email().safeParse(a).success));
const httpUrl = z.string().max(500).refine((s) => {
  if (s === "") return true;
  try {
    return /^https?:$/.test(new URL(s).protocol);
  } catch {
    return false;
  }
});

function validator(def: Def): z.ZodType {
  switch (def.type) {
    case "number": {
      const n = def.int ? z.number().int() : z.number();
      return n.min(def.min ?? -Infinity).max(def.max ?? Infinity);
    }
    case "boolean":
      return z.boolean();
    case "email":
      return emailList;
    case "url":
      return httpUrl;
    case "time":
      return z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d)?$/);
    case "enum":
      return z.enum(def.options!.map((o) => o.value) as [string, ...string[]]);
    case "secret":
      return z.string().min(1).max(2000).regex(NO_CONTROL);
    default:
      return z.string().max(300).regex(def.pattern ?? NO_CONTROL);
  }
}

export class SettingsError extends Error {}

export type SettingsInput = Record<string, unknown>;

/**
 * Secretos que dejan de valer si cambia el servicio al que pertenecen: si se edita alguno de estos ajustes sin enviar el
 * secreto en el mismo cambio, el secreto guardado se borra (así una clave no viaja a un servidor que no es el que se guardó).
 */
const SECRET_BOUND_TO: Record<string, string> = {
  SMTP_HOST: "SMTP_PASSWORD",
  SMTP_PORT: "SMTP_PASSWORD",
  LLM_CUSTOM_BASE_URL: "LLM_CUSTOM_API_KEY",
  WEB_SEARCH_URL: "WEB_SEARCH_API_KEY",
  WEB_SEARCH_PROVIDER: "WEB_SEARCH_API_KEY",
};

export interface SettingsResult {
  /** Claves pedidas (nunca valores). */
  keys: string[];
  /** Secretos borrados porque cambió el servidor al que pertenecían. */
  cleared: string[];
}

/**
 * Aplica un cambio de ajustes: `null` vuelve al valor por defecto (borra la fila); en un secreto, texto = valor nuevo.
 * Todo o nada: si una clave no es válida no se guarda ninguna. `beforeWrite` se ejecuta tras validar y justo antes de
 * guardar (la reconfirmación de identidad: un código no se gasta con un cambio que ni siquiera es válido).
 */
export async function applySettings(values: SettingsInput, by: string, beforeWrite?: () => Promise<void>): Promise<SettingsResult> {
  const ops: { def: Def; value: unknown }[] = [];
  for (const [key, value] of Object.entries(values)) {
    const def = DEFS.get(key);
    if (key === DESTINATION_KEY) throw new SettingsError("La carpeta externa se cambia con «Cambiar destino», no desde los ajustes.");
    if (!def) throw new SettingsError(`Ajuste desconocido: ${key.slice(0, 60)}`);
    if (envRaw(key) !== undefined) throw new SettingsError(`«${def.label}» está fijado en el .env del servidor.`);
    if (value !== null && !validator(def).safeParse(value).success) throw new SettingsError(`Valor no válido para «${def.label}».`);
    ops.push({ def, value });
  }
  if (ops.length === 0) return { keys: [], cleared: [] };

  // Secretos a borrar: el ajuste cambia de valor de verdad, el secreto no viene en el mismo cambio y no está fijado en el entorno.
  const cleared: string[] = [];
  for (const { def, value } of ops) {
    const secretKey = SECRET_BOUND_TO[def.key];
    if (!secretKey || Object.hasOwn(values, secretKey) || envRaw(secretKey) !== undefined || cleared.includes(secretKey)) continue;
    const next = value === null ? defaultOf(def) : value;
    if (JSON.stringify(next) === JSON.stringify(effective(def))) continue;
    if (stored.has(secretKey) || undecryptable.has(secretKey)) cleared.push(secretKey);
  }

  await beforeWrite?.();
  await sqlOwner.begin(async (tx) => {
    for (const { def, value } of ops) {
      if (value === null) await tx`DELETE FROM settings WHERE key = ${def.key}`;
      else await upsert(tx, def, value, by);
    }
    for (const key of cleared) await tx`DELETE FROM settings WHERE key = ${key}`;
  });
  await refreshSettings();
  return { keys: ops.map((o) => o.def.key), cleared };
}

async function upsert(tx: TransactionSql, def: Def, value: unknown, by: string): Promise<void> {
  if (def.type === "secret") {
    await tx`
      INSERT INTO settings (key, value, secret, updated_at, updated_by) VALUES (${def.key}, NULL, ${seal(SECRET_INFO, value as string, def.key)}, now(), ${by})
      ON CONFLICT (key) DO UPDATE SET value = NULL, secret = EXCLUDED.secret, updated_at = now(), updated_by = EXCLUDED.updated_by`;
  } else {
    // tx.json: el driver ya convierte a JSON. Con JSON.stringify(...)::jsonb se convertía dos veces y la fila quedaba
    // como texto JSON con comillas dentro ("\"tavily\"", "9"): ver migración 022.
    await tx`
      INSERT INTO settings (key, value, secret, updated_at, updated_by) VALUES (${def.key}, ${tx.json(value as JSONValue)}, NULL, now(), ${by})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, secret = NULL, updated_at = now(), updated_by = EXCLUDED.updated_by`;
  }
}

// --- Pasar lo fijado en el .env a la base ---------------------------------------------------------------

export interface EnvImportResult {
  /** Claves copiadas a la base (nunca valores). */
  imported: string[];
  /** Claves cuyo valor del .env no pasa la validación de la pantalla: no se copian y deben quedarse en el .env. */
  invalid: string[];
}

/**
 * Copia a la tabla `settings` cada ajuste del catálogo que está fijado en el entorno, con su valor efectivo de ahora
 * (los secretos, cifrados). Mientras la variable siga en el .env nada cambia; al quitarla, manda la fila y el ajuste se
 * puede editar en la pantalla. Todo o nada. Lo usa scripts/import-env-settings.ts desde la consola del servidor.
 */
export async function importEnvSettings(by: string): Promise<EnvImportResult> {
  const ops: { def: Def; value: unknown }[] = [];
  const invalid: string[] = [];
  for (const def of DEFS.values()) {
    if (envRaw(def.key) === undefined) continue;
    const value = effective(def);
    if (validator(def).safeParse(value).success) ops.push({ def, value });
    else invalid.push(def.key);
  }
  if (ops.length > 0) {
    await sqlOwner.begin(async (tx) => {
      for (const { def, value } of ops) await upsert(tx, def, value, by);
    });
    await refreshSettings();
  }
  return { imported: ops.map((o) => o.def.key), invalid };
}

// --- Archivo para los scripts de copia ---------------------------------------------------------------

/**
 * Ajustes de las copias que no están fijados en el .env, más la carpeta externa, para el archivo `b2.env` que leen los
 * scripts. Los fijados en el .env no se incluyen: los scripts ya los reciben por su entorno.
 */
export function backupSettingsForScripts(): [string, string][] {
  const out: [string, string][] = [];
  for (const g of GROUPS.filter((x) => BACKUP_GROUP_IDS.has(x.id))) {
    for (const def of g.fields) {
      if (envRaw(def.key) === undefined) out.push([def.key, String(effective(def))]);
    }
  }
  if (envRaw(DESTINATION_KEY) === undefined) out.push([DESTINATION_KEY, backupDestination()]);
  return out;
}
