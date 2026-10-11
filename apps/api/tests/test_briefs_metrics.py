"""Time saved, on screen (CONTRACTS.md R3.2, CLAUDE.md §00.5).

* confirming a draft stores its pre-filled / edited counts (the rules package's counters);
* ``GET /metrics/time-saved`` adds them up and its minutes equal
  ``interim_rules.time_saved.estimate`` on the same counts (the API does no arithmetic of
  its own), with the basis and the "estimate" label;
* an edited field saves nothing; a record re-confirmed after an edit counts once;
* briefs count one per participant and visit, whatever the cut-off; ``since`` filters
  everything;
* signed packets count only real, source-backed values (no placeholders, nothing a person
  typed, and on a follow-up only what changed since the previous report).
"""

from __future__ import annotations

from typing import Any

from conftest import add_participant, login, run_kiosk_checkin
from sqlmodel import select

from interim_api import models
from interim_api.models import DraftMetrics
from interim_api.util import load_json, now_iso, shift
from interim_rules.time_saved import edited_count, estimate, prefilled_count

BASE = "/api/v1"


def _drafts(client, headers: dict[str, str], session_id: str) -> list[dict[str, Any]]:
    return client.get(f"{BASE}/checkins/{session_id}", headers=headers).json()["drafts"]


def test_confirm_records_counts_and_metrics_match_the_estimate(client) -> None:
    coordinator = login(client, "coordinator")
    usubjid = add_participant(client, "P-007")
    done = run_kiosk_checkin(client, usubjid)
    drafts = _drafts(client, coordinator, done["session_id"])
    ae = [d for d in drafts if d["domain"] == "AE"]
    cm = [d for d in drafts if d["domain"] == "CM"]
    assert len(ae) == 2 and len(cm) == 1

    # AE #1 confirmed untouched; AE #2 edited (grade changed) then confirmed; CM confirmed.
    r = client.post(f"{BASE}/drafts/{ae[0]['id']}/confirm", json={}, headers=coordinator)
    assert r.status_code == 200, r.text
    edited_grade = 1 if ae[1]["fields"]["AETOXGR"] != 1 else 2
    r = client.patch(
        f"{BASE}/drafts/{ae[1]['id']}",
        json={"fields": {"AETOXGR": edited_grade}, "note": "investigator call"},
        headers=coordinator,
    )
    assert r.status_code == 200, r.text
    v2 = r.json()
    r = client.post(f"{BASE}/drafts/{v2['id']}/confirm", json={}, headers=coordinator)
    assert r.status_code == 200, r.text
    r = client.post(f"{BASE}/drafts/{cm[0]['id']}/confirm", json={}, headers=coordinator)
    assert r.status_code == 200, r.text

    # The stored counts are the rules package's counts of v1 vs the confirmed version.
    database = client.app.state.database
    with database.read_scope() as db:
        rows = {r.lineage_id: r for r in db.exec(select(DraftMetrics)).all()}
        assert set(rows) == {ae[0]["lineage_id"], ae[1]["lineage_id"], cm[0]["lineage_id"]}
        v1_fields = load_json(db.get(models.Draft, ae[1]["id"]).fields_json, {})
        v2_fields = load_json(db.get(models.Draft, v2["id"]).fields_json, {})
    assert rows[ae[1]["lineage_id"]].prefilled_fields == prefilled_count("AE", v1_fields)
    assert rows[ae[1]["lineage_id"]].edited_fields == edited_count("AE", v1_fields, v2_fields) == 1
    assert rows[ae[0]["lineage_id"]].edited_fields == 0
    assert rows[cm[0]["lineage_id"]].prefilled_fields == prefilled_count("CM", cm[0]["fields"])

    res = client.get(f"{BASE}/metrics/time-saved", headers=coordinator)
    assert res.status_code == 200, res.text
    m = res.json()
    pre_ae = sum(rows[d["lineage_id"]].prefilled_fields for d in ae)
    pre_cm = rows[cm[0]["lineage_id"]].prefilled_fields
    expected = estimate({"AE": pre_ae, "CM": pre_cm}, {"AE": 1})
    assert m["records_confirmed"] == 3
    assert m["minutes_saved"] == expected["minutes_saved"]
    assert m["minutes_manual_baseline"] == expected["minutes_manual_baseline"]
    assert m["fields_prefilled"] == pre_ae + pre_cm and m["fields_edited"] == 1
    assert m["basis"] == expected["basis"]
    assert m["is_estimate"] is True and m["disclaimer"] == "estimate"
    assert any("estimate" in line for line in m["basis"])
    assert m["minutes_saved"] < m["minutes_manual_baseline"]  # the edited field saved nothing
    assert m["packets_signed"] == 0 and m["briefs_generated"] == 0

    # since in the future: nothing counted.
    future = shift(now_iso(), seconds=3600)
    m2 = client.get(f"{BASE}/metrics/time-saved?since={future}", headers=coordinator).json()
    assert m2["records_confirmed"] == 0 and m2["minutes_saved"] == 0
    assert (
        client.get(f"{BASE}/metrics/time-saved?since=nope", headers=coordinator).status_code == 422
    )


