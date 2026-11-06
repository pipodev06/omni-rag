import { sqlOwner } from "../db/client.js";
import { hashPassword, passwordProblem } from "../auth/password.js";
import { weakSeedPassword } from "../lib/secrets.js";
import { USERNAME_RE } from "../lib/validate.js";

export const PLATFORM_NAME = "Plataforma";
export const PLATFORM_SLUG = "plataforma";

export interface InitialAdmin {
  username: string;
  email: string | null;
  password: string;
}

export interface CreatedAdmin {
  id: string;
  tenant_id: string;
  username: string;
  email: string | null;
  name: string;
}

/**
 * Mínimo del primer superadministrador: puede quedar sin 2FA (en local no se exige), y sin segundo factor NIST
 * 800-63B rev. 4 pide 15 caracteres. El resto de usuarios sigue con el mínimo general.
 */
export const INITIAL_ADMIN_MIN_PASSWORD = 15;

/** Problema de un usuario/contraseña para el primer superadministrador, o null si vale. */
export function initialAdminProblem(a: InitialAdmin): string | null {
  if (!USERNAME_RE.test(a.username)) return "El usuario debe tener 3-40 caracteres: minúsculas, números, punto, guion o guion bajo.";
  if (a.password.length < INITIAL_ADMIN_MIN_PASSWORD) return `La contraseña del superadministrador debe tener al menos ${INITIAL_ADMIN_MIN_PASSWORD} caracteres.`;
  return passwordProblem(a.password) ?? weakSeedPassword(process.env.DOMAIN?.trim() ?? "", a.password);
}

/**
 * Crea la organización interna «Plataforma» y su superadministrador, solo si la base aún no tiene ningún usuario (si ya
 * hay uno devuelve null). La tabla se bloquea durante la comprobación: dos peticiones a la vez no crean dos.
 * Plataforma no es un cliente: no aparece en la lista de organizaciones ni se puede borrar.
 */
export async function createInitialAdmin(a: InitialAdmin): Promise<CreatedAdmin | null> {
  const hash = await hashPassword(a.password);
  return sqlOwner.begin(async (tx) => {
    await tx`LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`;
    const [{ n } = { n: 0 }] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM users`;
    if (n > 0) return null;
    const [t] = await tx<{ id: string }[]>`
      INSERT INTO tenants (name, slug, is_platform) VALUES (${PLATFORM_NAME}, ${PLATFORM_SLUG}, true)
      ON CONFLICT (slug) DO UPDATE SET is_platform = true RETURNING id`;
    const [u] = await tx<CreatedAdmin[]>`
      INSERT INTO users (tenant_id, username, email, name, password_hash, role, is_superadmin)
      VALUES (${t!.id}, ${a.username}, ${a.email}, 'Administrador', ${hash}, 'admin', true)
      RETURNING id, tenant_id, username, email, name`;
    return u!;
  });
}

/** ¿Falta crear el primer usuario? Mientras sea así, la web muestra la configuración inicial. */
export async function setupPending(): Promise<boolean> {
  const [{ n } = { n: 0 }] = await sqlOwner<{ n: number }[]>`SELECT count(*)::int AS n FROM users`;
  return n === 0;
}

/**
 * Crea el superadministrador al arrancar si la base está vacía y el archivo de entorno trae SEED_ADMIN_* (instalaciones
 * automatizadas). Sin esas variables no hace nada: el superadministrador se crea en la configuración inicial de la web.
 * Ninguna organización de cliente se crea sola: la primera se crea en Organizaciones. Es idempotente.
 */
export async function ensureInitialAdmin(): Promise<void> {
  if (!(await setupPending())) return;

  if (process.env.SEED_TENANT_NAME || process.env.SEED_TENANT_SLUG) {
    console.warn("[bootstrap] SEED_TENANT_NAME y SEED_TENANT_SLUG ya no se usan: crea la primera organización en Organizaciones.");
  }
  const password = process.env.SEED_ADMIN_PASSWORD ?? "";
  if (!password) return;
  // El usuario es obligatorio; el email es opcional (si falta, se usa la parte anterior a «@» o «admin»).
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase() || null;
  const username =
    process.env.SEED_ADMIN_USERNAME?.trim().toLowerCase() || email?.split("@")[0]?.replace(/[^a-z0-9._-]/g, "") || "admin";
  const problem = initialAdminProblem({ username, email, password });
  if (problem) throw new Error(`SEED_ADMIN_USERNAME / SEED_ADMIN_PASSWORD: ${problem}`);

  const created = await createInitialAdmin({ username, email, password });
  if (created) console.log(`[bootstrap] creado el superadministrador ${username} en la organización interna «${PLATFORM_NAME}». Crea tu primera organización en Organizaciones.`);
}
