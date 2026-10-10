"""Load the synthetic demo data (app/data/*.json) through the same code paths the API uses.

    python -m app.seed            # seed if the database is empty
    python -m app.seed --reset    # wipe and re-seed
"""

from __future__ import annotations

import argparse
import json
import random
from datetime import date, datetime
from pathlib import Path

from sqlmodel import Session, select

from app.db import init_db, new_session, reset_db
from app.models import ChartNote, CheckIn, Patient, VitalsReading, as_utc
from app.services.capture import complete_checkin, ingest_note, submit_answers
from app.services.vitals import summarize_presage

DATA = Path(__file__).parent / "data"


def simulated_presage_metrics(pulse_bpm: float, breathing_bpm: float, seconds: int, start: datetime) -> list[dict]:
    """Fake Presage SmartSpectra Metrics messages (one per second) around the given values.
    Breathing confidence stays 0 for the first 30 s, as the real SDK does."""
    rng = random.Random(42)
    t0 = int(start.timestamp() * 1e6)
    out = []
    for i in range(seconds):
        ts = t0 + i * 1_000_000
        pulse_conf = min(95.0, 30 + i * 2.5) + rng.uniform(-5, 5)
        br_conf = 0.0 if i < 30 else min(90.0, 40 + (i - 30) * 3) + rng.uniform(-5, 5)
        out.append({
            "cardio": {"pulse_rate": [{"value": round(pulse_bpm + rng.uniform(-3, 3), 1), "confidence": round(pulse_conf, 1),
                                       "stable": pulse_conf >= 40, "timestamp": ts}],
                       "hrv": [{"rmssd": round(18 + rng.uniform(-2, 2), 1), "confidence": 60.0, "stable": True,
                                "timestamp": ts}] if i >= 60 - 1 else []},
            "breathing": {"rate": [{"value": round(breathing_bpm + rng.uniform(-1.5, 1.5), 1), "confidence": round(br_conf, 1),
                                    "stable": br_conf >= 45, "timestamp": ts}]},
        })
    return out


def seed(session: Session) -> dict:
    personas = json.loads((DATA / "personas.json").read_text(encoding="utf-8"))
    notes = json.loads((DATA / "chart_notes.json").read_text(encoding="utf-8"))
    by_subject: dict[str, Patient] = {}

    for p in personas["patients"]:
        fields = {k: v for k, v in p.items() if k in Patient.model_fields and k != "id"}
        if fields.get("enrolled_on"):
            fields["enrolled_on"] = date.fromisoformat(fields["enrolled_on"])
        patient = Patient(**fields)
        session.add(patient)
        session.flush()
        by_subject[p["subject_id"]] = patient

    for v in personas.get("prior_vitals", []):
        r = VitalsReading(patient_id=by_subject[v["subject_id"]].id, captured_at=as_utc(datetime.fromisoformat(v["captured_at"])),
                          **{k: v[k] for k in ("pulse_bpm", "pulse_confidence", "breathing_bpm", "breathing_confidence")},
                          n_pulse_samples=1, n_breathing_samples=1, quality_notes=["Synthetic baseline"], processed=True)
        session.add(r)
    session.commit()

    # Chart notes and check-ins, in date order so de-dup across sources behaves like real life.
    events = [("note", n["note_date"], n) for n in notes["notes"]] + \
             [("checkin", c["started_at"][:10], c) for c in personas["checkins"]]
    events.sort(key=lambda e: e[1])
    n_notes = n_checkins = 0
    for kind, _, item in events:
        patient = by_subject[item["subject_id"]]
        if kind == "note":
            note = ChartNote(patient_id=patient.id, note_date=date.fromisoformat(item["note_date"]),
                             author=item.get("author"), note_type=item.get("note_type", "progress_note"),
                             source="synthetic", text=item["text"])
            session.add(note)
            session.flush()
            ingest_note(session, note)
            session.commit()
            n_notes += 1
        else:
            started = as_utc(datetime.fromisoformat(item["started_at"]))
            c = CheckIn(patient_id=patient.id, mode=item.get("mode", "text"), respondent=item.get("respondent", "patient"),
                        respondent_name=item.get("respondent_name"), started_at=started)
            session.add(c)
            session.commit()
            submit_answers(session, c, item["answers"])
            sim = (item.get("vitals") or {}).get("presage_simulated")
            if sim:
                summary = summarize_presage(simulated_presage_metrics(sim["pulse_bpm"], sim["breathing_bpm"],
                                                                      sim.get("seconds", 60), started))
                session.add(VitalsReading(patient_id=patient.id, checkin_id=c.id, captured_at=started, **summary))
                session.commit()
            session.refresh(c)
            complete_checkin(session, c)
            n_checkins += 1
    return {"patients": len(by_subject), "notes": n_notes, "checkins": n_checkins}


def seed_if_empty() -> dict | None:
    init_db()
    with new_session() as session:
        if session.exec(select(Patient)).first():
            return None
        return seed(session)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--reset", action="store_true", help="drop all tables and re-seed")
    args = ap.parse_args()
    if args.reset:
        reset_db()
    result = seed_if_empty()
    print("Database already has data (use --reset to re-seed)." if result is None else f"Seeded: {result}")


if __name__ == "__main__":
    main()
