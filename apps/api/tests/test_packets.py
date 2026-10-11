"""Serious-event packets (CONTRACTS R3.2 "Packets", R4.2 follow-ups, R4.3 irAE assessment).

Covers: AESI clocks persisted with ``kind``; clock kinds on the queue, the check-in detail
and ``/sae-clocks``; packet creation (idempotent), the role matrix, evidence resolution,
versioned edits, signing (clock stopped "reported (mock)", mock-EDC ack), follow-ups
(``changes_since_previous``, recomputed missing information), JSON export and the
printable page; ``INTERIM_IRAE`` on the attribution endpoint; protocol flags on chart-note
CM drafts. No network anywhere (the LLM writer tests live in ``test_packets_writer.py``).
"""

from __future__ import annotations

from typing import Any

import pytest
from conftest import ZERO_RESPONSES, add_participant, login, make_settings, run_kiosk_checkin

from interim_api.models import Packet
from interim_api.services.packets import FOOTER
from interim_rules.narrative import validate_written

API = "/api/v1"


@pytest.fixture
def settings(tmp_path):
    """No API key, whatever the developer's shell holds: the template writer only."""
    return make_settings(tmp_path, anthropic_api_key="", interim_writer="auto")


AESI_SAE_GATES: dict[str, Any] = {
    "hospitalization": True,
    "conmed_changed": True,
    "conmed_text": "prednisone",
    "conmed_direction": "started",
    "other_text": "",
}


def _responses(**overrides: dict[str, int]) -> dict[str, dict[str, int]]:
    out = {k: dict(v) for k, v in ZERO_RESPONSES.items()}
    out.update(overrides)
    return out


def _aesi_checkin(client, label: str = "P-003", *, hospital: bool = True) -> dict[str, Any]:
    add_participant(client, label)
    gates = dict(AESI_SAE_GATES, hospitalization=hospital)
    return run_kiosk_checkin(
        client,
        label,
        responses=_responses(diarrhea={"frequency": 4}, itching={"severity": 3}),
        gates=gates,
    )


def _clocks(client, session_id: str, headers: dict[str, str]) -> dict[str, dict[str, Any]]:
    detail = client.get(f"{API}/checkins/{session_id}", headers=headers).json()
    return {c["kind"]: c for c in detail["clocks"]}


def _all_cited_ids(packet: dict[str, Any]) -> set[str]:
    ids = {str(e["id"]) for f in packet["fields"] for e in f["evidence"]}
    ids |= {i for s in packet["narrative"]["sentences"] for i in s["evidence_ids"]}
    return ids


def _audit(client, headers, **query: str) -> list[dict[str, Any]]:
    params = "&".join(f"{k}={v}" for k, v in query.items())
    return client.get(f"{API}/audit?{params}&limit=500", headers=headers).json()["items"]


# --------------------------------------------------------------------------- #
# Engine integration: AESI clock, kinds, protocol on the detail
# --------------------------------------------------------------------------- #


def test_aesi_clock_is_persisted_with_kind_everywhere(client) -> None:
    done = _aesi_checkin(client)
    coord = login(client, "coordinator")
    detail = client.get(f"{API}/checkins/{done['session_id']}", headers=coord).json()
    kinds = sorted(c["kind"] for c in detail["clocks"])
    assert kinds == ["aesi", "sae"]
    assert detail["sae_clock"]["kind"] == "sae" and detail["aesi_clock"]["kind"] == "aesi"
    assert detail["aesi_clock"]["label"] == "possible AESI, investigator to confirm"
    assert (
        detail["aesi_clock"]["has_ae_draft"] is True and detail["aesi_clock"]["packet_id"] is None
    )
    # Protocol assessment and plain labels reach the detail (R3.2).
    assert detail["protocol"]["aesi_suspected"] is True
    assert set(detail["protocol"]["aesi_items"]) == {"diarrhea", "itching"}
    assert detail["labels"]["AETOXGR"] == "Severity grade (provisional)"
    cm = next(d for d in detail["drafts"] if d["domain"] == "CM")
    assert cm["fields"]["INTERIM_PROTOCOL_FLAG"] == "discouraged"
    assert "CMDOSE" in cm["fields"]["INTERIM_CM_MISSING_FIELDS"]
    # GET /sae-clocks returns both kinds.
    rows = client.get(f"{API}/sae-clocks", headers=coord).json()["items"]
    assert sorted(r["kind"] for r in rows) == ["aesi", "sae"]
    # Queue item carries every clock with its kind.
    item = client.get(f"{API}/queue", headers=coord).json()["items"][0]
    assert sorted(c["kind"] for c in item["clocks"]) == ["aesi", "sae"]
    assert item["has_sae_clock"] is True and item["clock_kind"] in ("sae", "aesi")
    # Audit: every clock start is a clock.started event carrying its kind (SAE and AESI
    # alike); the SAE start also keeps the original sae_clock.started action.
    started = _audit(client, coord, action="clock.started")
    assert sorted(e["payload"]["kind"] for e in started) == ["aesi", "sae"]
    legacy = _audit(client, coord, action="sae_clock.started")
    assert len(legacy) == 1 and legacy[0]["payload"]["kind"] == "sae"


