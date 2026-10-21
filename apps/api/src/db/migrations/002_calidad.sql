-- =====================================================================
-- 002_calidad.sql — Caché de respuestas y valoraciones (👍/👎)
-- Marcadores: {{EMBEDDING_DIM}} (ver migrate.ts)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Caché de respuestas
-- Una respuesta solo se reutiliza para el MISMO conjunto de colecciones
-- consultables (scope_key) dentro de la misma organización. Se invalida
-- cuando cambia cualquier documento de esas colecciones.
-- ---------------------------------------------------------------------
CREATE TABLE answer_cache (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope_key         text NOT NULL,           -- hash de las colecciones consultadas
  collection_ids    uuid[] NOT NULL,         -- para invalidar por colección
  question          text NOT NULL,
  question_norm     text NOT NULL,           -- pregunta normalizada (minúsculas, sin tildes ni signos)
  question_numbers  text[] NOT NULL DEFAULT '{}', -- números/códigos de la pregunta (deben coincidir)
  embedding         vector({{EMBEDDING_DIM}}) NOT NULL,
  answer            text NOT NULL,
  sources           jsonb NOT NULL,
  model             text,
  message_id        uuid,                    -- respuesta original (para invalidar si recibe 👎)
  hits              integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_hit_at       timestamptz
);
CREATE INDEX answer_cache_lookup ON answer_cache (tenant_id, scope_key, question_norm);
CREATE INDEX answer_cache_collections ON answer_cache USING gin (collection_ids);
CREATE INDEX answer_cache_message ON answer_cache (message_id);

ALTER TABLE answer_cache ENABLE ROW LEVEL SECURITY;
-- Cualquier usuario de la organización puede leer, crear e invalidar entradas
-- de su organización. Que el conjunto de colecciones coincida lo comprueba la API.
CREATE POLICY answer_cache_tenant ON answer_cache FOR ALL
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- Los mensajes servidos desde la caché se marcan para mostrarlo en la interfaz.
ALTER TABLE messages
  ADD COLUMN from_cache boolean NOT NULL DEFAULT false,
  ADD COLUMN cache_id uuid;

-- ---------------------------------------------------------------------
-- Valoraciones de respuestas
-- Se guarda una copia de la pregunta, la respuesta y las fuentes para que
-- los administradores puedan revisarla (las conversaciones son privadas).
-- ---------------------------------------------------------------------
CREATE TABLE message_feedback (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,
  message_id   uuid UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
  rating       smallint NOT NULL CHECK (rating IN (-1, 1)),
  comment      text NOT NULL DEFAULT '',
  question     text NOT NULL,
  answer       text NOT NULL,
  sources      jsonb NOT NULL DEFAULT '[]',
  model        text,
  from_cache   boolean NOT NULL DEFAULT false,
  resolved     boolean NOT NULL DEFAULT false, -- revisada por un administrador
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, tenant_id) REFERENCES users(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX message_feedback_tenant_idx ON message_feedback (tenant_id, rating, created_at DESC);

ALTER TABLE message_feedback ENABLE ROW LEVEL SECURITY;
-- Cada usuario gestiona sus valoraciones, y solo sobre mensajes propios
-- (la subconsulta sobre `messages` ya está filtrada por su RLS).
CREATE POLICY feedback_own ON message_feedback FOR ALL
  USING (tenant_id = app_tenant_id() AND user_id = app_user_id())
  WITH CHECK (
    tenant_id = app_tenant_id() AND user_id = app_user_id()
    AND (message_id IS NULL OR EXISTS (SELECT 1 FROM messages m WHERE m.id = message_id))
  );
-- Los administradores ven y marcan como revisadas las de su organización.
CREATE POLICY feedback_admin_read ON message_feedback FOR SELECT
  USING (tenant_id = app_tenant_id() AND app_role() = 'admin');
CREATE POLICY feedback_admin_update ON message_feedback FOR UPDATE
  USING (tenant_id = app_tenant_id() AND app_role() = 'admin')
  WITH CHECK (tenant_id = app_tenant_id() AND app_role() = 'admin');

GRANT SELECT, INSERT, UPDATE, DELETE ON answer_cache, message_feedback TO rag_app;
