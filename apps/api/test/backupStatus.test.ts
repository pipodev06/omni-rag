import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import "./env.js";
import { checkB2, checkBackups, checkOffsite } from "../src/lib/monitor.js";
import { readBackupInfo } from "../src/lib/backupStatus.js";

const made: string[] = [];
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "rag-bk-"));
  made.push(d);
  return d;
};
afterAll(() => Promise.all(made.map((d) => rm(d, { recursive: true, force: true }))));
const HOUR = 3_600_000;
const SQ = String.fromCharCode(39);

async function dump(dir: string, name: string, ageHours = 1, content = "x") {
  const file = join(dir, name);
  await writeFile(file, content);
  const t = new Date(Date.now() - ageHours * HOUR);
  await utimes(file, t, t);
}
const json = (dir: string, name: string, data: unknown) => writeFile(join(dir, name), JSON.stringify(data));

describe("readBackupInfo", () => {
  it("carpeta no montada: mounted=false y sin copias, pero sigue leyendo el estado de B2", async () => {
    const status = await tmp();
    await json(status, "b2.json", { ok: true, error: "" });
    const info = await readBackupInfo(join(status, "no-existe"), status);
    expect(info).toMatchObject({ mounted: false, copies: [], totalBytes: 0, failed: 0, local: null, targets: null });
    expect(info.b2).toMatchObject({ ok: true });
  });

  it("carpeta vacía: montada, sin copias y sin estado", async () => {
    const dir = await tmp();
    const info = await readBackupInfo(dir, dir);
    expect(info).toMatchObject({ mounted: true, copies: [], totalBytes: 0, failed: 0, local: null, b2: null, targets: null });
  });

  it("lista las copias de la más reciente a la más antigua con el tamaño del volcado y de las subidas", async () => {
    const dir = await tmp();
    await dump(dir, "db_2026-11-01_0300.dump", 72, "1234567890");
    await dump(dir, "db_2026-11-03_0300.dump", 24, "12345");
    await dump(dir, "uploads_2026-11-03_0300.tgz", 24, "123");
    await dump(dir, "uploads_2026-11-01_0300.tgz", 72, "12");
    await dump(dir, "otra-cosa.txt", 1, "no cuenta");
    const info = await readBackupInfo(dir, dir);
    expect(info.copies.map((c) => c.stamp)).toEqual(["2026-11-03_0300", "2026-11-01_0300"]);
    expect(info.copies[0]).toMatchObject({ dbBytes: 5, uploadsBytes: 3 });
    expect(info.copies[1]).toMatchObject({ dbBytes: 10, uploadsBytes: 2 });
    expect(info.totalBytes).toBe(5 + 3 + 10 + 2);
  });

  it("una copia sin archivo de subidas lleva uploadsBytes null", async () => {
    const dir = await tmp();
    await dump(dir, "db_2026-11-03_0300.dump");
    expect((await readBackupInfo(dir, dir)).copies[0]!.uploadsBytes).toBeNull();
  });

  it("cuenta las .dump.fallida aparte y no las lista como copias", async () => {
    const dir = await tmp();
    await dump(dir, "db_2026-11-03_0300.dump.fallida");
    await dump(dir, "db_2026-11-02_0300.dump.fallida");
    await dump(dir, "db_2026-11-01_0300.dump");
    const info = await readBackupInfo(dir, dir);
    expect(info.failed).toBe(2);
    expect(info.copies).toHaveLength(1);
  });

  it("no pasa de 30 copias en la lista", async () => {
    const dir = await tmp();
    for (let i = 1; i <= 35; i++) await dump(dir, `db_2026-10-${String(i).padStart(2, "0")}_0300.dump`, i);
    const info = await readBackupInfo(dir, dir);
    expect(info.copies).toHaveLength(30);
  });

  it("lee .estado.json, .destinos.json y b2.json; un JSON a medias o vacío cuenta como ausente", async () => {
    const dir = await tmp();
    const status = await tmp();
    await json(dir, ".estado.json", { ok: false, error: "x", offsiteError: "el destino externo no está conectado" });
    await json(dir, ".destinos.json", { root: "/targets", available: true, dirs: [{ path: "usb1/omni", sameDisk: false, freeBytes: 5, writable: true }] });
    await writeFile(join(status, "b2.json"), "{ \"ok\": tru");
    const info = await readBackupInfo(dir, status);
    expect(info.local).toMatchObject({ ok: false, offsiteError: "el destino externo no está conectado" });
    expect(info.targets?.dirs[0]).toMatchObject({ path: "usb1/omni", sameDisk: false });
    expect(info.b2).toBeNull();
    await writeFile(join(dir, ".estado.json"), "");
    expect((await readBackupInfo(dir, status)).local).toBeNull();
  });
});

