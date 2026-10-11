# syntax=docker/dockerfile:1
# Interim API image: FastAPI + the deterministic rules engine (CLAUDE.md §4, §10.7).
#
# Build context: the REPOSITORY ROOT (the image needs packages/rules, apps/api and data/):
#   docker build -f apps/api/Dockerfile -t interim-api .
#   docker run --rm -p 8000:8000 -v interim-db:/var/lib/interim interim-api
# The root .dockerignore keeps .env, virtualenvs, caches, node_modules and *.db out of the context.
#
# Stage 1 builds a self-contained virtualenv with both packages installed NON-editable: the rules
# package maps packages/rules/data/*.json into `interim_rules.data`, so the wheel ships its tables
# (CONTRACTS.md R2.1 "Table resolution"). Stage 2 copies only that venv plus the public/synthetic
# data the seed reads. No secrets are baked in; every setting is an environment variable.

# Reproducibility: base images are pinned by digest (tag kept for humans), and every Python
# package in the image, transitive ones included, is pinned by the constraints file below, so a
# rebuild next month resolves exactly what was smoke-tested. To refresh: bump the digest
# (docker pull python:3.12-slim && docker image inspect python:3.12-slim --format
# '{{index .RepoDigests 0}}'), build, then regenerate the list from the built image with
# `docker run --rm --entrypoint /opt/venv/bin/pip interim-api:local freeze --exclude-editable`
# (drop the interim-* and pip lines). A pin here that contradicts apps/api/pyproject.toml fails
# the build on purpose.

# ---- build ---------------------------------------------------------------------------------
FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 AS build
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_CONSTRAINT=/src/constraints.txt
WORKDIR /src
COPY <<EOF /src/constraints.txt
annotated-types==0.8.0
anyio==4.15.1
click==8.5.0
fastapi==0.115.12
h11==0.16.0
httptools==0.9.0
idna==3.20
pydantic==2.14.0
pydantic-settings==2.15.0
pydantic_core==2.50.0
python-dotenv==1.2.4
python-ulid==4.0.1
PyYAML==6.0.3
SQLAlchemy==2.1.4
sqlmodel==0.0.48
starlette==0.46.2
typing-inspection==0.4.4
typing_extensions==4.16.0
uvicorn==0.34.2
uvloop==0.23.0
watchfiles==1.3.0
websockets==17.2
EOF
COPY packages/rules ./packages/rules
COPY apps/api ./apps/api
# Direct dependencies are exact pins in apps/api/pyproject.toml (interim-rules has none); the
# constraints above pin the transitive rest.
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install ./packages/rules ./apps/api \
 # Fail the build, not the first request, if the tables did not make it into the wheel.
 && /opt/venv/bin/python -c "from interim_rules import tables; tables.items(); print('rules tables OK:', tables.data_dir())"

# ---- runtime -------------------------------------------------------------------------------
FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH \
    # SQLite in a volume-backed directory (absolute path: four slashes). Postgres: override
    # DATABASE_URL with postgresql+psycopg://... (and add psycopg to the image).
    DATABASE_URL=sqlite:////var/lib/interim/interim.db \
    # The package is installed into site-packages, so point the API at the copied data/ tree
    # instead of its repo-relative default.
    PUBLIC_DATA_DIR=/app/data/public \
    SEED_ON_START=true \
    VITALS_SOURCE=mock

# Unprivileged runtime user; it owns only the database directory.
RUN groupadd --system --gid 10001 interim \
 && useradd --system --uid 10001 --gid interim --home-dir /app --no-create-home \
      --shell /usr/sbin/nologin interim \
 && mkdir -p /app /var/lib/interim \
 && chown interim:interim /var/lib/interim

COPY --from=build /opt/venv /opt/venv
# Public registry/label caches (fetched at seed time, committed) and the documented synthetic
# cohort. The API never fetches anything at runtime.
COPY data/public /app/data/public
COPY data/synthetic /app/data/synthetic

WORKDIR /app
USER interim
VOLUME ["/var/lib/interim"]
EXPOSE 8000

# First start seeds an empty database through the service layer (audited), which takes a few
# seconds; the start period covers it.
HEALTHCHECK --interval=10s --timeout=5s --start-period=90s --retries=6 \
  CMD ["python", "-c", "import sys, urllib.request; r = urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health', timeout=4); sys.exit(0 if r.status == 200 else 1)"]

# --proxy-headers: nginx in the web container forwards X-Forwarded-*.
CMD ["uvicorn", "interim_api.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
