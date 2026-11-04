-- ---------------------------------------------------------------------
-- Estado de las copias de seguridad (pantalla Sistema → Copias, solo superadministrador)
-- El worker lee cada 5 minutos la carpeta de copias y el estado que dejan deploy/backup.sh y deploy/b2-sync.sh, y lo
-- guarda aquí: la API nunca monta la carpeta de copias (contiene la base entera sin cifrar). Una sola fila, sin
-- secretos. Como las demás tablas de plataforma, solo la usa la conexión propietaria.
-- ---------------------------------------------------------------------
CREATE TABLE backup_snapshot (
  id   integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  at   timestamptz NOT NULL DEFAULT now(),
  info jsonb NOT NULL
);