describe("writeBackupConfig (b2.env para los scripts)", () => {
  // Los ajustes se simulan: aquí se prueba el formato del archivo, no el catálogo.
  async function withSettings(pairs: [string, string][], b2 = true) {
    vi.resetModules();
    vi.doMock("../src/lib/settings.js", () => ({ backupSettingsForScripts: () => pairs, b2Configured: () => b2 }));
    return import("../src/lib/backupStatus.js");
  }
  afterEach(() => vi.doUnmock("../src/lib/settings.js"));
  const hasSh = (() => {
    try {
      execFileSync("sh", ["-c", "exit 0"]);
      return true;
    } catch {
      return false;
    }
  })();
  const sourced = (file: string, vars: string[]) =>
    vars.map((v) => execFileSync("sh", ["-c", `. "$0"; printf %s "$${v}"`, file.replaceAll("\\", "/")], { encoding: "utf8" }));

  it("no hace nada si la carpeta no existe (no está montada) y no la crea", async () => {
    const base = await tmp();
    const { writeBackupConfig } = await withSettings([["B2_BUCKET", "x"]]);
    await expect(writeBackupConfig(join(base, "no-existe"))).resolves.toBeUndefined();
    expect(await readdir(base)).toEqual([]);
  });

  it("escribe una línea export por ajuste, sin dejar el archivo temporal", async () => {
    const dir = await tmp();
    const { writeBackupConfig } = await withSettings([["B2_BUCKET", "mi-bucket"], ["BACKUP_DESTINATION", ""]]);
    await writeBackupConfig(dir);
    expect(await readFile(join(dir, "b2.env"), "utf8")).toBe(`export B2_BUCKET=${SQ}mi-bucket${SQ}\nexport BACKUP_DESTINATION=${SQ}${SQ}\n`);
    expect(await readdir(dir)).toEqual(["b2.env"]);
  });

  it.skipIf(process.platform === "win32")("el archivo queda con permisos 0600 (lleva claves en claro)", async () => {
    const dir = await tmp();
    const { writeBackupConfig } = await withSettings([["B2_APPLICATION_KEY", "secreta"]]);
    await writeBackupConfig(dir);
    expect((await stat(join(dir, "b2.env"))).mode & 0o777).toBe(0o600);
  });

  it("si el contenido no cambió no reescribe el archivo, y si cambió sí", async () => {
    const dir = await tmp();
    const { writeBackupConfig } = await withSettings([["B2_BUCKET", "a"]]);
    await writeBackupConfig(dir);
    const old = new Date(Date.now() - 10 * HOUR);
    await utimes(join(dir, "b2.env"), old, old);
    await writeBackupConfig(dir);
    expect(Math.abs((await stat(join(dir, "b2.env"))).mtimeMs - old.getTime())).toBeLessThan(2000);
    const { writeBackupConfig: again } = await withSettings([["B2_BUCKET", "b"]]);
    await again(dir);
    expect(await readFile(join(dir, "b2.env"), "utf8")).toContain(`${SQ}b${SQ}`);
  });

  it("las comillas simples se escapan como comilla-barra-comilla-comilla", async () => {
    const dir = await tmp();
    const { writeBackupConfig } = await withSettings([["B2_APPLICATION_KEY", `a${SQ}b${SQ}${SQ}c`]]);
    await writeBackupConfig(dir);
    const esc = `${SQ}\\${SQ}${SQ}`;
    expect(await readFile(join(dir, "b2.env"), "utf8")).toBe(`export B2_APPLICATION_KEY=${SQ}a${esc}b${esc}${esc}c${SQ}\n`);
  });

  it.skipIf(!hasSh)("el shell recupera exactamente el valor, aunque lleve comillas, espacios, $, comandos o saltos de línea", async () => {
    const dir = await tmp();
    const nasty = `p${SQ}a"s s$HOME $(echo pwned) ; rm -rf x \\n fin`;
    const { writeBackupConfig } = await withSettings([["B2_APPLICATION_KEY", nasty], ["B2_KEY_ID", "linea1\nlinea2"], ["B2_BUCKET", ""]]);
    await writeBackupConfig(dir);
    const [key, id, bucket] = sourced(join(dir, "b2.env"), ["B2_APPLICATION_KEY", "B2_KEY_ID", "B2_BUCKET"]);
    expect(key).toBe(nasty);
    expect(id).toBe("linea1\nlinea2");
    expect(bucket).toBe("");
  });

  it("sin bucket o sin las dos claves de B2 no escribe nada y borra el archivo que hubiera", async () => {
    const dir = await tmp();
    const configured = await withSettings([["B2_BUCKET", "z"]]);
    await configured.writeBackupConfig(dir);
    expect(await readdir(dir)).toEqual(["b2.env"]);
    const off = await withSettings([["B2_BUCKET", "z"], ["B2_APPLICATION_KEY", "secreta"]], false);
    await off.writeBackupConfig(dir);
    expect(await readdir(dir)).toEqual([]);
    await off.writeBackupConfig(dir);
    expect(await readdir(dir)).toEqual([]);
  });

  it("convive con otras carpetas dentro del directorio de configuración", async () => {
    const dir = await tmp();
    await mkdir(join(dir, "sub"));
    const { writeBackupConfig } = await withSettings([["B2_BUCKET", "z"]]);
    await writeBackupConfig(dir);
    expect((await readdir(dir)).sort()).toEqual(["b2.env", "sub"]);
  });
});

