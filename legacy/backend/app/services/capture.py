"""Turns raw inputs (check-in answers, transcripts, chart notes, vitals) into reviewable records:
AE flags with evidence, con-med changes, and escalations. Handles de-duplication across sources and
starts the serious-AE clock when the site first becomes aware of a possible SAE.
"""

from __future__ import annotations

from datetime import date, timedelta
from statistics import median

from sqlmodel import Session, col, select

from app.config import settings
from app.models import (
    AEFlag,
    Answer,
    CheckIn,
    CheckInStatus,
    ChartNote,
    ConMedChange,
    Escalation,
    EscalationStatus,
    Evidence,
    Patient,
    ReviewStatus,
    SourceType,
    VitalsReading,
    utcnow,
)
from app.services import safety
from app.services.extract import MedFinding, ScanResult, scan_text
from app.services.grading import provisional_grade
from app.services.items import QUESTION_BY_ID, QUESTIONS, SCALES, SYMPTOM_BY_KEY, Question, parse_spoken_answer
from app.services.vitals import vitals_signals

DEDUP_WINDOW_DAYS = 30
OPEN_FLAG_STATUSES = (ReviewStatus.pending.value, ReviewStatus.needs_info.value, ReviewStatus.confirmed.value)
LEVEL_RANK = {"emergency": 3, "urgent": 2, "human_requested": 1}
GENERIC_SAE_TERM = "Event requiring ER visit or hospitalization (term to be coded)"

# ---------------------------------------------------------------------------
# Low-level upserts (all de-duplicate)
# ---------------------------------------------------------------------------


def upsert_flag(
    session: Session,
    patient_id: int,
    term: str,
    grade: int,
    grade_basis: str,
    *,
    source_type: str,
    source_id: int | None,
    quote: str,
    reasoning: str,
    span: tuple[int, int] | None = None,
    onset_date: date | None = None,
    serious_reason: str | None = None,
) -> AEFlag:
    """Find an open flag for the same patient + term in the last 30 days and attach evidence to it,
    or create a new one. This is the cross-source de-duplication step."""
    now = utcnow()
    flag = session.exec(
        select(AEFlag).where(
            AEFlag.patient_id == patient_id,
            AEFlag.term == term,
            col(AEFlag.status).in_(OPEN_FLAG_STATUSES),
            AEFlag.last_updated_at >= now - timedelta(days=DEDUP_WINDOW_DAYS),
        )
    ).first()
    if flag is None:
        flag = AEFlag(patient_id=patient_id, term=term, provisional_grade=grade, grade_basis=grade_basis,
                      onset_date=onset_date)
        session.add(flag)
        session.flush()
    else:
        if grade > flag.provisional_grade:
            flag.provisional_grade, flag.grade_basis = grade, grade_basis
        if onset_date and (flag.onset_date is None or onset_date < flag.onset_date):
            flag.onset_date = onset_date
        flag.last_updated_at = now

    if serious_reason and not flag.serious_candidate:
        flag.serious_candidate = True
        flag.serious_reason = serious_reason
        flag.site_aware_at = now  # SAE clock starts when the site becomes aware
        flag.sae_due_at = now + timedelta(hours=settings.sae_report_hours)

    dup = session.exec(
        select(Evidence).where(
            Evidence.flag_id == flag.id,
            Evidence.source_type == source_type,
            Evidence.source_id == source_id,
            Evidence.quote == quote,
        )
    ).first()
    if dup is None:
        session.add(Evidence(
            flag_id=flag.id, source_type=source_type, source_id=source_id, quote=quote, reasoning=reasoning,
            span_start=span[0] if span else None, span_end=span[1] if span else None, grade_suggested=grade,
        ))
    session.add(flag)
    return flag


