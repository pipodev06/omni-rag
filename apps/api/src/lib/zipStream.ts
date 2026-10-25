import { Zip, ZipDeflate, ZipPassThrough } from "fflate";

/** Un archivo del ZIP. `data` se lee solo cuando le toca (un archivo en memoria a la vez). */
export interface ZipEntry {
  name: string;
  data: () => Promise<Uint8Array | string>;
  /** Comprimir (texto, JSON). Los PDF, Office e imágenes ya vienen comprimidos: se guardan tal cual. */
  compress?: boolean;
}

/**
 * ZIP en streaming para una respuesta HTTP. Lee y añade un archivo cada vez que el cliente pide más datos, así que una
 * exportación de varios GB no se carga entera en memoria (como mucho, un archivo y lo que aún no se ha enviado).
 */
export function zipStream(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>): ReadableStream<Uint8Array> {
  const it = Symbol.asyncIterator in entries ? entries[Symbol.asyncIterator]() : (entries as Iterable<ZipEntry>)[Symbol.iterator]();
  let zip: Zip;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      zip = new Zip((err, chunk, final) => {
        if (err) return controller.error(err);
        if (chunk.length) controller.enqueue(chunk);
        if (final) controller.close();
      });
    },
    async pull() {
      const next = await it.next();
      if (next.done) return zip.end();
      const entry = next.value;
      let name = entry.name;
      let raw: Uint8Array | string;
      try {
        raw = await entry.data();
      } catch {
        // Un archivo que falta en el disco no debe cortar la descarga entera: se deja una nota en su lugar.
        name = `${entry.name}.no-encontrado.txt`;
        raw = "No se pudo leer este archivo en el servidor. El resto del ZIP está completo.";
      }
      const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
      const file = entry.compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
      zip.add(file);
      file.push(bytes, true);
    },
    async cancel() {
      await it.return?.();
    },
  });
}

/** Nombre de archivo apto para un ZIP: sin rutas ni caracteres problemáticos, y sin repetir uno ya usado («informe (2).pdf»). */
export function uniqueZipName(used: Set<string>, folder: string | string[], filename: string): string {
  const clean = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/^\.+/, "_").trim().slice(0, 150) || "archivo";
  const name = clean(filename);
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  // Cada nivel de carpeta se limpia por separado: un «/» dentro del nombre de una colección no crea otra carpeta.
  const levels = (Array.isArray(folder) ? folder : [folder]).filter(Boolean).map(clean);
  const prefix = levels.length ? `${levels.join("/")}/` : "";
  let candidate = `${prefix}${name}`;
  for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `${prefix}${base} (${i})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

export const zipHeaders = (filename: string) => ({
  "content-type": "application/zip",
  "content-disposition": `attachment; filename="${filename}"`,
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
});
