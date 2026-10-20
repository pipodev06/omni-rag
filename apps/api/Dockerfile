# --- Etapa 1: dependencias y compilación ---------------------------------
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @rag/api...
COPY apps/api apps/api
RUN pnpm --filter @rag/api build \
 && cp -r apps/api/src/db/migrations apps/api/dist/db/migrations \
 && pnpm --filter @rag/api deploy --prod --legacy /out

# --- Etapa 2: imagen final mínima ----------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
EXPOSE 3001
CMD ["node", "dist/server.js"]
