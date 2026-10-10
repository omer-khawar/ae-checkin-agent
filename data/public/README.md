# `data/public/` — cached public reference data

Everything in this directory was pulled from a public, key-free U.S. government API by
`scripts/fetch_public.py` and committed so that the demo runs from a clean clone with no
network. **Nothing here is participant data.** All Interim participants are synthetic
(see `data/synthetic/README.md`).

Every fetched file carries the same provenance header:

| field | meaning |
|---|---|
| `source_url` | the exact URL that was fetched |
| `fetched_at` | UTC ISO-8601 time of the pull |
| `fetched` | `true` for a live pull; `false` when the script wrote its bundled offline fallback (a `fallback_note` then says why) |
| `license_note` | the data's terms, repeated in the file so exports stay self-describing |

All files are UTF-8. Read them with `encoding="utf-8"`: the study record contains a
fullwidth comma (U+FF0C) and a `≥` exactly as the registry prints them, and a Windows
default code page will mangle both.

## Files

| File | Source | What Interim uses it for | Terms |
|---|---|---|---|
| `study.json` | [ClinicalTrials.gov API v2](https://clinicaltrials.gov/api/v2/studies/NCT03088540) — record `NCT03088540` (EMPOWER-Lung 1, cemiplimab vs platinum chemotherapy, Regeneron). Fallback `NCT02760498`, then a registry search for a completed Regeneron phase 3 cemiplimab study. | `STUDYID` (`R2810-ONC-1624`, the sponsor's protocol id), the dashboard header "Demo study (public registry record)", `INTERIM_NCT_ID` in exports, and the seed script. See the field mapping below. | Registry records are U.S. government works (NLM), public domain. [Terms](https://clinicaltrials.gov/about-site/terms-conditions). |
| `libtayo_label_excerpt.json` | [openFDA drug label API](https://api.fda.gov/drug/label.json?search=openfda.brand_name:%22LIBTAYO%22&limit=1) — the current LIBTAYO (cemiplimab-rwlc) SPL. | `GET /reference/label`: the *Adverse Reactions* and *Warnings and Precautions* text shown read-only, collapsed, beside the investigator's attribution controls as "reference safety information (public label excerpt)". Never parsed, never used by the rules engine. | [openFDA licence](https://open.fda.gov/license/): U.S. government work, public domain. openFDA disclaimer: do not rely on openFDA for medical-care decisions; results may be unvalidated. |
| `openfda_medlist_raw.json` | openFDA label `count=` queries: `openfda.generic_name.exact` and `openfda.brand_name.exact` (top 1,000 each, overall / prescription / OTC) plus, for each candidate generic, a `generic_name.exact → brand_name.exact` count lookup (the "label hits" that give brand → generic). | Raw material for `--build-medlist`, which writes `packages/rules/data/medlist.json` (CONTRACTS §1.6). The con-med matcher does exact / case-insensitive / Levenshtein ≤ 2 matching against that list. **Not RxNorm, not a formulary.** | openFDA licence, as above. |
| `ctcae_v5_excerpt.json` | [NCI EVS CTCAE v5.0](https://evs.nci.nih.gov/ftp1/CTCAE/CTCAE_5.0/) workbook `CTCAE_v5.0_2017-11-27.xlsx`, sheet "CTCAE v5.0 Clean Copy". The workbook itself is **not** bundled (only ten rows are extracted; its SHA-256 is recorded). | The ten terms behind the PRO items (Dyspnea, Cough, Fatigue, Nausea, Diarrhea, Rash maculo-papular, Pruritus, Arthralgia, Fever, Mucositis oral): `AEDECOD`, hover text for grade definitions, and the MedDRA code as printed by NCI (`meddra_code`). `null` in `grades` means NCI prints "-" (not defined). See "Two CTCAE tables" below. | CTCAE is an NCI (NIH) publication, public domain. MedDRA codes are reproduced as printed; MedDRA itself is licensed by ICH/MSSO and Interim ships no MedDRA dictionary. |
| `medlist_build_config.json` | Hand-written (not fetched). | The rules `--build-medlist` applies: the CONTRACTS §1.6 core list (always present), salt-suffix stripping, the non-drug exclusion lists (sunscreen filters, antiseptics, gases, cosmetic bases, homeopathic markers), store-brand filtering, the brand blocklist, the name-length rules and the size caps. Build-time data shaping only; the rules engine never reads it. | MIT (part of this repo). |

Not bundled, on purpose: the NCI PRO-CTCAE item library (requires registration; our
items are *modeled on* PRO-CTCAE, see `docs/PRD.md`), the full CTCAE workbook, MedDRA,
RxNorm.

### `study.json` field mapping for the seed and the API

The registry record keeps its structure (`title` is `{official, brief}`, `interventions`
are `{name, type, other_names}`) for hover text and provenance. The data model in
`CLAUDE.md` §6 wants flat strings, so the file also carries flat convenience fields:

| Data model (`Study`) | `study.json` field |
|---|---|
| `study_id` | `study_id` (sponsor protocol id, `R2810-ONC-1624`) |
| `nct_id` | `nct_id` |
| `title` | `title_display` (= `title.brief`; show `title.official` on hover) |
| `sponsor`, `phase` | `sponsor`, `phase` (`"Phase 3"`; the raw code is in `phases_raw`) |
| `conditions[]` | `conditions` (verbatim, including the registry's U+FF0C) |
| `interventions[]` | `intervention_names` (flat); `interventions` has type and other names |
| `source_url` | `official_url` (the human page); `source_url` is the API URL that was fetched |
| `fetched_at` | `fetched_at` |

The same note is embedded in the file as `reader_note`.

### Two CTCAE tables, one set of terms

`packages/rules/data/ctcae_terms.json` (owned by the rules package) is the **runtime**
source for `AEDECOD` and grade hover text and carries a clearly labeled `meddra_code_mock`.
This directory's `ctcae_v5_excerpt.json` is the **reference** view (`GET /reference/ctcae`)
and carries `meddra_code` as printed by NCI, with `meddra_code_note` saying so. The grade
text in the two files is identical (a test in the rules package should keep it so). The UI
must label the printed codes "as printed in CTCAE v5.0; no MedDRA dictionary shipped" and
never present either as a validated MedDRA coding.

## Refreshing

From the repo root, with the venv active (or using `.venv/Scripts/python.exe`):

```bash
python scripts/fetch_public.py                 # fetch what is missing or is a fallback; real pulls are untouched
python scripts/fetch_public.py --force         # refetch everything (~360 polite openFDA requests, ~3 min)
python scripts/fetch_public.py --offline       # never touch the network; bundled fallbacks if a file is missing
python scripts/fetch_public.py --only study --nct NCT02760498
python scripts/fetch_public.py --build-medlist                      # -> packages/rules/data/medlist.json
python scripts/fetch_public.py --build-medlist --out /tmp/m.json    # inspect before overwriting
python scripts/fetch_public.py --offline --strict                   # freshness check: exit 1 unless every file is a real pull
```

`make fetch-public` / `npm run fetch-public` run the first form. The script is idempotent:
a second run without `--force` reads the cache and writes nothing. It needs `openpyxl`
only to parse the CTCAE workbook (`uv pip install --python .venv/Scripts/python.exe
openpyxl==3.1.5`); without it the cached excerpt or the bundled copy is used and the log
says so.

What counts as a cache hit: a readable file with `fetched: true`. A bundled fallback
(`fetched: false`) is **not** a hit: an online run refetches it, and an offline run reports
it as `fallback` (and leaves it alone, so repeated offline runs are idempotent). A
truncated or otherwise unreadable file is treated as missing: refetched online, replaced by
the bundled copy offline, never a hard failure.

Exit status and the summary line per step:

| status | meaning | `--strict` |
|---|---|---|
| `cached` | real pull reused | ok |
| `fetched` / `updated` | pulled now / existing pull topped up | ok |
| `built` | `--build-medlist` output | ok |
| `partial` | pulled, but some openFDA brand lookups failed; re-run to fill them | exit 1 |
| `fallback` | the bundled offline copy is on disk | exit 1 |
| `stale-cache` | the refetch failed and the previous real pull was kept | exit 1 |
| `failed` | the step raised; nothing usable on disk | exit 1 (always) |

`--offline --strict` opens no socket and is the check to put in CI once the workflow runs
these scripts (today `.github/workflows/ci.yml` is a placeholder): it fails the build when
someone commits a fallback or partial file by mistake.

Tests (no network): `.venv/Scripts/python.exe -m pytest scripts/tests -q`.

## Offline fallbacks

If a file is missing and the network is unavailable (or `--offline` is given) the script
writes a bundled copy with `fetched: false`:

- `study.json`: the NCT03088540 record as transcribed on 2026-10-10.
- `ctcae_v5_excerpt.json`: the ten rows, same wording as the workbook (a test asserts the
  bundled copy matches the fetched one).
- `libtayo_label_excerpt.json`: headers only, section text left `null` rather than
  reproduced from memory.
- `openfda_medlist_raw.json`: empty query sets; `--build-medlist` then emits the core list only.

Rate limits: openFDA allows 240 requests/min and 1,000/day without a key; the script
pauses 250 ms between calls, waits 20 s after a 429 before retrying, writes brand-lookup
progress to disk every 25 generics (and on Ctrl-C), skips a generic whose lookup keeps
failing (reported as `partial`; the next run retries only the gaps), and caches per-generic
lookups so a re-run with a larger `top_generics` only fetches the missing ones.

## How the con-med list is built (and what it still gets wrong)

`--build-medlist` assembles `medlist.json` in this order: the 43 hand-curated core
entries, then **every one** of the `top_generics` (180) ranked openFDA generics, then up
to two brands per generic in rank order until `max_entries` (300). Generics go in before
brands so a common drug (warfarin, montelukast, tamsulosin) is never squeezed out by the
brands of a more common one.

Name rules, all in `medlist_build_config.json` with their rationale:

- Every entry has at least 5 letters and every word at least 3. The matcher tries any
  free-text token of 4+ characters at Levenshtein ≤ 2, so 4-letter entries matched ordinary
  words (`doxy` ← "dose"/"body", `blip` ← "slip", `urea` ← "area"). The cost: 4-letter
  brands a participant might type (**Tums**) are not in the list and come back *unmatched*,
  which is the honest outcome.
- A brand is dropped when it is a substring or superstring of its generic, within 2 edits of
  it, a repackager/store/descriptor pseudo-brand, a homeopathic name, or already in the list
  under another generic.
- `brand_blocklist` removes brand families sold under one name with several different
  active ingredients (Dramamine = dimenhydrinate *or* meclizine; Zantac = ranitidine
  historically, famotidine now; Fleet, Aspercreme, Dulcolax, Lotrimin, Sudafed, Unisom…).
  The count-based mapping would otherwise pick one ingredient and present it with
  confidence 1.0. These names now come back unmatched for the coordinator.

Known remaining limits of the list (also for `docs/WHAT_IT_GETS_WRONG.md` §4):

- **brand → generic comes from label counts, not a dictionary**: a brand maps to whichever
  generic its name appears on most in openFDA labels; the blocklist covers the families we
  found, not every one that exists.
- **Distance-2 collisions with 5-letter names remain**: "again" → `afrin` (0.6), "more" →
  `coreg` (0.6), "area" → `abreva` (0.67). A longer name list cannot remove this; only a
  larger edit-distance denominator or a stop-word list in the matcher could, and both are
  matcher decisions (`packages/rules/data/conmed_matching.json`), not list decisions.
- Obscure repackager brands with ≥ 2 labels (e.g. `pharbetol`, `toronova`) are kept; they
  are harmless for matching but not names anyone says.