def add_conmed(
    session: Session,
    patient: Patient,
    f: MedFinding,
    *,
    source_type: str,
    source_id: int | None,
    event_date: date | None,
) -> ConMedChange | None:
    baseline = {m.lower() for m in (patient.baseline_meds or [])}
    if f.action == "taking" and f.drug.lower() in baseline:
        return None  # already on the con-med log, nothing changed
    if f.action == "taking" and session.exec(select(ConMedChange).where(
            ConMedChange.patient_id == patient.id, ConMedChange.drug == f.drug,
            ConMedChange.status != ReviewStatus.rejected.value)).first():
        return None  # already captured (e.g. "started" earlier); a plain mention adds nothing
    existing = session.exec(
        select(ConMedChange).where(
            ConMedChange.patient_id == patient.id,
            ConMedChange.drug == f.drug,
            ConMedChange.action == f.action,
            ConMedChange.status != ReviewStatus.rejected.value,
            ConMedChange.detected_at >= utcnow() - timedelta(days=DEDUP_WINDOW_DAYS),
        )
    ).first()
    if existing:
        return existing
    reasoning = f.reasoning
    if f.action == "taking":
        reasoning += "; not on this patient's baseline con-med list -> needs to be recorded"
    cm = ConMedChange(
        patient_id=patient.id, drug=f.drug, mentioned_as=f.mentioned_as, action=f.action,
        indication=f.indication, event_date=event_date, source_type=source_type, source_id=source_id,
        quote=f.sentence, reasoning=reasoning,
    )
    session.add(cm)
    session.flush()
    return cm


def add_escalation(
    session: Session,
    patient_id: int,
    level: str,
    reason: str,
    *,
    category: str | None = None,
    quote: str | None = None,
    source_type: str | None = None,
    source_id: int | None = None,
    checkin_id: int | None = None,
    patient_message: str | None = None,
) -> tuple[Escalation, bool]:
    """One open escalation per patient + category (per check-in, or per 24h outside a check-in).
    New evidence for the same category is merged in, and the level is upgraded if needed."""
    category = category or reason
    q = select(Escalation).where(
        Escalation.patient_id == patient_id,
        Escalation.category == category,
        Escalation.status == EscalationStatus.open.value,
    )
    q = q.where(Escalation.checkin_id == checkin_id) if checkin_id else q.where(
        Escalation.created_at >= utcnow() - timedelta(hours=24))
    existing = session.exec(q).first()
    if existing:
        if reason not in existing.reason:
            existing.reason = f"{existing.reason} | {reason}"
        if LEVEL_RANK.get(level, 0) > LEVEL_RANK.get(existing.level, 0):
            existing.level, existing.patient_message = level, patient_message or existing.patient_message
        session.add(existing)
        return existing, False
    esc = Escalation(patient_id=patient_id, checkin_id=checkin_id, level=level, category=category, reason=reason,
                     quote=quote, source_type=source_type, source_id=source_id, patient_message=patient_message)
    session.add(esc)
    session.flush()
    return esc, True


# ---------------------------------------------------------------------------
# Text (check-in transcript or chart note) -> records
# ---------------------------------------------------------------------------


