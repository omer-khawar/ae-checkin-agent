"""Sponsor-side edit checks and drafted query answers (CONTRACTS.md R4.4).

Every check in ``edit_checks.json`` must fire on a record that breaks it and stay silent on
one that does not; every candidate must carry evidence (the check itself plus the record's
own pointers); runs must be deterministic; and a suggested answer may cite only evidence ids
present in the facts it was written from.
"""

from __future__ import annotations

import copy
import json
import re
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, cast

import pytest

from interim_rules import narrative, queries, tables
from interim_rules.models import DraftField, DraftRecord, Evidence
from interim_rules.queries import QueryCandidate, QueryContext
from interim_rules.tables import TableError

REPO_ROOT = Path(__file__).resolve().parents[3]
EXCERPT_PATH = REPO_ROOT / "data" / "public" / "empower_lung1_protocol_excerpt.json"

R44_CHECKS = {
    "query.ae_serious_no_signed_report",
    "query.ae_irae_assessment_needs_detail",
    "query.ae_end_before_start",
    "query.cm_required_fields_missing",
    "query.cm_protocol_flag_no_note",
    "query.vs_value_implausible",
    "query.ae_resolved_without_end_date",
}
"""The checks CONTRACTS.md R4.4 says must ship."""


# --------------------------------------------------------------------------- #
# Record builders (the API's draft_to_dict shape)
# --------------------------------------------------------------------------- #


def _ev(kind: str, ident: str, note: str, ts: str | None = None) -> dict[str, object]:
    return {"kind": kind, "id": ident, "ts": ts, "note": note}


def ae(**overrides: object) -> dict[str, Any]:
    """A clean AE record that passes every check."""
    fields: dict[str, object] = {
        "STUDYID": "R2810-ONC-1624",
        "USUBJID": "R2810-ONC-1624-P-007",
        "AESEQ": 1,
        "AETERM": "skin rash",
        "AEDECOD": "Rash maculo-papular",
        "AESTDTC": "2026-10-08",
        "AEENDTC": None,
        "AEONGO": "Y",
        "AETOXGR": 3,
        "AESER": None,
        "AEREL": None,
        "AEOUT": None,
        "INTERIM_IRAE": None,
    }
    record: dict[str, Any] = {
        "id": "draft-ae-1",
        "lineage_id": "lineage-ae-1",
        "ae_open_id": "aeopen-1",
        "domain": "AE",
        "status": "confirmed",
        "usubjid": "R2810-ONC-1624-P-007",
        "fields": fields,
        "evidence": {
            "AETERM": [
                _ev(
                    "pro_response",
                    "ans-rash-presence",
                    "rash.presence = 1 (Yes)",
                    "2026-10-08T13:00:00Z",
                )
            ],
            "AETOXGR": [
                _ev("rule", "grade.composite_to_grade", "provisional, investigator to confirm"),
                _ev(
                    "pro_response",
                    "ans-rash-severity",
                    "rash.severity = 3 (Severe)",
                    "2026-10-08T13:00:05Z",
                ),
            ],
            "AESTDTC": [
                _ev(
                    "pro_response",
                    "ans-rash-presence",
                    "rash.presence = 1 (Yes)",
                    "2026-10-08T13:00:00Z",
                )
            ],
        },
    }
    for key, value in overrides.items():
        fields[key] = value
    return record


def cm(**overrides: object) -> dict[str, Any]:
    """A clean CM record that passes every check."""
    fields: dict[str, object] = {
        "USUBJID": "R2810-ONC-1624-P-003",
        "CMSEQ": 1,
        "CMTRT": "loratadine",
        "CMDECOD": "loratadine",
        "CMDOSE": 10,
        "CMDOSU": "mg",
        "CMDOSFRQ": "QD",
        "CMINDC": "itching",
        "CMSTDTC": "2026-10-07",
        "CMENDTC": None,
        "INTERIM_DIRECTION": "started",
        "INTERIM_PROTOCOL_FLAG": None,
    }
    record: dict[str, Any] = {
        "id": "draft-cm-1",
        "domain": "CM",
        "status": "confirmed",
        "fields": fields,
        "evidence": {
            "CMTRT": [_ev("gate_answer", "gate-conmed-1", "conmed_text = 'loratadine'")],
            "INTERIM_PROTOCOL_FLAG": [
                _ev("rule", "protocol.conmed_discouraged", "systemic corticosteroid")
            ],
        },
    }
    fields.update(overrides)
    return record


