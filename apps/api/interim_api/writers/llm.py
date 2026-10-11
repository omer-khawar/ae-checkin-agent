"""Optional Claude writer (CLAUDE.md §00.3, CONTRACTS R3.2 "Writer selection").

Used only when ``ANTHROPIC_API_KEY`` is set (``writers.base.get_writer``). It asks Claude,
through the official ``anthropic`` Python SDK (optional extra ``interim-api[llm]``), to
rephrase the template writer's draft for readability from the same fact bundle, as JSON
sentences that each cite evidence ids. The answer is accepted only if
``interim_rules.narrative.validate_written`` returns no problem: every cited id exists in
the facts, every quoted passage is verbatim in a fact the same sentence cites, grades and
seriousness/causality/AESI wording carry their "investigator to confirm" qualifier, and no
advice or filler words appear. Anything else (no SDK, an API error, a refusal, a truncated
or malformed answer, a validation problem) returns the template text with
``fallback_reason`` saying why. Decisions never depend on this text.

Request shape (from the claude-api skill): ``client.beta.messages.create`` with structured
outputs (``output_config.format`` JSON schema), ``output_config.effort = "medium"``, and the
server-side refusal fallback (``betas=["server-side-fallback-2026-07-01"]``,
``fallbacks="default"``). The model id comes from ``INTERIM_LLM_MODEL`` (default
``claude-sonnet-5-5``, the Sonnet tier, for writing).
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from typing import Any

from interim_rules.narrative import validate_written
from interim_rules.narrative_templates import narrative_templates

from .template import TemplateWriter

log = logging.getLogger("interim_api.writers.llm")

FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_TOKENS = 8000
MAX_PROBLEMS_IN_REASON = 3

SYSTEM_PROMPT = """You draft short narratives for a clinical trial site's safety report \
(an SAE or AESI report, a visit-prep brief) that a research coordinator and an investigator \
will review and sign. You are given a JSON fact bundle and a draft written by a template. \
Rewrite the draft as clear, plain, past-tense sentences for a reader who is not a clinician.

Rules (your output is checked automatically and discarded if any rule is broken):
- Use only the facts given. Do not add symptoms, dates, numbers, drugs or conclusions.
- Every sentence cites at least one evidence id, copied exactly from an "evidence_ids" list \
of a fact the sentence uses.
- Text in double quotes must appear exactly, character for character, in a fact the same \
sentence cites.
- Any grade is written with "(provisional, investigator to confirm)".
- Seriousness and causality are the investigator's decisions: state them only as suspected, \
with "investigator to confirm", or as the investigator's recorded assessment.
- Any mention of AESI or special interest includes "possible AESI, investigator to confirm".
- No medical advice, no diagnosis, no recommendations.
- Do not write filler for missing facts (such as "unknown", "n/a" or "TBD"); missing items \
go in one sentence starting "Information still needed:".
- Keep the draft's order and do not merge facts from different sources into one claim."""

OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "sentences": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "evidence_ids": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["text", "evidence_ids"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["sentences"],
    "additionalProperties": False,
}


def build_client(api_key: str) -> tuple[Any, str | None]:
    """``(client, None)`` or ``(None, reason)`` when the SDK is not installed."""
    try:
        import anthropic
    except ImportError:
        return None, (
            "the anthropic SDK is not installed (pip install 'interim-api[llm]'); "
            "using the template writer"
        )
    return anthropic.Anthropic(api_key=api_key, timeout=60.0, max_retries=1), None


def _user_message(kind: str, facts: Mapping[str, object], draft: Mapping[str, Any]) -> str:
    draft_sentences = [
        {"text": s.get("text"), "evidence_ids": s.get("evidence_ids")}
        for s in draft.get("sentences", [])
        if isinstance(s, Mapping)
    ]
    return (
        f"Narrative kind: {kind}\n\n"
        f"Fact bundle (JSON):\n{json.dumps(facts, ensure_ascii=False, sort_keys=True)}\n\n"
        f"Template draft (JSON sentences):\n{json.dumps(draft_sentences, ensure_ascii=False)}\n\n"
        'Return {"sentences": [{"text": ..., "evidence_ids": [...]}]}.'
    )


def _response_text(response: Any) -> str | None:
    for block in getattr(response, "content", None) or []:
        if getattr(block, "type", None) == "text":
            return str(getattr(block, "text", ""))
    return None


class LlmWriter:
    """Claude writer with template fallback. ``client`` is an ``anthropic.Anthropic`` or any
    object exposing ``beta.messages.create(**kwargs)`` (tests pass a fake)."""

    name = "llm"

    def __init__(self, *, client: Any, model: str, unavailable_reason: str | None = None) -> None:
        self.client = client
        self.model = model
        self.unavailable_reason = unavailable_reason
        self.template = TemplateWriter()

    def _fallback(self, draft: dict[str, Any], reason: str) -> dict[str, Any]:
        log.info("LLM writer fell back to the template writer: %s", reason)
        return {**draft, "writer": "template", "fallback_reason": reason}

    def write(self, kind: str, facts: Mapping[str, object]) -> dict[str, Any]:
        draft = self.template.write(kind, facts)
        if self.client is None:
            return self._fallback(draft, self.unavailable_reason or "no LLM client is configured")
        try:
            response = self.client.beta.messages.create(
                model=self.model,
                max_tokens=MAX_TOKENS,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": _user_message(kind, facts, draft)}],
                output_config={
                    "effort": "medium",
                    "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA},
                },
                betas=[FALLBACK_BETA],
                fallbacks="default",
            )
        except Exception as exc:  # noqa: BLE001 - any SDK/network error means "use the template"
            return self._fallback(draft, f"the LLM call failed ({type(exc).__name__})")
        stop = getattr(response, "stop_reason", None)
        if stop == "refusal":
            return self._fallback(draft, "Claude declined to write this text (refusal)")
        if stop == "max_tokens":
            return self._fallback(draft, "the LLM answer was cut off (max_tokens)")
        raw = _response_text(response)
        if raw is None:
            return self._fallback(draft, "the LLM answer had no text block")
        try:
            parsed = json.loads(raw)
            sentences = [
                {"text": str(s["text"]), "evidence_ids": [str(i) for i in s["evidence_ids"]]}
                for s in parsed["sentences"]
            ]
        except (ValueError, KeyError, TypeError):
            return self._fallback(draft, "the LLM answer was not the expected JSON")
        separator = narrative_templates().formats.sentence_separator
        written: dict[str, Any] = {
            "kind": kind,
            "writer": "llm",
            "sentences": sentences,
            "text": separator.join(s["text"] for s in sentences),
        }
        problems = validate_written(written, facts)
        if problems:
            shown = "; ".join(problems[:MAX_PROBLEMS_IN_REASON])
            more = len(problems) - MAX_PROBLEMS_IN_REASON
            suffix = f" (+{more} more)" if more > 0 else ""
            return self._fallback(draft, f"LLM text rejected by validate_written: {shown}{suffix}")
        written["model"] = getattr(response, "model", None) or self.model
        return written


__all__ = ["OUTPUT_SCHEMA", "SYSTEM_PROMPT", "LlmWriter", "build_client"]
