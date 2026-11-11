/**
 * Limitador de intentos en memoria (ventana fija). Suficiente para frenar
 * ataques de fuerza bruta al login en una instalación de un solo servidor.
 *
 * Memoria acotada a `maxKeys` claves. Si se llena de claves vigentes, las claves NUEVAS cuentan como limitadas hasta
 * que venzan las viejas: nunca se borra un contador vigente, porque eso dejaría reiniciar el propio contador
 * inundando el mapa con claves distintas. Las claves ya registradas siguen contando normal.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 50_000,
  ) {}

  /** Registra un intento. Devuelve false si se superó el límite (o si está lleno y la clave es nueva). */
  hit(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (!entry && this.hits.size >= this.maxKeys) {
        this.cleanup(now, true);
        if (this.hits.size >= this.maxKeys) return false;
      }
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      this.cleanup(now);
      return true;
    }
    entry.count++;
    return entry.count <= this.max;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Borra las claves vencidas; sin `force`, solo cuando ya hay muchas (para no recorrer el mapa en cada intento). */
  private cleanup(now: number, force = false) {
    if (!force && this.hits.size < 10_000) return;
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}

/**
 * Limitador con espera creciente (segundo factor): `max` intentos por ventana; cada ventana agotada duplica la
 * siguiente (base, 2×, 4×… hasta `maxMs`). Una ventana sin agotar vuelve a la base; `reset` (acierto) lo borra todo.
 * En memoria: un reinicio del servidor lo pone a cero. Memoria acotada como RateLimiter (claves nuevas limitadas si
 * se llena).
 */
export class BackoffLimiter {
  private hits = new Map<string, { count: number; resetAt: number; strikes: number }>();

  constructor(
    private readonly max: number,
    private readonly baseMs: number,
    private readonly maxMs = 24 * 60 * 60 * 1000,
    private readonly maxKeys = 50_000,
  ) {}

  private windowMs(strikes: number) {
    return Math.min(this.baseMs * 2 ** strikes, this.maxMs);
  }

  /** Registra un intento. Devuelve false si está bloqueado. */
  hit(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry) {
      if (this.hits.size >= this.maxKeys) {
        this.cleanup(now);
        if (this.hits.size >= this.maxKeys) return false;
      }
      this.hits.set(key, { count: 1, resetAt: now + this.baseMs, strikes: 0 });
      return true;
    }
    if (entry.resetAt <= now) {
      // La ventana anterior terminó: si se usaron todos los intentos sin acertar, la siguiente dura el doble; si no,
      // se vuelve a la base. (>= y no >: usar justo los `max` y esperar también cuenta.)
      entry.strikes = entry.count >= this.max ? entry.strikes + 1 : 0;
      entry.count = 1;
      entry.resetAt = now + this.windowMs(entry.strikes);
      return true;
    }
    entry.count++;
    return entry.count <= this.max;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Borra lo que ya no puede bloquear a nadie: ventanas vencidas hace más de la espera máxima. */
  private cleanup(now: number) {
    for (const [k, v] of this.hits) if (v.resetAt + this.maxMs <= now) this.hits.delete(k);
  }
}