def test_reconfirmed_record_counts_once_and_briefs_count_once_per_visit(client) -> None:
    coordinator = login(client, "coordinator")
    usubjid = add_participant(client, "P-007")
    done = run_kiosk_checkin(client, usubjid)
    ae = [d for d in _drafts(client, coordinator, done["session_id"]) if d["domain"] == "AE"][0]
    assert (
        client.post(f"{BASE}/drafts/{ae['id']}/confirm", json={}, headers=coordinator).status_code
        == 200
    )
    r = client.patch(
        f"{BASE}/drafts/{ae['id']}", json={"fields": {"AEONGO": "Y"}}, headers=coordinator
    )
    if r.status_code == 200:  # editing a confirmed record makes a new draft version
        assert (
            client.post(
                f"{BASE}/drafts/{r.json()['id']}/confirm", json={}, headers=coordinator
            ).status_code
            == 200
        )
    m = client.get(f"{BASE}/metrics/time-saved", headers=coordinator).json()
    assert m["records_confirmed"] == 1

    # Three brief requests and a print, two distinct cut-offs -> still one brief (same visit).
    for q in ("", "", "?since=2026-01-01"):
        assert (
            client.get(f"{BASE}/participants/P-007/brief{q}", headers=coordinator).status_code
            == 200
        )
    assert (
        client.get(f"{BASE}/participants/P-007/brief/print", headers=coordinator).status_code == 200
    )
    m = client.get(f"{BASE}/metrics/time-saved", headers=coordinator).json()
    assert m["briefs_generated"] == 1
    sections = m["prefilled_by_category"]["BRIEF_SECTION"]
    assert sections >= 1
    expected = estimate(m["prefilled_by_category"], m["edited_by_category"])
    assert m["minutes_saved"] == expected["minutes_saved"]


def test_query_answered_from_suggestion_counts_as_a_prefilled_field(client) -> None:
    query_cls = getattr(models, "SponsorQuery", None)
    if query_cls is None:
        return  # the queries feature is not present in this build
    coordinator = login(client, "coordinator")
    usubjid = add_participant(client, "P-007")
    database = client.app.state.database
    stamp = now_iso()
    with database.write_scope() as db:
        db.add(
            query_cls(
                id="01QUERYTESTSUGGESTED000001",
                domain="CM",
                draft_id="d",
                lineage_id="d",
                usubjid=usubjid,
                field="CMDOSE",
                text="Dose missing",
                severity="data",
                status="answered",
                raised_by="edit-check",
                raised_at=stamp,
                answer_text="Dose 10 mg",
                answered_by="coordinator",
                answered_at=stamp,
                answered_from_suggestion=True,
            )
        )
    m = client.get(f"{BASE}/metrics/time-saved", headers=coordinator).json()
    assert m["queries_answered_from_suggestion"] == 1
    assert m["prefilled_by_category"]["CM"] == 1


