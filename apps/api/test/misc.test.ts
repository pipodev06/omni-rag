import { describe, expect, it } from "vitest";
import "./env.js";
import { RateLimiter } from "../src/lib/rateLimit.js";
import { OptionalEmailSchema, UsernameSchema } from "../src/lib/validate.js";
import { safeFilename, titleFromFilename } from "../src/storage/local.js";

describe("RateLimiter", () => {
  it("bloquea al superar el máximo y se reinicia al pasar la ventana", () => {
    const rl = new RateLimiter(2, 1000);
    expect(rl.hit("k", 0)).toBe(true);
    expect(rl.hit("k", 10)).toBe(true);
    expect(rl.hit("k", 20)).toBe(false);
    expect(rl.hit("otra", 20)).toBe(true);
    expect(rl.hit("k", 1001)).toBe(true);
  });

  it("reset borra el contador", () => {
    const rl = new RateLimiter(1, 1000);
    rl.hit("k", 0);
    rl.reset("k");
    expect(rl.hit("k", 1)).toBe(true);
  });
});

describe("nombre de usuario", () => {
  it("normaliza a minúsculas y acepta el formato permitido", () => {
    expect(UsernameSchema.parse("  Ana.Perez_01 ")).toBe("ana.perez_01");
  });
  it("rechaza espacios, arrobas, acentos y longitudes fuera de rango", () => {
    for (const bad of ["ab", "a b c", "ana@mail.com", "pérez", "x".repeat(41), "-ana"]) {
      expect(UsernameSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
  it("el email opcional acepta vacío como «sin email»", () => {
    expect(OptionalEmailSchema.parse("")).toBeNull();
    expect(OptionalEmailSchema.parse(undefined)).toBeUndefined();
    expect(OptionalEmailSchema.safeParse("no-es-email").success).toBe(false);
  });
});

describe("nombres de archivo con acentos", () => {
  it("el nombre guardado pierde los acentos sin dejar guiones bajos sueltos", () => {
    expect(safeFilename("CV Piter Muñoz_Pérez 2026.pdf")).toBe("CV_Piter_Munoz_Perez_2026.pdf");
    expect(safeFilename("../../etc/pasión.txt")).toBe("pasion.txt");
  });
  it("el título conserva eñes y acentos", () => {
    expect(titleFromFilename("CV Piter Muñoz_Pérez 2026.pdf")).toBe("CV Piter Muñoz Pérez 2026");
    // También si el sistema envió el nombre descompuesto (n + tilde).
    expect(titleFromFilename("Muñoz_Pérez.docx")).toBe("Muñoz Pérez");
    expect(titleFromFilename("informe-final_v2.xlsx")).toBe("informe final v2");
  });
});
