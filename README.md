# Interim — between-visit AE check-in with contactless vitals as eSource

> **Build in progress on the `interim` branch.** The full README (quickstart, architecture, demo script, screenshots) lands with the final wave. Until then: `CLAUDE.md` is the build brief, `docs/CONTRACTS.md` the interface contracts, `docs/DECISIONS.md` the decision log, `docs/ISSUES.md` the tracker.

HackRU 2026, Regeneron "Best Clinical Trials Solution" track, starter sheet 08 *"How Are You Feeling?"*. MIT licensed. Synthetic data only. Not a medical device; no medical advice.

## What is here today

| Path | Status | What |
|---|---|---|
| `packages/rules/` | done, 263 tests | Deterministic rules engine: PRO-CTCAE composite scoring (Basch 2021 tables), provisional CTCAE grade, red flags, vitals corroboration, escalation ladder, SAE clock, con-med matcher, dedup, SDTM drafting, 29-persona answer key |
| `apps/vitals-bridge/` | done | Vitals adapter: mock source (5 scenarios), timing/confidence gates, WebSocket to the kiosk, batched POST to the API; Presage and Arduino sources |
| `apps/web/` | kiosk done, dashboard next | React kiosk flow; dashboard pages are stubs until the next wave |
| `apps/api/` | next wave | FastAPI system of record: sessions, audit chain, drafts, exports, mock EDC, eval |
| `scripts/fetch_public.py`, `data/public/` | done | ClinicalTrials.gov study record, openFDA LIBTAYO label excerpt and medlist source, CTCAE v5.0 excerpt, cached for offline use |
| `docs/` | done, revised as we go | PRD, NOT_BUILT, WHAT_IT_GETS_WRONG, DEMO, SLIDES, VITALS_SOURCES, CONTRACTS, DECISIONS, ISSUES |
| `backend/`, `presage-bridge/`, `AGENTS.md` | original repo | Omer Khawar's AE Capture Desk backend and Presage bridge. Its chart-note scanner and Presage integration are being ported into the Interim structure (`docs/DECISIONS.md` D-014); these directories move to `legacy/` once parity is verified. See `backend/README.md` to run it standalone. |
