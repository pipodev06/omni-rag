import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.js";
import { auditLog } from "../lib/audit.js";
import { badRequest, HttpError } from "../lib/errors.js";
import { clientIp } from "../lib/request.js";
import { checkSetupCode, clearSetupCode } from "../lib/setupCode.js";
import { parse } from "../lib/validate.js";
import { createInitialAdmin, initialAdminProblem, setupPending } from "../scripts/bootstrap.js";
import { startSession } from "./auth.js";

/**
 * Configuración inicial: mientras la base no tenga ningún usuario, la web crea aquí el superadministrador con el código
 * de un solo uso que la API escribe en sus registros. Sin sesión (aún no hay usuarios); el límite por IP de las
 * peticiones sin sesión también la protege. En cuanto existe un usuario, todo responde «ya configurado».
 */
export const setupRoutes = new Hono<AppEnv>();

setupRoutes.get("/", async (c) => c.json({ pending: await setupPending() }));

const SetupBody = z.object({
  code: z.string().trim().min(1).max(40),
  username: z.string().trim().toLowerCase().max(40),
  email: z.string().trim().toLowerCase().email().max(254).optional().or(z.literal("").transform(() => undefined)),
  password: z.string().min(1).max(200),
});

setupRoutes.post("/", async (c) => {
  const body = parse(SetupBody, await c.req.json().catch(() => ({})));
  if (!(await setupPending())) throw new HttpError(409, "Omni RAG ya está configurado. Inicia sesión.");
  if (!checkSetupCode(body.code)) {
    // Sin el código intentado: solo quién lo intentó.
    console.warn(`[setup] código de configuración incorrecto desde ${clientIp(c) ?? "IP desconocida"}`);
    throw new HttpError(403, "Código incorrecto. Míralo en los registros del servidor: docker compose logs api");
  }
  const admin = { username: body.username, email: body.email ?? null, password: body.password };
  const problem = initialAdminProblem(admin);
  if (problem) throw badRequest(problem);

  const user = await createInitialAdmin(admin);
  if (!user) throw new HttpError(409, "Omni RAG ya está configurado. Inicia sesión.");
  clearSetupCode();
  console.log(`[setup] configuración inicial hecha: superadministrador ${user.username}`);
  await auditLog({ tenantId: user.tenant_id, userId: user.id, username: user.username, ip: clientIp(c) }, "setup.completed");
  return c.json(await startSession(c, { ...user, role: "admin", is_superadmin: true }));
});
