-- ---------------------------------------------------------------------
-- Omni RAG solo mide sus propios contenedores: se borran las muestras de los demás contenedores del servidor que se
-- guardaron antes (columna own = false). Las alertas ya solo miraban los propios.
-- ---------------------------------------------------------------------
DELETE FROM container_samples WHERE NOT own;
