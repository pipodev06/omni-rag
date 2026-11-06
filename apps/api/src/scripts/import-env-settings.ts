import { closeDb, sqlOwner } from "../db/client.js";
import { auditLog } from "../lib/audit.js";
import { importEnvSettings, refreshSettings } from "../lib/settings.js";

/**
 * Pasa a la base los ajustes de Sistema → Configuración y Copias que están escritos en el .env, para poder editarlos
 * desde la pantalla (lo escrito en el .env manda y los deja bloqueados). Copia el valor de ahora, así que nada cambia
 * hasta quitar esas líneas del .env; al final muestra los comandos para hacerlo. Nunca muestra valores.
 *
 *   docker compose exec api node dist/scripts/import-env-settings.js
 *
 * Se puede repetir sin problema: vuelve a copiar lo que siga en el .env.
 */
await refreshSettings();
const { imported, invalid } = await importEnvSettings("Consola del servidor");

if (imported.length > 0) {
  const [platform] = await sqlOwner<{ id: string }[]>`SELECT id FROM tenants WHERE is_platform LIMIT 1`;
  await auditLog({ tenantId: platform?.id ?? null, userId: null, username: "Consola del servidor" }, "settings.updated", {
    targetType: "settings",
    details: { keys: imported, cleared: [], origin: "env" },
  });
}
await closeDb();

if (imported.length === 0 && invalid.length === 0) {
  console.log("El .env no fija ningún ajuste de la pantalla: no hay nada que pasar.");
  process.exit(0);
}

if (imported.length > 0) {
  console.log(`Copiados a la base (${imported.length}):`);
  for (const k of imported) console.log(`  ${k}`);
}
if (invalid.length > 0) {
  console.log(`\nNo copiados: su valor del .env no es válido para la pantalla. Corrígelos o déjalos en el .env (${invalid.length}):`);
  for (const k of invalid) console.log(`  ${k}`);
}
if (imported.length > 0) {
  const keys = imported.join("|");
  console.log(`
Todavía manda el .env. Para editarlos desde la pantalla, quita esas líneas del .env (fuera del contenedor, en la carpeta
del proyecto) y aplica:

  cp .env .env.bak-importado
  sed -i -E '/^(${keys})=/d' .env
  docker compose up -d

Comprueba en Sistema → Configuración y Copias que ya no salen bloqueados y borra la copia: rm .env.bak-importado`);
}
