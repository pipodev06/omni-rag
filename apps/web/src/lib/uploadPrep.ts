/**
 * Prepara lo que el usuario arrastra o elige para subirlo: abre los ZIP en el navegador (el servidor nunca recibe un ZIP,
 * así que no hay riesgo de «bombas ZIP» en él), descarta lo que no se puede procesar y reparte los archivos en tandas
 * pequeñas: Cloudflare corta las peticiones de más de 100 MB y la API limita las subidas por minuto.
 */
export const MAX_FILES = 500;
const MAX_ZIP_ENTRIES = 500;
const MAX_UNZIPPED_BYTES = 1024 ** 3; // 1 GB entre todos los ZIP
export const BATCH_BYTES = 90 * 1024 ** 2;
export const BATCH_FILES = 20;

export interface Prepared {
  files: File[];
  /** Lo que no se va a subir y por qué («nombre: motivo»). */
  skipped: string[];
}

const extension = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
};
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
/** Archivos de sistema que no son documentos: carpetas __MACOSX de macOS, ocultos (.DS_Store), temporales de Office (~$). */
const isJunk = (path: string) => /(^|[\\/])(__MACOSX|\.)/.test(path) || baseName(path).startsWith("~$") || /thumbs\.db$/i.test(path);

export async function expandUploads(input: File[], extensions: string[]): Promise<Prepared> {
  const allowed = new Set(extensions.map((e) => e.toLowerCase()));
  const files: File[] = [];
  const skipped: string[] = [];
  let unzipped = 0;

  for (const file of input) {
    const name = file.webkitRelativePath || file.name;
    if (isJunk(name)) continue;
    if (extension(file.name) !== ".zip") {
      if (allowed.size === 0 || allowed.has(extension(file.name))) files.push(file);
      else skipped.push(`${file.name}: formato no admitido`);
      continue;
    }
    // La librería se descarga solo al abrir el primer ZIP.
    const { unzipSync } = await import("fflate");
    let entries: Record<string, Uint8Array>;
    try {
      let count = 0;
      entries = unzipSync(new Uint8Array(await file.arrayBuffer()), {
        filter: (entry) => {
          if (entry.name.endsWith("/") || isJunk(entry.name)) return false;
          const ext = extension(entry.name);
          if (ext === ".zip") {
            skipped.push(`${file.name} → ${baseName(entry.name)}: no se abren ZIP dentro de otro ZIP`);
            return false;
          }
          if (allowed.size > 0 && !allowed.has(ext)) {
            skipped.push(`${file.name} → ${baseName(entry.name)}: formato no admitido`);
            return false;
          }
          if (++count > MAX_ZIP_ENTRIES) return false;
          unzipped += entry.originalSize;
          return unzipped <= MAX_UNZIPPED_BYTES;
        },
      });
      if (count > MAX_ZIP_ENTRIES) skipped.push(`${file.name}: tiene más de ${MAX_ZIP_ENTRIES} archivos; solo se suben los primeros`);
      if (unzipped > MAX_UNZIPPED_BYTES) skipped.push(`${file.name}: pasa de 1 GB descomprimido; se omitió lo que no cabe`);
    } catch {
      skipped.push(`${file.name}: el ZIP está dañado o protegido con contraseña`);
      continue;
    }
    for (const [path, data] of Object.entries(entries)) {
      files.push(new File([data as Uint8Array<ArrayBuffer>], baseName(path), { lastModified: file.lastModified }));
    }
  }

  if (files.length > MAX_FILES) {
    skipped.push(`Se suben como máximo ${MAX_FILES} archivos a la vez; se omitieron ${files.length - MAX_FILES}`);
    files.length = MAX_FILES;
  }
  return { files, skipped };
}

/** Reparte los archivos en tandas de hasta 20 archivos y 90 MB (un archivo más grande va solo en su tanda). */
export function batches(files: File[], maxBytes = BATCH_BYTES, maxFiles = BATCH_FILES): File[][] {
  const out: File[][] = [];
  let current: File[] = [];
  let bytes = 0;
  for (const f of files) {
    if (current.length > 0 && (current.length >= maxFiles || bytes + f.size > maxBytes)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(f);
    bytes += f.size;
  }
  if (current.length > 0) out.push(current);
  return out;
}