def ingest_scan(
    session: Session,
    patient: Patient,
    scan: ScanResult,
    *,
    source_type: str,
    source_id: int | None,
    ref_date: date,
    context: str,  # "checkin" | "note"
    checkin_id: int | None = None,
    create_generic_sae: bool = True,
) -> dict:
    flags, conmeds, escalations = [], [], []

    for f in scan.symptoms:
        parts = [f"Text mentions '{f.quote}' -> CTCAE term '{f.term}'.", f.grade_basis[0].upper() + f.grade_basis[1:] + "."]
        if f.onset_date:
            parts.append(f"Onset estimated {f.onset_date.isoformat()} ({f.onset_days_ago} day(s) before {ref_date.isoformat()}).")
        if f.worsening:
            parts.append("Described as worsening.")
        if f.resolved:
            parts.append("Described as resolved (still recordable as an AE with an end date).")
        flag = upsert_flag(
            session, patient.id, f.term, f.grade, f.grade_basis, source_type=source_type, source_id=source_id,
            quote=f.sentence, reasoning=" ".join(parts), span=(f.span_start, f.span_end), onset_date=f.onset_date,
            serious_reason=f.serious_cue,
        )
        flags.append(flag)

    event_date = ref_date if context == "note" else None
    for m in scan.meds:
        cm = add_conmed(session, patient, m, source_type=source_type, source_id=source_id, event_date=event_date)
        if cm:
            conmeds.append(cm)

    for rf in scan.red_flags:
        if create_generic_sae and rf.category == "hospitalization" and not any(fl.serious_candidate for fl in flags):
            flags.append(upsert_flag(
                session, patient.id, GENERIC_SAE_TERM, 3, "ER visit / hospitalization mentioned, no symptom identified",
                source_type=source_type, source_id=source_id, quote=rf.quote,
                reasoning=f"{rf.reason}. No specific symptom found in the text, so the coordinator needs to code the term.",
                span=(rf.span_start, rf.span_end), serious_reason=rf.reason,
            ))
        if context == "note":
            level, msg, reason = "urgent", None, f"Chart note: {rf.reason}"
        else:
            level, msg, reason = rf.level, safety.message_for(rf.level, rf.category), rf.reason
        esc, _ = add_escalation(session, patient.id, level, reason, category=rf.category, quote=rf.quote,
                                source_type=source_type,
                                source_id=source_id, checkin_id=checkin_id, patient_message=msg)
        escalations.append(esc)

    if scan.human_requested and context == "checkin":
        esc, _ = add_escalation(session, patient.id, "human_requested", "Patient asked to talk to a person",
                                category="human_requested",
                                source_type=source_type, source_id=source_id, checkin_id=checkin_id,
                                patient_message=safety.PATIENT_MESSAGES["human_requested"])
        escalations.append(esc)

    return {"flags": flags, "conmeds": conmeds, "escalations": escalations}


def ingest_note(session: Session, note: ChartNote) -> dict:
    patient = session.get(Patient, note.patient_id)
    scan = scan_text(note.text, note.note_date)
    result = ingest_scan(session, patient, scan, source_type=SourceType.chart_note.value, source_id=note.id,
                         ref_date=note.note_date, context="note")
    result["scan"] = scan
    return result


# ---------------------------------------------------------------------------
# Check-in flow
# ---------------------------------------------------------------------------


def checkin_answers(session: Session, checkin_id: int) -> dict[str, Answer]:
    rows = session.exec(select(Answer).where(Answer.checkin_id == checkin_id).order_by(Answer.id)).all()
    return {a.question_id: a for a in rows}


def next_question(session: Session, checkin: CheckIn) -> Question | None:
    """Next unanswered question, with PRO-CTCAE-style branching: if frequency/presence/severity is
    0 ("Never"/"No"/"None"), the remaining attributes for that symptom are skipped."""
    answers = checkin_answers(session, checkin.id)
    for q in QUESTIONS:
        a = answers.get(q.id)
        if a is not None and (a.value is not None or q.attribute == "text"):
            continue  # answered (an answer we couldn't parse is asked again)
        if q.symptom:
            sym = SYMPTOM_BY_KEY[q.symptom]
            prior = [answers.get(f"{q.symptom}.{a}") for a in sym.attributes]
            if any(a is not None and a.attribute in ("frequency", "presence", "severity") and a.value == 0 for a in prior):
                continue
        return q
    return None


