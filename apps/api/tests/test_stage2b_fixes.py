"""Stage 2B review fixes (CONTRACTS R3.2 / R4.2 / R3.1).

* a CM record version that fills a protocol-required field drops it from
  ``INTERIM_CM_MISSING_FIELDS``, and the packet's missing information follows;
* the printed packet names the narrative that is (or was) reported, and the sign event
  records which one the investigator signed;
* clock starts and stops of every kind share the ``clock.started`` / ``clock.stopped``
  vocabulary (``sae_clock.*`` kept for the original contract's readers);
* ``GET /sae-clocks?active=all`` lists running and stopped clocks;
* the eval harness compares the R3.1 AESI / protocol expectations;
* ``INTERIM_RECORD_SOURCE`` has a plain-language label.
"""

from __future__ import annotations

from typing import Any

import pytest
from conftest import ZERO_RESPONSES, add_participant, login, make_settings, run_kiosk_checkin

from interim_api.audit import Actor
from interim_api.models import Draft
from interim_api.services.drafts import edit_draft
from interim_api.services.evaluation import compare
from interim_api.util import load_json

API = "/api/v1"
SIGN_ATTEST = {"narrative_reviewed": True, "missing_info_acknowledged": True}


@pytest.fixture
def settings(tmp_path):
    """No API key: the template writer only (no network)."""
    return make_settings(tmp_path, anthropic_api_key="", interim_writer="auto")


def _aesi_sae_checkin(client, label: str = "P-003") -> dict[str, Any]:
    add_participant(client, label)
    responses = {k: dict(v) for k, v in ZERO_RESPONSES.items()}
    responses.update(diarrhea={"frequency": 4}, itching={"severity": 3})
    return run_kiosk_checkin(
        client,
        label,
        responses=responses,
        gates={
            "hospitalization": True,
            "conmed_changed": True,
            "conmed_text": "prednisone",
            "conmed_direction": "started",
            "other_text": "",
        },
    )


def _clocks(client, session_id: str, headers: dict[str, str]) -> dict[str, dict[str, Any]]:
    detail = client.get(f"{API}/checkins/{session_id}", headers=headers).json()
    return {c["kind"]: c for c in detail["clocks"]}


def _audit(client, headers, **query: str) -> list[dict[str, Any]]:
    params = "&".join(f"{k}={v}" for k, v in query.items())
    return client.get(f"{API}/audit?{params}&limit=500", headers=headers).json()["items"]


# --------------------------------------------------------------------------- #
# CM missing fields are recomputed
# --------------------------------------------------------------------------- #


def test_filling_a_cm_field_updates_missing_fields_and_the_packet(client) -> None:
    done = _aesi_sae_checkin(client)
    coord = login(client, "coordinator")
    detail = client.get(f"{API}/checkins/{done['session_id']}", headers=coord).json()
    cm = next(d for d in detail["drafts"] if d["domain"] == "CM")
    assert "CMDOSE" in cm["fields"]["INTERIM_CM_MISSING_FIELDS"]

    with client.app.state.database.write_scope() as db:
        row = db.get(Draft, cm["id"])
        assert row is not None
        new = edit_draft(
            db,
            Actor(id="coordinator", role="coordinator"),
            row,
            changes={"CMDOSE": "10"},
            note="dose from the pharmacy record",
            allow_new_fields=("CMDOSE",),
        )
        fields = load_json(new.fields_json, {})
        evidence = load_json(new.evidence_json, {})
    assert "CMDOSE" not in fields["INTERIM_CM_MISSING_FIELDS"]
    assert {"CMDOSU", "CMDOSFRQ", "CMINDC"} <= set(fields["INTERIM_CM_MISSING_FIELDS"])
    assert evidence["INTERIM_CM_MISSING_FIELDS"][-1]["note"].startswith("recomputed")

    clock = _clocks(client, done["session_id"], coord)["sae"]
    packet = client.post(f"{API}/packets", json={"clock_id": clock["id"]}, headers=coord).json()
    line = next(
        m for m in packet["missing_information"] if m.startswith("Medication record for prednisone")
    )
    assert line == "Medication record for prednisone: dose unit, frequency, indication"


# --------------------------------------------------------------------------- #
# Printed narrative: which text is (was) reported
# --------------------------------------------------------------------------- #


def test_print_shows_the_signed_narrative_and_the_sign_event_records_it(client) -> None:
    done = _aesi_sae_checkin(client)
    coord = login(client, "coordinator")
    inv = login(client, "investigator")
    clock = _clocks(client, done["session_id"], coord)["sae"]
    pid = client.post(f"{API}/packets", json={"clock_id": clock["id"]}, headers=coord).json()["id"]

    # Unedited, unsigned: the generated draft, with its review line.
    page = client.get(f"{API}/packets/{pid}/print", headers=coord).text
    assert "Draft narrative" in page and "Written by template" in page
    assert "for investigator review and signature" in page

    text = "Participant P-003 reported severe diarrhea and itching; admitted overnight."
    r = client.patch(f"{API}/packets/{pid}", json={"narrative_text": text}, headers=coord)
    assert r.status_code == 200, r.text
    page = client.get(f"{API}/packets/{pid}/print", headers=coord).text
    assert text in page
    assert "Original template draft" in page and "not the reported text" in page
    assert "for investigator review and signature" not in page

    signed = client.post(f"{API}/packets/{pid}/sign", json=SIGN_ATTEST, headers=inv)
    assert signed.status_code == 200, signed.text
    page = client.get(f"{API}/packets/{pid}/print", headers=coord).text
    assert "Narrative (signed)" in page and "Draft narrative" not in page
    assert "the investigator signed and reported" in page
    event = _audit(client, coord, action="packet.signed", entity_id=pid)[0]
    assert event["payload"]["narrative_signed"] == "edited"
    assert len(event["payload"]["narrative_sha256"]) == 64
    exported = client.get(f"{API}/packets/{pid}/export.json", headers=coord).json()
    assert exported["mock_edc_record"]["narrative"] == text
    assert exported["mock_edc_record"]["narrative_source"] == "edited by a person"