def vs(testcd: str = "PULSE", value: object = "72", unit: str = "beats/min") -> dict[str, Any]:
    return {
        "id": f"draft-vs-{testcd}",
        "domain": "VS",
        "status": "draft",
        "fields": {
            "USUBJID": "R2810-ONC-1624-P-001",
            "VSSEQ": 1,
            "VSTESTCD": testcd,
            "VSORRES": value,
            "VSORRESU": unit,
        },
        "evidence": {
            "VSORRES": [
                _ev("vitals_sample", "vs-sample-9", "pulse 72 (conf 0.91)", "2026-10-09T08:00:00Z")
            ]
        },
    }


def fired(records: Sequence[Mapping[str, object]], ctx: object = None) -> set[str]:
    return {
        c.check_id
        for c in queries.run_edit_checks(
            records, cast(QueryContext | Mapping[str, object] | None, ctx)
        )
    }


def only(
    records: Sequence[Mapping[str, object]], check_id: str, ctx: object = None
) -> QueryCandidate:
    found = [
        c
        for c in queries.run_edit_checks(
            records, cast(QueryContext | Mapping[str, object] | None, ctx)
        )
        if c.check_id == check_id
    ]
    assert len(found) == 1, f"expected exactly one {check_id}, got {found}"
    return found[0]


def _irae_available() -> None:
    try:
        tables.irae_mapping()
    except TableError as exc:  # pragma: no cover - only while irae_mapping.json is missing
        pytest.skip(f"irae_mapping.json not available yet: {exc}")


# --------------------------------------------------------------------------- #
# Table
# --------------------------------------------------------------------------- #


def test_table_ships_every_r44_check_with_provenance() -> None:
    checks = queries.edit_checks()
    assert R44_CHECKS <= set(queries.check_ids())
    for check in checks:
        assert check.id.startswith("query.")
        assert check.domain in queries.DOMAINS
        assert check.severity in queries.SEVERITIES
        assert check.source.strip() and check.rationale.strip()
    by_id = {c.id: c for c in checks}
    for check_id, page in (
        ("query.ae_serious_no_signed_report", 91),
        ("query.ae_irae_assessment_needs_detail", 91),
        ("query.cm_required_fields_missing", 69),
        ("query.cm_protocol_flag_no_note", 69),
    ):
        ref = by_id[check_id].protocol_ref
        assert ref is not None and ref.printed_page == page


def test_protocol_quotes_are_verbatim_in_the_excerpt() -> None:
    if not EXCERPT_PATH.is_file():  # pragma: no cover - only in a wheel install
        pytest.skip("protocol excerpt not present (installed package without the repository)")
    excerpt = json.loads(EXCERPT_PATH.read_text(encoding="utf-8"))
    pages: dict[int, str] = {}
    for section in excerpt["sections"].values():
        for page in section:
            pages[int(page["printed_page"])] = " ".join(str(page["text"]).split())
    quoted = [c for c in queries.edit_checks() if c.quote is not None]
    assert len(quoted) >= 3
    for check in quoted:
        assert check.protocol_ref is not None and check.quote is not None
        assert " ".join(check.quote.split()) in pages[check.protocol_ref.printed_page], check.id


def test_cm_required_fields_come_from_protocol_rules() -> None:
    record = cm(CMDOSE=None, CMDOSU=None, CMDOSFRQ=None, CMINDC=None, CMTRT=None, CMSTDTC=None)
    record["fields"]["INTERIM_DIRECTION"] = None
    cand = only([record], "query.cm_required_fields_missing")
    assert set(cand.fields) == set(tables.protocol_rules().cm_required_fields)


