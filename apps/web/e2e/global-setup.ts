import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { api, STATE_FILE, superadminToken, type E2EState } from "./helpers";

/** Crea una organización temporal con su administrador; las pruebas entran con él por la pantalla de login. */
export default async function globalSetup() {
  const token = await superadminToken();
  const stamp = Date.now().toString(36);
  const state: Omit<E2EState, "tenantId"> = {
    slug: `e2e-${stamp}`,
    username: `e2e-admin-${stamp}`,
    password: `E2e-${randomBytes(9).toString("base64url")}`,
  };
  const r = await api<{ tenantId?: string; error?: string }>("POST", "/platform/tenants", {
    token,
    json: { name: `E2E ${stamp}`, slug: state.slug, admin: { username: state.username, name: "Admin E2E", password: state.password } },
  });
  if (r.status !== 201 || !r.data.tenantId) throw new Error(`No se pudo crear la organización de prueba (${r.status}): ${JSON.stringify(r.data)}`);
  writeFileSync(STATE_FILE, JSON.stringify({ ...state, tenantId: r.data.tenantId }));
}
