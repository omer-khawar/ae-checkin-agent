#!/usr/bin/env python3
"""Fetch, cache and shape the public reference data Interim uses (CLAUDE.md section 9).

Four public sources, no API keys, cached as JSON under ``data/public/`` so the demo works
offline from a clean clone:

  1. ClinicalTrials.gov API v2      -> data/public/study.json
     The demo study record (default NCT03088540, cemiplimab / EMPOWER-Lung 1, Regeneron).
  2. openFDA drug label (LIBTAYO)   -> data/public/libtayo_label_excerpt.json
     Adverse-reactions and warnings text shown read-only on the investigator screen.
  3. openFDA drug label name counts -> data/public/openfda_medlist_raw.json
     Raw material for the con-med name list (``--build-medlist`` turns it into the
     ``medlist.json`` schema from docs/CONTRACTS.md section 1.6).
  4. NCI EVS CTCAE v5.0 workbook    -> data/public/ctcae_v5_excerpt.json
     The ten CTCAE terms Interim uses as AEDECOD, with grade text and MedDRA codes.

Ground rules for this script:
  * HTTP uses only the standard library (``urllib``).  ``openpyxl`` is an optional import,
    used solely to read the CTCAE workbook; without it the cached excerpt or the bundled
    offline copy is used and a clear message says how to install it.
  * Every output JSON carries ``source_url``, ``fetched_at``, ``license_note`` and a boolean
    ``fetched``.  ``fetched: false`` means a bundled offline fallback was written, and a
    ``fallback_note`` explains why.
  * ``--offline`` never opens a socket.  ``--force`` ignores the cache.  Without either flag a
    cached file that was really fetched (``fetched: true``) is left untouched (its original
    ``fetched_at`` is preserved), so the script is idempotent and safe to run on every
    ``make seed``.  A bundled fallback (``fetched: false``) or an unreadable file is *not* a
    cache hit: it is refetched online, reported as ``fallback`` offline (so ``--strict``
    fails), and an unreadable file is replaced by the bundled copy rather than aborting.
  * No clinical logic lives here.  The script fetches, labels and reshapes public data; the
    rules engine reads the results from its own tables.

Usage (from the repo root; see data/public/README.md):
  python scripts/fetch_public.py                     # fetch what is missing, keep the rest
  python scripts/fetch_public.py --force             # refetch everything
  python scripts/fetch_public.py --offline           # cache only; bundled fallbacks if missing
  python scripts/fetch_public.py --build-medlist --out /tmp/medlist.json
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
import os
import re
import sys
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

Json = dict[str, Any]

# Characters that appear in upstream data; spelled out so no literal lookalike sits in source.
NBSP = chr(0x00A0)  # non-breaking space (CTCAE workbook headers)
FULLWIDTH_COMMA = chr(0xFF0C)  # as printed in the NCT03088540 conditions list

log = logging.getLogger("fetch_public")

# --------------------------------------------------------------------------------------
# Locations
# --------------------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PUBLIC_DIR = REPO_ROOT / "data" / "public"
DEFAULT_MEDLIST_OUT = REPO_ROOT / "packages" / "rules" / "data" / "medlist.json"
MEDLIST_OUT_DISPLAY = DEFAULT_MEDLIST_OUT.relative_to(REPO_ROOT).as_posix()

STUDY_FILE = "study.json"
LABEL_FILE = "libtayo_label_excerpt.json"
MEDLIST_RAW_FILE = "openfda_medlist_raw.json"
CTCAE_FILE = "ctcae_v5_excerpt.json"
MEDLIST_CONFIG_FILE = "medlist_build_config.json"

STEP_FILES: dict[str, str] = {
    "study": STUDY_FILE,
    "label": LABEL_FILE,
    "medlist": MEDLIST_RAW_FILE,
    "ctcae": CTCAE_FILE,
}

# --------------------------------------------------------------------------------------
# Upstream endpoints and attribution
# --------------------------------------------------------------------------------------

CTGOV_API = "https://clinicaltrials.gov/api/v2/studies"
CTGOV_STUDY_URL = "https://clinicaltrials.gov/study/{nct}"
OPENFDA_LABEL_API = "https://api.fda.gov/drug/label.json"
# The EVS "ftp1" listing page is a client-rendered app; unknown paths under it return the
# app's HTML with HTTP 200, so the exact file name matters and the download is verified by
# content type and zip magic bytes before it is parsed.
CTCAE_LISTING_URL = "https://evs.nci.nih.gov/ftp1/CTCAE/CTCAE_5.0/"
CTCAE_XLSX_URL = "https://evs.nci.nih.gov/ftp1/CTCAE/CTCAE_5.0/CTCAE_v5.0_2017-11-27.xlsx"
CTCAE_SHEET = "CTCAE v5.0 Clean Copy"
CTCAE_PUBLISHED = "2017-11-27"
# An .xlsx is a zip archive.  The magic bytes are the reliable signal; the Content-Type
# header is only logged, because static hosts routinely serve the file as octet-stream.
XLSX_MAGIC = b"PK\x03\x04"

# Candidate NCT ids, tried in order (CLAUDE.md section 9).  DEMO_NCT_ID / --nct go first.
NCT_CANDIDATES: tuple[str, ...] = ("NCT03088540", "NCT02760498")
SPONSOR_MATCH = "regeneron"
NCT_RE = re.compile(r"^NCT\d{8}$")

LICENSE_CTGOV = (
    "ClinicalTrials.gov is a service of the U.S. National Library of Medicine; registry "
    "records are U.S. government works in the public domain. Cite the NCT number. "
    "Terms: https://clinicaltrials.gov/about-site/terms-conditions"
)
LICENSE_OPENFDA = (
    "openFDA data are U.S. government works in the public domain "
    "(https://open.fda.gov/license/). openFDA disclaimer: do not rely on openFDA to make "
    "decisions regarding medical care; results may be unvalidated. "
    "Terms: https://open.fda.gov/terms/"
)
LICENSE_CTCAE = (
    "CTCAE is published by the U.S. National Cancer Institute (NIH) and is a U.S. government "
    "work in the public domain. MedDRA codes are reproduced as printed in the CTCAE v5.0 "
    "file; MedDRA itself is maintained by ICH/MSSO under its own licence and Interim ships no "
    "MedDRA dictionary."
)

USER_AGENT = "interim-fetch-public/0.1 (HackRU 2026 clinical-trial check-in demo; stdlib urllib)"
HTTP_TIMEOUT_S = 30.0
HTTP_RETRIES = 3
RETRYABLE_HTTP = frozenset({408, 429, 500, 502, 503, 504})
# openFDA allows 240 requests/min and 1,000/day without a key.  The brand lookups make
# ~200 requests on a cold run; a short pause keeps us well inside the per-minute budget.
OPENFDA_POLITE_DELAY_S = 0.25
# When openFDA does answer 429 the per-minute window has to roll over before a retry can
# succeed, so a 429 waits at least this long instead of the 2/4 s exponential backoff.
RATE_LIMIT_PAUSE_S = 20.0
# The brand-lookup loop writes its progress to disk this often so that a failure (or a
# Ctrl-C) three minutes into a cold run does not throw away every lookup already made.
LOOKUP_PERSIST_EVERY = 25

OPENPYXL_HINT = (
    "openpyxl is needed to parse the CTCAE workbook. Install it into the venv with: "
    "uv pip install --python .venv/Scripts/python.exe openpyxl==3.1.5 "
    "(or run with --offline to use the cached excerpt)."
)

# The ten CTCAE v5.0 terms Interim uses, in item order, with the PRO item id each one backs.
CTCAE_TERMS: tuple[tuple[str, str], ...] = (
    ("Dyspnea", "shortness_of_breath"),
    ("Cough", "cough"),
    ("Fatigue", "fatigue"),
    ("Nausea", "nausea"),
    ("Diarrhea", "diarrhea"),
    ("Rash maculo-papular", "rash"),
    ("Pruritus", "itching"),
    ("Arthralgia", "joint_pain"),
    ("Fever", "fever_or_chills"),
    ("Mucositis oral", "mouth_sores"),
)

# --------------------------------------------------------------------------------------
# Bundled offline fallbacks (written only when there is no cache and no network).
# Transcribed by the Interim team from the live records on 2026-10-10; every file written
# from these carries ``fetched: false`` so nobody mistakes them for a fresh pull.
# --------------------------------------------------------------------------------------

STUDY_BRIEF_TITLE = (
    "Study of REGN 2810 Compared to Platinum-Based Chemotherapies in Participants "
    "With Metastatic Non-Small Cell Lung Cancer (NSCLC)"
)
STUDY_READER_NOTE = (
    "Read this file as UTF-8 (conditions contain the fullwidth comma U+FF0C exactly as the "
    "registry prints it). Study.title in the data model = title_display (the brief title); "
    "show title.official on hover. Study.interventions[] = intervention_names."
)

FALLBACK_STUDY: Json = {
    "nct_id": "NCT03088540",
    "study_id": "R2810-ONC-1624",
    "title": {
        "official": (
            "A Global, Randomised, Phase 3, Open-label Study of REGN2810 (ANTI-PD 1 Antibody) "
            "Versus Platinum Based Chemotherapy in First Line Treatment of Patients With "
            "Advanced or Metastatic PD L1+Non-small Cell Lung Cancer"
        ),
        "brief": STUDY_BRIEF_TITLE,
    },
    "title_display": STUDY_BRIEF_TITLE,
    "sponsor": "Regeneron Pharmaceuticals",
    "sponsor_class": "INDUSTRY",
    "collaborators": ["Sanofi"],
    "phase": "Phase 3",
    "phases_raw": ["PHASE3"],
    "status": "COMPLETED",
    "study_type": "INTERVENTIONAL",
    "conditions": [
        "Carcinoma" + FULLWIDTH_COMMA + "Non-Small-Cell Lung",
        "Lung Carcinomas, Non-Small-Cell",
        "Non-small-cell Lung Carcinoma",
        "Nonsmall Cell Lung Cancer",
    ],
    "keywords": [
        "Previous Smoker",
        "Current Smoker",
        "Stage IIIB",
        "Stage IIIC",
        "Stage IV",
        "PD-L1",
    ],
    "interventions": [
        {"name": "Pemetrexed", "type": "DRUG", "other_names": []},
        {"name": "Paclitaxel", "type": "DRUG", "other_names": []},
        {"name": "Gemcitabine", "type": "DRUG", "other_names": []},
        {"name": "Cisplatin", "type": "DRUG", "other_names": []},
        {"name": "Carboplatin", "type": "DRUG", "other_names": []},
        {"name": "cemiplimab", "type": "DRUG", "other_names": ["REGN2810", "Libtayo"]},
    ],
    "intervention_names": [
        "Pemetrexed",
        "Paclitaxel",
        "Gemcitabine",
        "Cisplatin",
        "Carboplatin",
        "cemiplimab",
    ],
    "start_date": "2017-05-29",
    "primary_completion_date": "2025-04-18",
    "completion_date": "2025-04-18",
    "enrollment": {"count": 712, "type": "ACTUAL"},
    "brief_summary": None,
    "official_url": "https://clinicaltrials.gov/study/NCT03088540",
    "registry_last_update_posted": "2026-06-25",
    "raw": None,
}

# Grade text exactly as printed in the "CTCAE v5.0 Clean Copy" sheet (2017-11-27 workbook).
# ``None`` where NCI prints "-" (grade not defined for that term).
FALLBACK_CTCAE_ROWS: dict[str, Json] = {
    "Dyspnea": {
        "meddra_code": "10013963",
        "meddra_soc": "Respiratory, thoracic and mediastinal disorders",
        "grades": {
            "1": "Shortness of breath with moderate exertion",
            "2": "Shortness of breath with minimal exertion; limiting instrumental ADL",
            "3": "Shortness of breath at rest; limiting self care ADL",
            "4": "Life-threatening consequences; urgent intervention indicated",
            "5": "Death",
        },
        "definition": (
            "A disorder characterized by an uncomfortable sensation of difficulty breathing."
        ),
        "navigational_note": None,
        "ctcae_v5_change": None,
    },
    "Cough": {
        "meddra_code": "10011224",
        "meddra_soc": "Respiratory, thoracic and mediastinal disorders",
        "grades": {
            "1": "Mild symptoms; nonprescription intervention indicated",
            "2": "Moderate symptoms, medical intervention indicated; limiting instrumental ADL",
            "3": "Severe symptoms; limiting self care ADL",
            "4": None,
            "5": None,
        },
        "definition": (
            "A disorder characterized by sudden, often repetitive, spasmodic contraction of "
            "the thoracic cavity, resulting in violent release of air from the lungs and "
            "usually accompanied by a distinctive sound."
        ),
        "navigational_note": None,
        "ctcae_v5_change": None,
    },
    "Fatigue": {
        "meddra_code": "10016256",
        "meddra_soc": "General disorders and administration site conditions",
        "grades": {
            "1": "Fatigue relieved by rest",
            "2": "Fatigue not relieved by rest; limiting instrumental ADL",
            "3": "Fatigue not relieved by rest, limiting self care ADL",
            "4": None,
            "5": None,
        },
        "definition": (
            "A disorder characterized by a state of generalized weakness with a pronounced "
            "inability to summon sufficient energy to accomplish daily activities."
        ),
        "navigational_note": None,
        "ctcae_v5_change": None,
    },
    "Nausea": {
        "meddra_code": "10028813",
        "meddra_soc": "Gastrointestinal disorders",
        "grades": {
            "1": "Loss of appetite without alteration in eating habits",
            "2": (
                "Oral intake decreased without significant weight loss, dehydration or malnutrition"
            ),
            "3": (
                "Inadequate oral caloric or fluid intake; tube feeding, TPN, or "
                "hospitalization indicated"
            ),
            "4": None,
            "5": None,
        },
        "definition": ("A disorder characterized by a queasy sensation and/or the urge to vomit."),
        "navigational_note": None,
        "ctcae_v5_change": None,
    },
    "Diarrhea": {
        "meddra_code": "10012727",
        "meddra_soc": "Gastrointestinal disorders",
        "grades": {
            "1": (
                "Increase of <4 stools per day over baseline; mild increase in ostomy output "
                "compared to baseline"
            ),
            "2": (
                "Increase of 4 - 6 stools per day over baseline; moderate increase in ostomy "
                "output compared to baseline; limiting instrumental ADL"
            ),
            "3": (
                "Increase of >=7 stools per day over baseline; hospitalization indicated; "
                "severe increase in ostomy output compared to baseline; limiting self care ADL"
            ),
            "4": "Life-threatening consequences; urgent intervention indicated",
            "5": "Death",
        },
        "definition": (
            "A disorder characterized by an increase in frequency and/or loose or watery "
            "bowel movements."
        ),
        "navigational_note": None,
        "ctcae_v5_change": "Clarification: Grade 2, 3, Definition",
    },
    "Rash maculo-papular": {
        "meddra_code": "10037868",
        "meddra_soc": "Skin and subcutaneous tissue disorders",
        "grades": {
            "1": (
                "Macules/papules covering <10% BSA with or without symptoms (e.g., pruritus, "
                "burning, tightness)"
            ),
            "2": (
                "Macules/papules covering 10 - 30% BSA with or without symptoms (e.g., "
                "pruritus, burning, tightness); limiting instrumental ADL; rash covering "
                "> 30% BSA with or without mild symptoms"
            ),
            "3": (
                "Macules/papules covering >30% BSA with moderate or severe symptoms; "
                "limiting self care ADL"
            ),
            "4": None,
            "5": None,
        },
        "definition": (
            "A disorder characterized by the presence of macules (flat) and papules "
            "(elevated). Also known as morbillform rash, it is one of the most common "
            "cutaneous adverse events, frequently affecting the upper trunk, spreading "
            "centripetally and associated with pruritis."
        ),
        "navigational_note": None,
        "ctcae_v5_change": "Clarification: Grade 2, 3",
    },
    "Pruritus": {
        "meddra_code": "10037087",
        "meddra_soc": "Skin and subcutaneous tissue disorders",
        "grades": {
            "1": "Mild or localized; topical intervention indicated",
            "2": (
                "Widespread and intermittent; skin changes from scratching (e.g., edema, "
                "papulation, excoriations, lichenification, oozing/crusts); oral intervention "
                "indicated; limiting instrumental ADL"
            ),
            "3": (
                "Widespread and constant; limiting self care ADL or sleep; systemic "
                "corticosteroid or immunosuppressive therapy indicated"
            ),
            "4": None,
            "5": None,
        },
        "definition": "A disorder characterized by an intense itching sensation.",
        "navigational_note": None,
        "ctcae_v5_change": "Clarification: Grade 2, 3",
    },
    "Arthralgia": {
        "meddra_code": "10003239",
        "meddra_soc": "Musculoskeletal and connective tissue disorders",
        "grades": {
            "1": "Mild pain",
            "2": "Moderate pain; limiting instrumental ADL",
            "3": "Severe pain; limiting self care ADL",
            "4": None,
            "5": None,
        },
        "definition": ("A disorder characterized by a sensation of marked discomfort in a joint."),
        "navigational_note": None,
        "ctcae_v5_change": None,
    },
    "Fever": {
        "meddra_code": "10016558",
        "meddra_soc": "General disorders and administration site conditions",
        "grades": {
            "1": "38.0 - 39.0 degrees C (100.4 - 102.2 degrees F)",
            "2": ">39.0 - 40.0 degrees C (102.3 - 104.0 degrees F)",
            "3": ">40.0 degrees C (>104.0 degrees F) for <=24 hrs",
            "4": ">40.0 degrees C (>104.0 degrees F) for >24 hrs",
            "5": "Death",
        },
        "definition": (
            "A disorder characterized by elevation of the body's temperature above the upper "
            "limit of normal."
        ),
        "navigational_note": None,
        "ctcae_v5_change": None,
    },
    "Mucositis oral": {
        "meddra_code": "10028130",
        "meddra_soc": "Gastrointestinal disorders",
        "grades": {
            "1": "Asymptomatic or mild symptoms; intervention not indicated",
            "2": (
                "Moderate pain or ulcer that does not interfere with oral intake; modified "
                "diet indicated"
            ),
            "3": "Severe pain; interfering with oral intake",
            "4": "Life-threatening consequences; urgent intervention indicated",
            "5": "Death",
        },
        "definition": (
            "A disorder characterized by ulceration or inflammation of the oral mucosal."
        ),
        "navigational_note": None,
        "ctcae_v5_change": "Clarification: Grade 2, Definition",
    },
}

CTCAE_NOTE = (
    "Ten CTCAE v5.0 terms used as AEDECOD for Interim's PRO-CTCAE-modeled items. The grade "
    "text is reference/hover text only: Interim's provisional grade comes from participant "
    "answers via the composite table (CLAUDE.md 3.4b) and grades 4-5 are never assigned."
)
CTCAE_GRADE_NULL_NOTE = "null = NCI prints '-' for that grade (not defined for this term)."
CTCAE_CODE_NOTE = (
    "meddra_code is the code as printed in the NCI CTCAE v5.0 workbook, kept for reference; "
    "Interim ships no MedDRA dictionary and does not validate these codes. The runtime "
    "rules table packages/rules/data/ctcae_terms.json carries a clearly labeled "
    "meddra_code_mock for AE drafting; this file is the reference view "
    "(GET /reference/ctcae). Label the printed codes 'as printed in CTCAE v5.0' in the UI."
)
LABEL_NOTE = "public label excerpt, reference only; not clinical guidance"
STUDY_NOTE = (
    "Demo study (public registry record). All Interim participants are synthetic; nothing "
    "in this file is participant data."
)
MEDLIST_RAW_NOTE = (
    "Raw openFDA label name counts used by `fetch_public.py --build-medlist`. Not RxNorm, "
    "not a formulary; the built list is a small lookup table for deterministic string "
    "matching of what a participant typed."
)

# --------------------------------------------------------------------------------------
# Small shared helpers
# --------------------------------------------------------------------------------------


class FetchError(RuntimeError):
    """A fetch failed after retries, or a response was not shaped the way we expected."""


class NotFoundError(FetchError):
    """Upstream says the resource does not exist (HTTP 404, or CT.gov's 400 for a bad id)."""


@dataclass(frozen=True)
class Options:
    """Command-line options that the fetch steps care about."""

    public_dir: Path
    offline: bool
    force: bool
    nct_candidates: tuple[str, ...]
    medlist_config: Path


@dataclass
class StepResult:
    """One line of the end-of-run summary.

    ``status`` vocabulary:
      cached       a real pull (``fetched: true``) is on disk and was reused
      fetched      pulled from the network this run
      updated      an existing pull was topped up (medlist brand lookups)
      partial      pulled, but some openFDA lookups failed; re-run to fill the gaps
      fallback     the bundled offline copy is on disk (written now, or left from before)
      stale-cache  the refetch failed and the previous real pull was kept
      built        ``--build-medlist`` output
      failed       the step raised; nothing usable is on disk
    ``partial``, ``fallback`` and ``stale-cache`` are "degraded": they make ``--strict``
    exit 1.
    """

    name: str
    path: Path
    status: str
    detail: str = ""


DEGRADED_STATUSES: frozenset[str] = frozenset({"fallback", "stale-cache", "partial"})

CacheKind = Literal["fresh", "fallback", "corrupt", "missing"]


@dataclass(frozen=True)
class CacheState:
    """What the cache directory holds for one step, inspected before any socket is opened.

    ``fresh``     a readable file with ``fetched: true`` (a real pull)
    ``fallback``  a readable file without ``fetched: true`` (a bundled copy written earlier,
                  or a hand-edited file); never a cache hit, so an online run refreshes it
    ``corrupt``   the file exists but is not valid JSON / not an object; treated as missing
    ``missing``   no file
    """

    kind: CacheKind
    doc: Json | None = None
    detail: str = ""

    @property
    def present(self) -> bool:
        """True when a readable document is on disk (fresh or fallback)."""
        return self.doc is not None


def utc_now_iso() -> str:
    """UTC ISO-8601 with millisecond precision and a Z suffix (docs/CONTRACTS.md conventions)."""
    now = datetime.now(UTC)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def rel(path: Path) -> str:
    """Repo-relative path for log lines when possible, else the absolute path."""
    try:
        return path.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(path)


def read_json(path: Path) -> Json:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise FetchError(f"{rel(path)}: expected a JSON object at the top level")
    return data


def write_json(path: Path, doc: Json) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    log.info("wrote %s (%s bytes)", rel(path), f"{len(text.encode('utf-8')):,}")


def http_get(url: str, *, accept: str = "application/json") -> tuple[bytes, str]:
    """GET ``url`` with retries and exponential backoff.

    Returns ``(body, content_type)``.  Raises :class:`NotFoundError` on 404 (and on 400,
    which ClinicalTrials.gov uses for a malformed NCT id) and :class:`FetchError` for
    anything else that does not succeed within ``HTTP_RETRIES`` attempts.
    """
    last_error: Exception | None = None
    for attempt in range(1, HTTP_RETRIES + 1):
        request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
        try:
            with urlopen(request, timeout=HTTP_TIMEOUT_S) as response:
                body: bytes = response.read()
                content_type = str(response.headers.get("Content-Type") or "")
                log.debug("GET %s -> %d bytes (%s)", url, len(body), content_type)
                return body, content_type
        except HTTPError as exc:
            if exc.code in (400, 404):
                raise NotFoundError(f"GET {url} -> HTTP {exc.code}") from exc
            if exc.code not in RETRYABLE_HTTP:
                raise FetchError(f"GET {url} -> HTTP {exc.code} {exc.reason}") from exc
            last_error = exc
        except (URLError, TimeoutError) as exc:  # DNS, refused, read timeout
            last_error = exc
        if attempt < HTTP_RETRIES:
            delay = 2.0**attempt
            if isinstance(last_error, HTTPError) and last_error.code == 429:
                delay = max(delay, RATE_LIMIT_PAUSE_S)
            log.warning("GET %s failed (%s); retrying in %.0fs", url, last_error, delay)
            time.sleep(delay)
    raise FetchError(f"GET {url} failed after {HTTP_RETRIES} attempts: {last_error}")


def http_get_json(url: str) -> Json:
    body, _ = http_get(url)
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise FetchError(f"GET {url}: response is not JSON ({exc})") from exc
    if not isinstance(data, dict):
        raise FetchError(f"GET {url}: expected a JSON object")
    return data


def openfda_url(**params: str | int) -> str:
    """Build an openFDA label query URL. Quotes inside ``search`` are percent-encoded."""
    return OPENFDA_LABEL_API + "?" + urlencode(params, quote_via=quote)


def openfda_count(url: str) -> list[Json]:
    """Run an openFDA ``count=`` query; a 404 means "no matches" and yields an empty list."""
    try:
        data = http_get_json(url)
    except NotFoundError:
        return []
    results = data.get("results", [])
    return [{"term": str(r["term"]), "count": int(r["count"])} for r in results]


def inspect_cache(path: Path) -> CacheState:
    """Classify the cached file at ``path`` without raising (see :class:`CacheState`)."""
    if not path.exists():
        return CacheState("missing", detail="no cached file")
    try:
        doc = read_json(path)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, FetchError) as exc:
        log.warning("%s: cached file is unreadable (%s); treating it as missing", path.name, exc)
        return CacheState("corrupt", detail=f"unreadable cache: {exc}")
    if doc.get("fetched") is not True:
        return CacheState(
            "fallback",
            doc,
            "cached file is a bundled fallback (fetched=false); run without --offline to refresh",
        )
    return CacheState("fresh", doc, f"fetched_at={doc.get('fetched_at')}")


