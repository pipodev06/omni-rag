/**
 * Comprobación de secretos para despliegues reales. Módulo puro (sin configuración
 * ni red) para poder probarlo. Con un dominio público configurado, el servidor se
 * niega a arrancar con las claves de ejemplo del `.env.example` o con claves cortas.
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
}

/** Problemas de los secretos; lista vacía = correctos (o instalación local, donde no se exige). */
export function weakSecrets(env: SecretsInput): string[] {
  if (!isRealDomain(env.domain)) return [];
  const problems: string[] = [];
  const check = (name: string, value: string, min: number) => {
    if (PLACEHOLDER.test(value)) problems.push(`${name} sigue con el valor de ejemplo`);
    else if (value.length < min) problems.push(`${name} es demasiado corta (mínimo ${min} caracteres)`);
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
