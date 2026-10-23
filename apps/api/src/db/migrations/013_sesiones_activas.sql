-- ---------------------------------------------------------------------
-- Sesiones activas
-- Cada inicio de sesión queda registrado (su id viaja en el token como `jti`). Así cada persona puede ver desde
-- qué dispositivos tiene la cuenta abierta y cerrar uno concreto, en vez de solo «cerrar todas».
-- Solo la API (conexión propietaria) accede a esta tabla; `rag_app` no tiene permisos sobre ella.
-- ---------------------------------------------------------------------
CREATE TABLE user_sessions (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ip           text,
  user_agent   text,
  revoked_at   timestamptz
);

CREATE INDEX user_sessions_user_idx ON user_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX user_sessions_expires_idx ON user_sessions (expires_at);
