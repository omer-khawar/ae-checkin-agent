# Interim vitals bridge: mock-only image for `docker compose up` (CLAUDE.md §10.7).
#
# What it is: the Node service that turns a vitals source into the kiosk's live WebSocket feed
# and batched eSource POSTs to the API. In Docker it can only run the MOCK source (every sample
# `isMeasured: false`, badge SIMULATED): a container has no webcam, and the Presage SDK (several
# hundred MB of native binaries) is never a declared dependency; it is installed on demand on the
# kiosk laptop with `npm run install:presage`. Real sensors run the bridge on the kiosk laptop
# itself (`npm run bridge -- --source presage`), not in compose. See docs/VITALS_SOURCES.md.
#
# Build context: this directory (apps/vitals-bridge). From the repo root:
#   docker build -t interim-bridge apps/vitals-bridge
#   docker run --rm -p 8787:8787 -e BRIDGE_API_URL=http://host.docker.internal:8000 interim-bridge
# In compose: `bridge: { build: ./apps/vitals-bridge, ports: ["8787:8787"], init: true }`.
#
# Stage 1 installs dev dependencies and compiles TypeScript; stage 2 ships only dist/ and the
# production node_modules (ulid + ws). No secrets are baked in: everything is environment-driven.

# ---- build ---------------------------------------------------------------------------------
# Base image pinned by digest (tag kept for humans) so a rebuild resolves the smoke-tested image.
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime -------------------------------------------------------------------------------
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
ENV NODE_ENV=production \
    # Bind all interfaces: the kiosk browser connects from outside the container through the
    # published port (the CLI default is loopback for the bare-metal case).
    BRIDGE_WS_HOST=0.0.0.0 \
    BRIDGE_WS_PORT=8787 \
    # The compose service name for the API; override for any other topology.
    BRIDGE_API_URL=http://api:8000 \
    VITALS_SOURCE=mock \
    VITALS_SCENARIO=resting
WORKDIR /app
# package.json is read at runtime for the version string (src/version.ts).
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 8787
# Drop root: the bridge needs no privileges (one listening socket, outbound HTTP).
USER node
# Liveness: the WebSocket port accepts TCP connections (the bridge serves no plain HTTP route).
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "require('net').connect(Number(process.env.BRIDGE_WS_PORT || 8787), '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))"]
# Node is PID 1 here and handles SIGTERM itself (graceful stop + flush, see src/cli.ts); run the
# container with `init: true` / `--init` so a stopped container also reaps correctly.
# `--source mock` is a flag (flags beat env), so this image cannot be switched to a real sensor
# by an environment variable: no webcam, no SDK and no Presage key ever exist in it. The API URL
# stays env-driven (BRIDGE_API_URL) so `docker run -e BRIDGE_API_URL=...` keeps working; compose
# passes `--api http://api:8000` explicitly.
CMD ["node", "dist/cli.js", "--source", "mock", "--ws-host", "0.0.0.0"]
