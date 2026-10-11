"""Request bodies for the packet endpoints (CONTRACTS R3.2 "Packets", R4.2)."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class CreatePacketRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    clock_id: str = Field(min_length=1, max_length=64, description="SAE or AESI clock id")


class PatchPacketRequest(BaseModel):
    """Edit fields and/or the narrative text. ``AESER``, ``AEREL`` and ``INTERIM_IRAE`` are
    investigator-only. Each accepted edit is a new version and a ``packet.edited`` event."""

    model_config = ConfigDict(extra="forbid")

    fields: dict[str, Any] | None = Field(
        default=None, description="field name -> new value (only the changed fields)"
    )
    narrative_text: str | None = Field(default=None, max_length=20000)
    note: str | None = Field(default=None, max_length=2000)


class SignPacketRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    note: str | None = Field(default=None, max_length=2000)


__all__ = ["CreatePacketRequest", "PatchPacketRequest", "SignPacketRequest"]
