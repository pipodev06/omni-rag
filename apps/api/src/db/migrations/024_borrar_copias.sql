-- ---------------------------------------------------------------------
-- Nueva orden para el servicio de copias: borrar una copia desde Sistema → Copias (payload: {"stamp": "AAAA-MM-DD_HHMM"}).
-- ---------------------------------------------------------------------
ALTER TABLE backup_requests DROP CONSTRAINT IF EXISTS backup_requests_kind_check;
ALTER TABLE backup_requests ADD CONSTRAINT backup_requests_kind_check CHECK (kind IN ('backup', 'destination', 'delete'));
