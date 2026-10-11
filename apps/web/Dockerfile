# syntax=docker/dockerfile:1
# Interim web image: the kiosk + dashboard SPA (Vite build) served by nginx (CLAUDE.md §4.1).
#
# Build context: apps/web (self-contained):
#   docker build -t interim-web apps/web
#   docker run --rm -p 5173:80 interim-web     # starts without an API; /api answers 502 until
#                                               # API_UPSTREAM is reachable
# nginx serves the static build with SPA history fallback and proxies /api/ to API_UPSTREAM
# (default http://api:8000, the compose service), resolved per request (apps/web/nginx.conf), so
# the browser only ever sees a same-origin /api/v1 base.
# The vitals bridge is NOT proxied: the kiosk page opens ws://<page hostname>:8787 directly
# unless VITE_BRIDGE_WS_URL is baked in at build time.

# ---- build ---------------------------------------------------------------------------------
# Base images are pinned by digest (tag kept for humans) so a rebuild next month is the image
# that was smoke-tested. Refresh: docker pull <tag> && docker image inspect <tag> --format '{{index .RepoDigests 0}}'.
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Optional, build-time only (Vite inlines import.meta.env). Empty = ws://<page hostname>:8787.
ARG VITE_BRIDGE_WS_URL=
ENV VITE_BRIDGE_WS_URL=${VITE_BRIDGE_WS_URL}
RUN npm run build

# ---- runtime -------------------------------------------------------------------------------
FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10
# Rendered by the stock entrypoint (20-envsubst-on-templates.sh) into conf.d/default.conf.
# NGINX_ENTRYPOINT_LOCAL_RESOLVERS makes 15-local-resolvers.envsh export NGINX_LOCAL_RESOLVERS from
# /etc/resolv.conf (127.0.0.11 under compose), which the template uses for per-request DNS.
ENV API_UPSTREAM=http://api:8000 NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
