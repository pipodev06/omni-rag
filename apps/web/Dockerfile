FROM node:22-alpine AS build
WORKDIR /app
# Node prueba antes las direcciones IPv4: en redes con IPv6 lento o roto evita los EAI_AGAIN y ERR_SOCKET_TIMEOUT.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
# Valores de pnpm por defecto; deploy/build.sh los baja para enlaces lentos.
ARG PNPM_NETWORK_CONCURRENCY=16
ARG PNPM_FETCH_RETRIES=2
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --network-concurrency $PNPM_NETWORK_CONCURRENCY --fetch-retries $PNPM_FETCH_RETRIES --fetch-timeout 120000 --filter @rag/web...
COPY apps/web apps/web
RUN pnpm --filter @rag/web build
# Versiones .gz de los archivos estáticos, creadas una vez al construir: nginx las sirve con gzip_static sin gastar CPU por petición.
RUN find apps/web/dist -type f -regex '.*\.\(js\|mjs\|css\|svg\|html\)' -exec gzip -9 -k {} +

FROM nginx:1.29-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/web/security-headers.conf /etc/nginx/security-headers.conf
# Proxies de confianza (REAL_IP_FROM): el entrypoint de nginx ejecuta lo que haya en /docker-entrypoint.d/ al arrancar.
COPY --chmod=755 apps/web/real-ip.sh /docker-entrypoint.d/30-real-ip.sh
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
