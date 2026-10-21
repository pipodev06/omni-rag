-- =============================================================================
-- Revocación de sesiones.
--
-- Una sesión (JWT) solo vale si se emitió a partir de `sessions_valid_after`.
-- Cambiar la contraseña, restablecerla, quitar el 2FA o «cerrar todas las
-- sesiones» mueve esa fecha y deja inservibles las sesiones anteriores.
-- El valor inicial («epoch») no invalida las sesiones que ya existen.
-- =============================================================================

ALTER TABLE users ADD COLUMN sessions_valid_after timestamptz NOT NULL DEFAULT 'epoch';