def _use_cache(opts: Options, state: CacheState) -> bool:
    """A real pull on disk is reused unless ``--force``; nothing else ever counts as a hit."""
    if state.kind != "fresh":
        return False
    if opts.force:
        log.info("%s: ignoring cache (--force)", state.detail)
        return False
    log.info("cache hit (%s)", state.detail)
    return True


def _before_online_fetch(name: str, state: CacheState) -> None:
    """Explain in the log why a file that exists is about to be refetched."""
    if state.kind in ("fallback", "corrupt"):
        log.info("%s: %s; refetching", name, state.detail)


def _offline_result(
    name: str, path: Path, state: CacheState, make_fallback: Callable[[], Json]
) -> StepResult:
    """``--offline`` and the cache is not a real pull: keep an existing fallback, else write one.

    An existing fallback is deliberately left alone (no rewrite, no new ``fetched_at``) so a
    repeated offline run is idempotent; it is still reported as ``fallback`` so ``--strict``
    fails until someone runs online.
    """
    if state.kind == "fallback":
        log.warning("%s: --offline and the %s", name, state.detail)
        return StepResult(name, path, "fallback", state.detail)
    reason = "offline, no cache" if state.kind == "missing" else f"offline, {state.detail}"
    log.warning("%s: --offline and %s at %s; writing bundled fallback", name, reason, rel(path))
    write_json(path, make_fallback())
    return StepResult(name, path, "fallback", reason)


