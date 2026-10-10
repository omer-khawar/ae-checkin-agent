"""Tests for scripts/fetch_public.py.

Everything here runs against the committed cache under data/public/ and never touches the
network: an autouse fixture replaces ``urlopen`` with a function that fails the test.

Run from the repo root:
    .venv/Scripts/python.exe -m pytest scripts/tests -q
"""

from __future__ import annotations

import io
import json
import shutil
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError

import pytest

import fetch_public as fp

PUBLIC = fp.DEFAULT_PUBLIC_DIR
CACHE_FILES = (fp.STUDY_FILE, fp.LABEL_FILE, fp.MEDLIST_RAW_FILE, fp.CTCAE_FILE)
CONFIG = PUBLIC / fp.MEDLIST_CONFIG_FILE
# Verbatim from docs/CONTRACTS.md section 1.6: every one of these must be in the built list.
CORE_NAMES = [
    "acetaminophen", "tylenol", "ibuprofen", "advil", "motrin", "naproxen", "aleve", "aspirin",
    "loratadine", "claritin", "cetirizine", "zyrtec", "diphenhydramine", "benadryl", "loperamide",
    "imodium", "omeprazole", "prilosec", "pantoprazole", "famotidine", "pepcid", "ondansetron",
    "zofran", "prednisone", "dexamethasone", "amoxicillin", "azithromycin", "ciprofloxacin",
    "doxycycline", "metformin", "lisinopril", "amlodipine", "atorvastatin", "levothyroxine",
    "metoprolol", "hydrocortisone", "triamcinolone", "gabapentin", "sertraline", "albuterol",
    "melatonin", "vitamin d", "multivitamin",
]  # fmt: skip
CORE_BRAND_TO_GENERIC = {
    "tylenol": "acetaminophen",
    "advil": "ibuprofen",
    "motrin": "ibuprofen",
    "aleve": "naproxen",
    "claritin": "loratadine",
    "zyrtec": "cetirizine",
    "benadryl": "diphenhydramine",
    "imodium": "loperamide",
    "prilosec": "omeprazole",
    "pepcid": "famotidine",
    "zofran": "ondansetron",
}


