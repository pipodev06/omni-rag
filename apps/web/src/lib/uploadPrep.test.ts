import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { batches, expandUploads } from "./uploadPrep";

const EXT = [".pdf", ".docx", ".txt"];
const file = (name: string, data: Uint8Array | string = "x") => new File([(typeof data === "string" ? strToU8(data) : data) as Uint8Array<ArrayBuffer>], name);

describe("expandUploads", () => {
  it("abre los ZIP y se queda con los documentos, sin carpetas, archivos de sistema ni ZIP anidados", async () => {
    const zip = zipSync({
      "Contratos/contrato.pdf": strToU8("%PDF-1"),
      "Contratos/notas.txt": strToU8("hola"),
      "__MACOSX/Contratos/._contrato.pdf": strToU8("basura"),
      ".DS_Store": strToU8("basura"),
      "fotos/foto.exe": strToU8("MZ"),
      "otro.zip": zipSync({ "a.txt": strToU8("a") }),
    });
    const { files, skipped } = await expandUploads([file("lote.zip", zip), file("suelto.docx")], EXT);
    expect(files.map((f) => f.name).sort()).toEqual(["contrato.pdf", "notas.txt", "suelto.docx"]);
    expect(skipped.some((s) => s.includes("foto.exe") && s.includes("formato no admitido"))).toBe(true);
    expect(skipped.some((s) => s.includes("otro.zip") && s.includes("ZIP dentro de otro ZIP"))).toBe(true);
  });

  it("avisa de un ZIP dañado y de los formatos que no se procesan", async () => {
    const { files, skipped } = await expandUploads([file("roto.zip", "no es un zip"), file("programa.exe")], EXT);
    expect(files).toEqual([]);
    expect(skipped).toEqual(["roto.zip: el ZIP está dañado o protegido con contraseña", "programa.exe: formato no admitido"]);
  });
});

describe("batches", () => {
  it("reparte por número de archivos y por tamaño; un archivo grande va solo", () => {
    const f = (size: number) => new File([new Uint8Array(size)], "a.pdf");
    expect(batches([f(1), f(1), f(1)], 100, 2).map((b) => b.length)).toEqual([2, 1]);
    expect(batches([f(60), f(60), f(200), f(10)], 100, 20).map((b) => b.length)).toEqual([1, 1, 1, 1]);
    expect(batches([f(30), f(30), f(30)], 100, 20).map((b) => b.length)).toEqual([3]);
  });
});
