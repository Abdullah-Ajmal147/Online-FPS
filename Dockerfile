# Sentinel Strike — one image with the game server (serving the built client) and the API.
# Build:  docker build -t sentinel .
# Run:    docker compose up   (see docker-compose.yml)

FROM node:22-trixie-slim AS build
# Same pnpm as package.json "packageManager".
RUN npm install -g pnpm@12.6.0
WORKDIR /app
# Download dependencies from the lockfile alone, before copying the source, so editing code
# does not invalidate this layer. The pnpm store and metadata cache are BuildKit cache mounts:
# they persist across builds (and across failed attempts), so a download is never repeated.
# Few parallel requests + long timeout + more retries keep slow connections from timing out
# (pnpm reads settings from pnpm_config_* environment variables).
ENV pnpm_config_network_concurrency=4 \
    pnpm_config_fetch_timeout=600000 \
    pnpm_config_fetch_retries=6 \
    pnpm_config_fetch_retry_maxtimeout=120000
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    --mount=type=cache,id=pnpm-cache,target=/root/.cache/pnpm \
    pnpm fetch --store-dir /pnpm-store
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    --mount=type=cache,id=pnpm-cache,target=/root/.cache/pnpm \
    pnpm install --frozen-lockfile --offline --store-dir /pnpm-store
# The client talks to the game server on the same host (port 2567) and the API on port 8787
# unless VITE_SERVER_URL / VITE_API_URL are set at build time.
ARG VITE_SERVER_URL
ARG VITE_API_URL
# A root .env (written by the Docker Hub publish workflow from the ENV_FILE secret, or your
# local one) can also set build-time values: VITE_*, SITE_URL. It stays in this build stage:
# the runtime stage below copies only built output, so no .env reaches the published image.
RUN set -a; if [ -f .env ]; then . ./.env; fi; set +a; pnpm build

FROM node:22-trixie-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Server and API bundles include our workspace packages and Rapier; they only need their
# third-party runtime dependencies, which the build stage's node_modules already has.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/scripts ./apps/api/scripts
COPY --from=build /app/apps/client/dist ./apps/client/dist
COPY --from=build /app/package.json ./package.json
ENV SENTINEL_CLIENT_DIR=/app/apps/client/dist
# The API's SQLite database lives on a volume at /data, writable by the unprivileged user.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 2567 8787
# Default: the game server. The API runs from the same image with a different command.
CMD ["node", "apps/server/dist/index.mjs"]