def test_vs_bounds_come_from_the_vitals_table() -> None:
    bounds = tables.vitals_config().plausibility["pulse"]
    assert "query.vs_value_implausible" not in fired([vs(value=bounds.max)])
    assert "query.vs_value_implausible" in fired([vs(value=bounds.max + 1)])
    assert "query.vs_value_implausible" not in fired([vs(value=bounds.min)])
    assert "query.vs_value_implausible" in fired([vs(value=bounds.min - 1)])


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda t: t["checks"][0]["condition"].update(op="no_such_op"), "unknown operation"),
        (lambda t: t["checks"][0].update(query_text="Bad {nonsense}"), "unknown slot"),
        (lambda t: t["checks"][1].update(id=t["checks"][0]["id"]), "duplicate id"),
        (lambda t: t["checks"][0].update(id="ae_serious"), "query.snake_case"),
        (lambda t: t["checks"][0].update(severity="urgent"), "severity"),
        (lambda t: t["checks"][0]["condition"].update(colour="red"), "unknown parameter"),
        (lambda t: t["checks"][0].update(answer_close="About {AETERM}"), "not allowed"),
        (lambda t: t["value_labels"].update(aeser={"Y": "yes"}), "SDTM-style field name"),
        (lambda t: t["value_labels"]["AESER"].update(y="yes again"), "listed twice"),
        (lambda t: t["value_labels"]["AESER"].update(Y="  "), "non-empty text"),
    ],
)
def test_malformed_tables_fail_loudly(mutate: Any, message: str) -> None:
    table = copy.deepcopy(tables.load_table("edit_checks"))
    mutate(table)
    with pytest.raises(TableError, match=message):
        queries.parse_edit_checks(table)


# --------------------------------------------------------------------------- #
# Each check fires, and does not fire
# --------------------------------------------------------------------------- #


def test_clean_records_raise_nothing() -> None:
    assert queries.run_edit_checks([ae(), cm(), vs(), vs("RESP", "14", "breaths/min")]) == []


def test_serious_without_signed_report() -> None:
    check = "query.ae_serious_no_signed_report"
    assert check in fired([ae(AESER="Y")])
    assert check in fired([ae(AESER="y")])
    assert check not in fired([ae(AESER="N")])
    assert check not in fired([ae(AESER=None)])
    for key in ("draft-ae-1", "lineage-ae-1", "aeopen-1"):
        assert check not in fired(
            [ae(AESER="Y")], QueryContext(signed_packet_keys=frozenset({key}))
        )
    assert check not in fired([ae(AESER="Y")], {"signed_packet_keys": ["lineage-ae-1"]})
    assert check in fired([ae(AESER="Y")], {"signed_packet_keys": ["some-other-draft"]})
    cand = only([ae(AESER="Y")], check)
    assert cand.severity == "safety" and cand.field == "AESER"


def test_immune_related_marked_not_immune_related() -> None:
    _irae_available()
    check = "query.ae_irae_assessment_needs_detail"
    cand = only([ae(INTERIM_IRAE="N")], check)
    assert cand.field == "INTERIM_IRAE"
    assert "investigator to confirm" in cand.text and "dermatologic" in cand.text
    assert any(e.kind == "table" and e.id == "irae_mapping.json" for e in cand.evidence)
    assert check not in fired([ae(INTERIM_IRAE="Y")])
    assert check not in fired([ae(INTERIM_IRAE=None)])
    assert check not in fired([ae(INTERIM_IRAE="N", AETOXGR=2)])
    assert check in fired([ae(INTERIM_IRAE="N", AETOXGR="3")])
    # Cough is not potentially immune-related in irae_mapping.json.
    assert check not in fired([ae(INTERIM_IRAE="N", AEDECOD="Cough", AETERM="cough")])
    # A chart-note term outside the ten kiosk items, listed in additional_terms.
    colitis = only([ae(INTERIM_IRAE="N", AEDECOD="Colitis", AETERM="colitis")], check)
    assert any(e.id == "edit_checks.json" for e in colitis.evidence)
    assert check not in fired([ae(INTERIM_IRAE="N", AEDECOD="Headache", AETERM="headache")])


def test_end_date_before_start_date() -> None:
    check = "query.ae_end_before_start"
    cand = only([ae(AEENDTC="2026-10-01")], check)
    assert "2026-10-01" in cand.text and "2026-10-08" in cand.text
    assert check not in fired([ae(AEENDTC="2026-10-08")])
    assert check not in fired([ae(AEENDTC="2026-10-09")])
    # Same day with times: compared as instants.
    assert check in fired([ae(AESTDTC="2026-10-08T14:00:00Z", AEENDTC="2026-10-08T09:00:00Z")])
    assert check not in fired(
        [ae(AESTDTC="2026-10-08T14:00:00Z", AEENDTC="2026-10-08T15:00:00+00:00")]
    )
    # One side date-only: compared as calendar dates, so the same day never fires.
    assert check not in fired([ae(AESTDTC="2026-10-08T14:00:00Z", AEENDTC="2026-10-08")])
    # Partial or unparseable dates never fire (nothing to compare).
    assert check not in fired([ae(AEENDTC="2026-09")])
    assert check not in fired([ae(AEENDTC="soon")])


