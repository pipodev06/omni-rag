-- ---------------------------------------------------------------------
-- Alertas de monitorización
-- El worker revisa cada 5 minutos disco, cola de documentos, copias de seguridad y errores del modelo. Esta tabla
-- recuerda qué problemas hay abiertos para avisar una vez al empezar, recordar cada 24 h y avisar al resolverse.
-- Solo la usa el worker (conexión propietaria); `rag_app` no tiene permisos sobre ella.
-- ---------------------------------------------------------------------
CREATE TABLE alert_state (
  key        text PRIMARY KEY,
  since      timestamptz NOT NULL DEFAULT now(),
  last_sent  timestamptz NOT NULL DEFAULT now(),
  message    text NOT NULL
);
