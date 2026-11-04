import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./env.js";

/**
 * Ajustes editables (lib/settings.ts). No hay base: `sqlOwner` se sustituye por una tabla en memoria que entiende
 * las cuatro sentencias que usa el módulo. Lo que se prueba es la lógica (precedencia, validación, todo o nada,
 * cifrado de secretos), no el driver.
 */
type Row = { value: unknown; secret: string | null };

function makeDb() {
  const rows = new Map<string, Row>();
  const calls = { begin: 0 };
  const run = (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT key, value, secret FROM settings")) {
      return Promise.resolve([...rows].map(([key, r]) => ({ key, value: r.value, secret: r.secret })));
    }
    if (q.startsWith("DELETE FROM settings")) {
      rows.delete(vals[0] as string);
      return Promise.resolve([]);
    }
    if (q.startsWith("INSERT INTO settings")) {
      const key = vals[0] as string;
      if (q.includes("?::jsonb")) rows.set(key, { value: JSON.parse(vals[1] as string), secret: null });
      else rows.set(key, { value: null, secret: vals[1] as string });
      return Promise.resolve([]);
    }
    throw new Error(`consulta no prevista: ${q}`);
  };
  const sql = Object.assign(run, {
    begin: async (fn: (tx: typeof run) => Promise<void>) => {
      calls.begin++;
      await fn(run);
    },
  });
  return { rows, calls, sql };
}

const TOUCHED = ["ALERT_BACKUP_HOURS", "ALERT_DISK_FREE_PERCENT", "BACKUP_KEEP_DAYS", "BACKUP_DESTINATION", "B2_BUCKET", "SMTP_HOST", "HISTORY_MESSAGES"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of TOUCHED) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

/** Importa settings.ts de cero (config.ts lee el entorno al importarse) con la base simulada. */
async function fresh(env: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.resetModules();
  const db = makeDb();
  vi.doMock("../src/db/client.js", () => ({ sqlOwner: db.sql }));
  const settings = await import("../src/lib/settings.js");
  const box = await import("../src/lib/secretBox.js");
  return { ...settings, box, db };
}

const field = (view: ReturnType<Awaited<ReturnType<typeof fresh>>["settingsView"]>, key: string) =>
  view.groups.flatMap((g) => g.fields).find((f) => f.key === key)!;

