"""Writer interface and selection (CLAUDE.md §00 "Generated text works with no API key").

``write(kind, facts) -> {kind, writer: "template" | "llm", sentences: [{text, evidence_ids}],
text, fallback_reason?}`` (``interim_rules.narrative.WrittenText.to_dict``).

Selection (:func:`get_writer`):

* ``INTERIM_WRITER=template`` or no ``ANTHROPIC_API_KEY`` -> the template writer (what a clean
  clone and the eval use);
* otherwise the LLM writer, which still falls back to the template writer, with a stated
  ``fallback_reason``, whenever the SDK is missing, the call fails, or the text fails
  ``validate_written`` (an unknown evidence id, a quote not verbatim in the cited fact, a
  grade without "investigator to confirm", advice wording, ...).

Tests never reach the network: the LLM writer takes an injected client, and the real
client is never built while pytest is running (``PYTEST_CURRENT_TEST``).
"""

from __future__ import annotations

import importlib.util
import os
from collections.abc import Mapping
from typing import Any, Protocol

from ..settings import Settings
from .template import TemplateWriter


class Writer(Protocol):
    name: str

    def write(self, kind: str, facts: Mapping[str, object]) -> dict[str, Any]: ...


def llm_sdk_installed() -> bool:
    return importlib.util.find_spec("anthropic") is not None


def llm_configured(settings: Settings) -> bool:
    """A key is set and the operator did not force the template writer."""
    return bool(settings.anthropic_api_key.strip()) and settings.interim_writer != "template"


def writer_status(settings: Settings) -> dict[str, Any]:
    """``GET /settings/public`` keys: ``writer``, ``llm_configured`` (+ model, SDK presence)."""
    configured = llm_configured(settings)
    installed = llm_sdk_installed()
    return {
        "writer": "llm" if configured and installed else "template",
        "llm_configured": configured,
        "llm_sdk_installed": installed,
        "llm_model": settings.interim_llm_model if configured else None,
    }


def get_writer(settings: Settings, *, client: Any = None) -> Writer:
    """The writer to use now. ``client`` injects an Anthropic-compatible client (tests)."""
    if client is not None:
        from .llm import LlmWriter

        return LlmWriter(client=client, model=settings.interim_llm_model)
    if not llm_configured(settings):
        return TemplateWriter()
    from .llm import LlmWriter, build_client

    if os.environ.get("PYTEST_CURRENT_TEST"):
        return LlmWriter(
            client=None,
            model=settings.interim_llm_model,
            unavailable_reason="the LLM writer is disabled while tests run (no network in tests)",
        )
    real, reason = build_client(settings.anthropic_api_key)
    return LlmWriter(client=real, model=settings.interim_llm_model, unavailable_reason=reason)


def write_text(
    settings: Settings, kind: str, facts: Mapping[str, object], *, client: Any = None
) -> dict[str, Any]:
    """Write ``kind`` from ``facts`` with the selected writer (template unless configured)."""
    return get_writer(settings, client=client).write(kind, facts)


__all__ = [
    "Writer",
    "get_writer",
    "llm_configured",
    "llm_sdk_installed",
    "write_text",
    "writer_status",
]
