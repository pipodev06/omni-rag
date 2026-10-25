import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Datos de la organización temporal, escritos por global-setup y borrados por global-teardown (no se suben al repositorio). */
export const STATE_FILE = fileURLToPath(new URL("./.state.json", import.meta.url));

export interface E2EState {
  tenantId: string;
  slug: string;
  username: string;
  password: string;
}

export const readState = (): E2EState => JSON.parse(readFileSync(STATE_FILE, "utf8")) as E2EState;

export const baseUrl = () => (process.env.E2E_BASE_URL ?? "http://localhost:8000").replace(/\/$/, "");

export async function api<T = unknown>(method: string, path: string, opts: { token?: string; json?: unknown } = {}): Promise<{ status: number; data: T }> {
  const res = await fetch(`${baseUrl()}/api${path}`, {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.json !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* respuesta sin JSON */
  }
  return { status: res.status, data: data as T };
}

/** Sesión del superadministrador (E2E_USER / E2E_PASSWORD). Con 2FA no se puede automatizar: se avisa claro. */
export async function superadminToken(): Promise<string> {
  const login = process.env.E2E_USER;
  const password = process.env.E2E_PASSWORD;
  if (!login || !password) throw new Error("Faltan E2E_USER y E2E_PASSWORD (el superadministrador del sistema que se prueba)");
  const r = await api<{ token?: string; mfaRequired?: boolean; error?: string }>("POST", "/auth/login", { json: { login, password } });
  if (r.data.mfaRequired) throw new Error("El superadministrador tiene 2FA: las pruebas E2E se lanzan contra una instalación local o de pruebas sin 2FA");
  if (r.status !== 200 || !r.data.token) throw new Error(`No se pudo iniciar sesión como superadministrador (${r.status})`);
  return r.data.token;
}