describe("monitor: copias locales", () => {
  it("avisa si la última copia falló aunque haya un volcado reciente", async () => {
    const dir = await tmp();
    await dump(dir, "db_2026-11-04_0300.dump", 2);
    await json(dir, ".estado.json", { ok: false, error: "pg_dump no pudo volcar la base de datos" });
    const p = await checkBackups(dir);
    expect(p?.key).toBe("backup");
    expect(p?.message).toContain("pg_dump no pudo volcar");
  });

  it("no avisa con ok=true, sin estado o con un estado ilegible", async () => {
    const dir = await tmp();
    await dump(dir, "db_2026-11-04_0300.dump", 2);
    expect(await checkBackups(dir)).toBeNull();
    await json(dir, ".estado.json", { ok: true, error: "" });
    expect(await checkBackups(dir)).toBeNull();
    await writeFile(join(dir, ".estado.json"), "{no es json");
    expect(await checkBackups(dir)).toBeNull();
  });

  it("una copia .dump.fallida no cuenta como copia reciente", async () => {
    const dir = await tmp();
    await dump(dir, "db_2026-11-04_0300.dump.fallida", 1);
    const p = await checkBackups(dir);
    expect(p?.key).toBe("backup");
    expect(p?.message).toContain("No hay ninguna copia");
  });

  it("el borde del umbral: por debajo de 36 h no avisa, por encima sí", async () => {
    const dir = await tmp();
    await dump(dir, "db_2026-11-02_0300.dump", 35);
    expect(await checkBackups(dir)).toBeNull();
    const dir2 = await tmp();
    await dump(dir2, "db_2026-11-02_0300.dump", 37);
    expect((await checkBackups(dir2))?.message).toContain("máximo 36");
  });

  it("recién encendido: una copia antigua espera una hora (la del arranque está en camino); después sí avisa", async () => {
    const dir = await tmp();
    await dump(dir, "db_2026-10-28_0300.dump", 24 * 7);
    expect(await checkBackups(dir, Date.now(), 120)).toMatchObject({ key: "backup", hold: true });
    expect(await checkBackups(dir, Date.now(), 2 * 3600)).toMatchObject({ key: "backup", hold: false });
  });

  it("recién encendido: si la copia del arranque falla, avisa al momento con el error", async () => {
    const dir = await tmp();
    await dump(dir, "db_2026-10-28_0300.dump", 24 * 7);
    await json(dir, ".estado.json", { attemptAt: new Date().toISOString(), ok: false, error: "disco lleno" });
    const p = await checkBackups(dir, Date.now(), 300);
    expect(p?.hold).toBeUndefined();
    expect(p?.message).toContain("disco lleno");
  });
});