def test_grade3_without_hospitalization_starts_only_an_aesi_clock(client) -> None:
    done = _aesi_checkin(client, hospital=False)
    coord = login(client, "coordinator")
    clocks = _clocks(client, done["session_id"], coord)
    assert list(clocks) == ["aesi"]
    item = client.get(f"{API}/queue", headers=coord).json()["items"][0]
    assert item["clock_kind"] == "aesi" and item["sae_due_at"] == clocks["aesi"]["due_at"]


# --------------------------------------------------------------------------- #
# Packets
# --------------------------------------------------------------------------- #


def test_packet_create_is_idempotent_and_role_checked(client) -> None:
    done = _aesi_checkin(client)
    coord = login(client, "coordinator")
    inv = login(client, "investigator")
    admin = login(client, "admin")
    clock = _clocks(client, done["session_id"], coord)["aesi"]

    assert client.post(f"{API}/packets", json={"clock_id": clock["id"]}).status_code == 401
    assert (
        client.post(f"{API}/packets", json={"clock_id": "nope"}, headers=coord).status_code == 404
    )
    first = client.post(f"{API}/packets", json={"clock_id": clock["id"]}, headers=coord)
    assert first.status_code == 201, first.text
    again = client.post(f"{API}/packets", json={"clock_id": clock["id"]}, headers=inv)
    assert again.status_code == 200 and again.json()["id"] == first.json()["id"]
    assert (
        client.post(f"{API}/packets", json={"clock_id": clock["id"]}, headers=admin).json()["id"]
        == first.json()["id"]
    )
    assert len(_audit(client, coord, action="packet.created")) == 1
    # The clock row now links to its packet.
    assert _clocks(client, done["session_id"], coord)["aesi"]["packet_id"] == first.json()["id"]
    # Reads: every dashboard role; anonymous refused.
    pid = first.json()["id"]
    assert client.get(f"{API}/packets/{pid}").status_code == 401
    for headers in (coord, inv, admin):
        assert client.get(f"{API}/packets/{pid}", headers=headers).status_code == 200
    assert client.get(f"{API}/packets/missing", headers=coord).status_code == 404
    listed = client.get(f"{API}/packets?clock_id={clock['id']}", headers=coord).json()
    assert listed["total"] == 1 and listed["items"][0]["id"] == pid


