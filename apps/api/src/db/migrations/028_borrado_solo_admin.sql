-- ---------------------------------------------------------------------
-- Eliminar documentos de forma definitiva es solo de administradores (criterio del proyecto: «eliminar
-- definitivamente: solo admin»). Hasta ahora lo comprobaba solo la API; ahora también la base, como el resto de
-- permisos (RLS). Editores siguen creando, editando, mandando a la papelera (UPDATE de deleted_at) y restaurando.
-- ---------------------------------------------------------------------
DROP POLICY documents_write ON documents;

CREATE POLICY documents_insert ON documents FOR INSERT
  WITH CHECK (tenant_id = app_tenant_id() AND app_role() IN ('admin', 'editor')
              AND app_can_access_collection(collection_id));

CREATE POLICY documents_update ON documents FOR UPDATE
  USING (tenant_id = app_tenant_id() AND app_role() IN ('admin', 'editor')
         AND app_can_access_collection(collection_id))
  WITH CHECK (tenant_id = app_tenant_id() AND app_role() IN ('admin', 'editor')
              AND app_can_access_collection(collection_id));

CREATE POLICY documents_delete ON documents FOR DELETE
  USING (tenant_id = app_tenant_id() AND app_role() = 'admin'
         AND app_can_access_collection(collection_id));
