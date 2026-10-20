import postgres from "postgres";
import { config } from "../config.js";

/**
 * Dos conexiones a PostgreSQL:
 *
 * - `sqlOwner`: dueño de las tablas. NO está sujeto a Row Level Security.
 *   Solo se usa para login, migraciones y tareas de plataforma (crear organizaciones).
 * - `sqlApp`: usuario `rag_app`. SÍ está sujeto a Row Level Security.
 *   Todo acceso a datos de un cliente debe pasar por `withTenant()`.
 */
export const sqlOwner = postgres(config.DATABASE_URL, { max: 5, onnotice: () => {} });
export const sqlApp = postgres(config.APP_DATABASE_URL, { max: 20, onnotice: () => {} });

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

export type Role = "admin" | "editor" | "viewer";

/** Identidad con la que se ejecuta una transacción. */
export interface TenantContext {
  tenantId: string;
  userId: string | null;
  role: Role;
}

/**
 * Ejecuta `fn` dentro de una transacción en la que PostgreSQL conoce la
 * organización, el usuario y el rol actuales. Las políticas RLS usan estos
 * valores para filtrar automáticamente lo que se puede leer y escribir.
 */
export async function withTenant<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const result = await sqlApp.begin(async (tx) => {
    await tx`
      SELECT set_config('app.tenant_id', ${ctx.tenantId}, true),
             set_config('app.user_id', ${ctx.userId ?? ""}, true),
             set_config('app.role', ${ctx.role}, true)
    `;
    return fn(tx);
  });
  return result as T;
}

export async function closeDb(): Promise<void> {
  await Promise.all([sqlOwner.end({ timeout: 5 }), sqlApp.end({ timeout: 5 })]);
}

/** Convierte un vector de JS al formato de texto que acepta pgvector: "[0.1,0.2,...]". */
export const toPgVector = (v: number[]): string => `[${v.join(",")}]`;
