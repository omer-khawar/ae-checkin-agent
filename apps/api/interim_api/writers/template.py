"""The default writer: ``interim_rules.narrative.write`` (pure, deterministic, no network)."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from interim_rules.narrative import write


class TemplateWriter:
    """Assembles every sentence from evidence fields; every sentence cites evidence ids."""

    name = "template"

    def write(self, kind: str, facts: Mapping[str, object]) -> dict[str, Any]:
        return write(kind, facts).to_dict()


__all__ = ["TemplateWriter"]
