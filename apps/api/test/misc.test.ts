import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/lib/rateLimit.js";

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
