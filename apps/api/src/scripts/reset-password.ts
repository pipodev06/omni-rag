import { randomBytes } from "node:crypto";
import { hashPassword, passwordProblem } from "../auth/password.js";
import { closeDb, sqlOwner } from "../db/client.js";
import { auditLog } from "../lib/audit.js";

/**
 * Restablece la contraseña de un usuario desde la consola del servidor. Pensado para el caso
 * en que el superadministrador no puede entrar (olvidó la contraseña o el .env ya no coincide
 * con la base de datos). No muestra la contraseña salvo con --generar, y la escribe oculta.
 *
 *   docker compose exec api node dist/scripts/reset-password.js <usuario> [--generar] [--quitar-2fa]
 *
 * Sin --generar pide la contraseña dos veces (hace falta terminal: no uses `exec -T`).
 * Con la entrada redirigida (`printf 'clave\nclave\n' | docker compose exec -T …`) lee las dos líneas.
 * Cierra todas las sesiones abiertas del usuario y deja constancia en la auditoría.
 */

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const username = args.find((a) => !a.startsWith("--"));

const fail = async (msg: string): Promise<never> => {
  console.error(`Error: ${msg}`);
  await closeDb().catch(() => {});
  process.exit(1);
};

/** Lee una línea sin mostrar lo que se escribe (terminal) o directamente de la entrada (tuberías). */
function readSecret(prompt: string, lines: string[] | null): Promise<string> {
  if (lines) return Promise.resolve(lines.shift() ?? "");
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") process.exit(130); // Ctrl+C
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readPipedLines(): Promise<string[]> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.split(/\r?\n/);
}

async function main() {
  if (!username || flags.has("--ayuda") || flags.has("--help")) {
    console.log("Uso: node dist/scripts/reset-password.js <usuario> [--generar] [--quitar-2fa]");
    process.exit(username ? 0 : 1);
  }

  const [user] = await sqlOwner<{ id: string; tenant_id: string; username: string; is_active: boolean; totp: boolean }[]>`
    SELECT id, tenant_id, username, is_active, (totp_enabled_at IS NOT NULL) AS totp
      FROM users WHERE lower(username) = lower(${username}) AND support_for IS NULL`;
  if (!user) return fail(`no existe el usuario «${username}»`);
  if (!user.is_active) console.warn(`Aviso: «${user.username}» está desactivado; sigue sin poder entrar hasta activarlo.`);

  let password: string;
  let generated = false;
  if (flags.has("--generar")) {
    password = randomBytes(18).toString("base64url");
    generated = true;
  } else {
    const piped = process.stdin.isTTY ? null : await readPipedLines();
    password = await readSecret("Nueva contraseña: ", piped);
    const confirm = await readSecret("Repite la contraseña: ", piped);
    if (password !== confirm) return fail("las contraseñas no coinciden");
  }
  const problem = passwordProblem(password);
  if (problem) return fail(problem);

  await sqlOwner`
    UPDATE users SET password_hash = ${await hashPassword(password)}, sessions_valid_after = date_trunc('second', now())
     WHERE id = ${user.id}`;
  const removed2fa = flags.has("--quitar-2fa") && user.totp;
  if (removed2fa) {
    await sqlOwner`
      UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, totp_recovery_hashes = '{}'
       WHERE id = ${user.id}`;
  }
  await auditLog({ tenantId: user.tenant_id, userId: user.id, username: "Consola del servidor" }, "user.updated", {
    targetType: "user",
    targetId: user.id,
    details: { passwordReset: true, ...(removed2fa && { totpRemoved: true }) },
  });

  console.log(`Contraseña de «${user.username}» restablecida. Se cerraron sus sesiones abiertas.`);
  if (removed2fa) console.log("Se quitó también su verificación en dos pasos (podrá volver a activarla en Mi cuenta).");
  else if (user.totp) console.log("Mantiene la verificación en dos pasos. Si perdió el teléfono y los códigos, repite con --quitar-2fa.");
  if (generated) console.log(`\nContraseña generada (cámbiala en Mi cuenta; no se volverá a mostrar):\n  ${password}`);
  await closeDb();
}

main().catch(async (err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  await closeDb().catch(() => {});
  process.exit(1);
});