def _n_core() -> int:
    """Number of hand-curated core entries in data/public/medlist_build_config.json."""
    import json as _json
    from pathlib import Path as _Path

    cfg_path = (
        _Path(__file__).resolve().parents[2] / "data" / "public" / "medlist_build_config.json"
    )
    cfg = _json.loads(cfg_path.read_text(encoding="utf-8"))
    return len(cfg["core_entries"])


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Any attempt to open a socket fails the test."""

    def _refuse(*args: Any, **_kwargs: Any) -> Any:
        raise AssertionError(f"network access attempted during tests: {args[:1]}")

    monkeypatch.setattr(fp, "urlopen", _refuse)


@pytest.fixture
def cache_copy(tmp_path: Path) -> Path:
    """A throwaway copy of the committed cache so runs can never touch data/public."""
    target = tmp_path / "public"
    target.mkdir()
    for name in CACHE_FILES:
        shutil.copyfile(PUBLIC / name, target / name)
    return target


@pytest.fixture
def fallback_dir(tmp_path: Path) -> Path:
    """A directory holding only the bundled fallbacks, as a no-network first run leaves it."""
    target = tmp_path / "fallbacks"
    assert fp.main(["--offline", "--public-dir", str(target)]) == 0
    for name in CACHE_FILES:
        assert fp.read_json(target / name)["fetched"] is False
    return target


@pytest.fixture
def cfg() -> dict[str, Any]:
    return fp.load_medlist_config(CONFIG)


def _load(name: str) -> dict[str, Any]:
    return fp.read_json(PUBLIC / name)


def _summary_statuses(out: str) -> dict[str, str]:
    """Parse the printed summary into ``{step: status}``."""
    statuses: dict[str, str] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[0] in (*fp.STEPS, "build-medlist"):
            statuses[parts[0]] = parts[1]
    return statuses


def _label_record() -> dict[str, Any]:
    """A minimal openFDA label response shaped like the real LIBTAYO one."""
    return {
        "meta": {"last_updated": "2026-10-09"},
        "results": [
            {
                "openfda": {
                    "brand_name": ["LIBTAYO"],
                    "generic_name": ["CEMIPLIMAB-RWLC"],
                    "manufacturer_name": ["Regeneron Pharmaceuticals, Inc."],
                },
                "set_id": "test-set",
                "id": "test-spl",
                "version": "9",
                "effective_time": "20260831",
                "adverse_reactions": ["6 ADVERSE REACTIONS " + "x" * 1200],
                "warnings_and_cautions": ["5 WARNINGS AND PRECAUTIONS"],
                "indications_and_usage": ["1 INDICATIONS AND USAGE"],
            }
        ],
    }


def _ctcae_workbook_bytes() -> bytes:
    """Build a tiny workbook with the real header row and the ten bundled term rows."""
    openpyxl = pytest.importorskip("openpyxl")
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.title = fp.CTCAE_SHEET
    header = [
        "MedDRA Code",
        "MedDRA SOC",
        "CTCAE Term",
        "Grade 1",
        "Grade 2",
        "Grade 3",
        "Grade 4",
        "Grade 5",
        "Definition",
        "Navigational Note",
        "CTCAE v5.0 Change",
    ]
    sheet.append(header)
    sheet.append(
        [10000000, "Some SOC", "Unrelated term", "a", "b", "c", "-", "-", "def", None, None]
    )
    for term, row in fp.FALLBACK_CTCAE_ROWS.items():
        grades = [row["grades"][str(g)] or "-" for g in range(1, 6)]
        sheet.append(
            [
                int(row["meddra_code"]),
                row["meddra_soc"],
                term,
                *grades,
                row["definition"],
                row["navigational_note"],
                row["ctcae_v5_change"],
            ]
        )
    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()


# ---- provenance fields every cached file must carry -----------------------------------


@pytest.mark.parametrize("name", CACHE_FILES)
def test_every_cache_file_carries_provenance(name: str) -> None:
    doc = _load(name)
    for key in ("source_url", "fetched_at", "license_note", "fetched"):
        assert key in doc, f"{name} lacks {key}"
    assert doc["source_url"].startswith("https://")
    assert doc["fetched_at"].endswith("Z")
    assert isinstance(doc["fetched"], bool)


# ---- study.json ---------------------------------------------------------------------------


def test_cached_study_is_a_regeneron_record() -> None:
    doc = _load(fp.STUDY_FILE)
    assert fp.NCT_RE.match(doc["nct_id"])
    assert "regeneron" in doc["sponsor"].lower()
    assert doc["study_id"], "orgStudyId (sponsor protocol id) must be present"
    assert doc["official_url"] == f"https://clinicaltrials.gov/study/{doc['nct_id']}"
    assert doc["title"]["official"] and doc["title"]["brief"]
    assert doc["phase"] and doc["status"]
    assert doc["conditions"] and doc["interventions"]
    assert all({"name", "type", "other_names"} <= set(i) for i in doc["interventions"])
    assert "synthetic" in doc["note"]


def test_study_carries_flat_fields_for_the_data_model() -> None:
    """CLAUDE.md 6 models Study.title as a string and interventions[] as a flat list."""
    for doc in (_load(fp.STUDY_FILE), fp.make_fallback_study()):
        assert doc["title_display"] == doc["title"]["brief"]
        assert isinstance(doc["title_display"], str)
        assert doc["intervention_names"] == [i["name"] for i in doc["interventions"]]
        assert all(isinstance(n, str) for n in doc["intervention_names"])
        assert "UTF-8" in doc["reader_note"] and "title_display" in doc["reader_note"]
    cached = _load(fp.STUDY_FILE)
    # The registry prints a fullwidth comma in one condition; the file must round-trip it.
    assert any(fp.FULLWIDTH_COMMA in c for c in cached["conditions"])
    raw_text = (PUBLIC / fp.STUDY_FILE).read_bytes().decode("utf-8")
    assert fp.FULLWIDTH_COMMA in raw_text, "study.json must be written as UTF-8, not escaped"


def test_humanize_phase() -> None:
    assert fp.humanize_phase("PHASE3") == "Phase 3"
    assert fp.humanize_phase("EARLY_PHASE1") == "Early Phase 1"
    assert fp.humanize_phase("NA") == "Not applicable"


def test_shape_study_reads_the_v2_protocol_section() -> None:
    protocol = {
        "identificationModule": {
            "nctId": "NCT00000001",
            "orgStudyIdInfo": {"id": "R-TEST-1"},
            "briefTitle": "Brief",
            "officialTitle": "Official",
        },
        "statusModule": {"overallStatus": "COMPLETED", "startDateStruct": {"date": "2020-01-01"}},
        "sponsorCollaboratorsModule": {"leadSponsor": {"name": "Regeneron Pharmaceuticals"}},
        "designModule": {"phases": ["PHASE3"], "enrollmentInfo": {"count": 5, "type": "ACTUAL"}},
        "conditionsModule": {"conditions": ["X"]},
        "armsInterventionsModule": {"interventions": [{"name": "cemiplimab", "type": "DRUG"}]},
    }
    doc = fp.shape_study(protocol, "direct:NCT00000001")
    assert doc["study_id"] == "R-TEST-1"
    assert doc["phase"] == "Phase 3"
    assert doc["start_date"] == "2020-01-01"
    assert doc["completion_date"] is None
    assert doc["interventions"] == [{"name": "cemiplimab", "type": "DRUG", "other_names": []}]
    assert doc["intervention_names"] == ["cemiplimab"]
    assert doc["title_display"] == "Brief"
    assert doc["raw"]["protocolSection"]["armsInterventionsModule"]["interventions"]


# ---- libtayo_label_excerpt.json ---------------------------------------------------------


def test_cached_label_excerpt() -> None:
    doc = _load(fp.LABEL_FILE)
    assert doc["brand"] == "LIBTAYO"
    assert doc["generic"] == "cemiplimab-rwlc"
    assert doc["note"] == "public label excerpt, reference only; not clinical guidance"
    if doc["fetched"]:
        assert doc["set_id"] and doc["effective_time"]
        assert "ADVERSE REACTIONS" in doc["sections"]["adverse_reactions"]
        assert doc["section_chars"]["adverse_reactions"] > 1000


def test_effective_date_parsing() -> None:
    assert fp._effective_date("20260831") == "2026-08-31"
    assert fp._effective_date(None) is None
    assert fp._effective_date("2026") is None


# ---- ctcae_v5_excerpt.json ----------------------------------------------------------------


def test_cached_ctcae_has_exactly_the_ten_terms_in_item_order() -> None:
    doc = _load(fp.CTCAE_FILE)
    assert doc["n_terms"] == 10
    assert [t["ctcae_term"] for t in doc["terms"]] == [term for term, _ in fp.CTCAE_TERMS]
    assert [t["interim_item_id"] for t in doc["terms"]] == [item for _, item in fp.CTCAE_TERMS]
    for term in doc["terms"]:
        assert term["meddra_code"].isdigit() and len(term["meddra_code"]) == 8
        assert set(term["grades"]) == {"1", "2", "3", "4", "5"}
        assert all(term["grades"][g] for g in ("1", "2", "3")), term["ctcae_term"]
        assert term["definition"]
    dyspnea = doc["terms"][0]
    assert dyspnea["meddra_code"] == "10013963"
    assert dyspnea["grades"]["3"] == "Shortness of breath at rest; limiting self care ADL"


def test_ctcae_files_say_which_table_is_the_runtime_source() -> None:
    """Two tables carry the ten terms; this one must say it is the reference view."""
    for doc in (_load(fp.CTCAE_FILE), fp.make_fallback_ctcae()):
        note = doc["meddra_code_note"]
        assert "as printed" in note and "ctcae_terms.json" in note and "meddra_code_mock" in note
        assert "no MedDRA dictionary" in note


def test_parse_ctcae_workbook_extracts_the_ten_rows_in_item_order() -> None:
    sheet, rows = fp.parse_ctcae_workbook(_ctcae_workbook_bytes())
    assert sheet == fp.CTCAE_SHEET
    assert [r["ctcae_term"] for r in rows] == [term for term, _ in fp.CTCAE_TERMS]
    cough = rows[1]
    assert cough["meddra_code"] == "10011224"  # integer cell -> digit string
    assert cough["grades"]["4"] is None  # "-" -> null
    assert rows[4]["ctcae_v5_change"] == "Clarification: Grade 2, 3, Definition"


def test_looks_like_xlsx_trusts_the_zip_signature_over_the_header() -> None:
    body = fp.XLSX_MAGIC + b"rest of archive"
    assert fp.looks_like_xlsx(body, "application/octet-stream")
    assert fp.looks_like_xlsx(
        body, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    assert not fp.looks_like_xlsx(b"<!doctype html><html>", "text/html")
    assert not fp.looks_like_xlsx(
        b"", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )


def test_fetch_ctcae_accepts_octet_stream_and_rejects_html(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A static host serving the workbook as octet-stream must not downgrade to the fallback,
    and the EVS app answering an unknown path with HTML + HTTP 200 must."""
    workbook = _ctcae_workbook_bytes()
    public = tmp_path / "public"

    monkeypatch.setattr(fp, "http_get", lambda _url, **_: (workbook, "application/octet-stream"))
    assert fp.main(["--only", "ctcae", "--public-dir", str(public)]) == 0
    doc = fp.read_json(public / fp.CTCAE_FILE)
    assert doc["fetched"] is True and doc["n_terms"] == 10 and doc["workbook_sha256"]
    assert _summary_statuses(capsys.readouterr().out)["ctcae"] == "fetched"

    monkeypatch.setattr(fp, "http_get", lambda _url, **_: (b"<!doctype html>", "text/html"))
    assert fp.main(["--only", "ctcae", "--public-dir", str(tmp_path / "html")]) == 0
    doc = fp.read_json(tmp_path / "html" / fp.CTCAE_FILE)
    assert doc["fetched"] is False and "fallback_note" in doc
    assert _summary_statuses(capsys.readouterr().out)["ctcae"] == "fallback"


