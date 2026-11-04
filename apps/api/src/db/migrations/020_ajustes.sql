-- ---------------------------------------------------------------------
-- Ajustes editables desde la pantalla Sistema → Configuración (solo superadministrador) y órdenes a los scripts de copia
-- La clave de cada ajuste es el nombre de su variable de entorno (ALERT_EMAIL, BACKUP_AT…). Una variable escrita en el
-- .env manda sobre lo guardado aquí y la pantalla la muestra bloqueada. Los secretos (claves de API, contraseña SMTP,
-- claves de B2) van cifrados en `secret` (AES-256-GCM, clave derivada de JWT_SECRET) y `value` queda NULL.
-- Como las demás tablas de plataforma, solo las usa la conexión propietaria (API, worker y el servicio backup).
-- ---------------------------------------------------------------------
CREATE TABLE settings (
  key        text PRIMARY KEY CHECK (key ~ '^[A-Z][A-Z0-9_]*$'),
  value      jsonb,
  secret     text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  CHECK (value IS NULL OR secret IS NULL)
);

-- Órdenes de la pantalla al servicio backup (que no expone ningún puerto): las lee cada minuto con psql.
--   backup      = hacer una copia ahora.
--   destination = cambiar la carpeta externa: payload { path, moveExisting }.
CREATE TABLE backup_requests (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('backup', 'destination')),
  payload      jsonb NOT NULL DEFAULT '{}',
  requested_by text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  ok           boolean,
  message      text
);
CREATE INDEX backup_requests_pending ON backup_requests (id) WHERE started_at IS NULL;