def test_packet_fields_missing_info_narrative_and_evidence(client) -> None:
    done = _aesi_checkin(client)
    coord = login(client, "coordinator")
    clocks = _clocks(client, done["session_id"], coord)
    packet = client.post(
        f"{API}/packets", json={"clock_id": clocks["sae"]["id"]}, headers=coord
    ).json()
    fields = {f["name"]: f for f in packet["fields"]}
    assert packet["kind"] == "sae" and packet["status"] == "draft" and packet["sequence"] == 0
    assert packet["display_label"] == "P-003" and packet["due_at"] == clocks["sae"]["due_at"]
    assert fields["EVENT_TERM"]["value"] == "Diarrhea" and fields["AETOXGR"]["value"] == 3
    assert fields["EVENT_PLAIN"]["value"] == "Diarrhea or loose stools"
    assert fields["STUDY_DRUG"]["value"] == "cemiplimab"
    assert fields["AEOUT"]["value"] == "unknown"
    assert fields["AEREL"]["value"] == "not yet assessed by the investigator"
    assert fields["REPORTER_ROLE"]["value"] == "study coordinator"
    assert any("prednisone" in c and "discouraged" in c for c in fields["CONMEDS"]["value"])
    assert fields["SITE_AWARENESS_AT"]["value"] == clocks["sae"]["site_awareness_at"]
    for name in ("EVENT_TERM", "AETOXGR", "STUDY_DRUG", "CONMEDS", "SERIOUSNESS_CRITERIA"):
        assert fields[name]["evidence"], name
    assert all(f["plain_label"] for f in packet["fields"])
    missing = packet["missing_information"]
    assert "Date of the last dose of cemiplimab" in missing
    assert "Outcome of the event" in missing
    assert any(m.startswith("Medication record for prednisone") for m in missing)
    # Narrative: template writer, every sentence cites ids, every id resolves.
    narrative = packet["narrative"]
    assert narrative["writer"] == "template" and narrative["kind"] == "sae_narrative"
    assert narrative["sentences"] and all(s["evidence_ids"] for s in narrative["sentences"])
    assert "investigator to confirm" in narrative["text"]
    index = packet["evidence_index"]
    cited = _all_cited_ids(packet)
    assert cited <= set(index)
    assert all(index[i]["resolved"] for i in cited), [i for i in cited if not index[i]["resolved"]]
    # The stored fact bundle validates the stored narrative (what an LLM must also pass).
    with client.app.state.database.read_scope() as db:
        import json

        row = db.get(Packet, packet["id"])
        assert validate_written(json.loads(row.narrative_json), json.loads(row.facts_json)) == []


def test_patch_is_versioned_audited_and_role_checked(client) -> None:
    done = _aesi_checkin(client)
    coord = login(client, "coordinator")
    inv = login(client, "investigator")
    clock = _clocks(client, done["session_id"], coord)["aesi"]
    packet = client.post(f"{API}/packets", json={"clock_id": clock["id"]}, headers=coord).json()
    pid = packet["id"]
    url = f"{API}/packets/{pid}"

    assert client.patch(url, json={}, headers=coord).status_code == 422
    bad = client.patch(url, json={"fields": {"NOPE": 1}}, headers=coord)
    assert bad.status_code == 422
    assert (
        client.patch(url, json={"fields": {"AEREL": "related"}}, headers=coord).status_code == 403
    )
    assert (
        client.patch(url, json={"fields": {"LAST_DOSE_DATE": {"x": 1}}}, headers=coord).status_code
        == 422
    )

    edited = client.patch(
        url,
        json={"fields": {"LAST_DOSE_DATE": "2026-10-01"}, "note": "from the dosing log"},
        headers=coord,
    )
    assert edited.status_code == 200, edited.text
    body = edited.json()
    assert body["version"] == 2 and body["id"] == pid
    last_dose = next(f for f in body["fields"] if f["name"] == "LAST_DOSE_DATE")
    assert last_dose["value"] == "2026-10-01" and last_dose["edited"] is True
    edit_ev = last_dose["evidence"][-1]
    assert edit_ev["kind"] == "edit"
    assert body["evidence_index"][edit_ev["id"]]["audit_event"]["action"] == "packet.edited"
    assert not any("last dose" in m for m in body["missing_information"])
    # The narrative is rewritten and now cites the edit.
    dose_sentence = next(
        s for s in body["narrative"]["sentences"] if "last recorded dose" in s["text"]
    )
    assert edit_ev["id"] in dose_sentence["evidence_ids"]
    events = _audit(client, coord, action="packet.edited", entity_id=pid)
    assert events[0]["payload"]["diff"]["LAST_DOSE_DATE"] == {"before": None, "after": "2026-10-01"}
    assert body["versions"][-1]["audit_event_id"] == events[0]["id"]

    # Investigator-only field, and a person's narrative text kept beside the generated one.
    by_inv = client.patch(
        url,
        json={"fields": {"AEREL": "possibly related"}, "narrative_text": "Edited text."},
        headers=inv,
    )
    assert by_inv.status_code == 200, by_inv.text
    body = by_inv.json()
    assert body["version"] == 3
    assert body["narrative_edited"]["text"] == "Edited text."
    assert body["narrative_edited"]["edited_by"] == "investigator"
    assert any(
        "relationship" in s["text"] and "possibly related" in s["text"]
        for s in body["narrative"]["sentences"]
    )
    # An identical PATCH is a no-op (no new version).
    same = client.patch(url, json={"fields": {"AEREL": "possibly related"}}, headers=inv).json()
    assert same["version"] == 3