def test_ctcae_fallback_matches_the_fetched_excerpt_text() -> None:
    """The bundled offline copy must not drift from what NCI publishes."""
    cached = _load(fp.CTCAE_FILE)
    if not cached["fetched"]:
        pytest.skip("cache itself is the fallback; nothing to compare against")
    fallback = fp.make_fallback_ctcae()
    assert fallback["fetched"] is False
    for live, bundled in zip(cached["terms"], fallback["terms"], strict=True):
        assert live["ctcae_term"] == bundled["ctcae_term"]
        assert live["meddra_code"] == bundled["meddra_code"]
        assert live["grades"] == bundled["grades"]
        assert live["definition"] == bundled["definition"]


def test_grade_text_treats_dash_as_undefined() -> None:
    assert fp._grade_text(" -") is None
    assert fp._grade_text(None) is None
    assert fp._grade_text("Mild pain") == "Mild pain"
    assert fp._clean_cell(10013963) == "10013963"
    assert fp._clean_cell(10013963.0) == "10013963"


# ---- openfda_medlist_raw.json -------------------------------------------------------------


def test_cached_medlist_raw_shape() -> None:
    doc = _load(fp.MEDLIST_RAW_FILE)
    if not doc["fetched"]:
        pytest.skip("raw cache is the offline fallback")
    assert set(fp.COUNT_QUERIES) <= set(doc["queries"])
    for key, query in doc["queries"].items():
        assert query["url"].startswith(fp.OPENFDA_LABEL_API), key
        assert query["n"] == len(query["results"]) > 100, key
        assert all({"term", "count"} <= set(r) for r in query["results"][:5])
    assert doc["candidate_generics"], "ranked candidates must be stored for traceability"
    assert doc["brands_by_generic"], "brand lookups must be cached"
    loratadine = doc["brands_by_generic"].get("loratadine")
    assert loratadine and loratadine["lookups"][0]["query_term"] == "LORATADINE"


def test_cached_candidate_ranking_matches_the_current_build_config(cfg: dict[str, Any]) -> None:
    """The stored ranking is the traceability record of what the build used; if the config
    changes how generics normalize, run ``fetch_public.py --only medlist`` (online) so the
    top-up refreshes it and fetches lookups for any newly ranked base."""
    raw = _load(fp.MEDLIST_RAW_FILE)
    if not raw["fetched"]:
        pytest.skip("raw cache is the offline fallback")
    expected = fp._candidate_rows(fp.rank_generics(raw, cfg)[: int(cfg["top_generics"])])
    assert raw["candidate_generics"] == expected, "re-run fetch_public.py --only medlist online"
    missing_lookups = [c["base"] for c in expected if c["base"] not in raw["brands_by_generic"]]
    assert not missing_lookups, f"no brand lookup cached for {missing_lookups}"