describe("precedencia: variable de entorno no vacía > fila > valor por defecto", () => {
  it("sin nada guardado vale el valor por defecto", async () => {
    delete process.env.ALERT_BACKUP_HOURS;
    const s = await fresh();
    await s.refreshSettings();
    expect(s.setting("ALERT_BACKUP_HOURS")).toBe(36);
    const f = field(s.settingsView(), "ALERT_BACKUP_HOURS");
    expect(f).toMatchObject({ value: 36, default: 36, lockedByEnv: false });
  });

  it("la fila de la base manda sobre el valor por defecto", async () => {
    delete process.env.ALERT_BACKUP_HOURS;
    const s = await fresh();
    s.db.rows.set("ALERT_BACKUP_HOURS", { value: 12, secret: null });
    await s.refreshSettings();
    expect(s.setting("ALERT_BACKUP_HOURS")).toBe(12);
  });

  it("la variable de entorno no vacía manda sobre la fila y deja el campo bloqueado", async () => {
    const s = await fresh({ ALERT_BACKUP_HOURS: "48" });
    s.db.rows.set("ALERT_BACKUP_HOURS", { value: 12, secret: null });
    await s.refreshSettings();
    expect(s.setting("ALERT_BACKUP_HOURS")).toBe(48);
    expect(field(s.settingsView(), "ALERT_BACKUP_HOURS")).toMatchObject({ value: 48, lockedByEnv: true });
  });

  it("una variable vacía cuenta como no escrita: manda la fila y el campo no está bloqueado", async () => {
    const s = await fresh({ ALERT_BACKUP_HOURS: "" });
    s.db.rows.set("ALERT_BACKUP_HOURS", { value: 12, secret: null });
    await s.refreshSettings();
    expect(s.setting("ALERT_BACKUP_HOURS")).toBe(12);
    expect(field(s.settingsView(), "ALERT_BACKUP_HOURS").lockedByEnv).toBe(false);
  });

  it("los ajustes de copias (fuera de config.ts) usan su valor por defecto, la fila o el entorno", async () => {
    delete process.env.BACKUP_KEEP_DAYS;
    const s = await fresh();
    await s.refreshSettings();
    const asMap = () => new Map(s.backupSettingsForScripts());
    expect(asMap().get("BACKUP_KEEP_DAYS")).toBe("7");
    expect(asMap().get("B2_PATH")).toBe("omni-rag");
    expect(asMap().get("BACKUP_UPLOADS_TGZ")).toBe("true");
    s.db.rows.set("BACKUP_KEEP_DAYS", { value: 30, secret: null });
    await s.refreshSettings();
    expect(asMap().get("BACKUP_KEEP_DAYS")).toBe("30");
  });

  it("backupSettingsForScripts omite lo fijado en el entorno y lleva la carpeta externa", async () => {
    const s = await fresh({ BACKUP_KEEP_DAYS: "9", B2_BUCKET: "mi-bucket" });
    s.db.rows.set("BACKUP_DESTINATION", { value: "usb1/omni", secret: null });
    await s.refreshSettings();
    const keys = s.backupSettingsForScripts().map(([k]) => k);
    expect(keys).not.toContain("BACKUP_KEEP_DAYS");
    expect(keys).not.toContain("B2_BUCKET");
    expect(keys).toContain("BACKUP_DESTINATION");
    expect(new Map(s.backupSettingsForScripts()).get("BACKUP_DESTINATION")).toBe("usb1/omni");
    expect(s.backupDestination()).toBe("usb1/omni");
  });

  it("BACKUP_DESTINATION del entorno manda sobre la fila", async () => {
    const s = await fresh({ BACKUP_DESTINATION: "disco/env" });
    s.db.rows.set("BACKUP_DESTINATION", { value: "usb1/omni", secret: null });
    await s.refreshSettings();
    expect(s.backupDestination()).toBe("disco/env");
    expect(s.backupSettingsForScripts().map(([k]) => k)).not.toContain("BACKUP_DESTINATION");
  });
});

describe("secretos", () => {
  it("se guardan cifrados con la etiqueta settings-secret y la vista nunca devuelve el valor", async () => {
    const s = await fresh();
    await s.applySettings({ GROQ_API_KEY: "gsk_secreto-en-claro" }, "root");
    const row = s.db.rows.get("GROQ_API_KEY")!;
    expect(row.value).toBeNull();
    expect(row.secret).not.toContain("gsk_secreto");
    expect(row.secret!.split(".")).toHaveLength(3);
    expect(s.box.open("settings-secret", row.secret!)).toBe("gsk_secreto-en-claro");
    expect(() => s.box.open("totp-secret", row.secret!)).toThrow();
    // El valor efectivo sí llega a los consumidores, la vista no.
    expect(s.setting("GROQ_API_KEY")).toBe("gsk_secreto-en-claro");
    const f = field(s.settingsView(), "GROQ_API_KEY");
    expect(f).toMatchObject({ value: null, default: null, configured: true, lockedByEnv: false });
    expect(JSON.stringify(s.settingsView())).not.toContain("gsk_secreto");
  });

  it("un secreto sin configurar aparece como no configurado", async () => {
    const s = await fresh();
    await s.refreshSettings();
    expect(field(s.settingsView(), "OPENAI_API_KEY")).toMatchObject({ value: null, configured: false });
  });

  it("null quita el secreto", async () => {
    const s = await fresh();
    await s.applySettings({ GROQ_API_KEY: "abc" }, "root");
    await s.applySettings({ GROQ_API_KEY: null }, "root");
    expect(s.db.rows.has("GROQ_API_KEY")).toBe(false);
    expect(field(s.settingsView(), "GROQ_API_KEY").configured).toBe(false);
  });

  it("un secreto vacío, con salto de línea o enorme se rechaza", async () => {
    const s = await fresh();
    for (const bad of ["", "a\nb", "x".repeat(2001)]) {
      await expect(s.applySettings({ GROQ_API_KEY: bad }, "root")).rejects.toBeInstanceOf(s.SettingsError);
    }
    expect(s.db.rows.size).toBe(0);
  });

  it("un secreto que no se puede descifrar (JWT_SECRET cambiado) se ignora sin romper la carga", async () => {
    const s = await fresh();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    s.db.rows.set("GROQ_API_KEY", { value: null, secret: "AAAA.BBBB.CCCC" });
    s.db.rows.set("ALERT_BACKUP_HOURS", { value: 12, secret: null });
    await s.refreshSettings();
    expect(s.setting("GROQ_API_KEY")).toBe("");
    expect(s.setting("ALERT_BACKUP_HOURS")).toBe(12);
    expect(err).toHaveBeenCalledOnce();
    expect(String(err.mock.calls[0]![0])).toContain("GROQ_API_KEY");
  });
});

