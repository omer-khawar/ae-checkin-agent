"""Reference data for the investigator screen (CONTRACTS.md §2.2)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..auth import require_role
from ..deps import get_settings
from ..services.reference import ctcae_rows, load_label
from ..settings import Settings

router = APIRouter(tags=["reference"], dependencies=[Depends(require_role())])


@router.get("/reference/label")
def reference_label(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return load_label(settings.public_data_dir)


@router.get("/reference/ctcae")
def reference_ctcae() -> list[dict[str, Any]]:
    return ctcae_rows()