def _after_fetch_failure(
    name: str,
    path: Path,
    exc: Exception,
    make_fallback: Callable[[], Json],
    state: CacheState,
) -> StepResult:
    """Keep a real stale cache or an existing fallback; otherwise write the bundled fallback."""
    if state.kind == "fresh":
        log.error("%s: fetch failed (%s); keeping the existing cached file", name, exc)
        return StepResult(name, path, "stale-cache", str(exc))
    if state.kind == "fallback":
        log.error("%s: fetch failed (%s); cached file is still the bundled fallback", name, exc)
        return StepResult(name, path, "fallback", f"fetch failed: {exc}")
    log.error("%s: fetch failed (%s); writing bundled fallback (fetched=false)", name, exc)
    write_json(path, make_fallback())
    return StepResult(name, path, "fallback", str(exc))


# --------------------------------------------------------------------------------------
# Step 1: ClinicalTrials.gov study record
# --------------------------------------------------------------------------------------


def humanize_phase(phase: str) -> str:
    """CT.gov phase code to display text: PHASE3 -> Phase 3, NA -> Not applicable."""
    if phase == "NA":
        return "Not applicable"
    words = phase.replace("_", " ").title()
    return re.sub(r"Phase(\d)", r"Phase \1", words)


def lead_sponsor(protocol: Json) -> str:
    return str(
        protocol.get("sponsorCollaboratorsModule", {}).get("leadSponsor", {}).get("name", "")
    )


