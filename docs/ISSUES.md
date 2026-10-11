# Issues (lightweight tracker)

Status: `open` | `in-progress` | `done` | `wontfix`. Owner is a role, not a person.

| # | Title | Status | Owner | Notes |
|---|---|---|---|---|
| 1 | Repo skeleton, contracts, CI stub | done | build | CI stub to be replaced by real jobs in #9 |
| 2 | `packages/rules` engine + tables + tests | done | rules | Basch 2021 tables verbatim (D-010); 29 personas match on first replay |
| 3 | `apps/vitals-bridge` mock + stubs + WS + CLI | done | bridge | Presage stub superseded by #14 |
| 4 | `scripts/fetch_public.py` + `data/public` cache + medlist | done | data | medlist regeneration tracked in #16 |
| 5 | `apps/api` endpoints, audit chain, exports, seed | in-progress | api | CONTRACTS §2 + R2.3 + R2.4 |
| 6 | `apps/web` kiosk flow | done | web | Verified: lint, typecheck, tests, build |
| 7 | `apps/web` dashboard pages | open | web | Stubs in place; wave 3 |
| 8 | Personas + `scripts/run_eval.py` + `docs/eval/results.md` | in-progress | eval | Personas done; runner after API |
| 9 | Docker images + compose + CI green | open | infra | After API |
| 10 | Docs: PRD, NOT_BUILT, WHAT_IT_GETS_WRONG, DEMO, SLIDES, VITALS_SOURCES | done | docs | Must be revised for #13/#14 (Better tier now shipped) |
| 11 | Presage SmartSpectra source implementation | superseded | bridge | See #14 |
| 12 | Arduino serial source implementation | open | bridge | Deliberately deferred; stub in place (§7.4) |
| 13 | Port chart-note scanner from `ae-checkin-agent` into `interim_rules.chartscan` + `/notes` API + answer-key eval | open | rules/api | CONTRACTS R2.4; credit Omer Khawar |
| 14 | Implement `presage.ts` from the teammate's verified SDK usage (dynamic import, no package.json dep) | open | bridge | CONTRACTS R2.5, D-016; untested against a live camera until someone has a key |
| 15 | Merge into `omer-khawar/ae-checkin-agent` on branch `interim`, open PR, move `backend/` + `presage-bridge/` to `legacy/` after parity | done | build | D-014, D-015 |
| 16 | Regenerate `medlist.json` from openFDA and re-run persona tests | open | data | Must keep core names and lowercase uniqueness |
| 17 | Seed: 12 participants with backdated check-ins; ingest the 8 synthetic chart notes mapped to P-xxx | open | api | CONTRACTS §5, R2.4 |
| 18 | Dashboard: Notes page + chart-note evidence highlighting (span offsets) | open | web | Wave 3 |
| 19 | Clean-clone rehearsal of `docs/DEMO.md` on a second machine | open | build | Judge criterion: cold start on a laptop that is not the build laptop |
| 22 | Synthea: reproducible NSCLC generation (Docker JRE, pinned jar, seed 20261010), FHIR importer to participant baselines + de-identified notes, independent eval of scanner + con-med matcher vs structured FHIR | in-progress | data | Recommended by Regeneron judges; starter sheet lists Synthea as chart-scan input |
| 23 | Seed participants from Synthea baselines (age, sex, NSCLC stage, comorbidities, active meds, prior chemo, baseline pulse/breathing); ingest one recent Synthea note per participant; timeline shows baseline labeled "Synthea synthetic EHR (simulated)" | open | api/web | Integration wave, after wave 2 releases seed.py and the timeline page |
| 24 | Scanner over-flags templated chief-complaint "chest pain" as emergency (81/238 Synthea notes) and its med lexicon misses most structured meds | open | rules | Measured by the Synthea eval; candidate fix: section-aware "# Medications" parsing through the con-med matcher; decide after numbers are in |
| 25 | Chart scanner: discharge advice ("If symptoms worsen, go to the ER") is flagged as a hospitalization and starts an SAE clock; red-flag detection skips the hypothetical cues symptoms use | open | rules | Found during the notes fix; investigator can stop the clock via PATCH /sae-clocks/{id}/stop meanwhile |
| 26 | Web: investigator "Record seriousness decision" control for clocks with no AE draft (calls PATCH /sae-clocks/{id}/stop) | open | web | Stage 2 |
| 27 | render.yaml still deploys the legacy backend/ | done | infra | Fix with the legacy/ move |
| 21 | Kiosk vitals card: "HRV (RMSSD)" label wraps to two lines and pushes its value sideways at ~1000px width | open | web | Seen in the 2026-10-10 localhost preview; polish pass |
| 20 | Con-med matcher: short tokens vs short names (`from` → `iron` at 0.5; `icon` → `iron` at 0.75) | partially done | rules | 0.7 confidence floor blocks the first; the openFDA build drops names < 5 letters, but core entries (`iron`) are exempt, so the second remains and is documented in WHAT_IT_GETS_WRONG §4 |