def test_signed_packet_counts_form_fields_and_narrative(client) -> None:
    packet_cls = getattr(models, "Packet", None)
    if packet_cls is None:
        return  # the packets feature is not present in this build
    from interim_api.audit import Actor, append_event
    from interim_api.util import dump_json

    coordinator = login(client, "coordinator")
    usubjid = add_participant(client, "P-007")
    stamp = now_iso()
    ev = [{"kind": "pro_response", "id": "01ANSWER", "ts": stamp, "note": "answer"}]
    fields = [
        {"name": "event_term", "value": "Rash", "evidence": ev},
        {"name": "onset", "value": "2026-10-09", "evidence": ev},
        {"name": "provisional_grade", "value": 3, "evidence": ev},
        {"name": "study_drug", "value": "cemiplimab", "evidence": ev},
        {"name": "outcome", "value": None},
    ]
    edits = [{"version": 2, "diff": {"onset": {"before": "a", "after": "b"}, "narrative": {}}}]
    database = client.app.state.database
    with database.write_scope() as db:
        db.add(
            packet_cls(
                id="01PACKETTESTSIGNED00000001",
                clock_id="01CLOCKTEST000000000000001",
                kind="aesi",
                usubjid=usubjid,
                status="signed",
                version=2,
                fields_json=dump_json(fields),
                narrative_json=dump_json({"text": "x", "sentences": []}),
                edits_json=dump_json(edits),
                created_by="coordinator",
                created_at=stamp,
                updated_at=stamp,
                signed_by="investigator",
                signed_at=stamp,
            )
        )
        append_event(
            db,
            Actor(id="investigator", role="investigator"),
            "packet.signed",
            "packet",
            "01PACKETTESTSIGNED00000001",
            {"usubjid": usubjid},
        )
    m = client.get(f"{BASE}/metrics/time-saved", headers=coordinator).json()
    assert m["packets_signed"] == 1
    assert m["prefilled_by_category"]["SAE_FORM"] == 4  # the empty outcome is not pre-filled
    assert m["edited_by_category"]["SAE_FORM"] == 1
    assert m["prefilled_by_category"]["NARRATIVE_PARAGRAPH"] == 1
    assert m["edited_by_category"]["NARRATIVE_PARAGRAPH"] == 1
    expected = estimate(m["prefilled_by_category"], m["edited_by_category"])
    assert m["minutes_saved"] == expected["minutes_saved"] == 3 * 1.5


def test_brief_cutoff_changes_do_not_inflate_time_saved(client) -> None:
    """Moving the brief's date cut-off (what the brief page's control does) or reloading it
    is the same piece of work: one brief per participant per visit, not per ``since``."""
    coordinator = login(client, "coordinator")
    usubjid = add_participant(client, "P-007")
    run_kiosk_checkin(client, usubjid)
    first = client.get(f"{BASE}/participants/P-007/brief", headers=coordinator)
    assert first.status_code == 200
    before = client.get(f"{BASE}/metrics/time-saved", headers=coordinator).json()
    assert before["briefs_generated"] == 1
    for day in ("2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2025-01-01"):
        r = client.get(f"{BASE}/participants/P-007/brief?since={day}", headers=coordinator)
        assert r.status_code == 200
    after = client.get(f"{BASE}/metrics/time-saved", headers=coordinator).json()
    assert after["briefs_generated"] == 1
    assert after["minutes_saved"] <= before["minutes_saved"] + 1.0  # one section at most
    expected = estimate(after["prefilled_by_category"], after["edited_by_category"])
    assert after["minutes_saved"] == expected["minutes_saved"]


