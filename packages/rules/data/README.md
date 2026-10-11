# Rule tables — provenance

Every file here is read by `interim_rules.tables` and carries a top-level `source` and
`rationale`. Code reads these tables; code never hardcodes a clinical number. This note records
where the two tables derived from public reference data came from and how to regenerate them.

## `composite_scoring.json` (PRO-CTCAE composite grading, Basch et al. 2021)

* **Paper:** Basch E, Becker C, Rogak LJ, et al. *Composite grading algorithm for the National
  Cancer Institute's Patient-Reported Outcomes version of the Common Terminology Criteria for
  Adverse Events (PRO-CTCAE).* Clin Trials 2021;18(1):104–114. doi:10.1177/1740774520975120.
  PMID 33258687 (PMCID PMC7878323).
* **Rows:** reproduced row-for-row from the reference implementation of that algorithm, the
  `comp_tab` object (179 rows) inside the CRAN package **ProAE** v1.0.4 (Langlais B, Noble B,
  Truman M, Voss M, Dueck A — the PRO-CTCAE scoring tools from the Mayo Clinic group that
  co-authored the paper). Retrieved 2026-10-10 from
  `https://cran.r-project.org/src/contrib/ProAE_1.0.4.tar.gz` → `ProAE/R/sysdata.rda`.
* **Regenerate:** download the tarball, read `sysdata.rda` with R (`load()`) or Python
  (`pyreadr`), export `comp_tab` as CSV (`frq,sev,int,comp,rank`), and map `rank` 7 →
  `three_attribute`, 4 → `two_attribute_freq_sev`, 6 → `two_attribute_sev_int`,
  5 → `two_attribute_freq_int`, 1/2/3 → `single_attribute_by_attribute.frequency/severity/interference`.
  The published zero rule (gating attribute = 0 → composite 0) is encoded in `zero_gate`.
* **Not published:** the `presence` mapping (yes/no items are not composite-graded by the
  published algorithm). `present → 1` is Interim's convention and is labeled as such.

## `ctcae_terms.json` (CTCAE v5.0 term rows)

* **Source:** NCI CTCAE v5.0 spreadsheet, published 2017-11-27:
  `https://evs.nci.nih.gov/ftp1/CTCAE/CTCAE_5.0/CTCAE_v5.0_2017-11-27.xlsx`, sheet
  *CTCAE v5.0 Clean Copy*. Retrieved 2026-10-10.
* **Rows:** the 10 terms this instrument uses (Dyspnea, Cough, Fatigue, Nausea, Diarrhea,
  Rash maculo-papular, Pruritus, Arthralgia, Fever, Mucositis oral). Grade 1–5 texts and the
  term definition are verbatim; blank grades (`-`) are `null`.
* **MedDRA:** the public CTCAE file lists a MedDRA code per term, but MedDRA is a licensed
  dictionary, so Interim ships a clearly-labeled `meddra_code_mock` instead.

## `medlist.json`

Generated brand/generic names (lowercase), 300 as shipped: `scripts/fetch_public.py --build-medlist`
builds it from the cached openFDA drug-label name counts plus the hand-curated `core_entries` in
`data/public/medlist_build_config.json` (always present, exempt from the length rules). It is
**not** RxNorm. Matcher parameters live separately in
`conmed_matching.json` so a regeneration cannot change matching behavior.

## Everything else

`proctcae_items.json`, `gate_questions.json`, `composite_to_grade.json`, `red_flags.json`,
`vitals_corroboration.json`, `escalation_ladder.json`, `seriousness.json`, `dedup.json`,
`conmed_matching.json` and `rules_catalog.json` are written by the Interim team from CLAUDE.md
§3.4 and CONTRACTS.md §1, with the regulatory references (ICH E2A, 21 CFR 312.32) named in
each file's `source`. Three engineering guards added after review live in the same tables so
that they are visible without reading code: `vitals_corroboration.json: min_window_s`
(the CLAUDE.md §3.3 / §7.1 timing gates, 12 / 30 / 60 s) and `simulated_sources` (`mock` is
simulated whatever `isMeasured` says), `conmed_matching.json: min_levenshtein_confidence`
(0.7; keeps `ondansatrone -> ondansetron`, drops `from -> iron`) and `dedup.json:
max_future_skew_s` (300 s; same-server clock skew). `personas.json` (the eval answer key) is
owned by the eval harness; its vitals samples follow the bridge contract (`windowS` = window
of the longest-window metric present, so 60 once HRV is published).

## `chartscan_lexicon.json`, `chartscan_red_flags.json`, `chartscan_answer_key.json` (chart-note scanner)

