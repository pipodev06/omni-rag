import { describe, expect, it } from "vitest";
import "./env.js";
import { quotaLevel } from "../src/lib/plans.js";

describe("aviso de cuota diaria", () => {
  it("sin límite (0) nunca avisa", () => {
    expect(quotaLevel(0, 0, 80)).toBe("unlimited");
    expect(quotaLevel(9999, 0, 80)).toBe("unlimited");
  });
  it("normal por debajo del umbral", () => {
    expect(quotaLevel(0, 200, 80)).toBe("ok");
    expect(quotaLevel(159, 200, 80)).toBe("ok");
  });
  it("avisa desde el umbral (80%) hasta antes del tope", () => {
    expect(quotaLevel(160, 200, 80)).toBe("warn");
    expect(quotaLevel(199, 200, 80)).toBe("warn");
  });
  it("agotada al llegar al límite", () => {
    expect(quotaLevel(200, 200, 80)).toBe("full");
    expect(quotaLevel(250, 200, 80)).toBe("full");
  });
  it("respeta otro umbral y límites pequeños", () => {
    expect(quotaLevel(5, 10, 50)).toBe("warn");
    expect(quotaLevel(4, 10, 50)).toBe("ok");
    expect(quotaLevel(1, 1, 80)).toBe("full");
  });
});
