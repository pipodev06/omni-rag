-- =====================================================================
-- 004_produccion.sql — Invitaciones, recuperación de contraseña y auditoría
-- =====================================================================

-- Un usuario invitado no tiene contraseña hasta que acepta la invitación.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- ---------------------------------------------------------------------
-- Enlaces de un solo uso (invitación y restablecimiento de contraseña).
-- Solo se guarda el hash SHA-256 del token, nunca el token en claro.
-- Se usan antes de iniciar sesión, así que solo los maneja la conexión
-- propietaria: `rag_app` no tiene ningún permiso sobre esta tabla.
-- ---------------------------------------------------------------------
CREATE TABLE user_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('invite', 'reset')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, tenant_id) REFERENCES users(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX user_tokens_user_idx ON user_tokens (user_id, kind);
ALTER TABLE user_tokens ENABLE ROW LEVEL SECURITY; -- sin políticas: rag_app no ve nada

-- ---------------------------------------------------------------------
-- Registro de auditoría: quién hizo qué y cuándo.
-- Se escribe con la conexión propietaria (no puede falsearse desde la app)
-- y lo leen los administradores de cada organización.
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      uuid,
  user_email   text,
  action       text NOT NULL,       -- p. ej. 'document.deleted'
  target_type  text,
  target_id    text,
  details      jsonb NOT NULL DEFAULT '{}',
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant_idx ON audit_log (tenant_id, id DESC);
CREATE INDEX audit_log_action_idx ON audit_log (tenant_id, action);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_admin_read ON audit_log FOR SELECT
  USING (tenant_id = app_tenant_id() AND app_role() = 'admin');

GRANT SELECT ON audit_log TO rag_app;