* **Source:** ported from `backend/app/services/extract.py`, `backend/app/data/answer_key.json`
  and `backend/app/data/chart_notes.json` of `omer-khawar/ae-checkin-agent` (Omer Khawar, MIT),
  2026-10-10 (CONTRACTS.md R2.4, decision D-014). Read by `interim_rules.chartscan` through
  `tables.load_table`; not part of `tables.TABLE_NAMES` (the scanner owns them, as the eval
  harness owns `personas.json`).
* **`chartscan_lexicon.json`:** `symptom_patterns` (29 CTCAE v5.0 term names → regex lists; the
  ten kiosk terms of `ctcae_terms.json` are among them, so note and check-in findings de-duplicate
  by term), `med_patterns` (43 lowercase generics → brand / abbreviation regexes; not RxNorm), and
  `text_normalization` (typographic punctuation → ASCII, one code point each, applied before
  matching so offsets are preserved), `scope` (the NegEx word scope and the character windows
  around a term), and one section per context cue (`negation`, `pseudo_negation`, `terminators`,
  `historical`, `hypothetical`, `post_negation`, `resolved`, `severity_words`, `explicit_grade`
  (capped at `composite_to_grade.json` `max_assignable_grade`), `default_grade`, `stool_count`,
  `bsa`, `worsening`, `hospital`, `number_words`, `duration`, `relative_days`, `med_started` /
  `med_stopped` / `med_changed` / `med_negated`, `allergy`, `indication`, `human_request`), each
  with its own `source` / `rationale`. Rows changed or added after the 2026-10-10 review say so
  in their `source`. The grade bands for diarrhea
  (stools/day over baseline) and maculo-papular rash (% BSA) are the CTCAE v5.0 definitions.
  Patterns compile with `re.IGNORECASE`; `(?-i:...)` marks a case-sensitive abbreviation.
* **`chartscan_red_flags.json`:** 16 red-flag rules (`category`, `level` emergency / urgent,
  `seriousness`, `pattern`, `reason`) and the ordered `escalation_levels`. The fever rule embeds
  the lexicon's `temperature_high` pattern and the hospitalization rule equals the lexicon's
  `hospital` pattern; `tests/test_chartscan.py` fails if the copies drift.
* **`chartscan_answer_key.json`:** 39 SYNTHETIC cases (8 chart notes with their text inline,
  31 participant utterances; `T18`–`T31` were added after the 2026-10-10 review, one per fix,
  each with a `review_fix` note) with the expected AE terms, con-meds, escalation level and SAE
  cue. Subject ids were remapped `101-00x` → `P-00x` (`subject_mapping`); the same eight notes
  live in `data/synthetic/chart_notes.json` for the seed (unchanged by the review), and the tests
  keep both files identical.
* **Regenerate / extend:** hand-edited. Add an answer-key case for every new pattern and run
  `pytest tests/test_chartscan.py` (pass criterion: 100% on the shipped key).

## `protocol_rules.json`, `irae_mapping.json` (protocol-aware rules, CONTRACTS.md R3.1)

* **Source:** EMPOWER-Lung 1 clinical study protocol R2810-ONC-1624 Amendment 9 (Regeneron;
  NCT03088540), posted on ClinicalTrials.gov at
  `https://cdn.clinicaltrials.gov/large-docs/40/NCT03088540/Prot_000.pdf` (pdf sha256
  `f80249119e17839ad53f432d4bc6ed591aa42221b596feb7c5ca89047d6f0ae7`). The pages Interim cites
  (printed pages 68–69 and 90–92) are cached verbatim in
  `data/public/empower_lung1_protocol_excerpt.json` (repository root). Decision D-025.
* **Citations:** every entry carries `protocol_ref: {section, printed_page}`; every `quote`,
  `exception_text`, `further_exceptions_text` and `condition` is the protocol's own wording
  (curly apostrophes and the en dash in "protocol–defined" kept), and
  `tests/test_protocol_tables.py` checks each one, whitespace-normalized, against the cited page
  of the excerpt. The corticosteroid exception is quoted, never paraphrased: "except in the case
  of a life-threatening emergency and/or to treat an irAE."
