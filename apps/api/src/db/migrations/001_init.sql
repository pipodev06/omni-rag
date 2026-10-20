-- =====================================================================
-- 001_init.sql — Esquema inicial del RAG multi-cliente
--
-- Marcadores que reemplaza el script de migración (src/db/migrate.ts):
--   {{EMBEDDING_DIM}}  dimensión del modelo de embeddings (p. ej. 768)
--   {{FTS_LANGUAGE}}   configuración de búsqueda de texto (p. ej. spanish)
--
-- Modelo de permisos (ver docs/permisos.md):
--   * Cada fila pertenece a una organización (tenant_id).
--   * El backend se conecta como `rag_app` y, en cada transacción, fija
--     app.tenant_id, app.user_id y app.role. Las políticas RLS de abajo
--     impiden ver o modificar filas de otra organización o de colecciones
--     a las que el usuario no tiene acceso.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------
-- Funciones auxiliares que leen el contexto de la transacción
-- ---------------------------------------------------------------------
CREATE FUNCTION app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app_role() RETURNS text
  LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('app.role', true), '') $$;

-- ---------------------------------------------------------------------
-- Organizaciones (clientes) y usuarios
-- ---------------------------------------------------------------------
CREATE TABLE tenants (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  slug                  text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  daily_question_limit  integer CHECK (daily_question_limit >= 0), -- NULL = usar el valor global
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE user_role AS ENUM ('admin', 'editor', 'viewer');

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email          text NOT NULL,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  role           user_role NOT NULL DEFAULT 'viewer',
  is_superadmin  boolean NOT NULL DEFAULT false, -- dueño de la plataforma: puede crear organizaciones
  is_active      boolean NOT NULL DEFAULT true,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id) -- permite claves foráneas compuestas (ver abajo)
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));
CREATE INDEX users_tenant_idx ON users (tenant_id);

-- ---------------------------------------------------------------------
-- Colecciones (carpetas) y quién puede verlas
-- ---------------------------------------------------------------------
CREATE TABLE collections (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (id, tenant_id)
);

