-- =============================================================================
-- Acceso por usuario y contraseña. El email pasa a ser opcional.
--
-- `username` es único en toda la plataforma (igual que el email) porque la
-- pantalla de login no pide la organización. Los usuarios existentes reciben
-- uno generado a partir de su email, sin perder el acceso con el email.
-- =============================================================================

ALTER TABLE users ADD COLUMN username text;

WITH base AS (
  SELECT id, created_at,
         CASE WHEN length(b) >= 3 THEN left(b, 30) ELSE 'usuario' END AS b
    FROM (
      SELECT id, created_at,
             lower(regexp_replace(split_part(email, '@', 1), '[^a-zA-Z0-9._-]', '', 'g')) AS b
        FROM users
    ) s
), ranked AS (
  SELECT id, b, row_number() OVER (PARTITION BY b ORDER BY created_at, id) AS rn FROM base
)
UPDATE users u SET username = CASE
    WHEN u.support_for IS NOT NULL THEN 'soporte-' || substr(md5(u.support_for::text || u.tenant_id::text), 1, 12)
    WHEN r.rn = 1 THEN r.b
    ELSE r.b || '-' || substr(replace(u.id::text, '-', ''), 1, 6)
  END
  FROM ranked r WHERE r.id = u.id;

ALTER TABLE users ALTER COLUMN username SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9._-]{3,40}$');
CREATE UNIQUE INDEX users_username_key ON users (lower(username));

-- Sin email no hay invitaciones ni recuperación por correo: el usuario entra solo con usuario y contraseña.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_login_method CHECK (email IS NOT NULL OR password_hash IS NOT NULL);
