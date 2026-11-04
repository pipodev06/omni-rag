import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import "./env.js";
import { config } from "../src/config.js";
import { open, seal } from "../src/lib/secretBox.js";
import { decryptSecret, encryptSecret } from "../src/lib/totp.js";

describe("secretBox", () => {
  it("va y vuelve, también con texto no ASCII y largo", () => {
    for (const plain of ["clave-1", "ñandú ✓ 日本語", "x".repeat(2000), "a.b.c"]) {
      expect(open("settings-secret", seal("settings-secret", plain))).toBe(plain);
    }
  });

  it("usa un iv distinto cada vez y guarda iv.tag.datos", () => {
    const a = seal("settings-secret", "igual");
    const b = seal("settings-secret", "igual");
    expect(a).not.toBe(b);
    expect(a.split(".")).toHaveLength(3);
    expect(a).not.toContain("igual");
  });

  it("lo cifrado con una etiqueta no se abre con otra", () => {
    const s = seal("settings-secret", "clave");
    expect(() => open("totp-secret", s)).toThrow();
    const t = seal("totp-secret", "JBSWY3DPEHPK3PXP");
    expect(() => open("settings-secret", t)).toThrow();
  });

  it("detecta datos manipulados o corruptos", () => {
    const [iv, tag, data] = seal("settings-secret", "clave").split(".") as [string, string, string];
    const flipped = Buffer.from(data, "base64");
    flipped[0] = flipped[0]! ^ 1;
    expect(() => open("settings-secret", [iv, tag, flipped.toString("base64")].join("."))).toThrow();
    expect(() => open("settings-secret", "solo-un-trozo")).toThrow(/corrupto/);
    expect(() => open("settings-secret", "")).toThrow();
  });

  it("totp: lo guardado antes de crear secretBox (formato original) se sigue abriendo", () => {
    // Misma construcción que tenía lib/totp.ts antes del cambio: clave HKDF con info totp-secret.
    const key = Buffer.from(hkdfSync("sha256", config.JWT_SECRET, "rag", "totp-secret", 32));
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update("JBSWY3DPEHPK3PXP", "utf8"), cipher.final()]);
    const legacy = [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
    expect(decryptSecret(legacy)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("totp: encryptSecret y decryptSecret usan la etiqueta totp-secret y no abren los secretos de ajustes", () => {
    const enc = encryptSecret("ABC");
    expect(decryptSecret(enc)).toBe("ABC");
    expect(open("totp-secret", enc)).toBe("ABC");
    expect(() => decryptSecret(seal("settings-secret", "ABC"))).toThrow();
  });
});
