import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./env.js";

/** Correo saliente: TLS obligatorio salvo en servidores locales, configuración fijada al capturar el envío y errores sin datos sensibles. */
const cfg: Record<string, unknown> = {};
const sent: { transport: number; mail: Record<string, unknown> }[] = [];
const created: Record<string, unknown>[] = [];
let failWith: unknown = null;

vi.mock("nodemailer", () => ({
  default: {
    createTransport: (opts: Record<string, unknown>) => {
      const id = created.push(opts);
      return {
        sendMail: async (mail: Record<string, unknown>) => {
          if (failWith) throw failWith;
          sent.push({ transport: id, mail });
        },
        verify: async () => {
          if (failWith) throw failWith;
        },
      };
    },
  },
}));
vi.mock("../src/lib/settings.js", () => ({ setting: (k: string) => cfg[k] }));

const base = { SMTP_HOST: "smtp.ejemplo.com", SMTP_PORT: 587, SMTP_SECURE: false, SMTP_USER: "pepe", SMTP_PASSWORD: "hunter2", SMTP_FROM: "Omni <no-reply@ejemplo.com>" };

beforeEach(() => {
  Object.assign(cfg, base);
  created.length = 0;
  sent.length = 0;
  failWith = null;
  vi.resetModules();
});
afterEach(() => vi.restoreAllMocks());

const mail = { to: "a@b.com", subject: "s", intro: "i", outro: "o" };

describe("smtpOptions: requireTLS", () => {
  it("sin TLS directo exige STARTTLS en cualquier servidor que no sea local", async () => {
    const { smtpOptions } = await import("../src/lib/mailer.js");
    const o = { port: 587, secure: false, user: "", pass: "" };
    expect(smtpOptions({ ...o, host: "smtp.gmail.com" }).requireTLS).toBe(true);
    expect(smtpOptions({ ...o, host: "10.0.0.5" }).requireTLS).toBe(true);
    expect(smtpOptions({ ...o, host: "mailpit.example.com" }).requireTLS).toBe(true);
  });

  it.each(["mailpit", "localhost", "127.0.0.1", "::1", "LOCALHOST", "Mailpit"])("%s (local) puede ir sin cifrar", async (host) => {
    const { smtpOptions } = await import("../src/lib/mailer.js");
    expect(smtpOptions({ host, port: 1025, secure: false, user: "", pass: "" }).requireTLS).toBe(false);
  });

  it("con TLS directo no hace falta requireTLS", async () => {
    const { smtpOptions } = await import("../src/lib/mailer.js");
    expect(smtpOptions({ host: "smtp.gmail.com", port: 465, secure: true, user: "", pass: "" })).toMatchObject({ secure: true, requireTLS: false });
  });

  it("la autenticación solo va si hay usuario", async () => {
    const { smtpOptions } = await import("../src/lib/mailer.js");
    expect(smtpOptions({ host: "h", port: 25, secure: false, user: "", pass: "x" }).auth).toBeUndefined();
    expect(smtpOptions({ host: "h", port: 25, secure: false, user: "u", pass: "x" }).auth).toEqual({ user: "u", pass: "x" });
  });

  it("el transporte real se crea con requireTLS según el servidor configurado", async () => {
    const { sendEmail } = await import("../src/lib/mailer.js");
    await sendEmail(mail);
    expect(created[0]).toMatchObject({ host: "smtp.ejemplo.com", requireTLS: true });
    cfg.SMTP_HOST = "mailpit";
    await sendEmail(mail);
    expect(created[1]).toMatchObject({ host: "mailpit", requireTLS: false });
  });
});

describe("captureMailer", () => {
  it("usa la configuración de cuando se capturó, aunque cambie después (el aviso sale por el servidor de antes)", async () => {
    const { captureMailer } = await import("../src/lib/mailer.js");
    const send = captureMailer();
    cfg.SMTP_HOST = "servidor-del-atacante.com";
    expect(await send(mail)).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ host: "smtp.ejemplo.com" });
    expect(sent[0]!.mail).toMatchObject({ from: base.SMTP_FROM, to: "a@b.com" });
  });

  it("sin servidor configurado no envía", async () => {
    cfg.SMTP_HOST = "";
    const { captureMailer } = await import("../src/lib/mailer.js");
    expect(await captureMailer()(mail)).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("un fallo de envío devuelve false y el registro no lleva el objeto del error (puede traer el comando con las credenciales)", async () => {
    failWith = Object.assign(new Error("Invalid login"), { code: "EAUTH", responseCode: 535, command: "AUTH PLAIN AHBlcGUAaHVudGVyMg==" });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sendEmail } = await import("../src/lib/mailer.js");
    expect(await sendEmail(mail)).toBe(false);
    const dump = JSON.stringify(log.mock.calls);
    expect(dump).toContain("EAUTH");
    expect(dump).not.toContain("AHBlcGUAaHVudGVyMg==");
    expect(dump).not.toContain("hunter2");
  });

  it("verifyEmail registra solo código y mensaje, y vuelve a lanzar el error", async () => {
    failWith = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED", command: "COMANDO-INTERNO" });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { verifyEmail } = await import("../src/lib/mailer.js");
    await expect(verifyEmail()).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("COMANDO-INTERNO");
  });
});

describe("smtpErrorMessage", () => {
  it("devuelve siempre un texto fijo, sin trozos del error original", async () => {
    const { smtpErrorMessage } = await import("../src/lib/mailer.js");
    const texts = new Set(
      ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAUTH", "ESOCKET", "OTRO"].map((code) => smtpErrorMessage(Object.assign(new Error("SECRETO " + code), { code }))),
    );
    expect(texts.size).toBe(6);
    for (const t of texts) expect(t).not.toContain("SECRETO");
    expect(smtpErrorMessage(null)).toMatch(/No se pudo enviar/);
    expect(smtpErrorMessage("texto")).toMatch(/No se pudo enviar/);
  });
});
