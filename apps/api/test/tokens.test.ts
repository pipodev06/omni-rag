import { describe, expect, it } from "vitest";
import "./env.js";
import { hashToken, linkFor } from "../src/lib/tokens.js";

describe("enlaces de acceso", () => {
  it("guarda solo el hash (determinista y distinto del token)", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).not.toBe("abc");
    expect(hashToken("abc")).toHaveLength(64);
  });
  it("construye la URL pública según el tipo", () => {
    expect(linkFor("invite", "t1")).toMatch(/\/activar\?token=t1$/);
    expect(linkFor("reset", "a+b")).toMatch(/\/restablecer\?token=a%2Bb$/);
  });
});
