-- ---------------------------------------------------------------------
-- Cuándo se mostró por última vez cada secreto que el superadministrador debe guardar fuera del servidor (hoy, la frase
-- de cifrado de las copias: «backup_passphrase»). Mientras no se haya mostrado, el monitor avisa: sin ella, si se pierde
-- el servidor, las copias externas y las de B2 no se pueden abrir. No guarda el valor ni nada derivado de él. Va aparte
-- de la auditoría porque esta se borra pasados AUDIT_RETENTION_DAYS. Solo la usa la conexión propietaria.
-- ---------------------------------------------------------------------
CREATE TABLE secret_views (
  name   text PRIMARY KEY,
  -- De dónde salía el secreto al mostrarlo («generated» o «env»): si cambia de origen, es otra frase y se vuelve a avisar.
  source text NOT NULL,
  at     timestamptz NOT NULL DEFAULT now()
);
