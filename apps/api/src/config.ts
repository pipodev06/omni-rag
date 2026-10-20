import { z } from "zod";

/**
 * Configuración de la aplicación, leída de variables de entorno.
 * Si falta algo obligatorio, el proceso falla al arrancar con un mensaje claro.
 * Ver `.env.example` para la descripción de cada variable.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().default(3001),

  // Conexión "propietaria": crea tablas y se usa solo para login y tareas de plataforma.
  // Este usuario NO está sujeto a Row Level Security.
  DATABASE_URL: z.string().min(1),
  // Conexión de la aplicación: usuario `rag_app`, siempre sujeto a Row Level Security.
  APP_DATABASE_URL: z.string().min(1),
  // Contraseña con la que la migración crea el usuario `rag_app`.
  APP_DB_PASSWORD: z.string().min(8),

  JWT_SECRET: z.string().min(32, "JWT_SECRET debe tener al menos 32 caracteres"),
  JWT_EXPIRES_IN: z.string().default("12h"),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  STORAGE_DIR: z.string().default("./data/uploads"),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(50),

  DOCLING_URL: z.string().url().default("http://localhost:5001"),
  DOCLING_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(900),
  DOCLING_OCR_LANGS: z.string().default("es,en"),

  EMBEDDINGS_URL: z.string().url().default("http://localhost:8080"),
  EMBEDDING_MODEL: z.string().default("intfloat/multilingual-e5-base"),
  EMBEDDING_DIM: z.coerce.number().int().positive().default(768),
  // Prefijos que exigen los modelos E5. Para otros modelos (p. ej. bge-m3) dejar vacíos.
  EMBEDDING_QUERY_PREFIX: z.string().default("query: "),
  EMBEDDING_PASSAGE_PREFIX: z.string().default("passage: "),
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().positive().default(16),

  CHUNK_SIZE_CHARS: z.coerce.number().int().positive().default(1200),
  CHUNK_OVERLAP_CHARS: z.coerce.number().int().nonnegative().default(200),

  OPENROUTER_API_KEY: z.string().default(""),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  // Lista separada por comas. El primero es el principal; el resto son respaldos.
  LLM_MODELS: z
    .string()
    .default(
      "google/gemma-4-31b-it:free,nvidia/nemotron-3-super-120b-a12b:free,minimax/minimax-m3.1-flash:free",
    ),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(2048),
  APP_PUBLIC_URL: z.string().default("http://localhost:8000"),
  APP_NAME: z.string().default("RAG Project"),

  RETRIEVAL_TOP_K: z.coerce.number().int().positive().default(6),
  RETRIEVAL_CANDIDATES: z.coerce.number().int().positive().default(40),
  // Distancia coseno máxima para que un fragmento cuente como resultado vectorial (0 = idéntico, 2 = opuesto).
  RETRIEVAL_MAX_DISTANCE: z.coerce.number().positive().default(0.25),
  FTS_LANGUAGE: z.string().default("spanish"),
  HISTORY_MESSAGES: z.coerce.number().int().nonnegative().default(6),

  // Límite de preguntas al LLM por organización y día (protege el cupo gratuito compartido).
  TENANT_DAILY_QUESTION_LIMIT: z.coerce.number().int().nonnegative().default(200),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuración inválida:\n${issues}`);
  }
  return parsed.data;
}

export const config = load();

export const llmModels = (): string[] =>
  config.LLM_MODELS.split(",")
    .map((m) => m.trim())
    .filter(Boolean);
