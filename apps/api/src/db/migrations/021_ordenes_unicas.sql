-- ---------------------------------------------------------------------
-- Órdenes de copias: como mucho una sin terminar a la vez, garantizado por la base (dos clics simultáneos no crean dos).
-- Antes de crear el índice se cierran las sobrantes (se conserva la más reciente) para que la migración no falle.
-- ---------------------------------------------------------------------
UPDATE backup_requests
   SET started_at = coalesce(started_at, now()), finished_at = now(), ok = false, message = 'caducada'
 WHERE finished_at IS NULL
   AND id <> (SELECT max(id) FROM backup_requests WHERE finished_at IS NULL);

CREATE UNIQUE INDEX backup_requests_una_abierta ON backup_requests ((true)) WHERE finished_at IS NULL;
