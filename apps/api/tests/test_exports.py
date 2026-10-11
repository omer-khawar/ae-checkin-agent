"""Exports: CSV column order, JSON, per-sample VS, the bundle manifest, and the mock EDC."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import zipfile

from conftest import add_participant, login, run_kiosk_checkin

from interim_api.services.exports import validate_edc_records


def _confirm_all(client, session_id: str, headers: dict[str, str]) -> list[dict]:
    detail = client.get(f"/api/v1/checkins/{session_id}", headers=headers).json()
    for d in detail["drafts"]:
        assert (
            client.post(f"/api/v1/drafts/{d['id']}/confirm", json={}, headers=headers).status_code
            == 200
        )
    return detail["drafts"]


def test_csv_and_json_exports_follow_sdtm_column_order(client) -> None:
    add_participant(client, "P-007")
    done = run_kiosk_checkin(client, "P-007")
    coord = login(client, "coordinator")
    # Nothing confirmed yet: confirmed exports are empty, ?status=all has rows.
    empty = client.get("/api/v1/export/AE.csv", headers=coord)
    assert empty.status_code == 200 and empty.text.strip() == ""
    _confirm_all(client, done["session_id"], coord)

    res = client.get("/api/v1/export/AE.csv", headers=coord)
    assert res.status_code == 200 and res.headers["content-type"].startswith("text/csv")
    assert res.headers["x-interim-sha256"] == hashlib.sha256(res.content).hexdigest()
    rows = list(csv.reader(io.StringIO(res.text)))
    header = rows[0]
    assert header[:2] == ["STUDYID", "USUBJID"]
    domain_vars = [c for c in header if not c.startswith("INTERIM_")]
    assert domain_vars == [
        "STUDYID",
        "USUBJID",
        "AESEQ",
        "AETERM",
        "AEDECOD",
        "AESTDTC",
        "AEENDTC",
        "AEONGO",
        "AETOXGR",
        "AESER",
        "AEREL",
        "AEACN",
        "AEOUT",
    ]
    interim = [c for c in header if c.startswith("INTERIM_")]
    assert header == domain_vars + interim  # every INTERIM_* column comes last
    assert {
        "INTERIM_NCT_ID",
        "INTERIM_TIER",
        "INTERIM_RULES_FIRED",
        "INTERIM_RECORD_SOURCE",
        "INTERIM_DRAFT_ID",
    } <= set(interim)
    assert len(rows) == 3  # header + Dyspnea + Cough
    record = dict(zip(header, rows[1], strict=True))
    assert (
        record["AEDECOD"] == "Dyspnea"
        and record["AETOXGR"] == "2"
        and record["INTERIM_PROVISIONAL"] == "true"
    )
    assert ";" in record["INTERIM_RULES_FIRED"] or record["INTERIM_RULES_FIRED"]

    vs = client.get("/api/v1/export/VS.json", headers=coord).json()
    assert vs["domain"] == "VS" and vs["status_filter"] == "confirmed" and vs["n_records"] == 2
    assert all(
        r["VSMETHOD"] == "Simulated" and r["INTERIM_SOURCE"] == "mock" for r in vs["records"]
    )
    assert all(r["INTERIM_IS_MEASURED"] is False for r in vs["records"])

    per_sample = client.get("/api/v1/export/VS.csv?per_sample=true", headers=coord)
    rows = list(csv.reader(io.StringIO(per_sample.text)))
    assert rows[0][:3] == ["STUDYID", "USUBJID", "VSTESTCD"]
    assert len(rows) == 3  # one sample with pulse + breathing -> two long-format rows
    assert {r[rows[0].index("VSTESTCD")] for r in rows[1:]} == {"PULSE", "RESP"}
    assert all(r[rows[0].index("VSMETHOD")] == "Simulated" for r in rows[1:])

    events = client.get("/api/v1/audit?action=export.generated", headers=coord).json()
    assert events["total"] == 4
    assert client.get("/api/v1/export/XX.csv", headers=coord).status_code == 404
    assert client.get("/api/v1/export/AE.xml", headers=coord).status_code == 404


def test_bundle_manifest_hashes_match_the_files(client) -> None:
    add_participant(client, "P-007")
    done = run_kiosk_checkin(client, "P-007")
    coord = login(client, "coordinator")
    _confirm_all(client, done["session_id"], coord)
    res = client.get("/api/v1/export/bundle.zip", headers=coord)
    assert res.status_code == 200 and res.headers["content-type"] == "application/zip"
    zf = zipfile.ZipFile(io.BytesIO(res.content))
    names = set(zf.namelist())
    assert names == {
        "AE.csv",
        "AE.json",
        "VS.csv",
        "VS.json",
        "VS_samples.csv",
        "CM.csv",
        "CM.json",
        "audit_excerpt.json",
        "manifest.json",
    }
    manifest = json.loads(zf.read("manifest.json"))
    assert manifest["study_id"] == "R2810-ONC-1624" and manifest["interim_version"] == "0.1.0"
    assert manifest["record_counts"] == {"AE": 2, "VS": 2, "CM": 1, "VS_samples": 2}
    for entry in manifest["files"]:
        data = zf.read(entry["name"])
        assert hashlib.sha256(data).hexdigest() == entry["sha256"], entry["name"]
        assert len(data) == entry["bytes"]
    excerpt = json.loads(zf.read("audit_excerpt.json"))
    assert excerpt["verify"]["ok"] is True
    assert (
        manifest["audit_head_hash"]
        == excerpt["head"]["hash"]
        == res.headers["x-interim-audit-head"]
    )
    assert any(e["action"] == "draft.confirmed" for e in excerpt["events"])
    # The bundle itself is an audit event written after the head captured in the manifest.
    verify = client.get("/api/v1/audit/verify", headers=coord).json()
    assert verify["ok"] and verify["head_hash"] != manifest["audit_head_hash"]


def test_eval_run_never_leaks_into_exports_or_the_bundle(client) -> None:
    """Demo step 6 (judge runs the eval) then step 7 (export): eval-harness rows, including the
    chart-note drafts that have no session, stay out unless ``include_eval=true``."""
    add_participant(client, "P-007")
    done = run_kiosk_checkin(client, "P-007")
    coord = login(client, "coordinator")
    _confirm_all(client, done["session_id"], coord)
    before = {
        d: client.get(f"/api/v1/export/{d}.json?status=all", headers=coord).json()["n_records"]
        for d in ("AE", "VS", "CM")
    }
    assert before == {"AE": 2, "VS": 2, "CM": 1}
    res = client.post(
        "/api/v1/eval/run", json={"persona_ids": ["T1-dyspnea-moderate"]}, headers=coord
    )
    assert res.status_code == 200 and res.json()["chartscan"]["via_api"]["n_notes"] == 8
    for domain, n in before.items():
        for status in ("all", "confirmed"):  # everything of P-007 was confirmed above
            doc = client.get(f"/api/v1/export/{domain}.json?status={status}", headers=coord).json()
            assert doc["n_records"] == n, (domain, status)
            assert all(r["USUBJID"] == "R2810-ONC-1624-P-007" for r in doc["records"])
    csv_rows = client.get("/api/v1/export/AE.csv?status=all", headers=coord).text
    assert "EVAL" not in csv_rows
    bundle = client.get("/api/v1/export/bundle.zip?status=all", headers=coord)
    manifest = json.loads(zipfile.ZipFile(io.BytesIO(bundle.content)).read("manifest.json"))
    assert manifest["record_counts"] == {"AE": 2, "VS": 2, "CM": 1, "VS_samples": 2}
    # Asked for explicitly, the eval rows are there (14 note AEs + the persona's 2).
    with_eval = client.get(
        "/api/v1/export/AE.json?status=all&include_eval=true", headers=coord
    ).json()
    assert with_eval["n_records"] == 2 + 2 + 14
    assert sum(1 for r in with_eval["records"] if "EVAL-NOTE" in r["USUBJID"]) == 14


def test_mock_edc_acknowledges_valid_records_and_rejects_bad_columns(client) -> None:
    add_participant(client, "P-007")
    done = run_kiosk_checkin(client, "P-007")
    coord = login(client, "coordinator")
    _confirm_all(client, done["session_id"], coord)
    records = client.get("/api/v1/export/AE.json", headers=coord).json()["records"]
    ack = client.post("/api/v1/mock-edc/AE", json={"records": records}, headers=coord)
    assert ack.status_code == 200, ack.text
    body = ack.json()
    assert body["ack_id"].startswith("EDC-AE-") and body["received"] == 2 and body["domain"] == "AE"
    event = client.get("/api/v1/audit?action=mock_edc.posted", headers=coord).json()["items"][0]
    assert event["entity_id"] == body["ack_id"] and event["payload"]["received"] == 2
    bad = client.post(
        "/api/v1/mock-edc/AE",
        json={"records": [{**records[0], "FOO": 1}, {"STUDYID": "X"}]},
        headers=coord,
    )
    assert bad.status_code == 422
    problem = bad.json()
    assert problem["title"] == "Records rejected by mock EDC"
    assert any("FOO" in e for e in problem["errors"]) and any(
        "missing required" in e for e in problem["errors"]
    )
    assert (
        client.post("/api/v1/mock-edc/ZZ", json={"records": records}, headers=coord).status_code
        == 404
    )
    # VS rows need VSORRES unless NOT DONE.
    assert (
        validate_edc_records(
            "VS", [{"STUDYID": "S", "USUBJID": "U", "VSTESTCD": "PULSE", "VSSTAT": "NOT DONE"}]
        )
        == []
    )
    assert validate_edc_records("VS", [{"STUDYID": "S", "USUBJID": "U", "VSTESTCD": "PULSE"}]) != []