def test_sign_stops_clock_posts_mock_edc_and_freezes_packet(client) -> None:
    done = _aesi_checkin(client)
    coord = login(client, "coordinator")
    inv = login(client, "investigator")
    admin = login(client, "admin")
    clock = _clocks(client, done["session_id"], coord)["aesi"]
    pid = client.post(f"{API}/packets", json={"clock_id": clock["id"]}, headers=coord).json()["id"]

    for headers in (coord, admin):
        assert client.post(f"{API}/packets/{pid}/sign", json={}, headers=headers).status_code == 403
    signed = client.post(f"{API}/packets/{pid}/sign", json={"note": "ok"}, headers=inv)
    assert signed.status_code == 200, signed.text
    body = signed.json()
    assert body["status"] == "signed" and body["signed_by"] == "investigator"
    assert body["mock_edc_ack"]["ack_id"].startswith("EDC-AESI-")
    assert body["mock_edc_ack_id"] == body["mock_edc_ack"]["ack_id"]
    assert body["clock_decision"] == "reported (mock)" and body["clock_stopped_at"]
    row = _clocks(client, done["session_id"], coord)["aesi"]
    assert row["stopped_at"] and row["decision"] == "reported (mock)"
    assert row["stopped_by"] == "investigator"
    # The SAE clock of the same check-in is a separate question and keeps running.
    assert _clocks(client, done["session_id"], coord)["sae"]["stopped_at"] is None
    # Audit: packet.signed, mock_edc.posted (domain AESI), sae_clock.stopped via the packet.
    assert _audit(client, coord, action="packet.signed", entity_id=pid)
    posted = _audit(client, coord, action="mock_edc.posted")
    assert posted[0]["payload"]["domain"] == "AESI" and posted[0]["payload"]["packet_id"] == pid
    stops = _audit(client, coord, action="sae_clock.stopped", entity_id=clock["id"])
    assert stops[0]["payload"]["path"] == "packet.sign"
    # Signed packets are frozen.
    assert client.post(f"{API}/packets/{pid}/sign", json={}, headers=inv).status_code == 409
    frozen = client.patch(f"{API}/packets/{pid}", json={"narrative_text": "x"}, headers=coord)
    assert frozen.status_code == 409
    verify = client.get(f"{API}/audit/verify", headers=coord).json()
    assert verify["ok"] is True


