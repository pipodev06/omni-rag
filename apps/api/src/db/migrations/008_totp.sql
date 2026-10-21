-- =============================================================================
-- Verificación en dos pasos (TOTP), opcional por usuario.
--
-- totp_secret          secreto cifrado (AES-256-GCM); NULL = sin 2FA
-- totp_enabled_at      NULL con secreto = configuración empezada pero sin confirmar
-- totp_last_step       último intervalo de 30 s aceptado (un código no se reutiliza)
-- totp_recovery_hashes SHA-256 de los códigos de recuperación aún sin usar
-- =============================================================================

ALTER TABLE users
  ADD COLUMN totp_secret text,
  ADD COLUMN totp_enabled_at timestamptz,
  ADD COLUMN totp_last_step bigint,
  ADD COLUMN totp_recovery_hashes text[] NOT NULL DEFAULT '{}';
