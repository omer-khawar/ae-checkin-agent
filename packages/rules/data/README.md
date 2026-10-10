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