def test_follow_up_diff_missing_info_and_signing(client) -> None:
    done = _aesi_checkin(client)
    coord = login(client, "coordinator")
    inv = login(client, "investigator")
    clock = _clocks(client, done["session_id"], coord)["aesi"]
    pid = client.post(f"{API}/packets", json={"clock_id": clock["id"]}, headers=coord).json()["id"]
    # Follow-up needs a signed packet.
    assert client.post(f"{API}/packets/{pid}/follow-up", headers=coord).status_code == 409
    client.patch(
        f"{API}/packets/{pid}", json={"fields": {"LAST_DOSE_DATE": "2026-10-01"}}, headers=coord
    )
    assert client.post(f"{API}/packets/{pid}/sign", json={}, headers=inv).status_code == 200

    # After signing, the investigator assesses the AE as immune-related and possibly related.
    detail = client.get(f"{API}/checkins/{done['session_id']}", headers=coord).json()
    ae = next(d for d in detail["drafts"] if d["fields"].get("AEDECOD") == "Diarrhea")
    att = client.patch(
        f"{API}/drafts/{ae['id']}/attribution",
        json={"AEREL": "possibly related", "INTERIM_IRAE": "Y"},
        headers=inv,
    )
    assert att.status_code == 200, att.text

    fu = client.post(f"{API}/packets/{pid}/follow-up", headers=coord)
    assert fu.status_code == 201, fu.text
    body = fu.json()
    assert body["sequence"] == 1 and body["parent_packet_id"] == pid and body["status"] == "draft"
    changes = {c["field"]: c for c in body["changes_since_previous"]}
    assert changes["AEREL"]["before"] == "not yet assessed by the investigator"
    assert changes["AEREL"]["after"] == "possibly related" and changes["AEREL"]["evidence"]
    assert changes["INTERIM_IRAE"]["after"] == "Y"
    # A person's value on the signed report is carried forward, not lost.
    fields = {f["name"]: f for f in body["fields"]}
    assert fields["LAST_DOSE_DATE"]["value"] == "2026-10-01" and "LAST_DOSE_DATE" not in changes
    # Missing information recomputed: causality and irAE are no longer missing.
    assert not any("relationship" in m for m in body["missing_information"])
    assert not any("immune-related" in m for m in body["missing_information"])
    assert "Outcome of the event" in body["missing_information"]
    assert set(_all_cited_ids(body)) <= set(body["evidence_index"])
    assert all(body["evidence_index"][i]["resolved"] for i in _all_cited_ids(body))
    created = _audit(client, coord, action="packet.created", entity_id=body["id"])
    assert created[0]["payload"]["sequence"] == 1
    # Asking again returns the pending follow-up; the parent lists it.
    again = client.post(f"{API}/packets/{pid}/follow-up", headers=coord)
    assert again.status_code == 200 and again.json()["id"] == body["id"]
    parent = client.get(f"{API}/packets/{pid}", headers=coord).json()
    assert parent["followup_packet_ids"] == [body["id"]]
    # Signing the follow-up: own audit action, mock EDC again, the clock stays as it was.
    signed = client.post(f"{API}/packets/{body['id']}/sign", json={}, headers=inv)
    assert signed.status_code == 200, signed.text
    assert _audit(client, coord, action="packet.followup_signed", entity_id=body["id"])
    assert len(_audit(client, coord, action="mock_edc.posted")) == 2
    assert signed.json()["clock_decision"] == "reported (mock)"
    # A new follow-up must start from the latest signed report.
    assert client.post(f"{API}/packets/{pid}/follow-up", headers=coord).status_code == 409
    nxt = client.post(f"{API}/packets/{body['id']}/follow-up", headers=coord)
    assert nxt.status_code == 201 and nxt.json()["sequence"] == 2


def test_export_json_and_printable_page(client) -> None:
    done = _aesi_checkin(client)
    coord = login(client, "coordinator")
    clock = _clocks(client, done["session_id"], coord)["sae"]
    packet = client.post(f"{API}/packets", json={"clock_id": clock["id"]}, headers=coord).json()
    pid = packet["id"]

    assert client.get(f"{API}/packets/{pid}/export.json").status_code == 401
    exported = client.get(f"{API}/packets/{pid}/export.json", headers=coord)
    assert exported.status_code == 200
    assert "attachment" in exported.headers["content-disposition"]
    data = exported.json()
    assert data["packet"]["id"] == pid and data["mock_edc_record"]["INTERIM_PACKET_ID"] == pid
    assert FOOTER in data["note"]

    page = client.get(f"{API}/packets/{pid}/print", headers=coord)
    assert page.status_code == 200 and page.headers["content-type"].startswith("text/html")
    html = page.text
    assert FOOTER in html
    assert "Written by template" in html
    assert "<script" not in html and "http://" not in html.replace("https://clinicaltrials.gov", "")
    assert "<style>" in html
    # Evidence ids are listed per field and per sentence.
    first_sentence = packet["narrative"]["sentences"][0]
    for ident in first_sentence["evidence_ids"]:
        assert ident in html
    event_term = next(f for f in packet["fields"] if f["name"] == "EVENT_TERM")
    assert event_term["evidence"][0]["id"] in html
    exports = _audit(client, coord, action="export.generated", entity_id=pid)
    assert {e["payload"]["kind"] for e in exports} == {"packet_json", "packet_print"}


# --------------------------------------------------------------------------- #
# R4.3 attribution: INTERIM_IRAE
# --------------------------------------------------------------------------- #