def study_phases(protocol: Json) -> list[str]:
    return [str(p) for p in protocol.get("designModule", {}).get("phases", [])]


def resolve_study(candidates: Iterable[str]) -> tuple[Json, str]:
    """Return ``(protocolSection, how)`` for the first candidate led by Regeneron.

    Falls back to a registry search for a completed Regeneron phase 3 cemiplimab study.
    """
    for nct in candidates:
        if not NCT_RE.match(nct):
            log.warning("skipping malformed NCT id %r", nct)
            continue
        url = f"{CTGOV_API}/{nct}"
        try:
            record = http_get_json(url)
        except NotFoundError:
            log.warning("%s: not found on ClinicalTrials.gov; trying the next candidate", nct)
            continue
        protocol = record.get("protocolSection")
        if not isinstance(protocol, dict):
            log.warning("%s: record has no protocolSection; trying the next candidate", nct)
            continue
        sponsor = lead_sponsor(protocol)
        if SPONSOR_MATCH in sponsor.lower():
            log.info("%s resolved (lead sponsor %r)", nct, sponsor)
            return protocol, f"direct:{nct}"
        log.warning(
            "%s: lead sponsor is %r, not Regeneron; trying the next candidate", nct, sponsor
        )

    search_url = (
        CTGOV_API
        + "?"
        + urlencode(
            {
                "query.spons": "Regeneron",
                "query.intr": "cemiplimab",
                "filter.overallStatus": "COMPLETED",
                "pageSize": 50,
            }
        )
    )
    log.info("searching the registry: %s", search_url)
    listing = http_get_json(search_url)
    for study in listing.get("studies", []):
        protocol = study.get("protocolSection", {})
        if "PHASE3" in study_phases(protocol) and SPONSOR_MATCH in lead_sponsor(protocol).lower():
            nct = str(protocol.get("identificationModule", {}).get("nctId"))
            log.info("search picked %s", nct)
            return protocol, f"search:{nct}"
    raise FetchError("no completed Regeneron phase 3 cemiplimab study found via search")


def shape_study(protocol: Json, resolved_via: str) -> Json:
    """Reduce a CT.gov v2 ``protocolSection`` to the fields the dashboard header needs."""
    ident = protocol.get("identificationModule", {})
    status = protocol.get("statusModule", {})
    sponsors = protocol.get("sponsorCollaboratorsModule", {})
    design = protocol.get("designModule", {})
    conditions = protocol.get("conditionsModule", {})
    arms = protocol.get("armsInterventionsModule", {})
    description = protocol.get("descriptionModule", {})
    nct = str(ident["nctId"])
    phases = study_phases(protocol)

    def date_of(key: str) -> str | None:
        value = status.get(key, {}).get("date")
        return str(value) if value else None

    raw_subset: Json = {
        key: protocol[key]
        for key in (
            "identificationModule",
            "statusModule",
            "sponsorCollaboratorsModule",
            "designModule",
            "conditionsModule",
        )
        if key in protocol
    }
    raw_subset["armsInterventionsModule"] = {"interventions": arms.get("interventions", [])}
    interventions = [
        {
            "name": item.get("name"),
            "type": item.get("type"),
            "other_names": list(item.get("otherNames", [])),
        }
        for item in arms.get("interventions", [])
    ]
    brief_title = ident.get("briefTitle")

    return {
        "source_url": f"{CTGOV_API}/{nct}",
        "fetched_at": utc_now_iso(),
        "fetched": True,
        "license_note": LICENSE_CTGOV,
        "note": STUDY_NOTE,
        "reader_note": STUDY_READER_NOTE,
        "resolved_via": resolved_via,
        "nct_id": nct,
        "study_id": ident.get("orgStudyIdInfo", {}).get("id"),
        "title": {"official": ident.get("officialTitle"), "brief": brief_title},
        # Flat convenience fields for the data model (CLAUDE.md 6: Study.title is a string,
        # Study.interventions a list of strings).  The structured forms above stay for hover
        # text and provenance.
        "title_display": brief_title or ident.get("officialTitle"),
        "sponsor": sponsors.get("leadSponsor", {}).get("name"),
        "sponsor_class": sponsors.get("leadSponsor", {}).get("class"),
        "collaborators": [c.get("name") for c in sponsors.get("collaborators", [])],
        "phase": " / ".join(humanize_phase(p) for p in phases) or None,
        "phases_raw": phases,
        "status": status.get("overallStatus"),
        "study_type": design.get("studyType"),
        "conditions": list(conditions.get("conditions", [])),
        "keywords": list(conditions.get("keywords", [])),
        "interventions": interventions,
        "intervention_names": [str(i["name"]) for i in interventions if i["name"]],
        "start_date": date_of("startDateStruct"),
        "primary_completion_date": date_of("primaryCompletionDateStruct"),
        "completion_date": date_of("completionDateStruct"),
        "enrollment": {
            "count": design.get("enrollmentInfo", {}).get("count"),
            "type": design.get("enrollmentInfo", {}).get("type"),
        },
        "brief_summary": description.get("briefSummary"),
        "official_url": CTGOV_STUDY_URL.format(nct=nct),
        "registry_last_update_posted": date_of("lastUpdatePostDateStruct"),
        "raw": {"protocolSection": raw_subset},
    }


def make_fallback_study() -> Json:
    nct = str(FALLBACK_STUDY["nct_id"])
    return {
        "source_url": f"{CTGOV_API}/{nct}",
        "fetched_at": utc_now_iso(),
        "fetched": False,
        "license_note": LICENSE_CTGOV,
        "note": STUDY_NOTE,
        "reader_note": STUDY_READER_NOTE,
        "fallback_note": (
            "Bundled offline copy transcribed from the live registry record on 2026-10-10. "
            "Run scripts/fetch_public.py without --offline to refresh."
        ),
        "resolved_via": "bundled-fallback",
        **json.loads(json.dumps(FALLBACK_STUDY)),
    }


def fetch_study(opts: Options) -> StepResult:
    path = opts.public_dir / STUDY_FILE
    state = inspect_cache(path)
    if _use_cache(opts, state) and state.doc is not None:
        cached = state.doc
        return StepResult(
            "study", path, "cached", f"{cached.get('nct_id')} {cached.get('study_id')}"
        )
    if opts.offline:
        return _offline_result("study", path, state, make_fallback_study)
    _before_online_fetch("study", state)
    try:
        protocol, how = resolve_study(opts.nct_candidates)
    except FetchError as exc:
        return _after_fetch_failure("study", path, exc, make_fallback_study, state)
    doc = shape_study(protocol, how)
    write_json(path, doc)
    return StepResult("study", path, "fetched", f"{doc['nct_id']} {doc['study_id']} via {how}")


# --------------------------------------------------------------------------------------
# Step 2: openFDA LIBTAYO label excerpt
# --------------------------------------------------------------------------------------

LABEL_SECTIONS: tuple[str, ...] = (
    "adverse_reactions",
    "warnings_and_cautions",
    "indications_and_usage",
)


def _section_text(record: Json, key: str) -> str | None:
    """openFDA stores each SPL section as a list of strings; join them with blank lines."""
    value = record.get(key)
    if not value:
        return None
    parts = [str(part).strip() for part in value if str(part).strip()]
    return "\n\n".join(parts) or None


def _effective_date(raw: str | None) -> str | None:
    """``20260831`` -> ``2026-08-31``."""
    if raw and re.fullmatch(r"\d{8}", raw):
        return f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
    return None