def test_signed_unedited_print_drops_the_review_line(client) -> None:
    done = _aesi_sae_checkin(client)
    coord = login(client, "coordinator")
    inv = login(client, "investigator")
    clock = _clocks(client, done["session_id"], coord)["aesi"]
    pid = client.post(f"{API}/packets", json={"clock_id": clock["id"]}, headers=coord).json()["id"]
    assert (
        client.post(f"{API}/packets/{pid}/sign", json=SIGN_ATTEST, headers=inv).status_code == 200
    )
    page = client.get(f"{API}/packets/{pid}/print", headers=coord).text
    assert "Narrative (signed)" in page and "Written by template" in page
    assert "for investigator review and signature" not in page
    event = _audit(client, coord, action="packet.signed", entity_id=pid)[0]
    assert event["payload"]["narrative_signed"] == "generated"


# --------------------------------------------------------------------------- #
# Clock audit vocabulary and the clock list filter
# --------------------------------------------------------------------------- #


def test_clock_starts_and_stops_of_every_kind_share_one_vocabulary(client) -> None:
    done = _aesi_sae_checkin(client)
    coord = login(client, "coordinator")
    inv = login(client, "investigator")
    clocks = _clocks(client, done["session_id"], coord)
    started = _audit(client, coord, action="clock.started")
    assert sorted(e["payload"]["kind"] for e in started) == ["aesi", "sae"]

    pid = client.post(
        f"{API}/packets", json={"clock_id": clocks["aesi"]["id"]}, headers=coord
    ).json()["id"]
    assert (
        client.post(f"{API}/packets/{pid}/sign", json=SIGN_ATTEST, headers=inv).status_code == 200
    )
    r = client.patch(
        f"{API}/sae-clocks/{clocks['sae']['id']}/stop",
        json={"decision": "not serious", "note": "ER visit unrelated"},
        headers=inv,
    )
    assert r.status_code == 200, r.text

    stopped = _audit(client, coord, action="clock.stopped")
    assert sorted(e["payload"]["kind"] for e in stopped) == ["aesi", "sae"]
    legacy = _audit(client, coord, action="sae_clock.stopped")
    assert sorted(e["payload"]["kind"] for e in legacy) == ["aesi", "sae"]
    assert client.get(f"{API}/audit/verify", headers=coord).json()["ok"] is True


def test_sae_clocks_active_all_lists_running_and_stopped(client) -> None:
    done = _aesi_sae_checkin(client)
    coord = login(client, "coordinator")
    inv = login(client, "investigator")
    clocks = _clocks(client, done["session_id"], coord)
    r = client.patch(
        f"{API}/sae-clocks/{clocks['sae']['id']}/stop",
        json={"decision": "not serious"},
        headers=inv,
    )
    assert r.status_code == 200, r.text

    def ids(active: str) -> set[str]:
        body = client.get(f"{API}/sae-clocks?active={active}", headers=coord).json()
        return {c["id"] for c in body["items"]}

    assert ids("true") == {clocks["aesi"]["id"]}
    assert ids("false") == {clocks["sae"]["id"]}
    assert ids("all") == {clocks["aesi"]["id"], clocks["sae"]["id"]}
    bad = client.get(f"{API}/sae-clocks?active=maybe", headers=coord)
    assert bad.status_code == 422


# --------------------------------------------------------------------------- #
# Eval: R3.1 expectations are compared, not just noted
# --------------------------------------------------------------------------- #


def _result(aesi: bool, items: list[str], floor: int, stamp: str) -> dict[str, Any]:
    return {
        "items": [],
        "drafts": [],
        "rules_fired": [],
        "stop_screen": False,
        "page_oncall": False,
        "escalation_tier": 0,
        "protocol": {"aesi_suspected": aesi, "aesi_items": items},
        "aesi_clock": (
            {"kind": "aesi", "site_awareness_at": stamp, "due_at": "2026-10-11T08:00:00.000Z"}
            if aesi
            else None
        ),
        "protocol_tier_floor": floor,
    }


def test_eval_compare_checks_aesi_and_protocol_floor(client) -> None:
    stamp = "2026-10-10T08:00:00.000Z"
    expected = {
        "aesi_suspected": True,
        "aesi_clock_started": True,
        "aesi_items": ["itching", "rash"],
        "protocol_tier_floor": 0,
    }
    with client.app.state.database.read_scope() as db:
        good = _result(True, ["rash", "itching"], 0, stamp)
        _, mismatches, notices = compare(db, good, expected, usubjid="X", completed_at=stamp)
        assert mismatches == [] and notices == []

        bad = _result(False, [], 2, stamp)
        _, mismatches, _ = compare(db, bad, expected, usubjid="X", completed_at=stamp)
    keys = {m.split(":")[0] for m in mismatches}
    assert {"aesi_suspected", "aesi_clock_started", "aesi_items", "protocol_tier_floor"} <= keys


def test_record_source_has_a_plain_label(client) -> None:
    done = _aesi_sae_checkin(client)
    coord = login(client, "coordinator")
    detail = client.get(f"{API}/checkins/{done['session_id']}", headers=coord).json()
    assert detail["labels"]["INTERIM_RECORD_SOURCE"] != "INTERIM_RECORD_SOURCE"