def test_cm_required_fields_missing() -> None:
    check = "query.cm_required_fields_missing"
    kiosk = cm(CMDOSE=None, CMDOSU=None, CMDOSFRQ=None, CMINDC=None)
    cand = only([kiosk], check)
    assert cand.field == "CMDOSE"
    assert cand.fields[:4] == ("CMDOSE", "CMDOSU", "CMDOSFRQ", "CMINDC")
    assert "dose, dose unit, frequency and indication" in cand.text
    assert any(e.id == "protocol_rules.json" for e in cand.evidence)
    # Started and still taken: no stop date is needed ("as appropriate").
    assert check not in fired([cm()])
    # Only the indication missing: the query is raised on that field.
    assert only([cm(CMINDC="  ")], check).field == "CMINDC"
    # Stopped: the stop date is required.
    stopped = cm(INTERIM_DIRECTION="stopped", CMENDTC=None)
    assert only([stopped], check).field == "CMENDTC"
    assert check not in fired([cm(INTERIM_DIRECTION="stopped", CMENDTC="2026-10-09")])
    # Chart-note "taking" is ongoing too.
    assert check not in fired([cm(INTERIM_DIRECTION="taking")])


def test_cm_protocol_flag_without_investigator_note() -> None:
    check = "query.cm_protocol_flag_no_note"
    cand = only([cm(INTERIM_PROTOCOL_FLAG="discouraged", CMTRT="prednisone")], check)
    assert cand.severity == "safety" and "discouraged" in cand.text
    assert check in fired([cm(INTERIM_PROTOCOL_FLAG="prohibited")])
    assert check not in fired([cm(INTERIM_PROTOCOL_FLAG="permitted")])
    assert check not in fired([cm(INTERIM_PROTOCOL_FLAG=None)])
    noted = cm(INTERIM_PROTOCOL_FLAG="discouraged", INTERIM_INVESTIGATOR_NOTE="Given for irAE")
    assert check not in fired([noted])
    assert check not in fired(
        [cm(INTERIM_PROTOCOL_FLAG="discouraged")], {"noted_record_keys": ["draft-cm-1"]}
    )


def test_vs_value_outside_plausibility() -> None:
    check = "query.vs_value_implausible"
    cand = only([vs(value="190")], check)
    assert "190" in cand.text and "35 to 180" in cand.text and "beats/min" in cand.text
    assert any(e.id == "vitals_corroboration.json" for e in cand.evidence)
    assert check in fired([vs("RESP", 50, "breaths/min")])
    assert check in fired([vs("RESP", 3.5, "breaths/min")])
    assert check not in fired([vs("RESP", 14, "breaths/min")])
    # HRV rows have no plausibility bounds; non-numbers and NOT DONE rows never fire.
    assert check not in fired([vs("HRV_RMSSD", 900, "ms")])
    assert check not in fired([vs(value=None)])
    assert check not in fired([vs(value="n/a")])


def test_resolved_outcome_without_end_date() -> None:
    check = "query.ae_resolved_without_end_date"
    cand = only([ae(AEOUT="RECOVERED/RESOLVED")], check)
    assert cand.field == "AEENDTC"
    assert check in fired([ae(AEOUT="recovered/resolved with sequelae")])
    assert check not in fired([ae(AEOUT="RECOVERED/RESOLVED", AEENDTC="2026-10-10")])
    assert check not in fired([ae(AEOUT="NOT RECOVERED/NOT RESOLVED")])
    assert check not in fired([ae(AEOUT=None)])


# --------------------------------------------------------------------------- #
# Record handling, determinism, evidence
# --------------------------------------------------------------------------- #