def _signed_packet(client, usubjid: str, packet_id: str, **extra: Any) -> None:
    from interim_api.audit import Actor, append_event
    from interim_api.util import dump_json

    stamp = now_iso()
    database = client.app.state.database
    with database.write_scope() as db:
        db.add(
            models.Packet(
                id=packet_id,
                clock_id=extra.pop("clock_id", "01CLOCKTEST000000000000002"),
                kind="sae",
                usubjid=usubjid,
                status="signed",
                version=1,
                fields_json=dump_json(extra.pop("fields")),
                narrative_json=dump_json({"text": "x", "sentences": []}),
                created_by="coordinator",
                created_at=stamp,
                updated_at=stamp,
                signed_by="investigator",
                signed_at=stamp,
                **{k: dump_json(v) if k.endswith("_json") else v for k, v in extra.items()},
            )
        )
        append_event(
            db,
            Actor(id="investigator", role="investigator"),
            "packet.followup_signed" if extra.get("sequence") else "packet.signed",
            "packet",
            packet_id,
            {"usubjid": usubjid},
        )


def test_packet_placeholders_and_typed_values_are_not_prefilled(client) -> None:
    """'unknown' / 'not yet decided by the investigator' save no work, and neither does a
    value backed only by a person's edit or a value carried from a previous report."""
    coordinator = login(client, "coordinator")
    usubjid = add_participant(client, "P-007")
    stamp = now_iso()
    source = [{"kind": "pro_response", "id": "01ANSWER", "ts": stamp, "note": "answer"}]
    table = [{"kind": "table", "id": "protocol_rules.json", "ts": None, "note": "t"}]
    typed = [{"kind": "edit", "id": "01EVENT", "ts": stamp, "note": "typed"}]
    carried = [*typed, {"kind": "packet", "id": "01PARENT", "ts": stamp, "note": "carried"}]
    fields = [
        {"name": "AETERM", "value": "Rash", "evidence": source},
        {"name": "AEOUT", "value": "unknown", "evidence": table},
        {"name": "AESER", "value": "not yet decided by the investigator", "evidence": table},
        {"name": "AEREL", "value": "not yet assessed by the investigator", "evidence": table},
        {"name": "LAST_DOSE_DATE", "value": "2026-10-01", "evidence": typed},
        {"name": "HOSPITALIZATION_DATES", "value": "2026-10-02", "evidence": carried},
    ]
    _signed_packet(client, usubjid, "01PACKETPLACEHOLDERS000001", fields=fields)
    m = client.get(f"{BASE}/metrics/time-saved", headers=coordinator).json()
    assert m["packets_signed"] == 1
    assert m["prefilled_by_category"]["SAE_FORM"] == 1  # AETERM only
    assert m["edited_by_category"]["SAE_FORM"] == 0


def test_followup_packet_counts_only_fields_changed_since_the_previous_report(client) -> None:
    coordinator = login(client, "coordinator")
    usubjid = add_participant(client, "P-007")
    stamp = now_iso()
    source = [{"kind": "pro_response", "id": "01ANSWER", "ts": stamp, "note": "answer"}]
    parent_fields = [
        {"name": "AETERM", "value": "Rash", "evidence": source},
        {"name": "LATEST_GRADE", "value": 2, "evidence": source},
    ]
    _signed_packet(
        client,
        usubjid,
        "01PACKETPARENT00000000001",
        clock_id="01CLOCKTEST000000000000003",
        fields=parent_fields,
    )
    once = client.get(f"{BASE}/metrics/time-saved", headers=coordinator).json()
    assert once["prefilled_by_category"]["SAE_FORM"] == 2
    followup_fields = [
        {"name": "AETERM", "value": "Rash", "evidence": source},
        {"name": "LATEST_GRADE", "value": 3, "evidence": source},
    ]
    _signed_packet(
        client,
        usubjid,
        "01PACKETFOLLOWUP000000001",
        clock_id="01CLOCKTEST000000000000003",
        fields=followup_fields,
        sequence=1,
        parent_packet_id="01PACKETPARENT00000000001",
        changes_json=[{"field": "LATEST_GRADE", "before": 2, "after": 3}],
    )
    twice = client.get(f"{BASE}/metrics/time-saved", headers=coordinator).json()
    assert twice["packets_signed"] == 2
    assert twice["prefilled_by_category"]["SAE_FORM"] == 3  # 2 + only the changed grade