@pytest.mark.parametrize(
    ("term", "expected"),
    [
        ("DIPHENHYDRAMINE HYDROCHLORIDE", "diphenhydramine"),
        ("DIPHENHYDRAMINE HCL", "diphenhydramine"),
        ("METFORMIN HYDROCHLORIDE", "metformin"),
        ("LIDOCAINE 4%", "lidocaine"),
        ("MENTHOL, UNSPECIFIED FORM", None),  # combination marker (comma)
        ("AMOXICILLIN AND CLAVULANATE POTASSIUM", None),  # combination product
        ("ZINC OXIDE", None),  # sunscreen filter
        ("ALCOHOL", None),
        ("ETHYL ALCOHOL 70% V/V", None),
        ("AVOBENZONE, HOMOSALATE, OCTISALATE, OCTOCRYLENE", None),
        ("ARNICA MONTANA", None),  # homeopathic
        ("POTASSIUM CHLORIDE", "potassium chloride"),  # kept verbatim, not collapsed
        ("OXYBUTYNIN CHLORIDE", "oxybutynin"),
        ("DEXAMETHASONE SODIUM PHOSPHATE", "dexamethasone"),
        ("NICOTINE POLACRILEX", "nicotine"),
        ("BACITRACIN ZINC", "bacitracin"),
        ("OXYGEN", None),
        ("VITAMIN D3", None),  # 'vitamin' alone is meaningless; core list carries 'vitamin d'
        ("IBU", None),  # too short to be a drug name
        ("UREA", None),  # 4 letters: a magnet for 'area' at distance 1
        ("ZINC", None),  # a salt word on its own is not a medicine
        ("LEVOCETIRIZINE DIHYDROCHLORIDE", "levocetirizine"),
        ("PRAMIPEXOLE DIHYDROCHLORIDE", "pramipexole"),
        ("AMOXICILLIN TRIHYDRATE", "amoxicillin"),
        ("SERTRALINE HYDROCHLORIDE", "sertraline"),
        ("POTASSIUM CITRATE", None),  # would collapse to the bare cation
        ("CALCIUM ACETATE", None),
        ("SODIUM SULFATE", None),
        ("CALCIUM CARBONATE", "calcium carbonate"),  # keep_verbatim wins
        ("MAGNESIUM SULFATE HEPTAHYDRATE", None),  # strips to an excluded term
    ],
)
def test_normalize_generic(term: str, expected: str | None, cfg: dict[str, Any]) -> None:
    assert fp.normalize_generic(term, cfg) == expected


def test_rank_generics_sums_salt_variants(cfg: dict[str, Any]) -> None:
    raw = {
        "queries": {
            "generic_all": {
                "results": [
                    {"term": "DIPHENHYDRAMINE HYDROCHLORIDE", "count": 300},
                    {"term": "DIPHENHYDRAMINE HCL", "count": 250},
                    {"term": "ZINC OXIDE", "count": 9000},
                    {"term": "GABAPENTIN", "count": 400},
                ]
            },
            "generic_rx": {"results": [{"term": "GABAPENTIN", "count": 398}]},
        }
    }
    ranked = fp.rank_generics(raw, cfg)
    assert [c.base for c in ranked] == ["diphenhydramine", "gabapentin"]
    assert ranked[0].count == 550
    assert ranked[0].variants == ("DIPHENHYDRAMINE HYDROCHLORIDE", "DIPHENHYDRAMINE HCL")
    assert ranked[1].count == 400  # max across lists, not the sum


def test_edit_distance() -> None:
    assert fp.edit_distance("losortan", "losartan") == 1
    assert fp.edit_distance("claritin", "loratadine") > 2
    assert fp.edit_distance("", "abc") == 3
    assert fp.edit_distance("same", "same") == 0


@pytest.mark.parametrize(
    ("term", "expected"),
    [
        ("Claritin", "claritin"),
        ("Seroquel XR", "seroquel"),  # line-extension suffix merges into the bare brand
        ("Claritin 24HR", "claritin"),  # numeric token dropped
        ("Cleocin Phosphate", "cleocin"),  # salt suffix stripped from brands too
        ("Wal-itin", None),  # store prefix
        ("Stool Softener", None),  # descriptor, not a brand
        ("Acid Controller", None),
        ("equate ibuprofen", None),  # store brand token
        ("Kali Muriaticum", None),  # homeopathic
        ("Kali Sulphuricum", None),
        ("Glonoinum", None),
        ("IBU", None),  # too short
        ("Hand Sanitizer", None),  # excluded token
        ("Doxy", None),  # 4 letters: matched 'dose' and 'body' at distance 2
        ("BLIP", None),  # matched 'slip'
        ("APAP", None),
        ("M-PAP", None),  # 4 letters once the hyphen is ignored
        ("Hi Vetic", None),  # a 2-letter word
        ("Anusol HC", "anusol"),  # 'hc' is a form suffix, stripped
        ("Lamisil AT", "lamisil"),
        ("Imodium A-D", "imodium"),
        ("Tums Smoothies", None),  # -> 'tums', 4 letters
        ("Auvi-Q", "auvi-q"),  # 5 letters, hyphen allowed inside a token
        ("Solu-Medrol", "solu-medrol"),
        ("Bayer Aleve", None),  # manufacturer token
        ("Stay Awake", None),  # descriptor
    ],
)
def test_normalize_brand(term: str, expected: str | None, cfg: dict[str, Any]) -> None:
    assert fp.normalize_brand(term, cfg) == expected