def submit_answers(session: Session, checkin: CheckIn, items: list[dict]) -> dict:
    """Save answers and run live safety checks. items: [{question_id, value?, text?}]."""
    patient = session.get(Patient, checkin.patient_id)
    existing = checkin_answers(session, checkin.id)
    saved, unparsed, new_escalations = [], [], []
    needs_details: list[dict] = []

    for item in items:
        q = QUESTION_BY_ID.get(item["question_id"])
        if q is None:
            raise ValueError(f"Unknown question_id '{item['question_id']}'")
        value, text = item.get("value"), (item.get("text") or "").strip() or None
        prev = existing.get(q.id)
        if q.attribute != "text":
            if value is None and text:
                value = parse_spoken_answer(q.attribute, text)
            if value is None and not text:
                raise ValueError(f"{q.id}: provide 'value' or 'text'")
            if value is not None and not (0 <= value < len(q.options)):
                raise ValueError(f"{q.id}: value must be 0..{len(q.options) - 1}")
            if value is None and prev is not None and prev.value is not None:
                value = prev.value  # follow-up details for an answer we already have ("Yes" -> "which medicine?")
            elif value is None:
                unparsed.append({"question_id": q.id, "text": text,
                                 "hint": "Couldn't map this answer to a scale option; re-ask with the options."})
        ans = prev or Answer(checkin_id=checkin.id, question_id=q.id, attribute=q.attribute, symptom=q.symptom)
        if text and prev is not None and prev.raw_text and text not in prev.raw_text:
            text_to_store = f"{prev.raw_text} {text}"
        else:
            text_to_store = text or (prev.raw_text if prev else None)
        ans.value, ans.raw_text = value, text_to_store
        session.add(ans)
        saved.append(q.id)
        if text:
            checkin.transcript = (checkin.transcript + f"\n({q.id.replace('.', ' ')}) {text}").strip()

        # Live safety: structured-answer rules
        for level, category, reason in safety.answer_escalations(q.id, value):
            esc, created = add_escalation(session, patient.id, level, reason, category=category,
                                          quote=f"{q.text} -> {q.options[value]}",
                                          source_type=SourceType.checkin_answer.value, source_id=checkin.id,
                                          checkin_id=checkin.id, patient_message=safety.message_for(level, category))
            new_escalations.append(esc)
        # Live safety: red flags / human request in anything they said
        if text:
            scan = scan_text(text, checkin.started_at.date(), detect_human_request=True)
            only_safety = ScanResult(red_flags=scan.red_flags, human_requested=scan.human_requested)
            res = ingest_scan(session, patient, only_safety, source_type=SourceType.checkin_text.value,
                              source_id=checkin.id, ref_date=checkin.started_at.date(), context="checkin",
                              checkin_id=checkin.id, create_generic_sae=False)
            new_escalations += res["escalations"]
            if scan.human_requested:
                checkin.human_requested = True
        if q.id == "care.visits" and value == 1 and not text:
            esc, _ = add_escalation(session, patient.id, "urgent", "Reported an ER / urgent care / hospital visit; details needed",
                                    category="hospitalization",
                                    source_type=SourceType.checkin_answer.value, source_id=checkin.id,
                                    checkin_id=checkin.id, patient_message=safety.PATIENT_MESSAGES["urgent"])
            new_escalations.append(esc)
        if q.asks_for_details and value == 1 and not text:
            needs_details.append({"question_id": q.id, "prompt": q.details_prompt})

    session.flush()
    top = max(new_escalations, key=lambda e: LEVEL_RANK.get(e.level, 0), default=None)
    end_checkin = bool(top and top.level == "emergency")
    if end_checkin:
        checkin.emergency_triggered = True
    session.add(checkin)
    session.commit()

    if end_checkin:
        # Emergency: the agent tells the patient to call 911 and ends the call. Process what we have.
        complete_checkin(session, checkin)

    nq = None if end_checkin else next_question(session, checkin)
    return {
        "saved": saved,
        "unparsed": unparsed,
        "needs_details": needs_details,
        "escalations": [e.model_dump() for e in new_escalations],
        "patient_message": top.patient_message if top else None,
        "end_checkin": end_checkin,
        "next_question": nq.as_dict() if nq else None,
        "done": nq is None,
    }


def _patient_baseline(session: Session, patient_id: int, exclude_id: int | None) -> tuple[float | None, float | None]:
    rows = session.exec(select(VitalsReading).where(VitalsReading.patient_id == patient_id)).all()
    rows = [r for r in rows if r.id != exclude_id]
    p = [r.pulse_bpm for r in rows if r.pulse_bpm is not None]
    b = [r.breathing_bpm for r in rows if r.breathing_bpm is not None]
    return (median(p) if p else None), (median(b) if b else None)


