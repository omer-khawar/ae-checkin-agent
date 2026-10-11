#!/usr/bin/env python3
"""Interim evaluation harness, over HTTP (CLAUDE.md §8, CONTRACTS.md §2.2 + R2.2 + R2.4).

Replays every persona in ``packages/rules/data/personas.json`` through the **running API**
exactly as the kiosk would (``POST /sessions`` -> answers -> gates -> vitals -> ``/complete``),
reads the stored check-in back (``GET /checkins/{id}``) and compares every key of the answer
key's ``expected`` block it knows how to compute. Unknown keys are logged as notices, never
failures. It then scores the deterministic chart-note scanner two ways, also over HTTP:

* every case of ``packages/rules/data/chartscan_answer_key.json`` through ``POST /scan``
  (AE-term and medication precision / recall, change accuracy, escalation recall,
  over-escalations, possible-SAE recall: the same arithmetic as
  ``interim_rules.chartscan.evaluate_answer_key``);
* the synthetic notes through ``POST /notes`` for fresh eval participants (drafted terms
  and meds, tier, escalation row, SAE clock at ingestion, cross-note follow-ups).

The comparison mirrors ``apps/api/interim_api/services/evaluation.py`` (the in-process
harness behind ``POST /eval/run``) but this script imports nothing from the API: it is a
black-box client that only speaks HTTP (httpx). It needs the admin login because the
backdating and per-session settings overrides are admin-only (DECISIONS.md D-004).

Every persona is its own synthetic participant created with ``is_eval = true``; eval rows
are hidden from the queue, escalations, SAE clocks, pages and exports by default. The
harness checks that this isolation holds after the run and that the API reports the same
version as ``packages/rules``; both are failures under ``--strict``, which is on by default
with ``--start-server`` (that server is this checkout, so a leak or a version skew is a bug).
Unknown ``expected`` keys are logged notices (CONTRACTS.md R2.2), never failures, unless
``--strict-keys`` is given.

Usage::

    python scripts/run_eval.py --start-server                 # self-contained (make eval, CI)
    python scripts/run_eval.py --api http://localhost:8000    # against a running API

Every persona (the hidden judge personas included) runs by default; ``--no-include-hidden`` runs
the visible ones only. Only the canonical run (``--start-server`` over every persona) writes
``docs/eval/results.md`` by default; any other run (``--api``, ``--persona-ids``,
``--no-include-hidden``) writes ``data/runtime/eval/results.live.md`` (gitignored) unless
``--out`` names a file, so a rehearsal never overwrites the committed record.

Exit status: 0 when every persona, counterfactual and scanner case passes; 1 on any failure,
including an HTTP error while replaying one persona, counterfactual, scan case or note (it is
recorded on that row and the run carries on, so the results file always reflects this run);
2 when the harness could not run (API unreachable, login refused, bad persona id, ``/study``
or ``/items`` unavailable).

No LLM, no network beyond the API given. Nothing here prints a secret.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

REPO_ROOT = Path(__file__).resolve().parents[1]
RULES_DATA = REPO_ROOT / "packages" / "rules" / "data"
API_DIR = REPO_ROOT / "apps" / "api"
DEFAULT_OUT = REPO_ROOT / "docs" / "eval" / "results.md"
"""The committed record: written by default only by the canonical ``--start-server`` run."""
LIVE_OUT = REPO_ROOT / "data" / "runtime" / "eval" / "results.live.md"
"""Default for every other run (``--api``, a persona subset): gitignored runtime data."""
SYNTHEA_RESULTS = REPO_ROOT / "docs" / "eval" / "synthea_results.md"

SESSION_SECONDS = 180
"""Kiosk time from session start to completion; persona ``tsOffsetS`` is relative to start
(the same convention as the in-process harness and ``personas.json`` replay_conventions)."""

KNOWN_EXPECTED_KEYS: frozenset[str] = frozenset(
    {
        "grades",
        "max_grade",
        "tier",
        "stop_screen",
        "red_flag_tier_floor",
        "corroboration_bump",
        "rules_fired_includes",
        "rules_fired_excludes",
        "sae_clock_started",
        "seriousness_suspected",
        "ae_drafts",
        "vs_drafts",
        "vs_not_done",
        "cm",
        "dedup_followups",
        "vitals_status",
        # R3.1 protocol logic (possible AESI + its 24 h clock, protocol tier floor).
        "aesi_suspected",
        "aesi_items",
        "aesi_clock_started",
        "protocol_tier_floor",
    }
)

PROTOCOL_CHECK_PREFIXES: tuple[str, ...] = ("aesi", "protocol_tier_floor")
"""Mismatch prefixes that count against the "possible AESI / protocol" correctness block."""

TIERS: tuple[str, ...] = ("0", "1", "2", "3")

NOTE_MAX_TIER = 2
"""A chart note escalates to Tier 2 at most (CONTRACTS.md R2.4, D-017: notes are
retrospective, nobody is paged)."""

EVAL_MARKER = "-EVAL-"
"""Every eval participant's USUBJID contains this (``{study}-EVAL-{persona}-{run}``)."""

Log = Callable[[str], None]


class HarnessError(RuntimeError):
    """The harness could not run (as opposed to a persona failing)."""


class ApiError(HarnessError):
    """The API answered a request with an HTTP error (4xx/5xx).

    During a replay this fails that one row (persona, counterfactual, scan case or note) and
    the run carries on; during setup (health, login, study, items) it aborts with exit 2.
    Transport failures (connection refused, timeout) stay plain ``HarnessError`` and abort.
    """


# --------------------------------------------------------------------------- #
# Time (UTC ISO-8601 with milliseconds, the API's canonical form)
# --------------------------------------------------------------------------- #


def parse_iso(value: str) -> datetime:
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    moment = datetime.fromisoformat(text)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC)


def fmt_iso(moment: datetime) -> str:
    utc = moment.astimezone(UTC)
    return f"{utc:%Y-%m-%dT%H:%M:%S}.{utc.microsecond // 1000:03d}Z"


def shift(value: str, *, seconds: float = 0.0, hours: float = 0.0, days: float = 0.0) -> str:
    return fmt_iso(parse_iso(value) + timedelta(seconds=seconds, hours=hours, days=days))


def iso_date(value: str) -> str:
    return parse_iso(value).date().isoformat()


def now_iso() -> str:
    return fmt_iso(datetime.now(UTC))


# --------------------------------------------------------------------------- #
# Tables (read as data; the clinical numbers stay in packages/rules/data)
# --------------------------------------------------------------------------- #


def load_table(name: str) -> dict[str, Any]:
    path = RULES_DATA / f"{name}.json"
    with path.open(encoding="utf-8") as fh:
        data: dict[str, Any] = json.load(fh)
    return data


def escalation_rank() -> dict[str, int]:
    """``none < human_requested < urgent < emergency`` from ``chartscan_red_flags.json``."""
    levels = load_table("chartscan_red_flags")["escalation_levels"]
    return {str(level): index for index, level in enumerate(levels)}


def expected_note_tier(
    *, level: str, serious: bool, has_findings: bool, rank: Mapping[str, int]
) -> int:
    """The tier CONTRACTS.md R2.4 gives an ingested note.

    A red flag at ``urgent`` or above (the order of ``chartscan_red_flags.json``
    ``escalation_levels``) or a hospitalization/ER cue -> Tier 2 (escalation row); otherwise
    any drafted finding -> Tier 1; nothing at all -> Tier 0. Never above ``NOTE_MAX_TIER``.
    """
    if rank.get(level, 0) >= rank["urgent"] or serious:
        tier = 2
    elif has_findings:
        tier = 1
    else:
        tier = 0
    return min(tier, NOTE_MAX_TIER)


def site_to_sponsor_hours() -> float:
    return float(load_table("seriousness")["site_to_sponsor_hours"])


def aesi_reporting_hours() -> float:
    """``protocol_rules.json`` ``aesi.reporting_hours`` (the possible-AESI clock, R3.1)."""
    return float(load_table("protocol_rules")["aesi"]["reporting_hours"])


def tier_names() -> dict[int, str]:
    """Tier display names from ``escalation_ladder.json`` when present, else the CLAUDE.md names."""
    names = {0: "Log", 1: "Coordinator review", 2: "Nurse call today", 3: "Urgent"}
    with contextlib.suppress(OSError, KeyError, TypeError, ValueError):
        ladder = load_table("escalation_ladder")
        for tier in ladder["tiers"]:
            names[int(tier["tier"])] = str(tier["name"])
    return names


def select_personas(
    all_personas: Sequence[Mapping[str, Any]],
    *,
    include_hidden: bool,
    persona_ids: Sequence[str] | None,
) -> list[Mapping[str, Any]]:
    """Same selection rule as ``POST /eval/run``: named ids win (hidden or not)."""
    if persona_ids:
        wanted = set(persona_ids)
        known = {str(p["id"]) for p in all_personas}
        unknown = sorted(wanted - known)
        if unknown:
            raise HarnessError(f"unknown persona id(s): {', '.join(unknown)}")
        return [p for p in all_personas if p["id"] in wanted]
    if include_hidden:
        return list(all_personas)
    return [p for p in all_personas if not p.get("hidden")]


# --------------------------------------------------------------------------- #
# HTTP client
# --------------------------------------------------------------------------- #


