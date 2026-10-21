-- =============================================================================
-- Acceso de soporte del superadministrador a cualquier organización.
--
-- Cuando el dueño de la plataforma "entra" en una organización, se usa una
-- cuenta de soporte propia de esa organización, enlazada a su usuario real
-- (support_for). Así las claves foráneas compuestas, el RLS y el historial de
-- chat funcionan igual que para cualquier administrador, sin excepciones.
-- La cuenta no tiene contraseña: solo se puede usar desde la sesión del
-- superadministrador, y cada entrada/salida queda en la auditoría del cliente.
-- =============================================================================

ALTER TABLE users ADD COLUMN support_for uuid REFERENCES users(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX users_support_key ON users (support_for, tenant_id) WHERE support_for IS NOT NULL;

-- Los administradores del cliente no pueden modificar ni borrar la cuenta de soporte.
DROP POLICY users_write ON users;
CREATE POLICY users_write ON users FOR ALL
  USING (tenant_id = app_tenant_id() AND app_role() = 'admin' AND support_for IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_role() = 'admin' AND is_superadmin = false AND support_for IS NULL);
