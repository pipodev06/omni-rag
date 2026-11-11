import { describe, expect, it } from "vitest";
import "./env.js";
import { BackoffLimiter, RateLimiter } from "../src/lib/rateLimit.js";
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

  it("con el tope de claves lleno no borra contadores vigentes: las claves nuevas quedan limitadas", () => {
    const rl = new RateLimiter(2, 1000, 3);
    expect(rl.hit("victima", 0)).toBe(true);
    expect(rl.hit("victima", 1)).toBe(true);
    expect(rl.hit("a", 2)).toBe(true);
    expect(rl.hit("b", 3)).toBe(true);
    expect(rl.hit("c", 4)).toBe(false); // lleno: la clave nueva no entra
    expect(rl.hit("victima", 5)).toBe(false); // su contador sigue vigente (no se reinició)
    expect(rl.hit("c", 1001)).toBe(true); // vencidas las viejas, vuelve a haber sitio
  });
});

describe("clave de IP de los limitadores", () => {
  it("IPv4 tal cual; IPv6 agrupada por su /64 (con o sin abreviar)", async () => {
    const { ipLimitKey } = await import("../src/lib/request.js");
    expect(ipLimitKey("203.0.113.7")).toBe("203.0.113.7");
    expect(ipLimitKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(ipLimitKey("2001:0db8:0001:0002:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2::/64");
    expect(ipLimitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipLimitKey("::1")).toBe("0:0:0:0::/64");
  });
});

describe("BackoffLimiter (segundo factor)", () => {
  it("cada ventana agotada duplica la siguiente y un acierto lo reinicia", () => {
    const rl = new BackoffLimiter(2, 100, 1000);
    expect(rl.hit("u", 0)).toBe(true);
    expect(rl.hit("u", 1)).toBe(true);
    expect(rl.hit("u", 2)).toBe(false); // agotada la 1.ª ventana (0–100)
    expect(rl.hit("u", 100)).toBe(true); // 2.ª ventana: dura 200 (hasta 300)
    expect(rl.hit("u", 101)).toBe(true);
    expect(rl.hit("u", 299)).toBe(false); // sigue bloqueado pasados 100 ms
    expect(rl.hit("u", 300)).toBe(true); // 3.ª ventana: dura 400
    rl.reset("u");
    expect(rl.hit("u", 301)).toBe(true);
    expect(rl.hit("u", 302)).toBe(true);
    expect(rl.hit("u", 303)).toBe(false);
    expect(rl.hit("u", 401)).toBe(true); // tras el acierto, vuelve a la ventana base (100)
  });

  it("usar justo el máximo y esperar también cuenta; no pasa de la espera máxima", () => {
    const rl = new BackoffLimiter(1, 100, 300);
    for (const [t, ok] of [[0, true], [100, true], [299, false], [300, true], [599, false], [600, true], [899, false], [900, true]] as const) {
      expect(rl.hit("u", t)).toBe(ok);
    }
  });

  it("una ventana sin agotar vuelve a la base", () => {
    const rl = new BackoffLimiter(3, 100, 1000);
    rl.hit("u", 0); // 1 de 3: no se agota
    expect(rl.hit("u", 100)).toBe(true);
    expect(rl.hit("u", 199)).toBe(true);
    expect(rl.hit("u", 199)).toBe(true);
    expect(rl.hit("u", 199)).toBe(false);
    expect(rl.hit("u", 200)).toBe(true); // la base, no el doble
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
