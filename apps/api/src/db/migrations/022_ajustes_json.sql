-- ---------------------------------------------------------------------
-- Repara los ajustes guardados con doble conversión a JSON (la API hacía JSON.stringify(...)::jsonb y el driver volvía a
-- convertir): quedaban como texto JSON con comillas dentro, «"\"tavily\""» o «"9"», y la pantalla, la API y backup.sh
-- leían «"tavily"» con comillas o un número como texto. Se desenvuelve un nivel solo cuando el texto de dentro es un
-- valor JSON válido; un texto bien guardado que no lo es (la ruta de BACKUP_DESTINATION que escribe backup.sh) no cambia.
-- Los secretos van en `secret`, no en `value`, y no se tocan.
-- ---------------------------------------------------------------------
UPDATE settings
   SET value = (value #>> '{}')::jsonb
 WHERE value IS NOT NULL
   AND jsonb_typeof(value) = 'string'
   AND (value #>> '{}') IS JSON SCALAR;
