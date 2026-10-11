"""Visit-prep brief (CONTRACTS.md R3.2, CLAUDE.md §00.4) and plain-language labels.

* every section, item and question carries evidence ids that resolve to a database row,
  and a web route in ``link``;
* every line is written by the template writer and the narrative passes the rules
  package's own acceptance gate (``validate_written``);
* the ``since`` cut-off: explicit date, the latest completed visit, else 14 days;
* vitals lines always say MEASURED or SIMULATED;
* the printable page is self-contained and carries the footer verbatim;
* ``GET /checkins/{id}`` and ``GET /notes/{id}`` carry ``labels`` for every draft field and
  a ``plain`` sentence on every fired rule.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from conftest import (
    DEMO_GATES,
    DEMO_RESPONSES,
    ZERO_RESPONSES,
    add_participant,
    login,
    post_answers_and_gates,
    run_kiosk_checkin,
)
from sqlmodel import select

from interim_api.models import (
    AEOpen,
    Answer,
    AuditEvent,
    ChartNote,
    Draft,
    Escalation,
    Participant,
    ParticipantVisit,
    SAEClock,
    Session,
)
from interim_api.services.briefs import FOOTER, build_brief, cited_ids
from interim_api.util import now_iso, shift
from interim_rules import chartscan
from interim_rules.narrative import validate_written
from interim_rules.plain_language import label as plain_label

BASE = "/api/v1"
SECTION_KEYS = [
    "new_side_effects",
    "open_aes",
    "medication_changes",
    "escalations_and_clocks",
    "notes_and_calls",
    "vitals_context",
]
ROW_FOR_KIND = {
    "participant": Participant,
    "visit": ParticipantVisit,
    "session": Session,
    "draft": Draft,
    "pro_response": Answer,
    "gate_answer": Answer,
    "chart_note": ChartNote,
    "phone_call": ChartNote,
    "ae_open": AEOpen,
    "escalation": Escalation,
    "clock": SAEClock,
}


def _assert_resolves(client, brief: dict[str, Any]) -> None:
    """Every cited id is in the evidence map, and every map entry is a real row."""
    evidence = brief["evidence"]
    cited = cited_ids(brief)
    assert cited, "a brief with content cites evidence"
    missing = [i for i in cited if i not in evidence]
    assert not missing, f"cited but not in the evidence map: {missing}"
    database = client.app.state.database
    with database.read_scope() as db:
        for ident, ref in evidence.items():
            model = ROW_FOR_KIND.get(ref["kind"])
            if model is None:  # packet / query rows belong to other features
                continue
            assert db.get(model, ident) is not None, (ident, ref)
            assert ref["link"] and ref["link"].startswith("/dashboard/"), ref


def _assert_items_shape(brief: dict[str, Any]) -> None:
    assert [s["key"] for s in brief["sections"]] == SECTION_KEYS
    for section in brief["sections"]:
        assert section["title"]
        for it in section["items"]:
            assert it["text"].strip()
            assert it["evidence_ids"], it
            assert it["link"] and it["link"].startswith("/dashboard/"), it
    for q in brief["questions_to_ask"]:
        assert q["text"].strip() and q["evidence_ids"] and q["link"].startswith("/dashboard/")


def _backdated_checkin(
    client,
    admin: dict[str, str],
    usubjid: str,
    completed_at: str,
    responses: dict[str, dict[str, int]],
    gates: dict[str, Any] | None = None,
) -> str:
    started = shift(completed_at, seconds=-300)
    res = client.post(
        f"{BASE}/sessions",
        json={"usubjid": usubjid, "consent_camera": False, "started_at_override": started},
        headers=admin,
    )
    assert res.status_code == 201, res.text
    sid = res.json()["id"]
    post_answers_and_gates(
        client, sid, responses=responses, gates=gates or {**DEMO_GATES}, ts_client=started
    )
    res = client.post(
        f"{BASE}/sessions/{sid}/complete",
        json={"ts_client": completed_at, "completed_at_override": completed_at},
        headers=admin,
    )
    assert res.status_code == 200, res.text
    return sid


# --------------------------------------------------------------------------- #
# Sections and evidence on the Monday-morning seed
# --------------------------------------------------------------------------- #


def test_brief_sections_evidence_and_narrative_on_the_seed(seeded_client) -> None:
    client = seeded_client
    coordinator = login(client, "coordinator")
    # P-006: ER note (SAE clock + escalation), a discouraged steroid, check-ins with vitals.
    res = client.get(f"{BASE}/participants/P-006/brief", headers=coordinator)
    assert res.status_code == 200, res.text
    brief = res.json()
    assert brief["display_label"] == "P-006"
    assert brief["since_basis"] in ("default_lookback", "previous_visit")
    assert "facts" not in brief
    _assert_items_shape(brief)
    _assert_resolves(client, brief)
    by_key = {s["key"]: s["items"] for s in brief["sections"]}

    # Escalations and clocks: an SAE clock from the ER note, linked and labeled.
    clocks = [i for i in by_key["escalations_and_clocks"] if i.get("clock_kind")]
    assert clocks and clocks[0]["clock_kind"] in ("sae", "aesi")
    assert clocks[0]["due_at"] and clocks[0]["status"] in ("running", "reported (mock)", "stopped")
    # Medication changes carry the protocol flag and its page.
    flagged = [i for i in by_key["medication_changes"] if i.get("protocol_flag")]
    assert flagged and flagged[0]["printed_page"] == 69
    assert flagged[0]["protocol_flag"] in ("prohibited", "discouraged", "permitted")
    # Notes and calls point at the note page.
    assert by_key["notes_and_calls"] and all(
        i["link"].startswith("/dashboard/notes/") for i in by_key["notes_and_calls"]
    )
    # Vitals: MEASURED / SIMULATED in every line.
    for it in by_key["vitals_context"]:
        assert "SIMULATED" in it["text"] or "MEASURED" in it["text"]
        assert it["is_measured"] is False and "simulated" in it["text"].lower()
    # New side effects carry their grade points with resolvable evidence.
    assert by_key["new_side_effects"]
    for it in by_key["new_side_effects"]:
        for point in it.get("grades", []):
            assert 0 <= point["grade"] <= 3 and point["evidence_ids"]
    # Questions: unsigned report, missing CM fields, unresolved AEs (deterministic kinds).
    kinds = {q["kind"] for q in brief["questions_to_ask"]}
    assert {"cm_missing_fields", "unresolved_ae"} <= kinds
    # The narrative: template writer, every sentence cites known evidence, passes the gate.
    narrative = brief["narrative"]
    assert narrative["writer"] == "template" and narrative["sentences"]
    assert all(s["evidence_ids"] for s in narrative["sentences"])

    database = client.app.state.database
    with database.read_scope() as db:
        participant = db.get(Participant, brief["usubjid"])
        full = build_brief(db, participant, since=brief["since"])
    assert validate_written(full["narrative"], full["facts"]) == []

    # Generating the brief is audited.
    with database.read_scope() as db:
        events = [
            e
            for e in db.exec(select(AuditEvent).where(AuditEvent.action == "brief.generated"))
            if e.entity_id == brief["usubjid"]
        ]
    assert len(events) == 1
    assert client.get(f"{BASE}/audit/verify", headers=coordinator).json()["ok"] is True


def test_every_seeded_participant_brief_resolves(seeded_client) -> None:
    client = seeded_client
    coordinator = login(client, "coordinator")
    rows = client.get(f"{BASE}/participants", headers=coordinator).json()["items"]
    assert len(rows) >= 12
    for p in rows:
        res = client.get(f"{BASE}/participants/{p['usubjid']}/brief", headers=coordinator)
        assert res.status_code == 200, res.text
        brief = res.json()
        _assert_items_shape(brief)
        _assert_resolves(client, brief)


def test_brief_requires_a_token_and_a_known_participant(client) -> None:
    add_participant(client, "P-007")
    assert client.get(f"{BASE}/participants/P-007/brief").status_code == 401
    coordinator = login(client, "coordinator")
    res = client.get(f"{BASE}/participants/P-999/brief", headers=coordinator)
    assert res.status_code == 404
    assert res.headers["content-type"].startswith("application/problem+json")
    res = client.get(f"{BASE}/participants/P-007/brief?since=yesterday", headers=coordinator)
    assert res.status_code == 422


# --------------------------------------------------------------------------- #
# The cut-off
# --------------------------------------------------------------------------- #


def test_since_filter_default_explicit_and_previous_visit(client) -> None:
    admin = login(client, "admin")
    coordinator = login(client, "coordinator")
    usubjid = add_participant(client, "P-007")
    now = now_iso()
    old = shift(now, seconds=-20 * 86400)
    # 20 days ago: moderate dyspnea; today: severe-free mild dyspnea + no con-med.
    _backdated_checkin(client, admin, usubjid, old, DEMO_RESPONSES)
    later = {**ZERO_RESPONSES, "shortness_of_breath": {"severity": 1, "interference": 0}}
    run_kiosk_checkin(
        client, usubjid, responses=later, gates={"hospitalization": False, "conmed_changed": False}
    )

    # Default (no visit recorded): 14 days back -> only today's report is new.
    brief = client.get(f"{BASE}/participants/P-007/brief", headers=coordinator).json()
    assert brief["since_basis"] == "default_lookback"
    assert brief["since"] == (date.fromisoformat(now[:10]) - timedelta(days=14)).isoformat()
    new = {s["key"]: s["items"] for s in brief["sections"]}["new_side_effects"]
    sob = [i for i in new if "Dyspnea" in i["text"]]
    assert len(sob) == 1 and [g["grade"] for g in sob[0]["grades"]] == [1]
    meds = {s["key"]: s["items"] for s in brief["sections"]}["medication_changes"]
    assert len(meds) == 1 and meds[0].get("empty") is True  # loratadine was 20 days ago
    _assert_resolves(client, brief)

    # Explicit since before both: the trend has both grades and the old con-med appears.
    since = old[:10]
    brief = client.get(f"{BASE}/participants/P-007/brief?since={since}", headers=coordinator).json()
    assert brief["since"] == since and brief["since_basis"] == "requested"
    by_key = {s["key"]: s["items"] for s in brief["sections"]}
    sob = [i for i in by_key["new_side_effects"] if "Dyspnea" in i["text"]]
    assert [g["grade"] for g in sob[0]["grades"]] == [2, 1]
    assert "improving" in sob[0]["text"]
    assert any("loratadine" in i["text"] for i in by_key["medication_changes"])
    _assert_resolves(client, brief)

    # A recorded completed visit becomes the default cut-off; a scheduled one is "next".
    visit_day = shift(now, seconds=-3 * 86400)[:10]
    next_day = shift(now, seconds=2 * 86400)[:10]
    res = client.post(
        f"{BASE}/participants/P-007/visits",
        json={"visit_date": visit_day, "status": "completed", "label": "Cycle 3 Day 1"},
        headers=coordinator,
    )
    assert res.status_code == 201, res.text
    res = client.post(
        f"{BASE}/participants/P-007/visits",
        json={"visit_date": next_day, "status": "scheduled"},
        headers=coordinator,
    )
    assert res.status_code == 201, res.text
    brief = client.get(f"{BASE}/participants/P-007/brief", headers=coordinator).json()
    assert brief["since"] == visit_day and brief["since_basis"] == "previous_visit"
    assert brief["next_visit"] == next_day
    header = brief["narrative"]["sentences"][0]
    assert visit_day in header["text"] and brief["evidence"][header["evidence_ids"][-1]]
    _assert_resolves(client, brief)
    visits = client.get(f"{BASE}/participants/P-007/visits", headers=coordinator).json()
    assert visits["total"] == 2
    # Investigators may record visits, the endpoint validates the date.
    bad = client.post(
        f"{BASE}/participants/P-007/visits", json={"visit_date": "soon!!!!!!"}, headers=coordinator
    )
    assert bad.status_code == 422


def test_cm_missing_fields_and_open_ae_questions(client) -> None:
    coordinator = login(client, "coordinator")
    usubjid = add_participant(client, "P-003")
    run_kiosk_checkin(
        client,
        usubjid,
        gates={**DEMO_GATES, "conmed_text": "prednisone", "conmed_direction": "started"},
    )
    brief = client.get(f"{BASE}/participants/{usubjid}/brief", headers=coordinator).json()
    meds = {s["key"]: s["items"] for s in brief["sections"]}["medication_changes"]
    assert len(meds) == 1
    assert meds[0]["protocol_flag"] == "discouraged"
    assert meds[0]["exception_text"]
    assert set(meds[0]["missing_fields"]) == {"CMDOSE", "CMDOSU", "CMDOSFRQ", "CMINDC"}
    cm_q = [q for q in brief["questions_to_ask"] if q["kind"] == "cm_missing_fields"]
    assert len(cm_q) == 1 and "prednisone" in cm_q[0]["text"]
    assert any(q["kind"] == "unresolved_ae" for q in brief["questions_to_ask"])
    # The question's evidence includes the CM record itself.
    assert any(brief["evidence"][i]["kind"] == "draft" for i in cm_q[0]["evidence_ids"])


# --------------------------------------------------------------------------- #
# Print
# --------------------------------------------------------------------------- #


def test_print_is_self_contained_html_with_the_footer(client) -> None:
    coordinator = login(client, "coordinator")
    usubjid = add_participant(client, "P-007")
    run_kiosk_checkin(client, usubjid)
    res = client.get(f"{BASE}/participants/P-007/brief/print", headers=coordinator)
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/html")
    page = res.text
    assert page.startswith("<!doctype html>")
    assert FOOTER in page
    assert "<script" not in page and "http://" not in page and "https://" not in page
    assert "@media print" in page
    assert "Written by template" in page
    assert "SIMULATED" in page


# --------------------------------------------------------------------------- #
# Plain-language labels on check-in and note details
# --------------------------------------------------------------------------- #


def test_checkin_detail_labels_every_draft_field_and_plain_rules(client) -> None:
    coordinator = login(client, "coordinator")
    usubjid = add_participant(client, "P-007")
    done = run_kiosk_checkin(client, usubjid)
    detail = client.get(f"{BASE}/checkins/{done['session_id']}", headers=coordinator).json()
    labels = detail["labels"]
    assert detail["drafts"]
    for draft in detail["drafts"]:
        for name in draft["fields"]:
            assert name in labels and labels[name].strip(), name
            assert labels[name] == plain_label(name)
    assert labels["AETOXGR"] != "AETOXGR"  # a real plain label, not the code
    assert detail["rules_fired"]
    for rule in detail["rules_fired"]:
        assert rule["plain"].strip() and rule["rule_id"]


def test_note_detail_labels_and_plain_rules(client) -> None:
    coordinator = login(client, "coordinator")
    case = next(c for c in chartscan.answer_key() if c.kind == "note")
    add_participant(client, case.usubjid_label)
    res = client.post(
        f"{BASE}/notes",
        json={
            "usubjid": case.usubjid_label,
            "note_date": case.note_date,
            "author": case.author,
            "note_type": case.note_type,
            "text": case.text,
        },
        headers=coordinator,
    )
    assert res.status_code == 201, res.text
    posted = res.json()
    detail = client.get(f"{BASE}/notes/{posted['note']['id']}", headers=coordinator).json()
    for body in (posted, detail):
        assert body["drafts"]
        for draft in body["drafts"]:
            for name in draft["fields"]:
                assert name in body["labels"], name
        for rule in body["rules_fired"]:
            assert rule["plain"].strip()


# --------------------------------------------------------------------------- #
# Optional LLM writer: accepted only when it passes the gate (fake writer, no network)
# --------------------------------------------------------------------------- #


def test_llm_text_is_validated_and_falls_back_to_the_template(client, monkeypatch) -> None:
    import interim_api.writers as writers

    coordinator = login(client, "coordinator")
    usubjid = add_participant(client, "P-007")
    run_kiosk_checkin(client, usubjid)
    url = f"{BASE}/participants/P-007/brief"

    def bad_llm(settings, kind, facts, **_: Any) -> dict[str, Any]:
        text = "The participant is doing well."
        return {
            "kind": kind,
            "writer": "llm",
            "sentences": [{"text": text, "evidence_ids": ["not-a-real-id"]}],
            "text": text,
        }

    monkeypatch.setattr(writers, "write_text", bad_llm)
    brief = client.get(url, headers=coordinator).json()
    assert brief["narrative"]["writer"] == "template"
    assert brief["narrative"]["fallback_reason"].startswith("LLM text rejected")
    _assert_resolves(client, brief)

    def good_llm(settings, kind, facts, **_: Any) -> dict[str, Any]:
        from interim_rules.narrative import write

        out = write(kind, facts).to_dict()
        out["writer"] = "llm"
        return out

    monkeypatch.setattr(writers, "write_text", good_llm)
    brief = client.get(url, headers=coordinator).json()
    assert brief["narrative"]["writer"] == "llm"
    assert "fallback_reason" not in brief["narrative"]
