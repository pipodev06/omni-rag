import { closeDb } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { ensureInitialAdmin } from "./bootstrap.js";

/** `pnpm seed`: aplica migraciones y crea el primer administrador si no existe. */
await migrate();
await ensureInitialAdmin();
await closeDb();
