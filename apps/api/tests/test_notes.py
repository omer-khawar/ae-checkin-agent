"""Chart-note scanning through the API (CONTRACTS.md R2.4, D-017).

The eight answer-key notes go through ``POST /notes`` and must come out as the
answer key says (AE terms, meds + change, escalation, seriousness); every evidence
pointer must resolve and every span must slice the exact quote from the note; a
note never pages, never reaches Tier 3; the SAE clock starts at ingestion; the
same term open from a check-in (or an earlier note) links as a follow-up in both
directions; roles and the admin-only backdating override are enforced.
"""

from __future__ import annotations

from typing import Any

from conftest import (
    DEMO_GATES,
    DEMO_RESPONSES,
    ZERO_RESPONSES,
    add_participant,
    login,
    run_kiosk_checkin,
)

from interim_api.util import shift
from interim_rules import chartscan
from interim_rules.tables import rules_catalog

NOTE_CASES = {c.note_id: c for c in chartscan.answer_key() if c.kind == "note"}


def _ingest(client, headers: dict[str, str], case_id: str, usubjid: str | None = None) -> dict:
    case = NOTE_CASES[case_id]
    res = client.post(
        "/api/v1/notes",
        json={
            "usubjid": usubjid or case.usubjid_label,
            "note_date": case.note_date,
            "author": case.author,
            "note_type": case.note_type,
            "text": case.text,
        },
        headers=headers,
    )
    assert res.status_code == 201, res.text
    return res.json()


