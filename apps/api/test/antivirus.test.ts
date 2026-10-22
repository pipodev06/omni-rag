import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "./env.js";
import { config } from "../src/config.js";
import { antivirusEnabled, instreamFrames, parseClamdReply, pingAntivirus, scanBuffer } from "../src/lib/antivirus.js";

describe("respuestas de clamd", () => {
  it("limpio", () => {
    expect(parseClamdReply("stream: OK\0")).toEqual({ status: "clean" });
  });
  it("infectado: devuelve la firma", () => {
    expect(parseClamdReply("stream: Win.Test.EICAR_HDB-1 FOUND\0")).toEqual({ status: "infected", signature: "Win.Test.EICAR_HDB-1" });
    expect(parseClamdReply("stream: Eicar-Test-Signature FOUND\n")).toEqual({ status: "infected", signature: "Eicar-Test-Signature" });
  });
  it("errores y respuestas vacías no se confunden con «limpio»", () => {
    expect(parseClamdReply("INSTREAM size limit exceeded. ERROR\0").status).toBe("error");
    expect(parseClamdReply("").status).toBe("error");
    expect(parseClamdReply("cualquier otra cosa").status).toBe("error");
  });
});

describe("protocolo INSTREAM", () => {
  it("parte el archivo en bloques con su longitud y termina con un bloque vacío", () => {
    const frames = instreamFrames(new Uint8Array(150), 64);
    // 64 + 64 + 22 bytes, cada uno con su cabecera de 4 bytes, y la cabecera final en cero.
    expect(frames).toHaveLength(7);
    expect(frames[0]!.readUInt32BE()).toBe(64);
    expect(frames[2]!.readUInt32BE()).toBe(64);
    expect(frames[4]!.readUInt32BE()).toBe(22);
    expect(frames[6]!.readUInt32BE()).toBe(0);
    expect(frames[1]!.length + frames[3]!.length + frames[5]!.length).toBe(150);
  });
  it("un archivo vacío solo envía el bloque final", () => {
    expect(instreamFrames(new Uint8Array(0))).toHaveLength(1);
  });
});

/** clamd de mentira: entiende zINSTREAM y zPING; marca como infectado lo que contenga «MARCA-DE-VIRUS». */
function fakeClamd() {
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.toString().startsWith("zPING")) {
        socket.end("PONG\0");
        return;
      }
      const head = "zINSTREAM\0";
      if (!buf.toString("latin1").startsWith(head)) return;
      let off = head.length;
      const parts: Buffer[] = [];
      while (buf.length >= off + 4) {
        const len = buf.readUInt32BE(off);
        if (len === 0) {
          socket.end(Buffer.concat(parts).includes("MARCA-DE-VIRUS") ? "stream: Fake.Virus-1 FOUND\0" : "stream: OK\0");
          return;
        }
        if (buf.length < off + 4 + len) return;
        parts.push(buf.subarray(off + 4, off + 4 + len));
        off += 4 + len;
      }
    });
  });
  return server;
}

describe("scanBuffer contra un clamd de prueba", () => {
  const server = fakeClamd();
  const original = { host: config.CLAMAV_HOST, port: config.CLAMAV_PORT };

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    Object.assign(config, { CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: (server.address() as net.AddressInfo).port });
  });
  afterAll(() => {
    Object.assign(config, { CLAMAV_HOST: original.host, CLAMAV_PORT: original.port });
    server.close();
  });

  it("está activo solo si hay host", () => {
    expect(antivirusEnabled()).toBe(true);
  });
  it("archivo limpio", async () => {
    expect(await scanBuffer(Buffer.from("un documento normal"))).toEqual({ status: "clean" });
  });
  it("archivo infectado", async () => {
    expect(await scanBuffer(Buffer.from("texto MARCA-DE-VIRUS más texto"))).toEqual({ status: "infected", signature: "Fake.Virus-1" });
  });
  it("archivo grande (varios bloques) en el que la marca queda a mitad", async () => {
    const big = Buffer.concat([Buffer.alloc(300_000, 65), Buffer.from("MARCA-DE-VIRUS"), Buffer.alloc(300_000, 66)]);
    expect((await scanBuffer(big)).status).toBe("infected");
  });
  it("ping", async () => {
    expect(await pingAntivirus()).toBe("ok");
  });
});

describe("si el antivirus no está disponible", () => {
  it("scanBuffer devuelve error (no «limpio») para que la subida se rechace", async () => {
    const original = { host: config.CLAMAV_HOST, port: config.CLAMAV_PORT };
    Object.assign(config, { CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: 1 }); // puerto cerrado
    try {
      const r = await scanBuffer(Buffer.from("x"));
      expect(r.status).toBe("error");
      expect(await pingAntivirus()).not.toBe("ok");
    } finally {
      Object.assign(config, { CLAMAV_HOST: original.host, CLAMAV_PORT: original.port });
    }
  });
});
