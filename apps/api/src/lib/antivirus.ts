import { once } from "node:events";
import net from "node:net";
import { config } from "../config.js";

/**
 * Cliente mínimo de ClamAV (clamd) por TCP, sin dependencias. Se usa el comando INSTREAM: el archivo
 * viaja en bloques con su longitud y clamd responde «stream: OK» o «stream: <firma> FOUND».
 * Solo está activo si CLAMAV_HOST está definido (perfil «antivirus» de docker compose).
 */
export const antivirusEnabled = (): boolean => config.CLAMAV_HOST !== "";

export type ScanResult = { status: "clean" } | { status: "infected"; signature: string } | { status: "error"; message: string };

const CHUNK = 64 * 1024;

/** Bloques del protocolo INSTREAM: [longitud de 4 bytes (big endian) + datos]… y un bloque final de longitud 0. */
export function instreamFrames(data: Uint8Array, chunkSize = CHUNK): Buffer[] {
  const frames: Buffer[] = [];
  for (let i = 0; i < data.length; i += chunkSize) {
    const part = data.subarray(i, i + chunkSize);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(part.length);
    frames.push(head, Buffer.from(part.buffer, part.byteOffset, part.length));
  }
  frames.push(Buffer.alloc(4)); // longitud 0 = fin del archivo
  return frames;
}

/** Interpreta la respuesta de clamd (pura, para poder probarla). */
export function parseClamdReply(raw: string): ScanResult {
  const reply = raw.replace(/\0/g, "").trim();
  if (reply === "") return { status: "error", message: "clamd no respondió" };
  const found = /^stream:\s*(.+?)\s+FOUND$/i.exec(reply);
  if (found) return { status: "infected", signature: found[1]! };
  if (/^stream:\s*OK$/i.test(reply)) return { status: "clean" };
  return { status: "error", message: reply };
}

/** Abre una conexión a clamd, envía `frames` y devuelve la respuesta completa. */
function talk(frames: Buffer[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: config.CLAMAV_HOST, port: config.CLAMAV_PORT });
    let reply = "";
    let settled = false;
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(reply);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error("tiempo de espera agotado")));
    socket.on("error", (err) => finish(err));
    socket.on("data", (d) => (reply += d.toString("utf8")));
    socket.on("close", () => finish(null));
    socket.on("connect", () => {
      void (async () => {
        try {
          for (const f of frames) if (!socket.write(f)) await once(socket, "drain");
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
  });
}

/** Analiza un archivo en memoria. Nunca lanza: ante cualquier fallo devuelve `error`. */
export async function scanBuffer(data: Uint8Array): Promise<ScanResult> {
  try {
    const reply = await talk([Buffer.from("zINSTREAM\0"), ...instreamFrames(data)], config.CLAMAV_TIMEOUT_SECONDS * 1000);
    return parseClamdReply(reply);
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/** ¿Responde clamd? (para /api/health). Devuelve «ok» o el motivo. */
export async function pingAntivirus(): Promise<"ok" | string> {
  try {
    const reply = (await talk([Buffer.from("zPING\0")], 3000)).replace(/\0/g, "").trim();
    return reply === "PONG" ? "ok" : `respuesta inesperada: ${reply}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
