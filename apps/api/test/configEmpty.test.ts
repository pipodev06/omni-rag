import { afterEach, describe, expect, it, vi } from "vitest";
import "./env.js";

/** config.ts lee el entorno al importarse: cada caso lo prepara y lo importa de nuevo. */
const KEYS = ["ALERT_BACKUP_HOURS", "HISTORY_MESSAGES", "RERANKER_URL", "APP_NAME", "CACHE_ENABLED", "LLM_DEFAULT_PROVIDER", "SMTP_PORT", "DATABASE_URL", "TRASH_RETENTION_DAYS"];
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

async function load(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.resetModules();
  return import("../src/config.js");
}

describe("variables vacías en el entorno (withoutInvalidEmpty)", () => {
  it("ALERT_BACKUP_HOURS= usa el valor por defecto en vez de fallar", async () => {
    const { config, DEFAULTS } = await load({ ALERT_BACKUP_HOURS: "" });
    expect(config.ALERT_BACKUP_HOURS).toBe(DEFAULTS.ALERT_BACKUP_HOURS);
    expect(config.ALERT_BACKUP_HOURS).toBe(36);
  });

  it("HISTORY_MESSAGES= no queda en 0 (que sería un valor válido y cambiaría el comportamiento)", async () => {
    const { config } = await load({ HISTORY_MESSAGES: "" });
    expect(config.HISTORY_MESSAGES).toBe(6);
  });

  it("TRASH_RETENTION_DAYS= tampoco queda en 0 (que borraría la papelera al instante)", async () => {
    const { config, DEFAULTS } = await load({ TRASH_RETENTION_DAYS: "" });
    expect(config.TRASH_RETENTION_DAYS).toBe(DEFAULTS.TRASH_RETENTION_DAYS);
    expect(config.TRASH_RETENTION_DAYS).toBeGreaterThan(0);
  });

  it("un valor escrito de verdad se respeta, incluido 0 donde es válido", async () => {
    const { config } = await load({ HISTORY_MESSAGES: "0", ALERT_BACKUP_HOURS: "12" });
    expect(config.HISTORY_MESSAGES).toBe(0);
    expect(config.ALERT_BACKUP_HOURS).toBe(12);
  });

  it("booleanos y enums vacíos usan el valor por defecto", async () => {
    const { config, DEFAULTS } = await load({ CACHE_ENABLED: "", LLM_DEFAULT_PROVIDER: "" });
    expect(config.CACHE_ENABLED).toBe(DEFAULTS.CACHE_ENABLED);
    expect(config.LLM_DEFAULT_PROVIDER).toBe("openrouter");
  });

  it("RERANKER_URL= se respeta como vacío (desactiva el re-ranker)", async () => {
    const { config } = await load({ RERANKER_URL: "" });
    expect(config.RERANKER_URL).toBe("");
  });

  it("un texto con valor por defecto no vacío se respeta vacío si el esquema lo admite (APP_NAME=)", async () => {
    const { config, DEFAULTS } = await load({ APP_NAME: "" });
    expect(DEFAULTS.APP_NAME).not.toBe("");
    expect(config.APP_NAME).toBe("");
  });

  it("una variable con solo espacios cuenta como vacía, igual que \"\"", async () => {
    const { config, DEFAULTS } = await load({ ALERT_BACKUP_HOURS: "   ", HISTORY_MESSAGES: "	 ", CACHE_ENABLED: " ", LLM_DEFAULT_PROVIDER: "  ", TRASH_RETENTION_DAYS: " " });
    expect(config.ALERT_BACKUP_HOURS).toBe(DEFAULTS.ALERT_BACKUP_HOURS);
    expect(config.HISTORY_MESSAGES).toBe(DEFAULTS.HISTORY_MESSAGES);
    expect(config.CACHE_ENABLED).toBe(DEFAULTS.CACHE_ENABLED);
    expect(config.LLM_DEFAULT_PROVIDER).toBe("openrouter");
    expect(config.TRASH_RETENTION_DAYS).toBe(DEFAULTS.TRASH_RETENTION_DAYS);
  });

  it("donde \"\" vale, los espacios también dan vacío (RERANKER_URL, APP_NAME)", async () => {
    const { config } = await load({ RERANKER_URL: "   ", APP_NAME: "  " });
    expect(config.RERANKER_URL).toBe("");
    expect(config.APP_NAME).toBe("");
  });

  it("DATABASE_URL con solo espacios sigue siendo un error", async () => {
    await expect(load({ DATABASE_URL: "   " })).rejects.toThrow(/DATABASE_URL/);
  });

  it("un valor inválido no vacío sigue siendo un error", async () => {
    await expect(load({ ALERT_BACKUP_HOURS: "abc" })).rejects.toThrow(/Configuración inválida/);
    await expect(load({ ALERT_BACKUP_HOURS: "0" })).rejects.toThrow(/Configuración inválida/);
    await expect(load({ SMTP_PORT: "mucho" })).rejects.toThrow(/Configuración inválida/);
  });

  it("una variable obligatoria vacía sigue siendo un error (no se trata como no escrita)", async () => {
    await expect(load({ DATABASE_URL: "" })).rejects.toThrow(/DATABASE_URL/);
  });
});
