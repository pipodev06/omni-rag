-- ---------------------------------------------------------------------
-- Búsqueda de códigos e identificadores
-- La búsqueda por palabras solo encuentra palabras completas: «inc» no encontraba INC502635 y «502635» tampoco.
-- La API ahora busca también por prefijo ('inc':*, con el índice de texto que ya existe) y, para los términos con
-- dígitos, como texto dentro del fragmento (ILIKE), que necesita este índice de trigramas.
-- pg_trgm es una extensión «trusted»: no hace falta superusuario para instalarla.
-- ---------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS chunks_content_trgm ON chunks USING gin (content gin_trgm_ops);

-- Las respuestas guardadas antes de este cambio pueden decir «no encontré» para preguntas que ahora sí tienen
-- resultado: se vacía la caché para que se vuelvan a calcular.
DELETE FROM answer_cache;
