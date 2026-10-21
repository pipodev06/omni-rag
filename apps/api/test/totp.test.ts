import { describe, expect, it } from "vitest";
import "./env.js";
import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  hotp,
  normalizeRecoveryCode,
  verifyTotp,
} from "../src/lib/totp.js";

// Vectores de la RFC 6238 (secreto ASCII "12345678901234567890"; se comparan los 6 últimos dígitos de los de 8).
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("TOTP", () => {
  it("coincide con los vectores de la RFC 6238", () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(hotp(RFC_SECRET, Math.floor(59 / 30))).toBe("287082");
    expect(hotp(RFC_SECRET, Math.floor(1111111109 / 30))).toBe("081804");
    expect(hotp(RFC_SECRET, Math.floor(20000000000 / 30))).toBe("353130");
  });

  it("base32 va y vuelve", () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(secret))).toBe(secret);
  });

  it("acepta el intervalo actual y los vecinos, pero no uno lejano", () => {
    const now = 1111111109 * 1000;
    const step = Math.floor(now / 1000 / 30);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step), null, now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), null, now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 3), null, now)).toBeNull();
  });

  it("no deja reutilizar un código ya consumido", () => {
    const now = 1111111109 * 1000;
    const step = Math.floor(now / 1000 / 30);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step), step, now)).toBeNull();
  });

  it("rechaza lo que no son 6 dígitos", () => {
    expect(verifyTotp(RFC_SECRET, "12345", null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "abcdef", null)).toBeNull();
  });

  it("cifra el secreto y detecta manipulación", () => {
    const secret = generateSecret();
    const stored = encryptSecret(secret);
    expect(stored).not.toContain(secret);
    expect(decryptSecret(stored)).toBe(secret);
    const [iv, tag, data] = stored.split(".");
    const tampered = [iv, tag, Buffer.from("xx").toString("base64") + data!.slice(4)].join(".");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("los códigos de recuperación son únicos y se comparan sin guiones ni mayúsculas", () => {
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(8);
    expect(codes[0]).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect(hashRecoveryCode(codes[0]!.toUpperCase())).toBe(hashRecoveryCode(normalizeRecoveryCode(codes[0]!)));
  });
});
