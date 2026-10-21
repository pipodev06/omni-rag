-- =====================================================================
-- 003_experiencia.sql — Resumen por documento y avisos en tiempo real
-- =====================================================================

-- ---------------------------------------------------------------------
-- Resumen y preguntas sugeridas (se generan bajo demanda con el LLM)
-- ---------------------------------------------------------------------
ALTER TABLE documents
  ADD COLUMN summary             text,
  ADD COLUMN suggested_questions text[] NOT NULL DEFAULT '{}',
  ADD COLUMN summary_model       text,
  ADD COLUMN summary_at          timestamptz;

-- ---------------------------------------------------------------------
-- Avisos de cambios de estado de documentos (LISTEN/NOTIFY)
-- La API escucha el canal `document_events` y reenvía cada aviso, por
-- Server-Sent Events, solo a los usuarios con acceso a esa colección.
-- ---------------------------------------------------------------------
CREATE FUNCTION notify_document_event() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE
  d documents;
BEGIN
  d := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  PERFORM pg_notify('document_events', json_build_object(
    'op', lower(TG_OP),
    'tenantId', d.tenant_id,
    'collectionId', d.collection_id,
    'documentId', d.id,
    'title', d.title,
    'status', d.status,
    'error', left(d.error, 300), -- NOTIFY admite como máximo 8000 bytes
    'createdBy', d.created_by
  )::text);
  RETURN NULL;
END
$$;

CREATE TRIGGER documents_notify_insert_delete
  AFTER INSERT OR DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION notify_document_event();

CREATE TRIGGER documents_notify_status
  AFTER UPDATE ON documents
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.summary_at IS DISTINCT FROM NEW.summary_at)
  EXECUTE FUNCTION notify_document_event();
