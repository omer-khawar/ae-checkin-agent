"""Tests for scripts/run_eval.py (the persona replay harness over HTTP).

Two layers:
* the harness's pure parts on hand-made fixtures: metric arithmetic, persona selection,
  sample materialization, scan escalation rebuild, and ``compare`` catching a wrong tier;
* the real thing: ``run_eval.py --start-server --include-hidden --strict`` launches uvicorn on
  a free port with a temporary SQLite database, replays every persona, the chart-note answer
  key and the synthetic notes over HTTP, and must report 100% with no mismatch.
No network beyond 127.0.0.1; no fixed port (never 8000/5173/8787).
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

# run_eval talks HTTP through httpx (an apps/api dev dependency). The CI "scripts" job installs
# only the rules package, so skip there; the "eval" job runs the harness itself. The module is
# imported dynamically so mypy (run over scripts/tests) does not need httpx's stubs.
pytest.importorskip("httpx")
ev: Any = importlib.import_module("run_eval")

RUN_EVAL = SCRIPTS / "run_eval.py"
HAVE_API = (
    importlib.util.find_spec("interim_api") is not None
    and importlib.util.find_spec("uvicorn") is not None
)


# --------------------------------------------------------------------------------------
# Pure parts
# --------------------------------------------------------------------------------------


def test_prf_empty_denominators_follow_the_in_process_convention() -> None:
    assert ev.prf(0, 0, 0) == (1.0, 1.0, 1.0)
    assert ev.prf(1, 1, 0) == (0.5, 1.0, 0.6667)
    assert ev.prf(0, 1, 1) == (0.0, 0.0, 0.0)


def test_tier_metrics_and_confusion() -> None:
    metrics = ev.tier_metrics([(0, 0), (1, 2), (2, 2), (3, 3)])
    assert metrics["2"]["precision"] == 0.5
    assert metrics["2"]["recall"] == 1.0
    assert metrics["1"]["recall"] == 0.0
    assert metrics["1"]["support"] == 1
    assert metrics["2"]["predicted"] == 2
    matrix = ev.grade_confusion([(0, 0), (2, 1), (3, 3), (3, 3)])
    assert matrix[2][1] == 1
    assert matrix[3][3] == 2
    assert sum(map(sum, matrix)) == 4


def test_select_personas() -> None:
    personas: list[dict[str, Any]] = [
        {"id": "a", "hidden": False},
        {"id": "b", "hidden": True},
    ]
    assert [
        p["id"] for p in ev.select_personas(personas, include_hidden=False, persona_ids=None)
    ] == ["a"]
    assert len(ev.select_personas(personas, include_hidden=True, persona_ids=None)) == 2
    # A named hidden persona runs even without --include-hidden (same rule as POST /eval/run).
    assert [
        p["id"] for p in ev.select_personas(personas, include_hidden=False, persona_ids=["b"])
    ] == ["b"]
    with pytest.raises(ev.HarnessError, match="unknown persona"):
        ev.select_personas(personas, include_hidden=False, persona_ids=["nope"])


def test_materialize_samples_places_offsets_after_session_start() -> None:
    out = ev.materialize_samples(
        [{"tsOffsetS": 30, "source": "mock", "pulseBpm": 72, "windowS": 30}],
        "2026-10-10T12:00:00.000Z",
    )
    assert out == [
        {"source": "mock", "pulseBpm": 72, "windowS": 30, "tsUtc": "2026-10-10T12:00:30.000Z"}
    ]
    assert ev.shift("2026-10-10T12:00:00.000Z", days=-1.5) == "2026-10-09T00:00:00.000Z"


def test_predicted_escalation_note_vs_utterance() -> None:
    rank = ev.escalation_rank()
    assert rank["none"] < rank["human_requested"] < rank["urgent"] < rank["emergency"]
    scan = {"escalation_level": "urgent", "red_flags": [{"level": "emergency"}]}
    # A note routes every red flag to urgent (the API's own escalation_level) ...
    assert ev.predicted_escalation(scan, "note", rank) == "urgent"
    # ... an utterance keeps the red flag's own level.
    assert ev.predicted_escalation(scan, "utterance", rank) == "emergency"
    assert ev.predicted_escalation({"red_flags": []}, "utterance", rank) == "none"


def _detail(tier: int) -> dict[str, Any]:
    """A minimal ``GET /checkins/{id}`` body: one G2 item, no drafts, no vitals."""
    return {
        "session": {"id": "S1", "tier": tier},
        "result": {
            "items": [{"item_id": "cough", "provisional_grade": 2}],
            "max_grade": 2,
            "escalation_tier": tier,
            "stop_screen": tier == 3,
            "page_oncall": tier == 3,
            "rules_fired": [{"rule_id": "tier.base"}],
            "drafts": [],
            "sae_clock": None,
            "conmed": None,
            "vitals": {"status": "unavailable"},
        },
        "drafts": [],
        "ae_links": [],
        "sae_clock": None,
    }


def test_compare_passes_a_matching_detail_and_catches_a_wrong_tier() -> None:
    expected = {
        "grades": {"cough": 2},
        "tier": 1,
        "rules_fired_includes": ["tier.base"],
        "sae_clock_started": False,
        "made_up_key": True,
    }
    stamp = "2026-10-10T12:00:00.000Z"
    actual, mismatches, notices = ev.compare(_detail(1), expected, completed_at=stamp, sae_hours=24)
    assert mismatches == []
    assert actual["tier"] == 1
    assert notices == ["expected.made_up_key is not compared by this harness"]

    _, mismatches, _ = ev.compare(_detail(2), expected, completed_at=stamp, sae_hours=24)
    assert "tier: expected 1, got 2" in mismatches

    broken = _detail(1)
    broken["session"]["tier"] = 0  # what was stored disagrees with what the engine decided
    _, mismatches, _ = ev.compare(broken, expected, completed_at=stamp, sae_hours=24)
    assert any(m.startswith("invariant: stored session tier") for m in mismatches)


def test_unreachable_api_exits_2(tmp_path: Path) -> None:
    port = ev.free_port()  # nothing listens there
    proc = subprocess.run(
        [
            sys.executable,
            str(RUN_EVAL),
            "--api",
            f"http://127.0.0.1:{port}",
            "--quiet",
            "--timeout",
            "3",
            "--out",
            str(tmp_path / "results.md"),
        ],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert proc.returncode == 2, proc.stderr
    assert "cannot run" in proc.stderr
    assert not (tmp_path / "results.md").exists()


# --------------------------------------------------------------------------------------
# Review fixes (wave 2): strict split, per-row API errors, stored rows, note tier, --out
# --------------------------------------------------------------------------------------


def test_unknown_keys_are_notices_not_failures_unless_strict_keys() -> None:
    clean = [{"label": "Queue", "path": "/queue", "n_items": 3, "n_eval": 0}]
    notices = ["P1: expected.aesi_suspected is not compared by this harness"]
    kwargs: dict[str, Any] = {"api_version": "0.1.0", "local_version": "0.1.0"}
    # R2.2: make eval (strict) stays green on an unknown key ...
    assert ev.strict_problems(notices, clean, strict=True, strict_keys=False, **kwargs) == []
    # ... and only the opt-in flag turns it into a failure.
    assert ev.strict_problems(notices, clean, strict=False, strict_keys=True, **kwargs) == [
        "1 notice(s) about unknown expected keys (--strict-keys)"
    ]
    leaked = [{"label": "Queue", "path": "/queue", "n_items": 3, "n_eval": 1}]
    assert ev.strict_problems([], leaked, strict=True, strict_keys=False, **kwargs) == [
        "eval rows leaked into the default coordinator lists"
    ]
    assert ev.strict_problems([], leaked, strict=False, strict_keys=False, **kwargs) == []
    unreadable = [
        {"label": "Queue", "path": "/queue", "n_items": None, "n_eval": 0, "error": "HTTP 500"}
    ]
    assert ev.strict_problems(
        [], unreadable, strict=True, strict_keys=False, api_version="0.1.0", local_version="0.2.0"
    ) == [
        "isolation: GET /queue could not be read (HTTP 500)",
        "API version 0.1.0 != packages/rules 0.2.0",
    ]


def test_out_defaults_never_overwrite_the_committed_record_from_a_partial_run() -> None:
    canonical = ev.parse_args(["--start-server"])
    assert canonical.out == ev.DEFAULT_OUT
    assert canonical.include_hidden is True  # CI's bare --start-server covers all 29 personas
    assert canonical.strict is True  # isolation + version enforced against this checkout
    assert canonical.strict_keys is False
    live = ev.parse_args(["--api", "http://127.0.0.1:1"])
    assert live.out == ev.LIVE_OUT
    assert live.strict is False
    assert ev.parse_args(["--start-server", "--persona-ids", "T1-x"]).out == ev.LIVE_OUT
    assert ev.parse_args(["--start-server", "--no-include-hidden"]).out == ev.LIVE_OUT
    assert ev.parse_args(["--start-server", "--no-strict"]).strict is False
    explicit = ev.parse_args(["--api", "http://127.0.0.1:1", "--out", "x.md"])
    assert explicit.out == Path("x.md")
    # The live default is gitignored runtime data, not docs/.
    assert ev.LIVE_OUT.relative_to(ev.REPO_ROOT).parts[:2] == ("data", "runtime")


def test_expected_note_tier_follows_r2_4() -> None:
    rank = ev.escalation_rank()
    tier = ev.expected_note_tier
    assert tier(level="none", serious=False, has_findings=False, rank=rank) == 0
    assert tier(level="none", serious=False, has_findings=True, rank=rank) == 1
    assert tier(level="urgent", serious=False, has_findings=True, rank=rank) == 2
    assert tier(level="emergency", serious=False, has_findings=True, rank=rank) == 2
    # A hospitalization-only note ("admitted overnight after a fall"): no term, no med, still
    # Tier 2 with an escalation row (it used to be expected at Tier 0).
    assert tier(level="urgent", serious=True, has_findings=False, rank=rank) == 2
    assert tier(level="none", serious=True, has_findings=False, rank=rank) == 2
    assert tier(level="emergency", serious=True, has_findings=True, rank=rank) == ev.NOTE_MAX_TIER


def test_compare_checks_a_stored_sae_clock_the_engine_never_started() -> None:
    stamp = "2026-10-10T12:00:00.000Z"
    expected = {"sae_clock_started": False}
    detail = _detail(1)
    detail["sae_clock"] = {"site_awareness_at": stamp, "due_at": "2026-10-11T12:00:00.000Z"}
    _, mismatches, _ = ev.compare(detail, expected, completed_at=stamp, sae_hours=24)
    assert "sae_clock: none was started but an SAE clock row is stored" in mismatches
    # An AESI clock row (R3.2 ``kind``) is not an SAE clock.
    detail["sae_clock"]["kind"] = "aesi"
    _, mismatches, _ = ev.compare(detail, expected, completed_at=stamp, sae_hours=24)
    assert not [m for m in mismatches if m.startswith("sae_clock")]


def _vs(fields: dict[str, Any], *, stored: bool) -> dict[str, Any]:
    if stored:
        return {"domain": "VS", "fields": fields}
    return {"domain": "VS", "fields": [{"name": k, "value": v} for k, v in fields.items()]}


def test_compare_checks_the_stored_draft_rows_not_only_the_engine_snapshot() -> None:
    stamp = "2026-10-10T12:00:00.000Z"
    good = {
        "VSTESTCD": "PULSE",
        "VSORRES": 72,
        "VSORRESU": "beats/min",
        "VSSTAT": None,
        "VSMETHOD": "Simulated",
        "INTERIM_SOURCE": "mock",
        "INTERIM_IS_MEASURED": False,
    }
    detail = _detail(1)
    detail["result"]["drafts"] = [_vs(good, stored=False)]
    detail["drafts"] = [_vs(good, stored=True)]
    _, mismatches, _ = ev.compare(detail, {"tier": 1}, completed_at=stamp, sae_hours=24)
    assert mismatches == []
    # The engine snapshot is right, the persisted row claims a camera measurement.
    detail["drafts"] = [_vs({**good, "VSMETHOD": "Contactless optical, camera-based"}, stored=True)]
    _, mismatches, _ = ev.compare(detail, {"tier": 1}, completed_at=stamp, sae_hours=24)
    assert "invariant: a simulated stored VS row is not labeled Simulated" in mismatches
    assert any(m.startswith("invariant: stored VS drafts differ") for m in mismatches)


class FakeApi:
    """An httpx.MockTransport API: enough of /sessions, /checkins, /scan and /notes."""

    def __init__(self, *, fail_complete_for: str = "", fail_text: str = "") -> None:
        self.fail_complete_for = fail_complete_for  # USUBJID substring: /complete -> 500
        self.fail_text = fail_text  # /scan or /notes text substring -> 500
        self.sessions: dict[str, str] = {}
        self.completed_with: list[Any] = []

    def handler(self, request: Any) -> Any:
        import httpx

        body = json.loads(request.content or b"null")
        path = request.url.path.removeprefix("/api/v1")
        owner = next((u for s, u in self.sessions.items() if f"/sessions/{s}/" in path), "")
        failing_complete = bool(self.fail_complete_for) and self.fail_complete_for in owner
        failing_text = bool(self.fail_text) and self.fail_text in str((body or {}).get("text"))
        if (path.endswith("/complete") and failing_complete) or failing_text:
            problem = {"title": "Internal Server Error", "detail": "boom"}
            return httpx.Response(500, json=problem)
        if path.endswith("/complete") and "protocol_context" in body:
            self.completed_with.append(body["protocol_context"])
        if path == "/sessions":
            sid = f"S{len(self.sessions) + 1}"
            self.sessions[sid] = str(body["usubjid"])
            return httpx.Response(201, json={"id": sid})
        if path.startswith("/checkins/"):
            return httpx.Response(200, json=_detail(1))
        if path == "/scan":
            terms = [{"term": "Cough"}] if "cough" in body["text"] else []
            return httpx.Response(
                200, json={"symptoms": terms, "meds": [], "red_flags": [], "dry_run": True}
            )
        if path == "/notes":
            ingested = "2026-10-10T12:00:00.000Z"
            serious = "admitted" in body["text"]
            return httpx.Response(
                201,
                json={
                    "note": {"id": "n1", "ingested_at": ingested, "text": body["text"]},
                    "drafts": [],
                    "tier": 2 if serious else 0,
                    "escalation": {"tier": 2} if serious else None,
                    "sae_clock": (
                        {"site_awareness_at": ingested, "due_at": ev.shift(ingested, hours=24)}
                        if serious
                        else None
                    ),
                    "why": [],
                    "rules_fired": [],
                },
            )
        return httpx.Response(200, json={})

    def api(self) -> Any:
        import httpx

        api = ev.Api("http://fake", timeout=5, bridge_token=None)
        api.client.close()
        api.client = httpx.Client(
            base_url="http://fake/api/v1", transport=httpx.MockTransport(self.handler)
        )
        return api


def _ctx(api: Any) -> Any:
    return ev.Context(api=api, study_id="STUDY", instrument={"cough": ["severity"]})


def test_protocol_context_is_sent_only_where_the_api_declares_it() -> None:
    assert ev.protocol_context_input(None) is None
    assert ev.protocol_context_input({"components": {"schemas": {}}}) is None
    declared = {"properties": {"protocol_context": {"type": "object"}}}
    on_complete = {"components": {"schemas": {"CompleteRequest": declared}}}
    assert ev.protocol_context_input(on_complete) == "complete"
    on_session = {"components": {"schemas": {"CreateSessionRequest": declared}}}
    assert ev.protocol_context_input(on_session) == "session"
    assert not ev.needs_protocol_context({"id": "x"})
    default = {"prior_pi3k_inhibitor": False, "last_dose_date": None}
    assert not ev.needs_protocol_context({"protocol_context": default})
    assert ev.needs_protocol_context({"protocol_context": {"prior_pi3k_inhibitor": True}})
    assert ev.needs_protocol_context({"protocol_context": {"last_dose_date": "2026-10-01"}})


def test_a_persona_the_api_cannot_receive_is_listed_not_passed_or_failed() -> None:
    fake = FakeApi()
    persona = {
        "id": "P3-pi3k",
        "expected": {"tier": 1},
        "responses": {},
        "protocol_context": {"prior_pi3k_inhibitor": True, "last_dose_date": None},
    }
    out = ev.run_personas(
        _ctx(fake.api()),
        [persona],
        suffix="t",
        completed_at="2026-10-10T12:00:00.000Z",
        sae_hours=24,
        log=lambda _m: None,
    )
    assert out["n_personas"] == 0 and out["per_persona"] == []
    assert [r["persona_id"] for r in out["not_replayable"]] == ["P3-pi3k"]
    assert fake.sessions == {}  # nothing was sent
    # Once the API declares the input, the persona replays with its context in the body.
    ctx = _ctx(fake.api())
    ctx.protocol_context_via = "complete"
    out = ev.run_personas(
        ctx,
        [persona],
        suffix="t",
        completed_at="2026-10-10T12:00:00.000Z",
        sae_hours=24,
        log=lambda _m: None,
    )
    assert out["n_pass"] == 1 and out["not_replayable"] == []
    assert fake.completed_with == [{"prior_pi3k_inhibitor": True, "last_dose_date": None}]


def test_one_persona_api_error_fails_that_row_and_the_run_carries_on() -> None:
    fake = FakeApi(fail_complete_for="-EVAL-bad-")
    personas = [
        {"id": "bad", "expected": {"tier": 1, "sae_clock_started": False}, "responses": {}},
        {
            "id": "good",
            "expected": {"tier": 1, "made_up": 1},
            "responses": {},
            "counterfactuals": [{"label": "cf", "settings": {}, "expected": {"aesi_x": True}}],
        },
    ]
    logged: list[str] = []
    out = ev.run_personas(
        _ctx(fake.api()),
        personas,
        suffix="t",
        completed_at="2026-10-10T12:00:00.000Z",
        sae_hours=24,
        log=logged.append,
    )
    rows = {r["persona_id"]: r for r in out["per_persona"]}
    assert rows["bad"]["pass"] is False and rows["bad"]["actual_tier"] is None
    assert rows["bad"]["mismatches"][0].startswith("API error: POST /sessions/")
    assert "HTTP 500" in rows["bad"]["mismatches"][0]
    assert rows["good"]["pass"] is True  # replayed after the failure
    assert out["n_fail"] == 1
    assert out["sae_clock_correct"] == {"n": 1, "correct": 0}  # an error is not "correct"
    assert out["tier_metrics"]["1"]["recall"] == 0.5
    # Counterfactual notices are kept (with their label) and printed, not dropped.
    assert "good [cf]: expected.aesi_x is not compared by this harness" in out["notices"]
    assert "good: expected.made_up is not compared by this harness" in out["notices"]
    assert any(line.strip().startswith("notice  good [cf]:") for line in logged)
    markdown_rows = [r for r in out["per_persona"] if r["actual_tier"] is None]
    assert ev._tier(markdown_rows[0]["actual_tier"]) == "-"


def test_one_note_api_error_fails_that_note_and_a_hospitalization_only_note_passes() -> None:
    fake = FakeApi(fail_text="boom note")
    cases = [
        {"id": "N1", "kind": "note", "usubjid_label": "P-001", "text": "boom note", "expected": {}},
        {"id": "N2", "kind": "note", "usubjid_label": "P-001", "text": "nothing", "expected": {}},
        {
            "id": "N3",
            "kind": "note",
            "usubjid_label": "P-002",
            "text": "Pt admitted overnight for observation after a fall.",
            "expected": {"escalation": "urgent", "serious": True},
        },
    ]
    out = ev.notes_via_api(_ctx(fake.api()), cases, suffix="t", sae_hours=24)
    rows = {r["case_id"]: r for r in out["per_note"]}
    assert rows["N1"]["pass"] is False
    assert rows["N1"]["mismatches"][0].startswith("API error: POST /notes")
    assert rows["N2"]["pass"] is True, rows["N2"]["mismatches"]
    assert rows["N3"]["pass"] is True, rows["N3"]["mismatches"]
    assert rows["N3"]["tier"] == 2 and rows["N3"]["escalation"] and rows["N3"]["sae_clock"]
    assert out == {"n_notes": 3, "n_pass": 2, "per_note": out["per_note"]}


def test_scan_api_error_is_a_miss_and_partially_scorable_cases_are_counted_apart() -> None:
    fake = FakeApi(fail_text="boom scan")
    cases = [
        {
            "id": "U1",
            "kind": "utterance",
            "text": "boom scan",
            "expected": {"ae_terms": ["Fatigue"]},
        },
        {"id": "U2", "kind": "utterance", "text": "a cough", "expected": {"ae_terms": ["Cough"]}},
        {
            "id": "T6",
            "kind": "utterance",
            "text": "can I talk to someone",
            "expected": {"escalation": "human_requested"},
        },
    ]
    out = ev.score_answer_key(fake.api(), cases, "2026-10-10", ev.escalation_rank())
    assert out["passed"] is False
    assert out["misses"][0]["case_id"] == "U1"
    assert out["misses"][0]["problems"][0].startswith("API error: POST /scan")
    assert out["ae_terms"]["fn"] == 1 and out["ae_terms"]["tp"] == 1
    assert (out["n_fully_scorable"], out["n_fully_scorable_exact"]) == (2, 1)
    assert (out["n_partially_scorable"], out["n_partially_scorable_exact"]) == (1, 1)
    assert out["partially_scorable_ids"] == ["T6"]


# --------------------------------------------------------------------------------------
# The real run over HTTP
# --------------------------------------------------------------------------------------


@pytest.mark.skipif(not HAVE_API, reason="needs apps/api (interim_api + uvicorn) installed")
def test_full_run_over_http_is_100_percent(tmp_path: Path) -> None:
    out = tmp_path / "results.md"
    proc = subprocess.run(
        [
            sys.executable,
            str(RUN_EVAL),
            "--start-server",
            "--include-hidden",
            "--strict",
            "--quiet",
            "--out",
            str(out),
        ],
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )
    assert proc.returncode == 0, f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    text = out.read_text(encoding="utf-8")

    table = json.loads((ev.RULES_DATA / "personas.json").read_text(encoding="utf-8"))
    total = len(table["personas"])
    personas = re.search(r"\*\*(\d+) / (\d+) personas pass \(([\d.]+)%\)\*\*", text)
    assert personas is not None
    assert personas.group(1) == personas.group(2)
    assert personas.group(3) == "100.0"
    # Every persona is either replayed or listed as not replayable (decided before the run).
    skipped = re.search(r"; (\d+) not replayable over HTTP yet", text)
    n_skipped = int(skipped.group(1)) if skipped else 0
    assert int(personas.group(2)) + n_skipped == total
    needing = sum(1 for p in table["personas"] if ev.needs_protocol_context(p))
    assert n_skipped in (0, needing)  # 0 once the API takes protocol_context (R3.2)

    scan = re.search(r"`POST /scan`: (\d+) / (\d+) fully scorable answer-key cases exact", text)
    assert scan is not None and scan.group(1) == scan.group(2)
    # A partially scorable case (T6: escalation not observable over HTTP) is counted apart.
    partial = re.search(r"; (\d+) / (\d+) partially scorable case", text)
    assert partial is None or partial.group(1) == partial.group(2)
    assert "| Checks | strict = true" in text
    notes = re.search(r"`POST /notes`: (\d+) / (\d+) notes pass", text)
    assert notes is not None and notes.group(1) == notes.group(2) == "8"
    counterfactuals = re.search(r"(\d+) / (\d+) counterfactuals pass", text)
    assert counterfactuals is not None and counterfactuals.group(1) == counterfactuals.group(2)

    assert "None. Every compared key matched its answer key." in text
    assert "Eval isolation: 0 eval rows" in text
    assert "Overall: **PASS**" in text
    assert "| FAIL |" not in text
    # Every tier row is perfect on the shipped personas.
    for tier in ("0", "1", "2", "3"):
        row = re.search(rf"^\| {tier} \| [^|]+ \| ([\d.]+) \| ([\d.]+) \| ([\d.]+)", text, re.M)
        assert row is not None and row.groups() == ("1.00", "1.00", "1.00"), tier
    # The honesty note is part of the document.
    assert "regression test" in text
    assert "-> PASS" in proc.stdout