CREATE TABLE collection_members (
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  collection_id  uuid NOT NULL,
  user_id        uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, user_id),
  -- Claves compuestas: imposible enlazar una colección o usuario de otra organización.
  FOREIGN KEY (collection_id, tenant_id) REFERENCES collections(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, tenant_id) REFERENCES users(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX collection_members_user_idx ON collection_members (user_id);

-- ¿Puede el usuario actual acceder a la colección?
-- La colección debe ser de su organización y, salvo que sea admin, debe ser miembro.
-- SECURITY DEFINER: se ejecuta con permisos del dueño para poder consultar
-- `collections` sin recursión de políticas RLS.
CREATE FUNCTION app_can_access_collection(cid uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT EXISTS (
           SELECT 1 FROM collections c
            WHERE c.id = cid AND c.tenant_id = app_tenant_id()
         )
     AND (
           app_role() = 'admin'
           OR EXISTS (
                SELECT 1 FROM collection_members m
                 WHERE m.collection_id = cid
                   AND m.user_id = app_user_id()
              )
         )
$$;

-- ---------------------------------------------------------------------
-- Documentos y fragmentos (chunks) con su embedding
-- ---------------------------------------------------------------------
CREATE TABLE documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  collection_id  uuid NOT NULL,
  title          text NOT NULL,
  filename       text NOT NULL,
  mime_type      text NOT NULL,
  size_bytes     bigint NOT NULL,
  sha256         text NOT NULL,
  storage_key    text NOT NULL,
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  error          text,
  page_count     integer,
  chunk_count    integer NOT NULL DEFAULT 0,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection_id, sha256), -- evita subir el mismo archivo dos veces a la misma colección
  UNIQUE (id, tenant_id),
  FOREIGN KEY (collection_id, tenant_id) REFERENCES collections(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX documents_tenant_collection_idx ON documents (tenant_id, collection_id, created_at DESC);

CREATE TABLE chunks (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  collection_id  uuid NOT NULL,
  document_id    uuid NOT NULL,
  chunk_index    integer NOT NULL,
  heading        text NOT NULL DEFAULT '',
  content        text NOT NULL,
  page_start     integer,
  page_end       integer,
  embedding      vector({{EMBEDDING_DIM}}) NOT NULL,
  tsv            tsvector GENERATED ALWAYS AS (
                   to_tsvector('{{FTS_LANGUAGE}}'::regconfig, heading || ' ' || content)
                 ) STORED,
  UNIQUE (document_id, chunk_index),
  FOREIGN KEY (document_id, tenant_id) REFERENCES documents(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id, tenant_id) REFERENCES collections(id, tenant_id) ON DELETE CASCADE
);
-- Búsqueda semántica (distancia coseno) con índice HNSW.
CREATE INDEX chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops);
-- Búsqueda por palabras clave.
CREATE INDEX chunks_tsv_gin ON chunks USING gin (tsv);
CREATE INDEX chunks_tenant_collection_idx ON chunks (tenant_id, collection_id);

-- ---------------------------------------------------------------------
-- Conversaciones (privadas de cada usuario)
-- ---------------------------------------------------------------------
CREATE TABLE conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  title       text NOT NULL DEFAULT 'Nueva conversación',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  FOREIGN KEY (user_id, tenant_id) REFERENCES users(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX conversations_user_idx ON conversations (user_id, updated_at DESC);

CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL,
  conversation_id  uuid NOT NULL,
  role             text NOT NULL CHECK (role IN ('user', 'assistant')),
  content          text NOT NULL,
  sources          jsonb NOT NULL DEFAULT '[]',
  model            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- El mensaje solo puede ir en una conversación del mismo usuario.
  FOREIGN KEY (conversation_id, user_id) REFERENCES conversations(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, tenant_id) REFERENCES users(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);

-- ---------------------------------------------------------------------
-- Registro de consumo (para límites por organización y reportes)
-- ---------------------------------------------------------------------
CREATE TABLE usage_events (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  kind               text NOT NULL, -- 'question'
  model              text,
  prompt_tokens      integer,
  completion_tokens  integer,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_tenant_day_idx ON usage_events (tenant_id, kind, created_at);

-- =====================================================================
-- Row Level Security
-- El dueño de las tablas (conexión DATABASE_URL) no está sujeto a RLS;
-- `rag_app` (APP_DATABASE_URL) sí.
-- =====================================================================
ALTER TABLE tenants            ENABLE ROW LEVEL SECURITY;
ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE collections        ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunks             ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages           ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events       ENABLE ROW LEVEL SECURITY;

-- Organización: solo la propia, solo lectura.
CREATE POLICY tenant_read ON tenants FOR SELECT USING (id = app_tenant_id());

-- Usuarios: todos ven a los de su organización; solo admin los gestiona.
CREATE POLICY users_read  ON users FOR SELECT USING (tenant_id = app_tenant_id());
CREATE POLICY users_write ON users FOR ALL
  USING (tenant_id = app_tenant_id() AND app_role() = 'admin')
  WITH CHECK (tenant_id = app_tenant_id() AND app_role() = 'admin' AND is_superadmin = false);
-- Cualquiera puede actualizar su propia fila (p. ej. last_login_at, contraseña).
CREATE POLICY users_self_update ON users FOR UPDATE
  USING (tenant_id = app_tenant_id() AND id = app_user_id())
  WITH CHECK (tenant_id = app_tenant_id() AND id = app_user_id());

-- Colecciones: se ven las accesibles; solo admin crea/edita/borra.
CREATE POLICY collections_read ON collections FOR SELECT
  USING (tenant_id = app_tenant_id() AND app_can_access_collection(id));
CREATE POLICY collections_write ON collections FOR ALL
  USING (tenant_id = app_tenant_id() AND app_role() = 'admin')
  WITH CHECK (tenant_id = app_tenant_id() AND app_role() = 'admin');

CREATE POLICY members_read ON collection_members FOR SELECT
  USING (tenant_id = app_tenant_id());
CREATE POLICY members_write ON collection_members FOR ALL
  USING (tenant_id = app_tenant_id() AND app_role() = 'admin')
  WITH CHECK (tenant_id = app_tenant_id() AND app_role() = 'admin');

-- Documentos y chunks: lectura si hay acceso a la colección;
-- escritura además requiere rol admin o editor.
CREATE POLICY documents_read ON documents FOR SELECT
  USING (tenant_id = app_tenant_id() AND app_can_access_collection(collection_id));
CREATE POLICY documents_write ON documents FOR ALL
  USING (tenant_id = app_tenant_id() AND app_role() IN ('admin', 'editor')
         AND app_can_access_collection(collection_id))
  WITH CHECK (tenant_id = app_tenant_id() AND app_role() IN ('admin', 'editor')
              AND app_can_access_collection(collection_id));

CREATE POLICY chunks_read ON chunks FOR SELECT
  USING (tenant_id = app_tenant_id() AND app_can_access_collection(collection_id));
CREATE POLICY chunks_write ON chunks FOR ALL
  USING (tenant_id = app_tenant_id() AND app_role() IN ('admin', 'editor')
         AND app_can_access_collection(collection_id))
  WITH CHECK (tenant_id = app_tenant_id() AND app_role() IN ('admin', 'editor')
              AND app_can_access_collection(collection_id));

-- Conversaciones y mensajes: privados de cada usuario.
CREATE POLICY conversations_own ON conversations FOR ALL
  USING (tenant_id = app_tenant_id() AND user_id = app_user_id())
  WITH CHECK (tenant_id = app_tenant_id() AND user_id = app_user_id());
CREATE POLICY messages_own ON messages FOR ALL
  USING (tenant_id = app_tenant_id() AND user_id = app_user_id())
  WITH CHECK (tenant_id = app_tenant_id() AND user_id = app_user_id());

-- Consumo: cualquiera registra el suyo y ve el de su organización (para el límite diario).
CREATE POLICY usage_insert ON usage_events FOR INSERT
  WITH CHECK (tenant_id = app_tenant_id() AND user_id = app_user_id());
CREATE POLICY usage_read ON usage_events FOR SELECT
  USING (tenant_id = app_tenant_id());

-- ---------------------------------------------------------------------
-- Permisos del usuario de aplicación
-- ---------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO rag_app;
GRANT SELECT ON tenants TO rag_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, collections, collection_members, documents, chunks,
  conversations, messages, usage_events
TO rag_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO rag_app;
REVOKE ALL ON FUNCTION app_can_access_collection(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_can_access_collection(uuid) TO rag_app;