describe("monitor: Backblaze B2", () => {
  const status = (over: Record<string, unknown>) => ({ checkedAt: new Date().toISOString(), ok: false, error: "faltan los datos de Backblaze: B2_BUCKET", lastOkAt: "", at: "", intervalHours: 6, nextAt: "", syncUploads: false, keepDays: 30, ...over });
  const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString();

  it("avisa con un fallo reciente", async () => {
    const dir = await tmp();
    await json(dir, "b2.json", status({ checkedAt: ago(1) }));
    const p = await checkB2(dir, Date.now(), true);
    expect(p?.key).toBe("backup-b2");
    expect(p?.message).toContain("faltan los datos");
  });

  it("no avisa con un estado viejo (backup-b2 parado): 26 h con hora fija, 2 ciclos sin ella", async () => {
    const dir = await tmp();
    await json(dir, "b2.json", status({ checkedAt: ago(27), at: "04:00" }));
    expect(await checkB2(dir, Date.now(), true)).toBeNull();
    await json(dir, "b2.json", status({ checkedAt: ago(25), at: "04:00" }));
    expect((await checkB2(dir, Date.now(), true))?.key).toBe("backup-b2");
    // Sin hora fija y cada 24 h: el margen es de 48 h.
    await json(dir, "b2.json", status({ checkedAt: ago(30), intervalHours: 24 }));
    expect((await checkB2(dir, Date.now(), true))?.key).toBe("backup-b2");
    await json(dir, "b2.json", status({ checkedAt: ago(49), intervalHours: 24 }));
    expect(await checkB2(dir, Date.now(), true)).toBeNull();
  });

  it("sin bucket ni claves B2 es opcional: no avisa aunque el estado diga que faltan los datos", async () => {
    const dir = await tmp();
    await json(dir, "b2.json", status({ checkedAt: ago(1) }));
    expect(await checkB2(dir, Date.now(), false)).toBeNull();
  });

  it("no avisa con ok=true ni sin archivo", async () => {
    const dir = await tmp();
    expect(await checkB2(dir, Date.now(), true)).toBeNull();
    await json(dir, "b2.json", status({ ok: true, error: "" }));
    expect(await checkB2(dir, Date.now(), true)).toBeNull();
  });
});

describe("monitor: copia externa (backup-offsite)", () => {
  it("avisa con el texto del error cuando el destino no está conectado", async () => {
    const dir = await tmp();
    await json(dir, ".estado.json", { ok: true, error: "", offsiteError: "el destino externo no está conectado: no existe /targets/usb1/omni" });
    const p = await checkOffsite(dir);
    expect(p?.key).toBe("backup-offsite");
    expect(p?.message).toContain("no existe /targets/usb1/omni");
  });

  it("no avisa con offsiteError vacío, ausente, sin estado o sin carpeta", async () => {
    const dir = await tmp();
    expect(await checkOffsite(dir)).toBeNull();
    await json(dir, ".estado.json", { ok: true, error: "" });
    expect(await checkOffsite(dir)).toBeNull();
    await json(dir, ".estado.json", { ok: true, error: "", offsiteError: "" });
    expect(await checkOffsite(dir)).toBeNull();
    expect(await checkOffsite(join(dir, "no-existe"))).toBeNull();
  });
});

