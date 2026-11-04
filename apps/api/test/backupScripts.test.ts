import { execFile, execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * deploy/backup.sh y deploy/b2-sync.sh con psql, pg_dump, pg_restore y rclone falsos. Los scripts apuntan a rutas fijas
 * del contenedor (/backups, /targets, /offsite...): se copian a una carpeta temporal cambiando esas rutas por las de
 * la prueba (y el arnés falla si queda alguna sin cambiar, para no tocar nunca el sistema real). Necesita `sh` con las
 * herramientas GNU (stat -c, find -mindepth, df, date -d): Linux, o Git Bash en Windows. Si falta, se salta entero.
 */
// QA_DEPLOY_DIR permite probar una copia modificada de los scripts (pruebas de mutación).
const DEPLOY = process.env.QA_DEPLOY_DIR ?? fileURLToPath(new URL("../../../deploy/", import.meta.url));

const hasGnuSh = (() => {
  try {
    execFileSync("sh", ["-c", "stat -c %d . >/dev/null && find . -mindepth 1 -maxdepth 1 >/dev/null && date -Iseconds >/dev/null && sleep 0.1"], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
})();

const toPosix = (p: string) => (process.platform === "win32" ? p.replace(/^([A-Za-z]):[\\/]/, (_m, d: string) => `/${d.toLowerCase()}/`).replaceAll("\\", "/") : p);
const STRIP_STUBS = "PATH=$" + "{PATH#*:}"; // quita la carpeta de stubs (primer elemento) para llamar a la herramienta real
const SQ = String.fromCharCode(39);

const STUBS: Record<string, string> = {
  psql: [
    'echo "psql $*" >> "$STUB_LOG"',
    'case "$*" in',
    '  *"INSERT INTO settings"*) [ -z "$STUB_PSQL_INSERT_FAIL" ] || exit 1; exit 0 ;;',
    '  *"FROM settings"*) [ ! -f "$STUB_SETTINGS" ] || cat "$STUB_SETTINGS"; exit 0 ;;',
    '  *"count(*)"*) echo "1, 2, 3"; exit 0 ;;',
    "esac",
    "exit 0",
  ].join("\n"),
  pg_dump: [
    '[ -z "$STUB_PGDUMP_FAIL" ] || { echo "pg_dump: error simulado" >&2; exit 1; }',
    'out=""',
    'while [ $# -gt 0 ]; do case "$1" in -f) out="$2"; shift ;; esac; shift; done',
    "printf DUMP > \"$out\"",
  ].join("\n"),
  pg_restore: '[ -z "$STUB_RESTORE_FAIL" ] || { echo "pg_restore: error simulado" >&2; exit 1; }\nexit 0',
  createdb: "exit 0",
  dropdb: "exit 0",
  pg_isready: "exit 0",
  rclone: [
    'echo "rclone $*" >> "$STUB_LOG"',
    'echo "ACCOUNT=$RCLONE_CONFIG_B2_ACCOUNT KEY=$RCLONE_CONFIG_B2_KEY" >> "$STUB_LOG"',
    '[ -z "$STUB_RCLONE_FAIL" ] || exit 1',
    '[ "$1" != "obscure" ] || { echo "obscure-stdin=$(cat)" >> "$STUB_LOG"; echo obscured; exit 0; }',
    "exit 0",
  ].join("\n"),
  timeout: 'echo "timeout $*" >> "$STUB_LOG"\nshift\nexec "$@"',
  sleep: `${STRIP_STUBS}\nexec sleep 0.2`,
  cmp: `[ -z "$STUB_CMP_FAIL" ] || exit 1\n${STRIP_STUBS}\nexec cmp "$@"`,
  cp: `[ -z "$STUB_CP_FAIL" ] || exit 1\n${STRIP_STUBS}\nexec cp "$@"`,
  df: [
    '[ -z "$STUB_DF_FREE_KB" ] || { echo "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "x 1 1 $STUB_DF_FREE_KB 1% /"; exit 0; }',
    STRIP_STUBS,
    'exec df "$@"',
  ].join("\n"),
};

/** Cambia las rutas fijas del contenedor por las de la prueba; falla si queda alguna (así nunca se toca el sistema real). */
function localize(text: string, px: string): string {
  const out = text.replaceAll("\r\n", "\n").replace(/([=" >])\/(backups|targets|offsite|uploads|status|backup-config|tmp)(?![A-Za-z0-9_-])/g, (_m, pre: string, name: string) => `${pre}${px}/${name}`);
  const left = out.replaceAll(`${px}/`, "PX/").match(/[=" >]\/(backups|targets|offsite|uploads|status|backup-config|tmp)\b/);
  if (left) throw new Error(`el script aún apunta a ${left[0]}: actualiza el arnés de prueba`);
  return out;
}

interface Result {
  code: number | null;
  out: string;
}

class Sandbox {
  readonly px: string;
  constructor(readonly root: string) {
    this.px = toPosix(root);
  }
  p = (...parts: string[]) => join(this.root, ...parts);

  env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k.toUpperCase() === "PATH" || /^(BACKUP_|B2_|RCLONE_|STUB_)/.test(k)) continue;
      env[k] = v;
    }
    env.PATH = `${this.p("bin")}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
    env.STUB_LOG = `${this.px}/stub.log`;
    env.STUB_SETTINGS = `${this.px}/settings.tsv`;
    return { ...env, ...extra };
  }

  run(file: string, args: string[], extra: Record<string, string> = {}): Promise<Result> {
    return new Promise((resolve) => {
      execFile("sh", [`${this.px}/${file}`, ...args], { cwd: this.root, env: this.env(extra), timeout: 60_000, encoding: "utf8" }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, out: `${stdout}${stderr}` });
      });
    });
  }

  /** Ejecuta do_destination() de backup.sh (sin su bucle) con la ruta y la opción de mover; devuelve «ok|mensaje». */
  dest(path: string, move: boolean, extra: Record<string, string> = {}, pre = ""): Promise<{ ok: boolean; msg: string }> {
    const script = `cd "${this.px}"\n. "${this.px}/backup-lib.sh"\n${pre}\ndo_destination "$QA_PATH" "$QA_MOVE" || true\nprintf 'RESULT:%s|%s\\n' "$REQ_OK" "$REQ_MSG"`;
    return new Promise((resolve, reject) => {
      execFile("sh", ["-c", script], { cwd: this.root, env: this.env({ ...extra, QA_PATH: path, QA_MOVE: String(move) }), timeout: 60_000, encoding: "utf8" }, (err, stdout, stderr) => {
        const m = stdout.match(/RESULT:(true|false)\|(.*)/);
        if (!m) return reject(new Error(`sin resultado (${err?.message ?? ""}): ${stdout}${stderr}`));
        resolve({ ok: m[1] === "true", msg: m[2]! });
      });
    });
  }

  /** Carga las funciones de backup.sh (sin su bucle) y ejecuta `cmd`; devuelve la salida. */
  fn(cmd: string, extra: Record<string, string> = {}): Promise<Result> {
    return new Promise((resolve) => {
      execFile("sh", ["-c", `cd "${this.px}"\n. "${this.px}/backup-lib.sh"\n${cmd}`], { cwd: this.root, env: this.env(extra), timeout: 60_000, encoding: "utf8" }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, out: `${stdout}${stderr}` });
      });
    });
  }
  /** Hace «viejo» un archivo (fecha de modificación hace `days` días). */
  age = (rel: string, days: number) => utimes(this.p(...rel.split("/")), new Date(Date.now() - days * 86_400_000), new Date(Date.now() - days * 86_400_000));

  ls = (...parts: string[]) => readdir(this.p(...parts)).then((n) => n.sort());
  read = (...parts: string[]) => readFile(this.p(...parts), "utf8");
  json = async <T>(...parts: string[]) => JSON.parse(await this.read(...parts)) as T;
  exists = (...parts: string[]) => stat(this.p(...parts)).then(() => true, () => false);
  log = () => this.read("stub.log").catch(() => "");
  write = (rel: string, content: string) => mkdir(join(this.root, ...rel.split("/").slice(0, -1)), { recursive: true }).then(() => writeFile(this.p(...rel.split("/")), content));
  settings = (rows: Record<string, string>) => writeFile(this.p("settings.tsv"), Object.entries(rows).map(([k, v]) => `${k}\t${v}\n`).join(""));

  /** Todos los archivos (rutas relativas) bajo la carpeta de pruebas que cumplan el patrón, sin contar los scripts ni los stubs. */
  async find(re: RegExp, dir = this.root, rel = ""): Promise<string[]> {
    const found: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) found.push(...(await this.find(re, join(dir, e.name), r)));
      else if (re.test(e.name)) found.push(r);
    }
    return found.sort();
  }
}

const boxes: string[] = [];
async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "rag-sh-"));
  boxes.push(root);
  const sb = new Sandbox(root);
  for (const d of ["backups", "targets", "offsite", "uploads", "status", "config", "tmp", "bin"]) await mkdir(sb.p(d));
  for (const [name, body] of Object.entries(STUBS)) {
    await writeFile(sb.p("bin", name), `#!/bin/sh\n${body}\n`);
    await chmod(sb.p("bin", name), 0o755);
  }
  const backup = localize(await readFile(join(DEPLOY, "backup.sh"), "utf8"), sb.px);
  const cut = backup.indexOf("# --- Programación");
  if (cut < 0) throw new Error("backup.sh ya no tiene la sección «Programación»: actualiza el arnés de prueba");
  await writeFile(sb.p("backup.sh"), backup);
  await writeFile(sb.p("backup-lib.sh"), backup.slice(0, cut));
  await writeFile(sb.p("b2-sync.sh"), localize(await readFile(join(DEPLOY, "b2-sync.sh"), "utf8"), sb.px));
  return sb;
}

afterAll(async () => {
  await Promise.all(boxes.map((b) => rm(b, { recursive: true, force: true }).catch(() => {})));
});

const T = 90_000;
const dumps = (names: string[]) => names.filter((n) => /^db_.*\.dump$/.test(n));

interface LocalState {
  ok: boolean;
  error: string;
  offsiteError: string;
  destination: string;
  destDevice: string;
}

describe.concurrent("deploy/backup.sh --once (copia con pg_dump y rclone falsos)", { skip: !hasGnuSh }, () => {
  it("copia local y externa a la carpeta clásica; con archivos subidos hace el .tgz", async () => {
    const sb = await sandbox();
    await sb.write("uploads/doc.txt", "contenido");
    const r = await sb.run("backup.sh", ["--once"], { BACKUP_OFFSITE: "true", BACKUP_UPLOADS_TGZ: "true" });
    expect(r.code, r.out).toBe(0);
    const names = await sb.ls("backups");
    expect(dumps(names)).toHaveLength(1);
    expect(names.some((n) => /^uploads_.*\.tgz$/.test(n))).toBe(true);
    expect(dumps(await sb.ls("offsite"))).toHaveLength(1);
    const st = await sb.json<LocalState>("backups", ".estado.json");
    expect(st).toMatchObject({ ok: true, error: "", offsiteError: "" });
  }, T);

  it("destino conectado: la copia va a /targets/<ruta> y se anota el disco y la carpeta", async () => {
    const sb = await sandbox();
    await sb.write("targets/usb1/omni/.keep", "");
    await sb.settings({ BACKUP_DESTINATION: "usb1/omni" });
    const r = await sb.run("backup.sh", ["--once"], { BACKUP_OFFSITE: "true", BACKUP_UPLOADS_TGZ: "false" });
    expect(r.code, r.out).toBe(0);
    expect(dumps(await sb.ls("targets", "usb1", "omni"))).toHaveLength(1);
    expect(await sb.ls("offsite")).toEqual([]);
    const st = await sb.json<LocalState>("backups", ".estado.json");
    expect(st).toMatchObject({ ok: true, offsiteError: "", destination: "usb1/omni" });
    expect(st.destDevice).not.toBe("");
    const targets = await sb.json<{ root: string; available: boolean; dirs: { path: string; sameDisk: boolean; writable: boolean; freeBytes: number }[] }>("backups", ".destinos.json");
    expect(targets.available).toBe(true);
    expect(targets.dirs.find((d) => d.path === "usb1/omni")).toMatchObject({ sameDisk: true, writable: true });
  }, T);

  it("destino desconectado: no escribe en otro sitio, avisa con offsiteError y la copia local sigue", async () => {
    const sb = await sandbox();
    await sb.settings({ BACKUP_DESTINATION: "usb1/omni" });
    const r = await sb.run("backup.sh", ["--once"], { BACKUP_OFFSITE: "true", BACKUP_UPLOADS_TGZ: "false" });
    expect(r.code, r.out).toBe(0);
    expect(dumps(await sb.ls("backups"))).toHaveLength(1);
    expect(await sb.ls("targets")).toEqual([]);
    expect(await sb.ls("offsite")).toEqual([]);
    expect(await sb.find(/^db_/)).toEqual([expect.stringMatching(/^backups\/db_.*\.dump$/)]);
    const st = await sb.json<LocalState>("backups", ".estado.json");
    expect(st.offsiteError).toMatch(/el destino externo no está conectado/);
    expect(st.destination).toBe("usb1/omni");
    expect(r.out).toMatch(/no está conectado/);
  }, T);

  it("el disco del destino cambió desde la última vez (otro USB en la misma ruta): no copia", async () => {
    const sb = await sandbox();
    await sb.write("targets/usb1/omni/.keep", "");
    await sb.settings({ BACKUP_DESTINATION: "usb1/omni" });
    await writeFile(sb.p("backups", ".estado.json"), JSON.stringify({ destination: "usb1/omni", destDevice: "1" }));
    const r = await sb.run("backup.sh", ["--once"], { BACKUP_OFFSITE: "true", BACKUP_UPLOADS_TGZ: "false" });
    expect(r.code, r.out).toBe(0);
    expect(dumps(await sb.ls("targets", "usb1", "omni"))).toEqual([]);
    expect((await sb.json<LocalState>("backups", ".estado.json")).offsiteError).toMatch(/ya no está en el mismo disco/);
  }, T);

  it("sin copia externa activa no toca ningún destino", async () => {
    const sb = await sandbox();
    await sb.write("targets/usb1/omni/.keep", "");
    await sb.settings({ BACKUP_DESTINATION: "usb1/omni" });
    const r = await sb.run("backup.sh", ["--once"], { BACKUP_UPLOADS_TGZ: "false" });
    expect(r.code, r.out).toBe(0);
    expect(dumps(await sb.ls("targets", "usb1", "omni"))).toEqual([]);
    expect(await sb.ls("offsite")).toEqual([]);
  }, T);

  const BAD_PATHS = ["../x", "../../etc", "/etc", "a/../b", ".", "./x", "a/./b", "a;touch PWNED", "$" + "(touch PWNED)", "a" + SQ + "b", "a|b", "ñ"];
  it.each(BAD_PATHS)("destino no válido %j (desde la base): se avisa, se usa la carpeta clásica y no se ejecuta nada", async (bad) => {
    const sb = await sandbox();
    await sb.settings({ BACKUP_DESTINATION: bad });
    const r = await sb.run("backup.sh", ["--once"], { BACKUP_OFFSITE: "true", BACKUP_UPLOADS_TGZ: "false" });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/valor no válido en BACKUP_DESTINATION/);
    expect(await sb.ls("targets")).toEqual([]);
    expect(await sb.find(/PWNED/)).toEqual([]);
    expect(dumps(await sb.ls("offsite"))).toHaveLength(1);
    expect((await sb.json<LocalState>("backups", ".estado.json")).destination).toBe("");
  }, T);

  it("destino no válido en la variable de entorno: igual", async () => {
    const sb = await sandbox();
    const r = await sb.run("backup.sh", ["--once"], { BACKUP_OFFSITE: "true", BACKUP_UPLOADS_TGZ: "false", BACKUP_DESTINATION: "../../etc" });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/valor no válido en BACKUP_DESTINATION/);
    expect(await sb.ls("targets")).toEqual([]);
  }, T);

  it("valores numéricos o booleanos no válidos en la base usan el valor por defecto con aviso", async () => {
    const sb = await sandbox();
    await sb.settings({ BACKUP_KEEP_DAYS: "abc", BACKUP_INTERVAL_HOURS: "0", BACKUP_OFFSITE: "quizá", BACKUP_AT: "25:99", BACKUP_TZ: "x;y" });
    const r = await sb.run("backup.sh", ["--once"], { BACKUP_UPLOADS_TGZ: "false" });
    expect(r.code, r.out).toBe(0);
    for (const k of ["BACKUP_KEEP_DAYS", "BACKUP_INTERVAL_HOURS", "BACKUP_OFFSITE", "BACKUP_AT", "BACKUP_TZ"]) expect(r.out).toContain(`valor no válido en ${k}`);
    const st = await sb.json<{ keepDays: number; intervalHours: number; offsite: boolean; at: string }>("backups", ".estado.json");
    expect(st).toMatchObject({ keepDays: 7, intervalHours: 24, offsite: false, at: "" });
  }, T);

  it("pg_dump falla: sin db_*.dump, ni temporales, estado con error y sin copia externa", async () => {
    const sb = await sandbox();
    const r = await sb.run("backup.sh", ["--once"], { BACKUP_OFFSITE: "true", BACKUP_UPLOADS_TGZ: "false", STUB_PGDUMP_FAIL: "1" });
    expect(r.code).not.toBe(0);
    expect(await sb.find(/^db_/)).toEqual([]);
    expect((await sb.ls("backups")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    const st = await sb.json<LocalState>("backups", ".estado.json");
    expect(st.ok).toBe(false);
    expect(st.error).toMatch(/pg_dump no pudo/);
    expect(await sb.ls("offsite")).toEqual([]);
  }, T);

  it("la restauración de prueba falla: el volcado queda como .dump.fallida y no sale a la carpeta externa", async () => {
    const sb = await sandbox();
    const r = await sb.run("backup.sh", ["--once"], { BACKUP_OFFSITE: "true", BACKUP_UPLOADS_TGZ: "false", STUB_RESTORE_FAIL: "1" });
    expect(r.code).not.toBe(0);
    const names = await sb.ls("backups");
    expect(dumps(names)).toEqual([]);
    expect(names.filter((n) => n.endsWith(".dump.fallida"))).toHaveLength(1);
    expect(await sb.ls("offsite")).toEqual([]);
    expect(await sb.json<LocalState>("backups", ".estado.json")).toMatchObject({ ok: false });
  }, T);
});

describe.concurrent("deploy/backup.sh: retención, espacio, órdenes caducadas y escaneo de destinos", { skip: !hasGnuSh }, () => {
  it("la retención solo borra archivos con el nombre exacto de copia, en ./backups y en la carpeta externa", async () => {
    const sb = await sandbox();
    const old = ["db_2020-01-01_0300.dump", "db_2020-01-01_0300.dump.fallida", "uploads_2020-01-01_0300.tgz", "db_2020-01-01_0300.dump.enc", "uploads_2020-01-01_0300.tgz.enc"];
    const mine = ["db_clientes.xlsx", "uploads_viejo.tgz", "db_2020-01-01_0300.dump.bak", "notas.txt", "db_2020-1-1_0300.dump"];
    for (const dir of ["backups", "offsite"]) {
      for (const n of [...old, ...mine]) {
        await sb.write(`${dir}/${n}`, "x");
        await sb.age(`${dir}/${n}`, 400);
      }
    }
    // Una carpeta con nombre de copia no es un archivo: no se borra aunque sea vieja.
    await mkdir(sb.p("offsite", "db_2020-01-02_0300.dump"));
    const r = await sb.run("backup.sh", ["--once"], { BACKUP_OFFSITE: "true", BACKUP_UPLOADS_TGZ: "false" });
    expect(r.code, r.out).toBe(0);
    for (const dir of ["backups", "offsite"]) {
      const names = await sb.ls(dir);
      for (const n of old) expect(names, `${dir}/${n} debía borrarse`).not.toContain(n);
      for (const n of mine) expect(names, `${dir}/${n} no es nuestro: debía quedar`).toContain(n);
    }
    expect(await sb.exists("offsite", "db_2020-01-02_0300.dump")).toBe(true);
  }, T);

  it("sin espacio libre para el doble de la última copia: la copia falla con mensaje claro y no crea nada", async () => {
    const sb = await sandbox();
    await sb.write("backups/db_2026-11-01_0300.dump", "A".repeat(100_000));
    const r = await sb.run("backup.sh", ["--once"], { BACKUP_UPLOADS_TGZ: "false", STUB_DF_FREE_KB: "100" });
    expect(r.code).not.toBe(0);
    const st = await sb.json<LocalState>("backups", ".estado.json");
    expect(st.ok).toBe(false);
    expect(st.error).toMatch(/no hay espacio suficiente/);
    expect(dumps(await sb.ls("backups"))).toEqual(["db_2026-11-01_0300.dump"]);
    expect(await sb.log()).not.toMatch(/pg_dump/);
  }, T);

  it("con espacio de sobra (o sin copia previa) la copia se hace", async () => {
    const sb = await sandbox();
    await sb.write("backups/db_2026-11-01_0300.dump", "A".repeat(100_000));
    const r = await sb.run("backup.sh", ["--once"], { BACKUP_UPLOADS_TGZ: "false", STUB_DF_FREE_KB: "10000000" });
    expect(r.code, r.out).toBe(0);
    expect(dumps(await sb.ls("backups"))).toHaveLength(2);
  }, T);

  it("las órdenes sin empezar de más de 6 h se cierran como caducadas (ok=false)", async () => {
    const sb = await sandbox();
    const r = await sb.fn("process_requests");
    expect(r.code, r.out).toBe(0);
    expect(await sb.log()).toMatch(/UPDATE backup_requests SET finished_at = now\(\), ok = false, message = 'Caducada[^']*' WHERE started_at IS NULL AND finished_at IS NULL AND created_at < now\(\) - interval '6 hours'/);
  }, T);

  it("scan_targets: find, df y stat llevan «timeout 20»", async () => {
    const sb = await sandbox();
    await sb.write("targets/usb1/.keep", "");
    const r = await sb.fn("scan_targets");
    expect(r.code, r.out).toBe(0);
    const log = await sb.log();
    for (const cmd of ["find", "df", "stat"]) expect(log, cmd).toMatch(new RegExp(`timeout 20 ${cmd} `));
    expect((await sb.json<{ dirs: { path: string }[] }>("backups", ".destinos.json")).dirs.map((d) => d.path)).toEqual(["usb1"]);
  }, T);

  it("tick escanea los destinos como mucho cada 5 min", async () => {
    const sb = await sandbox();
    await sb.write("targets/usb1/.keep", "");
    const r = await sb.fn("tick; tick; tick");
    expect(r.code, r.out).toBe(0);
    expect(((await sb.log()).match(/timeout 20 find /g) ?? []).length).toBe(1);
    const again = await sb.fn("LAST_SCAN=$(( $(date +%s) - 301 )); tick");
    expect(again.code, again.out).toBe(0);
    expect(((await sb.log()).match(/timeout 20 find /g) ?? []).length).toBe(2);
  }, T);
});

describe.concurrent("deploy/backup.sh: orden «Cambiar destino» (do_destination)", { skip: !hasGnuSh }, () => {
  const COPIES = { "db_2026-11-01_0300.dump": "A".repeat(20), "uploads_2026-11-01_0300.tgz": "B".repeat(30) };

  async function withCopies(dir = "offsite") {
    const sb = await sandbox();
    await sb.write("targets/usb1/.keep", "");
    for (const [n, c] of Object.entries(COPIES)) await sb.write(`${dir}/${n}`, c);
    await sb.write(`${dir}/notas.txt`, "mío");
    await sb.write(`${dir}/db_2026-10-01_0300.dump.fallida`, "x");
    return sb;
  }
  const intact = async (sb: Sandbox, dir: string) => {
    for (const [n, c] of Object.entries(COPIES)) expect(await sb.read(dir, n), `${dir}/${n}`).toBe(c);
    expect(await sb.read(dir, "notas.txt")).toBe("mío");
  };
  const inserted = async (sb: Sandbox) => /INSERT INTO settings/.test(await sb.log());

  it.each(["../x", "/abs", ".", "a/../b", "a;b", "$" + "(id)", "a" + SQ + "b"])("ruta no válida %j: se rechaza sin crear nada", async (bad) => {
    const sb = await withCopies();
    const r = await sb.dest(bad, true);
    expect(r).toMatchObject({ ok: false });
    expect(r.msg).toMatch(/Ruta no válida/);
    expect(await sb.ls("targets")).toEqual(["usb1"]);
    expect(await sb.ls("targets", "usb1")).toEqual([".keep"]);
    expect(await inserted(sb)).toBe(false);
    await intact(sb, "offsite");
  }, T);

  it("si el destino está fijado en BACKUP_DESTINATION del entorno no se cambia", async () => {
    const sb = await withCopies();
    const r = await sb.dest("usb1/omni", false, { BACKUP_DESTINATION: "usb1/fijo" });
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/fijado con BACKUP_DESTINATION/);
    expect(await inserted(sb)).toBe(false);
  }, T);

  it("sin carpetas de destino (BACKUP_TARGETS_DIR sin definir) se rechaza con la explicación", async () => {
    const sb = await sandbox();
    const r = await sb.dest("usb1/omni", false);
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/No hay carpetas de destino disponibles/);
  }, T);

  it("si falta la carpeta superior (disco desconectado) no la inventa", async () => {
    const sb = await withCopies();
    const r = await sb.dest("nodisk/omni", false);
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/No se pudo crear la carpeta/);
    expect(await sb.ls("targets")).toEqual(["usb1"]);
    expect(await inserted(sb)).toBe(false);
  }, T);

  it("sin mover: crea la última carpeta, guarda el ajuste y deja las copias donde estaban", async () => {
    const sb = await withCopies();
    const r = await sb.dest("usb1/omni/", false);
    expect(r.ok, r.msg).toBe(true);
    expect(r.msg).toMatch(/Destino cambiado a usb1\/omni/);
    expect(r.msg).toMatch(/Copias movidas: 0/);
    expect(r.msg).toMatch(/mismo disco que el servidor/);
    expect(await sb.ls("targets", "usb1", "omni")).toEqual([]);
    await intact(sb, "offsite");
    const log = await sb.log();
    expect(log).toMatch(/INSERT INTO settings.*BACKUP_DESTINATION.*usb1\/omni/);
    expect(log).not.toMatch(/usb1\/omni\//);
  }, T);

  it("moviendo: copia, compara y solo entonces borra lo antiguo; no toca archivos ajenos ni .fallida", async () => {
    const sb = await withCopies();
    const r = await sb.dest("usb1/omni", true);
    expect(r.ok, r.msg).toBe(true);
    expect(r.msg).toMatch(/Copias movidas: 2/);
    for (const [n, c] of Object.entries(COPIES)) {
      expect(await sb.read("targets", "usb1", "omni", n)).toBe(c);
      expect(await sb.exists("offsite", n), `${n} debería haberse movido`).toBe(false);
    }
    expect(await sb.read("offsite", "notas.txt")).toBe("mío");
    expect(await sb.exists("offsite", "db_2026-10-01_0300.dump.fallida")).toBe(true);
    expect((await sb.ls("targets", "usb1", "omni")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(await inserted(sb)).toBe(true);
  }, T);

  it("si la comparación falla no borra nada ni cambia el ajuste", async () => {
    const sb = await withCopies();
    const r = await sb.dest("usb1/omni", true, { STUB_CMP_FAIL: "1" });
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/no coincide con el original; no se borró nada/);
    await intact(sb, "offsite");
    expect(await inserted(sb)).toBe(false);
  }, T);

  it("si falla la copia de un archivo no borra nada, no deja temporales y no cambia el ajuste", async () => {
    const sb = await withCopies();
    const r = await sb.dest("usb1/omni", true, { STUB_CP_FAIL: "1" });
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/No se pudo copiar .* no se borró nada/);
    await intact(sb, "offsite");
    expect((await sb.ls("targets", "usb1", "omni")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(await inserted(sb)).toBe(false);
  }, T);

  it("si no se puede guardar el ajuste en la base no borra lo antiguo", async () => {
    const sb = await withCopies();
    const r = await sb.dest("usb1/omni", true, { STUB_PSQL_INSERT_FAIL: "1" });
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/No se pudo guardar el destino en la base; no se borró nada/);
    await intact(sb, "offsite");
  }, T);

  const link = async (target: string, linkPath: string): Promise<boolean> => {
    try {
      await symlink(target, linkPath, "dir");
      return (await stat(linkPath)).isDirectory();
    } catch {
      return false;
    }
  };

  it("un enlace simbólico dentro de /targets hacia el origen: no borra nada y la orden termina con ok=false", async () => {
    const sb = await withCopies();
    if (!(await link(sb.p("offsite"), sb.p("targets", "usb1", "alias")))) return; // sin permiso para enlaces simbólicos (Windows)
    const r = await sb.dest("usb1/alias", true);
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/misma carpeta/);
    await intact(sb, "offsite");
    expect(await inserted(sb)).toBe(false);
  }, T);

  it("la misma carpeta con otra ruta (origen y destino son alias): no borra nada", async () => {
    const sb = await sandbox();
    await sb.write("targets/usb1/omni/db_2026-11-01_0300.dump", "A".repeat(20));
    if (!(await link(sb.p("targets", "usb1", "omni"), sb.p("targets", "usb1", "otro")))) return;
    const r = await sb.dest("usb1/otro", true, {}, "DEST_REL=usb1/omni");
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/misma carpeta/);
    expect(await sb.read("targets", "usb1", "omni", "db_2026-11-01_0300.dump")).toBe("A".repeat(20));
    expect(await inserted(sb)).toBe(false);
  }, T);

  it("mover solo lleva las copias con nombre exacto (un db_clientes.xlsx se queda)", async () => {
    const sb = await withCopies();
    await sb.write("offsite/db_clientes.xlsx", "ajeno");
    const r = await sb.dest("usb1/omni", true);
    expect(r.ok, r.msg).toBe(true);
    expect(r.msg).toMatch(/Copias movidas: 2/);
    expect(await sb.read("offsite", "db_clientes.xlsx")).toBe("ajeno");
    expect(await sb.exists("targets", "usb1", "omni", "db_clientes.xlsx")).toBe(false);
  }, T);

  it("sin espacio suficiente en el destino no copia nada", async () => {
    const sb = await sandbox();
    await sb.write("targets/usb1/.keep", "");
    await sb.write("offsite/db_2026-11-01_0300.dump", "A".repeat(50_000));
    const r = await sb.dest("usb1/omni", true, { STUB_DF_FREE_KB: "1" });
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/No hay espacio suficiente/);
    expect(await sb.ls("targets", "usb1", "omni")).toEqual([]);
    expect(await sb.exists("offsite", "db_2026-11-01_0300.dump")).toBe(true);
  }, T);

  it("origen no disponible al mover: no mueve nada y lo dice", async () => {
    const sb = await sandbox();
    await sb.write("targets/usb1/.keep", "");
    const r = await sb.dest("usb1/omni", true, {}, "DEST_REL=gone/x");
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/origen no está disponible; no se movió nada/);
    expect(await inserted(sb)).toBe(false);
  }, T);

  it("elegir el destino actual solo lo confirma", async () => {
    const sb = await sandbox();
    await sb.write("targets/usb1/omni/db_2026-11-01_0300.dump", "A");
    const r = await sb.dest("usb1/omni", true, {}, "DEST_REL=usb1/omni");
    expect(r.ok, r.msg).toBe(true);
    expect(r.msg).toMatch(/Destino confirmado/);
    expect(await sb.exists("targets", "usb1", "omni", "db_2026-11-01_0300.dump")).toBe(true);
  }, T);

  it("vacío vuelve a la carpeta clásica y lleva las copias de la carpeta anterior", async () => {
    const sb = await sandbox();
    await sb.write("targets/usb1/omni/db_2026-11-01_0300.dump", "A");
    const r = await sb.dest("", true, {}, "DEST_REL=usb1/omni");
    expect(r.ok, r.msg).toBe(true);
    expect(r.msg).toMatch(/carpeta clásica/);
    expect(await sb.read("offsite", "db_2026-11-01_0300.dump")).toBe("A");
    expect(await sb.exists("targets", "usb1", "omni", "db_2026-11-01_0300.dump")).toBe(false);
  }, T);
});

