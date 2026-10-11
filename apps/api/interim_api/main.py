"""FastAPI application factory. Run: ``uvicorn interim_api.main:app``.

``create_app(settings)`` builds an isolated app (its own engine, write lock
and settings on ``app.state``), which is what the tests use with a temporary
SQLite file. The module-level ``app`` reads the environment.

Startup: ``SQLModel.metadata.create_all`` and, when ``SEED_ON_START`` is true
and the database is empty, the demo seed (study, users, twelve synthetic
participants with prior check-ins) through the service layer.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import API_VERSION
from .db import Database, create_all, make_engine
from .problems import install_problem_handlers
from .routers import all_routers
from .seed import seed_if_empty
from .services.settings_svc import ensure_defaults
from .settings import Settings

API_PREFIX = "/api/v1"

log = logging.getLogger("interim_api")

DESCRIPTION = """
Interim: between-visit adverse-event check-in with contactless vitals as eSource.

* Kiosk endpoints (`/sessions*`, `/items`, `/study`, `/settings/public`) need no token.
* Dashboard endpoints need `Authorization: Bearer <token>` from `POST /auth/login`
  (demo users `coordinator`, `investigator`, `admin`; password `DEMO_PASSWORD`).
* Every error is RFC 7807 `application/problem+json`.
* No LLM anywhere: every grade, tier and draft comes from `interim_rules` (tables + arithmetic).

Interim is a research data-capture tool. It is not a medical device and does not provide
medical advice. All participants are synthetic.
"""


def create_app(settings: Settings | None = None) -> FastAPI:
    cfg = settings or Settings()
    logging.basicConfig(level=cfg.log_level.upper(), format="%(levelname)s %(name)s: %(message)s")
    database = Database(make_engine(cfg.resolved_database_url))

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        create_all(database.engine)
        with database.write_scope() as db:
            ensure_defaults(db, cfg)
        if cfg.seed_on_start:
            summary = seed_if_empty(database, cfg)
            if summary is not None:
                log.info("seeded demo data: %s", summary)
        log.info(
            "Interim API %s ready (db=%s, seed_on_start=%s)",
            API_VERSION,
            cfg.database_label,
            cfg.seed_on_start,
        )
        try:
            yield
        finally:
            database.dispose()

    app = FastAPI(
        title="Interim API",
        version=API_VERSION,
        description=DESCRIPTION,
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url="/openapi.json",
    )
    app.state.settings = cfg
    app.state.database = database
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cfg.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Disposition", "X-Interim-SHA256", "X-Interim-Audit-Head"],
    )
    install_problem_handlers(app)
    for router in all_routers():
        app.include_router(router, prefix=API_PREFIX)

    @app.get("/", include_in_schema=False)
    def root() -> dict[str, str]:
        return {
            "service": "interim-api",
            "version": API_VERSION,
            "docs": "/docs",
            "health": f"{API_PREFIX}/health",
            "note": "Interim is a research data-capture tool. It is not a medical device and "
            "does not provide medical advice.",
        }

    return app


app = create_app()
