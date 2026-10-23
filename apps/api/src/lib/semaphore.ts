/**
 * Semáforo asíncrono: deja pasar como máximo `max` tareas a la vez y encola el resto por orden de llegada.
 * Sirve para no saturar un servicio que usa toda la CPU (p. ej. el re-ranker): en fila, la primera búsqueda
 * termina pronto; todas a la vez, terminan todas tarde y pueden agotar su tiempo de espera.
 */
export class Semaphore {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  /** Ejecuta `fn` cuando haya un hueco libre. Si `signal` se cancela mientras espera, se abandona la cola. */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get queued(): number {
    return this.waiting.length;
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const turn = () => {
        signal?.removeEventListener("abort", onAbort);
        this.active++;
        resolve();
      };
      const onAbort = () => {
        this.waiting = this.waiting.filter((w) => w !== turn);
        reject(signal!.reason instanceof Error ? signal!.reason : new Error("cancelado"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(turn);
    });
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }
}
