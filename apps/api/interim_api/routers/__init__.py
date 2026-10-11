"""HTTP routers, all mounted under ``/api/v1`` by ``main.create_app``."""

from fastapi import APIRouter

from . import admin, audit, auth, dashboard, drafts, evaluation, exports, kiosk, notes, reference
from . import briefs as _briefs  # [briefs agent] R3.2 visit-prep brief + time saved
from . import packets as _packets  # [packets agent] R3.2 / R4.2
from . import queries as _queries  # [queries agent] R4.4


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
        _queries.router,  # [queries agent] R4.4
        _packets.router,  # [packets agent] R3.2 / R4.2
        _briefs.router,  # [briefs agent] R3.2
        admin.router,
    ]