class Api:
    """A thin httpx wrapper: base ``/api/v1``, bearer token, RFC 7807 errors -> exceptions."""

    def __init__(self, base_url: str, *, timeout: float, bridge_token: str | None) -> None:
        self.base_url = base_url.rstrip("/")
        self.client = httpx.Client(base_url=f"{self.base_url}/api/v1", timeout=timeout)
        self.bridge_token = bridge_token or None
        self.n_requests = 0

    def close(self) -> None:
        self.client.close()

    def login(self, username: str, password: str) -> None:
        body = self.call("POST", "/auth/login", json={"username": username, "password": password})
        if body.get("role") != "admin":
            raise HarnessError(f"user {username!r} is not an admin (the overrides need one)")
        self.client.headers["Authorization"] = f"Bearer {body['token']}"

    def call(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Any:
        self.n_requests += 1
        try:
            response = self.client.request(
                method, path, json=json, params=dict(params or {}), headers=dict(headers or {})
            )
        except httpx.HTTPError as exc:
            raise HarnessError(f"{method} {path}: {exc}") from exc
        if response.status_code >= 400:
            detail = response.text[:600]
            with contextlib.suppress(ValueError):
                problem = response.json()
                detail = f"{problem.get('title')}: {problem.get('detail')}"
            raise ApiError(f"{method} {path} -> HTTP {response.status_code} ({detail})")
        if not response.content:
            return None
        return response.json()

    def openapi(self) -> dict[str, Any] | None:
        """The API's OpenAPI document (served at the root, outside ``/api/v1``), or None."""
        self.n_requests += 1
        with contextlib.suppress(httpx.HTTPError, ValueError):
            response = self.client.get(f"{self.base_url}/openapi.json")
            if response.status_code == 200:
                body = response.json()
                return body if isinstance(body, dict) else None
        return None

    def get_all(self, path: str, params: Mapping[str, Any] | None = None) -> list[Any]:
        """Every item of a paginated list (``{items, total, limit, offset}``) or a bare list."""
        out: list[Any] = []
        offset = 0
        while True:
            query = {**dict(params or {}), "limit": 500, "offset": offset}
            page = self.call("GET", path, params=query)
            if isinstance(page, list):
                return page
            items = list(page.get("items", []))
            out.extend(items)
            offset += len(items)
            if not items or offset >= int(page.get("total", 0)):
                return out


# --------------------------------------------------------------------------- #
# Replay
# --------------------------------------------------------------------------- #


@dataclass
class Context:
    api: Api
    study_id: str
    instrument: dict[str, list[str]]
    """item_id -> attributes, from ``GET /items`` (omitted answers are recorded as 0)."""
    protocol_context_via: str | None = None
    """Where the API takes a persona's ``protocol_context`` (CONTRACTS.md R3.1):
    ``"session"`` (``POST /sessions``), ``"complete"`` (``POST /sessions/{id}/complete``) or
    ``None`` when its OpenAPI document shows no such input yet (see ``protocol_context_input``).
    """


def needs_protocol_context(persona: Mapping[str, Any]) -> bool:
    """True when the persona's ``protocol_context`` differs from the engine default.

    personas.json schema: an absent context means "no prior PI3K inhibitor, last dose
    unknown", so only a persona that sets one of those facts depends on the API receiving it.
    """
    context = persona.get("protocol_context") or {}
    return bool(context.get("prior_pi3k_inhibitor")) or context.get("last_dose_date") is not None


def protocol_context_input(openapi: Mapping[str, Any] | None) -> str | None:
    """Which request body of the running API declares a ``protocol_context`` property.

    Read from the API's own OpenAPI document so the harness starts sending the context the
    moment the API accepts it (R3.2), and never sends a field the API would reject (422).
    """
    schemas = ((openapi or {}).get("components") or {}).get("schemas") or {}
    for via, name in (("session", "CreateSessionRequest"), ("complete", "CompleteRequest")):
        properties = (schemas.get(name) or {}).get("properties") or {}
        if "protocol_context" in properties:
            return via
    return None


def materialize_samples(raw: Sequence[Mapping[str, Any]], started_at: str) -> list[dict[str, Any]]:
    """Persona samples (camelCase, ``tsOffsetS``) -> bridge-shaped samples with ``tsUtc``."""
    out = []
    for sample in raw:
        body = {k: v for k, v in sample.items() if k not in ("tsOffsetS", "ts_offset_s")}
        if "tsUtc" not in body and "ts_utc" not in body:
            offset = sample.get("tsOffsetS", sample.get("ts_offset_s"))
            if offset is None:
                raise HarnessError("persona vitals sample has neither tsUtc nor tsOffsetS")
            body["tsUtc"] = shift(started_at, seconds=float(offset))
        out.append(body)
    return out


def run_checkin(
    ctx: Context,
    *,
    usubjid: str,
    responses: Mapping[str, Mapping[str, int]],
    gates: Mapping[str, Any],
    vitals: Sequence[Mapping[str, Any]],
    consent_camera: bool,
    rule_settings: Mapping[str, Any] | None,
    completed_at: str,
    protocol_context: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """One kiosk check-in over HTTP, backdated to ``completed_at``; returns the check-in detail."""
    api = ctx.api
    started_at = shift(completed_at, seconds=-SESSION_SECONDS)
    context_body: dict[str, Any] = (
        {"protocol_context": dict(protocol_context)} if protocol_context is not None else {}
    )
    session = api.call(
        "POST",
        "/sessions",
        json={
            "usubjid": usubjid,
            "consent_camera": consent_camera,
            "started_at_override": started_at,
            "create_participant": True,
            "is_eval": True,
            **(context_body if ctx.protocol_context_via == "session" else {}),
        },
    )
    session_id = str(session["id"])
    # Answer-key convention: an item or attribute a persona omits means "none / never" (0); it
    # is answered explicitly so the check-in passes the API's completeness check.
    full: dict[str, dict[str, int]] = {
        item_id: dict.fromkeys(attributes, 0) for item_id, attributes in ctx.instrument.items()
    }
    for item_id, attrs in responses.items():
        full.setdefault(item_id, {}).update({str(k): int(v) for k, v in attrs.items()})
    for item_id, attrs in full.items():
        for attribute, value in attrs.items():
            api.call(
                "POST",
                f"/sessions/{session_id}/answers",
                json={
                    "item_id": item_id,
                    "attribute": attribute,
                    "value": int(value),
                    "ts_client": completed_at,
                },
            )
    api.call(
        "POST",
        f"/sessions/{session_id}/gates",
        json={
            "hospitalization": bool(gates.get("hospitalization", False)),
            "conmed_changed": bool(gates.get("conmed_changed", False)),
            "conmed_text": gates.get("conmed_text"),
            "conmed_direction": gates.get("conmed_direction") or None,
            "other_text": gates.get("other_text"),
            "temp_c": gates.get("temp_c"),
            "ts_client": completed_at,
        },
    )
    if vitals and consent_camera:
        headers = {"X-Bridge-Token": api.bridge_token} if api.bridge_token else None
        api.call(
            "POST",
            f"/sessions/{session_id}/vitals",
            json={"samples": materialize_samples(vitals, started_at)},
            headers=headers,
        )
    api.call(
        "POST",
        f"/sessions/{session_id}/complete",
        json={
            "ts_client": completed_at,
            "completed_at_override": completed_at,
            "settings_override": dict(rule_settings or {}),
            **(context_body if ctx.protocol_context_via == "complete" else {}),
        },
    )
    detail: dict[str, Any] = api.call("GET", f"/checkins/{session_id}")
    return detail


def confirm_ae_drafts(ctx: Context, detail: Mapping[str, Any]) -> int:
    """Confirm a prior check-in's AE drafts so they become confirmed open AEs."""
    n = 0
    for draft in detail.get("drafts", []):
        if draft.get("domain") == "AE" and draft.get("status") == "draft":
            ctx.api.call(
                "POST",
                f"/drafts/{draft['id']}/confirm",
                json={"note": "confirmed by the eval harness (prior check-in)"},
            )
            n += 1
    return n


def replay_persona(
    ctx: Context,
    persona: Mapping[str, Any],
    *,
    suffix: str,
    completed_at: str,
    rule_settings: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Replay one persona (prior check-ins first, AE drafts confirmed) as a fresh participant."""
    usubjid = f"{ctx.study_id}-EVAL-{persona['id']}-{suffix}"
    setup = persona.get("setup") or {}
    priors = sorted(setup.get("prior_checkins", []), key=lambda p: -float(p["days_ago"]))
    for prior in priors:
        prior_vitals = prior.get("vitals_samples", [])
        prior_detail = run_checkin(
            ctx,
            usubjid=usubjid,
            responses=prior["responses"],
            gates=prior.get("gates", {}),
            vitals=prior_vitals,
            consent_camera=bool(prior_vitals),
            rule_settings=persona.get("settings"),
            completed_at=shift(completed_at, days=-float(prior["days_ago"])),
            protocol_context=persona.get("protocol_context"),
        )
        confirm_ae_drafts(ctx, prior_detail)
    effective = dict(persona.get("settings") or {})
    if rule_settings is not None:
        effective.update(rule_settings)
    consent = bool(persona.get("consent_camera", True))
    return run_checkin(
        ctx,
        usubjid=usubjid,
        responses=persona["responses"],
        gates=persona.get("gates", {}),
        vitals=persona.get("vitals_samples", []) if consent else [],
        consent_camera=consent,
        rule_settings=effective,
        completed_at=completed_at,
        protocol_context=persona.get("protocol_context"),
    )


# --------------------------------------------------------------------------- #
# Comparison (mirrors interim_api.services.evaluation.compare, over the HTTP detail)
# --------------------------------------------------------------------------- #


def draft_value(draft: Mapping[str, Any], name: str) -> Any:
    """A field of a draft: engine shape ``[{name, value, ...}]`` or stored shape ``{NAME: v}``."""
    fields = draft.get("fields", [])
    if isinstance(fields, Mapping):
        return fields.get(name)
    for f in fields:
        if f.get("name") == name:
            return f.get("value")
    return None


def draft_invariants(drafts: Sequence[Mapping[str, Any]], tier: Any, *, where: str) -> list[str]:
    """Per-field invariants of one set of drafts (engine shape or stored shape)."""
    out: list[str] = []
    for d in drafts:
        domain = d.get("domain")
        if domain == "AE":
            if draft_value(d, "INTERIM_TIER") != tier:
                out.append(f"invariant: {where} AE draft INTERIM_TIER differs from the tier")
            if draft_value(d, "INTERIM_PROVISIONAL") is not True:
                out.append(f"invariant: {where} AE draft is not marked provisional")
            if draft_value(d, "AETOXGR") not in (1, 2, 3):
                out.append(f"invariant: {where} AE draft AETOXGR outside 1..3")
        elif domain == "VS":
            measured, method = draft_value(d, "INTERIM_IS_MEASURED"), draft_value(d, "VSMETHOD")
            if measured is True and method == "Simulated":
                out.append(f"invariant: a measured {where} VS row is labeled Simulated")
            if measured is False and method != "Simulated":
                out.append(f"invariant: a simulated {where} VS row is not labeled Simulated")
    return out


STORED_KEY_FIELDS: dict[str, tuple[str, ...]] = {
    "AE": ("AEDECOD", "AETERM", "AETOXGR", "AESTDTC", "INTERIM_TIER"),
    "VS": ("VSTESTCD", "VSORRES", "VSORRESU", "VSSTAT", "VSMETHOD", "INTERIM_SOURCE"),
    "CM": ("CMTRT", "CMDECOD", "CMSTDTC", "CMENDTC"),
}
"""Fields whose stored value must equal the engine's (the ones a coordinator confirms)."""


def stored_vs_engine(
    stored: Sequence[Mapping[str, Any]], engine: Sequence[Mapping[str, Any]]
) -> list[str]:
    """Each domain's stored rows carry the same key-field values as the engine's drafts."""

    def rows(drafts: Sequence[Mapping[str, Any]], domain: str) -> list[str]:
        names = STORED_KEY_FIELDS[domain]
        return sorted(
            json.dumps([draft_value(d, n) for n in names], default=str)
            for d in drafts
            if d.get("domain") == domain
        )

    out: list[str] = []
    for domain, names in STORED_KEY_FIELDS.items():
        got, want = rows(stored, domain), rows(engine, domain)
        # A count difference is reported by the stored-draft count invariant instead.
        if len(got) == len(want) and got != want:
            out.append(
                f"invariant: stored {domain} drafts differ from the engine's on {', '.join(names)}"
            )
    return out


def compare(
    detail: Mapping[str, Any],
    expected: Mapping[str, Any],
    *,
    completed_at: str,
    sae_hours: float,
) -> tuple[dict[str, Any], list[str], list[str]]:
    """Return ``(actual, mismatches, notices)`` for every expected key the harness knows.

    ``detail`` is ``GET /checkins/{id}``; ``detail["result"]`` is the stored engine result.
    Beyond the in-process checks it verifies that what was *persisted* (session tier, draft
    rows, SAE clock row) agrees with what the engine decided.
    """
    result: Mapping[str, Any] = detail.get("result") or {}
    mismatches: list[str] = []
    notices: list[str] = []
    fired = [str(r["rule_id"]) for r in result.get("rules_fired", [])]
    drafts = result.get("drafts", [])
    ae_drafts = [d for d in drafts if d["domain"] == "AE"]
    vs_drafts = [d for d in drafts if d["domain"] == "VS"]
    cm_drafts = [d for d in drafts if d["domain"] == "CM"]
    grades = {str(i["item_id"]): int(i["provisional_grade"]) for i in result.get("items", [])}
    sae_clock = result.get("sae_clock")
    aesi_clock = result.get("aesi_clock")
    protocol = result.get("protocol") or {}
    conmed = result.get("conmed")
    actual: dict[str, Any] = {
        "grades": grades,
        "max_grade": result.get("max_grade"),
        "tier": result.get("escalation_tier"),
        "stop_screen": result.get("stop_screen"),
        "page_oncall": result.get("page_oncall"),
        "red_flag_tier_floor": result.get("red_flag_tier_floor"),
        "corroboration_bump": result.get("corroboration_bump"),
        "rules_fired": fired,
        "sae_clock_started": sae_clock is not None,
        "seriousness_suspected": result.get("seriousness_suspected"),
        "ae_drafts": len(ae_drafts),
        "vs_drafts": len(vs_drafts),
        "vs_not_done": sorted(
            str(draft_value(d, "VSTESTCD"))
            for d in vs_drafts
            if draft_value(d, "VSSTAT") == "NOT DONE"
        ),
        "cm": [
            {
                "verbatim": draft_value(d, "CMTRT"),
                "cmdecod": draft_value(d, "CMDECOD"),
                "confidence": draft_value(d, "INTERIM_MATCH_CONFIDENCE"),
                "match_kind": draft_value(d, "INTERIM_MATCH_KIND"),
                "direction": draft_value(d, "INTERIM_DIRECTION"),
                "distance": conmed.get("distance") if conmed else None,
            }
            for d in cm_drafts
        ],
        "dedup_followups": sum(1 for d in ae_drafts if d.get("is_followup")),
        "vitals_status": (result.get("vitals") or {}).get("status"),
        "aesi_suspected": bool(protocol.get("aesi_suspected")),
        "aesi_items": sorted(str(i) for i in protocol.get("aesi_items") or []),
        "aesi_clock_started": aesi_clock is not None,
        "protocol_tier_floor": result.get("protocol_tier_floor"),
    }

    def check(key: str, got: Any, want: Any) -> None:
        if got != want:
            mismatches.append(f"{key}: expected {want!r}, got {got!r}")

    for key in expected:
        if key not in KNOWN_EXPECTED_KEYS:
            notices.append(f"expected.{key} is not compared by this harness")

    if "grades" in expected:
        check("grades", grades, {k: int(v) for k, v in expected["grades"].items()})
    if "max_grade" in expected:
        check("max_grade", actual["max_grade"], expected["max_grade"])
    if "tier" in expected:
        check("tier", actual["tier"], expected["tier"])
    if "stop_screen" in expected:
        check("stop_screen", actual["stop_screen"], expected["stop_screen"])
    if actual["stop_screen"] != actual["page_oncall"] or actual["stop_screen"] != (
        actual["tier"] == 3
    ):
        mismatches.append("invariant: stop_screen == page_oncall == (tier == 3) violated")
    if "red_flag_tier_floor" in expected:
        check("red_flag_tier_floor", actual["red_flag_tier_floor"], expected["red_flag_tier_floor"])
    if "corroboration_bump" in expected:
        check("corroboration_bump", actual["corroboration_bump"], expected["corroboration_bump"])
    for rule_id in expected.get("rules_fired_includes", []):
        if rule_id not in fired:
            mismatches.append(f"rules_fired_includes: {rule_id} did not fire")
    for rule_id in expected.get("rules_fired_excludes", []):
        if rule_id in fired:
            mismatches.append(f"rules_fired_excludes: {rule_id} fired")
    if "sae_clock_started" in expected:
        check("sae_clock_started", actual["sae_clock_started"], expected["sae_clock_started"])
        if sae_clock is not None:
            check("sae_clock.site_awareness_at", sae_clock.get("site_awareness_at"), completed_at)
            check("sae_clock.due_at", sae_clock.get("due_at"), shift(completed_at, hours=sae_hours))
            stored = detail.get("sae_clock")
            if stored is None:
                mismatches.append("sae_clock: the engine started one but none was stored")
            elif stored.get("due_at") != sae_clock.get("due_at"):
                mismatches.append("sae_clock: the stored due_at differs from the engine's")
            elif stored.get("kind", "sae") != "sae":
                mismatches.append(f"sae_clock: the stored clock is kind {stored.get('kind')!r}")
    stored_clock = detail.get("sae_clock")
    if sae_clock is None and stored_clock is not None and stored_clock.get("kind", "sae") == "sae":
        # The dashboard counts down whatever is stored; a clock the engine never started (a
        # carried-over row, a mislabeled AESI clock) must not pass as "no SAE clock".
        mismatches.append("sae_clock: none was started but an SAE clock row is stored")
    if "seriousness_suspected" in expected:
        check(
            "seriousness_suspected",
            actual["seriousness_suspected"],
            expected["seriousness_suspected"],
        )
    if "ae_drafts" in expected:
        check("ae_drafts", actual["ae_drafts"], expected["ae_drafts"])
    if "vs_drafts" in expected:
        check("vs_drafts", actual["vs_drafts"], expected["vs_drafts"])
    if "vs_not_done" in expected:
        check("vs_not_done", actual["vs_not_done"], sorted(expected["vs_not_done"]))
        for d in vs_drafts:
            has_value = draft_value(d, "VSORRES") is not None
            if has_value != (draft_value(d, "VSSTAT") is None):
                mismatches.append(f"VS {draft_value(d, 'VSTESTCD')}: VSORRES/VSSTAT inconsistent")
    if "cm" in expected:
        want_cm = list(expected["cm"])
        if len(cm_drafts) != len(want_cm):
            mismatches.append(f"cm: expected {len(want_cm)} CM draft(s), got {len(cm_drafts)}")
        else:
            for index, (exp, got) in enumerate(zip(want_cm, actual["cm"], strict=True)):
                where = f"cm[{index}]"
                check(f"{where}.verbatim", got["verbatim"], exp.get("verbatim"))
                check(f"{where}.cmdecod", got["cmdecod"], exp.get("cmdecod"))
                confidence = got["confidence"]
                if not isinstance(confidence, int | float) or confidence < float(
                    exp.get("min_confidence", 0.0)
                ):
                    mismatches.append(
                        f"{where}.confidence {confidence!r} < {exp.get('min_confidence')}"
                    )
                if "match_kind" in exp:
                    check(f"{where}.match_kind", got["match_kind"], exp["match_kind"])
                if "distance" in exp:
                    check(f"{where}.distance", got["distance"], exp["distance"])
                if "direction" in exp:
                    direction = exp["direction"]
                    day = iso_date(completed_at)
                    check(f"{where}.direction", got["direction"], direction)
                    draft = cm_drafts[index]
                    check(
                        f"{where}.CMSTDTC",
                        draft_value(draft, "CMSTDTC"),
                        day if direction in ("started", "both") else None,
                    )
                    check(
                        f"{where}.CMENDTC",
                        draft_value(draft, "CMENDTC"),
                        day if direction in ("stopped", "both") else None,
                    )
            if want_cm and (conmed is None or conmed.get("verbatim") != want_cm[0].get("verbatim")):
                mismatches.append("cm: result.conmed.verbatim does not match the first expected CM")
            if not want_cm and conmed is not None:
                mismatches.append("cm: unexpected con-med match in result")
    if "dedup_followups" in expected:
        check("dedup_followups", actual["dedup_followups"], expected["dedup_followups"])
        open_rows = {
            str(link["ae_open_id"]): link.get("open_ae") or {}
            for link in detail.get("ae_links", [])
            if link.get("ae_open_id")
        }
        for d in ae_drafts:
            if not d.get("is_followup"):
                continue
            linked = open_rows.get(str(d.get("linked_ae_open_id")))
            if not linked:
                mismatches.append("dedup: follow-up draft points at an unknown open AE")
                continue
            check("dedup.INTERIM_FOLLOWUP_OF", draft_value(d, "INTERIM_FOLLOWUP_OF"), linked["id"])
            check("dedup.AESTDTC", draft_value(d, "AESTDTC"), linked.get("first_reported_at"))
            check("dedup.AEDECOD", draft_value(d, "AEDECOD"), linked.get("aedecod"))
            check("dedup.AEONGO", draft_value(d, "AEONGO"), "Y")
    if "vitals_status" in expected:
        check("vitals_status", actual["vitals_status"], expected["vitals_status"])
    if "aesi_suspected" in expected:
        check("aesi_suspected", actual["aesi_suspected"], expected["aesi_suspected"])
    if "aesi_items" in expected:
        check("aesi_items", actual["aesi_items"], sorted(expected["aesi_items"]))
    if "aesi_clock_started" in expected:
        check("aesi_clock_started", actual["aesi_clock_started"], expected["aesi_clock_started"])
        if aesi_clock is not None:
            hours = aesi_reporting_hours()
            check("aesi_clock.kind", aesi_clock.get("kind"), "aesi")
            check("aesi_clock.site_awareness_at", aesi_clock.get("site_awareness_at"), completed_at)
            check("aesi_clock.due_at", aesi_clock.get("due_at"), shift(completed_at, hours=hours))
            stored_aesi = detail.get("aesi_clock")
            if stored_aesi is None:
                mismatches.append("aesi_clock: the engine started one but none was stored")
            elif stored_aesi.get("due_at") != aesi_clock.get("due_at"):
                mismatches.append("aesi_clock: the stored due_at differs from the engine's")
    if "protocol_tier_floor" in expected:
        check("protocol_tier_floor", actual["protocol_tier_floor"], expected["protocol_tier_floor"])

    # Invariants (as in the in-process harness), on the engine's drafts *and* on the stored
    # Draft rows the dashboard and the exports actually show.
    stored_drafts = list(detail.get("drafts", []))
    mismatches.extend(draft_invariants(drafts, actual["tier"], where="engine"))
    mismatches.extend(draft_invariants(stored_drafts, actual["tier"], where="stored"))
    mismatches.extend(stored_vs_engine(stored_drafts, drafts))

    # Persistence invariants (only observable from outside, over HTTP).
    session = detail.get("session") or {}
    if session.get("tier") != actual["tier"]:
        mismatches.append(
            f"invariant: stored session tier {session.get('tier')!r} != engine tier "
            f"{actual['tier']!r}"
        )
    stored_counts = {"AE": 0, "VS": 0, "CM": 0}
    for d in stored_drafts:
        if d.get("domain") in stored_counts:
            stored_counts[str(d["domain"])] += 1
    engine_counts = {"AE": len(ae_drafts), "VS": len(vs_drafts), "CM": len(cm_drafts)}
    if stored_counts != engine_counts:
        mismatches.append(
            f"invariant: stored drafts {stored_counts} differ from the engine's {engine_counts}"
        )
    return actual, mismatches, notices


# --------------------------------------------------------------------------- #
# Metrics
# --------------------------------------------------------------------------- #


def prf(tp: int, fp: int, fn: int, *, digits: int = 4) -> tuple[float, float, float]:
    """Precision / recall / F1; an empty denominator scores 1.0 (the in-process convention)."""
    precision = tp / (tp + fp) if (tp + fp) else 1.0
    recall = tp / (tp + fn) if (tp + fn) else 1.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    return round(precision, digits), round(recall, digits), round(f1, digits)


def prf_block(tp: int, fp: int, fn: int, *, digits: int = 3) -> dict[str, float | int]:
    precision, recall, f1 = prf(tp, fp, fn, digits=digits)
    return {"tp": tp, "fp": fp, "fn": fn, "precision": precision, "recall": recall, "f1": f1}


def tier_metrics(pairs: Sequence[tuple[int, int]]) -> dict[str, dict[str, float | int]]:
    """``pairs`` = (expected_tier, actual_tier); one-vs-rest per tier."""
    out: dict[str, dict[str, float | int]] = {}
    for tier in TIERS:
        t = int(tier)
        tp = sum(1 for e, a in pairs if e == t and a == t)
        fp = sum(1 for e, a in pairs if e != t and a == t)
        fn = sum(1 for e, a in pairs if e == t and a != t)
        precision, recall, f1 = prf(tp, fp, fn)
        out[tier] = {
            "precision": precision,
            "recall": recall,
            "f1": f1,
            "support": sum(1 for e, _ in pairs if e == t),
            "predicted": sum(1 for _, a in pairs if a == t),
        }
    return out


def grade_confusion(pairs: Sequence[tuple[int, int]]) -> list[list[int]]:
    matrix = [[0] * 4 for _ in range(4)]
    for expected, actual in pairs:
        if 0 <= expected <= 3 and 0 <= actual <= 3:
            matrix[expected][actual] += 1
    return matrix


# --------------------------------------------------------------------------- #
# Personas
# --------------------------------------------------------------------------- #


def run_personas(
    ctx: Context,
    selected: Sequence[Mapping[str, Any]],
    *,
    suffix: str,
    completed_at: str,
    sae_hours: float,
    log: Log,
) -> dict[str, Any]:
    per_persona: list[dict[str, Any]] = []
    counterfactuals: list[dict[str, Any]] = []
    notices: list[str] = []
    tier_pairs: list[tuple[int, int]] = []
    grade_pairs: list[tuple[int, int]] = []
    dedup = {"n": 0, "correct": 0}
    sae = {"n": 0, "correct": 0}
    conmed = {"n": 0, "correct": 0}
    aesi = {"n": 0, "correct": 0}

    def note(text: str) -> None:
        notices.append(text)
        log(f"  notice  {text}")

    not_replayable: list[dict[str, Any]] = []
    for persona in selected:
        if needs_protocol_context(persona) and ctx.protocol_context_via is None:
            # Declared up front from the persona and the API's OpenAPI document, never from a
            # result: the engine would evaluate this persona without its protocol facts.
            reason = (
                "its protocol_context "
                f"{json.dumps(persona.get('protocol_context'), sort_keys=True)} has no input "
                "path in this API yet (no `protocol_context` on POST /sessions or /complete, "
                "CONTRACTS.md R3.2); replayed in-process by packages/rules/tests/test_personas.py"
            )
            not_replayable.append(
                {
                    "persona_id": persona["id"],
                    "name": persona.get("name", persona["id"]),
                    "reason": reason,
                }
            )
            log(f"  SKIP  {persona['id']}  not replayable over HTTP: {reason}")
            continue
        expected = persona.get("expected") or {}
        actual: dict[str, Any] | None = None
        detail: Mapping[str, Any] = {}
        try:
            detail = replay_persona(ctx, persona, suffix=suffix, completed_at=completed_at)
        except ApiError as exc:
            # One persona's HTTP error fails that row; the rest of the run still reports.
            mismatches = [f"API error: {exc}"]
        else:
            actual, mismatches, persona_notices = compare(
                detail, expected, completed_at=completed_at, sae_hours=sae_hours
            )
            for text in persona_notices:
                note(f"{persona['id']}: {text}")
        actual_tier = actual["tier"] if actual is not None else None
        if "tier" in expected:
            tier_pairs.append(
                (int(expected["tier"]), -1 if actual_tier is None else int(actual_tier))
            )
        actual_grades: Mapping[str, int] = actual["grades"] if actual is not None else {}
        for item_id, grade in (expected.get("grades") or {}).items():
            grade_pairs.append((int(grade), int(actual_grades.get(item_id, -1))))
        for block, prefix, trigger in (
            (dedup, "dedup", "dedup_followups"),
            (sae, "sae_clock", "sae_clock_started"),
            (conmed, "cm", "cm"),
        ):
            if trigger in expected:
                block["n"] += 1
                if actual is not None and not any(m.startswith(prefix) for m in mismatches):
                    block["correct"] += 1
        if any(
            k in expected
            for k in ("aesi_suspected", "aesi_items", "aesi_clock_started", "protocol_tier_floor")
        ):
            aesi["n"] += 1
            if actual is not None and not any(
                m.startswith(PROTOCOL_CHECK_PREFIXES) for m in mismatches
            ):
                aesi["correct"] += 1
        per_persona.append(
            {
                "persona_id": persona["id"],
                "name": persona.get("name", persona["id"]),
                "category": persona.get("category"),
                "hidden": bool(persona.get("hidden")),
                "pass": not mismatches,
                "expected_tier": expected.get("tier"),
                "actual_tier": actual_tier,
                "mismatches": mismatches,
                "session_id": (detail.get("session") or {}).get("id"),
            }
        )
        log(
            f"  {'PASS' if not mismatches else 'FAIL'}  {persona['id']}  "
            f"tier {actual_tier} (expected {expected.get('tier', '-')})"
            + (f"  {'; '.join(mismatches)}" if mismatches else "")
        )
        for index, cf in enumerate(persona.get("counterfactuals") or []):
            label = str(cf.get("label", f"counterfactual {index}"))
            cf_actual: dict[str, Any] | None = None
            try:
                cf_detail = replay_persona(
                    ctx,
                    persona,
                    suffix=f"{suffix}-cf{index}",
                    completed_at=completed_at,
                    rule_settings=cf.get("settings"),
                )
            except ApiError as exc:
                cf_mismatches = [f"API error: {exc}"]
            else:
                cf_actual, cf_mismatches, cf_notices = compare(
                    cf_detail,
                    cf.get("expected") or {},
                    completed_at=completed_at,
                    sae_hours=sae_hours,
                )
                for text in cf_notices:
                    note(f"{persona['id']} [{label}]: {text}")
                if actual is None:
                    cf_mismatches.append("baseline replay failed: nothing to compare against")
                else:
                    if cf_actual["grades"] != actual["grades"]:
                        cf_mismatches.append("invariant: settings changed a provisional grade")
                    if cf_actual["tier"] == actual["tier"]:
                        cf_mismatches.append(
                            "counterfactual changed nothing: tier identical to baseline"
                        )
            cf_tier = cf_actual["tier"] if cf_actual is not None else None
            counterfactuals.append(
                {
                    "persona_id": persona["id"],
                    "label": label,
                    "baseline_tier": actual_tier,
                    "tier": cf_tier,
                    "pass": not cf_mismatches,
                    "mismatches": cf_mismatches,
                }
            )
            log(
                f"  {'PASS' if not cf_mismatches else 'FAIL'}  {persona['id']} "
                f"[{label}]  tier {actual_tier} -> {cf_tier}"
                + (f"  {'; '.join(cf_mismatches)}" if cf_mismatches else "")
            )

    n_pass = sum(1 for p in per_persona if p["pass"])
    return {
        "n_personas": len(per_persona),
        "n_pass": n_pass,
        "n_fail": len(per_persona) - n_pass,
        "tier_metrics": tier_metrics(tier_pairs),
        "grade_confusion": grade_confusion(grade_pairs),
        "dedup_correct": dedup,
        "sae_clock_correct": sae,
        "conmed_correct": conmed,
        "aesi_correct": aesi,
        "per_persona": per_persona,
        "counterfactuals": counterfactuals,
        "not_replayable": not_replayable,
        "notices": sorted(set(notices)),
    }


# --------------------------------------------------------------------------- #
# Chart-note scanner
# --------------------------------------------------------------------------- #


@dataclass
class ScanOutcome:
    case_id: str
    kind: str
    problems: list[str]
    not_scorable: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems


def predicted_escalation(scan: Mapping[str, Any], kind: str, rank: Mapping[str, int]) -> str:
    """The escalation the answer key scores, rebuilt from a ``POST /scan`` response.

    A chart note routes every red flag to ``urgent`` (the API's own ``escalation_level``);
    an utterance keeps each red flag's level, plus ``human_requested`` when the scan says so
    (the same rule as ``interim_rules.chartscan.escalation_level``).
    """
    if kind == "note":
        return str(scan.get("escalation_level", "none"))
    levels = ["none"] + [str(f.get("level", "none")) for f in scan.get("red_flags", [])]
    if scan.get("human_requested"):
        levels.append("human_requested")
    return max(levels, key=lambda level: rank.get(level, 0))


def score_answer_key(
    api: Api, cases: Sequence[Mapping[str, Any]], utterance_ref: str, rank: Mapping[str, int]
) -> dict[str, Any]:
    """Every answer-key case through ``POST /scan``, with the source evaluator's arithmetic."""
    urgent_rank, emergency_rank = rank["urgent"], rank["emergency"]
    human_rank = rank.get("human_requested", -1)
    ae_tp = ae_fp = ae_fn = med_tp = med_fp = med_fn = 0
    change_hits = change_total = 0
    exact = esc_scored = 0
    urgent_needed = urgent_caught = urgent_predicted = 0
    emergency_needed = emergency_caught = over = 0
    serious_needed = serious_caught = serious_fp = 0
    outcomes: list[ScanOutcome] = []
    for case in cases:
        kind = str(case["kind"])
        ref = str(case.get("note_date") or utterance_ref) if kind == "note" else utterance_ref
        api_error: str | None = None
        try:
            scan = api.call("POST", "/scan", json={"text": case["text"], "ref_date": ref})
        except ApiError as exc:
            # Scored as an empty scan (every expected finding becomes a miss) and labeled.
            scan, api_error = {}, f"API error: {exc}"
        exp = case["expected"]
        e_terms = {str(t) for t in exp.get("ae_terms", [])}
        g_terms = {str(s["term"]) for s in scan.get("symptoms", [])}
        ae_tp += len(e_terms & g_terms)
        ae_fp += len(g_terms - e_terms)
        ae_fn += len(e_terms - g_terms)

        e_meds = {(str(d), str(c)) for d, c in exp.get("meds", [])}
        g_meds = {(str(m["drug"]), str(m["change"])) for m in scan.get("meds", [])}
        e_drugs, g_drugs = {d for d, _ in e_meds}, {d for d, _ in g_meds}
        med_tp += len(e_drugs & g_drugs)
        med_fp += len(g_drugs - e_drugs)
        med_fn += len(e_drugs - g_drugs)
        for drug, change in e_meds:
            if drug in g_drugs:
                change_total += 1
                change_hits += (drug, change) in g_meds

        problems: list[str] = []
        not_scorable: list[str] = []
        want_esc = str(exp.get("escalation", "none"))
        got_esc = predicted_escalation(scan, kind, rank)
        er, gr = rank[want_esc], rank.get(got_esc, 0)
        if kind == "utterance" and er == human_rank:
            # POST /scan scans clinician text and never enables the participant-utterance
            # "talk to a person" detector: Interim has no utterance input path (the kiosk's
            # free text is stored verbatim and never parsed). Not observable over HTTP.
            not_scorable.append(
                f"expected escalation {want_esc!r}: POST /scan never runs the human-request "
                "detector (Interim has no participant-utterance input)"
            )
        else:
            esc_scored += 1
            exact += er == gr
            if er >= urgent_rank:
                urgent_needed += 1
                urgent_caught += gr >= urgent_rank
            urgent_predicted += gr >= urgent_rank
            if er == emergency_rank:
                emergency_needed += 1
                emergency_caught += gr == emergency_rank
            over += gr > er
            if er != gr:
                problems.append(f"escalation expected={want_esc} got={got_esc}")
        want_serious = bool(exp.get("serious", False))
        got_serious = bool(scan.get("seriousness_suspected"))
        if want_serious:
            serious_needed += 1
            serious_caught += got_serious
            if not got_serious:
                problems.append("missed possible-SAE cue")
        elif got_serious:
            serious_fp += 1
        if e_terms != g_terms:
            problems.append(
                f"AE missed={sorted(e_terms - g_terms)} extra={sorted(g_terms - e_terms)}"
            )
        if e_meds != g_meds:
            problems.append(f"meds expected={sorted(e_meds)} got={sorted(g_meds)}")
        if api_error is not None:
            problems.insert(0, api_error)
        elif scan.get("dry_run") is not True:
            problems.append("invariant: POST /scan did not report dry_run")
        outcomes.append(ScanOutcome(str(case["id"]), kind, problems, not_scorable))

    fully = [o for o in outcomes if not o.not_scorable]
    partly = [o for o in outcomes if o.not_scorable]

    return {
        "n_cases": len(cases),
        "n_notes": sum(1 for c in cases if c["kind"] == "note"),
        "n_utterances": sum(1 for c in cases if c["kind"] == "utterance"),
        "ae_terms": prf_block(ae_tp, ae_fp, ae_fn),
        "meds": prf_block(med_tp, med_fp, med_fn),
        "escalated": prf_block(
            urgent_caught, urgent_predicted - urgent_caught, urgent_needed - urgent_caught
        ),
        "serious": prf_block(serious_caught, serious_fp, serious_needed - serious_caught),
        "med_change_accuracy": round(change_hits / change_total, 3) if change_total else None,
        "escalation_scored": esc_scored,
        "escalation_exact_match": round(exact / esc_scored, 3) if esc_scored else 1.0,
        "urgent_or_emergency_needed": urgent_needed,
        "urgent_or_emergency_caught": urgent_caught,
        "emergency_needed": emergency_needed,
        "emergency_caught": emergency_caught,
        "over_escalations": over,
        "serious_needed": serious_needed,
        "serious_caught": serious_caught,
        "n_fully_scorable": len(fully),
        "n_fully_scorable_exact": sum(1 for o in fully if o.ok),
        "n_partially_scorable": len(partly),
        "n_partially_scorable_exact": sum(1 for o in partly if o.ok),
        "partially_scorable_ids": [o.case_id for o in partly],
        "misses": [{"case_id": o.case_id, "problems": o.problems} for o in outcomes if not o.ok],
        "not_scorable": [
            {"case_id": o.case_id, "reasons": o.not_scorable} for o in outcomes if o.not_scorable
        ],
        "passed": all(o.ok for o in outcomes),
    }


def ensure_participant(ctx: Context, usubjid: str) -> None:
    """Create an eval participant over HTTP.

    The API has no ``POST /participants``; ``POST /sessions`` with the admin-only
    ``create_participant`` + ``is_eval`` flags is the documented way. The session it opens is
    left unanswered and incomplete: an eval row, hidden everywhere by default.
    """
    ctx.api.call(
        "POST",
        "/sessions",
        json={
            "usubjid": usubjid,
            "consent_camera": False,
            "create_participant": True,
            "is_eval": True,
        },
    )


def notes_via_api(
    ctx: Context,
    cases: Sequence[Mapping[str, Any]],
    *,
    suffix: str,
    sae_hours: float,
    rank: Mapping[str, int] | None = None,
) -> dict[str, Any]:
    """The synthetic notes through ``POST /notes`` (mirrors the in-process ``via_api``).

    An HTTP error on one note fails that note's row and the run carries on.
    """
    levels = dict(rank) if rank is not None else escalation_rank()
    participants: dict[str, str] = {}
    opened: dict[str, set[str]] = {}
    per_note: list[dict[str, Any]] = []
    for case in (c for c in cases if c["kind"] == "note"):
        label = str(case.get("usubjid_label") or "P-000")
        try:
            row = note_case(
                ctx,
                case,
                label=label,
                participants=participants,
                opened=opened,
                suffix=suffix,
                sae_hours=sae_hours,
                rank=levels,
            )
        except ApiError as exc:
            row = {
                "case_id": case["id"],
                "subject": label,
                "note_id": None,
                "ae_terms": [],
                "meds": [],
                "tier": None,
                "escalation": False,
                "sae_clock": False,
                "dedup_followups": 0,
                "mismatches": [f"API error: {exc}"],
                "pass": False,
            }
        per_note.append(row)
    n_pass = sum(1 for n in per_note if n["pass"])
    return {"n_notes": len(per_note), "n_pass": n_pass, "per_note": per_note}


def note_case(
    ctx: Context,
    case: Mapping[str, Any],
    *,
    label: str,
    participants: dict[str, str],
    opened: dict[str, set[str]],
    suffix: str,
    sae_hours: float,
    rank: Mapping[str, int],
) -> dict[str, Any]:
    """One answer-key note through ``POST /notes``; returns its result row."""
    usubjid = participants.get(label)
    if usubjid is None:
        usubjid = f"{ctx.study_id}-EVAL-NOTE-{label}-{suffix}"
        ensure_participant(ctx, usubjid)
        participants[label] = usubjid
    detail = ctx.api.call(
        "POST",
        "/notes",
        json={
            "usubjid": usubjid,
            "note_date": case.get("note_date"),
            "author": case.get("author") or "eval harness",
            "note_type": case.get("note_type") or "eval",
            "text": case["text"],
        },
    )
    exp = case["expected"]
    ae_drafts = [d for d in detail["drafts"] if d["domain"] == "AE"]
    cm_drafts = [d for d in detail["drafts"] if d["domain"] == "CM"]
    terms = sorted({str(d["fields"]["AEDECOD"]) for d in ae_drafts})
    meds = sorted(
        {(str(d["fields"]["CMDECOD"]), str(d["fields"]["INTERIM_DIRECTION"])) for d in cm_drafts}
    )
    expected_terms = sorted({str(t) for t in exp.get("ae_terms", [])})
    expected_meds = sorted({(str(d), str(c)) for d, c in exp.get("meds", [])})
    already_open = opened.setdefault(usubjid, set())
    expected_followups = len(set(expected_terms) & already_open)
    followups = sum(1 for d in ae_drafts if d.get("is_followup"))
    serious = bool(exp.get("serious", False))
    expected_tier = expected_note_tier(
        level=str(exp.get("escalation", "none")),
        serious=serious,
        has_findings=bool(expected_terms or expected_meds),
        rank=rank,
    )
    mismatches: list[str] = []
    if terms != expected_terms:
        mismatches.append(f"ae_terms: expected {expected_terms}, got {terms}")
    if meds != expected_meds:
        mismatches.append(f"meds: expected {expected_meds}, got {meds}")
    tier = detail.get("tier")
    if tier != expected_tier:
        mismatches.append(f"tier: expected {expected_tier}, got {tier}")
    if tier is not None and tier >= 3:
        mismatches.append("invariant: a chart note reached Tier 3")
    if (detail.get("escalation") is not None) != (expected_tier >= 2):
        mismatches.append(
            f"escalation row: expected {expected_tier >= 2}, "
            f"got {detail.get('escalation') is not None}"
        )
    clock = detail.get("sae_clock")
    if serious:
        if clock is None:
            mismatches.append("sae_clock: expected one, got none")
        else:
            ingested = detail["note"]["ingested_at"]
            if clock["site_awareness_at"] != ingested:
                mismatches.append("sae_clock.site_awareness_at != ingested_at")
            if clock["due_at"] != shift(ingested, hours=sae_hours):
                mismatches.append("sae_clock.due_at != ingested_at + site_to_sponsor_hours")
    elif clock is not None:
        mismatches.append("sae_clock: started without a hospitalization cue")
    if followups != expected_followups:
        mismatches.append(f"dedup_followups: expected {expected_followups}, got {followups}")
    if len(detail.get("why", [])) != len(detail.get("rules_fired", [])):
        mismatches.append("invariant: why[] and rules_fired[] differ in length")
    text = str(detail["note"]["text"])
    for d in detail["drafts"]:
        if (
            d.get("source") != "chart_note"
            or d["fields"].get("INTERIM_RECORD_SOURCE") != "chart_note"
        ):
            mismatches.append(f"invariant: draft {d['id']} is not labeled chart_note")
        if d["domain"] == "AE" and d["fields"].get("INTERIM_TIER") != tier:
            mismatches.append("invariant: AE draft INTERIM_TIER differs from the note tier")
        for pointers in (d.get("evidence") or {}).values():
            for p in pointers:
                if p.get("kind") != "chart_note" or p.get("span_start") is None:
                    continue
                if text[int(p["span_start"]) : int(p["span_end"])] != p.get("note"):
                    mismatches.append(
                        f"invariant: an evidence span of draft {d['id']} does not quote "
                        "the stored note"
                    )
    already_open.update(terms)
    return {
        "case_id": case["id"],
        "subject": label,
        "note_id": detail["note"]["id"],
        "ae_terms": terms,
        "meds": meds,
        "tier": tier,
        "escalation": detail.get("escalation") is not None,
        "sae_clock": clock is not None,
        "dedup_followups": followups,
        "mismatches": sorted(set(mismatches)),
        "pass": not mismatches,
    }


# --------------------------------------------------------------------------- #
# Isolation: eval rows must not leak into what a coordinator sees
# --------------------------------------------------------------------------- #

ISOLATION_LISTS: tuple[tuple[str, str], ...] = (
    ("Queue", "/queue"),
    ("Escalations", "/escalations"),
    ("Active SAE clocks", "/sae-clocks"),
    ("Pager log", "/pages"),
    ("Chart notes", "/notes"),
    ("Participants", "/participants"),
)


def isolation_check(api: Api) -> list[dict[str, Any]]:
    """Read-only default lists (no exports: an export is an audited event); count eval rows."""
    out: list[dict[str, Any]] = []
    for label, path in ISOLATION_LISTS:
        try:
            items = api.get_all(path)
        except ApiError as exc:
            out.append(
                {"label": label, "path": path, "n_items": None, "n_eval": 0, "error": str(exc)}
            )
            continue
        leaked = [
            i for i in items if EVAL_MARKER in str(i.get("usubjid", "")) or i.get("is_eval") is True
        ]
        out.append({"label": label, "path": path, "n_items": len(items), "n_eval": len(leaked)})
    return out


def strict_problems(
    notices: Sequence[str],
    isolation: Sequence[Mapping[str, Any]],
    *,
    api_version: Any,
    local_version: str | None,
    strict: bool,
    strict_keys: bool,
) -> list[str]:
    """Run-level failures beyond the answer keys.

    ``strict`` (default with ``--start-server``): eval rows leaked into a coordinator list, a
    list that could not be read, or an API version other than ``packages/rules``'.
    ``strict_keys`` (opt-in only): any notice about an ``expected`` key this harness does not
    compare. CONTRACTS.md R2.2 makes those notices, so they never fail ``make eval`` or CI.
    """
    problems: list[str] = []
    if strict:
        for row in isolation:
            if row.get("error"):
                problems.append(f"isolation: GET {row['path']} could not be read ({row['error']})")
        if any(row["n_eval"] for row in isolation):
            problems.append("eval rows leaked into the default coordinator lists")
        if local_version and api_version != local_version:
            problems.append(f"API version {api_version} != packages/rules {local_version}")
    if strict_keys and notices:
        problems.append(f"{len(notices)} notice(s) about unknown expected keys (--strict-keys)")
    return problems


# --------------------------------------------------------------------------- #
# Markdown
# --------------------------------------------------------------------------- #


def _cell(text: Any) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ")


def _tier(value: Any) -> str:
    """A tier cell; ``-`` when the replay hit an API error and produced no tier."""
    return "-" if value is None else str(value)


def all_mismatches(run: Mapping[str, Any]) -> list[str]:
    p, s = run["personas"], run["scanner"]
    out: list[str] = []
    for row in p["per_persona"]:
        out.extend(f"`{row['persona_id']}`: {m}" for m in row["mismatches"])
    for c in p["counterfactuals"]:
        out.extend(f"`{c['persona_id']}` [{c['label']}]: {m}" for m in c["mismatches"])
    for miss in s["answer_key"]["misses"]:
        out.extend(f"scan `{miss['case_id']}`: {m}" for m in miss["problems"])
    for n in s["notes"]["per_note"]:
        out.extend(f"note `{n['case_id']}`: {m}" for m in n["mismatches"])
    out.extend(f"strict: {m}" for m in run["strict_problems"])
    return out


def render_markdown(run: Mapping[str, Any]) -> str:
    p = run["personas"]
    s = run["scanner"]
    key, via = s["answer_key"], s["notes"]
    names = tier_names()
    lines: list[str] = []
    add = lines.append
    add("# Interim evaluation results")
    add("")
    add(
        "> Generated by `scripts/run_eval.py`, which replays the answer keys **over HTTP against "
        "the running API**: the same endpoints the kiosk, the vitals bridge and the dashboard "
        "call. Do not edit by hand; rerun `make eval`."
    )
    add("")
    add("| Run | Value |")
    add("|---|---|")
    add(f"| Generated (UTC) | {run['generated_at']} |")
    add(f"| API | {_cell(run['api_label'])} |")
    add(f"| API version (`GET /health`) | {run['api_version']} |")
    add(f"| Harness run id | `{run['suffix']}` |")
    selection = f"include_hidden = {str(run['include_hidden']).lower()}"
    if run["persona_ids"]:
        selection += f", persona_ids = {', '.join(run['persona_ids'])}"
    add(
        f"| Personas | {p['n_personas']} replayed of "
        f"{p['n_personas'] + len(p.get('not_replayable', []))} selected from "
        f"`packages/rules/data/personas.json` v{run['personas_version']} ({selection}) |"
    )
    add(
        f"| Chart-note answer key | {key['n_cases']} cases ({key['n_notes']} notes + "
        f"{key['n_utterances']} utterances), `packages/rules/data/chartscan_answer_key.json` |"
    )
    add(
        f"| Checks | strict = {str(run['strict']).lower()} (eval isolation, API version), "
        f"strict_keys = {str(run['strict_keys']).lower()} (unknown `expected` keys) |"
    )
    add(f"| HTTP requests | {run['n_requests']} in {run['elapsed_s']:.1f} s |")
    add("")
    rate = (100.0 * p["n_pass"] / p["n_personas"]) if p["n_personas"] else 0.0
    cfs = p["counterfactuals"]
    n_cf_pass = sum(1 for c in cfs if c["pass"])
    add("## Headline")
    add("")
    skipped = p.get("not_replayable", [])
    add(
        f"- **{p['n_pass']} / {p['n_personas']} personas pass ({rate:.1f}%)**; {p['n_fail']} fail"
        + (
            f"; {len(skipped)} not replayable over HTTP yet (listed below, not counted)."
            if skipped
            else "."
        )
    )
    if cfs:
        add(
            f"- **{n_cf_pass} / {len(cfs)} counterfactuals pass**: same answers, one setting "
            "changed; the tier moves and no grade does."
        )
    partial = ""
    if key["n_partially_scorable"]:
        ids = ", ".join(f"`{i}`" for i in key["partially_scorable_ids"])
        partial = (
            f"; {key['n_partially_scorable_exact']} / {key['n_partially_scorable']} "
            f"partially scorable case(s) ({ids}) exact on every attribute observable over "
            "HTTP, see below"
        )
    add(
        f"- **Chart-note scanner through `POST /scan`: {key['n_fully_scorable_exact']} / "
        f"{key['n_fully_scorable']} fully scorable answer-key cases exact**{partial} "
        f"({'PASS' if key['passed'] else 'FAIL'})."
    )
    add(
        f"- **Chart notes through `POST /notes`: {via['n_pass']} / {via['n_notes']} notes pass** "
        f"({'PASS' if via['n_pass'] == via['n_notes'] else 'FAIL'})."
    )
    leaks = sum(c["n_eval"] for c in run["isolation"])
    unreadable = sum(1 for c in run["isolation"] if c.get("error"))
    add(
        f"- **Eval isolation: {leaks} eval rows** in the default coordinator lists"
        + (f", {unreadable} list(s) unreadable" if unreadable else "")
        + f" ({'PASS' if leaks == 0 and not unreadable else 'FAIL'})."
    )
    add(f"- Overall: **{'PASS' if run['all_passed'] else 'FAIL'}**.")
    add("")

    add("## Tier precision / recall / F1")
    add("")
    add("| Tier | Name | Precision | Recall | F1 | Support | Predicted |")
    add("|---|---|---|---|---|---|---|")
    for tier, m in p["tier_metrics"].items():
        note = "" if m["support"] or m["predicted"] else " (no cases; 1.00 by convention)"
        add(
            f"| {tier} | {names.get(int(tier), tier)} | {m['precision']:.2f} | "
            f"{m['recall']:.2f} | {m['f1']:.2f}{note} | {m['support']} | {m['predicted']} |"
        )
    add("")
    add("## Provisional grade confusion (rows = expected, columns = actual)")
    add("")
    add(
        "One count per persona x item (ten items per persona). G4 and G5 are never assigned "
        "by this system."
    )
    add("")
    add("| expected \\ actual | G0 | G1 | G2 | G3 |")
    add("|---|---|---|---|---|")
    for row_index, row in enumerate(p["grade_confusion"]):
        add(f"| G{row_index} | " + " | ".join(str(c) for c in row) + " |")
    add("")
    add("## Correctness checks")
    add("")
    add("| Check | Correct | Of |")
    add("|---|---|---|")
    for block_key, label in (
        ("dedup_correct", "De-duplication (follow-up vs new AE; linked open AE's dates)"),
        ("sae_clock_correct", "SAE clock started / not started (24 h due-time arithmetic)"),
        ("conmed_correct", "Con-med match (verbatim, name, kind, distance, confidence, dates)"),
        (
            "aesi_correct",
            "Possible AESI (items, 24 h clock arithmetic) and protocol tier floor (R3.1)",
        ),
    ):
        block = p.get(block_key) or {"correct": 0, "n": 0}
        add(f"| {label} | {block['correct']} | {block['n']} |")
    if cfs:
        add(f"| Counterfactuals (tier changes, grades do not) | {n_cf_pass} | {len(cfs)} |")
    add("")
    add("## Per persona")
    add("")
    add("| Persona | Category | Hidden | Expected tier | Actual tier | Pass |")
    add("|---|---|---|---|---|---|")
    for row in p["per_persona"]:
        add(
            f"| `{row['persona_id']}` {_cell(row['name'])} | {row['category']} | "
            f"{'yes' if row['hidden'] else 'no'} | {row['expected_tier']} | "
            f"{_tier(row['actual_tier'])} | {'PASS' if row['pass'] else 'FAIL'} |"
        )
    if skipped:
        add("")
        add("## Not replayable over HTTP (yet)")
        add("")
        add(
            "Decided before the run from the persona and the API's OpenAPI document, never from "
            "a result. These personas are neither passes nor failures here."
        )
        add("")
        for row in skipped:
            add(f"- `{row['persona_id']}` {_cell(row['name'])}: {_cell(row['reason'])}.")
    if cfs:
        add("")
        add("## Counterfactuals (change one input, watch the output change)")
        add("")
        add("| Persona | Counterfactual | Baseline tier | Tier | Pass |")
        add("|---|---|---|---|---|")
        for c in cfs:
            add(
                f"| `{c['persona_id']}` | {_cell(c['label'])} | {_tier(c['baseline_tier'])} | "
                f"{_tier(c['tier'])} | {'PASS' if c['pass'] else 'FAIL'} |"
            )
    add("")

    add("## Chart-note scanner (CONTRACTS R2.4; deterministic, no LLM)")
    add("")
    add(
        "Scanner ported from omer-khawar/ae-checkin-agent (Omer Khawar, MIT). Each answer-key "
        "case is posted to `POST /scan` (a dry run: nothing stored, nothing audited) and scored "
        "with the arithmetic of `interim_rules.chartscan.evaluate_answer_key`: micro precision "
        "and recall over CTCAE terms and drugs, change accuracy over matched drugs, escalation "
        "recall, over-escalations and possible-SAE recall."
    )
    add("")
    add("| Category | Precision | Recall | F1 | TP | FP | FN |")
    add("|---|---|---|---|---|---|---|")
    for label, block in (
        ("AE terms (CTCAE v5)", key["ae_terms"]),
        ("Medications (drug)", key["meds"]),
        ("Escalation (urgent or emergency flagged)", key["escalated"]),
        ("Possible SAE (hospitalization / ER cue)", key["serious"]),
    ):
        add(
            f"| {label} | {block['precision']:.2f} | {block['recall']:.2f} | {block['f1']:.2f} | "
            f"{block['tp']} | {block['fp']} | {block['fn']} |"
        )
    add("")
    change = key["med_change_accuracy"]
    add("| Check | Value |")
    add("|---|---|")
    add(
        "| Medication change accuracy (started/stopped/changed/taking) | "
        + ("n/a" if change is None else f"{change:.2f}")
        + " |"
    )
    add(
        f"| Escalation level exact match | {key['escalation_exact_match']:.2f} "
        f"(over {key['escalation_scored']} scorable cases) |"
    )
    add(
        f"| Urgent/emergency cases caught | {key['urgent_or_emergency_caught']} / "
        f"{key['urgent_or_emergency_needed']} |"
    )
    add(f"| Emergency cases caught | {key['emergency_caught']} / {key['emergency_needed']} |")
    add(f"| Over-escalations | {key['over_escalations']} |")
    add(f"| Possible-SAE cues caught | {key['serious_caught']} / {key['serious_needed']} |")
    if key["not_scorable"]:
        add("")
        add(
            "Not scorable over HTTP (left out of the escalation rows above; still scored for "
            "terms, medications and seriousness):"
        )
        add("")
        for row in key["not_scorable"]:
            add(f"- `{row['case_id']}`: {'; '.join(row['reasons'])}.")
    add("")
    add(
        f"Through `POST /notes` (fresh eval participants, one per answer-key subject): "
        f"**{via['n_pass']} / {via['n_notes']} notes pass**. Each note's AE drafts must carry "
        "exactly the expected CTCAE terms and its CM drafts the expected drug and change; the "
        "tier follows the red flags (2 at most, never a page); a hospitalization/ER cue starts "
        "the SAE clock at ingestion with the 24 h due time; a term already open for the subject "
        "links as a follow-up; every evidence span quotes the stored note text verbatim."
    )
    add("")
    add("| Note | Subject | AE terms | Meds | Tier | Escalation | SAE clock | Follow-ups | Pass |")
    add("|---|---|---|---|---|---|---|---|---|")
    for n in via["per_note"]:
        meds = ", ".join(f"{d} ({c})" for d, c in n["meds"]) or "-"
        add(
            f"| `{n['case_id']}` | {n['subject']} | {', '.join(n['ae_terms']) or '-'} | {meds} | "
            f"{_tier(n['tier'])} | {'yes' if n['escalation'] else 'no'} | "
            f"{'yes' if n['sae_clock'] else 'no'} | {n['dedup_followups']} | "
            f"{'PASS' if n['pass'] else 'FAIL'} |"
        )
    add("")

    add("## Eval isolation")
    add("")
    add(
        "Every replay above ran as an `is_eval` participant. After the run the harness reads "
        "the lists a coordinator sees by default and counts rows belonging to an eval "
        "participant. None are expected: eval data stays out of the queue, the escalation "
        "board, the SAE countdowns, the pager log, the notes list and the participant list."
    )
    add("")
    add("| List | Endpoint | Rows | Eval rows |")
    add("|---|---|---|---|")
    for c in run["isolation"]:
        rows = "unreadable" if c.get("error") else c["n_items"]
        add(f"| {c['label']} | `GET {c['path']}` | {rows} | {c['n_eval']} |")
    add("")

    add("## Mismatches")
    add("")
    mismatches = all_mismatches(run)
    if mismatches:
        for m in mismatches:
            add(f"- {_cell(m)}")
    else:
        add("None. Every compared key matched its answer key.")
    add("")
    if p["notices"]:
        add("## Notices")
        add("")
        add(
            "Keys in an answer key this harness does not compare (CONTRACTS.md R2.2: logged, "
            "not failures; `--strict-keys` makes them failures)."
        )
        add("")
        for notice in p["notices"]:
            add(f"- {_cell(notice)}")
        add("")

    add("## What these numbers mean (and do not)")
    add("")
    add(
        "Both answer keys were written by the Interim team **alongside the rules they test**: "
        "the persona outputs were derived by hand from the rule tables, and the chart-note "
        "cases came with the scanner's lexicon. 100% here is therefore a **regression test**: "
        "the deployed system, end to end over HTTP (kiosk endpoints, rules engine, persistence, "
        "drafts, de-duplication, SAE clock, scanner), reproduces the documented rules exactly. "
        "It is not an accuracy estimate and not a clinical validation; the PRO-CTCAE composite "
        "to CTCAE grade mapping is itself an approximation (`docs/WHAT_IT_GETS_WRONG.md`)."
    )
    if run["synthea_present"]:
        add("")
        add(
            "For an independent test on text the scanner was **not** tuned on, see "
            "[`docs/eval/synthea_results.md`](synthea_results.md): the same scanner and con-med "
            "matcher scored against Synthea-generated synthetic EHR notes and medication "
            "records, where recall is markedly lower and reported as such."
        )
    add("")
    add(
        "Conventions: a tier with no expected and no predicted cases reports 1.00 by convention; "
        "the grades compared are the engine's provisional CTCAE grades per item (CLAUDE.md "
        "§3.4(b)). All participants and notes are synthetic."
    )
    vit = run["vitals_samples"]
    add("")
    add(
        f"Vitals: {vit['simulated']} of the {vit['total']} persona vitals samples replayed are "
        "**simulated** (mock source, `isMeasured: false`, exported as VSMETHOD `Simulated`)"
        + (f"; {vit['measured']} claim a measured sensor (eval-only)" if vit["measured"] else "")
        + '. Corroboration fires only for personas that turn on the admin "treat simulated as '
        'measured" setting; the counterfactuals replay the same inputs with it off.'
    )
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- #
# Local server (--start-server)
# --------------------------------------------------------------------------- #


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@contextlib.contextmanager
def local_server(*, port: int, password: str, log: Log) -> Iterator[str]:
    """uvicorn on ``127.0.0.1:port`` with a fresh temporary SQLite DB (seeded on start)."""
    with tempfile.TemporaryDirectory(prefix="interim-eval-", ignore_cleanup_errors=True) as tmp:
        db_path = Path(tmp) / "interim-eval.db"
        env = dict(os.environ)
        env.update(
            {
                "DATABASE_URL": f"sqlite:///{db_path.as_posix()}",
                "SEED_ON_START": "true",
                "DEMO_PASSWORD": password,
                "AUTH_SECRET": os.urandom(16).hex(),
                "BRIDGE_TOKEN": "",
                "PYTHONUNBUFFERED": "1",
            }
        )
        log_path = Path(tmp) / "uvicorn.log"
        with log_path.open("w", encoding="utf-8") as log_fh:
            proc = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "uvicorn",
                    "interim_api.main:app",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(port),
                    "--log-level",
                    "warning",
                ],
                cwd=str(API_DIR),
                env=env,
                stdout=log_fh,
                stderr=subprocess.STDOUT,
            )
            base = f"http://127.0.0.1:{port}"
            try:
                deadline = time.monotonic() + 180.0
                while True:
                    if proc.poll() is not None:
                        tail = log_path.read_text(encoding="utf-8", errors="replace")[-3000:]
                        raise HarnessError(
                            f"the API exited with code {proc.returncode} during startup:\n{tail}"
                        )
                    with contextlib.suppress(httpx.HTTPError):
                        if httpx.get(f"{base}/api/v1/health", timeout=2.0).status_code == 200:
                            break
                    if time.monotonic() > deadline:
                        raise HarnessError("the API did not become healthy within 180 s")
                    time.sleep(0.25)
                log(f"started a temporary API on {base} (fresh SQLite, seeded)")
                yield base
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=15)
                log("stopped the temporary API")


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #


