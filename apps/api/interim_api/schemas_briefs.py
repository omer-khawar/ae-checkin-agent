"""Request bodies for the brief / visits / time-saved endpoints (briefs agent, CONTRACTS R3.2)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class VisitRequest(BaseModel):
    """``POST /participants/{usubjid}/visits``: record a completed or scheduled visit date."""

    model_config = ConfigDict(extra="forbid")

    visit_date: str = Field(description="YYYY-MM-DD", min_length=10, max_length=32)
    status: Literal["completed", "scheduled"] = "completed"
    label: str | None = Field(default=None, max_length=120)