def shape_label(record: Json, meta: Json, source_url: str) -> Json:
    openfda = record.get("openfda", {})
    brand = str((openfda.get("brand_name") or ["LIBTAYO"])[0])
    generic = str((openfda.get("generic_name") or ["cemiplimab-rwlc"])[0]).lower()
    sections = {key: _section_text(record, key) for key in LABEL_SECTIONS}
    omitted = sorted(k for k in record if k.endswith("_table"))
    return {
        "source_url": source_url,
        "fetched_at": utc_now_iso(),
        "fetched": True,
        "license_note": LICENSE_OPENFDA,
        "note": LABEL_NOTE,
        "drug": f"{brand} ({generic})",
        "brand": brand,
        "generic": generic,
        "manufacturer": (openfda.get("manufacturer_name") or [None])[0],
        "application_number": (openfda.get("application_number") or [None])[0],
        "route": list(openfda.get("route", [])),
        "product_type": list(openfda.get("product_type", [])),
        "set_id": record.get("set_id"),
        "spl_id": record.get("id"),
        "spl_version": record.get("version"),
        "effective_time": record.get("effective_time"),
        "effective_date": _effective_date(record.get("effective_time")),
        "openfda_last_updated": meta.get("last_updated"),
        "sections": sections,
        "section_chars": {k: (len(v) if v else 0) for k, v in sections.items()},
        "omitted_fields_note": (
            "HTML table fields and all other SPL sections are not cached; only the sections "
            "listed above are kept. Omitted table fields: " + ", ".join(omitted)
        ),
    }


def make_fallback_label() -> Json:
    url = openfda_url(search='openfda.brand_name:"LIBTAYO"', limit=1)
    return {
        "source_url": url,
        "fetched_at": utc_now_iso(),
        "fetched": False,
        "license_note": LICENSE_OPENFDA,
        "note": LABEL_NOTE,
        "fallback_note": (
            "No cached label and --offline was given. Section text is intentionally empty "
            "rather than reproduced from memory; run scripts/fetch_public.py online to fill it."
        ),
        "drug": "LIBTAYO (cemiplimab-rwlc)",
        "brand": "LIBTAYO",
        "generic": "cemiplimab-rwlc",
        "manufacturer": None,
        "application_number": None,
        "route": [],
        "product_type": [],
        "set_id": None,
        "spl_id": None,
        "spl_version": None,
        "effective_time": None,
        "effective_date": None,
        "openfda_last_updated": None,
        "sections": dict.fromkeys(LABEL_SECTIONS),
        "section_chars": dict.fromkeys(LABEL_SECTIONS, 0),
        "omitted_fields_note": "n/a (fallback)",
    }


def fetch_label(opts: Options) -> StepResult:
    path = opts.public_dir / LABEL_FILE
    state = inspect_cache(path)
    if _use_cache(opts, state) and state.doc is not None:
        return StepResult("label", path, "cached", f"set_id={state.doc.get('set_id')}")
    if opts.offline:
        return _offline_result("label", path, state, make_fallback_label)
    _before_online_fetch("label", state)
    url = openfda_url(search='openfda.brand_name:"LIBTAYO"', limit=1)
    try:
        data = http_get_json(url)
        results = data.get("results") or []
        if not results:
            raise FetchError("openFDA returned no LIBTAYO label")
        doc = shape_label(results[0], data.get("meta", {}), url)
        if not doc["sections"]["adverse_reactions"]:
            raise FetchError("LIBTAYO label has no adverse_reactions section")
    except FetchError as exc:
        return _after_fetch_failure("label", path, exc, make_fallback_label, state)
    write_json(path, doc)
    detail = f"set_id={doc['set_id']} v{doc['spl_version']} effective {doc['effective_date']}"
    return StepResult("label", path, "fetched", detail)


# --------------------------------------------------------------------------------------
# Step 3: openFDA name counts (raw material for the con-med list)
# --------------------------------------------------------------------------------------

COUNT_QUERIES: dict[str, dict[str, str | int]] = {
    "generic_all": {"count": "openfda.generic_name.exact", "limit": 1000},
    "brand_all": {"count": "openfda.brand_name.exact", "limit": 1000},
    "generic_rx": {
        "search": 'openfda.product_type:"HUMAN PRESCRIPTION DRUG"',
        "count": "openfda.generic_name.exact",
        "limit": 1000,
    },
    "generic_otc": {
        "search": 'openfda.product_type:"HUMAN OTC DRUG"',
        "count": "openfda.generic_name.exact",
        "limit": 1000,
    },
}
GENERIC_QUERY_KEYS: tuple[str, ...] = ("generic_all", "generic_rx", "generic_otc")

TOKEN_RE = re.compile(r"[a-z][a-z'\-]+")
# Splits a brand into its word parts for the "already a known name" check, so 'senna-lax'
# and 'bayer aleve' are both seen to contain an existing entry.
WORD_PART_RE = re.compile(r"[\s\-]+")
COMBINATION_MARKERS: tuple[str, ...] = (",", " and ", "/", " with ", "+", " w/ ")


@dataclass(frozen=True)
class GenericCandidate:
    """A normalized generic name with its aggregated label count and raw openFDA spellings."""

    base: str
    count: int
    variants: tuple[str, ...]  # raw openFDA terms, highest count first


def load_medlist_config(path: Path) -> Json:
    if not path.exists():
        raise FetchError(f"medlist build config not found: {rel(path)}")
    cfg = read_json(path)
    required = (
        "max_entries",
        "top_generics",
        "max_brands_per_generic",
        "min_brand_label_count",
        "lookup_variants_per_generic",
        "min_name_letters",
        "min_token_letters",
        "max_brand_chars",
        "core_entries",
        "keep_verbatim",
        "salt_suffixes",
        "qualifier_tokens",
        "excluded_terms",
        "excluded_tokens",
        "homeopathic_tokens",
        "brand_suffix_tokens",
        "brand_junk_prefixes",
        "brand_junk_tokens",
        "brand_blocklist",
        "max_brand_edit_distance_from_generic",
    )
    missing = [key for key in required if key not in cfg]
    if missing:
        raise FetchError(f"{rel(path)} is missing keys: {', '.join(missing)}")
    return cfg


def letter_count(text: str) -> int:
    """Number of letters in a name, ignoring hyphens, apostrophes and spaces."""
    return sum(ch.isalpha() for ch in text)


def _shape_ok(tokens: list[str], cfg: Json) -> bool:
    """Length rules shared by generics and brands.

    The con-med matcher tries every free-text token of >= 4 characters at Levenshtein <= 2
    (CONTRACTS 1.7), so a 4-letter list entry is a false-positive magnet: 'doxy' matched
    'dose' and 'body', 'blip' matched 'slip'.  Every name therefore needs at least
    ``min_name_letters`` letters in total, every token at least ``min_token_letters``
    ('hi vetic', 'anusol hc'), and all tokens must be alphabetic (hyphens/apostrophes
    allowed inside a token).
    """
    if letter_count(" ".join(tokens)) < int(cfg["min_name_letters"]):
        return False
    if any(letter_count(tok) < int(cfg["min_token_letters"]) for tok in tokens):
        return False
    return all(TOKEN_RE.fullmatch(tok) for tok in tokens)


def normalize_generic(term: str, cfg: Json) -> str | None:
    """Turn a raw openFDA generic name into a lowercase base name, or ``None`` to drop it.

    Order of checks (each documented in ``medlist_build_config.json``):
    keep-verbatim list -> excluded whole names -> combination products -> drop numeric and
    qualifier tokens -> excluded / homeopathic tokens -> strip trailing salt words -> a name
    that is *only* a salt word ('potassium' from POTASSIUM CITRATE) is dropped -> shape
    check (1-3 alphabetic tokens, at least ``min_name_letters`` letters, <= 40 chars).
    """
    text = " ".join(term.replace(NBSP, " ").lower().split())
    if text in set(cfg["keep_verbatim"]):
        return text
    excluded_terms = set(cfg["excluded_terms"])
    if text in excluded_terms:
        return None
    padded = f" {text} "
    if any(marker in padded for marker in COMBINATION_MARKERS):
        return None
    qualifiers = set(cfg["qualifier_tokens"])
    tokens = [
        tok
        for tok in text.split()
        if not any(ch.isdigit() for ch in tok) and "%" not in tok and tok not in qualifiers
    ]
    if not tokens:
        return None
    blocked = set(cfg["excluded_tokens"]) | set(cfg["homeopathic_tokens"])
    if blocked & set(tokens):
        return None
    salts = set(cfg["salt_suffixes"])
    while len(tokens) > 1 and tokens[-1] in salts:
        tokens.pop()
    if len(tokens) == 1 and tokens[0] in salts:
        # 'POTASSIUM CITRATE' -> 'potassium', 'CALCIUM ACETATE' -> 'calcium': the cation is
        # not the medicine, and as a list entry it would swallow unrelated electrolyte labels.
        return None
    name = " ".join(tokens)
    if name in excluded_terms:
        return None
    if not 1 <= len(tokens) <= 3 or len(name) > 40:
        return None
    if not _shape_ok(tokens, cfg):
        return None
    return name


def rank_generics(raw: Json, cfg: Json) -> list[GenericCandidate]:
    """Aggregate the three generic-name count lists into ranked base names.

    For each raw spelling we keep its highest count across the lists (the lists overlap:
    ``generic_all`` is a superset of the Rx and OTC lists but is capped at 1,000 terms, so a
    prescription drug can appear only in ``generic_rx``).  Spellings that normalize to the
    same base are summed, e.g. ``DIPHENHYDRAMINE HYDROCHLORIDE`` + ``DIPHENHYDRAMINE HCL``.
    """
    best: dict[str, int] = {}
    for key in GENERIC_QUERY_KEYS:
        for row in raw.get("queries", {}).get(key, {}).get("results", []):
            term = str(row["term"])
            best[term] = max(best.get(term, 0), int(row["count"]))
    groups: dict[str, dict[str, int]] = {}
    for term, count in best.items():
        base = normalize_generic(term, cfg)
        if base is not None:
            groups.setdefault(base, {})[term] = count
    candidates = [
        GenericCandidate(
            base=base,
            count=sum(variants.values()),
            variants=tuple(sorted(variants, key=lambda t: (-variants[t], t))),
        )
        for base, variants in groups.items()
    ]
    candidates.sort(key=lambda c: (-c.count, c.base))
    return candidates


