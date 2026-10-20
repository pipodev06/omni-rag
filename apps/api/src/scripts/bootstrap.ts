import { sqlOwner } from "../db/client.js";
import { hashPassword, passwordProblem } from "../auth/password.js";

/**
 * Crea la primera organización y su superadministrador si la base de datos
 * está vacía. Usa las variables SEED_* (ver .env.example). Es idempotente.
 */
export async function ensureInitialAdmin(): Promise<void> {
  const [{ n } = { n: 0 }] = await sqlOwner<{ n: number }[]>`SELECT count(*)::int AS n FROM users`;
  if (n > 0) return;

  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? "";
  if (!email || !password) {
    console.warn("[bootstrap] No hay usuarios. Define SEED_ADMIN_EMAIL y SEED_ADMIN_PASSWORD para crear el primero.");
    return;
  }
  const problem = passwordProblem(password);
  if (problem) throw new Error(`SEED_ADMIN_PASSWORD: ${problem}`);

  const tenantName = process.env.SEED_TENANT_NAME ?? "Mi organización";
  const tenantSlug = process.env.SEED_TENANT_SLUG ?? "principal";
  const hash = await hashPassword(password);

  await sqlOwner.begin(async (tx) => {
    const [t] = await tx<{ id: string }[]>`
      INSERT INTO tenants (name, slug) VALUES (${tenantName}, ${tenantSlug})
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`;
    await tx`
      INSERT INTO users (tenant_id, email, name, password_hash, role, is_superadmin)
      VALUES (${t!.id}, ${email}, 'Administrador', ${hash}, 'admin', true)`;
    await tx`
      INSERT INTO collections (tenant_id, name, description)
      VALUES (${t!.id}, 'General', 'Colección por defecto') ON CONFLICT DO NOTHING`;
  });
  console.log(`[bootstrap] creado el superadministrador ${email} en la organización "${tenantName}"`);
}
