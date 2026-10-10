"""HTTP routers, all mounted under ``/api/v1`` by ``main.create_app``."""

from fastapi import APIRouter

from . import admin, audit, auth, dashboard, drafts, evaluation, exports, kiosk, notes, reference


def all_routers() -> list[APIRouter]:
    return [
        auth.router,
        kiosk.router,
        dashboard.router,
        drafts.router,
        notes.router,
        exports.router,
        audit.router,
        evaluation.router,
        reference.router,
        admin.router,
    ]