def _messy_batch() -> list[dict[str, Any]]:
    second = ae(AESER="Y", AEENDTC="2026-10-01", INTERIM_IRAE="N")
    second["id"] = "draft-ae-2"
    second["lineage_id"] = "lineage-ae-2"
    second["ae_open_id"] = "aeopen-2"
    return [
        ae(AESER="Y", AEOUT="RECOVERED/RESOLVED"),
        second,
        cm(CMDOSE=None, INTERIM_PROTOCOL_FLAG="discouraged"),
        vs(value="12"),
        vs("RESP", 60, "breaths/min"),
    ]


def test_rejected_records_and_other_domains_are_skipped() -> None:
    rejected = ae(AESER="Y")
    rejected["status"] = "rejected"
    assert queries.run_edit_checks([rejected]) == []


def test_flat_records_and_draft_records_are_accepted() -> None:
    flat = {"DOMAIN": "AE", **ae(AESER="Y")["fields"]}
    cand = only([flat], "query.ae_serious_no_signed_report")
    assert cand.record_key == "AE:R2810-ONC-1624-P-007:1"
    draft = DraftRecord(
        domain="VS",
        fields=(
            DraftField("USUBJID", "S-1", ()),
            DraftField("VSSEQ", 2, ()),
            DraftField("VSTESTCD", "PULSE", ()),
            DraftField(
                "VSORRES",
                20,
                (Evidence("vitals_sample", "s-1", "2026-10-09T08:00:00Z", "pulse 20"),),
            ),
        ),
        linked_ae_open_id=None,
        is_followup=False,
    )
    vs_cand = only([cast(Mapping[str, object], draft)], "query.vs_value_implausible")
    assert vs_cand.record_key == "VS:S-1:2"
    assert any(e.id == "s-1" and e.kind == "vitals_sample" for e in vs_cand.evidence)


def test_malformed_records_raise() -> None:
    with pytest.raises(ValueError, match="no domain"):
        queries.run_edit_checks([{"fields": {"AESER": "Y"}}])
    bad = ae()
    bad["evidence"]["AETERM"] = [{"kind": "pro_response"}]
    with pytest.raises(ValueError, match="kind' and 'id'"):
        queries.run_edit_checks([bad])


def test_runs_are_deterministic() -> None:
    batch = _messy_batch()
    first = [c.to_dict() for c in queries.run_edit_checks(batch)]
    second = [c.to_dict() for c in queries.run_edit_checks(copy.deepcopy(batch))]
    assert first == second
    reversed_keys = {c.key for c in queries.run_edit_checks(list(reversed(batch)))}
    assert reversed_keys == {str(c["key"]) for c in first}
    assert len(first) == len({str(c["key"]) for c in first})


def test_query_key_is_stable_across_versions_and_partial_fixes() -> None:
    """One query per record lineage per check (CONTRACTS R4.4), however the record changes."""
    check = "query.ae_serious_no_signed_report"
    v1 = ae(AESER="Y")
    v2 = ae(AESER="Y", AETOXGR=2)
    v2["id"] = "draft-ae-1-v2"
    c1, c2 = only([v1], check), only([v2], check)
    assert c1.record_key == "draft-ae-1" and c2.record_key == "draft-ae-1-v2"
    assert c1.key == c2.key == f"{check}|lineage-ae-1|AESER"
    assert c1.to_dict()["lineage_key"] == "lineage-ae-1"
    # Both versions in one batch: one query, raised on the first version given.
    both = [c for c in queries.run_edit_checks([v2, v1]) if c.check_id == check]
    assert [c.record_key for c in both] == ["draft-ae-1-v2"]

    # The medication check shows the first missing field, but its key does not drift as
    # the coordinator fills fields in one at a time.
    cm_check = "query.cm_required_fields_missing"
    kiosk = only([cm(CMDOSE=None, CMDOSU=None, CMDOSFRQ=None, CMINDC=None)], cm_check)
    dose_filled = only([cm(CMDOSU=None, CMDOSFRQ=None, CMINDC=None)], cm_check)
    assert (kiosk.field, dose_filled.field) == ("CMDOSE", "CMDOSU")
    assert kiosk.key == dose_filled.key == f"{cm_check}|draft-cm-1|CMDOSE"

    # A record without a lineage id is its own lineage (flat SDTM rows keep working).
    flat = only([{"DOMAIN": "AE", **ae(AESER="Y")["fields"]}], check)
    assert flat.key == f"{check}|AE:R2810-ONC-1624-P-007:1|AESER"


