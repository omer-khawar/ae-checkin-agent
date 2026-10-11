"""Seed (data/synthetic/README.md §4.3 and "Monday morning") and the admin endpoints."""

from __future__ import annotations

from conftest import add_participant, login, run_kiosk_checkin

from interim_api.seed import NOTE_SEEDS, OVERNIGHT_CHECKINS, PROFILES
from interim_api.services.baseline import SYNTHEA_LABEL
from interim_api.util import now_iso, shift


def test_seed_produces_twelve_participants_with_lived_in_timelines(seeded_client) -> None:
    client = seeded_client
    coord = login(client, "coordinator")
    participants = client.get("/api/v1/participants?limit=100", headers=coord).json()
    labels = [p["display_label"] for p in participants["items"]]
    assert labels == [f"P-{i:03d}" for i in range(1, 13)]
    assert participants["items"][0]["usubjid"] == "R2810-ONC-1624-P-001"
    # Every participant carries its Synthea chart's baseline, labelled simulated; the simulated
    # kiosk vitals are centred on the chart's median pulse and breathing rate.
    for p in participants["items"]:
        vitals = p["baseline_vitals_json"]
        assert vitals["note"] == "simulated baseline" and vitals["is_measured"] is False
        assert vitals["source"] == "synthea"
        baseline = p["baseline"]
        assert baseline["label"] == SYNTHEA_LABEL and baseline["is_measured"] is False
        assert baseline["summary"] and baseline["nsclc_stage"] and baseline["sex"]
        assert vitals["pulse_bpm"] == baseline["pulse_bpm"]["median"]
    p1 = participants["items"][0]["baseline"]
    assert (
        p1["age_at_reference"] == 76 and p1["sex"] == "male" and p1["pulse_bpm"]["median"] == 82.0
    )
    assert {t["ingredient"] for t in p1["prior_cancer_therapy"]} == {"cisplatin", "paclitaxel"}
    assert "metoprolol" in p1["active_medications"]

    queue = client.get("/api/v1/queue?limit=100", headers=coord).json()
    n_checkins = sum(len(p.checkins) for p in PROFILES) + len(OVERNIGHT_CHECKINS)
    assert n_checkins == 35 + 3 and len(NOTE_SEEDS) == 9
    assert queue["total"] == n_checkins + len(NOTE_SEEDS) == 47
    tiers = [item["tier"] for item in queue["items"]]
    assert tiers == sorted(tiers, reverse=True)  # tier desc, then completed_at desc
    # Tier 3: P-012's hospitalization last week. Tier 2: three check-ins (P-003 d12 and the
    # overnight G3, P-009 d30) and two notes (the overnight caregiver call N3, the ER note N6).
    assert tiers.count(3) == 1 and tiers.count(2) == 5
    checkins = [i for i in queue["items"] if i["source"] == "check_in"]
    notes = [i for i in queue["items"] if i["source"] == "chart_note"]
    assert len(checkins) == 38 and len(notes) == 9
    assert all(item["vitals_status"] in ("simulated_ignored", "declined") for item in checkins)
    assert all(item["is_measured"] is False for item in queue["items"])
    assert all(i["session_id"] is None and i["note_id"] for i in notes)
    assert all(i["vitals_status"] == "unavailable" and i["note_date"] for i in notes)
    for a, b in zip(queue["items"], queue["items"][1:], strict=False):
        if a["tier"] == b["tier"]:
            assert a["completed_at"] >= b["completed_at"]

    # P-007: three check-ins, an open Cough AE from 5 days ago, confirmed by the coordinator.
    timeline = client.get("/api/v1/participants/P-007/timeline", headers=coord).json()
    assert timeline["baseline"]["label"] == SYNTHEA_LABEL
    assert len(timeline["sessions"]) == 3
    assert [a["aedecod"] for a in timeline["open_aes"]] == ["Fatigue", "Cough"]
    cough_session = timeline["open_aes"][1]["first_session_id"]
    detail = client.get(f"/api/v1/checkins/{cough_session}", headers=coord).json()
    ae = next(d for d in detail["drafts"] if d["domain"] == "AE")
    assert (
        ae["status"] == "confirmed"
        and ae["fields"]["AEDECOD"] == "Cough"
        and ae["fields"]["AETOXGR"] == 1
    )
    assert detail["session"]["backdated"] is True
    assert len(detail["vitals"]["samples"]) >= 240
    assert all(
        s["source"] == "mock" and s["is_measured"] is False for s in detail["vitals"]["samples"][:5]
    )
    assert {d["fields"]["VSTESTCD"] for d in detail["drafts"] if d["domain"] == "VS"} == {
        "PULSE",
        "RESP",
        "HRV_RMSSD",
    }
    assert all(d["fields"]["VSSTAT"] is None for d in detail["drafts"] if d["domain"] == "VS")

    # Escalations: the history ones (P-003 d12, P-009 d30, P-012 d7) were acknowledged 20-50
    # minutes later; the three overnight ones wait for the coordinator.
    escalations = client.get("/api/v1/escalations", headers=coord).json()
    assert escalations["total"] == 6
    history = [e for e in escalations["items"] if e["acked_at"] is not None]
    assert sorted(e["usubjid"][-5:] for e in history) == ["P-003", "P-009", "P-012"]
    for e in history:
        assert e["source"] == "check_in" and e["acked_by"] == "coordinator"
        assert 1200 <= e["seconds_to_ack"] <= 3000
    assert {e["usubjid"][-5:]: e["tier"] for e in history} == {"P-003": 2, "P-009": 2, "P-012": 3}
    overnight = sorted(
        (e["usubjid"][-5:], e["source"], e["tier"])
        for e in escalations["items"]
        if e["acked_at"] is None
    )
    assert overnight == [
        ("P-003", "chart_note", 2),
        ("P-003", "check_in", 2),
        ("P-006", "chart_note", 2),
    ]
    open_queue = client.get("/api/v1/queue?status=open&min_tier=2", headers=coord).json()
    unacked = [i for i in open_queue["items"] if i["escalation_acked"] is False]
    assert sorted((i["display_label"], i["source"]) for i in unacked) == [
        ("P-003", "chart_note"),
        ("P-003", "check_in"),
        ("P-006", "chart_note"),
    ]

    # Two 24-hour clocks running on Monday morning, both live countdowns: the overnight
    # possible AESI (P-003's severe diarrhea, ~10.5 h old) and the ER note's SAE clock (N6,
    # read ~3 h before the seed clock). Seriousness is the investigator's call; the seed never
    # records it.
    clocks = client.get("/api/v1/sae-clocks?active=true", headers=coord).json()
    assert clocks["total"] == 2
    by_kind = {c["kind"]: c for c in clocks["items"]}
    aesi, sae = by_kind["aesi"], by_kind["sae"]
    assert aesi["usubjid"].endswith("P-003") and aesi["session_id"] and aesi["note_id"] is None
    assert 24 * 3600 - 11.0 * 3600 < aesi["seconds_remaining"] < 24 * 3600 - 10.0 * 3600
    assert sae["usubjid"].endswith("P-006") and sae["session_id"] is None and sae["note_id"]
    assert all(c["overdue"] is False and c["stopped_at"] is None for c in clocks["items"])
    assert 24 * 3600 - 3.6 * 3600 < sae["seconds_remaining"] < 24 * 3600 - 2.4 * 3600
    n6 = client.get(f"/api/v1/notes/{sae['note_id']}", headers=coord).json()
    assert n6["note"]["note_date"] < n6["note"]["ingested_at"][:10]  # written before it was read
    assert n6["sae_clock"]["site_awareness_at"] == n6["note"]["ingested_at"]
    # Past clocks were all reported at the time (signed packets, mock EDC).
    stopped = client.get("/api/v1/sae-clocks?active=false&limit=50", headers=coord).json()
    assert sorted((c["kind"], c["usubjid"][-5:]) for c in stopped["items"]) == [
        ("aesi", "P-003"),
        ("aesi", "P-009"),
        ("sae", "P-012"),
    ]
    assert all(c["decision"] == "reported (mock)" for c in stopped["items"])

    # Packets: the two running clocks' reports are pre-filled (template writer, unsigned);
    # P-012's SAE report from last week is signed inside 24 h with a follow-up due.
    packets = client.get("/api/v1/packets?limit=50", headers=coord).json()["items"]
    assert len(packets) == 5
    drafts = [p for p in packets if p["status"] == "draft"]
    assert sorted((p["kind"], p["usubjid"][-5:]) for p in drafts) == [
        ("aesi", "P-003"),
        ("sae", "P-006"),
    ]
    for p in drafts:
        full = client.get(f"/api/v1/packets/{p['id']}", headers=coord).json()
        assert full["created_by"] == "interim-api" and full["narrative"]["writer"] == "template"
        assert full["narrative"]["sentences"] and full["missing_information"]
        assert full["clock_id"] in {aesi["id"], sae["id"]}
    last_week = next(p for p in packets if p["kind"] == "sae" and p["status"] == "signed")
    signed = client.get(f"/api/v1/packets/{last_week['id']}", headers=coord).json()
    assert signed["usubjid"].endswith("P-012") and signed["sequence"] == 0
    assert signed["signed_by"] == "investigator" and signed["mock_edc_ack_id"]
    assert signed["followup_packet_ids"] == [] and signed["missing_information"]
    assert "Outcome of the event" in signed["missing_information"]
    assert signed["signed_at"] <= signed["due_at"] and signed["clock_stopped_at"]

    # Sponsor queries (R4.5): one open on P-005's confirmed Zofran record, one answered on
    # P-003's loperamide record (dose corrected and re-confirmed).
    queries = client.get("/api/v1/queries?limit=50", headers=coord).json()
    assert queries["counts"] == {"open": 1, "answered": 1, "closed": 0}
    by_status = {q["status"]: q for q in queries["items"]}
    open_q, answered_q = by_status["open"], by_status["answered"]
    assert open_q["display_label"] == "P-005" and "Zofran" in open_q["text"]
    assert open_q["check_id"] == "query.cm_required_fields_missing" and open_q["field"] == "CMDOSE"
    assert open_q["trigger"] == "mock_edc" and open_q["edc_ack_id"]
    assert 60 < open_q["age_hours"] < 84  # posted to the mock EDC three days ago
    assert answered_q["display_label"] == "P-003" and "loperamide" in answered_q["text"]
    answered = client.get(f"/api/v1/queries/{answered_q['id']}", headers=coord).json()
    assert answered["answered_by"] == "coordinator" and answered["answered_from_suggestion"] is True
    corrected = answered["answer_edit_draft_id"]
    assert corrected
    cm_rows = client.get("/api/v1/export/CM.json?status=confirmed", headers=coord).json()["records"]
    lop = next(r for r in cm_rows if r["INTERIM_DRAFT_ID"] == corrected)
    assert lop["CMDOSE"] == "2" and lop["INTERIM_DRAFT_VERSION"] == 2

    # The overnight kiosk check-ins: P-003 G3 diarrhea (possible AESI, follow-up of the open
    # Diarrhea AE), P-011 prednisone (discouraged, no tier change), P-004 routine.
    def latest(label: str) -> dict:
        sessions = client.get(f"/api/v1/participants/{label}/timeline", headers=coord).json()[
            "sessions"
        ]
        return client.get(f"/api/v1/checkins/{sessions[-1]['id']}", headers=coord).json()

    p3 = latest("P-003")
    diarrhea = next(d for d in p3["drafts"] if d["fields"].get("AEDECOD") == "Diarrhea")
    assert diarrhea["fields"]["AETOXGR"] == 3 and diarrhea["is_followup"] is True
    assert diarrhea["status"] == "draft"
    assert p3["session"]["tier"] == 2 and p3["protocol"]["aesi_suspected"] is True
    p11 = latest("P-011")
    assert p11["session"]["tier"] == 1
    flags = p11["protocol"]["conmed_flags"]
    assert [(f["level"], f["drug"]) for f in flags] == [("discouraged", "prednisone")]
    assert flags[0]["protocol_ref"]["printed_page"] == 69 and flags[0]["exception_text"]
    p4 = latest("P-004")
    assert p4["session"]["tier"] == 0
    for d in (p3, p11, p4):
        assert all(x["status"] == "draft" for x in d["drafts"])  # waiting for the coordinator
        assert d["session"]["completed_at"][:10] >= shift(now_iso(), seconds=-14 * 3600)[:10]

    # Nine notes: six history notes on their re-anchored days, then overnight a caregiver
    # call (N3, P-003), an urgent-care record (UC1, P-002) and the ER note (N6, P-006).
    notes_page = client.get("/api/v1/notes?limit=50", headers=coord).json()
    assert notes_page["total"] == 9
    assert [n["ingested_at"] for n in notes_page["items"]] == sorted(
        (n["ingested_at"] for n in notes_page["items"]), reverse=True
    )
    assert all(n["ingested_by"] == "coordinator" for n in notes_page["items"])
    newest = notes_page["items"][:3]
    assert [(n["display_label"], n["note_type"]) for n in newest] == [
        ("P-006", "ed_note"),
        ("P-002", "outside_record"),
        ("P-003", "phone_call"),
    ]
    call = newest[2]
    assert call["caller"] == "caregiver" and call["call_direction"] == "inbound"
    n3 = client.get(f"/api/v1/notes/{call['id']}", headers=coord).json()
    assert n3["tier"] == 2 and n3["sae_clock"] is None
    assert {d["fields"]["AEDECOD"] for d in n3["drafts"] if d["is_followup"]} == {
        "Dyspnea",
        "Cough",
    }
    p2 = client.get("/api/v1/participants/P-002/timeline", headers=coord).json()
    assert [n["note_type"] for n in p2["notes"]] == ["consult", "outside_record"]
    n2 = client.get(f"/api/v1/notes/{p2['notes'][0]['id']}", headers=coord).json()
    n2_ae = [d for d in n2["drafts"] if d["domain"] == "AE"]
    assert {d["fields"]["AEDECOD"] for d in n2_ae} == {"Rash maculo-papular", "Pruritus"}
    assert all(d["is_followup"] and d["linked_ae_open_id"] for d in n2_ae)
    linked = {link["ae_open_id"]: link for link in n2["ae_links"]}
    assert all(linked[d["linked_ae_open_id"]]["first_session_id"] for d in n2_ae)
    assert all(d["fields"]["INTERIM_RECORD_SOURCE"] == "chart_note" for d in n2["drafts"])
    uc1 = client.get(f"/api/v1/notes/{p2['notes'][1]['id']}", headers=coord).json()
    uc1_ae = [d for d in uc1["drafts"] if d["domain"] == "AE"]
    assert {d["fields"]["AEDECOD"] for d in uc1_ae} == {"Rash maculo-papular", "Pruritus"}
    assert all(d["is_followup"] for d in uc1_ae) and uc1["tier"] == 1
    assert {d["linked_ae_open_id"] for d in uc1_ae} == {d["linked_ae_open_id"] for d in n2_ae}
    p1 = client.get("/api/v1/participants/P-001/timeline", headers=coord).json()
    assert [n["note_type"] for n in p1["notes"]] == ["progress_note", "phone_note"]
    assert p1["notes"][1]["draft_count"] == 3 and p1["notes"][0]["draft_count"] == 4
    n7 = client.get(f"/api/v1/notes/{p1['notes'][1]['id']}", headers=coord).json()
    assert sum(1 for d in n7["drafts"] if d["is_followup"]) == 2
    assert all(link["first_note_id"] == p1["notes"][0]["id"] for link in n7["ae_links"])
    assert {a["aedecod"] for a in p1["open_aes"]} == {"Fatigue", "Diarrhea", "Nausea"}
    assert [c["source"] for c in p1["conmed_changes"]] == ["chart_note"] * 3

    # P-003's brief defaults to "since the last visit" (20 days ago) with the next visit
    # tomorrow; it shows the Synthea background, labelled simulated.
    brief = client.get("/api/v1/participants/P-003/brief", headers=coord).json()
    today = now_iso()[:10]
    assert brief["since_basis"] == "previous_visit"
    assert brief["since"] == shift(f"{today}T12:00:00.000Z", days=-20)[:10]
    assert brief["next_visit"] == shift(f"{today}T12:00:00.000Z", days=1)[:10]
    assert brief["baseline"]["label"] == SYNTHEA_LABEL and brief["baseline"]["evidence_ids"]
    kinds = {q["kind"] for q in brief["questions_to_ask"]}
    assert {"cm_missing_fields", "unresolved_ae", "unsigned_packet"} <= kinds
    printable = client.get("/api/v1/participants/P-003/brief/print", headers=coord)
    assert printable.status_code == 200 and SYNTHEA_LABEL in printable.text

    # P-012's middle session declined the camera: no VS rows, status declined.
    p12 = client.get("/api/v1/participants/P-012/timeline", headers=coord).json()
    declined = [s for s in p12["sessions"] if not s["consent_camera"]]
    assert len(declined) == 1 and declined[0]["vitals_status"] == "declined"
    d12 = client.get(f"/api/v1/checkins/{declined[0]['id']}", headers=coord).json()
    assert not [d for d in d12["drafts"] if d["domain"] == "VS"]

    # Con-med changes on check-ins for five participants, including the brand -> generic case
    # and the overnight prednisone; note-sourced CM rows are labeled chart_note.
    all_cm = client.get("/api/v1/export/CM.json?status=all", headers=coord).json()["records"]
    conmeds = [r for r in all_cm if r["INTERIM_RECORD_SOURCE"] == "check_in"]
    assert {r["USUBJID"][-5:] for r in conmeds} == {"P-003", "P-005", "P-006", "P-008", "P-011"}
    note_cm = [r for r in all_cm if r["INTERIM_RECORD_SOURCE"] == "chart_note"]
    assert len(note_cm) == 9 and all(
        r["INTERIM_NOTE_ID"] and r["INTERIM_SESSION_ID"] is None for r in note_cm
    )
    assert all(r["INTERIM_MATCH_KIND"] == "lexicon" for r in note_cm)
    zofran = next(r for r in conmeds if r["CMTRT"] == "Zofran")
    assert zofran["CMDECOD"] == "ondansetron" and zofran["INTERIM_MATCH_KIND"] == "case_insensitive"
    assert zofran["INTERIM_DRAFT_STATUS"] == "confirmed"

    # Everything the seed did is in the chain and the chain verifies.
    verify = client.get("/api/v1/audit/verify", headers=coord).json()
    assert verify["ok"] is True and verify["checked"] > 1000
    genesis = client.get("/api/v1/audit?action=demo.seed", headers=coord).json()
    assert genesis["total"] == 1 and genesis["items"][0]["seq"] == 1
    seeded = client.get("/api/v1/audit?action=demo.seeded", headers=coord).json()["items"][0]
    assert seeded["payload"]["overnight"] == {
        "checkins": 3,
        "notes": 2,
        "calls": 1,
        "packets_prefilled": 2,
    }
    assert seeded["payload"]["queries"] == {"open": 1, "answered": 1}
    assert seeded["payload"]["synthea_baselines"] == 12
    assert client.get("/api/v1/audit?action=visit.recorded", headers=coord).json()["total"] == 2

    # The live demo check-in links its cough report to the seeded open AE.
    done = run_kiosk_checkin(client, "P-007")
    live = client.get(f"/api/v1/checkins/{done['session_id']}", headers=coord).json()
    cough = next(d for d in live["drafts"] if d["fields"].get("AEDECOD") == "Cough")
    dyspnea = next(d for d in live["drafts"] if d["fields"].get("AEDECOD") == "Dyspnea")
    assert (
        cough["is_followup"] is True and cough["linked_ae_open_id"] == timeline["open_aes"][1]["id"]
    )
    assert dyspnea["is_followup"] is False
    # Queue order is tier desc, then newest first: the seeded Tier 3 and Tier 2 rows outrank
    # this Tier 1 check-in, which is the newest row of its tier and the top row for P-007.
    queue_after = client.get("/api/v1/queue?limit=100", headers=coord).json()["items"]
    assert [i["tier"] for i in queue_after][:6] == [3, 2, 2, 2, 2, 2]
    assert next(i for i in queue_after if i["tier"] == 1)["session_id"] == done["session_id"]
    mine = client.get("/api/v1/queue?usubjid=P-007", headers=coord).json()["items"]
    assert mine[0]["session_id"] == done["session_id"] and len(mine) == 4


