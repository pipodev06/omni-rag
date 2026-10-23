-- ---------------------------------------------------------------------
-- Papelera de documentos
-- Borrar un documento lo marca con `deleted_at`: deja de verse, de contar para el plan y de aparecer en las
-- respuestas, pero el archivo, los fragmentos y los vectores se conservan para poder restaurarlo al instante.
-- Pasados TRASH_RETENTION_DAYS días (o si un administrador lo elimina definitivamente) se borra de verdad.
-- ---------------------------------------------------------------------
ALTER TABLE documents
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX documents_trash_idx ON documents (tenant_id, deleted_at) WHERE deleted_at IS NOT NULL;

-- Que las pantallas de los demás usuarios se actualicen también al mandar a la papelera o restaurar.
DROP TRIGGER documents_notify_status ON documents;
CREATE TRIGGER documents_notify_status
  AFTER UPDATE ON documents
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
        OR OLD.summary_at IS DISTINCT FROM NEW.summary_at
        OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION notify_document_event();
