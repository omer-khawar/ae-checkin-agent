# Backend (FastAPI)

See the [main README](../README.md) for the full picture. Quick reference:

```bash
python -m venv .venv
# Windows: .venv\Scripts\Activate.ps1     macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload            # http://localhost:8000/docs
pytest                                   # tests (use a throwaway DB)
python -m scripts.evaluate               # scanner precision/recall vs answer key
python -m app.seed --reset               # reload synthetic demo data
```

| File | What's in it |
|---|---|
| `app/services/items.py` | PRO-CTCAE-style question set, answer scales, spoken-answer parser |
| `app/services/grading.py` | Provisional PRO → CTCAE grade, with the reasoning as text |
| `app/services/safety.py` | Opening disclosure, fixed patient messages (911 / 988 / urgent / human), answer-based escalation rules |
| `app/services/extract.py` | Text scanner: symptom + medication lexicons, negation/history/hypothetical filters, red flags, evidence spans |
| `app/services/vitals.py` | Presage SmartSpectra metrics → summary + plain-English signals vs baseline |
| `app/services/capture.py` | Turns inputs into AE flags / evidence / con-meds / escalations; de-dup; SAE clock; check-in flow |
| `app/services/edc.py` | Draft SDTM AE / CM rows |
| `app/data/` | Synthetic personas, chart notes, answer key (all documented) |
