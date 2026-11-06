import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "./env.js";
import { withGeneratedSecrets } from "../src/config.js";

/** Partes de una URL de PostgreSQL, con la contraseña ya decodificada. */
const parts = (raw: string | undefined) => {
  const u = new URL(raw!);
  return { user: u.username, pass: decodeURIComponent(u.password), host: u.host, db: u.pathname };
};

/** Arranque sin archivo de entorno: los secretos salen de los archivos que genera el servicio «init». */
describe("withGeneratedSecrets", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "rag-secrets-"));
    await writeFile(join(dir, "postgres_password"), "a".repeat(64) + "\n");
    await writeFile(join(dir, "app_db_password"), "b".repeat(64));
    await writeFile(join(dir, "jwt_secret"), "c".repeat(64));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("sin variables: toma los archivos y arma las URL con el host db", () => {
    const env = withGeneratedSecrets({ SECRETS_DIR: dir, DATABASE_URL: "", APP_DATABASE_URL: "" });
    expect(env.JWT_SECRET).toBe("c".repeat(64));
    expect(env.APP_DB_PASSWORD).toBe("b".repeat(64));
    expect(parts(env.DATABASE_URL)).toEqual({ user: "rag_owner", pass: "a".repeat(64), host: "db:5432", db: "/rag" });
    expect(parts(env.APP_DATABASE_URL)).toEqual({ user: "rag_app", pass: "b".repeat(64), host: "db:5432", db: "/rag" });
  });

  it("una variable escrita manda sobre el archivo (instalaciones con .env)", () => {
    const env = withGeneratedSecrets({ SECRETS_DIR: dir, POSTGRES_PASSWORD: "p/a+s=s", JWT_SECRET: "x".repeat(40), DATABASE_URL: "" });
    expect(env.JWT_SECRET).toBe("x".repeat(40));
    expect(parts(env.DATABASE_URL)).toMatchObject({ user: "rag_owner", pass: "p/a+s=s", host: "db:5432" });
  });

  it("una URL completa (desarrollo fuera de Docker) no se toca", () => {
    const dev = Object.assign(new URL("postgres://localhost:15432/rag"), { username: "rag_owner", password: "x" }).toString();
    const env = withGeneratedSecrets({ SECRETS_DIR: dir, DATABASE_URL: dev });
    expect(env.DATABASE_URL).toBe(dev);
  });

  it("sin carpeta ni variables no inventa nada: la validación de config.ts dirá qué falta", () => {
    const env = withGeneratedSecrets({ SECRETS_DIR: join(dir, "no-existe") });
    expect(env.JWT_SECRET).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });
});
