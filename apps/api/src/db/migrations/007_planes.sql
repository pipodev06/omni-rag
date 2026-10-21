-- =============================================================================
-- Planes por organización.
--
-- Un plan define qué modelos de lenguaje se usan (en orden, con respaldo) y los
-- topes de la organización: preguntas por día, usuarios y documentos.
-- Solo el superadministrador los gestiona (la tabla no se concede a rag_app).
--
-- El plan por defecto nace con los valores del .env actual (LLM_MODELS y
-- TENANT_DAILY_QUESTION_LIMIT). Desde aquí se editan en la pantalla de Planes.
-- tenants.plan_id NULL = plan por defecto. tenants.daily_question_limit sigue
-- existiendo como excepción puntual que prevalece sobre el plan.
-- =============================================================================

CREATE TABLE plans (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  description           text NOT NULL DEFAULT '',
  llm_models            text[] NOT NULL CHECK (cardinality(llm_models) > 0),
  daily_question_limit  integer NOT NULL CHECK (daily_question_limit >= 0), -- 0 = sin límite
  max_users             integer CHECK (max_users >= 1),                     -- NULL = sin tope
  max_documents         integer CHECK (max_documents >= 1),                 -- NULL = sin tope
  is_default            boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX plans_name_key ON plans (lower(name));
CREATE UNIQUE INDEX plans_default_key ON plans ((true)) WHERE is_default;

INSERT INTO plans (name, description, llm_models, daily_question_limit, is_default)
VALUES (
  'Estándar',
  'Plan por defecto',
  ARRAY(SELECT trim(m) FROM unnest(string_to_array('{{LLM_MODELS}}', ',')) AS m WHERE trim(m) <> ''),
  {{TENANT_DAILY_QUESTION_LIMIT}},
  true
);

ALTER TABLE tenants ADD COLUMN plan_id uuid REFERENCES plans(id);