def test_seed_is_deterministic_apart_from_ids_and_clock(tmp_path) -> None:
    from conftest import make_settings
    from sqlmodel import select

    from interim_api.db import Database, create_all, make_engine
    from interim_api.models import Answer, Session
    from interim_api.seed import seed_database

    def answers_signature(path_name: str) -> list[tuple[str, str, int | None, str | None]]:
        settings = make_settings(tmp_path / path_name)
        (tmp_path / path_name).mkdir()
        database = Database(make_engine(settings.resolved_database_url))
        create_all(database.engine)
        with database.write_scope() as db:
            seed_database(db, settings, now="2026-10-10T12:00:00.000Z")
            sessions = {s.id: s for s in db.exec(select(Session)).all()}
            rows = db.exec(select(Answer)).all()
            sig = sorted(
                (
                    sessions[a.session_id].usubjid,
                    a.item_id + "." + a.attribute,
                    a.value_int,
                    a.value_text,
                )
                for a in rows
            )
            tiers = sorted((s.usubjid, s.started_at, s.tier) for s in sessions.values())
        database.dispose()
        return sig + [(u, t, tier, None) for u, t, tier in tiers]

    assert answers_signature("a") == answers_signature("b")


def test_admin_settings_round_trip_and_reset(seeded_client) -> None:
    client = seeded_client
    admin = login(client, "admin")
    coord = login(client, "coordinator")
    before = client.get("/api/v1/admin/settings", headers=admin).json()
    assert before["vitals_source"] == "mock" and before["simulated_as_measured"] is False
    assert "warning" in before
    res = client.put(
        "/api/v1/admin/settings",
        json={"mock_scenario": "post_exercise", "simulated_as_measured": True},
        headers=admin,
    )
    assert res.status_code == 200
    assert (
        res.json()["mock_scenario"] == "post_exercise"
        and res.json()["simulated_as_measured"] is True
    )
    public = client.get("/api/v1/settings/public").json()
    assert public["mock_scenario"] == "post_exercise" and public["simulated_as_measured"] is True
    event = client.get("/api/v1/audit?action=settings.changed", headers=coord).json()["items"][0]
    assert event["payload"]["before"]["mock_scenario"] == "resting"
    assert event["payload"]["after"]["mock_scenario"] == "post_exercise"
    assert (
        client.put(
            "/api/v1/admin/settings", json={"vitals_source": "webcam"}, headers=admin
        ).status_code
        == 422
    )
    assert client.put("/api/v1/admin/settings", json={"other": 1}, headers=admin).status_code == 422

    # The global toggle now applies to a live check-in (tier 2 with the tachypnea sample).
    sample = {
        "tsUtc": now_iso(),
        "source": "mock",
        "isMeasured": False,
        "pulseBpm": 98,
        "pulseConf": 0.9,
        "breathingBpm": 26,
        "breathingConf": 0.9,
        "windowS": 30,
        "qualityFlags": [],
    }
    done = run_kiosk_checkin(client, "P-007", samples=[sample])
    assert done["tier"] == 2

    # Reset wipes everything, reseeds, and starts a fresh chain with a demo.reset genesis.
    total_before = client.get("/api/v1/audit", headers=coord).json()["total"]
    res = client.post("/api/v1/admin/reset", json={"reseed": True}, headers=admin)
    assert res.status_code == 200, res.text
    assert (
        res.json()["ok"] is True
        and res.json()["participants"] == 12
        and res.json()["sessions"] == 38
        and res.json()["notes"] == 9
        and res.json()["note_followups"] == 8
        and res.json()["note_sae_clocks"] == 1
        and res.json()["queries"] == {"open": 1, "answered": 1}
    )
    admin = login(client, "admin")  # tokens stay valid: identity is signed, not stored
    audit = client.get("/api/v1/audit?limit=1&offset=0", headers=admin).json()
    assert audit["total"] < total_before
    first = client.get("/api/v1/audit?action=demo.reset", headers=admin).json()["items"][0]
    assert first["seq"] == 1 and first["prev_hash"] == "0" * 64
    assert client.get("/api/v1/audit/verify", headers=admin).json()["ok"] is True
    settings_after = client.get("/api/v1/admin/settings", headers=admin).json()
    assert (
        settings_after["mock_scenario"] == "resting"
        and settings_after["simulated_as_measured"] is False
    )
    assert client.get("/api/v1/queue?limit=100", headers=admin).json()["total"] == 47
    assert client.get("/api/v1/notes", headers=admin).json()["total"] == 9
    add_participant(client, "P-013")
    assert (
        client.post(
            "/api/v1/sessions", json={"usubjid": "P-013", "consent_camera": False}
        ).status_code
        == 201
    )
