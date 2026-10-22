-- =============================================================================
-- Avisos por correo de la cuota diaria.
--
-- Cuando una organización llega al porcentaje de aviso (QUOTA_WARN_PERCENT) o al tope de su
-- límite diario, se avisa por correo a sus administradores UNA sola vez por día y nivel.
-- La clave primaria hace que el INSERT sea el cerrojo: si dos preguntas coinciden, solo una envía.
-- Solo la usa la conexión propietaria (no se concede a rag_app).
-- =============================================================================

CREATE TABLE quota_notices (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day        date NOT NULL,                              -- día en UTC
  level      text NOT NULL CHECK (level IN ('warn', 'full')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day, level)
);
