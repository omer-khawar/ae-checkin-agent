"""Request bodies for the sponsor-query endpoints (CONTRACTS.md R4.4)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

QuerySeverity = Literal["data", "safety"]
QueryDomain = Literal["AE", "VS", "CM"]


class RaiseQueryRequest(BaseModel):
    """``POST /queries``: an admin acting as the sponsor's monitor asks about one field."""

    model_config = ConfigDict(extra="forbid")

    draft_id: str = Field(min_length=1, max_length=64)
    field: str = Field(min_length=1, max_length=40, description="SDTM variable, e.g. CMDOSE")
    text: str = Field(min_length=1, max_length=4000)
    severity: QuerySeverity = "data"


class AlsoEdit(BaseModel):
    """Correct the record while answering: creates a new draft version (audited)."""

    model_config = ConfigDict(extra="forbid")

    field: str = Field(min_length=1, max_length=40)
    value: Any = None


class AnswerQueryRequest(BaseModel):
    """``POST /queries/{id}/answer`` (coordinator, investigator or admin)."""

    model_config = ConfigDict(extra="forbid")

    answer_text: str = Field(min_length=1, max_length=8000)
    evidence_ids: list[str] | None = Field(
        default=None,
        max_length=100,
        description="ids from the query, its record or the suggested answer; omitted = the "
        "suggestion's own citations when the answer starts from it",
    )
    also_edit: AlsoEdit | None = None


class CloseQueryRequest(BaseModel):
    """``POST /queries/{id}/close`` (admin acting as the sponsor)."""

    model_config = ConfigDict(extra="forbid")

    note: str | None = Field(default=None, max_length=2000)


class RunChecksRequest(BaseModel):
    """``POST /queries/run-checks`` (admin): re-run every edit check on confirmed records."""

    model_config = ConfigDict(extra="forbid")

    domains: list[QueryDomain] | None = None
    include_eval: bool = False
