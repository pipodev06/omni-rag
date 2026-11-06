# =====================================================================
# Imagen de los servicios auxiliares (init, backup y backup-b2): PostgreSQL 17 (pg_dump, pg_restore, psql, openssl) más
# rclone y los scripts de deploy/. Así el servidor no necesita la carpeta deploy/: le basta el docker-compose.yml.
# La publica el CI como ghcr.io/pipodev06/omni-rag-ops. Los scripts quedan en la raíz (/backup.sh…) para que los
# comandos de siempre sigan valiendo: docker compose exec backup sh /backup.sh --once
# =====================================================================
FROM rclone/rclone:1.69.3 AS rclone

FROM pgvector/pgvector:pg17
# rclone es un binario estático de Go: funciona igual en esta imagen (Debian) que en la suya (Alpine).
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY deploy/init-secrets.sh /init-secrets.sh
COPY deploy/backup.sh /backup.sh
COPY deploy/b2-sync.sh /b2-sync.sh