CODED_WORDS = (
    "AESER",
    "AEOUT",
    "VSTESTCD",
    "INTERIM_",
    "PULSE",
    "RESP ",
    "RECOVERED/RESOLVED",
    "AE record",
    "CM record",
    "VS record",
    "= Y",
    "currently Y",
    "currently N",
)
"""Codes a non-clinician should not meet in query or answer text (CLAUDE.md §00)."""


def test_query_and_answer_text_is_plain_language() -> None:
    _irae_available()
    for cand, _, answer in _answers():
        for text in (cand.text, str(answer["text"])):
            for word in CODED_WORDS:
                assert word not in text, (cand.check_id, word, text)
    pulse = only([vs(value="200")], "query.vs_value_implausible")
    assert pulse.text.startswith("The pulse reading (record 1) for participant")
    assert "is 200 beats/min" in pulse.text
    resp = only([vs("RESP", 60, "breaths/min")], "query.vs_value_implausible")
    assert "breathing rate reading" in resp.text
    resolved = only([ae(AEOUT="RECOVERED/RESOLVED")], "query.ae_resolved_without_end_date")
    assert "has the outcome recovered," in resolved.text
    # The SDTM names stay one click deeper: on the candidate, not in the sentence.
    serious = only([ae(AESER="Y")], "query.ae_serious_no_signed_report")
    assert serious.field == "AESER" and "AESER" not in serious.text


def test_answer_facts_keep_the_recorded_code_beside_the_plain_value() -> None:
    _irae_available()
    record = ae(INTERIM_IRAE="N")
    cand = only([record], "query.ae_irae_assessment_needs_detail")
    facts = queries.answer_facts(cand, record)
    irae = next(f for f in facts["fields"] if f["field"] == "INTERIM_IRAE")
    assert irae["value"] == "no" and irae.get("code") == "N"
    grade = next(f for f in facts["fields"] if f["field"] == "AETOXGR")
    assert grade["value"] == "3" and "code" not in grade
    text = str(queries.suggest_answer(cand, facts)["text"])
    assert "Immune-related? (investigator decides): no, as currently recorded." in text


def test_value_labels_are_plain_and_pass_the_narrative_validator() -> None:
    forbidden = [
        re.compile(p["pattern"], re.IGNORECASE)
        for p in tables.load_table("narrative_templates")["validation"]["forbidden_patterns"]
    ]
    labels = queries.edit_check_table().value_labels
    assert labels["VSTESTCD"]["pulse"] == "pulse"
    assert queries.display_value("AEOUT", "unknown", "not recorded") == "outcome not known"
    assert queries.display_value("AESER", "y", "not recorded") == "yes"
    # Unlisted codes and other fields are shown as recorded; empty values as missing.
    assert queries.display_value("AESER", "MAYBE", "not recorded") == "MAYBE"
    assert queries.display_value("CMTRT", "Y", "not recorded") == "Y"
    assert queries.display_value("AESER", None, "not recorded") == "not recorded"
    for fld, codes in labels.items():
        for code, words in codes.items():
            for pattern in forbidden:
                assert not pattern.search(words), (fld, code, words)


def test_every_candidate_has_evidence_and_rendered_plain_text() -> None:
    _irae_available()
    batch = _messy_batch()
    candidates = queries.run_edit_checks(batch)
    assert {c.check_id for c in candidates} == R44_CHECKS
    records = {str(r["id"]): r for r in batch}
    forbidden = [
        re.compile(p["pattern"], re.IGNORECASE)
        for p in tables.load_table("narrative_templates")["validation"]["forbidden_patterns"]
    ]
    for cand in candidates:
        assert cand.evidence, cand.key
        assert cand.evidence[0].kind == "rule" and cand.evidence[0].id == cand.check_id
        assert cand.field == cand.fields[0]
        assert "{" not in cand.text and "}" not in cand.text
        for pattern in forbidden:
            assert not pattern.search(cand.text), (cand.check_id, pattern.pattern)
        # The record's own evidence for the queried fields travels with the query.
        record = records[cand.record_key]
        own = {
            str(e["id"])
            for name in cand.fields
            for e in cast(dict[str, list[dict[str, object]]], record["evidence"]).get(name, [])
        }
        assert own <= {e.id for e in cand.evidence}
        assert cand.to_dict()["evidence"]