def test_select_brands_drops_truncations_known_words_and_blocklisted_families(
    cfg: dict[str, Any],
) -> None:
    lookup = {
        "lookups": [
            {
                "results": [
                    {"term": "Doxycycline Hyclate", "count": 90},
                    {"term": "DOXY", "count": 9},  # truncation of the generic
                    {"term": "Vibramycin", "count": 4},
                    {"term": "Senna-Lax", "count": 3},  # contains an existing entry
                    {"term": "Bayer Vibra", "count": 3},  # junk token
                    {"term": "Dramamine", "count": 8},  # blocklisted family
                    {"term": "Monodox", "count": 2},
                ]
            }
        ]
    }
    known = {"doxycycline", "senna"}
    assert fp.select_brands("doxycycline", lookup, cfg, known) == ["vibramycin", "monodox"]
    # Brands chosen for the same generic also count as known for the word-part check.
    lookup2 = {
        "lookups": [
            {"results": [{"term": "Senna", "count": 26}, {"term": "Senna-Lax", "count": 3}]}
        ]
    }
    assert fp.select_brands("sennosides", lookup2, cfg, {"sennosides"}) == ["senna"]


def test_select_brands_filters_store_brands_and_generic_restatements(cfg: dict[str, Any]) -> None:
    lookup = {
        "lookups": [
            {
                "results": [
                    {"term": "Loratadine", "count": 80},
                    {"term": "Allergy Relief", "count": 19},
                    {"term": "Claritin", "count": 11},
                    {"term": "childrens loratadine", "count": 6},
                    {"term": "equate allergy", "count": 5},
                    {"term": "Loratidine", "count": 5},  # label typo within 2 edits of generic
                    {"term": "Wal-itin", "count": 4},  # store prefix
                    {"term": "Alavert", "count": 3},
                    {"term": "Claritin 24HR", "count": 4},  # merges into claritin
                    {"term": "Xyzal", "count": 1},  # below min label count
                ]
            }
        ]
    }
    assert fp.select_brands("loratadine", lookup, cfg, {"loratadine"}) == ["claritin", "alavert"]
    assert fp.select_brands("loratadine", None, cfg, set()) == []
    # A brand that is itself another generic's name is never emitted as a brand.
    assert fp.select_brands("loratadine", lookup, cfg, {"loratadine", "alavert"}) == ["claritin"]


# ---- the built medlist (CONTRACTS.md section 1.6) ---------------------------------------


@pytest.fixture(scope="module")
def built_medlist() -> dict[str, Any]:
    raw = fp.read_json(PUBLIC / fp.MEDLIST_RAW_FILE)
    cfg = fp.load_medlist_config(PUBLIC / fp.MEDLIST_CONFIG_FILE)
    return fp.build_medlist(raw, cfg, built_at="2026-10-10T00:00:00.000Z")


def test_medlist_top_level_schema(built_medlist: dict[str, Any]) -> None:
    assert built_medlist["source"].startswith("openFDA drug label API")
    assert built_medlist["rationale"] == (
        "Small bundled list for deterministic string matching. NOT RxNorm. Not a formulary."
    )
    assert built_medlist["built_at"] == "2026-10-10T00:00:00.000Z"
    assert built_medlist["is_rxnorm"] is False
    assert isinstance(built_medlist["entries"], list)


def test_medlist_contains_every_core_name_with_the_contract_mapping(
    built_medlist: dict[str, Any],
) -> None:
    by_name = {e["name"]: e for e in built_medlist["entries"]}
    missing = [n for n in CORE_NAMES if n not in by_name]
    assert not missing, f"core names missing from medlist: {missing}"
    for brand, generic in CORE_BRAND_TO_GENERIC.items():
        assert by_name[brand] == {"name": brand, "kind": "brand", "generic": generic}
    for name in CORE_NAMES:
        if name not in CORE_BRAND_TO_GENERIC:
            assert by_name[name] == {"name": name, "kind": "generic", "generic": name}


def test_medlist_entries_are_lowercase_unique_sorted_and_capped(
    built_medlist: dict[str, Any], cfg: dict[str, Any]
) -> None:
    entries = built_medlist["entries"]
    names = [e["name"] for e in entries]
    assert names == sorted(names)
    assert len(names) == len(set(names))
    assert 43 <= len(names) <= int(cfg["max_entries"])
    for entry in entries:
        assert set(entry) == {"name", "kind", "generic"}
        assert entry["name"] == entry["name"].lower()
        assert entry["generic"] == entry["generic"].lower()
        assert entry["kind"] in ("generic", "brand")
        if entry["kind"] == "generic":
            assert entry["generic"] == entry["name"]
    generics = {e["name"] for e in entries if e["kind"] == "generic"}
    for entry in entries:
        if entry["kind"] == "brand":
            assert entry["generic"] in generics, f"brand {entry['name']} maps to unknown generic"


def test_medlist_excludes_non_drug_ingredients(built_medlist: dict[str, Any]) -> None:
    names = {e["name"] for e in built_medlist["entries"]}
    for junk in (
        "zinc oxide",
        "alcohol",
        "ethyl alcohol",
        "isopropyl alcohol",
        "water",
        "menthol",
        "avobenzone",
        "octinoxate",
        "titanium dioxide",
        "oxygen",
        "sunscreen",
        "arnica montana",
        "salicylic acid",
        "hand sanitizer",
        # descriptor pseudo-brands and homeopathic names must not come in as brands either
        "acid controller",
        "stool softener",
        "laxative",
        "anti itch",
        "kali muriaticum",
    ):
        assert junk not in names, junk
    assert not any("," in n or " and " in n for n in names), "no combination products"
    brands = [e for e in built_medlist["entries"] if e["kind"] == "brand"]
    for entry in brands:
        assert fp.edit_distance(entry["name"], entry["generic"]) > 2, entry
        assert not entry["name"].endswith((" xr", " xl", " er", " hfa")), entry


def test_medlist_uses_openfda_data_when_the_cache_was_fetched(
    built_medlist: dict[str, Any],
) -> None:
    raw = _load(fp.MEDLIST_RAW_FILE)
    info = built_medlist["build_info"]
    assert info["n_core"] == _n_core()
    if raw["fetched"]:
        assert info["n_openfda_generic"] >= 100
        assert len(built_medlist["entries"]) >= 200
        names = {e["name"] for e in built_medlist["entries"]}
        # Common prescription drugs that are not in the core list but are in openFDA's top ranks.
        assert {"lidocaine", "furosemide", "cephalexin"} <= names