describe("applySettings: validación todo o nada", () => {
  it("guarda un valor válido, devuelve solo las claves y refresca la memoria", async () => {
    const s = await fresh();
    const keys = await s.applySettings({ ALERT_DISK_FREE_PERCENT: 15, CACHE_ENABLED: false }, "root");
    expect(keys.sort()).toEqual(["ALERT_DISK_FREE_PERCENT", "CACHE_ENABLED"]);
    expect(s.setting("ALERT_DISK_FREE_PERCENT")).toBe(15);
    expect(s.setting("CACHE_ENABLED")).toBe(false);
    expect(s.db.rows.get("ALERT_DISK_FREE_PERCENT")).toEqual({ value: 15, secret: null });
  });

  it("null borra la fila y vuelve al valor por defecto", async () => {
    const s = await fresh();
    await s.applySettings({ ALERT_DISK_FREE_PERCENT: 20 }, "root");
    await s.applySettings({ ALERT_DISK_FREE_PERCENT: null }, "root");
    expect(s.db.rows.has("ALERT_DISK_FREE_PERCENT")).toBe(false);
    expect(s.setting("ALERT_DISK_FREE_PERCENT")).toBe(15);
  });

  it("un cuerpo vacío no abre transacción", async () => {
    const s = await fresh();
    expect(await s.applySettings({}, "root")).toEqual([]);
    expect(s.db.calls.begin).toBe(0);
  });

  it("si una clave no es válida no se guarda ninguna (todo o nada)", async () => {
    const s = await fresh();
    await expect(s.applySettings({ ALERT_DISK_FREE_PERCENT: 15, HISTORY_MESSAGES: 999 }, "root")).rejects.toBeInstanceOf(s.SettingsError);
    await expect(s.applySettings({ ALERT_DISK_FREE_PERCENT: 15, NO_EXISTE: 1 }, "root")).rejects.toBeInstanceOf(s.SettingsError);
    await expect(s.applySettings({ ALERT_DISK_FREE_PERCENT: 15, BACKUP_DESTINATION: "x" }, "root")).rejects.toBeInstanceOf(s.SettingsError);
    expect(s.db.calls.begin).toBe(0);
    expect(s.db.rows.size).toBe(0);
  });

  it("rechaza claves desconocidas y no repite el texto largo en el mensaje", async () => {
    const s = await fresh();
    await expect(s.applySettings({ JWT_SECRET: "x" }, "root")).rejects.toThrow(/desconocido/);
    await expect(s.applySettings({ ["K".repeat(500)]: 1 }, "root")).rejects.toSatisfy((e: Error) => e.message.length < 100);
  });

  it("rechaza BACKUP_DESTINATION: solo la escribe backup.sh", async () => {
    const s = await fresh();
    await expect(s.applySettings({ BACKUP_DESTINATION: "usb/omni" }, "root")).rejects.toThrow(/Cambiar destino/);
    await expect(s.applySettings({ BACKUP_DESTINATION: null }, "root")).rejects.toThrow(/Cambiar destino/);
  });

  it("rechaza lo fijado en el entorno, también para null", async () => {
    const s = await fresh({ ALERT_BACKUP_HOURS: "48" });
    await expect(s.applySettings({ ALERT_BACKUP_HOURS: 12 }, "root")).rejects.toThrow(/fijado en el/);
    await expect(s.applySettings({ ALERT_BACKUP_HOURS: null }, "root")).rejects.toThrow(/fijado en el/);
    expect(s.db.rows.size).toBe(0);
  });

  // [clave, valores válidos (incluidos los bordes), valores fuera de rango o de tipo]
  const SQ = String.fromCharCode(39);
  const RANGES: [string, unknown[], unknown[]][] = [
    ["ALERT_DISK_FREE_PERCENT", [1, 90, 5.5], [0, 91, -1, "10"]],
    ["ALERT_CONTAINER_MEM_PERCENT", [50, 100], [49, 101]],
    ["HISTORY_MESSAGES", [0, 50], [-1, 51, 1.5]],
    ["TRASH_RETENTION_DAYS", [0, 365], [-1, 366, 0.5]],
    ["QUOTA_WARN_PERCENT", [1, 100], [0, 101]],
    ["SMTP_PORT", [1, 65535], [0, 65536, 587.5]],
    ["LLM_TEMPERATURE", [0, 2, 0.7], [-0.1, 2.1]],
    ["RERANK_MIN_SCORE", [0, 1, 0.25], [1.01, -0.01]],
    ["WEB_SEARCH_MAX_RESULTS", [1, 10], [0, 11]],
    ["BACKUP_INTERVAL_HOURS", [1, 720], [0, 721]],
    ["B2_KEEP_DAYS", [1, 3650], [0, 3651]],
    ["SMTP_SECURE", [true, false], ["true", 1, 0]],
    ["LLM_DEFAULT_PROVIDER", ["groq", "custom"], ["otro", "", 5]],
    ["WEB_SEARCH_PROVIDER", ["", "tavily", "brave", "searxng"], ["bing"]],
    ["BACKUP_AT", ["", "00:00", "23:59"], ["24:00", "3:00", "12:60", "03:00:00", "abc"]],
    ["B2_AT", ["04:30"], ["4:30"]],
    ["ALERT_EMAIL", ["", "a@b.com", "a@b.com, c@d.org", "a@b.com;c@d.org"], ["no-es-correo", "a@b.com,x", "a@b.com\nbcc:x@y.z"]],
    ["WEB_SEARCH_URL", ["", "http://searx.local:8080", "https://x.org/p"], ["ftp://x", "javascript:alert(1)", "no es url"]],
    ["LLM_CUSTOM_BASE_URL", ["http://localhost:11434/v1"], ["file:///etc/passwd"]],
    ["SMTP_HOST", ["smtp.gmail.com", ""], ["a\nb", "x".repeat(301)]],
    ["BACKUP_TZ", ["<-05>5", "America/Lima", ""], ["a b", "x;rm", "$" + "(id)", "a" + SQ + "b", "x".repeat(65)]],
    ["B2_BUCKET", ["mi-bucket.1", ""], ["mi bucket", "a/b", "x".repeat(64)]],
    ["B2_PATH", ["omni-rag", "a/b c/d", ""], ["a/../b", "..", "a" + SQ + "b", "a;b", "$HOME"]],
  ];
  it.each(RANGES)("%s: acepta los bordes válidos y rechaza lo demás", async (key, good, bad) => {
    const s = await fresh();
    for (const v of good) {
      await expect(s.applySettings({ [key]: v }, "root"), `${key}=${JSON.stringify(v)} debería valer`).resolves.toEqual([key]);
    }
    for (const v of bad) {
      await expect(s.applySettings({ [key]: v }, "root"), `${key}=${JSON.stringify(v)} debería fallar`).rejects.toBeInstanceOf(s.SettingsError);
    }
  });

  it("el valor por defecto de cada ajuste no secreto cumple su propia validación", async () => {
    const s = await fresh();
    for (const g of s.settingsView().groups) {
      for (const f of g.fields) {
        if (f.type === "secret") continue;
        await expect(s.applySettings({ [f.key]: f.default }, "root"), `${f.key} default=${JSON.stringify(f.default)}`).resolves.toEqual([f.key]);
      }
    }
  });

  it("el catálogo no incluye BACKUP_DESTINATION ni claves repetidas, y todo campo trae etiqueta y ayuda", async () => {
    const s = await fresh();
    const keys = s.GROUPS.flatMap((g) => g.fields.map((f) => f.key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain(s.DESTINATION_KEY);
    for (const g of s.settingsView().groups) {
      for (const f of g.fields) {
        expect(f.label, f.key).toBeTruthy();
        expect(f.help, f.key).toBeTruthy();
      }
    }
  });
});
