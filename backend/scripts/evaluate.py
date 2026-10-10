"""Score the text scanner against the hand-written answer key (app/data/answer_key.json).

    python -m scripts.evaluate           # summary + misses
    python -m scripts.evaluate --json    # machine-readable

Reports precision / recall for possible-AE terms and con-meds, and, most importantly for safety,
whether every case that needed an urgent or emergency escalation got one.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.extract import scan_text  # noqa: E402

DATA = Path(__file__).resolve().parents[1] / "app" / "data"
RANK = {"none": 0, "human_requested": 1, "urgent": 2, "emergency": 3}


def predict(text: str, ref_date: date, kind: str) -> dict:
    scan = scan_text(text, ref_date, detect_human_request=(kind == "checkin_text"))
    levels = ["none"]
    for rf in scan.red_flags:
        # In chart notes we never tell anyone to call 911; everything routes to the coordinator as urgent.
        levels.append("urgent" if kind == "note" else rf.level)
    if scan.human_requested:
        levels.append("human_requested")
    return {
        "ae_terms": sorted({s.term for s in scan.symptoms}),
        "meds": sorted({(m.drug, m.action) for m in scan.meds}),
        "escalation": max(levels, key=RANK.get),
        "serious": any(s.serious_cue for s in scan.symptoms) or any(r.category == "hospitalization" for r in scan.red_flags),
    }


def prf(tp: int, fp: int, fn: int) -> dict:
    p = tp / (tp + fp) if tp + fp else 1.0
    r = tp / (tp + fn) if tp + fn else 1.0
    f = 2 * p * r / (p + r) if p + r else 0.0
    return {"precision": round(p, 3), "recall": round(r, 3), "f1": round(f, 3), "tp": tp, "fp": fp, "fn": fn}


def evaluate() -> dict:
    key = json.loads((DATA / "answer_key.json").read_text(encoding="utf-8"))
    notes = {n["id"]: n for n in json.loads((DATA / "chart_notes.json").read_text(encoding="utf-8"))["notes"]}
    ae = {"tp": 0, "fp": 0, "fn": 0}
    med = {"tp": 0, "fp": 0, "fn": 0}
    action_hits = action_total = 0
    esc_exact = urgent_needed = urgent_caught = emerg_needed = emerg_caught = over = 0
    serious_needed = serious_caught = 0
    misses, rows = [], []

    for case in key["cases"]:
        if case["kind"] == "note":
            n = notes[case["note_id"]]
            text, ref = n["text"], date.fromisoformat(n["note_date"])
        else:
            text, ref = case["text"], date(2026, 10, 10)
        exp, got = case["expected"], predict(text, ref, case["kind"])

        e_terms, g_terms = set(exp["ae_terms"]), set(got["ae_terms"])
        ae["tp"] += len(e_terms & g_terms)
        ae["fp"] += len(g_terms - e_terms)
        ae["fn"] += len(e_terms - g_terms)

        e_meds = {tuple(m) for m in exp["meds"]}
        e_drugs, g_drugs = {d for d, _ in e_meds}, {d for d, _ in got["meds"]}
        med["tp"] += len(e_drugs & g_drugs)
        med["fp"] += len(g_drugs - e_drugs)
        med["fn"] += len(e_drugs - g_drugs)
        for d, a in e_meds:
            if d in g_drugs:
                action_total += 1
                action_hits += (d, a) in set(got["meds"])

        er, gr = RANK[exp["escalation"]], RANK[got["escalation"]]
        esc_exact += er == gr
        if er >= RANK["urgent"]:
            urgent_needed += 1
            urgent_caught += gr >= RANK["urgent"]
        if er == RANK["emergency"]:
            emerg_needed += 1
            emerg_caught += gr == RANK["emergency"]
        over += gr > er
        if exp.get("serious"):
            serious_needed += 1
            serious_caught += got["serious"]

        problems = []
        if e_terms != g_terms:
            problems.append(f"AE missed={sorted(e_terms - g_terms)} extra={sorted(g_terms - e_terms)}")
        if e_meds != set(got["meds"]):
            problems.append(f"meds expected={sorted(e_meds)} got={got['meds']}")
        if er != gr:
            problems.append(f"escalation expected={exp['escalation']} got={got['escalation']}")
        if exp.get("serious") and not got["serious"]:
            problems.append("missed possible-SAE cue")
        rows.append({"id": case["id"], "ok": not problems, "problems": problems})
        if problems:
            misses.append({"id": case["id"], "text": text, "problems": problems})

    return {
        "cases": len(key["cases"]),
        "ae_terms": prf(**ae),
        "conmeds": {**prf(**med), "action_accuracy": round(action_hits / action_total, 3) if action_total else None},
        "escalation": {
            "exact_match": round(esc_exact / len(key["cases"]), 3),
            "urgent_or_emergency_recall": f"{urgent_caught}/{urgent_needed}",
            "emergency_recall": f"{emerg_caught}/{emerg_needed}",
            "over_escalations": over,
        },
        "possible_sae_recall": f"{serious_caught}/{serious_needed}",
        "per_case": rows,
        "misses": misses,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    r = evaluate()
    if args.json:
        print(json.dumps(r, indent=2))
        return
    a, m, e = r["ae_terms"], r["conmeds"], r["escalation"]
    print(f"Answer key: {r['cases']} cases (synthetic chart notes + check-in utterances)\n")
    print(f"Possible-AE terms   precision {a['precision']:.2f}  recall {a['recall']:.2f}  F1 {a['f1']:.2f}   (TP {a['tp']}, FP {a['fp']}, FN {a['fn']})")
    print(f"Con-med drugs       precision {m['precision']:.2f}  recall {m['recall']:.2f}  F1 {m['f1']:.2f}   action accuracy {m['action_accuracy']}")
    print(f"Escalation          urgent/emergency caught {e['urgent_or_emergency_recall']}   emergencies caught {e['emergency_recall']}   "
          f"exact level {e['exact_match']:.2f}   over-escalations {e['over_escalations']}")
    print(f"Possible SAE cues   {r['possible_sae_recall']}")
    if r["misses"]:
        print("\nMisses:")
        for miss in r["misses"]:
            print(f"  [{miss['id']}] {miss['text']}")
            for p in miss["problems"]:
                print(f"      - {p}")


if __name__ == "__main__":
    main()