def test_medlist_builder_is_deterministic(built_medlist: dict[str, Any]) -> None:
    raw = fp.read_json(PUBLIC / fp.MEDLIST_RAW_FILE)
    cfg = fp.load_medlist_config(PUBLIC / fp.MEDLIST_CONFIG_FILE)
    again = fp.build_medlist(raw, cfg, built_at="2026-10-10T00:00:00.000Z")
    assert again == built_medlist


def test_medlist_keeps_every_ranked_generic(
    built_medlist: dict[str, Any], cfg: dict[str, Any]
) -> None:
    """Generics go in before brands, so the cap can never squeeze out a common drug."""
    raw = _load(fp.MEDLIST_RAW_FILE)
    if not raw["fetched"]:
        pytest.skip("raw cache is the offline fallback")
    names = {e["name"] for e in built_medlist["entries"]}
    ranked = [c.base for c in fp.rank_generics(raw, cfg)[: int(cfg["top_generics"])]]
    missing = [base for base in ranked if base not in names]
    assert not missing, f"ranked generics dropped by the cap: {missing}"
    # The reviewer's examples of common drugs that the old brand-first assembly dropped.
    assert {"warfarin", "montelukast", "tamsulosin", "valsartan", "morphine"} <= names


def test_medlist_cap_smaller_than_generics_fails_loudly(cfg: dict[str, Any]) -> None:
    raw = _load(fp.MEDLIST_RAW_FILE)
    if not raw["fetched"]:
        pytest.skip("raw cache is the offline fallback")
    tight = {**cfg, "max_entries": 100}
    with pytest.raises(fp.FetchError, match="exceed max_entries"):
        fp.build_medlist(raw, tight, built_at="x")


def test_medlist_names_are_long_enough_for_the_matcher(
    built_medlist: dict[str, Any], cfg: dict[str, Any]
) -> None:
    """The matcher tries 4+ character tokens at Levenshtein <= 2 (CONTRACTS 1.7), so a
    4-letter entry matches ordinary words.  Core entries are the contract's and exempt
    ('vitamin d' has a one-letter word)."""
    core = {str(e["name"]) for e in cfg["core_entries"]}
    for entry in built_medlist["entries"]:
        name = entry["name"]
        if name in core:
            continue
        assert fp.letter_count(name) >= int(cfg["min_name_letters"]), entry
        assert all(fp.letter_count(t) >= int(cfg["min_token_letters"]) for t in name.split()), entry
    names = {e["name"] for e in built_medlist["entries"]}
    assert not names & {"doxy", "blip", "apap", "m-pap", "hi vetic", "urea", "d-cal"}
    for entry in built_medlist["entries"]:
        if entry["kind"] == "brand":
            assert entry["name"] not in entry["generic"], f"{entry} is a truncation of its generic"


def test_medlist_excludes_multi_ingredient_brand_families(
    built_medlist: dict[str, Any], cfg: dict[str, Any]
) -> None:
    """Dramamine is dimenhydrinate or meclizine; a count-based pick with confidence 1.0 would
    be wrong for half the family, so such names are never emitted."""
    names = {e["name"] for e in built_medlist["entries"]}
    assert not names & {"dramamine", "aspercreme", "fleet", "zantac"}
    assert not names & set(cfg["brand_blocklist"])
    assert all(reason for reason in cfg["brand_blocklist"].values()), "every entry has a reason"
    assert "label counts" in built_medlist["build_info"]["brand_mapping_note"]


def test_medlist_has_no_distance_two_hits_for_the_reviewers_free_text(
    built_medlist: dict[str, Any],
) -> None:
    """'started a higher dose' proposed doxycycline and 'I slip on ice' proposed nicotine.
    No token of those sentences may sit within Levenshtein 2 of any entry."""
    names = [e["name"] for e in built_medlist["entries"]]
    for sentence in ("started a higher dose", "new body lotion", "I slip on ice", "sleep better"):
        for token in sentence.lower().split():
            if len(token) < 4:  # the matcher never tries shorter tokens
                continue
            hits = [n for n in names if fp.edit_distance(token, n) <= 2]
            assert not hits, f"{token!r} would match {hits}"


# ---- CLI behaviour -------------------------------------------------------------------