def test_irae_attribution_is_investigator_only_and_stops_the_aesi_clock(client) -> None:
    done = _aesi_checkin(client)
    coord = login(client, "coordinator")
    inv = login(client, "investigator")
    detail = client.get(f"{API}/checkins/{done['session_id']}", headers=coord).json()
    ae = next(d for d in detail["drafts"] if d["fields"].get("AEDECOD") == "Pruritus")
    url = f"{API}/drafts/{ae['id']}/attribution"
    assert client.patch(url, json={"INTERIM_IRAE": "N"}, headers=coord).status_code == 403
    assert client.patch(url, json={"INTERIM_IRAE": "maybe"}, headers=inv).status_code == 422
    res = client.patch(url, json={"INTERIM_IRAE": "N", "note": "drug rash ruled out"}, headers=inv)
    assert res.status_code == 200, res.text
    new = res.json()
    assert new["fields"]["INTERIM_IRAE"] == "N" and new["version"] == 2
    assert new["evidence"]["INTERIM_IRAE"][-1]["kind"] == "edit"
    clocks = _clocks(client, done["session_id"], coord)
    assert clocks["aesi"]["stopped_at"] and clocks["aesi"]["decision"].startswith(
        "INTERIM_IRAE = N"
    )
    assert clocks["sae"]["stopped_at"] is None
    # AESER stops the SAE clock only.
    res = client.patch(f"{API}/drafts/{new['id']}/attribution", json={"AESER": "Y"}, headers=inv)
    assert res.status_code == 200, res.text
    clocks = _clocks(client, done["session_id"], coord)
    assert clocks["sae"]["decision"] == "AESER = Y"
    # null clears the assessment (sent explicitly); an empty body is still refused.
    cleared = client.patch(
        f"{API}/drafts/{res.json()['id']}/attribution", json={"INTERIM_IRAE": None}, headers=inv
    )
    assert cleared.status_code == 200 and cleared.json()["fields"]["INTERIM_IRAE"] is None
    assert (
        client.patch(
            f"{API}/drafts/{cleared.json()['id']}/attribution", json={}, headers=inv
        ).status_code
        == 422
    )


# --------------------------------------------------------------------------- #
# Chart notes: protocol flags on CM drafts; an SAE packet quotes the note
# --------------------------------------------------------------------------- #

ER_NOTE = (
    "Seen in the ER overnight for severe diarrhea, 8 stools/day; admitted for IV fluids. "
    "Started prednisone 40 mg daily."
)


def test_chart_note_cm_flags_and_note_packet_quotes_the_note(client) -> None:
    add_participant(client, "P-005")
    coord = login(client, "coordinator")
    res = client.post(
        f"{API}/notes",
        json={
            "usubjid": "P-005",
            "note_date": "2026-10-09",
            "author": "ED physician (synthetic)",
            "note_type": "ed_visit",
            "text": ER_NOTE,
        },
        headers=coord,
    )
    assert res.status_code in (200, 201), res.text
    note = res.json()
    cm = next(d for d in note["drafts"] if d["domain"] == "CM")
    assert cm["fields"]["INTERIM_PROTOCOL_FLAG"] == "discouraged"
    assert {"CMDOSE", "CMINDC"} <= set(cm["fields"]["INTERIM_CM_MISSING_FIELDS"])
    assert cm["evidence"]["INTERIM_PROTOCOL_FLAG"][0]["id"] == "protocol.conmed_discouraged"
    assert any(r["rule_id"] == "protocol.conmed_discouraged" for r in note["rules_fired"])
    assert note["tier"] <= 2  # D-017: a note never reaches Tier 3
    clock = note["sae_clock"]
    assert clock is not None and clock["kind"] == "sae"

    packet = client.post(f"{API}/packets", json={"clock_id": clock["id"]}, headers=coord).json()
    assert packet["note_id"] == note["note"]["id"]
    quotes = [
        s for s in packet["narrative"]["sentences"] if '"' in s["text"] and "reads" in s["text"]
    ]
    assert quotes and all(note["note"]["id"] in s["evidence_ids"] for s in quotes)
    assert "chart note dated 2026-10-09" in packet["narrative"]["text"]
    cited = _all_cited_ids(packet)
    assert all(packet["evidence_index"][i]["resolved"] for i in cited)


def test_settings_public_reports_template_writer(client) -> None:
    body = client.get(f"{API}/settings/public").json()
    assert body["writer"] == "template" and body["llm_configured"] is False
    assert "anthropic_api_key" not in body
