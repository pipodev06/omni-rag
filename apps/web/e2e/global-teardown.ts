import { existsSync, rmSync } from "node:fs";
import { api, readState, STATE_FILE, superadminToken } from "./helpers";

/** Borra la organización temporal (con sus usuarios, documentos y archivos): primero se desactiva, como exige la API. */
export default async function globalTeardown() {
  if (!existsSync(STATE_FILE)) return;
  const { tenantId, slug } = readState();
  try {
    const token = await superadminToken();
    await api("PATCH", `/platform/tenants/${tenantId}`, { token, json: { isActive: false } });
    const r = await api("DELETE", `/platform/tenants/${tenantId}`, { token, json: { confirmSlug: slug } });
    if (r.status !== 200) console.warn(`No se pudo borrar la organización de prueba ${slug} (${r.status}); bórrala desde Organizaciones`);
  } finally {
    rmSync(STATE_FILE, { force: true });
  }
}