const CREDS = ["export B2_BUCKET=" + SQ + "mibucket" + SQ, "export B2_KEY_ID=" + SQ + "kid" + SQ, "export B2_APPLICATION_KEY=" + SQ + "secreta" + SQ];
const confFile = (sb: Sandbox) => ({ B2_CONFIG_FILE: `${sb.px}/config/b2.env` });
const b2State = (sb: Sandbox) => sb.json<{ ok: boolean; error: string; checkedAt: string }>("status", "b2.json");

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`tiempo agotado esperando la condición${last ? `: ${String(last)}` : ""}`);
}

describe.concurrent("deploy/b2-sync.sh", { skip: !hasGnuSh }, () => {
  it("--once sin credenciales: anota el error en b2.json, sale con 1 y no llama a rclone", async () => {
    const sb = await sandbox();
    const r = await sb.run("b2-sync.sh", ["--once"], confFile(sb));
    expect(r.code, r.out).toBe(1);
    const st = await b2State(sb);
    expect(st.ok).toBe(false);
    expect(st.error).toMatch(/faltan los datos de Backblaze: B2_BUCKET B2_KEY_ID B2_APPLICATION_KEY/);
    expect(await sb.log()).not.toMatch(/rclone/);
  }, T);

  it("en el bucle principal, sin credenciales no sale y arranca solo cuando se configuran", async () => {
    const sb = await sandbox();
    const child = spawn("sh", [`${sb.px}/b2-sync.sh`], { cwd: sb.root, env: sb.env(confFile(sb)), stdio: "ignore" });
    try {
      const first = await waitFor(async () => {
        const s = await b2State(sb);
        return /faltan los datos/.test(s.error) ? s : null;
      });
      expect(first.ok).toBe(false);
      await new Promise((r) => setTimeout(r, 1500));
      expect(child.exitCode, "el script no debe salir mientras faltan credenciales").toBeNull();
      // Se configuran desde la pantalla: el worker escribe b2.env y el script lo recoge sin reiniciarse.
      await writeFile(sb.p("config", "b2.env"), CREDS.join("\n") + "\n");
      const second = await waitFor(async () => {
        const s = await b2State(sb);
        return /no hay copias cifradas/.test(s.error) ? s : null;
      });
      expect(second.ok).toBe(false);
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill("SIGKILL");
    }
  }, T);

  it("el b2.env con líneas maliciosas no ejecuta nada; las válidas se leen tal cual, con comillas y signos raros", async () => {
    const sb = await sandbox();
    await sb.write("offsite/db_2026-11-01_0300.dump.enc", "cifrado");
    const key = `it${SQ}s "a" $HOME ; x`;
    const conf = [
      "export B2_BUCKET=" + SQ + "mibucket" + SQ,
      "export B2_PATH=" + SQ + "ruta/x" + SQ,
      "export B2_KEY_ID=" + SQ + "$" + "(touch PWNED5)" + SQ,
      "export B2_APPLICATION_KEY=" + SQ + key.replaceAll(SQ, SQ + "\\" + SQ + SQ) + SQ,
      "touch PWNED1",
      "export B2_AT=" + SQ + "04:00" + SQ + "; touch PWNED2",
      "export EVIL=" + SQ + "1" + SQ,
      "export B2_KEY_ID=" + SQ + "a" + SQ + "$" + "(touch PWNED3)" + SQ + "b" + SQ,
      "export B2_BUCKET=" + SQ + "x" + SQ + "; touch PWNED4",
      "echo $" + "(touch PWNED6)",
      "export PATH=" + SQ + "/nada" + SQ,
      "export B2_PATH=" + SQ + "a" + SQ + "$" + "(touch PWNED7)",
      ". /etc/passwd",
    ].join("\n");
    await writeFile(sb.p("config", "b2.env"), conf + "\n");
    const r = await sb.run("b2-sync.sh", ["--once"], confFile(sb));
    expect(r.code, r.out).toBe(0);
    expect(await sb.find(/PWNED/)).toEqual([]);
    const log = await sb.log();
    expect(log).toContain("rclone copy " + sb.px + "/offsite b2:mibucket/ruta/x");
    expect(log).toContain(`ACCOUNT=$` + `(touch PWNED5) KEY=${key}`);
    expect((await b2State(sb)).ok).toBe(true);
  }, T);

  it("una variable de entorno no vacía manda sobre el archivo", async () => {
    const sb = await sandbox();
    await sb.write("offsite/db_2026-11-01_0300.dump.enc", "cifrado");
    await writeFile(sb.p("config", "b2.env"), CREDS.join("\n") + "\n");
    const r = await sb.run("b2-sync.sh", ["--once"], { ...confFile(sb), B2_BUCKET: "delentorno" });
    expect(r.code, r.out).toBe(0);
    expect(await sb.log()).toContain("b2:delentorno/omni-rag");
  }, T);

  it("carpeta externa elegida pero desconectada: error claro, no sube y no crea la carpeta", async () => {
    const sb = await sandbox();
    await sb.write("offsite/db_2026-11-01_0300.dump.enc", "cifrado");
    await writeFile(sb.p("config", "b2.env"), [...CREDS, "export BACKUP_DESTINATION=" + SQ + "usb9/none" + SQ].join("\n") + "\n");
    const r = await sb.run("b2-sync.sh", ["--once"], confFile(sb));
    expect(r.code).toBe(1);
    expect((await b2State(sb)).error).toMatch(/el destino externo no está conectado/);
    expect(await sb.log()).not.toMatch(/rclone/);
    expect(await sb.ls("targets")).toEqual([]);
  }, T);

  it.each(["../../etc", "/etc", "a/../b", ".", "a;b"])("destino no válido %j en b2.env: se avisa y se lee la carpeta clásica", async (bad) => {
    const sb = await sandbox();
    await sb.write("offsite/db_2026-11-01_0300.dump.enc", "cifrado");
    await writeFile(sb.p("config", "b2.env"), [...CREDS, "export BACKUP_DESTINATION=" + SQ + bad + SQ].join("\n") + "\n");
    const r = await sb.run("b2-sync.sh", ["--once"], confFile(sb));
    expect(r.out).toMatch(/valor no válido en BACKUP_DESTINATION/);
    expect(await sb.log()).toContain("rclone copy " + sb.px + "/offsite b2:mibucket/omni-rag");
  }, T);

  it("B2_PATH con «..» o caracteres raros vuelve al valor por defecto", async () => {
    const sb = await sandbox();
    await sb.write("offsite/db_2026-11-01_0300.dump.enc", "cifrado");
    await writeFile(sb.p("config", "b2.env"), [...CREDS, "export B2_PATH=" + SQ + "../otro" + SQ].join("\n") + "\n");
    const r = await sb.run("b2-sync.sh", ["--once"], confFile(sb));
    expect(r.out).toMatch(/valor no válido en B2_PATH/);
    expect(await sb.log()).toContain("b2:mibucket/omni-rag");
  }, T);

  it("rclone falla: b2.json queda con error y el script sale con 1", async () => {
    const sb = await sandbox();
    await sb.write("offsite/db_2026-11-01_0300.dump.enc", "cifrado");
    await writeFile(sb.p("config", "b2.env"), CREDS.join("\n") + "\n");
    const r = await sb.run("b2-sync.sh", ["--once"], { ...confFile(sb), STUB_RCLONE_FAIL: "1" });
    expect(r.code).toBe(1);
    expect(await b2State(sb)).toMatchObject({ ok: false });
  }, T);

  const PASS = "frase secreta para las pruebas";

  it("la frase de cifrado va a rclone obscure por la entrada estándar, nunca como argumento", async () => {
    const sb = await sandbox();
    await sb.write("offsite/db_2026-11-01_0300.dump.enc", "cifrado");
    await writeFile(sb.p("config", "b2.env"), CREDS.join("\n") + "\n");
    const r = await sb.run("b2-sync.sh", ["--once"], { ...confFile(sb), BACKUP_ENCRYPTION_PASSPHRASE: PASS });
    expect(r.code, r.out).toBe(0);
    const log = await sb.log();
    expect(log).toContain("rclone obscure -");
    expect(log).toContain(`obscure-stdin=${PASS}`);
    expect(log).toContain(`obscure-stdin=${PASS}:nombres`);
    expect(log.split("\n").filter((l) => l.startsWith("rclone ") && l.includes(PASS))).toEqual([]);
  }, T);

  it("el archivo temporal con las claves se borra tras cargarlo y la frase se ofusca una sola vez en el bucle", async () => {
    const sb = await sandbox();
    await writeFile(sb.p("config", "b2.env"), CREDS.join("\n") + "\n");
    const child = spawn("sh", [`${sb.px}/b2-sync.sh`], { cwd: sb.root, env: sb.env({ ...confFile(sb), BACKUP_ENCRYPTION_PASSPHRASE: PASS }), stdio: "ignore" });
    try {
      const first = await waitFor(async () => (await b2State(sb)).checkedAt);
      await waitFor(async () => (await b2State(sb)).checkedAt !== first); // el bucle dio al menos otra vuelta
      await new Promise((r) => setTimeout(r, 1500));
      expect(await sb.exists("tmp", "b2.env.seguro")).toBe(false);
      expect(((await sb.log()).match(/rclone obscure -/g) ?? []).length).toBe(2);
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill("SIGKILL");
    }
  }, T);
});

