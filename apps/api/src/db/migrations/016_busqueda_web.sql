-- ---------------------------------------------------------------------
-- Búsqueda en internet por plan
-- El modo híbrido (documentos + resultados de internet) se permite plan a plan. Desactivado por defecto: además hay que
-- configurar un buscador en el servidor (WEB_SEARCH_PROVIDER) y el usuario lo activa pregunta a pregunta en el chat.
-- ---------------------------------------------------------------------
ALTER TABLE plans ADD COLUMN web_search boolean NOT NULL DEFAULT false;
