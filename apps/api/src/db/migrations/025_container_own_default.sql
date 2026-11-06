-- ---------------------------------------------------------------------
-- Desde la migración 023 solo se guardan los contenedores propios: la columna own ya no se lee y vale siempre true.
-- Se le da ese valor por defecto para que el worker no tenga que escribirla (se conserva para no romper una imagen
-- anterior que aún la escriba).
-- ---------------------------------------------------------------------
ALTER TABLE container_samples ALTER COLUMN own SET DEFAULT true;
