"""Exports (CSV / JSON / submission bundle) and the mock EDC endpoint.

* Records are the **current** draft versions (never ``superseded``), filtered by
  ``status=confirmed`` (default) or ``status=all``; eval sessions are excluded
  unless asked for.
* CSV column order is SDTM-first: ``STUDYID, USUBJID``, the domain's own
  variables in draft order, then every ``INTERIM_*`` column (D-008 and the
  task brief). JSON keeps the same keys per record.
* ``VS`` has a per-sample long format (one row per metric per raw sample) for
  ``?per_sample=true`` and the bundle's ``VS_samples.csv``: the eSource series
  is never averaged away.
* Every export is an ``export.generated`` audit event carrying the SHA-256 of
  what was produced; the bundle's ``manifest.json`` lists a SHA-256 per file
  and the audit head hash at generation time.
* ``POST /mock-edc/{domain}`` validates the column set (SDTM variables of the
  domain plus any ``INTERIM_*`` column) and returns an acknowledgment id. Nothing
  leaves the system; the endpoint exists so the "post to EDC" step is visibly
  real in the demo.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import zipfile
from collections.abc import Iterable, Sequence
from typing import Any

from sqlmodel import Session as DbSession
from sqlmodel import select

from interim_rules.tables import vitals_config

from .. import API_VERSION
from ..audit import Actor, append_event, head, verify_chain
from ..models import AuditEvent, Draft, Session, Study, VitalsSample
from ..problems import problem
from ..util import load_json, new_id, now_iso
from .common import draft_to_dict
from .sdtm_fields import field_problems

DOMAINS: tuple[str, ...] = ("AE", "VS", "CM")

SDTM_VARIABLES: dict[str, tuple[str, ...]] = {
    "AE": (
        "STUDYID",
        "DOMAIN",
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
    ),
    "VS": (
        "STUDYID",
        "DOMAIN",
        "USUBJID",
        "VSSEQ",
        "VSTESTCD",
        "VSTEST",
        "VSORRES",
        "VSORRESU",
        "VSDTC",
        "VSMETHOD",
        "VSSTAT",
    ),
    "CM": (
        "STUDYID",
        "DOMAIN",
        "USUBJID",
        "CMSEQ",
        "CMTRT",
        "CMDECOD",
        "CMSTDTC",
        "CMENDTC",
        "CMSTAT",
    ),
}
"""SDTM IG variable names Interim emits per domain (CLAUDE.md §3.5)."""

REQUIRED_VARIABLES: dict[str, tuple[str, ...]] = {
    "AE": ("STUDYID", "USUBJID", "AETERM", "AEDECOD"),
    "VS": ("STUDYID", "USUBJID", "VSTESTCD"),
    "CM": ("STUDYID", "USUBJID", "CMTRT"),
}

BUNDLE_FILES: tuple[str, ...] = (
    "AE.csv",
    "AE.json",
    "VS.csv",
    "VS.json",
    "VS_samples.csv",
    "CM.csv",
    "CM.json",
    "audit_excerpt.json",
    "manifest.json",
)


def check_domain(domain: str) -> str:
    upper = domain.upper()
    if upper not in DOMAINS:
        raise problem(404, f"Unknown domain {domain!r}; use AE, VS or CM", title="Unknown domain")
    return upper


def check_status(status: str) -> str:
    if status not in ("confirmed", "all"):
        raise problem(422, "status must be 'confirmed' or 'all'", title="Bad status filter")
    return status


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --------------------------------------------------------------------------- #
# Records
# --------------------------------------------------------------------------- #


def _session_map(db: DbSession, session_ids: Iterable[str]) -> dict[str, Session]:
    ids = [s for s in set(session_ids) if s]
    if not ids:
        return {}
    return {s.id: s for s in db.exec(select(Session).where(Session.id.in_(ids))).all()}  # type: ignore[union-attr]


def records_for(
    db: DbSession, domain: str, status: str, *, include_eval: bool = False
) -> list[dict[str, Any]]:
    stmt = select(Draft).where(Draft.domain == domain).where(Draft.status != "superseded")
    if status == "confirmed":
        stmt = stmt.where(Draft.status == "confirmed")
    rows = list(db.exec(stmt).all())
    sessions = _session_map(db, (r.session_id or "" for r in rows))
    out: list[dict[str, Any]] = []
    for row in rows:
        session = sessions.get(row.session_id or "")
        if session is not None and session.is_eval and not include_eval:
            continue
        record = dict(draft_to_dict(row)["fields"])
        record["INTERIM_DRAFT_ID"] = row.id
        record["INTERIM_DRAFT_VERSION"] = row.version
        record["INTERIM_DRAFT_STATUS"] = row.status
        record["INTERIM_SESSION_ID"] = row.session_id
        record["INTERIM_NOTE_ID"] = row.note_id
        record["INTERIM_CONFIRMED_BY"] = (
            row.status_changed_by if row.status == "confirmed" else None
        )
        record["INTERIM_CONFIRMED_AT"] = (
            row.status_changed_at if row.status == "confirmed" else None
        )
        record["INTERIM_RECORDED_AT"] = (
            session.completed_at if session is not None and session.completed_at else row.created_at
        )
        out.append(record)
    seq_key = {"AE": "AESEQ", "VS": "VSSEQ", "CM": "CMSEQ"}[domain]
    out.sort(
        key=lambda r: (
            str(r.get("USUBJID", "")),
            str(r.get("INTERIM_RECORDED_AT", "")),
            int(r.get(seq_key) or 0),
        )
    )
    return out


def per_sample_records(
    db: DbSession, status: str, *, include_eval: bool = False
) -> list[dict[str, Any]]:
    """One row per metric per raw vitals sample, for every session with a VS record in scope."""
    cfg = vitals_config()
    vs_records = records_for(db, "VS", status, include_eval=include_eval)
    session_ids = sorted(
        {str(r["INTERIM_SESSION_ID"]) for r in vs_records if r.get("INTERIM_SESSION_ID")}
    )
    if not session_ids:
        return []
    sessions = _session_map(db, session_ids)
    study = db.exec(select(Study)).first()
    samples = db.exec(
        select(VitalsSample).where(VitalsSample.session_id.in_(session_ids))  # type: ignore[union-attr]
    ).all()
    tests = {
        "pulse": ("PULSE", "Pulse Rate", "beats/min", "pulse_bpm", "pulse_conf"),
        "breathing": ("RESP", "Respiratory Rate", "breaths/min", "breathing_bpm", "breathing_conf"),
        "hrv": ("HRV_RMSSD", "Heart Rate Variability (RMSSD)", "ms", "hrv_rmssd_ms", "hrv_conf"),
    }
    out: list[dict[str, Any]] = []
    for sample in sorted(samples, key=lambda v: (v.session_id, v.ts_utc, v.id)):
        session = sessions[sample.session_id]
        measured = sample.is_measured and sample.source not in cfg.simulated_sources
        method = cfg.method_measured if measured else cfg.method_simulated
        for _metric, (code, test, unit, value_attr, conf_attr) in tests.items():
            value = getattr(sample, value_attr)
            if value is None:
                continue
            out.append(
                {
                    "STUDYID": session.study_id,
                    "USUBJID": session.usubjid,
                    "VSTESTCD": code,
                    "VSTEST": test,
                    "VSORRES": value,
                    "VSORRESU": unit,
                    "VSDTC": sample.ts_utc,
                    "VSMETHOD": method,
                    "VSSTAT": None,
                    "INTERIM_NCT_ID": study.nct_id if study else None,
                    "INTERIM_CONFIDENCE": getattr(sample, conf_attr),
                    "INTERIM_SOURCE": sample.source,
                    "INTERIM_IS_MEASURED": measured,
                    "INTERIM_WINDOW_S": sample.window_s,
                    "INTERIM_QUALITY_FLAGS": load_json(sample.quality_flags_json, []),
                    "INTERIM_SAMPLE_ID": sample.id,
                    "INTERIM_SESSION_ID": sample.session_id,
                    "INTERIM_RECORD_SOURCE": "check_in",
                }
            )
    return out


# --------------------------------------------------------------------------- #
# CSV / JSON rendering
# --------------------------------------------------------------------------- #


def column_order(records: Sequence[dict[str, Any]]) -> list[str]:
    """``STUDYID, USUBJID``, then domain variables, then ``INTERIM_*`` (first-seen order)."""
    seen: dict[str, None] = {}
    for record in records:
        for key in record:
            seen.setdefault(key, None)
    keys = list(seen)
    first = [k for k in ("STUDYID", "USUBJID") if k in keys]
    domain_vars = [k for k in keys if k not in first and not k.startswith("INTERIM_")]
    interim_vars = [k for k in keys if k.startswith("INTERIM_")]
    return [*first, *domain_vars, *interim_vars]


def _cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, list | tuple):
        return ";".join(_cell(v) for v in value)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return str(value)


def to_csv(records: Sequence[dict[str, Any]], columns: Sequence[str] | None = None) -> bytes:
    cols = list(columns) if columns is not None else column_order(records)
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(cols)
    for record in records:
        writer.writerow([_cell(record.get(c)) for c in cols])
    return buffer.getvalue().encode("utf-8")


def export_json_document(
    domain: str, status: str, records: Sequence[dict[str, Any]], *, generated_at: str
) -> dict[str, Any]:
    return {
        "domain": domain,
        "generated_at": generated_at,
        "status_filter": status,
        "interim_version": API_VERSION,
        "n_records": len(records),
        "labeling": "Simulated values are labeled: VSMETHOD = 'Simulated', "
        "INTERIM_IS_MEASURED = false, "
        "INTERIM_SOURCE = 'mock'. Provisional grades carry INTERIM_PROVISIONAL = true.",
        "records": list(records),
    }


def to_json_bytes(document: dict[str, Any]) -> bytes:
    return json.dumps(document, ensure_ascii=False, indent=2).encode("utf-8")


def log_export(
    db: DbSession,
    actor: Actor,
    *,
    kind: str,
    domain: str | None,
    status: str,
    n_records: int,
    sha256: str,
    extra: dict[str, Any] | None = None,
    now: str | None = None,
) -> AuditEvent:
    payload: dict[str, Any] = {
        "kind": kind,
        "domain": domain,
        "status_filter": status,
        "n_records": n_records,
        "sha256": sha256,
        "interim_version": API_VERSION,
    }
    if extra:
        payload.update(extra)
    return append_event(db, actor, "export.generated", "export", sha256[:26], payload, ts_utc=now)


# --------------------------------------------------------------------------- #
# Bundle
# --------------------------------------------------------------------------- #


def audit_excerpt(db: DbSession, entity_ids: Iterable[str], *, cap: int = 5000) -> dict[str, Any]:
    ids = sorted({i for i in entity_ids if i})
    events: list[AuditEvent] = []
    if ids:
        for start in range(0, len(ids), 400):
            chunk = ids[start : start + 400]
            events.extend(
                db.exec(select(AuditEvent).where(AuditEvent.entity_id.in_(chunk))).all()  # type: ignore[union-attr]
            )
    events.sort(key=lambda e: e.seq)
    truncated = len(events) > cap
    events = events[-cap:]
    latest = head(db)
    return {
        "generated_at": now_iso(),
        "head": {"seq": latest.seq, "hash": latest.hash} if latest else None,
        "verify": verify_chain(db),
        "n_events": len(events),
        "truncated": truncated,
        "events": [
            {
                "id": e.id,
                "seq": e.seq,
                "ts_utc": e.ts_utc,
                "actor_id": e.actor_id,
                "actor_role": e.actor_role,
                "action": e.action,
                "entity_type": e.entity_type,
                "entity_id": e.entity_id,
                "payload": load_json(e.payload_json, {}),
                "prev_hash": e.prev_hash,
                "hash": e.hash,
            }
            for e in events
        ],
    }


def build_bundle(
    db: DbSession, actor: Actor, *, status: str, include_eval: bool = False, now: str | None = None
) -> tuple[bytes, dict[str, Any]]:
    """The submission bundle zip and its manifest (also written inside the zip)."""
    generated_at = now or now_iso()
    study = db.exec(select(Study)).first()
    files: dict[str, bytes] = {}
    entity_ids: set[str] = set()
    counts: dict[str, int] = {}
    for domain in DOMAINS:
        records = records_for(db, domain, status, include_eval=include_eval)
        counts[domain] = len(records)
        for r in records:
            entity_ids.add(str(r.get("INTERIM_DRAFT_ID")))
            if r.get("INTERIM_SESSION_ID"):
                entity_ids.add(str(r["INTERIM_SESSION_ID"]))
        files[f"{domain}.csv"] = to_csv(records)
        files[f"{domain}.json"] = to_json_bytes(
            export_json_document(domain, status, records, generated_at=generated_at)
        )
    samples = per_sample_records(db, status, include_eval=include_eval)
    counts["VS_samples"] = len(samples)
    files["VS_samples.csv"] = to_csv(samples)
    files["audit_excerpt.json"] = to_json_bytes(audit_excerpt(db, entity_ids))
    latest = head(db)
    manifest = {
        "generated_at": generated_at,
        "generated_by": actor.id,
        "study_id": study.study_id if study else None,
        "nct_id": study.nct_id if study else None,
        "status_filter": status,
        "include_eval": include_eval,
        "interim_version": API_VERSION,
        "audit_head_hash": latest.hash if latest else None,
        "audit_head_seq": latest.seq if latest else None,
        "record_counts": counts,
        "files": [
            {"name": name, "sha256": sha256_hex(data), "bytes": len(data)}
            for name, data in files.items()
        ],
        "note": "All participants are synthetic. Vitals rows say VSMETHOD = 'Simulated' unless a "
        "measured source produced them. Grades are provisional until an investigator confirms.",
    }
    manifest_bytes = to_json_bytes(manifest)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(name, data)
        zf.writestr("manifest.json", manifest_bytes)
    blob = buffer.getvalue()
    log_export(
        db,
        actor,
        kind="bundle",
        domain=None,
        status=status,
        n_records=sum(counts[d] for d in DOMAINS),
        sha256=sha256_hex(blob),
        extra={"files": manifest["files"], "audit_head_hash": manifest["audit_head_hash"]},
        now=generated_at,
    )
    return blob, manifest


# --------------------------------------------------------------------------- #
# Mock EDC
# --------------------------------------------------------------------------- #


def validate_edc_records(domain: str, records: Sequence[dict[str, Any]]) -> list[str]:
    """Problems with the submitted records (empty list = accepted)."""
    allowed = set(SDTM_VARIABLES[domain])
    required = REQUIRED_VARIABLES[domain]
    errors: list[str] = []
    for index, record in enumerate(records):
        unknown = sorted(k for k in record if k not in allowed and not k.startswith("INTERIM_"))
        if unknown:
            errors.append(f"records[{index}]: unknown column(s) {', '.join(unknown)}")
        missing = [k for k in required if record.get(k) in (None, "")]
        if missing:
            errors.append(f"records[{index}]: missing required {', '.join(missing)}")
        if (
            domain == "VS"
            and record.get("VSORRES") in (None, "")
            and record.get("VSSTAT") != "NOT DONE"
        ):
            errors.append(f"records[{index}]: VSORRES is empty but VSSTAT is not 'NOT DONE'")
        # Typed-field checks shared with PATCH /drafts (lenient: CSV round-trips carry strings).
        errors.extend(
            f"records[{index}]: {message}" for message in field_problems(record, lenient=True)
        )
    return errors


def post_mock_edc(
    db: DbSession,
    actor: Actor,
    domain: str,
    records: Sequence[dict[str, Any]],
    *,
    now: str | None = None,
) -> dict[str, Any]:
    errors = validate_edc_records(domain, records)
    if errors:
        raise problem(
            422,
            f"{len(errors)} record problem(s): " + "; ".join(errors[:5]),
            title="Records rejected by mock EDC",
            errors=errors,
        )
    stamp = now or now_iso()
    canonical = json.dumps(list(records), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    digest = sha256_hex(canonical.encode("utf-8"))
    ack_id = f"EDC-{domain}-{new_id()}"
    append_event(
        db,
        actor,
        "mock_edc.posted",
        "mock_edc",
        ack_id,
        {
            "domain": domain,
            "received": len(records),
            "sha256": digest,
            "usubjids": sorted({str(r.get("USUBJID")) for r in records}),
            "draft_ids": sorted(
                {str(r["INTERIM_DRAFT_ID"]) for r in records if r.get("INTERIM_DRAFT_ID")}
            ),
            "note": "mock EDC: records are acknowledged and logged; nothing is transmitted",
        },
        ts_utc=stamp,
    )
    return {
        "ack_id": ack_id,
        "domain": domain,
        "received": len(records),
        "accepted_at": stamp,
        "sha256": digest,
        "note": "Mock EDC acknowledgment. No external system was contacted.",
    }
