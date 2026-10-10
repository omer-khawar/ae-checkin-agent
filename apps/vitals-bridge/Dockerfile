# Interim vitals bridge: mock-only image for `docker compose up` (CLAUDE.md §10.7).
#
# What it is: the Node service that turns a vitals source into the kiosk's live WebSocket feed
# and batched eSource POSTs to the API. In Docker it can only run the MOCK source (every sample
# `isMeasured: false`, badge SIMULATED): a container has no webcam, and the Presage SDK (several
# hundred MB of native binaries) is deliberately not a dependency yet. Real sensors run the bridge
# on the kiosk laptop itself (`npm run bridge`), not in compose. See docs/VITALS_SOURCES.md.
#
# Build context: this directory (apps/vitals-bridge). From the repo root:
#   docker build -t interim-bridge apps/vitals-bridge
#   docker run --rm -p 8787:8787 -e BRIDGE_API_URL=http://host.docker.internal:8000 interim-bridge
# In compose: `bridge: { build: ./apps/vitals-bridge, ports: ["8787:8787"], init: true }`.
#
# Stage 1 installs dev dependencies and compiles TypeScript; stage 2 ships only dist/ and the
# production node_modules (ulid + ws). No secrets are baked in: everything is environment-driven.

# ---- build ---------------------------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime -------------------------------------------------------------------------------
FROM node:20-alpine
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
# Node is PID 1 here and handles SIGTERM itself (graceful stop + flush, see src/cli.ts); run the
# container with `init: true` / `--init` so a stopped container also reaps correctly.
CMD ["node", "dist/cli.js"]