* **`protocol_rules.json`:** `aesi` (24 h reporting, label "possible AESI, investigator to
  confirm", four criteria from §9.4.3 p. 92, two of which the kiosk cannot detect and are marked
  `detectable_from_kiosk: false`), `sae_reporting_hours` (24, §9.4.2 p. 91; must equal
  `seriousness.json`), `ae_reporting_window_days_after_last_dose` (90, §9.4.1 p. 91;
  informational; the quoted sentence includes "or until the patient commences another
  anti-cancer systemic therapy, whichever is earlier", applied through
  `ProtocolContext.new_anticancer_therapy_date`), `conmeds.prohibited / discouraged / permitted` (§7.7.1–7.7.2 p. 69; lowercase
  generics, plus brand / biosimilar `aliases` and category `match_terms`, which are Interim team
  additions labeled in each entry's `rationale`; `is_category` marks the investigational-agent
  and palliative-radiation entries), `conmeds.prohibited_tier_floor` (2),
  `conmeds.non_systemic_qualifiers` (Interim team addition: `cream`, `drops`, `inhaler` ... keep
  a topical steroid from being flagged), `cm_required_fields` (§7.7 p. 69) with the plain labels
  and the "as appropriate" date reading.
* **`irae_mapping.json`:** one row per kiosk item (exactly the shipped items; the loader fails
  otherwise) with `potentially_immune_related`, `irae_category` (pneumonitis, colitis,
  dermatologic, endocrine, musculoskeletal, mucosal, none) and a rationale. The protocol's own
  examples are "rash, colitis, elevated transaminases, or endocrine" (p. 91–92); the pneumonitis
  (shortness of breath) and musculoskeletal (joint pain) rows follow CLAUDE.md §00.1 and the PD-1
  class, because the protocol's irAE guidance (§7.3.1.2, Appendix 3) is not in the excerpt; their
  rationales say so.
* **Regenerate / extend:** hand-edited. To add a drug, add an entry under the right level with a
  `protocol_ref` and the verbatim `quote` from the excerpt; a name may appear in one level only
  (the loader rejects duplicates). Keep `medlist.json` in step (brands the medlist lacks still
  match through the protocol table's aliases).

## Generated text and time-saved estimate

These three tables belong to their modules, not to `tables.TABLE_NAMES`. Each module loads and
validates its own table, and `tests/test_tables.py` excludes them in the same way it excludes the
chart-scan tables.

| File | Content | Provenance |
|---|---|---|
| `narrative_templates.json` | Sentence variants per kind: `sae_narrative`; `aesi_narrative`, which reuses the SAE sentences through `sentences_from`; and `visit_brief`. Also holds fragments; plain labels for con-med verbs, trend words, clock kinds and statuses, and CM field names; section titles; date and list formats; and the `validation` patterns (`forbidden_patterns` and `qualifiers`) that `validate_written` applies to any writer's output | Interim. Narrative order follows ICH E2A. Reporting sentences carry a `protocol_ref` to EMPOWER-Lung 1 R2810-ONC-1624 Amd 9 (§9.4.2 p. 91, §9.4.3 p. 92, §7.7 and §7.7.1–7.7.2 p. 69). The seriousness and causality qualifier cites §9.3.2 p. 90 and §9.3.4 pp. 90–91. Owned by `interim_rules.narrative` (`NARRATIVE_TABLE_NAMES`). |
| `time_model.json` | Minutes per unit for `AE` (1.0), `CM` (0.75), `VS` (0.1), `SAE_FORM` (1.5), `NARRATIVE_PARAGRAPH` (10) and `BRIEF_SECTION` (5), each with `basis` (`source` or `assumption`) and `derivation`; category `aliases`; `countable_fields` per domain (CM follows §7.7 p. 69); `anchor_rate`; `weekly_baseline` (12–15 h per study per week); `disclaimer` = `"estimate"` | VS rate: MSK + IgniteData time-and-motion study (3023 data points in 5 data-manager hours, 0.099 min per field). The other rates are stated multiples of it or plain assumptions. Weekly figure: Clinical Trial Vanguard (16 Sep 2026), citing Mednet; it is context only and never used in the arithmetic. Owned by `interim_rules.time_saved` (`TIME_MODEL_TABLE_NAMES`). |
| `plain_language.json` | `fields` (a plain label per SDTM or `INTERIM_*` variable); `rules` (a sentence template plus an input-free fallback for every catalog rule id, including `protocol.*`, `aesi.clock_started` and `aesi.clock_not_restarted`); `tiers`; `grades`; `clock_kinds`; `evidence_kinds`; `domains`; `input_aliases`; `render_as` | Interim, written for non-clinicians. Grade words follow the CTCAE v5.0 general descriptions; the clock kinds cite protocol §9.4.2 p. 91 and §9.4.3 p. 92. Owned by `interim_rules.plain_language` (`PLAIN_LANGUAGE_TABLE_NAMES`). |

To change wording or a rate, edit the table; the code only fills slots and does arithmetic. Add a
`source` or `derivation` for any new number. `tests/test_narrative.py`, `tests/test_time_saved.py`
and `tests/test_plain_language.py` load the shipped tables and also check that malformed copies
fail loudly.
