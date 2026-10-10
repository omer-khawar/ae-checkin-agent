# What Interim gets wrong

> Judges have said they are impressed when a team can name one thing its tool gets wrong and why. Here are fourteen, each with a concrete failure example you can reproduce, why we accepted it for v0.1, and how we would measure it. Nothing here is hidden in the UI: every limitation that affects a number is labeled next to that number (provisional, simulated, not RxNorm, mock).

Read with `docs/NOT_BUILT.md` (scope we chose not to build) and `docs/PRD.md` §7 (non-goals).

---

## 1. The composite → CTCAE grade crosswalk is an approximation, not a validated instrument

**What we do.** Each item's attribute answers map to a 0–3 composite following the published PRO-CTCAE composite grading algorithm (Basch E, et al. *Clin Trials* 2021;18(1):104–114, [doi:10.1177/1740774520975120](https://doi.org/10.1177/1740774520975120)), stored in `packages/rules/data/composite_scoring.json`. The composite is then mapped 0→no AE, 1→G1, 2→G2, 3→G3 by `packages/rules/data/composite_to_grade.json`.

**Where it breaks** (every mapping below was replayed through `interim_rules.engine.evaluate_checkin` on 2026-10-10).
- The PRO-CTCAE composite was designed to summarize patient-reported attributes, **not** to equal a clinician-assigned CTCAE grade. NCI says so. CTCAE grades frequently depend on clinical criteria the participant cannot report: CTCAE v5.0 Diarrhea G3 is "increase of ≥7 stools per day over baseline; hospitalization indicated", while our single-attribute `diarrhea` item maps frequency "Almost constantly" (4) → composite 3 → **G3** with no stool count at all ("Frequently" (3) → composite 2 → G2; "Occasionally" (2) → composite 1 → G1). Single-attribute items use the attribute-specific published maps (`single_attribute_by_attribute` in `composite_scoring.json`: frequency 0,1,1,2,3; severity 0,1,2,3,3), so the same number means different things on different items: "Moderate" itching is G2, "Occasionally" diarrhea is G1.
- The published tables weight interference heavily. Shortness of breath **Severe** with interference **Not at all** is composite 1 → **G1** (it still reaches Tier 3 through the `redflag.severe_dyspnea` red flag, which looks at severity alone); Severe fatigue with no interference is G1 and Tier 0, full stop. Severe with "Somewhat" interference is composite 2 → G2; only Severe with "Quite a bit" or more is G3. A participant who does not understand the interference question can under-grade a real problem by two grades.
- `rash` and `fever_or_chills` are presence-only items in our set (presence 1 → composite 1 → **G1**). A blistering rash covering most of the body, which CTCAE would grade 3 (>30% BSA with moderate/severe symptoms), is **G1** in Interim because the item has no severity attribute. The participant has no way to say more.
- Composite 3 → G3 triggers Tier 2 ("Nurse call today"). That is deliberately conservative for a kiosk, but it means every "Severe / Quite a bit" answer is a same-day call.
- `composite_scoring.json` declares `reproduced_verbatim: true`: its 179 attribute combinations were copied row-for-row from the reference implementation of the published algorithm (the ProAE R package), not re-derived from the paper's prose. Two things in that file are **ours**, not the paper's: the `presence` convention (present → composite 1) and the composite → grade crosswalk. Treat the grade as *our reading*, not NCI's.

**Why we accepted it.** The grade is labeled **provisional, investigator to confirm** everywhere it appears, it never leaves the system without a human confirm, and the investigator owns `AETOXGR` in the confirmed record. A kiosk that under-grades a rash still gets the rash into the queue, which is the problem we are solving.

