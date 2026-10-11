# AGENTS.md: context for AI coding agents (Claude Code, Codex, Cursor, Copilot, ...)

Read this first, then `README.md`. Keep this file up to date when you change how things work.

## What this project is
HackRU 2026, **Regeneron challenge, starter sheet 08 "How Are You Feeling?"**. A between-visit check-in agent for
clinical-trial patients that captures **adverse events (AEs)** and **concomitant-medication (con-med) changes**, scans
chart notes, uses **Presage SmartSpectra** camera vitals as supporting evidence, and gives a research coordinator a
reviewed, evidence-backed summary (plus draft EDC rows). Team of two: Omer (backend) and his partner (app/frontend).

Judged on (Regeneron): solves a real bottleneck; **functional + runs from a clean clone following the README**;
GitHub repo with **MIT license**; ~3 min demo video; 10-12 slide deck; intuitive UX; clear docs; every output
shows its evidence. **Synthetic / public data only.**

## Repo layout
```
backend/          FastAPI + SQLModel + SQLite API (Python 3.10+)
  app/main.py       app, CORS, startup seeding
  app/models.py     tables: Patient, CheckIn, Answer, VitalsReading, ChartNote, AEFlag, Evidence, ConMedChange, Escalation
  app/schemas.py    request bodies (Presage payloads accept camelCase or snake_case)
  app/routers/      HTTP endpoints: meta, patients, checkins, notes, review (flags/conmeds/escalations/dashboard)
  app/services/     the logic (see below)
  app/data/         synthetic personas, chart notes, answer key (all documented as synthetic)
  scripts/evaluate.py   scanner precision/recall vs answer key
  tests/test_api.py     end-to-end API tests
  start-backend.bat / start-backend.ps1   Windows one-click setup + run
presage-bridge/   Node script: Presage SmartSpectra on a laptop webcam -> POST to backend
frontend/         (the app goes here; create it if it doesn't exist)
render.yaml       Render deploy blueprint
```

## Run / test
Windows: double-click `backend\start-backend.bat` (or follow README).
macOS/Linux:
```bash
cd backend && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
uvicorn app.main:app --reload        # http://localhost:8000/docs ; OpenAPI JSON at /openapi.json
pytest                               # must stay green
python -m scripts.evaluate           # must keep 100% urgent/emergency recall
python -m app.seed --reset           # wipe + reload demo data
```
Before every commit that touches `backend/`: run `pytest` and `python -m scripts.evaluate`.

## Backend services (where to change what)
| File | Responsibility |
|---|---|
| `services/items.py` | PRO-CTCAE-style questions, answer scales, spoken-answer parser (`parse_spoken_answer`) |
| `services/grading.py` | Provisional PRO -> CTCAE grade + human-readable basis (heuristic, labeled as such) |
| `services/safety.py` | Opening disclosure script, FIXED patient-facing messages (911 / 988 / urgent / human), answer-based escalation rules |
| `services/extract.py` | Rule-based text scanner: symptom + med lexicons, negation/history/hypothetical filters, red flags, evidence spans |
| `services/vitals.py` | Presage Metrics -> summary (median of confident samples) + signals vs patient baseline |
| `services/capture.py` | Inputs -> AEFlag/Evidence/ConMedChange/Escalation; cross-source de-dup; SAE clock; check-in flow (`submit_answers`, `next_question`, `complete_checkin`) |
| `services/edc.py` | Draft CDISC SDTM-shaped AE / CM rows |

## Check-in API flow (what the app calls)
1. `POST /api/checkins {patient_id, mode: text|voice|video, respondent: patient|caregiver}` -> `opening_script` + `next_question`
2. Loop: `POST /api/checkins/{id}/answers {answers:[{question_id, value?|text?}]}` -> `patient_message`, `end_checkin`, `needs_details`, `next_question`
   - If `patient_message` is set, show/say it verbatim. If `end_checkin` is true, stop (emergency, patient told to call 911).
   - Unparsed answers come back as `next_question` again (re-ask with options).
