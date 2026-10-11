"""AE Capture Desk API: adverse-event + con-med capture for clinical trial sites.

Run locally:  uvicorn app.main:app --reload      then open http://localhost:8000/docs
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse

from app.config import settings
from app.db import init_db
from app.routers import checkins, meta, notes, patients, review

log = logging.getLogger("uvicorn.error")


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    if settings.seed_on_startup:
        from app.seed import seed_if_empty

        result = seed_if_empty()
        if result:
            log.info("Seeded synthetic demo data: %s", result)
    yield


app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    description=(
        "Backend for a between-visit adverse event (AE) and concomitant-medication check-in agent. "
        "Built for the Regeneron HackRU 2026 challenge (starter sheet 08, 'How Are You Feeling?'). "
        "**Synthetic data only.** Not a medical device and gives no medical advice; the investigator "
        "decides seriousness and attribution."
    ),
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=settings.cors_origin_list != ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

for r in (meta.router, patients.router, checkins.router, notes.router, review.router):
    app.include_router(r)


@app.get("/", include_in_schema=False)
def root():
    return RedirectResponse("/docs")


@app.get("/health", tags=["meta"])
def health():
    return {"status": "ok", "service": settings.app_name, "study_id": settings.study_id}
