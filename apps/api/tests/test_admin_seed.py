"""Seed (data/synthetic/README.md §4.3) and the admin endpoints: settings and reset."""

from __future__ import annotations

from conftest import add_participant, login, run_kiosk_checkin

from interim_api.seed import NOTE_SEEDS, PROFILES


def test_seed_produces_twelve_participants_with_lived_in_timelines(seeded_client) -> None:
    client = seeded_client
    coord = login(client, "coordinator")
    participants = client.get("/api/v1/participants?limit=100", headers=coord).json()
    labels = [p["display_label"] for p in participants["items"]]
    assert labels == [f"P-{i:03d}" for i in range(1, 13)]
    assert participants["items"][0]["usubjid"] == "R2810-ONC-1624-P-001"
    assert participants["items"][0]["baseline_vitals_json"]["note"] == "simulated baseline"

    queue = client.get("/api/v1/queue?limit=100", headers=coord).json()
    n_checkins = sum(len(p.checkins) for p in PROFILES)
    assert n_checkins == 34 and len(NOTE_SEEDS) == 8
    assert queue["total"] == n_checkins + len(NOTE_SEEDS) == 42
    tiers = [item["tier"] for item in queue["items"]]
    assert tiers == sorted(tiers, reverse=True)  # tier desc, then completed_at desc
    assert tiers.count(2) == 4 and tiers.count(3) == 0  # 2 check-ins + 2 notes (N3, N6)
    checkins = [i for i in queue["items"] if i["source"] == "check_in"]
    notes = [i for i in queue["items"] if i["source"] == "chart_note"]
    assert len(checkins) == 34 and len(notes) == 8
    assert all(item["vitals_status"] in ("simulated_ignored", "declined") for item in checkins)
    assert all(item["is_measured"] is False for item in queue["items"])
    assert all(i["session_id"] is None and i["note_id"] for i in notes)
    assert all(i["vitals_status"] == "unavailable" and i["note_date"] for i in notes)
    for a, b in zip(queue["items"], queue["items"][1:], strict=False):
        if a["tier"] == b["tier"]:
            assert a["completed_at"] >= b["completed_at"]

    # P-007: three check-ins, an open Cough AE from 5 days ago, confirmed by the coordinator.
    timeline = client.get("/api/v1/participants/P-007/timeline", headers=coord).json()
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

    # Two Tier 2 check-in escalations (P-003 d24, P-009 d30), acknowledged 20-50 minutes
    # later; two Tier 2 note escalations (N6 for P-006 acknowledged, N3 for P-003 left open).
    escalations = client.get("/api/v1/escalations", headers=coord).json()
    assert escalations["total"] == 4
    by_source: dict[str, list[dict]] = {}
    for e in escalations["items"]:
        by_source.setdefault(e["source"], []).append(e)
    for e in by_source["check_in"]:
        assert e["tier"] == 2 and e["acked_by"] == "coordinator" and e["note_id"] is None
        assert 1200 <= e["seconds_to_ack"] <= 3000
    assert {e["usubjid"][-5:] for e in by_source["check_in"]} == {"P-003", "P-009"}
    note_escalations = {e["usubjid"][-5:]: e for e in by_source["chart_note"]}
    assert set(note_escalations) == {"P-003", "P-006"}
    assert all(e["tier"] == 2 and e["session_id"] is None for e in note_escalations.values())
    assert note_escalations["P-006"]["acked_by"] == "coordinator"
    assert 1800 <= note_escalations["P-006"]["seconds_to_ack"] <= 5400
    assert note_escalations["P-003"]["acked_at"] is None
    open_queue = client.get("/api/v1/queue?status=open&min_tier=2", headers=coord).json()
    unacked = [i for i in open_queue["items"] if i["escalation_acked"] is False]
    assert [(i["display_label"], i["source"]) for i in unacked] == [("P-003", "chart_note")]

    # The ED note (N6) is dated two days back but was read by the site ~3 h before the seed
    # clock, so its SAE clock is a live ~21 h countdown on first load, still running
    # (seriousness is the investigator's call; the seed never records it).
    clocks = client.get("/api/v1/sae-clocks?active=true", headers=coord).json()
    assert clocks["total"] == 1
    clock = clocks["items"][0]
    assert clock["usubjid"].endswith("P-006") and clock["session_id"] is None and clock["note_id"]
    assert clock["overdue"] is False and clock["stopped_at"] is None
    assert 24 * 3600 - 3.6 * 3600 < clock["seconds_remaining"] < 24 * 3600 - 2.4 * 3600
    n6 = client.get(f"/api/v1/notes/{clock['note_id']}", headers=coord).json()
    assert n6["note"]["note_date"] < n6["note"]["ingested_at"][:10]  # written before it was read
    assert n6["sae_clock"]["site_awareness_at"] == n6["note"]["ingested_at"]

    # Eight notes ingested, backdated; N2 links onto P-002's d6 check-in AEs (cross-source)
    # and N7 onto N1's AEs (cross-note); N8 has no AE at all.
    notes_page = client.get("/api/v1/notes?limit=50", headers=coord).json()
    assert notes_page["total"] == 8
    assert [n["ingested_at"] for n in notes_page["items"]] == sorted(
        (n["ingested_at"] for n in notes_page["items"]), reverse=True
    )
    assert all(n["ingested_by"] == "coordinator" for n in notes_page["items"])
    p2 = client.get("/api/v1/participants/P-002/timeline", headers=coord).json()
    assert len(p2["notes"]) == 1 and p2["notes"][0]["note_type"] == "consult"
    n2 = client.get(f"/api/v1/notes/{p2['notes'][0]['id']}", headers=coord).json()
    n2_ae = [d for d in n2["drafts"] if d["domain"] == "AE"]
    assert {d["fields"]["AEDECOD"] for d in n2_ae} == {"Rash maculo-papular", "Pruritus"}
    assert all(d["is_followup"] and d["linked_ae_open_id"] for d in n2_ae)
    linked = {link["ae_open_id"]: link for link in n2["ae_links"]}
    assert all(linked[d["linked_ae_open_id"]]["first_session_id"] for d in n2_ae)
    assert all(d["fields"]["INTERIM_RECORD_SOURCE"] == "chart_note" for d in n2["drafts"])
    p1 = client.get("/api/v1/participants/P-001/timeline", headers=coord).json()
    assert [n["note_type"] for n in p1["notes"]] == ["progress_note", "phone_note"]
    assert p1["notes"][1]["draft_count"] == 3 and p1["notes"][0]["draft_count"] == 4
    n7 = client.get(f"/api/v1/notes/{p1['notes'][1]['id']}", headers=coord).json()
    assert sum(1 for d in n7["drafts"] if d["is_followup"]) == 2
    assert all(link["first_note_id"] == p1["notes"][0]["id"] for link in n7["ae_links"])
    assert {a["aedecod"] for a in p1["open_aes"]} == {"Fatigue", "Diarrhea", "Nausea"}
    assert [c["source"] for c in p1["conmed_changes"]] == ["chart_note"] * 3

    # P-012's middle session declined the camera: no VS rows, status declined.
    p12 = client.get("/api/v1/participants/P-012/timeline", headers=coord).json()
    declined = [s for s in p12["sessions"] if not s["consent_camera"]]
    assert len(declined) == 1 and declined[0]["vitals_status"] == "declined"
    d12 = client.get(f"/api/v1/checkins/{declined[0]['id']}", headers=coord).json()
    assert not [d for d in d12["drafts"] if d["domain"] == "VS"]

    # Con-med changes on exactly four participants (check-ins), including the brand -> generic
    # case; note-sourced CM rows are labeled chart_note and carry the note id.
    all_cm = client.get("/api/v1/export/CM.json?status=all", headers=coord).json()["records"]
    conmeds = [r for r in all_cm if r["INTERIM_RECORD_SOURCE"] == "check_in"]
    assert {r["USUBJID"][-5:] for r in conmeds} == {"P-003", "P-005", "P-006", "P-008"}
    note_cm = [r for r in all_cm if r["INTERIM_RECORD_SOURCE"] == "chart_note"]
    assert len(note_cm) == 9 and all(
        r["INTERIM_NOTE_ID"] and r["INTERIM_SESSION_ID"] is None for r in note_cm
    )
    assert all(r["INTERIM_MATCH_KIND"] == "lexicon" for r in note_cm)
    zofran = next(r for r in conmeds if r["CMTRT"] == "Zofran")
    assert zofran["CMDECOD"] == "ondansetron" and zofran["INTERIM_MATCH_KIND"] == "case_insensitive"

    # Everything the seed did is in the chain and the chain verifies.
    verify = client.get("/api/v1/audit/verify", headers=coord).json()
    assert verify["ok"] is True and verify["checked"] > 1000
    genesis = client.get("/api/v1/audit?action=demo.seed", headers=coord).json()
    assert genesis["total"] == 1 and genesis["items"][0]["seq"] == 1

    # The live demo check-in links its cough report to the seeded open AE.
    done = run_kiosk_checkin(client, "P-007")
    live = client.get(f"/api/v1/checkins/{done['session_id']}", headers=coord).json()
    cough = next(d for d in live["drafts"] if d["fields"].get("AEDECOD") == "Cough")
    dyspnea = next(d for d in live["drafts"] if d["fields"].get("AEDECOD") == "Dyspnea")
    assert (
        cough["is_followup"] is True and cough["linked_ae_open_id"] == timeline["open_aes"][1]["id"]
    )
    assert dyspnea["is_followup"] is False
    # Queue order is tier desc, then newest first: the seeded Tier 2 rows outrank this Tier 1
    # check-in, which is the newest row of its tier and the top row for P-007.
    queue_after = client.get("/api/v1/queue?limit=100", headers=coord).json()["items"]
    assert [i["tier"] for i in queue_after][:2] == [2, 2]
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
    from interim_api.util import now_iso

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
        and res.json()["sessions"] == 34
        and res.json()["notes"] == 8
        and res.json()["note_followups"] == 4
        and res.json()["note_sae_clocks"] == 1
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
    assert client.get("/api/v1/queue?limit=100", headers=admin).json()["total"] == 42
    assert client.get("/api/v1/notes", headers=admin).json()["total"] == 8
    add_participant(client, "P-013")
    assert (
        client.post(
            "/api/v1/sessions", json={"usubjid": "P-013", "consent_camera": False}
        ).status_code
        == 201
    )
