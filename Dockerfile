# syntax=docker/dockerfile:1
# Bun solo instala dependencias y lanza el build; el runtime es siempre Node 24

# Bun sin instalarlo en la imagen de Node: se copia su binario
FROM oven/bun:1.4.4 AS bun

# Etapa de build: tsup corre sobre Node
FROM node:24.22.2 AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
COPY scripts ./scripts
RUN bun run build

# Solo las dependencias de producción
FROM node:24.22.2 AS deps
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Imagen final: Node, node_modules de producción, dist/ y migraciones. Sin Bun
FROM node:24.22.2-slim
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --gid 10001 app && useradd --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app
# package.json aporta "type": "module", necesario para el ESM de dist/
COPY --chown=root:root package.json ./
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --chown=root:root drizzle ./drizzle
USER 10001:10001
EXPOSE 3000
# La imagen slim no trae curl: se usa fetch de Node. El worker lo sustituye en el Compose
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server.js"]