def process_vitals(session: Session, reading: VitalsReading) -> list[dict]:
    """Compute signals and, if the patient has a related open AE flag, attach the vitals as evidence."""
    if reading.processed:
        return reading.signals
    base_p, base_b = _patient_baseline(session, reading.patient_id, reading.id)
    signals = vitals_signals(reading.pulse_bpm, reading.breathing_bpm, base_p, base_b)
    reading.signals, reading.processed = signals, True
    session.add(reading)

    def open_flag(term: str) -> AEFlag | None:
        return session.exec(select(AEFlag).where(
            AEFlag.patient_id == reading.patient_id, AEFlag.term == term,
            col(AEFlag.status).in_(OPEN_FLAG_STATUSES),
            AEFlag.last_updated_at >= utcnow() - timedelta(days=DEDUP_WINDOW_DAYS),
        )).first()

    br_sigs = [s for s in signals if s["kind"].startswith("breathing") and s["kind"] != "breathing_low"]
    pulse_sigs = [s for s in signals if s["kind"].startswith("pulse") and s["kind"] != "pulse_low"]
    conf_note = "Presage SmartSpectra camera measurement; supporting context only, not diagnostic."

    dyspnea = open_flag("Dyspnea")
    if dyspnea and br_sigs:
        upsert_flag(session, reading.patient_id, "Dyspnea", dyspnea.provisional_grade, dyspnea.grade_basis,
                    source_type=SourceType.vitals.value, source_id=reading.id,
                    quote="; ".join(s["text"] for s in br_sigs) + f" (confidence {reading.breathing_confidence or 0:.0f}%)",
                    reasoning=f"Objective breathing-rate change supports the reported shortness of breath. {conf_note}")
        high = any(s["kind"] in ("breathing_high", "breathing_up_from_baseline") for s in br_sigs)
        if dyspnea.provisional_grade >= 2 or high:
            add_escalation(session, reading.patient_id, "urgent",
                           "Reported shortness of breath + elevated breathing rate on camera vitals", category="dyspnea",
                           quote="; ".join(s["text"] for s in br_sigs), source_type=SourceType.vitals.value,
                           source_id=reading.id, checkin_id=reading.checkin_id,
                           patient_message=safety.PATIENT_MESSAGES["urgent"])
    if pulse_sigs:
        for term in ("Dyspnea", "Fever", "Chills", "Dizziness"):
            fl = open_flag(term)
            if fl:
                upsert_flag(session, reading.patient_id, term, fl.provisional_grade, fl.grade_basis,
                            source_type=SourceType.vitals.value, source_id=reading.id,
                            quote="; ".join(s["text"] for s in pulse_sigs) + f" (confidence {reading.pulse_confidence or 0:.0f}%)",
                            reasoning=f"Elevated pulse alongside reported {term.lower()}. {conf_note}")
    return signals


def complete_checkin(session: Session, checkin: CheckIn) -> dict:
    """Grade structured answers, scan everything said, attach vitals, and close the check-in.
    Idempotent: calling it again just returns the report."""
    if checkin.status == CheckInStatus.completed.value:
        return build_checkin_report(session, checkin)
    patient = session.get(Patient, checkin.patient_id)
    answers = checkin_answers(session, checkin.id)
    ref_date = checkin.started_at.date()
    respondent = "Caregiver" if checkin.respondent == "caregiver" else "Patient"

    for sym in SYMPTOM_BY_KEY.values():
        attrs = {a: answers[f"{sym.key}.{a}"].value for a in sym.attributes
                 if f"{sym.key}.{a}" in answers and answers[f"{sym.key}.{a}"].value is not None}
        if not attrs:
            continue
        grade, basis = provisional_grade(attrs)
        if grade < 1:
            continue
        quote = "; ".join(f"{a}: '{SCALES[a][v]}'" for a, v in attrs.items())
        upsert_flag(session, patient.id, sym.ctcae_term, grade, basis,
                    source_type=SourceType.checkin_answer.value, source_id=checkin.id,
                    quote=f"{respondent} PRO-CTCAE answers for {sym.label.lower()} ({checkin.recall_period}): {quote}",
                    reasoning=f"Structured check-in answers. {basis}")

    if checkin.transcript.strip():
        scan = scan_text(checkin.transcript, ref_date)
        ingest_scan(session, patient, scan, source_type=SourceType.checkin_text.value, source_id=checkin.id,
                    ref_date=ref_date, context="checkin", checkin_id=checkin.id)

    session.flush()
    for reading in session.exec(select(VitalsReading).where(VitalsReading.checkin_id == checkin.id)).all():
        process_vitals(session, reading)

    checkin.status = CheckInStatus.completed.value
    checkin.completed_at = utcnow()
    session.add(checkin)
    session.commit()
    return build_checkin_report(session, checkin)