def edit_distance(a: str, b: str) -> int:
    """Plain Levenshtein distance (insert / delete / substitute, all cost 1)."""
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        current = [i]
        for j, cb in enumerate(b, start=1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def normalize_brand(term: str, cfg: Json) -> str | None:
    """Lowercase a raw openFDA brand name and strip dosage-form suffixes, or ``None`` to drop it.

    ``Seroquel XR`` -> ``seroquel``; ``Claritin 24HR`` -> ``claritin``; ``Wal-itin`` -> ``None``
    (store prefix); ``Stool Softener`` -> ``None`` (descriptor, not a brand); ``Doxy`` ->
    ``None`` (fewer than ``min_name_letters`` letters, see :func:`_shape_ok`).
    """
    tokens = [
        tok
        for tok in term.replace(NBSP, " ").lower().split()
        if not any(ch.isdigit() for ch in tok) and "%" not in tok
    ]
    if not tokens:
        return None
    strippable = set(cfg["brand_suffix_tokens"]) | set(cfg["salt_suffixes"])
    while len(tokens) > 1 and tokens[-1] in strippable:
        tokens.pop()
    blocked = (
        set(cfg["brand_junk_tokens"]) | set(cfg["excluded_tokens"]) | set(cfg["homeopathic_tokens"])
    )
    if blocked & set(tokens):
        return None
    prefixes = tuple(cfg["brand_junk_prefixes"])
    if any(tok.startswith(prefixes) for tok in tokens):
        return None
    name = " ".join(tokens)
    if not 1 <= len(tokens) <= 2 or len(name) > int(cfg["max_brand_chars"]):
        return None
    if not _shape_ok(tokens, cfg):
        return None
    return name


def select_brands(base: str, lookup: Json | None, cfg: Json, known_names: set[str]) -> list[str]:
    """Pick the few brand names from a generic's label hits that a participant might actually say.

    Label counts are merged after :func:`normalize_brand`, then a brand is rejected when it:

    * is the generic itself, contains it ("childrens loratadine") or is contained in it
      ("doxy" is a truncation of doxycycline, not a brand);
    * is within ``max_brand_edit_distance_from_generic`` edits of it (restatements and label
      typos such as "losortan");
    * is, or has a word part (split on spaces and hyphens) that is, a name already in the
      list (``known_names``: every generic plus every entry chosen so far), so "bayer aleve"
      and "senna-lax" never duplicate "aleve" / "senna";
    * is in ``brand_blocklist`` (brand families sold with several different active
      ingredients, where "the generic" is ambiguous and a count-based pick would be wrong
      with confidence 1.0, e.g. Dramamine = dimenhydrinate or meclizine);
    * was seen on fewer than ``min_brand_label_count`` labels.

    ``known_names`` is read only; the caller adds the chosen brands to it.
    """
    if not lookup:
        return []
    base_tokens = set(base.split())
    max_distance = int(cfg["max_brand_edit_distance_from_generic"])
    blocklist = set(cfg["brand_blocklist"])
    counts: dict[str, int] = {}
    for entry in lookup.get("lookups", []):
        for row in entry.get("results", []):
            name = normalize_brand(str(row["term"]), cfg)
            if name is not None:
                counts[name] = counts.get(name, 0) + int(row["count"])
    chosen: list[str] = []
    for name, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
        if count < int(cfg["min_brand_label_count"]):
            continue
        if base in name or name in base or base_tokens & set(name.split()):
            continue
        if name in known_names or name in blocklist or name in chosen:
            continue
        if set(WORD_PART_RE.split(name)) & (known_names | set(chosen)):
            continue
        if edit_distance(name, base) <= max_distance:
            continue
        chosen.append(name)
        if len(chosen) >= int(cfg["max_brands_per_generic"]):
            break
    return chosen


@dataclass(frozen=True)
class LookupOutcome:
    """What :func:`_fill_brand_lookups` did: how many generics gained a lookup, how many failed."""

    added: int
    failed: int

    @property
    def touched(self) -> bool:
        return self.added > 0


def _fill_brand_lookups(
    raw: Json,
    candidates: list[GenericCandidate],
    cfg: Json,
    *,
    persist: Callable[[], None] | None = None,
) -> LookupOutcome:
    """Fetch brand-name counts for every candidate generic that has no cached lookup yet.

    Resilient by design: a generic whose lookup fails after the HTTP retries is logged and
    skipped (nothing is stored for it, so the next run retries it), and ``persist`` is called
    every ``LOOKUP_PERSIST_EVERY`` generics, after the last one, and on Ctrl-C, so a cold
    run that dies at request 300 keeps the 299 lookups it already made.  When the outcome
    says ``touched``, every lookup added is already on disk; the caller need not write again.
    """
    lookups: Json = raw.setdefault("brands_by_generic", {})
    todo: list[GenericCandidate] = []
    seen: set[str] = set()
    for candidate in candidates:
        if candidate.base not in lookups and candidate.base not in seen:
            todo.append(candidate)
            seen.add(candidate.base)
    if not todo:
        return LookupOutcome(0, 0)
    per_generic = int(cfg["lookup_variants_per_generic"])
    log.info(
        "fetching brand lookups for %d generics (%d queries max)",
        len(todo),
        len(todo) * per_generic,
    )
    added = failed = 0
    unsaved = 0

    def save() -> None:
        nonlocal unsaved
        if persist is not None and unsaved:
            persist()
        unsaved = 0

    try:
        for index, candidate in enumerate(todo, start=1):
            entries: list[Json] = []
            try:
                for variant in candidate.variants[:per_generic]:
                    url = openfda_url(
                        search=f'openfda.generic_name.exact:"{variant}"',
                        count="openfda.brand_name.exact",
                        limit=50,
                    )
                    entries.append(
                        {"query_term": variant, "url": url, "results": openfda_count(url)}
                    )
                    time.sleep(OPENFDA_POLITE_DELAY_S)
            except FetchError as exc:
                failed += 1
                log.warning(
                    "  brand lookup for %r failed (%s); will retry next run", candidate.base, exc
                )
            else:
                lookups[candidate.base] = {"fetched_at": utc_now_iso(), "lookups": entries}
                added += 1
                unsaved += 1
            if index % LOOKUP_PERSIST_EVERY == 0 or index == len(todo):
                log.info("  brand lookups %d/%d (%d failed)", index, len(todo), failed)
                save()
    except KeyboardInterrupt:
        log.warning("interrupted; saving %d brand lookups fetched so far", added)
        save()
        raise
    return LookupOutcome(added, failed)


def make_fallback_medlist_raw() -> Json:
    return {
        "source_url": OPENFDA_LABEL_API,
        "fetched_at": utc_now_iso(),
        "fetched": False,
        "license_note": LICENSE_OPENFDA,
        "note": MEDLIST_RAW_NOTE,
        "fallback_note": (
            "No cached openFDA counts and --offline was given. --build-medlist will emit the "
            "hand-curated core list only until this is refreshed online."
        ),
        "openfda_last_updated": None,
        "queries": {},
        "candidate_generics": [],
        "brands_by_generic": {},
    }


def fetch_medlist_raw(opts: Options) -> StepResult:
    path = opts.public_dir / MEDLIST_RAW_FILE
    state = inspect_cache(path)
    if opts.offline:
        if _use_cache(opts, state) and state.doc is not None:
            return StepResult("medlist", path, "cached", _medlist_raw_detail(state.doc))
        return _offline_result("medlist", path, state, make_fallback_medlist_raw)

    try:
        cfg = load_medlist_config(opts.medlist_config)
        if _use_cache(opts, state) and state.doc is not None:
            # Idempotent top-up: the config may now ask for more generics, or normalize them
            # differently, than when the cache was written.  Only missing lookups touch the
            # network; the ranked candidate list is refreshed so the file stays traceable.
            cached = state.doc
            candidates = rank_generics(cached, cfg)[: int(cfg["top_generics"])]
            rows = _candidate_rows(candidates)
            ranking_changed = rows != cached.get("candidate_generics")
            cached["candidate_generics"] = rows
            outcome = _fill_brand_lookups(
                cached, candidates, cfg, persist=lambda: write_json(path, cached)
            )
            if not outcome.touched and not ranking_changed:
                if outcome.failed:
                    return StepResult(
                        "medlist", path, "partial", f"{outcome.failed} brand lookups failed"
                    )
                return StepResult("medlist", path, "cached", _medlist_raw_detail(cached))
            if not outcome.touched:
                # Only the ranking changed; the lookup loop had nothing to persist.
                write_json(path, cached)
            detail = f"+{outcome.added} brand lookups"
            if ranking_changed:
                detail += ", candidate ranking refreshed"
            if outcome.failed:
                return StepResult(
                    "medlist", path, "partial", f"{detail}, {outcome.failed} failed (re-run)"
                )
            return StepResult("medlist", path, "updated", detail)

        _before_online_fetch("medlist", state)
        doc: Json = {
            "source_url": OPENFDA_LABEL_API,
            "fetched_at": utc_now_iso(),
            "fetched": True,
            "license_note": LICENSE_OPENFDA,
            "note": MEDLIST_RAW_NOTE,
            "openfda_last_updated": None,
            "queries": {},
            "candidate_generics": [],
            "brands_by_generic": {},
        }
        for key, params in COUNT_QUERIES.items():
            url = openfda_url(**params)
            data = http_get_json(url)
            results = [
                {"term": str(r["term"]), "count": int(r["count"])} for r in data.get("results", [])
            ]
            doc["queries"][key] = {"url": url, "n": len(results), "results": results}
            doc["openfda_last_updated"] = data.get("meta", {}).get("last_updated")
            log.info("openFDA %s: %d terms", key, len(results))
            time.sleep(OPENFDA_POLITE_DELAY_S)
        candidates = rank_generics(doc, cfg)[: int(cfg["top_generics"])]
        doc["candidate_generics"] = _candidate_rows(candidates)
        # The count queries are the expensive, all-or-nothing part; from here on progress is
        # written as it is made, so a lookup failure never discards them.
        outcome = _fill_brand_lookups(doc, candidates, cfg, persist=lambda: write_json(path, doc))
    except FetchError as exc:
        return _after_fetch_failure("medlist", path, exc, make_fallback_medlist_raw, state)
    if not outcome.touched:
        # Nothing to look up (or every lookup failed): the loop never persisted the document.
        write_json(path, doc)
    if outcome.failed:
        detail = f"{_medlist_raw_detail(doc)}; {outcome.failed} brand lookups failed (re-run)"
        return StepResult("medlist", path, "partial", detail)
    return StepResult("medlist", path, "fetched", _medlist_raw_detail(doc))


def _candidate_rows(candidates: list[GenericCandidate]) -> list[Json]:
    return [{"base": c.base, "count": c.count, "variants": list(c.variants)} for c in candidates]


def _medlist_raw_detail(doc: Json) -> str:
    queries = doc.get("queries", {})
    return (
        f"{len(queries)} count queries, {len(doc.get('brands_by_generic', {}))} brand lookups, "
        f"openFDA data {doc.get('openfda_last_updated')}"
    )


# --------------------------------------------------------------------------------------
# --build-medlist: raw counts + core list -> docs/CONTRACTS.md section 1.6 schema
# --------------------------------------------------------------------------------------

MEDLIST_SOURCE = (
    "openFDA drug label API (api.fda.gov/drug/label.json) brand/generic names; "
    "hand-curated core list merged in"
)
MEDLIST_RATIONALE = (
    "Small bundled list for deterministic string matching. NOT RxNorm. Not a formulary."
)


def build_medlist(raw: Json, cfg: Json, *, built_at: str) -> Json:
    """Pure function: (raw openFDA counts, build config) -> medlist.json document.

    Assembly order, which decides what survives ``max_entries``:

    1. the hand-curated core entries (they win every name collision, so the contract's
       brand -> generic mappings can never be overridden by openFDA data);
    2. **every** one of the ``top_generics`` ranked generics, so a common drug such as
       warfarin or montelukast is never squeezed out by brands of a more common one;
    3. brands, walking the generics in rank order, until the cap is reached.
    """
    entries: dict[str, Json] = {}

    def add(name: str, kind: str, generic: str) -> bool:
        if name in entries:
            return False
        entries[name] = {"name": name, "kind": kind, "generic": generic}
        return True

    for core in cfg["core_entries"]:
        add(str(core["name"]).lower(), str(core["kind"]), str(core["generic"]).lower())
    n_core = len(entries)

    max_entries = int(cfg["max_entries"])
    candidates = rank_generics(raw, cfg)[: int(cfg["top_generics"])]
    n_generic = sum(1 for c in candidates if add(c.base, "generic", c.base))
    if len(entries) > max_entries:
        raise FetchError(
            f"medlist: {len(entries)} core + generic entries exceed max_entries={max_entries}; "
            "raise max_entries or lower top_generics in the build config"
        )

    lookups = raw.get("brands_by_generic", {})
    known_names = set(entries)
    n_brand = 0
    for candidate in candidates:
        if len(entries) >= max_entries:
            break
        for brand in select_brands(candidate.base, lookups.get(candidate.base), cfg, known_names):
            if len(entries) >= max_entries:
                break
            if add(brand, "brand", candidate.base):
                known_names.add(brand)
                n_brand += 1

    ordered = [entries[name] for name in sorted(entries)]
    return {
        "source": MEDLIST_SOURCE,
        "rationale": MEDLIST_RATIONALE,
        "built_at": built_at,
        "is_rxnorm": False,
        "build_info": {
            "built_by": "scripts/fetch_public.py --build-medlist",
            "openfda_raw_fetched": bool(raw.get("fetched")),
            "openfda_raw_fetched_at": raw.get("fetched_at"),
            "openfda_last_updated": raw.get("openfda_last_updated"),
            "n_entries": len(ordered),
            "n_core": n_core,
            "n_openfda_generic": n_generic,
            "n_openfda_brand": n_brand,
            "max_entries": max_entries,
            "top_generics": int(cfg["top_generics"]),
            "order_rule": (
                "core entries, then every ranked generic, then brands in generic rank order "
                "until max_entries"
            ),
            "name_rule": (
                f"every name has >= {cfg['min_name_letters']} letters and every token >= "
                f"{cfg['min_token_letters']} letters, because the matcher tries 4+ character "
                "tokens at Levenshtein <= 2"
            ),
            "brand_rule": (
                "openFDA brands kept only when seen on >= "
                f"{cfg['min_brand_label_count']} labels after merging dosage-form suffixes, "
                "1-2 alphabetic words, not a generic name, not a substring or superstring of "
                f"its generic or within {cfg['max_brand_edit_distance_from_generic']} edits "
                "of it, not a store/descriptor pseudo-brand, not in brand_blocklist; at most "
                f"{cfg['max_brands_per_generic']} per generic"
            ),
            "brand_mapping_note": (
                "brand -> generic comes from openFDA label counts (which generic the brand "
                "name appears on most), not from a drug dictionary; brand families sold with "
                "several different active ingredients are excluded via brand_blocklist rather "
                "than mapped to one of them"
            ),
        },
        "entries": ordered,
    }


def run_build_medlist(opts: Options, out: Path) -> StepResult:
    raw_path = opts.public_dir / MEDLIST_RAW_FILE
    if not raw_path.exists():
        raise FetchError(f"{rel(raw_path)} is missing; run the fetch first (or without --only)")
    raw = read_json(raw_path)
    cfg = load_medlist_config(opts.medlist_config)
    doc = build_medlist(raw, cfg, built_at=utc_now_iso())
    write_json(out, doc)
    info = doc["build_info"]
    sample = ", ".join(f"{e['name']}->{e['generic']}" for e in doc["entries"][:6])
    log.info("medlist: %d entries (sample: %s, ...)", info["n_entries"], sample)
    detail = (
        f"{info['n_entries']} entries: core {info['n_core']}, openFDA generic "
        f"{info['n_openfda_generic']}, openFDA brand {info['n_openfda_brand']}"
    )
    return StepResult("build-medlist", out, "built", detail)


# --------------------------------------------------------------------------------------
# Step 4: NCI CTCAE v5.0 excerpt
# --------------------------------------------------------------------------------------

CTCAE_REQUIRED_COLUMNS: tuple[str, ...] = (
    "MedDRA Code",
    "MedDRA SOC",
    "CTCAE Term",
    "Grade 1",
    "Grade 2",
    "Grade 3",
    "Grade 4",
    "Grade 5",
    "Definition",
)


def _clean_cell(value: object) -> str | None:
    """Workbook cell -> stripped string (``None`` for empty).  Integer codes stay digit-only."""
    if value is None:
        return None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    text = " ".join(str(value).replace(NBSP, " ").split())
    return text or None


def _grade_text(value: object) -> str | None:
    text = _clean_cell(value)
    return None if text in (None, "-") else text


def parse_ctcae_workbook(body: bytes) -> tuple[str, list[Json]]:
    """Extract the ten Interim terms from the CTCAE v5.0 workbook bytes.

    Returns ``(sheet_name, rows)`` with rows in ``CTCAE_TERMS`` order.
    """
    try:
        import openpyxl
    except ImportError as exc:
        raise FetchError(OPENPYXL_HINT) from exc

    workbook = openpyxl.load_workbook(io.BytesIO(body), read_only=True, data_only=True)
    try:
        sheet_name = CTCAE_SHEET if CTCAE_SHEET in workbook.sheetnames else workbook.sheetnames[0]
        rows = workbook[sheet_name].iter_rows(values_only=True)
        header = [_clean_cell(cell) or "" for cell in next(rows)]
        columns = {name: index for index, name in enumerate(header)}
        missing = [name for name in CTCAE_REQUIRED_COLUMNS if name not in columns]
        if missing:
            raise FetchError(f"CTCAE sheet {sheet_name!r} lacks columns: {missing}")
        wanted = {term for term, _ in CTCAE_TERMS}
        found: dict[str, tuple[object, ...]] = {}
        for row in rows:
            term = _clean_cell(row[columns["CTCAE Term"]])
            if term in wanted and term not in found:
                found[term] = tuple(row)
            if len(found) == len(wanted):
                break
    finally:
        workbook.close()

    out: list[Json] = []
    for term, item_id in CTCAE_TERMS:
        if term not in found:
            raise FetchError(f"CTCAE term {term!r} not found in sheet {sheet_name!r}")
        row = found[term]
        out.append(
            {
                "interim_item_id": item_id,
                "ctcae_term": term,
                "meddra_code": _clean_cell(row[columns["MedDRA Code"]]),
                "meddra_soc": _clean_cell(row[columns["MedDRA SOC"]]),
                "grades": {
                    str(grade): _grade_text(row[columns[f"Grade {grade}"]]) for grade in range(1, 6)
                },
                "definition": _clean_cell(row[columns["Definition"]]),
                "navigational_note": _clean_cell(row[columns["Navigational Note"]])
                if "Navigational Note" in columns
                else None,
                "ctcae_v5_change": _clean_cell(row[columns["CTCAE v5.0 Change"]])
                if "CTCAE v5.0 Change" in columns
                else None,
            }
        )
    return sheet_name, out


def _ctcae_doc(terms: list[Json], *, fetched: bool, sheet: str | None, sha256: str | None) -> Json:
    doc: Json = {
        "source_url": CTCAE_XLSX_URL,
        "listing_url": CTCAE_LISTING_URL,
        "fetched_at": utc_now_iso(),
        "fetched": fetched,
        "license_note": LICENSE_CTCAE,
        "note": CTCAE_NOTE,
        "grade_null_note": CTCAE_GRADE_NULL_NOTE,
        "meddra_code_note": CTCAE_CODE_NOTE,
        "version": "CTCAE v5.0",
        "published": CTCAE_PUBLISHED,
        "workbook_sheet": sheet,
        "workbook_sha256": sha256,
        "n_terms": len(terms),
        "terms": terms,
    }
    if not fetched:
        doc["fallback_note"] = (
            "Offline copy transcribed by the Interim team from the 2017-11-27 workbook "
            "(same sheet, same wording). Run scripts/fetch_public.py online to re-extract."
        )
    return doc


def make_fallback_ctcae() -> Json:
    terms = [
        {
            "interim_item_id": item_id,
            "ctcae_term": term,
            **json.loads(json.dumps(FALLBACK_CTCAE_ROWS[term])),
        }
        for term, item_id in CTCAE_TERMS
    ]
    return _ctcae_doc(terms, fetched=False, sheet=CTCAE_SHEET, sha256=None)


def looks_like_xlsx(body: bytes, content_type: str) -> bool:
    """True when ``body`` can be an .xlsx (zip magic bytes), whatever the header says.

    The EVS listing is a client-rendered app that answers unknown paths with HTML and HTTP
    200, so the check matters; but the Content-Type is only advisory, because static hosts
    commonly serve .xlsx as ``application/octet-stream``.  The workbook is then verified for
    real by parsing it (sheet and column checks in :func:`parse_ctcae_workbook`).
    """
    if not body.startswith(XLSX_MAGIC):
        return False
    if "spreadsheetml" not in content_type:
        log.info("CTCAE download has content type %r; accepting it by zip signature", content_type)
    return True


def fetch_ctcae(opts: Options) -> StepResult:
    path = opts.public_dir / CTCAE_FILE
    state = inspect_cache(path)
    if _use_cache(opts, state) and state.doc is not None:
        return StepResult("ctcae", path, "cached", f"{state.doc.get('n_terms')} terms")
    if opts.offline:
        return _offline_result("ctcae", path, state, make_fallback_ctcae)
    _before_online_fetch("ctcae", state)
    try:
        body, content_type = http_get(
            CTCAE_XLSX_URL,
            accept="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, */*",
        )
        if not looks_like_xlsx(body, content_type):
            raise FetchError(
                f"{CTCAE_XLSX_URL} did not return an .xlsx (content type {content_type!r}, "
                f"{len(body)} bytes); check the listing at {CTCAE_LISTING_URL}"
            )
        sheet, terms = parse_ctcae_workbook(body)
        doc = _ctcae_doc(terms, fetched=True, sheet=sheet, sha256=hashlib.sha256(body).hexdigest())
    except FetchError as exc:
        return _after_fetch_failure("ctcae", path, exc, make_fallback_ctcae, state)
    write_json(path, doc)
    return StepResult("ctcae", path, "fetched", f"{len(terms)} terms from sheet {sheet!r}")


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------

STEPS: dict[str, Callable[[Options], StepResult]] = {
    "study": fetch_study,
    "label": fetch_label,
    "medlist": fetch_medlist_raw,
    "ctcae": fetch_ctcae,
}

EXAMPLES = """\
examples:
  fetch_public.py                      fetch whatever is missing from data/public/
  fetch_public.py --force              refetch every file
  fetch_public.py --offline            never touch the network; bundled fallbacks if needed
  fetch_public.py --only study --nct NCT02760498
  fetch_public.py --build-medlist --out /tmp/medlist.json
  fetch_public.py --offline --strict   exit 1 unless every cached file is a real pull
                                       (freshness check for CI; opens no socket)
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fetch_public.py",
        description=(
            "Fetch and cache Interim's public reference data (ClinicalTrials.gov, openFDA, "
            "NCI CTCAE). Idempotent; cached files are left untouched unless --force."
        ),
        epilog=EXAMPLES,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--public-dir",
        type=Path,
        default=DEFAULT_PUBLIC_DIR,
        help="cache directory (default: data/public)",
    )
    parser.add_argument("--offline", action="store_true", help="use the cache only; no network")
    parser.add_argument("--force", action="store_true", help="ignore the cache and refetch")
    parser.add_argument(
        "--only",
        action="append",
        choices=sorted(STEPS),
        metavar="STEP",
        help=f"run only this step (repeatable): {', '.join(STEPS)}",
    )
    parser.add_argument(
        "--nct",
        action="append",
        metavar="NCTxxxxxxxx",
        help="NCT id to try first (repeatable); DEMO_NCT_ID env and the defaults follow",
    )
    parser.add_argument(
        "--build-medlist",
        action="store_true",
        help="after fetching, build the CONTRACTS 1.6 medlist.json from the cached counts",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_MEDLIST_OUT,
        help=f"where --build-medlist writes (default: {MEDLIST_OUT_DISPLAY})",
    )
    parser.add_argument(
        "--medlist-config",
        type=Path,
        default=DEFAULT_PUBLIC_DIR / MEDLIST_CONFIG_FILE,
        help="build rules for the medlist (default: data/public/medlist_build_config.json)",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="exit 1 unless every file is a real pull (no fallback, stale cache or partial pull)",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    return parser


def print_summary(results: list[StepResult]) -> None:
    width = max(len(r.name) for r in results)
    print("\nfetch_public summary")
    for result in results:
        line = f"  {result.name:<{width}}  {result.status:<11}  {rel(result.path)}"
        if result.detail:
            line += f"  ({result.detail})"
        print(line)


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.offline and args.force:
        parser.error("--offline and --force are mutually exclusive")
    # Windows consoles often run cp1252; never let a stray registry character crash a log line.
    for stream in (sys.stdout, sys.stderr):
        if isinstance(stream, io.TextIOWrapper):
            stream.reconfigure(errors="replace")
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="[fetch_public] %(levelname)s %(message)s",
        stream=sys.stderr,
    )

    env_nct = os.environ.get("DEMO_NCT_ID", "").strip()
    candidates = tuple(
        dict.fromkeys([*(args.nct or []), *([env_nct] if env_nct else []), *NCT_CANDIDATES])
    )
    opts = Options(
        public_dir=args.public_dir,
        offline=args.offline,
        force=args.force,
        nct_candidates=candidates,
        medlist_config=args.medlist_config,
    )
    log.info("public dir %s | offline=%s force=%s", rel(opts.public_dir), opts.offline, opts.force)

    results: list[StepResult] = []
    for name in args.only or list(STEPS):
        try:
            results.append(STEPS[name](opts))
        except (FetchError, OSError, KeyError, ValueError) as exc:
            log.error("%s: %s", name, exc)
            results.append(StepResult(name, opts.public_dir / STEP_FILES[name], "failed", str(exc)))

    if args.build_medlist:
        try:
            results.append(run_build_medlist(opts, args.out))
        except (FetchError, OSError, KeyError, ValueError) as exc:
            log.error("build-medlist: %s", exc)
            results.append(StepResult("build-medlist", args.out, "failed", str(exc)))

    print_summary(results)
    failed = any(r.status == "failed" for r in results)
    degraded = [r for r in results if r.status in DEGRADED_STATUSES]
    if failed:
        return 1
    if args.strict and degraded:
        log.error(
            "--strict: not every file is a fresh pull (%s)",
            ", ".join(f"{r.name}={r.status}" for r in degraded),
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
