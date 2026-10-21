/**
 * Normaliza una URL de PostgreSQL cuya contraseña puede traer caracteres reservados.
 *
 * docker-compose arma la URL de conexión pegando la contraseña tal cual, sin codificarla, y una
 * contraseña de `openssl rand -base64` suele llevar «/», «+» o «=»; con un «/» la URL deja de ser
 * válida. Aquí se codifica la contraseña (si ya venía codificada, se respeta).
 * Si la URL sigue siendo inválida, el error NO incluye su valor: llevaría la contraseña a los logs.
 */
export function normalizeDbUrl(raw: string, name: string): string {
  const m = /^(postgres(?:ql)?:\/\/)([^:/@]+):(.*)@([^@/]+(?:\/.*)?)$/s.exec(raw);
  let url = raw;
  if (m) {
    const [, scheme, user, pass, rest] = m as unknown as [string, string, string, string, string];
    let encoded = pass;
    try {
      if (encodeURIComponent(decodeURIComponent(pass)) !== pass) encoded = encodeURIComponent(pass);
    } catch {
      encoded = encodeURIComponent(pass);
    }
    url = `${scheme}${user}:${encoded}@${rest}`;
  }
  try {
    new URL(url);
  } catch {
    throw new Error(`${name} no es una URL de PostgreSQL válida. Revisa el .env (el valor no se muestra para no filtrar la contraseña).`);
  }
  return url;
}