# ---------------------------------------------------------------------------
# Read models
# ---------------------------------------------------------------------------


def flag_out(session: Session, flag: AEFlag) -> dict:
    ev = session.exec(select(Evidence).where(Evidence.flag_id == flag.id).order_by(Evidence.id)).all()
    d = flag.model_dump()
    d["evidence"] = [e.model_dump() for e in ev]
    d["sources"] = sorted({e.source_type for e in ev})
    d["n_sources"] = len(d["sources"])
    if flag.sae_due_at and flag.serious is not False:
        remaining = (flag.sae_due_at - utcnow()).total_seconds() / 3600
        d["sae_clock"] = {"site_aware_at": flag.site_aware_at, "due_at": flag.sae_due_at,
                          "hours_remaining": round(remaining, 1), "overdue": remaining < 0}
    else:
        d["sae_clock"] = None
    return d


def build_checkin_report(session: Session, checkin: CheckIn) -> dict:
    patient = session.get(Patient, checkin.patient_id)
    answers = checkin_answers(session, checkin.id)

    symptoms = []
    for sym in SYMPTOM_BY_KEY.values():
        got = {a: answers[f"{sym.key}.{a}"] for a in sym.attributes if f"{sym.key}.{a}" in answers}
        if not got:
            continue
        attrs = {a: ans.value for a, ans in got.items() if ans.value is not None}
        grade, basis = provisional_grade(attrs) if attrs else (None, "answer not understood; re-ask")
        symptoms.append({
            "symptom": sym.key, "ctcae_term": sym.ctcae_term,
            "answers": {a: {"value": ans.value, "label": SCALES[a][ans.value] if ans.value is not None else None,
                            "raw_text": ans.raw_text} for a, ans in got.items()},
            "provisional_grade": grade, "grade_basis": basis,
        })

    other = {qid: {"value": a.value, "text": a.raw_text} for qid, a in answers.items() if not a.symptom}
    readings = session.exec(select(VitalsReading).where(VitalsReading.checkin_id == checkin.id)).all()
    reading_ids = [r.id for r in readings]

    ev_rows = session.exec(select(Evidence).where(
        ((col(Evidence.source_type).in_([SourceType.checkin_answer.value, SourceType.checkin_text.value]))
         & (Evidence.source_id == checkin.id))
        | ((Evidence.source_type == SourceType.vitals.value) & (col(Evidence.source_id).in_(reading_ids or [-1])))
    )).all()
    flag_ids = sorted({e.flag_id for e in ev_rows})
    flags = [flag_out(session, session.get(AEFlag, fid)) for fid in flag_ids]
    conmeds = session.exec(select(ConMedChange).where(
        ConMedChange.source_id == checkin.id, ConMedChange.source_type == SourceType.checkin_text.value)).all()
    escalations = session.exec(select(Escalation).where(Escalation.checkin_id == checkin.id)).all()
    scan = scan_text(checkin.transcript, checkin.started_at.date()) if checkin.transcript.strip() else None

    return {
        "checkin": checkin.model_dump(),
        "patient": {"id": patient.id, "subject_id": patient.subject_id, "display_name": patient.display_name},
        "symptoms": symptoms,
        "other_answers": other,
        "text_findings": scan.to_dict() if scan else None,
        "flags": flags,
        "conmed_changes": [c.model_dump() for c in conmeds],
        "escalations": [e.model_dump() for e in escalations],
        "vitals": [r.model_dump() for r in readings],
        "closing_message": safety.CLOSING_MESSAGE if checkin.status == CheckInStatus.completed.value else None,
    }
