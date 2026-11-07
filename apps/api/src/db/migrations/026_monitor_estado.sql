-- ---------------------------------------------------------------------
-- Estado de cada comprobación del monitor en su última revisión (panel «Qué se vigila» de Sistema → Alertas). El
-- worker la reescribe cada 5 minutos: [{ id, state: ok|bad|wait|off|error, detail }]. Una sola fila, sin secretos.
-- Como las demás tablas de plataforma, solo la usa la conexión propietaria.
-- ---------------------------------------------------------------------
CREATE TABLE monitor_snapshot (
  id     integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  at     timestamptz NOT NULL DEFAULT now(),
  checks jsonb NOT NULL
);

-- Historial por problema (un «opened» con su «resolved» siguiente) en Sistema → Alertas.
CREATE INDEX IF NOT EXISTS alert_events_key_at ON alert_events (key, at);
