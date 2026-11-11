/**
 * Comprobación de secretos para despliegues reales. Módulo puro (sin configuración
 * ni red) para poder probarlo. En la imagen de producción (`NODE_ENV=production`) el servidor se niega a arrancar con
 * las claves de ejemplo del `.env.example`, haya o no `DOMAIN` (un servidor publicado por Nginx Proxy Manager o
 * Cloudflare no necesita `DOMAIN`). Con un dominio público, además, rechaza las claves cortas.
 */

const PLACEHOLDER = /cambia|changeme|change-me|ejemplo|example|contraseña|password|secret0|tu-clave/i;

/** ¿Hay un dominio público (producción)? `localhost` o vacío = desarrollo local. */
export const isRealDomain = (domain: string) => domain !== "" && domain !== "localhost";

const passwordOf = (url: string): string => {
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return "";
  }
};

interface SecretsInput {
  domain: string;
  jwtSecret: string;
  appDbPassword: string;
  databaseUrl: string;
  /** Imagen de producción (`NODE_ENV=production`): los valores de ejemplo se rechazan aunque no haya dominio. */
  production?: boolean;
}

/** Problemas de los secretos; lista vacía = correctos (o desarrollo local, donde no se exige). */
export function weakSecrets(env: SecretsInput): string[] {
  const domain = isRealDomain(env.domain);
  if (!domain && !env.production) return [];
  const problems: string[] = [];
  const check = (name: string, value: string, min: number) => {
    if (PLACEHOLDER.test(value)) problems.push(`${name} sigue con el valor de ejemplo`);
    else if (domain && value.length < min) problems.push(`${name} es demasiado corta (mínimo ${min} caracteres)`);
  };
  check("JWT_SECRET", env.jwtSecret, 32);
  check("APP_DB_PASSWORD", env.appDbPassword, 16);
  const owner = passwordOf(env.databaseUrl);
  if (owner) check("POSTGRES_PASSWORD", owner, 16);
  return problems;
}

/** Contraseña inicial del superadministrador: en producción no puede ser la del ejemplo. */
export function weakSeedPassword(domain: string, password: string): string | null {
  if (!isRealDomain(domain)) return null;
  return PLACEHOLDER.test(password) ? "SEED_ADMIN_PASSWORD sigue con el valor de ejemplo" : null;
}