def test_offline_run_leaves_a_complete_cache_untouched(
    cache_copy: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    before = {name: (cache_copy / name).read_bytes() for name in CACHE_FILES}
    rc = fp.main(["--offline", "--public-dir", str(cache_copy)])
    assert rc == 0
    after = {name: (cache_copy / name).read_bytes() for name in CACHE_FILES}
    assert after == before, "an offline run must not rewrite cached files"
    out = capsys.readouterr().out
    assert out.count("cached") == 4


def test_offline_run_without_cache_writes_labeled_fallbacks(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    rc = fp.main(["--offline", "--public-dir", str(empty)])
    assert rc == 0
    for name in CACHE_FILES:
        doc = fp.read_json(empty / name)
        assert doc["fetched"] is False, name
        assert "fallback_note" in doc, name
    study = fp.read_json(empty / fp.STUDY_FILE)
    assert study["nct_id"] == "NCT03088540" and study["study_id"] == "R2810-ONC-1624"
    ctcae = fp.read_json(empty / fp.CTCAE_FILE)
    assert ctcae["n_terms"] == 10
    # --strict turns fallbacks into a non-zero exit so CI can insist on a fresh cache.
    assert fp.main(["--offline", "--strict", "--public-dir", str(tmp_path / "empty2")]) == 1


def test_offline_run_over_fallbacks_reports_fallback_and_strict_fails(
    fallback_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """A bundled fallback is never a cache hit: offline it is reported as such (and left
    alone), and --strict turns that into exit 1 so CI cannot pass on a fallback directory."""
    capsys.readouterr()
    before = {name: (fallback_dir / name).read_bytes() for name in CACHE_FILES}
    assert fp.main(["--offline", "--public-dir", str(fallback_dir)]) == 0
    statuses = _summary_statuses(capsys.readouterr().out)
    assert statuses == dict.fromkeys(fp.STEPS, "fallback"), statuses
    after = {name: (fallback_dir / name).read_bytes() for name in CACHE_FILES}
    assert after == before, "an existing fallback must not be rewritten (fetched_at churn)"
    assert fp.main(["--offline", "--strict", "--public-dir", str(fallback_dir)]) == 1


def test_online_run_refetches_fallback_files(
    fallback_dir: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """With network, a fallback on disk is a miss: the fetcher runs and fetched becomes true."""
    workbook = _ctcae_workbook_bytes()
    protocol = {
        "identificationModule": {
            "nctId": "NCT03088540",
            "orgStudyIdInfo": {"id": "R2810-ONC-1624"},
            "briefTitle": "Brief",
            "officialTitle": "Official",
        },
        "statusModule": {"overallStatus": "COMPLETED"},
        "sponsorCollaboratorsModule": {"leadSponsor": {"name": "Regeneron Pharmaceuticals"}},
        "designModule": {"phases": ["PHASE3"]},
        "conditionsModule": {"conditions": ["NSCLC"]},
        "armsInterventionsModule": {"interventions": []},
    }
    calls: list[str] = []

    def fake_resolve(_candidates: Any) -> tuple[dict[str, Any], str]:
        calls.append("study")
        return protocol, "direct:NCT03088540"

    def fake_get_json(url: str) -> dict[str, Any]:
        calls.append("label")
        assert "LIBTAYO" in url
        return _label_record()

    def fake_get(_url: str, **_: Any) -> tuple[bytes, str]:
        calls.append("ctcae")
        return workbook, "application/octet-stream"

    monkeypatch.setattr(fp, "resolve_study", fake_resolve)
    monkeypatch.setattr(fp, "http_get_json", fake_get_json)
    monkeypatch.setattr(fp, "http_get", fake_get)
    capsys.readouterr()
    rc = fp.main(
        ["--only", "study", "--only", "label", "--only", "ctcae", "--public-dir", str(fallback_dir)]
    )
    assert rc == 0
    assert sorted(calls) == ["ctcae", "label", "study"], "every fallback file must be refetched"
    statuses = _summary_statuses(capsys.readouterr().out)
    assert statuses == {"study": "fetched", "label": "fetched", "ctcae": "fetched"}
    for name in (fp.STUDY_FILE, fp.LABEL_FILE, fp.CTCAE_FILE):
        doc = fp.read_json(fallback_dir / name)
        assert doc["fetched"] is True and "fallback_note" not in doc, name
    # Now they are real pulls: a second run is a pure cache hit and --strict is happy
    # (the medlist file is still a fallback, so limit the steps).
    calls.clear()
    rc = fp.main(
        [
            "--offline", "--strict", "--only", "study", "--only", "label", "--only", "ctcae",
            "--public-dir", str(fallback_dir),
        ]
    )  # fmt: skip
    assert rc == 0 and calls == []


def test_online_fetch_failure_keeps_an_existing_fallback_as_fallback(
    fallback_dir: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def boom(_candidates: Any) -> tuple[dict[str, Any], str]:
        raise fp.FetchError("simulated outage")

    monkeypatch.setattr(fp, "resolve_study", boom)
    before = (fallback_dir / fp.STUDY_FILE).read_bytes()
    capsys.readouterr()
    assert fp.main(["--only", "study", "--public-dir", str(fallback_dir)]) == 0
    assert _summary_statuses(capsys.readouterr().out)["study"] == "fallback"
    assert (fallback_dir / fp.STUDY_FILE).read_bytes() == before
    assert fp.main(["--only", "study", "--strict", "--public-dir", str(fallback_dir)]) == 1


def test_corrupt_cache_file_is_replaced_not_fatal(
    cache_copy: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A truncated study.json used to abort the step with exit 1 even though a bundled copy
    exists; offline it must fall back, online it must refetch."""
    study = cache_copy / fp.STUDY_FILE
    study.write_text(study.read_text(encoding="utf-8")[:200], encoding="utf-8")
    assert fp.inspect_cache(study).kind == "corrupt"
    (cache_copy / fp.CTCAE_FILE).write_text("[]", encoding="utf-8")  # valid JSON, wrong shape
    assert fp.inspect_cache(cache_copy / fp.CTCAE_FILE).kind == "corrupt"
    capsys.readouterr()

    assert fp.main(["--offline", "--public-dir", str(cache_copy)]) == 0
    statuses = _summary_statuses(capsys.readouterr().out)
    assert statuses["study"] == "fallback" and statuses["ctcae"] == "fallback"
    assert statuses["label"] == "cached" and statuses["medlist"] == "cached"
    doc = fp.read_json(study)
    assert doc["fetched"] is False and doc["nct_id"] == "NCT03088540"

    # Online: a corrupt file is a miss and the fetcher runs.
    study.write_text("{not json", encoding="utf-8")
    called: list[str] = []

    def fake_resolve(_candidates: Any) -> tuple[dict[str, Any], str]:
        called.append("study")
        raise fp.FetchError("offline in test")

    monkeypatch.setattr(fp, "resolve_study", fake_resolve)
    assert fp.main(["--only", "study", "--public-dir", str(cache_copy)]) == 0
    assert called == ["study"]
    assert fp.read_json(study)["fetched"] is False  # fetch failed -> bundled copy written


def test_inspect_cache_classifies_every_state(tmp_path: Path) -> None:
    missing = tmp_path / "nope.json"
    assert fp.inspect_cache(missing).kind == "missing"
    fresh = tmp_path / "fresh.json"
    fresh.write_text('{"fetched": true, "fetched_at": "x"}', encoding="utf-8")
    assert fp.inspect_cache(fresh).kind == "fresh"
    fallback = tmp_path / "fb.json"
    fallback.write_text('{"fetched": false}', encoding="utf-8")
    assert fp.inspect_cache(fallback).kind == "fallback"
    unlabeled = tmp_path / "old.json"
    unlabeled.write_text('{"nct_id": "x"}', encoding="utf-8")  # no provenance -> not a hit
    assert fp.inspect_cache(unlabeled).kind == "fallback"
    bad = tmp_path / "bad.json"
    bad.write_bytes(b"\xff\xfe not utf-8 json")
    assert fp.inspect_cache(bad).kind == "corrupt"


def test_partial_pull_fails_strict_but_not_a_plain_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def partial(opts: fp.Options) -> fp.StepResult:
        return fp.StepResult(
            "medlist", opts.public_dir / fp.MEDLIST_RAW_FILE, "partial", "3 failed"
        )

    monkeypatch.setitem(fp.STEPS, "medlist", partial)
    assert fp.main(["--only", "medlist", "--public-dir", str(tmp_path)]) == 0
    assert fp.main(["--only", "medlist", "--strict", "--public-dir", str(tmp_path)]) == 1


def test_fill_brand_lookups_skips_failures_and_persists_progress(
    monkeypatch: pytest.MonkeyPatch, cfg: dict[str, Any]
) -> None:
    """One generic that keeps failing (a 429 outlasting the retries) must not discard the
    other lookups; progress is written as it is made and the failed one is left for the
    next run."""
    monkeypatch.setattr(time, "sleep", lambda _s: None)
    monkeypatch.setattr(fp, "LOOKUP_PERSIST_EVERY", 2)

    def fake_count(url: str) -> list[dict[str, Any]]:
        if "BAD" in url:
            raise fp.FetchError("HTTP 429 after retries")
        return [{"term": "SomeBrand", "count": 3}]

    monkeypatch.setattr(fp, "openfda_count", fake_count)
    candidates = [
        fp.GenericCandidate("alpha", 10, ("ALPHA",)),
        fp.GenericCandidate("bad", 9, ("BAD",)),
        fp.GenericCandidate("gamma", 8, ("GAMMA", "GAMMA HCL")),
        fp.GenericCandidate("alpha", 10, ("ALPHA",)),  # duplicate: already looked up
    ]
    raw: dict[str, Any] = {"brands_by_generic": {}}
    persisted: list[int] = []
    outcome = fp._fill_brand_lookups(
        raw, candidates, cfg, persist=lambda: persisted.append(len(raw["brands_by_generic"]))
    )
    assert (outcome.added, outcome.failed) == (2, 1)
    assert outcome.touched
    assert set(raw["brands_by_generic"]) == {"alpha", "gamma"}
    assert "bad" not in raw["brands_by_generic"], "a failed lookup is retried next run"
    assert len(raw["brands_by_generic"]["gamma"]["lookups"]) == 2
    assert persisted == [1, 2], "written after every LOOKUP_PERSIST_EVERY and after the last"
    # Second call: only the gap is attempted.
    outcome2 = fp._fill_brand_lookups(raw, candidates, cfg, persist=lambda: None)
    assert (outcome2.added, outcome2.failed) == (0, 1)
    assert not outcome2.touched


def test_http_get_waits_a_rate_limit_window_after_429(monkeypatch: pytest.MonkeyPatch) -> None:
    delays: list[float] = []
    monkeypatch.setattr(time, "sleep", lambda s: delays.append(s))

    def rate_limited(request: Any, timeout: float) -> Any:  # noqa: ARG001 (urlopen signature)
        raise HTTPError(request.full_url, 429, "Too Many Requests", {}, None)  # type: ignore[arg-type]

    monkeypatch.setattr(fp, "urlopen", rate_limited)
    with pytest.raises(fp.FetchError, match="429"):
        fp.http_get("https://api.fda.gov/drug/label.json?count=x")
    assert len(delays) == fp.HTTP_RETRIES - 1
    assert all(d >= fp.RATE_LIMIT_PAUSE_S for d in delays)


def test_build_medlist_cli_writes_to_out_path(cache_copy: Path, tmp_path: Path) -> None:
    out = tmp_path / "scratch" / "medlist.json"
    rc = fp.main(
        ["--offline", "--public-dir", str(cache_copy), "--build-medlist", "--out", str(out)]
    )
    assert rc == 0
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert doc["is_rxnorm"] is False
    assert {"name", "kind", "generic"} == set(doc["entries"][0])
    assert any(e["name"] == "claritin" and e["generic"] == "loratadine" for e in doc["entries"])


def test_build_medlist_with_fallback_raw_yields_core_only(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    out = tmp_path / "medlist.json"
    rc = fp.main(["--offline", "--public-dir", str(empty), "--build-medlist", "--out", str(out)])
    assert rc == 0
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert len(doc["entries"]) == _n_core()
    assert doc["build_info"]["openfda_raw_fetched"] is False


def test_offline_and_force_are_mutually_exclusive() -> None:
    with pytest.raises(SystemExit):
        fp.main(["--offline", "--force"])


def test_only_restricts_the_steps(cache_copy: Path, capsys: pytest.CaptureFixture[str]) -> None:
    rc = fp.main(["--offline", "--public-dir", str(cache_copy), "--only", "ctcae"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "ctcae" in out and "study" not in out
