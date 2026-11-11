/**
 * Sesiones de soporte contra PostgreSQL real y la aplicación completa (rutas, middleware, cookies).
 * Se ejecuta solo con base de datos de prueba (ver docs/desarrollo.md):
 *   RUN_DB_TESTS=1 DATABASE_URL=... APP_DATABASE_URL=... APP_DB_PASSWORD=... pnpm test
 * Comportamiento esperado: al entrar como soporte la sesión normal del superadministrador se cierra; al salir o cerrar
 * sesión, el token de soporte deja de valer; salir devuelve una sesión normal nueva.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "./env.js";

const enabled = process.env.RUN_DB_TESTS === "1";

describe.skipIf(!enabled)("Sesiones de soporte", async () => {
  const { migrate } = await import("../src/db/migrate.js");
  const { sqlOwner, closeDb } = await import("../src/db/client.js");
  const { hashPassword } = await import("../src/auth/password.js");
  const { createApp } = await import("../src/app.js");
  const app = createApp();
  const tag = Date.now().toString(36);
  const password = "contraseña-de-prueba-larga-123";
  const ids: Record<string, string> = {};

  /** Las fechas del token y del cierre masivo van en segundos: se espera al siguiente segundo para que la comparación sea estricta. */
  const nextSecond = () => new Promise((r) => setTimeout(r, 1100));

  const call = (method: string, path: string, token?: string) =>
    app.request(path, { method, headers: { "x-real-ip": "10.9.8.7", ...(token && { authorization: `Bearer ${token}` }) } });

  /** Cierre de sesión como lo hace el navegador (cookie). Los scripts usan Bearer (ver el último caso). */
  const logoutWithCookie = (token: string) =>
    app.request("/api/auth/logout", { method: "POST", headers: { "x-real-ip": "10.9.8.7", cookie: `rag_session=${token}` } });

  /** Valor de la cookie de sesión que pone la respuesta. */
  const cookieOf = (res: Response): string | undefined => /rag_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];

  const loginSuperadmin = async (): Promise<string> => {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "10.9.8.7" },
      body: JSON.stringify({ login: `root-${tag}`, password }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  };

  const enter = async (token: string): Promise<string> => {
    const res = await call("POST", `/api/platform/tenants/${ids.client}/enter`, token);
    expect(res.status).toBe(200);
    const support = cookieOf(res);
    expect(support).toBeTruthy();
    return support!;
  };

  beforeAll(async () => {
    await migrate();
    const [home] = await sqlOwner`INSERT INTO tenants (name, slug) VALUES ('home', ${`sup-home-${tag}`}) RETURNING id`;
    const [client] = await sqlOwner`INSERT INTO tenants (name, slug) VALUES ('cliente', ${`sup-client-${tag}`}) RETURNING id`;
    ids.client = client!.id;
    await sqlOwner`
      INSERT INTO users (tenant_id, username, email, name, password_hash, role, is_superadmin)
      VALUES (${home!.id}, ${`root-${tag}`}, ${`root-${tag}@soporte.test`}, 'Root', ${await hashPassword(password)}, 'admin', true)`;
  });

  afterAll(async () => {
    await sqlOwner`DELETE FROM tenants WHERE slug LIKE ${`sup-%-${tag}`}`;
    await closeDb();
  });

  it("entrar como soporte da una sesión de soporte válida y cierra la sesión normal anterior", async () => {
    const normal = await loginSuperadmin();
    expect((await call("GET", "/api/auth/me", normal)).status).toBe(200);

    const support = await enter(normal);

    const me = await call("GET", "/api/auth/me", support);
    expect(me.status).toBe(200);
    const body = (await me.json()) as { support: { username: string } | null; tenant: { slug: string } };
    expect(body.support?.username).toBe(`root-${tag}`);
    expect(body.tenant.slug).toBe(`sup-client-${tag}`);

    expect((await call("GET", "/api/auth/me", normal)).status).toBe(401);
  });

  it("salir de soporte abre una sesión normal nueva e invalida el token de soporte", async () => {
    const normal = await loginSuperadmin();
    const support = await enter(normal);
    await nextSecond();

    const exit = await call("POST", "/api/auth/exit-support", support);
    expect(exit.status).toBe(200);
    const fresh = ((await exit.json()) as { token: string }).token;

    const me = await call("GET", "/api/auth/me", fresh);
    expect(me.status).toBe(200);
    expect(((await me.json()) as { support: unknown }).support).toBeNull();
    expect((await call("GET", "/api/auth/me", support)).status).toBe(401);
    expect((await call("GET", "/api/auth/me", normal)).status).toBe(401);
  });

  it("cerrar sesión desde soporte invalida el token de soporte", async () => {
    const normal = await loginSuperadmin();
    const support = await enter(normal);
    expect((await call("GET", "/api/auth/me", support)).status).toBe(200);
    await nextSecond();

    expect((await logoutWithCookie(support)).status).toBe(200);
    expect((await call("GET", "/api/auth/me", support)).status).toBe(401);
  });

  it("cerrar sesión con Authorization: Bearer también la cierra en el servidor", async () => {
    const normal = await loginSuperadmin();
    expect((await call("POST", "/api/auth/logout", normal)).status).toBe(200);
    expect((await call("GET", "/api/auth/me", normal)).status).toBe(401);

    const support = await enter(await loginSuperadmin());
    await nextSecond();
    expect((await call("POST", "/api/auth/logout", support)).status).toBe(200);
    expect((await call("GET", "/api/auth/me", support)).status).toBe(401);
  });
});