3. Optional: `POST /api/checkins/{id}/transcript {text}` and `POST /api/checkins/{id}/vitals {metrics:[...]}` (Presage)
4. `POST /api/checkins/{id}/complete` -> report: symptoms, flags (with evidence), conmed_changes, escalations, vitals, closing_message
Coordinator screens: `GET /api/dashboard`, `/api/escalations`, `/api/flags`, `/api/patients/{id}/summary`, `/api/patients/{id}/edc-draft`;
review with `PATCH /api/flags/{id}`, `/api/conmeds/{id}`, `/api/escalations/{id}`. Full shapes: `/docs` or `/openapi.json`.
Demo patients 1-7 are seeded on first start (7 = Kevin, no consent for voice/video; good for a fresh live text demo).

## Invariants: do NOT break these (they're the challenge's rules of the road)
- Every check-in starts with the automated-agent disclosure (`opening_script`).
- "Talk to a person" at any point -> `human_requested` escalation.
- **No medical advice.** Patient-facing text comes only from the fixed messages in `services/safety.py`. Never generate advice with an LLM.
- Emergencies (chest pain, can't breathe, fainting, seizure, anaphylaxis, stroke signs, bleeding, self-harm) -> 911 message (+988 for self-harm) and `end_checkin: true` on that same answer.
- Voice/video check-ins require `consented_to_contact` (403 otherwise).
- The system only flags *possible* SAEs; the **investigator** sets `serious` and `attribution`.
- Presage vitals never create an AE or an emergency on their own; they attach as evidence to reported symptoms.
- Every flag/con-med keeps its evidence (source, exact quote, offsets, reasoning). New features must keep outputs explainable.
- Grades are provisional and labeled as heuristic (not the validated PRO-CTCAE composite algorithm).

## Conventions
- Python 3.10+ compatible (no 3.11-only syntax). Timestamps are timezone-aware UTC (`models.utcnow()`, `as_utc()`); sqlmodel 0.0.48 rejects naive datetimes.
- Sessions use `expire_on_commit=False` (`db.new_session()`), so objects stay serializable after commit.
- Adding a symptom/med/red-flag pattern in `extract.py`: also add a case to `app/data/answer_key.json`, then run the evaluator.
- Don't change response shapes silently; the frontend depends on them. If you must, update README + tell the other teammate.
- Data: synthetic or public only, documented in `app/data/` with sources. Never commit real patient data.
- Secrets (Presage API key) go in `.env` files, which are gitignored. Never commit them.

## Presage SmartSpectra facts (so you don't go looking for an API that doesn't exist)
- Runs **on-device only**: iOS (Swift), Android (Kotlin), C++, Node.js/Electron (`@smartspectra/node-sdk`). **No browser SDK, no cloud measurement API.**
- Web app -> use `presage-bridge/` (`node bridge.js serve`, then `POST http://localhost:8787/measure {"checkin_id": N}`), or `--demo` for simulated data.
- Native mobile app -> use the platform SDK and POST decoded `Metrics` JSON to `/api/checkins/{id}/vitals`.
- Docs: https://smartspectra.presagetech.com/docs/ ; API key: https://physiology.presagetech.com

## Frontend notes (for whoever builds `frontend/`)
- Read the API base URL from an env var (e.g. `VITE_API_URL` / `NEXT_PUBLIC_API_URL`), default `http://localhost:8000`.
- CORS is open (`CORS_ORIGINS=*`). No auth (demo only).
- You can generate a typed client from `http://localhost:8000/openapi.json`.
- Two audiences: the **patient check-in** (text/voice, shows `patient_message` verbatim) and the **coordinator desk** (dashboard, escalations, flags with evidence highlighted using `span_start`/`span_end`, EDC draft).

## Git workflow (2 people, hackathon speed)
- Omer works in `backend/`, partner in `frontend/`; that keeps merge conflicts rare.
- `git pull --rebase` before starting and before pushing; commit small, push often.
- Don't commit `.venv/`, `node_modules/`, `*.db`, `.env` (already in `.gitignore`).
