import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { uniqueZipName, zipStream, type ZipEntry } from "../src/lib/zipStream.js";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const c of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(c);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

describe("zipStream", () => {
  it("arma un ZIP válido con archivos comprimidos y sin comprimir, también con acentos en el nombre", async () => {
    const entries: ZipEntry[] = [
      { name: "datos.json", data: async () => '{"a":1}', compress: true },
      { name: "Contratos/Muñoz Pérez.pdf", data: async () => new Uint8Array([37, 80, 68, 70]) },
    ];
    const files = unzipSync(await readAll(zipStream(entries)));
    expect(strFromU8(files["datos.json"]!)).toBe('{"a":1}');
    expect([...files["Contratos/Muñoz Pérez.pdf"]!]).toEqual([37, 80, 68, 70]);
  });

  it("un archivo que no se puede leer deja una nota y no corta el resto", async () => {
    async function* entries(): AsyncGenerator<ZipEntry> {
      yield { name: "falta.pdf", data: async () => Promise.reject(new Error("ENOENT")) };
      yield { name: "bien.txt", data: async () => "ok" };
    }
    const files = unzipSync(await readAll(zipStream(entries())));
    expect(Object.keys(files).sort()).toEqual(["bien.txt", "falta.pdf.no-encontrado.txt"]);
    expect(strFromU8(files["bien.txt"]!)).toBe("ok");
  });
});

describe("uniqueZipName", () => {
  it("no repite nombres y quita rutas y caracteres peligrosos", () => {
    const used = new Set<string>();
    expect(uniqueZipName(used, "General", "informe.pdf")).toBe("General/informe.pdf");
    expect(uniqueZipName(used, "General", "INFORME.pdf")).toBe("General/INFORME (2).pdf");
    expect(uniqueZipName(used, "", "../../etc/passwd")).toBe("__.._etc_passwd");
    expect(uniqueZipName(used, "a/b", "x:y.txt")).toBe("a_b/x_y.txt");
    expect(uniqueZipName(used, ["archivos", "Legal/Contratos"], "c.pdf")).toBe("archivos/Legal_Contratos/c.pdf");
  });
});
