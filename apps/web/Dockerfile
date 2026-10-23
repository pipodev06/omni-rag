FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @rag/web...
COPY apps/web apps/web
RUN pnpm --filter @rag/web build
# Versiones .gz de los archivos estáticos, creadas una vez al construir: nginx las sirve con gzip_static sin gastar CPU por petición.
RUN find apps/web/dist -type f -regex '.*\.\(js\|mjs\|css\|svg\|html\)' -exec gzip -9 -k {} +

FROM nginx:1.29-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/web/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