# --------------------------------------------------------------------------- #
# Suggested answers
# --------------------------------------------------------------------------- #


def _answers() -> list[tuple[QueryCandidate, queries.AnswerFacts, dict[str, object]]]:
    batch = _messy_batch()
    records = {str(r["id"]): r for r in batch}
    out = []
    for cand in queries.run_edit_checks(batch):
        facts = queries.answer_facts(cand, records[cand.record_key])
        out.append((cand, facts, queries.suggest_answer(cand, facts)))
    return out


def test_suggested_answers_cite_only_ids_in_the_facts() -> None:
    _irae_available()
    for cand, facts, answer in _answers():
        known = set(narrative.collect_evidence_ids(cast(Mapping[str, object], facts)))
        sentences = cast(list[dict[str, object]], answer["sentences"])
        assert answer["kind"] == "query_answer" and answer["writer"] == "template"
        assert sentences, cand.check_id
        for sentence in sentences:
            ids = cast(list[str], sentence["evidence_ids"])
            assert ids, sentence
            assert set(ids) <= known, (cand.check_id, sentence)
        assert answer["text"] == " ".join(str(s["text"]) for s in sentences)


def test_suggested_answers_pass_the_narrative_validator() -> None:
    """Same rules as every generated text: verbatim quotes, no advice, qualified grades."""
    _irae_available()
    for cand, facts, answer in _answers():
        problems = narrative.validate_written(answer, cast(Mapping[str, object], facts))
        problems = [p for p in problems if not p.startswith("kind ")]  # query_answer is ours
        assert problems == [], (cand.check_id, problems, answer["text"])


def test_suggested_answer_content() -> None:
    _irae_available()
    by_check = {cand.check_id: answer for cand, _, answer in _answers()}
    cm_text = str(by_check["query.cm_required_fields_missing"]["text"])
    assert "Dose: not yet on the record." in cm_text
    assert "ask the participant for the dose" in cm_text
    irae_text = str(by_check["query.ae_irae_assessment_needs_detail"]["text"])
    assert "(provisional, investigator to confirm)" in irae_text
    assert '"rash.severity = 3 (Severe)"' in irae_text


def test_suggested_answer_from_api_row_and_extra_facts() -> None:
    record = ae(AESER="Y")
    cand = only([record], "query.ae_serious_no_signed_report")
    row = {k: v for k, v in cand.to_dict().items() if k in ("check_id", "field", "evidence")}
    extra: list[queries.ExtraFact] = [
        {"label": "Serious-event report", "value": "draft, not signed", "evidence_ids": ["pkt-1"]}
    ]
    facts = queries.answer_facts(row, record, extra)
    answer = queries.suggest_answer(row, facts)
    sentences = cast(list[dict[str, object]], answer["sentences"])
    assert any(s["evidence_ids"] == ["pkt-1"] for s in sentences)
    assert "Serious-event report: draft, not signed." in str(answer["text"])


def test_manual_query_and_empty_facts() -> None:
    record = ae()
    manual = {"check_id": None, "field": "AETERM"}
    facts = queries.answer_facts(manual, record)
    answer = queries.suggest_answer(manual, facts)
    sentences = cast(list[dict[str, object]], answer["sentences"])
    # No check: no opening or closing sentence, but the field and its source are cited.
    assert sentences
    assert all(set(cast(list[str], s["evidence_ids"])) <= {"ans-rash-presence"} for s in sentences)
    empty = queries.suggest_answer(manual, {})
    assert empty["sentences"] == [] and empty["text"] == ""


def test_suggest_answer_ignores_ids_not_in_facts() -> None:
    """A tampered fact bundle cannot make a sentence cite an id it does not contain."""
    record = cm(CMDOSE=None)
    cand = only([record], "query.cm_required_fields_missing")
    facts = cast(dict[str, Any], queries.answer_facts(cand, record))
    facts["sources"] = [{"kind": "rule", "note": "not a source kind", "evidence_ids": ["x"]}]
    answer = queries.suggest_answer(cand, facts)
    known = set(narrative.collect_evidence_ids(facts))
    for sentence in cast(list[dict[str, object]], answer["sentences"]):
        assert set(cast(list[str], sentence["evidence_ids"])) <= known
        assert "not a source kind" not in str(sentence["text"])