**How we would measure it.** Agreement between Interim's provisional `AETOXGR` and the investigator's confirmed grade on the same events (weighted Cohen's κ; per-grade confusion matrix, which the eval harness already produces for personas but which is self-referential until real adjudication exists). Track the edit rate on `AETOXGR` specifically (audit `draft.edited` events whose `fields` include `AETOXGR`).

## 2. Camera vitals are confounded by talking, motion and lighting

**What we do.** The bridge publishes pulse only after 12 s and breathing after 30 s of continuous collection, keeps every sample with its confidence and `qualityFlags`, and the rules ignore any sample below `min_confidence` (0.6) or outside plausibility (pulse 35–180, breathing 5–45). The `low_quality` and `dropout` mock scenarios exist so the UI's degraded paths get exercised.

**Where it breaks.**
- **A participant who talks** during the check-in (reading questions aloud, asking a companion) corrupts breathing-rate estimation; the vendor's own capture guidance says talking degrades breathing. A real source may still report a confident-looking value. The mock cannot simulate "confident but wrong"; it only simulates "flagged".
- **Motion**: shifting in the chair at second 40 can produce a transient breathing estimate of 25. Because corroboration uses the **session maximum** of eligible values (CONTRACTS §1.4), a single artifact ≥ 24 is enough to fire `corr.tachypnea_dyspnea` and bump the tier (see item 5).
- **Lighting and clothing**: low light, backlighting, dark clothing or fine stripes reduce signal quality; the mock's `low_quality` scenario models flags, not the bias.
- **Vendor valid ranges vs our thresholds**: the Presage documentation we captured in `docs/VITALS_SOURCES.md` states pulse is valid 40–110 BPM. Our tachycardia rule fires at **≥ 110**, i.e. at the top edge of the vendor's valid range. With a real source, readings above 110 may arrive with low confidence or validation flags, so `corr.tachycardia_dyspnea` may rarely fire on **measured** data even when the participant is genuinely tachycardic. The post-exercise demo works today only because the mock is not range-limited.

**Why we accepted it.** Vitals are context attached to the record. They never change a grade, they can only raise the escalation tier by one step, and every sample is auditable with its confidence. A wrong vitals value costs a nurse a phone call; it cannot create or hide an AE.

**How we would measure it.** A capture study against reference devices (pulse oximeter for pulse, capnography or a chest band for breathing) under controlled conditions (still/silent, talking, moving, low light), reporting Bland–Altman limits of agreement per condition, plus the false-corroboration rate: the share of `corr.*` firings where the reference device disagreed. Until then, "MEASURED" means "measured by the named source with the stated confidence", not "verified".

## 3. Corroboration thresholds are fixed, not personalized to baseline

**What we do.** `packages/rules/data/vitals_corroboration.json` uses population thresholds: breathing ≥ 24 and pulse ≥ 110.

**Where it breaks.**
- An NSCLC participant with COPD whose resting breathing rate is 22 is permanently two breaths from a corroboration bump; a mild cold tips them into "Nurse call today" every time they report moderate dyspnea.
- A fit participant with a resting pulse of 48 who reports moderate dyspnea at 96 bpm has **doubled** their heart rate and no rule fires.
- Beta-blocker users (metoprolol is in our own med list) rarely reach 110 bpm regardless of distress.

**Why we accepted it.** Fixed thresholds are easy to explain in a three-minute demo ("here is the number, here is the table"). Personalization needs a baseline capture at enrollment and a validation of the delta rule, which is more than a hackathon. The `Participant.baseline_vitals_json` field is reserved for it (`docs/NOT_BUILT.md` §12).

**How we would measure it.** Re-run the corroboration rules on the same sessions with a delta-from-baseline variant (e.g. breathing ≥ baseline + 6, pulse ≥ baseline × 1.3) and compare corroboration rates and nurse-adjudicated appropriateness; report precision of "tier bump was warranted" for each rule family.

## 4. The con-med matcher is string distance over 300 names, and it has both misses and false positives

**What we do.** `packages/rules/interim_rules/conmed.py` normalizes whitespace and case, then tries exact → case-insensitive → Levenshtein ≤ 2 against `packages/rules/data/medlist.json` (300 entries as shipped: 194 generic and 106 brand names; 59 are hand-curated core entries from `data/public/medlist_build_config.json`, which include the 43 names CONTRACTS §1.6 requires plus common supplements and Regeneron's dupilumab/Dupixent and cemiplimab/Libtayo; the other 241 are the most frequent openFDA label generics and their brands, built by `scripts/fetch_public.py --build-medlist`), trying the whole string and then each whitespace token of ≥ 4 characters. A Levenshtein proposal below confidence 0.7 is demoted to unmatched. Ties at the same distance go to the shortest name, then alphabetical. Brand names normalize to the generic. Unmatched text stays verbatim and is flagged for the coordinator. No other NLP.

**Where it breaks** (every row below was computed on 2026-10-10 with `interim_rules.conmed.match_conmed` against the shipped `medlist.json`; re-run them after regenerating the list, because adding a name can turn a documented miss into a hit):

| Participant typed | Result | Problem |
|---|---|---|
| `loritidene` | **unmatched** (nearest `loratadine`, distance 3) | Three edits is one too many; the coordinator codes it by hand. |
| `lorotadinee` | `loratadine`, confidence 0.82 | Correct, but only because the distance happens to be 2; the boundary is arbitrary. |
| `vitamin k` | `vitamin c`, confidence 0.89 | **False positive**: one letter turns one supplement into another. `vitamin d` and `vitamin e` are equally close; the tie-break (shortest, then alphabetical) picks `vitamin c`, which is not a clinical reason. |
| `lasik` | `furosemide`, confidence 0.80 | **False positive**: eye surgery becomes a diuretic via the brand `lasix`. |
| `irony`, `icon` | `iron`, confidence 0.80 / 0.75 | Non-drug words match a 4-letter supplement name. The openFDA build excludes names shorter than 5 letters for this reason, but `iron` is a hand-curated core entry and core entries are exempt. |
| `alive` | `naproxen`, confidence 0.80 | A non-drug word matches the brand `aleve` and is normalized to its generic. |
| `pepsi` | **unmatched** (nearest `pepcid`, distance 2, confidence 0.67) | Caught by the 0.7 confidence floor: a 6-letter name two edits away is never proposed. The floor is a blunt instrument; it also blocks genuine two-edit typos of six-letter drug names. |
| `vit d`, `d3`, `zinc`, `tums`, `sudafed`, `flonase` | **unmatched** | Abbreviations miss (tokens shorter than 4 characters are never tried alone), and names simply absent from a 300-entry list miss too. |
| `Advil PM` | `ibuprofen`, 1.0 (case-insensitive hit on the `advil` token) | **Loses the diphenhydramine** in the combination product. |
| `Tylenol Extra Strength 500 mg` | `acetaminophen`, 1.0 (via the `tylenol` token) | Dose, strength and formulation are discarded; `CMDOSE`/`CMDOSU` are not drafted. |
| `my blood pressure pill` | **unmatched** (nearest `lopressor`, distance 14) | Correct behavior, but the coordinator learns nothing. |

What the shipped list happens to get right is also luck of the list: `vitamin c`, `vitamin b12`, `fish oil`, `augmentin` (→ `amoxicillin-clavulanate`) and `dupixent` (→ `dupilumab`) are exact matches today only because we hand-added them to the core list after the first openFDA build turned `vitamin b12` into `methylphenidate` (the token `vitamin` is two edits from the brand `ritalin`, at exactly the 0.71 confidence the floor allows). A regenerated list without those core entries would reproduce that mistake.

**Why we accepted it.** The verbatim text is always stored unchanged (`CMTRT`), the match is a *suggestion* with a confidence and a match kind the coordinator sees, unmatched is a first-class state, and the alternative (an LLM) was ruled out on purpose. The list is labeled "NOT RxNorm" in its own `rationale`.

**How we would measure it.** Precision and recall of `CMDECOD` against coordinator-coded WHO-Drug or RxNorm on a labeled set of free-text entries (including a synthetic misspelling set), stratified by match kind; the share of entries that end unmatched; and the false-positive rate at confidence ≥ 0.8, which is the band where a coordinator is most likely to accept the suggestion without reading it.

## 5. Corroboration uses the session maximum, so one spike is enough

**What we do.** `max(eligible breathing)` and `max(eligible pulse)` over the session are compared to the thresholds (documented in the table `rationale`).

**Where it breaks.** A 90-second check-in with 60 eligible breathing samples at 15–17 and one sample at 25 (the participant leaned forward to read) fires `corr.tachypnea_dyspnea`. The Why panel shows the value and timestamp, so a nurse can see it was a single sample, but the tier has already been bumped.

**Why we accepted it.** For a demo and for safety, over-escalating by one tier on a spike is the cheaper error; a median would hide a genuine short tachypneic episode.

**How we would measure it.** Compare max, 90th percentile and median rules on recorded sessions against adjudicated "true tachypnea during capture"; report the bump rate and precision of each.

## 6. The 7-day de-duplication window is a heuristic

**What we do.** `packages/rules/data/dedup.json` sets `window_days: 7`. A new report of the same `AEDECOD` within 7 days of an open AE's last report is linked as a follow-up; otherwise a new AE is drafted.

**Where it breaks.**
- **False merge:** a rash that resolved on day 2 and a *different* rash (new site, new morphology) that started on day 6 are one AE in Interim, with the original `AESTDTC`.
- **False split:** a continuous cough reported on day 1 and next reported on day 9 (the participant skipped a week) becomes two AEs.
- Merging is at the `AEDECOD` level only: G1 → G3 progression is a follow-up with the new grade, which is right, but the follow-up draft's `AESTDTC` is the first report date even if the participant would say "this got bad yesterday".

**Why we accepted it.** The link is visible in the UI (`INTERIM_FOLLOWUP_OF`, the `ae_links` list), the coordinator can reject the follow-up and confirm a new AE instead, and seven days matches the instrument's recall window.

**How we would measure it.** Coordinator adjudication of every linked pair and every new-AE decision within 14 days of an open AE: false-merge and false-split rates; sensitivity of both to window length (3, 7, 14 days) using the eval harness with a modified `dedup.json`.

## 7. Demo authentication is not production authentication

**What we do.** Three seeded users (`coordinator`, `investigator`, `admin`) share `DEMO_PASSWORD`; tokens are HMAC-signed `username.role.exp.sig` bearer tokens kept in `sessionStorage`; roles are enforced server-side.

**Where it breaks.** Anyone with the shared password is "the investigator", so `AEREL`/`AESER` decisions are attributable to a role, not a person; tokens cannot be revoked before expiry; there is no MFA, no lockout, no password lifecycle; confirmations are audited actions, not Part 11 electronic signatures.

**Why we accepted it.** Role separation, not identity, is what the demo needs to prove (the coordinator *cannot* set attribution, server-side). `docs/PRD.md` §11 lists exactly what SSO and per-user identity add; the audit schema already has `actor_id`/`actor_role`.

**How we would measure it.** A threat-model checklist mapped to 21 CFR Part 11 §11.10 controls and an external penetration test before any non-synthetic use.

## 8. Everything depends on honest, understood self-report, and free text is never read by the system

**What we do.** Grades and red flags come only from the structured answers. The "anything else" field is stored verbatim and never parsed; it raises a tier floor (`redflag.other_text_with_severe`) **only** when it is non-empty **and** some item is severe, and then only as "human read".

**Where it breaks.** A participant who answers **No** to "were you admitted to a hospital or seen in an emergency room?" but types "went to the ER Tuesday for my breathing" in the free-text box, with no item marked severe, gets **Tier 0, no SAE clock**. The text is in the record and visible on the detail page, but nothing escalates it. Likewise a participant who does not understand "interference" answers "Not at all" and under-grades a real problem.

**Why we accepted it.** Parsing free text is where an LLM would enter the product. The alternative, escalating every non-empty free text, would make the field useless.

**How we would measure it.** Audit a random sample of free-text entries per month for missed escalation triggers; track how often a coordinator's confirmed grade or seriousness differs from the provisional one in sessions with non-empty free text versus without.

## 9. The 7-day recall window does not cover a 21-day dosing interval

**What we do.** Every item asks about "the last 7 days", following PRO-CTCAE.

**Where it breaks.** If a site runs check-ins only on infusion days (q3w for cemiplimab), days 8–21 after the previous check-in are never asked about. A nausea episode on day 10 that resolved by day 15 is invisible.

**Why we accepted it.** The recall window is the instrument's, and shortening or lengthening it would invalidate the structure we modeled. The fix is scheduling (weekly check-ins), which is a site decision and out of scope (`docs/NOT_BUILT.md` §17).

**How we would measure it.** Compare AEs captured per participant-month (`docs/PRD.md` M2) under weekly versus per-visit kiosk schedules.

## 10. Timestamps and the audit chain are only as strong as their anchors

**What we do.** Answers carry `ts_client` (kiosk clock) and `ts_server` (API clock); rules use server time. The audit chain is SHA-256 over the previous hash and the canonical JSON of each event; `GET /audit/verify` walks it.

**Where it breaks.** A kiosk with a wrong clock produces misleading `ts_client` values (the server time is authoritative but the UI shows both). The chain proves *internal* consistency: an attacker with write access to the database can rewrite every row and recompute every hash, and `verify` will still say OK. Only an externally anchored head hash detects that.

**Why we accepted it.** The bundle manifest already records `audit_head_hash`; emailing or printing that value after each export is an operational control a site can adopt today.

**How we would measure it.** Periodic comparison of the live head hash against the last externally recorded one; clock-drift monitoring on kiosks via `/health` `time_utc`.

## 11. "Treat simulated as measured" is a loaded footgun

**What we do.** The admin toggle (default OFF) lets simulated vitals satisfy the corroboration gate so the demo can show a tier change without a real sensor. It shows a warning, is audited as `settings.changed`, fires a visible `vitals.simulated_as_measured` warning rule in every affected result, and **never** changes `VSMETHOD`/`INTERIM_SOURCE`, which still say Simulated.

**Where it breaks.** If someone leaves it ON, every mock session can bump a tier. The label in exports is honest; the tier is not.

**Why we accepted it.** The demo needs it until the Presage adapter exists (`docs/NOT_BUILT.md` §8). The toggle is a per-run `settings_override` in the eval harness so personas never depend on the global setting (`docs/DECISIONS.md` D-004).

**How we would measure it.** Count sessions where `vitals.simulated_as_measured` fired outside a demo window; alert if non-zero.

## 12. Grade 3 is the ceiling, so the ladder, not the grade, carries emergencies

**What we do.** `max_assignable_grade: 3`. Life-threatening situations reach Tier 3 only via red flags (severe dyspnea, hospitalization) and the fixed stop screen.

**Where it breaks.** A participant having a genuine emergency at the kiosk is shown a static screen telling them to call 911. That is the right text and the only text we will ever show, but a kiosk is not an emergency pathway, and a participant who does not mark dyspnea as "Severe" gets no stop screen.

**How we would measure it.** Time from Tier 3 page to acknowledgment (`Escalation.seconds_to_ack`), and any Tier 3 session whose confirmed outcome was a hospitalization not reported at the kiosk.

## 13. Our items are not the NCI items, and the demo data is synthetic

**What we do.** Ten hand-written items modeled on PRO-CTCAE (`docs/PRD.md` §9); twelve synthetic participants; mock MedDRA codes; a mock EDC endpoint.

**Where it breaks.** No psychometric validation applies to our wording; `AEDECOD` values are CTCAE term names with mock codes, not MedDRA PTs; the `INTERIM_*` supplemental variables would need to move to SUPP-- domains in a real submission; the mock EDC validates the column set, nothing else; eval "100%" means the engine agrees with the answer key *we* wrote, verified by hand against the engine, which is a regression guarantee, not a clinical validation.

**How we would measure it.** Replace the items with NCI's under its Terms of Use, code against licensed MedDRA/RxNorm, and re-run the eval against an independently adjudicated answer key.

## 14. The mock vitals look physiological, but they are a model of a model

**What we do.** The mock emits autocorrelated noise around scenario means (`apps/vitals-bridge/src/sources/mock.ts`), and the seed replays a resting series per session (`data/synthetic/README.md`). Every sample is `isMeasured: false` and labeled **SIMULATED** in the kiosk, dashboard and exports.

**Where it breaks.** Nothing in the mock reflects the error structure of a real optical sensor (drift, dropouts correlated with motion, bias at low light), so the corroboration demo shows the *mechanism*, not the *reliability*, of vitals-based escalation.

**How we would measure it.** Replace the mock with the Presage adapter and re-run `docs/DEMO.md` step 5 with real jumping jacks, then items 2 and 3 above apply.
