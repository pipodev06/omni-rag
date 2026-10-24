import { closeDb, sqlOwner } from "../db/client.js";
import { PLATFORM_NAME, PLATFORM_SLUG } from "./bootstrap.js";

/**
 * Mueve al superadministrador a la organización interna «Plataforma», para que la organización donde estaba hasta
 * ahora sea una más (y se pueda borrar). Mantiene usuario, correo, contraseña y verificación en dos pasos.
 *
 *   docker compose exec api node dist/scripts/move-superadmin.js [usuario]               muestra qué pasaría
 *   docker compose exec api node dist/scripts/move-superadmin.js [usuario] --confirmar   lo hace
 *
 * No se puede mover una fila de usuario entre organizaciones (sus conversaciones y valoraciones la apuntan junto con su
 * organización), así que se crea la cuenta en Plataforma con los mismos datos y se borra la anterior. Se pierden su
 * historial de chat y sus valoraciones en la organización de origen, y sus cuentas de soporte en otras organizaciones
 * (se vuelven a crear solas al entrar como soporte). Hay que iniciar sesión de nuevo.
 */
const args = process.argv.slice(2);
const confirm = args.includes("--confirmar");
const wanted = args.find((a) => !a.startsWith("--"));

interface Row {
  id: string;
  username: string;
  tenant_id: string;
  tenant: string;
  is_platform: boolean;
}

const rows = await sqlOwner<Row[]>`
  SELECT u.id, u.username, u.tenant_id, t.name AS tenant, t.is_platform
    FROM users u JOIN tenants t ON t.id = u.tenant_id
   WHERE u.is_superadmin AND u.support_for IS NULL AND (${wanted ?? null}::text IS NULL OR u.username = ${wanted ?? null})
   ORDER BY u.created_at`;

if (rows.length === 0) {
  console.log(wanted ? `No hay un superadministrador llamado «${wanted}».` : "No hay superadministradores.");
  await closeDb();
  process.exit(1);
}
if (rows.length > 1) {
  console.log(`Hay varios superadministradores (${rows.map((r) => r.username).join(", ")}). Indica cuál mover: … move-superadmin.js <usuario>`);
  await closeDb();
  process.exit(1);
}
const su = rows[0]!;
if (su.is_platform) {
  console.log(`«${su.username}» ya está en la organización ${PLATFORM_NAME}. No hay nada que hacer.`);
  await closeDb();
  process.exit(0);
}

const [impact] = await sqlOwner<{ conversations: number; feedback: number; support: number }[]>`
  SELECT (SELECT count(*)::int FROM conversations WHERE user_id = ${su.id}) AS conversations,
         (SELECT count(*)::int FROM message_feedback WHERE user_id = ${su.id}) AS feedback,
         (SELECT count(*)::int FROM users WHERE support_for = ${su.id}) AS support`;

console.log(`Superadministrador: ${su.username} (hoy en la organización «${su.tenant}»)`);
console.log(`Pasará a: ${PLATFORM_NAME} (organización interna: no aparece en la lista ni se puede borrar)`);
console.log("\nSe conserva: usuario, correo, nombre, contraseña, verificación en dos pasos y códigos de recuperación.");
console.log("Se pierde:");
console.log(`  - ${impact!.conversations} conversaciones y ${impact!.feedback} valoraciones de ${su.username} en «${su.tenant}»`);
console.log(`  - ${impact!.support} cuentas de soporte en otras organizaciones (se recrean solas al «Entrar como soporte»)`);
console.log("  - las sesiones abiertas: tendrás que iniciar sesión de nuevo");
console.log(`\nLa organización «${su.tenant}» seguirá existiendo como una más; podrás desactivarla y borrarla desde Organizaciones.`);

if (!confirm) {
  console.log("\nNo se ha cambiado nada. Para hacerlo:  docker compose exec api node dist/scripts/move-superadmin.js " + su.username + " --confirmar");
  await closeDb();
  process.exit(0);
}

await sqlOwner.begin(async (tx) => {
  // La organización interna: la existente, o una nueva (si el identificador «plataforma» estuviera ocupado, otro).
  let [platform] = await tx<{ id: string }[]>`SELECT id FROM tenants WHERE is_platform`;
  if (!platform) {
    const [taken] = await tx<{ id: string }[]>`SELECT id FROM tenants WHERE slug = ${PLATFORM_SLUG}`;
    [platform] = await tx<{ id: string }[]>`
      INSERT INTO tenants (name, slug, is_platform) VALUES (${PLATFORM_NAME}, ${taken ? `${PLATFORM_SLUG}-interna` : PLATFORM_SLUG}, true) RETURNING id`;
  }
  // Todas las columnas del usuario salvo su id y su organización (así se conserva todo lo que se añada en el futuro).
  const cols = (
    await tx<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users' AND column_name NOT IN ('id', 'tenant_id')
       ORDER BY ordinal_position`
  ).map((c) => `"${c.column_name}"`);
  await tx`CREATE TEMP TABLE _superadmin ON COMMIT DROP AS SELECT * FROM users WHERE id = ${su.id}`;
  await tx`DELETE FROM users WHERE id = ${su.id}`;
  await tx.unsafe(`INSERT INTO users (tenant_id, ${cols.join(", ")}) SELECT $1, ${cols.join(", ")} FROM _superadmin`, [platform!.id]);
});

console.log(`\nListo: «${su.username}» está ahora en ${PLATFORM_NAME}. Inicia sesión de nuevo; la organización «${su.tenant}» ya es una más.`);
await closeDb();