def read_dotenv_value(name: str) -> str | None:
    """One key from the repo-root ``.env`` (never printed). No other key is read."""
    path = REPO_ROOT / ".env"
    if not path.is_file():
        return None
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        if k.strip() == name:
            return v.strip().strip('"').strip("'")
    return None


def read_package_version() -> str | None:
    init = REPO_ROOT / "packages" / "rules" / "interim_rules" / "__init__.py"
    if not init.is_file():
        return None
    for line in init.read_text(encoding="utf-8").splitlines():
        if line.startswith("INTERIM_VERSION"):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def evaluate(api: Api, args: argparse.Namespace, *, api_label: str, log: Log) -> dict[str, Any]:
    started = time.monotonic()
    health = api.call("GET", "/health")
    api.login(args.username, args.password)
    study = api.call("GET", "/study")
    items = api.call("GET", "/items")
    ctx = Context(
        api=api,
        study_id=str(study["study_id"]),
        instrument={str(i["id"]): [str(a) for a in i["attributes"]] for i in items["items"]},
        protocol_context_via=protocol_context_input(api.openapi()),
    )
    persona_table = load_table("personas")
    selected = select_personas(
        persona_table["personas"],
        include_hidden=args.include_hidden,
        persona_ids=args.persona_ids,
    )
    completed_at = now_iso()
    suffix = f"h{datetime.now(UTC):%Y%m%d%H%M%S}{os.urandom(2).hex()}"
    sae_hours = site_to_sponsor_hours()
    log(f"API {api.base_url} version {health.get('version')}: {len(selected)} personas")
    personas = run_personas(
        ctx, selected, suffix=suffix, completed_at=completed_at, sae_hours=sae_hours, log=log
    )
    answer_key_table = load_table("chartscan_answer_key")
    cases = list(answer_key_table["cases"])
    log(f"scanning {len(cases)} chart-note answer-key cases through POST /scan")
    answer_key = score_answer_key(
        api, cases, str(answer_key_table["utterance_ref_date"]), escalation_rank()
    )
    log("ingesting the synthetic notes through POST /notes")
    notes = notes_via_api(ctx, cases, suffix=suffix, sae_hours=sae_hours, rank=escalation_rank())
    isolation = isolation_check(api)
    scanner_passed = bool(answer_key["passed"]) and notes["n_pass"] == notes["n_notes"]
    personas_passed = personas["n_fail"] == 0 and all(
        c["pass"] for c in personas["counterfactuals"]
    )
    problems = strict_problems(
        personas["notices"],
        isolation,
        api_version=health.get("version"),
        local_version=read_package_version(),
        strict=bool(args.strict),
        strict_keys=bool(args.strict_keys),
    )
    return {
        "generated_at": now_iso(),
        "api_label": api_label,
        "api_version": health.get("version"),
        "suffix": suffix,
        "include_hidden": bool(args.include_hidden),
        "persona_ids": list(args.persona_ids or []),
        "personas_version": persona_table.get("version", "?"),
        "personas": personas,
        "scanner": {"answer_key": answer_key, "notes": notes, "passed": scanner_passed},
        "isolation": isolation,
        "strict": bool(args.strict),
        "strict_keys": bool(args.strict_keys),
        "strict_problems": problems,
        "all_passed": personas_passed and scanner_passed and not problems,
        "n_requests": api.n_requests,
        "elapsed_s": time.monotonic() - started,
        "synthea_present": SYNTHEA_RESULTS.is_file(),
        "vitals_samples": count_samples(selected),
    }


