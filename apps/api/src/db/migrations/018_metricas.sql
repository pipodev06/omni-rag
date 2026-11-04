-- ---------------------------------------------------------------------
-- Métricas de los contenedores y el historial de alertas (pantalla Sistema, solo superadministrador)
-- El worker toma una muestra por contenedor cada minuto a través del proxy de Docker con lista blanca. No son datos de
-- ninguna organización: solo los usan el worker y las rutas de plataforma con la conexión propietaria; `rag_app` no
-- tiene permisos sobre estas tablas.
-- ---------------------------------------------------------------------
CREATE TABLE container_samples (
  at         timestamptz NOT NULL DEFAULT now(),
  -- Nombre del servicio de compose (api, worker, docling…) o, para contenedores ajenos al proyecto, su nombre.
  name       text NOT NULL,
  -- true = pertenece a este proyecto de compose; false = otro contenedor del mismo servidor.
  own        boolean NOT NULL,
  image      text NOT NULL,
  state      text NOT NULL,
  health     text,
  cpu_cores  real NOT NULL,
  -- Topes aplicados por Docker (null = sin tope).
  cpu_limit  real,
  cpu_shares integer,
  mem_bytes  bigint NOT NULL,
  mem_limit  bigint,
  restarts   integer,
  oom_killed boolean NOT NULL DEFAULT false
);
CREATE INDEX container_samples_name_at ON container_samples (name, at DESC);
CREATE INDEX container_samples_at ON container_samples (at);

-- Datos del servidor de la última muestra (RAM total, núcleos, versión de Docker…). Una sola fila.
CREATE TABLE host_snapshot (
  id   integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  at   timestamptz NOT NULL DEFAULT now(),
  info jsonb NOT NULL
);

-- Historial de alertas: alert_state solo guarda las abiertas; aquí queda cuándo empezó, se recordó y se resolvió cada una.
CREATE TABLE alert_events (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  key     text NOT NULL,
  event   text NOT NULL CHECK (event IN ('opened', 'reminded', 'resolved')),
  message text NOT NULL
);
CREATE INDEX alert_events_at ON alert_events (at DESC);
