# --- Etapa 1: dependencias y compilación ---------------------------------
FROM node:22-alpine AS build
WORKDIR /app
# Node prueba antes las direcciones IPv4: en redes con IPv6 lento o roto evita los EAI_AGAIN y ERR_SOCKET_TIMEOUT.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
# Valores de pnpm por defecto; deploy/build.sh los baja para enlaces lentos.
ARG PNPM_NETWORK_CONCURRENCY=16
ARG PNPM_FETCH_RETRIES=2
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --network-concurrency $PNPM_NETWORK_CONCURRENCY --fetch-retries $PNPM_FETCH_RETRIES --fetch-timeout 120000 --filter @rag/api...
COPY apps/api apps/api
RUN pnpm --filter @rag/api build \
 && cp -r apps/api/src/db/migrations apps/api/dist/db/migrations \
 && pnpm --filter @rag/api deploy --prod --legacy /out

# --- Etapa 2: imagen final mínima ----------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
RUN mkdir -p /data/uploads /backup-config && chown -R node:node /data /backup-config
USER node
EXPOSE 3001
CMD ["node", "dist/server.js"]