def count_samples(selected: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    """Persona vitals samples replayed (main + prior check-ins), simulated vs measured."""
    samples: list[Mapping[str, Any]] = []
    for persona in selected:
        if persona.get("consent_camera", True):
            samples.extend(persona.get("vitals_samples", []))
        for prior in (persona.get("setup") or {}).get("prior_checkins", []):
            samples.extend(prior.get("vitals_samples", []))
    measured = sum(1 for x in samples if x.get("isMeasured") and x.get("source") != "mock")
    return {"total": len(samples), "simulated": len(samples) - measured, "measured": measured}


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Replay the Interim answer keys over HTTP and write docs/eval/results.md."
    )
    parser.add_argument(
        "--api", default="http://localhost:8000", help="API base URL (default %(default)s)"
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help=(
            "Markdown output (default: docs/eval/results.md for the canonical --start-server "
            "run over every persona, else data/runtime/eval/results.live.md)"
        ),
    )
    parser.add_argument(
        "--include-hidden",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="also run the five hidden judge personas (default: yes)",
    )
    parser.add_argument(
        "--persona-ids",
        nargs="+",
        default=None,
        metavar="ID",
        help="run only these persona ids (space- or comma-separated; hidden ones allowed)",
    )
    parser.add_argument(
        "--start-server",
        action="store_true",
        help="launch uvicorn on a free port with a temporary SQLite DB (ignores --api)",
    )
    parser.add_argument(
        "--strict",
        action=argparse.BooleanOptionalAction,
        default=None,
        help=(
            "also fail on leaked eval rows or an API version mismatch "
            "(default: on with --start-server, off with --api)"
        ),
    )
    parser.add_argument(
        "--strict-keys",
        action="store_true",
        help="also fail on answer-key keys this harness does not compare (R2.2: notices)",
    )
    parser.add_argument("--username", default="admin", help="dashboard user (must be admin)")
    parser.add_argument(
        "--password",
        default=None,
        help="demo password (default: $DEMO_PASSWORD, then .env, then 'interim-demo')",
    )
    parser.add_argument("--timeout", type=float, default=60.0, help="per-request timeout (s)")
    parser.add_argument("--quiet", action="store_true", help="print only the summary line")
    args = parser.parse_args(argv)
    if args.persona_ids:
        args.persona_ids = [
            pid.strip() for raw in args.persona_ids for pid in raw.split(",") if pid.strip()
        ]
    if args.strict is None:
        args.strict = bool(args.start_server)
    if args.out is None:
        canonical = args.start_server and args.include_hidden and not args.persona_ids
        args.out = DEFAULT_OUT if canonical else LIVE_OUT
    if args.password is None:
        args.password = (
            os.environ.get("DEMO_PASSWORD") or read_dotenv_value("DEMO_PASSWORD") or "interim-demo"
        )
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)

    def log(message: str) -> None:
        if not args.quiet:
            print(message, flush=True)

    try:
        if args.start_server:
            with local_server(port=free_port(), password=args.password, log=log) as base:
                api = Api(base, timeout=args.timeout, bridge_token=None)
                try:
                    run = evaluate(
                        api,
                        args,
                        api_label=(
                            "temporary server started by `--start-server` (fresh SQLite "
                            "database with the demo seed) on 127.0.0.1"
                        ),
                        log=log,
                    )
                finally:
                    api.close()
        else:
            bridge_token = os.environ.get("BRIDGE_TOKEN") or read_dotenv_value("BRIDGE_TOKEN")
            api = Api(args.api, timeout=args.timeout, bridge_token=bridge_token)
            try:
                run = evaluate(api, args, api_label=f"`{args.api}`", log=log)
            finally:
                api.close()
    except HarnessError as exc:
        print(f"run_eval: cannot run: {exc}", file=sys.stderr)
        return 2

    out: Path = args.out if args.out.is_absolute() else Path.cwd() / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_markdown(run), encoding="utf-8", newline="\n")

    p, s = run["personas"], run["scanner"]
    n_cf = len(p["counterfactuals"])
    n_cf_pass = sum(1 for c in p["counterfactuals"] if c["pass"])
    rate = (100.0 * p["n_pass"] / p["n_personas"]) if p["n_personas"] else 0.0
    key = s["answer_key"]
    print(
        f"personas {p['n_pass']}/{p['n_personas']} ({rate:.1f}%), counterfactuals "
        f"{n_cf_pass}/{n_cf}, scanner answer key {key['n_fully_scorable_exact']}/"
        f"{key['n_fully_scorable']} fully scorable + {key['n_partially_scorable_exact']}/"
        f"{key['n_partially_scorable']} partially, notes "
        f"{s['notes']['n_pass']}/{s['notes']['n_notes']}, eval rows "
        f"leaked {sum(c['n_eval'] for c in run['isolation'])} -> "
        f"{'PASS' if run['all_passed'] else 'FAIL'}; wrote {out}"
    )
    for problem in all_mismatches(run):
        print(f"  mismatch {problem}", file=sys.stderr)
    return 0 if run["all_passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