def _pointers(obj: Any, out: list[dict]) -> None:
    if isinstance(obj, dict):
        if obj.get("kind") == "chart_note" and "span_start" in obj:
            out.append(obj)
        for v in obj.values():
            _pointers(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _pointers(v, out)


def test_answer_key_notes_through_the_endpoint(client) -> None:
    for label in ("P-001", "P-002", "P-003", "P-004", "P-005", "P-006"):
        add_participant(client, label)
    coord = login(client, "coordinator")
    catalog = set(rules_catalog())
    hours = 24
    ingested: dict[str, dict] = {}
    for case_id in ("N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8"):
        case = NOTE_CASES[case_id]
        body = _ingest(client, coord, case_id)
        ingested[case_id] = body
        ae = [d for d in body["drafts"] if d["domain"] == "AE"]
        cm = [d for d in body["drafts"] if d["domain"] == "CM"]
        assert sorted(d["fields"]["AEDECOD"] for d in ae) == sorted(case.expected.ae_terms), case_id
        assert sorted(
            (d["fields"]["CMDECOD"], d["fields"]["INTERIM_DIRECTION"]) for d in cm
        ) == sorted(case.expected.meds), case_id
        assert not [d for d in body["drafts"] if d["domain"] == "VS"]  # a note has no vitals
        # Shapes and labels.
        assert body["note"]["id"] and body["note"]["text"] == case.text
        assert body["note"]["display_label"] == case.usubjid_label
        assert body["tier"] <= 2 and body["tier_name"] in (
            "Log",
            "Coordinator review",
            "Nurse call today",
        )
        for d in body["drafts"]:
            assert d["source"] == "chart_note" and d["session_id"] is None
            assert d["note_id"] == body["note"]["id"] and d["status"] == "draft"
            assert d["fields"]["INTERIM_RECORD_SOURCE"] == "chart_note"
            assert d["fields"]["INTERIM_SOURCE"] == "chart_note"
            assert d["fields"]["STUDYID"] == "R2810-ONC-1624"
            if d["domain"] == "AE":
                assert d["fields"]["INTERIM_TIER"] == body["tier"]
                assert d["fields"]["INTERIM_PROVISIONAL"] is True
                assert d["fields"]["AETOXGR"] in (1, 2, 3) and d["fields"]["AESER"] is None
                assert d["fields"]["AEONGO"] == "Y" and d["fields"]["AEENDTC"] is None
                assert d["evidence"]["AETERM"][0]["kind"] == "chart_note"
            else:
                assert d["fields"]["INTERIM_MATCH_KIND"] == "lexicon"
                assert d["fields"]["INTERIM_MATCH_CONFIDENCE"] == 1.0
        # Every chart_note pointer slices its quote out of the stored text.
        pointers: list[dict] = []
        _pointers(body["drafts"], pointers)
        _pointers(body["rules_fired"], pointers)
        assert pointers
        for p in pointers:
            assert p["id"] == body["note"]["id"] and p["ts"] == body["note"]["ingested_at"]
            assert case.text[p["span_start"] : p["span_end"]] == p["note"], p
        assert all(e["resolved"] for e in body["evidence_index"].values()), case_id
        rule_ids = [r["rule_id"] for r in body["rules_fired"]]
        assert set(rule_ids) <= catalog, set(rule_ids) - catalog
        assert "tier.final" in rule_ids and len(body["why"]) == len(rule_ids)
        assert all(r["category"] for r in body["rules_fired"])
        # Escalation and seriousness follow the answer key; a note never pages.
        if case.expected.escalation == "none":
            assert body["escalation"] is None and body["tier"] <= 1
        else:
            assert body["escalation"]["tier"] == 2 == body["tier"]
            assert body["escalation"]["source"] == "chart_note"
            assert body["escalation"]["note_id"] == body["note"]["id"]
            assert body["escalation"]["paged_at"] is None and body["escalation"]["reasons"]
        if case.expected.serious:
            clock = body["sae_clock"]
            assert clock and clock["note_id"] == body["note"]["id"] and clock["session_id"] is None
            assert clock["site_awareness_at"] == body["note"]["ingested_at"]
            assert clock["due_at"] == shift(body["note"]["ingested_at"], hours=hours)
            assert "sae.clock_started" in rule_ids and "chartscan.hospitalization" in rule_ids
        else:
            assert body["sae_clock"] is None and "sae.clock_started" not in rule_ids

    # N1 opened Diarrhea + Nausea for P-001; N7 (same subject) links both as follow-ups.
    n1, n7 = ingested["N1"], ingested["N7"]
    n1_ae = {d["fields"]["AEDECOD"]: d for d in n1["drafts"] if d["domain"] == "AE"}
    n7_ae = {d["fields"]["AEDECOD"]: d for d in n7["drafts"] if d["domain"] == "AE"}
    assert all(not d["is_followup"] for d in n1_ae.values())
    for term, d in n7_ae.items():
        assert d["is_followup"] and d["linked_ae_open_id"] == n1_ae[term]["ae_open_id"]
        assert d["fields"]["INTERIM_FOLLOWUP_OF"] == n1_ae[term]["ae_open_id"]
        assert d["fields"]["AESTDTC"] == shift(n1_ae[term]["fields"]["AESTDTC"] + "T00:00:00Z")
        assert d["fields"]["INTERIM_RULES_FIRED"] == ["chartscan.symptom", "dedup.followup_linked"]
    assert n7_ae["Nausea"]["fields"]["INTERIM_RESOLVED_CUE"] is True  # "Nausea resolved"
    assert n7_ae["Nausea"]["fields"]["AEONGO"] == "Y"  # the coordinator sets the end date
    assert [link["first_note_id"] for link in n7["ae_links"]] == [n1["note"]["id"]] * 2
    assert n1_ae["Diarrhea"]["fields"]["AESTDTC"] == "2026-10-02"  # "3 days of diarrhea"
    assert n1_ae["Diarrhea"]["fields"]["AETOXGR"] == 2  # 4-5 stools/day
    assert n1_ae["Nausea"]["fields"]["AESTDTC"] == "2026-10-05"  # note date stands in
    assert n1["note"]["tier"] == 1 and n1["escalation"] is None
    # N6: hospitalization raised the grade hint to 3 and started the clock at ingestion.
    n6 = ingested["N6"]
    assert {d["fields"]["AETOXGR"] for d in n6["drafts"] if d["domain"] == "AE"} == {3}
    assert n6["seriousness_suspected"] is True and n6["escalation_level"] == "urgent"
    # N8: nothing but a "taking" con-med; still a Tier 1 row for the coordinator.
    n8 = ingested["N8"]
    assert [d["domain"] for d in n8["drafts"]] == ["CM"] and n8["tier"] == 1
    assert (
        n8["drafts"][0]["fields"]["CMSTDTC"] is None
        and n8["drafts"][0]["fields"]["CMENDTC"] is None
    )
    assert sum(1 for r in n8["rules_fired"] if r["rule_id"] == "chartscan.symptom_excluded") == 4
    # N3: lisinopril held -> stopped on the note date.
    n3_cm = next(d for d in ingested["N3"]["drafts"] if d["domain"] == "CM")
    assert n3_cm["fields"]["CMENDTC"] == "2026-10-09" and n3_cm["fields"]["CMSTDTC"] is None

    # Nothing paged; never Tier 3; the chain verifies; both note audit actions are present.
    assert client.get("/api/v1/pages", headers=coord).json()["total"] == 0
    audit = client.get("/api/v1/audit?limit=500", headers=coord).json()
    actions = {e["action"] for e in audit["items"]}
    assert {
        "note.ingested",
        "note.scanned",
        "draft.created",
        "escalation.created",
        "sae_clock.started",
    } <= actions
    assert "escalation.paged" not in actions
    scanned = client.get("/api/v1/audit?action=note.scanned", headers=coord).json()
    assert scanned["total"] == 8
    assert scanned["items"][0]["payload"]["scanner"].startswith("interim_rules.chartscan")
    fired = client.get(
        "/api/v1/audit?action=rule.fired&entity_id=" + n6["note"]["id"], headers=coord
    ).json()
    assert fired["total"] == len(n6["rules_fired"])
    assert client.get("/api/v1/audit/verify", headers=coord).json()["ok"] is True

    # GET /notes/{id} is the ingest response; GET /notes lists newest first with counts.
    again = client.get(f"/api/v1/notes/{n6['note']['id']}", headers=coord).json()
    assert again["note"] == n6["note"] and again["why"] == n6["why"]
    assert [d["id"] for d in again["drafts"]] == [d["id"] for d in n6["drafts"]]
    assert again["sae_clock"]["id"] == n6["sae_clock"]["id"]
    listing = client.get("/api/v1/notes?limit=3", headers=coord).json()
    assert listing["total"] == 8 and len(listing["items"]) == 3 and listing["limit"] == 3
    assert listing["items"][0]["id"] == ingested["N8"]["note"]["id"]
    row = (
        next(i for i in listing["items"] if i["id"] == n6["note"]["id"])
        if any(i["id"] == n6["note"]["id"] for i in listing["items"])
        else client.get("/api/v1/notes?usubjid=P-006", headers=coord).json()["items"][0]
    )
    assert row["n_symptoms"] == 2 and row["n_meds"] == 1 and row["n_red_flags"] == 2
    assert row["draft_counts"] == {"AE": 2, "VS": 0, "CM": 1} and row["has_sae_clock"] is True
    assert row["escalation_acked"] is False and row["tier"] == 2
    assert client.get("/api/v1/notes?usubjid=P-001", headers=coord).json()["total"] == 2
    assert client.get("/api/v1/notes?usubjid=p-004", headers=coord).json()["total"] == 2
    assert client.get("/api/v1/notes?usubjid=P-999", headers=coord).json()["total"] == 0
    assert client.get("/api/v1/notes/nope", headers=coord).status_code == 404

    # Queue rows for notes: session_id null, note_id set, ordered with the check-ins.
    queue = client.get("/api/v1/queue?limit=100", headers=coord).json()
    assert queue["total"] == 8 and all(i["source"] == "chart_note" for i in queue["items"])
    top = queue["items"][0]
    assert top["session_id"] is None and top["note_id"] and top["tier"] == 2
    assert top["vitals_status"] == "unavailable" and top["is_measured"] is False
    assert top["completed_at"] == top["completed_at"] and top["note_type"]
    p6 = client.get("/api/v1/queue?usubjid=P-006", headers=coord).json()["items"]
    assert len(p6) == 1 and p6[0]["has_sae_clock"] is True and p6[0]["max_grade"] == 3
    assert client.get("/api/v1/queue?min_tier=2", headers=coord).json()["total"] == 2

    # Timeline: notes[], open AEs opened by notes, con-med changes from notes.
    timeline = client.get("/api/v1/participants/P-001/timeline", headers=coord).json()
    assert [n["id"] for n in timeline["notes"]] == [n1["note"]["id"], n7["note"]["id"]]
    assert timeline["notes"][0]["symptoms"][0]["term"] in ("Diarrhea", "Nausea")
    assert {a["aedecod"] for a in timeline["open_aes"]} == {"Diarrhea", "Nausea"}
    assert all(a["first_note_id"] == n1["note"]["id"] for a in timeline["open_aes"])
    assert [c["source"] for c in timeline["conmed_changes"]] == ["chart_note"] * 3

    # Exports carry the provenance columns for note-sourced records.
    ae_export = client.get("/api/v1/export/AE.json?status=all", headers=coord).json()
    assert ae_export["n_records"] == 14
    assert all(
        r["INTERIM_RECORD_SOURCE"] == "chart_note" and r["INTERIM_NOTE_ID"]
        for r in ae_export["records"]
    )
    assert all(r["INTERIM_SESSION_ID"] is None for r in ae_export["records"])
    bundle = client.get("/api/v1/export/bundle.zip?status=all", headers=coord)
    assert bundle.status_code == 200


def test_cross_source_dedup_in_both_directions(client) -> None:
    coord = login(client, "coordinator")
    # Check-in first (Dyspnea G2 + Cough G1 open for P-003), then the triage note N3.
    add_participant(client, "P-003")
    done = run_kiosk_checkin(client, "P-003")
    detail = client.get(f"/api/v1/checkins/{done['session_id']}", headers=coord).json()
    opened = {d["fields"]["AEDECOD"]: d for d in detail["drafts"] if d["domain"] == "AE"}
    n3 = _ingest(client, coord, "N3")
    n3_ae = {d["fields"]["AEDECOD"]: d for d in n3["drafts"] if d["domain"] == "AE"}
    assert set(n3_ae) == {"Dyspnea", "Cough"}
    for term, d in n3_ae.items():
        assert d["is_followup"] and d["linked_ae_open_id"] == opened[term]["ae_open_id"]
        assert d["fields"]["AESTDTC"] == opened[term]["fields"]["AESTDTC"]
    links = {link["ae_open_id"]: link for link in n3["ae_links"]}
    assert all(link["first_session_id"] == done["session_id"] for link in links.values())
    timeline = client.get("/api/v1/participants/P-003/timeline", headers=coord).json()
    assert [
        (a["aedecod"], a["last_note_id"] == n3["note"]["id"]) for a in timeline["open_aes"]
    ] == [
        ("Dyspnea", True),
        ("Cough", True),
    ]
    # Rejecting the follow-up draft does not close the AE the check-in opened.
    rejected = client.post(
        f"/api/v1/drafts/{n3_ae['Cough']['id']}/reject", json={"reason": "duplicate"}, headers=coord
    )
    assert rejected.status_code == 200
    assert (
        len(client.get("/api/v1/participants/P-003/timeline", headers=coord).json()["open_aes"])
        == 2
    )

    # Note first (N1 opens Diarrhea + Nausea for P-001), then a kiosk report of diarrhea.
    add_participant(client, "P-001")
    n1 = _ingest(client, coord, "N1")
    n1_ae = {d["fields"]["AEDECOD"]: d for d in n1["drafts"] if d["domain"] == "AE"}
    done2 = run_kiosk_checkin(
        client,
        "P-001",
        responses={**ZERO_RESPONSES, "diarrhea": {"frequency": 2}},
        gates={
            **DEMO_GATES,
            "conmed_changed": False,
            "conmed_text": None,
            "conmed_direction": None,
        },
    )
    detail2 = client.get(f"/api/v1/checkins/{done2['session_id']}", headers=coord).json()
    diarrhea = next(d for d in detail2["drafts"] if d["fields"].get("AEDECOD") == "Diarrhea")
    assert diarrhea["is_followup"] is True
    assert diarrhea["linked_ae_open_id"] == n1_ae["Diarrhea"]["ae_open_id"]
    assert diarrhea["fields"]["AESTDTC"] == "2026-10-02T00:00:00.000Z"  # the note's onset date
    assert "dedup.followup_linked" in [r["rule_id"] for r in detail2["rules_fired"]]
    assert detail2["ae_links"][0]["first_session_id"] is None  # opened by a note, not a session
    assert client.get("/api/v1/audit/verify", headers=coord).json()["ok"] is True


def test_scan_is_a_dry_run(client) -> None:
    coord = login(client, "coordinator")
    text = "Pt admitted overnight for severe diarrhea, 8 stools/day. Started loperamide. No rash."
    res = client.post("/api/v1/scan", json={"text": text, "ref_date": "2026-10-09"}, headers=coord)
    assert res.status_code == 200, res.text
    scan = res.json()
    assert scan["dry_run"] is True and scan["tier"] == 2 and scan["seriousness_suspected"] is True
    assert [s["term"] for s in scan["symptoms"]] == ["Diarrhea"]
    assert scan["symptoms"][0]["grade_hint"] == 3 and scan["symptoms"][0]["onset_date"] is None
    assert [s["term"] for s in scan["excluded_symptoms"]] == ["Rash maculo-papular"]
    assert [(m["drug"], m["change"]) for m in scan["meds"]] == [("loperamide", "started")]
    assert {f["category"] for f in scan["red_flags"]} >= {"hospitalization"}
    assert len(scan["why"]) == len(scan["rules_fired"]) >= 4
    for pointer in (e for r in scan["rules_fired"] for e in r["evidence"]):
        assert text[pointer["span_start"] : pointer["span_end"]] == pointer["note"]
    # Nothing stored, nothing audited.
    assert client.get("/api/v1/notes", headers=coord).json()["total"] == 0
    assert client.get("/api/v1/audit?action=note.scanned", headers=coord).json()["total"] == 0
    assert client.get("/api/v1/queue", headers=coord).json()["total"] == 0
    assert client.post("/api/v1/scan", json={"text": text}).status_code == 401
    bad = client.post("/api/v1/scan", json={"text": text, "ref_date": "yesterday"}, headers=coord)
    assert bad.status_code == 422
    assert client.post("/api/v1/scan", json={"text": ""}, headers=coord).status_code == 422


def test_roles_overrides_and_validation(client) -> None:
    add_participant(client, "P-004")
    coord = login(client, "coordinator")
    inv = login(client, "investigator")
    admin = login(client, "admin")
    case = NOTE_CASES["N4"]
    body = {
        "usubjid": "P-004",
        "note_date": case.note_date,
        "author": case.author,
        "note_type": case.note_type,
        "text": case.text,
    }
    assert client.post("/api/v1/notes", json=body).status_code == 401
    assert client.get("/api/v1/notes").status_code == 401
    # The backdating override is admin-only, like the kiosk overrides.
    forbidden = client.post(
        "/api/v1/notes",
        json={**body, "ingested_at_override": "2026-10-06T15:00:00Z"},
        headers=coord,
    )
    assert forbidden.status_code == 403 and "admin-only" in forbidden.json()["detail"]
    assert client.get("/api/v1/notes", headers=coord).json()["total"] == 0  # nothing stored
    backdated = client.post(
        "/api/v1/notes",
        json={**body, "ingested_at_override": "2026-10-06T15:00:00Z"},
        headers=admin,
    )
    assert backdated.status_code == 201, backdated.text
    assert backdated.json()["note"]["ingested_at"] == "2026-10-06T15:00:00.000Z"
    assert backdated.json()["note"]["ingested_by"] == "admin"
    event = client.get("/api/v1/audit?action=note.ingested", headers=coord).json()["items"][0]
    assert event["payload"]["backdated"] is True and event["payload"]["override_by"] == "admin"
    assert event["payload"]["chars"] == len(case.text)
    # An investigator may ingest too (coordinator+).
    by_inv = client.post("/api/v1/notes", json=body, headers=inv)
    assert by_inv.status_code == 201 and by_inv.json()["note"]["ingested_by"] == "investigator"
    # Validation: unknown participant, malformed / future note date, blank text, bad override.
    assert (
        client.post("/api/v1/notes", json={**body, "usubjid": "P-999"}, headers=coord).status_code
        == 404
    )
    assert (
        client.post(
            "/api/v1/notes", json={**body, "note_date": "10/06/2026"}, headers=coord
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/v1/notes", json={**body, "note_date": "2026-13-01"}, headers=coord
        ).status_code
        == 422
    )
    future = client.post(
        "/api/v1/notes",
        json={**body, "note_date": "2026-10-09", "ingested_at_override": "2026-10-06T15:00:00Z"},
        headers=admin,
    )
    assert future.status_code == 422 and future.json()["title"] == "Invalid note date"
    assert (
        client.post("/api/v1/notes", json={**body, "text": "   "}, headers=coord).status_code == 422
    )
    assert (
        client.post(
            "/api/v1/notes", json={**body, "ingested_at_override": "not-a-time"}, headers=admin
        ).status_code
        == 422
    )
    assert client.get("/api/v1/notes", headers=coord).json()["total"] == 2


def test_note_drafts_review_attribution_and_ack(client) -> None:
    add_participant(client, "P-006")
    coord = login(client, "coordinator")
    inv = login(client, "investigator")
    n6 = _ingest(client, coord, "N6")
    confusion = next(d for d in n6["drafts"] if d["fields"]["AEDECOD"] == "Confusion")
    # Coordinator edits the grade hint and confirms; the version chain works for note drafts.
    edited = client.patch(
        f"/api/v1/drafts/{confusion['id']}",
        json={"fields": {"AETOXGR": 2}, "note": "per chart"},
        headers=coord,
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["version"] == 2 and edited.json()["note_id"] == n6["note"]["id"]
    assert edited.json()["evidence"]["AETOXGR"][-1]["kind"] == "edit"
    confirmed = client.post(f"/api/v1/drafts/{edited.json()['id']}/confirm", json={}, headers=coord)
    assert confirmed.status_code == 200 and confirmed.json()["status"] == "confirmed"
    detail = client.get(f"/api/v1/notes/{n6['note']['id']}", headers=coord).json()
    current = next(d for d in detail["drafts"] if d["fields"]["AEDECOD"] == "Confusion")
    assert current["version"] == 2 and current["status"] == "confirmed"
    assert len(detail["drafts"]) == 3  # the superseded version is not listed
    # Only an investigator records seriousness; AESER stops the note's SAE clock.
    denied = client.patch(
        f"/api/v1/drafts/{current['id']}/attribution", json={"AESER": "Y"}, headers=coord
    )
    assert denied.status_code == 403
    active = client.get("/api/v1/sae-clocks?active=true", headers=coord).json()
    assert active["total"] == 1 and active["items"][0]["note_id"] == n6["note"]["id"]
    attributed = client.patch(
        f"/api/v1/drafts/{current['id']}/attribution",
        json={"AESER": "Y", "AEREL": "POSSIBLY RELATED"},
        headers=inv,
    )
    assert attributed.status_code == 200, attributed.text
    assert (
        attributed.json()["fields"]["AESER"] == "Y" and attributed.json()["status"] == "confirmed"
    )
    assert client.get("/api/v1/sae-clocks?active=true", headers=coord).json()["total"] == 0
    stopped = client.get(f"/api/v1/notes/{n6['note']['id']}", headers=coord).json()["sae_clock"]
    assert stopped["stopped_by"] == "investigator" and stopped["decision"] == "AESER = Y"
    stop_event = client.get("/api/v1/audit?action=sae_clock.stopped", headers=coord).json()[
        "items"
    ][0]
    assert stop_event["payload"]["note_id"] == n6["note"]["id"]
    # Acknowledging the note's escalation records who and when; a second ack is refused.
    ack = client.post(
        f"/api/v1/escalations/{n6['escalation']['id']}/ack", json={"note": "called"}, headers=coord
    )
    assert ack.status_code == 200 and ack.json()["acked_by"] == "coordinator"
    assert ack.json()["note_id"] == n6["note"]["id"] and ack.json()["source"] == "chart_note"
    assert (
        client.post(f"/api/v1/escalations/{n6['escalation']['id']}/ack", headers=coord).status_code
        == 409
    )
    queue = client.get("/api/v1/queue?status=open", headers=coord).json()
    assert queue["total"] == 1 and queue["items"][0]["escalation_acked"] is True
    # Confirm the rest: the row leaves the open queue.
    for d in client.get(f"/api/v1/notes/{n6['note']['id']}", headers=coord).json()["drafts"]:
        if d["status"] == "draft":
            assert (
                client.post(f"/api/v1/drafts/{d['id']}/confirm", json={}, headers=coord).status_code
                == 200
            )
    assert client.get("/api/v1/queue?status=open", headers=coord).json()["total"] == 0
    assert client.get("/api/v1/queue", headers=coord).json()["total"] == 1
    assert client.get("/api/v1/audit/verify", headers=coord).json()["ok"] is True


def test_live_demo_participant_mixes_both_sources(client) -> None:
    """P-007: a kiosk check-in and a phone note on the same day share one timeline."""
    add_participant(client, "P-007")
    coord = login(client, "coordinator")
    done = run_kiosk_checkin(client, "P-007", responses=DEMO_RESPONSES)
    note = client.post(
        "/api/v1/notes",
        json={
            "usubjid": "P-007",
            "note_date": "2026-10-10",
            "author": "Research RN",
            "note_type": "phone_note",
            "text": "Phone call: cough unchanged, mild. Started loratadine OTC yesterday.",
        },
        headers=coord,
    )
    assert note.status_code == 201, note.text
    body = note.json()
    cough = next(d for d in body["drafts"] if d["domain"] == "AE")
    assert cough["fields"]["AEDECOD"] == "Cough" and cough["is_followup"] is True
    checkin_cough = next(
        d
        for d in client.get(f"/api/v1/checkins/{done['session_id']}", headers=coord).json()[
            "drafts"
        ]
        if d["fields"].get("AEDECOD") == "Cough"
    )
    assert cough["linked_ae_open_id"] == checkin_cough["ae_open_id"]
    queue = client.get("/api/v1/queue?usubjid=P-007", headers=coord).json()["items"]
    assert [i["source"] for i in queue] == ["chart_note", "check_in"]  # same tier, newest first
    timeline = client.get("/api/v1/participants/P-007/timeline", headers=coord).json()
    assert len(timeline["sessions"]) == 1 and len(timeline["notes"]) == 1
    assert {c["source"] for c in timeline["conmed_changes"]} == {"check_in", "chart_note"}
