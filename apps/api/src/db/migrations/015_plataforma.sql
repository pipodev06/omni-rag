-- ---------------------------------------------------------------------
-- Organización «Plataforma»
-- El superadministrador (dueño de la plataforma) no es parte de ningún cliente: vive en una organización interna
-- marcada con `is_platform`. No aparece en la lista de organizaciones, no cuenta en los totales ni en la facturación y no
-- se puede desactivar ni borrar. Así, todas las organizaciones de clientes (también la primera) se pueden borrar.
-- Solo puede existir una.
-- ---------------------------------------------------------------------
ALTER TABLE tenants ADD COLUMN is_platform boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX tenants_one_platform_idx ON tenants (is_platform) WHERE is_platform;
