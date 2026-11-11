import { BackoffLimiter } from "./rateLimit.js";

/**
 * Intentos del segundo factor (código TOTP o de recuperación) por usuario: 5 cada 15 min, y cada ventana agotada
 * duplica la siguiente (15 min, 30 min, 1 h) hasta 2 h; acertar lo reinicia. Un tope bajo a propósito: quien solo
 * conoce la contraseña no puede dejar a la cuenta sin entrar más de 2 h seguidas. Restablecer la contraseña (enlace,
 * administrador o Mi cuenta) también lo reinicia: `clearMfaAttempts`.
 */
export const mfaLimiter = new BackoffLimiter(5, 15 * 60 * 1000, 2 * 60 * 60 * 1000);

export const clearMfaAttempts = (userId: string): void => mfaLimiter.reset(userId);
