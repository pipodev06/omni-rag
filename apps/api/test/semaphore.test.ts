import { describe, expect, it } from "vitest";
import { Semaphore } from "../src/lib/semaphore.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("semáforo", () => {
  it("deja pasar como máximo N a la vez y respeta el orden de llegada", async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];
    let running = 0;
    let peak = 0;
    const job = (name: string) =>
      sem.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await sleep(15);
        order.push(name);
        running--;
      });
    await Promise.all([job("a"), job("b"), job("c")]);
    expect(order).toEqual(["a", "b", "c"]);
    expect(peak).toBe(1);
  });

  it("con 2 huecos ejecuta dos a la vez", async () => {
    const sem = new Semaphore(2);
    let running = 0;
    let peak = 0;
    await Promise.all(
      [1, 2, 3, 4].map(() =>
        sem.run(async () => {
          running++;
          peak = Math.max(peak, running);
          await sleep(15);
          running--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  it("libera el hueco aunque la tarea falle", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => Promise.reject(new Error("falló")))).rejects.toThrow("falló");
    await expect(sem.run(async () => "ok")).resolves.toBe("ok");
  });

  it("quien cancela mientras espera sale de la cola sin ocupar un hueco", async () => {
    const sem = new Semaphore(1);
    const ctrl = new AbortController();
    const first = sem.run(() => sleep(30));
    const waiting = sem.run(async () => "nunca", ctrl.signal);
    expect(sem.queued).toBe(1);
    ctrl.abort();
    await expect(waiting).rejects.toBeDefined();
    expect(sem.queued).toBe(0);
    await first;
    await expect(sem.run(async () => "libre")).resolves.toBe("libre");
  });
});
