import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./auth/middleware.js";
import { HttpError } from "./lib/errors.js";
import { ipRateLimit } from "./lib/ipLimit.js";
import { currentRequestId } from "./lib/logger.js";
import { requestLog } from "./lib/requestLog.js";
import { authRoutes } from "./routes/auth.js";
import { userRoutes } from "./routes/users.js";
import { collectionRoutes } from "./routes/collections.js";
import { documentRoutes } from "./routes/documents.js";
import { chatRoutes } from "./routes/chat.js";
import { auditRoutes, platformRoutes, usageRoutes } from "./routes/admin.js";
import { healthRoutes } from "./routes/health.js";
import { feedbackRoutes, qualityRoutes } from "./routes/feedback.js";

/** Construye la aplicación HTTP (separado de server.ts para poder probarla). */
export function createApp() {
  const app = new Hono<AppEnv>();
  app.use("*", secureHeaders());
  app.use("*", requestLog);

  const api = new Hono<AppEnv>();
  api.use("*", ipRateLimit());
  api.route("/health", healthRoutes);
  api.route("/auth", authRoutes);
  api.route("/users", userRoutes);
  api.route("/collections", collectionRoutes);
  api.route("/documents", documentRoutes);
  api.route("/usage", usageRoutes);
  api.route("/platform", platformRoutes);
  api.route("/messages", feedbackRoutes);
  api.route("/quality", qualityRoutes);
  api.route("/audit", auditRoutes);
  api.route("/", chatRoutes); // /chat, /search, /conversations
  app.route("/api", api);

  app.notFound((c) => c.json({ error: "Ruta no encontrada" }, 404));
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message, ...(err.code && { code: err.code }) }, err.status);
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error("[api] error no controlado:", err);
    return c.json({ error: "Error interno del servidor", requestId: currentRequestId() }, 500);
  });
  return app;
}
