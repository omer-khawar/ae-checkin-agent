# legacy/ — the original AE Capture Desk

This folder keeps the repository's first build, by Omer Khawar (MIT), exactly as it was before the Interim merge on 2026-10-10. It is not part of the running product; it is kept for history and credit.

| Path | What it was | Where it lives now |
|---|---|---|
| `backend/` | FastAPI "AE Capture Desk": check-in flow, rule-based chart-note scanner (`app/services/extract.py`), answer key, evaluator | The scanner is ported to `packages/rules/interim_rules/chartscan.py`, its lexicons to `packages/rules/data/chartscan_*.json`, and its 25-case answer key to `packages/rules/data/chartscan_answer_key.json`, reproduced at 100% by `packages/rules/tests/test_chartscan.py`. The API is `apps/api`. |
| `presage-bridge/` | Node script running Presage SmartSpectra SDK 3.4.0 on a laptop webcam | Ported to `apps/vitals-bridge/src/sources/presage.ts` and `presageMap.ts`, which use the SDK calls and payload field names this script verified. |
| `AGENTS.md` | Coding-agent context for the original backend | Superseded by the root `CLAUDE.md` (read §00 first). |

Why the move: see `docs/DECISIONS.md` D-014. Both builds were deterministic and overlapped heavily; Interim's structure became primary and the pieces above were carried into it with credit.

To run the original backend on its own, follow `legacy/backend/README.md` from inside `legacy/backend`.
