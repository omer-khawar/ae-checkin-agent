"""Participant lookup and creation.

``POST /sessions`` accepts either the full ``USUBJID`` or the printed
``display_label`` (``P-007``, case-insensitive, trimmed; R2.3). Resolution order:
exact ``USUBJID``, then ``"{study_id}-{label}"``, then a label match among the
non-eval participants (eval participants reuse labels across runs, so they are
never reachable from the kiosk by label).
"""

from __future__ import annotations

from sqlalchemy import func
from sqlmodel import Session as DbSession
from sqlmodel import select

from interim_rules.serialize import protocol_context_from

from ..models import Participant, Study
from ..problems import problem
from ..util import dump_json, now_iso


def resolve_participant(db: DbSession, study: Study, key: str) -> Participant | None:
    text = key.strip()
    if not text:
        return None
    found = db.get(Participant, text)
    if found is not None:
        return found
    upper = text.upper()
    found = db.get(Participant, f"{study.study_id}-{upper}")
    if found is not None:
        return found
    prefix = f"{study.study_id.upper()}-"
    label = upper[len(prefix) :] if upper.startswith(prefix) else upper
    return db.exec(
        select(Participant)
        .where(Participant.is_eval == False)  # noqa: E712 - SQL comparison
        .where(func.upper(Participant.display_label) == label)
    ).first()


def require_participant(db: DbSession, study: Study, key: str) -> Participant:
    found = resolve_participant(db, study, key)
    if found is None:
        raise problem(
            404, f"No participant with usubjid {key.strip()}", title="Participant not found"
        )
    return found


def create_participant(
    db: DbSession,
    study: Study,
    *,
    display_label: str,
    usubjid: str | None = None,
    enrolled_at: str | None = None,
    baseline_vitals: dict[str, object] | None = None,
    baseline: dict[str, object] | None = None,
    protocol_context: dict[str, object] | None = None,
    is_eval: bool = False,
    now: str | None = None,
) -> Participant:
    """``baseline`` is the Synthea profile (seed only); ``protocol_context`` is the rules
    engine's ``ProtocolContext`` (``prior_pi3k_inhibitor``, ``last_dose_date``), validated
    here so a malformed context fails at creation, not at the first check-in."""
    created = now or now_iso()
    if protocol_context is not None:
        try:
            protocol_context_from(protocol_context)
        except ValueError as exc:
            raise problem(422, str(exc), title="Invalid protocol context") from exc
    participant = Participant(
        usubjid=usubjid or f"{study.study_id}-{display_label}",
        study_id=study.study_id,
        enrolled_at=enrolled_at or created,
        display_label=display_label,
        baseline_vitals_json=dump_json(baseline_vitals) if baseline_vitals is not None else None,
        baseline_json=dump_json(baseline) if baseline is not None else None,
        protocol_context_json=(
            dump_json(protocol_context) if protocol_context is not None else None
        ),
        is_eval=is_eval,
        created_at=created,
    )
    db.add(participant)
    db.flush()
    return participant
