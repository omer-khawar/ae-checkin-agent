#!/usr/bin/env python3
"""Import a Synthea run into Interim's committed, de-identified chart-scan fixtures.

Reads Synthea FHIR R4 patient bundles (plus Synthea's ``csv/medications.csv`` when the run
exported it) and writes three files under ``data/synthetic/synthea/``:

* ``participants.json``: one record per Synthea patient, relabelled ``P-001`` ... in a
  deterministic order (birthDate, then Synthea id), with the NSCLC diagnosis and stage,
  clinically relevant comorbidities, active medications (each run through Interim's con-med
  matcher), cancer therapy administrations, the last 12 months of encounters and baseline
  vitals. All values are "Synthea synthetic EHR (simulated)".
* ``notes.json``: up to 6 recent clinical notes per participant (always including any
  emergency-encounter note), de-identified, each with a ground-truth block built from the
  STRUCTURED FHIR record (medications active on the note date, medications prescribed and
  conditions diagnosed at that encounter, encounter class), so the chart scanner can be
  scored against something it did not produce. The note's own "# Chief Complaint" and
  "# Medications" sections are parsed as a documented fallback/complement.
* ``manifest.json``: sha256 and size of every output and input table, the generator
  config excerpt (jar sha256, seeds, flags), per-bundle input hashes, and summary stats.

De-identification (also in data/synthetic/synthea/README.md): no names, addresses,
phone numbers, SSNs, MRNs, driver's licence/passport numbers or Synthea UUIDs are written.
The patient's name tokens in note text become the participant label; any other
Synthea-style name token (``Word123``) becomes ``[name]``; ``synthea_ref`` is the first
12 hex characters of sha256(Synthea UUID), never the UUID. Exact birth dates are reduced
to an age at the reference date.

Determinism: the output is a pure function of the input bundles, the two tables in
``data/synthetic/synthea/``, ``scripts/synthea/synthea_config.json`` and
``packages/rules/data/medlist.json`` (the con-med matcher's list). No wall-clock time is
written. ``--check`` re-imports into a temporary directory and requires byte-identical
output, so it also catches drift in the importer and in the matcher's medication list. When
the raw Synthea output is not on disk (it is not committed), ``--check`` verifies only the
manifest: the committed files' hashes and that ``medlist.json`` still has the sha256 the
import ran against. It says loudly that importer drift is then NOT verified; ``--strict``
makes that case fail.

No network, no LLM: JSON parsing, regexes and table lookups only.

Usage (from the repo root)::

    .venv/Scripts/python.exe scripts/synthea/import_synthea.py --in <out dir> [--in <top-up dir>]
    .venv/Scripts/python.exe scripts/synthea/import_synthea.py --check [--strict]
    # or point it at the raw output via the environment (os.pathsep-separated):
    INTERIM_SYNTHEA_OUT='<out>;<top-up>' python scripts/synthea/import_synthea.py --check
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import os
import re
import statistics
import sys
import tempfile
from collections import Counter, defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any

IMPORTER_VERSION = "1.0.0"

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_OUTDIR = REPO_ROOT / "data" / "synthetic" / "synthea"
DEFAULT_CONFIG = SCRIPT_DIR / "synthea_config.json"
MEDLIST_PATH = REPO_ROOT / "packages" / "rules" / "data" / "medlist.json"

# The raw Synthea output (~66 MB of FHIR) is not committed and has no default location: pass
# it with --in, or set INTERIM_SYNTHEA_OUT to an os.pathsep-separated list of run dirs (the
# primary run first, then any top-up run). Without either, --check can only verify hashes.
IN_DIRS_ENV = "INTERIM_SYNTHEA_OUT"

OUTPUT_FILES = ("participants.json", "notes.json", "manifest.json")
TABLE_FILES = ("condition_filter.json", "import_tables.json")

# Bundles Synthea writes next to the patient bundles that are not patients.
_NON_PATIENT_PREFIXES = ("hospitalInformation", "practitionerInformation")

# A Synthea-generated personal name token: capitalised word with a numeric suffix
# ("Jane123", "D'Amore12"). Lower-case tokens such as "b12" or "phq-2" do not match.
SYNTHEA_NAME_TOKEN = re.compile(r"\b[A-Z][A-Za-z'\-]*[a-z]\d{1,4}\b")
_SEMANTIC_TAG = re.compile(r"\(([^()]+)\)\s*$")
_SECTION_HEADING = re.compile(r"^# (.+?)\s*$", re.MULTILINE)
_LEADING_DATE = re.compile(r"^\s*(\d{4}-\d{2}-\d{2})\s*$", re.MULTILINE)

JsonObj = dict[str, Any]

try:  # The rules package is installed (editable) in the repo venv; fall back to the source tree.
    from interim_rules.conmed import match_conmed
except ImportError:  # pragma: no cover - exercised only outside the venv
    sys.path.insert(0, str(REPO_ROOT / "packages" / "rules"))
    from interim_rules.conmed import match_conmed


# --------------------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------------------


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def dump_json(obj: Any) -> bytes:
    """Canonical output encoding: UTF-8, 2-space indent, LF line endings, trailing newline."""
    return (json.dumps(obj, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def to_date(value: str) -> date:
    """FHIR dateTime / CSV timestamp -> calendar date (the UTC date Synthea printed)."""
    return date.fromisoformat(value[:10])


def ref_id(reference: str) -> str:
    """'urn:uuid:<id>' or 'Type/<id>' -> '<id>'."""
    return reference.rsplit(":", 1)[-1].rsplit("/", 1)[-1]


def first_coding(concept: JsonObj | None) -> JsonObj:
    if not concept:
        return {}
    codings = concept.get("coding") or []
    return dict(codings[0]) if codings else {}


def semantic_tag(display: str) -> str | None:
    match = _SEMANTIC_TAG.search(display)
    return match.group(1).strip().lower() if match else None


def synthea_ref(uuid: str) -> str:
    """Stable, non-reversible handle: sha256 of the Synthea UUID, first 12 hex characters."""
    return sha256_bytes(uuid.encode("utf-8"))[:12]


def age_on(birth: date, on: date) -> int:
    return on.year - birth.year - ((on.month, on.day) < (birth.month, birth.day))


def round1(value: float) -> float:
    return round(float(value), 1)


# --------------------------------------------------------------------------------------
# Tables
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Tables:
    """The importer's data tables (data/synthetic/synthea/*.json), compiled once."""

    imports: JsonObj
    conditions: JsonObj
    nsclc_stage: dict[str, str | None]
    exclude_tags: frozenset[str]
    allow_codes: frozenset[str]
    exclude_codes: frozenset[str]
    cancer_reason: re.Pattern[str]
    leading_quantity: re.Pattern[str]
    brand: re.Pattern[str]
    salt_words: frozenset[str]
    formulation_words: frozenset[str]

    @property
    def label(self) -> str:
        return str(self.imports["label"])


def load_tables(table_dir: Path = DEFAULT_OUTDIR) -> Tables:
    imports = read_json(table_dir / "import_tables.json")
    conditions = read_json(table_dir / "condition_filter.json")
    ingredient = imports["ingredient"]
    return Tables(
        imports=imports,
        conditions=conditions,
        nsclc_stage=dict(imports["nsclc"]["codes"]),
        exclude_tags=frozenset(t.lower() for t in conditions["exclude_semantic_tags"]),
        allow_codes=frozenset(str(e["code"]) for e in conditions["allow_snomed"]),
        exclude_codes=frozenset(str(e["code"]) for e in conditions["exclude_snomed"]),
        cancer_reason=re.compile(imports["cancer_therapy"]["reason_regex"]),
        leading_quantity=re.compile(ingredient["leading_quantity_regex"]),
        brand=re.compile(ingredient["brand_regex"]),
        salt_words=frozenset(ingredient["salt_words"]),
        formulation_words=frozenset(ingredient["formulation_words"]),
    )


def is_clinical_condition(code: str, display: str, tables: Tables) -> bool:
    """condition_filter.json: allow-list beats the tag rule; the exclude list beats both."""
    if code in tables.exclude_codes:
        return False
    if code in tables.allow_codes:
        return True
    tag = semantic_tag(display)
    return tag is None or tag not in tables.exclude_tags


# --------------------------------------------------------------------------------------
# Ingredient heuristic
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Ingredients:
    leading: str
    all: tuple[str, ...]
    brand: str | None

    @property
    def is_combination(self) -> bool:
        return len(self.all) > 1


def _strip_trailing_words(words: list[str], tables: Tables) -> list[str]:
    """Drop trailing salt/formulation words, unless the name starts with a salt word."""
    if not words or words[0] in tables.salt_words:
        return words
    droppable = tables.salt_words | tables.formulation_words
    while len(words) > 1 and words[-1] in droppable:
        words = words[:-1]
    return words


def _ingredient_of_part(part: str, tables: Tables) -> str:
    text = tables.leading_quantity.sub("", part.strip())
    words: list[str] = []
    for word in text.split():
        if word[:1].isdigit():
            break  # the strength starts here
        words.append(word)
    name = " ".join(words).split(",", 1)[0].strip().lower()
    return " ".join(_strip_trailing_words(name.split(), tables))


def parse_ingredients(display: str, tables: Tables) -> Ingredients:
    """Leading ingredient of an RxNorm clinical-drug display (import_tables.json 'ingredient').

    Example: "24 HR metoprolol succinate 100 MG Extended Release Oral Tablet" gives
    leading "metoprolol"; "Acetaminophen 325 MG / Oxycodone Hydrochloride 5 MG Oral Tablet"
    gives leading "acetaminophen" with all = ("acetaminophen", "oxycodone").
    """
    text = display.strip()
    brand_match = tables.brand.search(text)
    brand = brand_match.group(1).strip() if brand_match else None
    if brand_match:
        text = text[: brand_match.start()]
    separator = str(tables.imports["ingredient"]["combination_separator"])
    parts = [p for p in text.split(separator) if p.strip()] or [text]
    names: list[str] = []
    for part in parts:
        name = _ingredient_of_part(part, tables)
        if name and name not in names:
            names.append(name)
    if not names:
        names = [text.lower()]
    return Ingredients(leading=names[0], all=tuple(names), brand=brand)


def _normalized_generic(name: str, tables: Tables) -> str:
    return " ".join(_strip_trailing_words(name.lower().split(), tables))


def interim_match(display: str, ingredients: Ingredients, tables: Tables) -> JsonObj:
    """Run Interim's deterministic con-med matcher on the full display and score it.

    ``agrees_with_ingredient`` is true when the matcher's generic name (salt words removed)
    equals one of the display's parsed ingredients. That is the "normalized correctly"
    statistic in manifest.json; it measures the matcher on Synthea's RxNorm strings, which
    are much longer than what a participant types at the kiosk.
    """
    match = match_conmed(display)
    matched = match.matched_name
    agrees: bool | None = None
    if matched is not None:
        agrees = _normalized_generic(matched, tables) in ingredients.all or matched.lower() in (
            ingredients.all
        )
    return {
        "matched_name": matched,
        "match_kind": match.match_kind,
        "confidence": match.confidence,
        "agrees_with_ingredient": agrees,
    }


# --------------------------------------------------------------------------------------
# Input discovery
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class RunInfo:
    """One Synthea output directory (fhir/, notes/, optional csv/, metadata/)."""

    path: Path
    seed: int | None
    synthea_version: str | None
    patient_count: int | None
    run_time_s: int | None
    has_csv: bool


def read_run_info(run_dir: Path) -> RunInfo:
    meta: JsonObj = {}
    meta_files = sorted((run_dir / "metadata").glob("*.json"))
    if meta_files:
        meta = read_json(meta_files[0])
    version = meta.get("version")
    return RunInfo(
        path=run_dir,
        seed=int(meta["seed"]) if "seed" in meta else None,
        synthea_version=str(version).strip() if version else None,
        patient_count=int(meta["patientCount"]) if "patientCount" in meta else None,
        run_time_s=int(meta["runTimeInSeconds"]) if "runTimeInSeconds" in meta else None,
        has_csv=(run_dir / "csv" / "medications.csv").is_file(),
    )


def patient_bundle_paths(run_dir: Path) -> list[Path]:
    fhir = run_dir / "fhir"
    return sorted(p for p in fhir.glob("*.json") if not p.name.startswith(_NON_PATIENT_PREFIXES))


@dataclass
class Source:
    """One patient's bundle plus everything derived from its run directory."""

    run: RunInfo
    bundle_sha256: str
    bundle_bytes: int
    by_url: dict[str, JsonObj]
    by_type: dict[str, list[JsonObj]]
    patient: JsonObj
    csv_stops: dict[tuple[str, str, str], date | None] | None = None
    label: str = ""

    @property
    def uuid(self) -> str:
        return str(self.patient["id"])

    @property
    def birth(self) -> date:
        return date.fromisoformat(str(self.patient["birthDate"]))

    def of(self, resource_type: str) -> list[JsonObj]:
        return self.by_type.get(resource_type, [])


def load_source(path: Path, run: RunInfo) -> Source:
    raw = path.read_bytes()
    bundle = json.loads(raw.decode("utf-8"))
    by_url: dict[str, JsonObj] = {}
    by_type: dict[str, list[JsonObj]] = defaultdict(list)
    for entry in bundle.get("entry", []):
        resource = entry["resource"]
        by_url[str(entry.get("fullUrl", ""))] = resource
        by_url[f"urn:uuid:{resource.get('id')}"] = resource
        by_type[str(resource["resourceType"])].append(resource)
    patients = by_type.get("Patient", [])
    if len(patients) != 1:
        raise ValueError(f"{path.name}: expected one Patient, found {len(patients)}")
    return Source(
        run=run,
        bundle_sha256=sha256_bytes(raw),
        bundle_bytes=len(raw),
        by_url=by_url,
        by_type=dict(by_type),
        patient=patients[0],
    )


def load_csv_stops(run_dir: Path) -> dict[str, dict[tuple[str, str, str], date | None]]:
    """medications.csv -> {patient uuid: {(encounter, rxnorm, start second): stop date}}."""
    path = run_dir / "csv" / "medications.csv"
    out: dict[str, dict[tuple[str, str, str], date | None]] = defaultdict(dict)
    if not path.is_file():
        return {}
    with path.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            key = (row["ENCOUNTER"], row["CODE"], row["START"][:19])
            out[row["PATIENT"]][key] = to_date(row["STOP"]) if row["STOP"] else None
    return dict(out)


# --------------------------------------------------------------------------------------
# Medications
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class MedInterval:
    rxnorm: str
    display: str
    start: date
    stop: date | None  # None = still active at the end of the simulation
    category: str
    encounter_id: str
    authored: str  # full authoredOn, for ordering


def med_identity(resource: JsonObj, by_url: dict[str, JsonObj]) -> tuple[str, str]:
    """(display, rxnorm) from medicationCodeableConcept or the referenced Medication."""
    concept = resource.get("medicationCodeableConcept")
    if concept is None and "medicationReference" in resource:
        medication = by_url.get(str(resource["medicationReference"]["reference"]), {})
        concept = medication.get("code")
    coding = first_coding(concept)
    return str(coding.get("display", "")), str(coding.get("code", ""))


MedRow = tuple[str, str, str, str, str, str]  # rxnorm, display, authoredOn, status, category, enc


def medication_rows(src: Source) -> list[MedRow]:
    """Every MedicationRequest as a row, sorted by (rxnorm, authoredOn, encounter)."""
    raw: list[MedRow] = []
    for mr in src.of("MedicationRequest"):
        display, rxnorm = med_identity(mr, src.by_url)
        authored = str(mr.get("authoredOn", ""))
        if not rxnorm or not authored:
            continue
        category = first_coding((mr.get("category") or [{}])[0]).get("code", "")
        encounter = ref_id(str(mr.get("encounter", {}).get("reference", "")))
        raw.append((rxnorm, display, authored, str(mr.get("status")), str(category), encounter))
    return sorted(raw, key=lambda r: (r[0], r[2], r[5]))


def medication_intervals(src: Source, raw: Sequence[MedRow]) -> tuple[list[MedInterval], str]:
    """Every MedicationRequest as an [start, stop] date interval, and how stops were found.

    FHIR R4 MedicationRequests from Synthea carry no end date. When the run exported CSV,
    Synthea's own STOP column (same simulation, structured) is used: ``synthea_csv``.
    Otherwise ``fhir_status_heuristic``: status 'active' -> open-ended; a completed
    community prescription lasts until the next prescription of the same RxNorm code
    (Synthea renews chronic meds yearly) or, with no renewal, only its own day; completed
    inpatient/outpatient orders last their own day.
    """
    if src.csv_stops is not None:
        intervals = []
        for rxnorm, display, authored, status, category, encounter in raw:
            key = (encounter, rxnorm, authored[:19])
            if key in src.csv_stops:
                stop = src.csv_stops[key]
            else:  # not in the CSV (should not happen): fall back to the status
                stop = None if status == "active" else to_date(authored)
            intervals.append(
                MedInterval(rxnorm, display, to_date(authored), stop, category, encounter, authored)
            )
        return intervals, "synthea_csv"
    return fhir_heuristic_intervals(raw), "fhir_status_heuristic"


def fhir_heuristic_intervals(raw: Sequence[MedRow]) -> list[MedInterval]:
    """See medication_intervals. ``raw`` is sorted by (rxnorm, authoredOn)."""
    intervals: list[MedInterval] = []
    for i, (rxnorm, display, authored, status, category, encounter) in enumerate(raw):
        start = to_date(authored)
        stop: date | None
        if status == "active":
            stop = None
        elif category == "community":
            nxt = raw[i + 1] if i + 1 < len(raw) and raw[i + 1][0] == rxnorm else None
            stop = to_date(nxt[2]) if nxt else start
        else:
            stop = start
        intervals.append(MedInterval(rxnorm, display, start, stop, category, encounter, authored))
    return intervals


def active_on(intervals: Iterable[MedInterval], day: date) -> dict[str, MedInterval]:
    """Intervals covering ``day`` (inclusive, date granularity), one per RxNorm code."""
    out: dict[str, MedInterval] = {}
    for iv in intervals:
        if iv.start <= day and (iv.stop is None or iv.stop >= day):
            prev = out.get(iv.rxnorm)
            if prev is None or iv.authored > prev.authored:
                out[iv.rxnorm] = iv
    return out


def chain_start(intervals: Sequence[MedInterval], current: MedInterval) -> date:
    """Earliest start of the run of back-to-back prescriptions of the same code ending in
    ``current`` (so a yearly-renewed statin reports when it was first started)."""
    same = sorted((iv for iv in intervals if iv.rxnorm == current.rxnorm), key=lambda iv: iv.start)
    start = current.start
    changed = True
    while changed:
        changed = False
        for iv in same:
            if iv.start < start and (iv.stop is None or iv.stop >= start):
                start = iv.start
                changed = True
    return start


def med_item(display: str, rxnorm: str | None, tables: Tables) -> JsonObj:
    ingredients = parse_ingredients(display, tables)
    item: JsonObj = {"display": display, "rxnorm": rxnorm, "ingredient": ingredients.leading}
    if ingredients.is_combination:
        item["ingredients"] = list(ingredients.all)
    if ingredients.brand:
        item["brand"] = ingredients.brand
    return item


# --------------------------------------------------------------------------------------
# Notes: sections and de-identification
# --------------------------------------------------------------------------------------


def note_sections(text: str) -> dict[str, str]:
    """Level-1 '# Heading' sections of a Synthea note ('## Plan' stays inside its parent)."""
    sections: dict[str, str] = {}
    matches = list(_SECTION_HEADING.finditer(text))
    for i, match in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        sections[match.group(1).strip().lower()] = text[match.end() : end].strip()
    return sections


def chief_complaints(sections: dict[str, str]) -> list[str]:
    body = sections.get("chief complaint", "")
    return [line[2:].strip() for line in body.splitlines() if line.startswith("- ")]


def note_medication_list(sections: dict[str, str]) -> list[str]:
    body = " ".join(sections.get("medications", "").split())
    if not body or body.lower().startswith("no active medications"):
        return []
    return [m.strip() for m in body.split(";") if m.strip()]


@dataclass(frozen=True)
class Redactor:
    """Replaces one patient's identifiers in free text (see module docstring)."""

    label: str
    name_tokens: tuple[str, ...]
    other_tokens: tuple[str, ...]

    @classmethod
    def for_patient(cls, patient: JsonObj, label: str) -> Redactor:
        names: set[str] = set()
        for name in patient.get("name", []):
            for token in [*name.get("given", []), name.get("family", "")]:
                for part in str(token).split():
                    names.add(part)
                    stripped = re.sub(r"\d+$", "", part)
                    if len(stripped) >= 3:
                        names.add(stripped)
        others: set[str] = set()
        for address in patient.get("address", []):
            others.update(str(line) for line in address.get("line", []))
            others.update(str(address[k]) for k in ("city", "postalCode") if address.get(k))
        others.update(str(t["value"]) for t in patient.get("telecom", []) if t.get("value"))
        others.update(str(i["value"]) for i in patient.get("identifier", []) if i.get("value"))
        others.add(str(patient.get("id", "")))
        others.discard("")
        # Longest first so 'Jane123' is replaced before 'Jane'.
        return cls(
            label=label,
            name_tokens=tuple(sorted(names, key=lambda s: (-len(s), s))),
            other_tokens=tuple(sorted(others, key=lambda s: (-len(s), s))),
        )

    def __call__(self, text: str) -> str:
        for token in self.other_tokens:
            text = text.replace(token, "[redacted]")
        for token in self.name_tokens:
            text = re.sub(rf"\b{re.escape(token)}\b", self.label, text)
        text = SYNTHEA_NAME_TOKEN.sub("[name]", text)
        # Honorific + label, and runs of the label from multi-token names, collapse to one label.
        text = re.sub(rf"\b(?:Mr|Mrs|Ms|Dr)\.\s+(?={re.escape(self.label)})", "", text)
        label = re.escape(self.label)
        return re.sub(rf"{label}(?:\s+{label})+", self.label, text)


# --------------------------------------------------------------------------------------
# Building one participant and their notes
# --------------------------------------------------------------------------------------


@dataclass
class Built:
    participant: JsonObj
    notes: list[JsonObj]
    stats: JsonObj = field(default_factory=dict)


def _condition_rows(src: Source) -> list[tuple[str, str, str, date | None, str]]:
    """(code, display, clinical status, onset, encounter id) for every Condition."""
    rows = []
    for cond in src.of("Condition"):
        coding = first_coding(cond.get("code"))
        status = first_coding(cond.get("clinicalStatus")).get("code", "")
        onset = cond.get("onsetDateTime")
        encounter = ref_id(str(cond.get("encounter", {}).get("reference", "")))
        rows.append(
            (
                str(coding.get("code", "")),
                str(coding.get("display", "")),
                str(status),
                to_date(onset) if onset else None,
                encounter,
            )
        )
    return rows


def _nsclc(src: Source, tables: Tables, reference: date) -> JsonObj | None:
    hits = [
        (code, display, onset)
        for code, display, status, onset, _ in _condition_rows(src)
        if code in tables.nsclc_stage
        and status == "active"
        and (onset is None or onset <= reference)
    ]
    if not hits:
        return None
    stages = sorted({s for c, _, _ in hits if (s := tables.nsclc_stage[c]) is not None})
    onsets = [o for _, _, o in hits if o is not None]
    return {
        "diagnosis_date": min(onsets).isoformat() if onsets else None,
        "stage": stages[-1] if stages else None,
        "snomed": sorted({c for c, _, _ in hits}),
        "displays": sorted({d for _, d, _ in hits}),
    }


def _comorbidities(src: Source, tables: Tables, reference: date) -> tuple[list[JsonObj], int]:
    kept: dict[str, JsonObj] = {}
    dropped: set[str] = set()
    for code, display, status, onset, _ in _condition_rows(src):
        if status != "active" or code in tables.nsclc_stage:
            continue
        if onset is not None and onset > reference:
            continue
        if not is_clinical_condition(code, display, tables):
            dropped.add(code)
            continue
        prev = kept.get(code)
        onset_s = onset.isoformat() if onset else None
        if prev is None or (onset_s and (prev["onset"] is None or onset_s < prev["onset"])):
            kept[code] = {"display": display, "snomed": code, "onset": onset_s}
    items = sorted(kept.values(), key=lambda c: (c["onset"] or "", c["display"]))
    return items, len(dropped)


def _allergies(src: Source) -> list[JsonObj]:
    out = []
    for allergy in src.of("AllergyIntolerance"):
        status = first_coding(allergy.get("clinicalStatus")).get("code", "active")
        if status != "active":
            continue
        coding = first_coding(allergy.get("code"))
        out.append(
            {
                "display": coding.get("display"),
                "code": coding.get("code"),
                "category": (allergy.get("category") or [None])[0],
            }
        )
    return sorted(out, key=lambda a: (str(a["display"]), str(a["code"])))


def _cancer_therapy(src: Source, tables: Tables, reference: date) -> list[JsonObj]:
    groups: dict[str, JsonObj] = {}
    for admin in src.of("MedicationAdministration"):
        reasons = [str(r.get("display", "")) for r in admin.get("reasonReference", [])]
        if not any(tables.cancer_reason.search(r) for r in reasons):
            continue
        when = admin.get("effectiveDateTime") or admin.get("effectivePeriod", {}).get("start")
        if not when or to_date(str(when)) > reference:
            continue
        display, rxnorm = med_identity(admin, src.by_url)
        day = to_date(str(when)).isoformat()
        group = groups.setdefault(
            rxnorm,
            {
                "display": display,
                "rxnorm": rxnorm,
                "ingredient": parse_ingredients(display, tables).leading,
                "indications": set(),
                "first_date": day,
                "last_date": day,
                "n_administrations": 0,
            },
        )
        group["indications"].update(reasons)
        group["first_date"] = min(group["first_date"], day)
        group["last_date"] = max(group["last_date"], day)
        group["n_administrations"] += 1
    out = []
    for group in groups.values():
        group["indications"] = sorted(group["indications"])
        out.append(group)
    return sorted(out, key=lambda g: (g["first_date"], g["display"]))


def _encounters(src: Source, tables: Tables) -> list[JsonObj]:
    """Every encounter, sorted, as plain dicts (internal; filtered by the callers)."""
    classes = tables.imports["encounter_class"]
    out = []
    for enc in src.of("Encounter"):
        start = str(enc.get("period", {}).get("start", ""))
        if not start:
            continue
        class_code = str(enc.get("class", {}).get("code", ""))
        out.append(
            {
                "id": str(enc["id"]),
                "start": start,
                "date": to_date(start).isoformat(),
                "type": first_coding((enc.get("type") or [{}])[0]).get("display"),
                "class": classes.get(class_code, class_code.lower() or None),
                "reason": first_coding((enc.get("reasonCode") or [{}])[0]).get("display"),
            }
        )
    return sorted(out, key=lambda e: (e["start"], e["id"]))


def _observations(src: Source, loinc: Sequence[str], reference: date) -> list[tuple[str, float]]:
    """(effectiveDateTime, value) of quantity observations with one of the codes, sorted."""
    codes = set(loinc)
    rows = []
    for obs in src.of("Observation"):
        code = first_coding(obs.get("code")).get("code")
        when = obs.get("effectiveDateTime")
        value = obs.get("valueQuantity", {}).get("value")
        if code in codes and when and value is not None and to_date(str(when)) <= reference:
            rows.append((str(when), float(value)))
    return sorted(rows)


def _panel_components(
    src: Source, panel: str, component: str, reference: date
) -> list[tuple[str, float]]:
    rows = []
    for obs in src.of("Observation"):
        if first_coding(obs.get("code")).get("code") != panel:
            continue
        when = obs.get("effectiveDateTime")
        if not when or to_date(str(when)) > reference:
            continue
        for comp in obs.get("component", []):
            value = comp.get("valueQuantity", {}).get("value")
            if first_coding(comp.get("code")).get("code") == component and value is not None:
                rows.append((str(when), float(value)))
    return sorted(rows)


def _baseline_vitals(src: Source, tables: Tables, reference: date) -> JsonObj:
    spec = tables.imports["vitals"]
    last_n = int(tables.imports["windows"]["baseline_vitals_last_n"])
    out: JsonObj = {}
    for key in ("pulse_bpm", "breathing_bpm", "systolic_bp", "diastolic_bp", "temp_c", "spo2"):
        entry = spec[key]
        if "panel" in entry:
            rows = _panel_components(src, entry["panel"], entry["component"], reference)
        else:
            rows = _observations(src, entry["loinc"], reference)
        recent = rows[-last_n:]
        if not recent:
            out[key] = None
            continue
        out[key] = {
            "values": [{"date": to_date(w).isoformat(), "value": round1(v)} for w, v in recent],
            "median": round1(statistics.median(v for _, v in recent)),
            "unit": entry["unit"],
        }
    out["label"] = tables.label
    out["is_measured"] = False
    return out


def _smoking(src: Source, tables: Tables, reference: date, notes_text: Sequence[str]) -> JsonObj:
    spec = tables.imports["smoking"]
    latest: tuple[str, JsonObj] | None = None
    for obs in src.of("Observation"):
        if first_coding(obs.get("code")).get("code") != spec["loinc"]:
            continue
        when = str(obs.get("effectiveDateTime", ""))
        if when and to_date(when) <= reference and (latest is None or when > latest[0]):
            latest = (when, first_coding(obs.get("valueCodeableConcept")))
    if latest is not None:
        when, coding = latest
        return {
            "status": spec["snomed_status"].get(str(coding.get("code")), "unknown"),
            "display": coding.get("display"),
            "snomed": coding.get("code"),
            "date": to_date(when).isoformat(),
            "source": f"fhir_observation_{spec['loinc']}",
        }
    for text in notes_text:  # newest first
        social = note_sections(text).get("social history", "")
        for pattern in spec["note_patterns"]:
            if re.search(pattern["regex"], social, re.IGNORECASE):
                return {
                    "status": pattern["status"],
                    "display": None,
                    "snomed": None,
                    "date": None,
                    "source": "note_social_history",
                }
    return {"status": "unknown", "display": None, "snomed": None, "date": None, "source": None}


@dataclass(frozen=True)
class RawNote:
    encounter: JsonObj
    note_date: date
    text: str


def _raw_notes(src: Source, encounters: dict[str, JsonObj]) -> list[RawNote]:
    notes = []
    for doc in src.of("DocumentReference"):
        contexts = doc.get("context", {}).get("encounter", [])
        enc_id = ref_id(str(contexts[0]["reference"])) if contexts else ""
        encounter = encounters.get(enc_id)
        contents = doc.get("content", [])
        if encounter is None or not contents:
            continue
        data = contents[0].get("attachment", {}).get("data")
        if not data:
            continue
        text = base64.b64decode(data).decode("utf-8")
        leading = _LEADING_DATE.search(text)
        note_day = date.fromisoformat(leading.group(1)) if leading else to_date(encounter["start"])
        notes.append(RawNote(encounter, note_day, text))
    return sorted(notes, key=lambda n: (n.note_date, n.encounter["start"], n.encounter["id"]))


def select_notes(notes: Sequence[RawNote], reference: date, tables: Tables) -> list[RawNote]:
    """Recent notes: every emergency note, then the newest note of each distinct
    (class, type, reason) so the sample is varied, then the newest of the rest.
    Returned in chronological order."""
    windows = tables.imports["windows"]
    since = reference - timedelta(days=int(windows["lookback_days"]))
    cap = int(windows["max_notes_per_participant"])
    recent = [n for n in notes if since < n.note_date <= reference]
    newest_first = sorted(
        recent, key=lambda n: (n.note_date, n.encounter["start"], n.encounter["id"]), reverse=True
    )
    chosen: list[RawNote] = [n for n in newest_first if n.encounter["class"] == "emergency"]
    seen_groups = {
        (n.encounter["class"], n.encounter["type"], n.encounter["reason"]) for n in chosen
    }
    for note in newest_first:
        group = (note.encounter["class"], note.encounter["type"], note.encounter["reason"])
        if len(chosen) < cap and note not in chosen and group not in seen_groups:
            chosen.append(note)
            seen_groups.add(group)
    for note in newest_first:
        if len(chosen) < cap and note not in chosen:
            chosen.append(note)
    return sorted(chosen, key=lambda n: (n.note_date, n.encounter["start"], n.encounter["id"]))


def build_participant(src: Source, tables: Tables, reference: date) -> Built:
    label = src.label
    redact = Redactor.for_patient(src.patient, label)
    encounter_list = _encounters(src, tables)
    encounters = {e["id"]: e for e in encounter_list}
    since = reference - timedelta(days=int(tables.imports["windows"]["lookback_days"]))

    rows = medication_rows(src)
    intervals, interval_source = medication_intervals(src, rows)
    all_meds = {(iv.rxnorm): iv.display for iv in intervals}
    for admin in src.of("MedicationAdministration"):
        display, rxnorm = med_identity(admin, src.by_url)
        all_meds.setdefault(rxnorm, display)
    rxnorm_by_lower = {display.lower(): rxnorm for rxnorm, display in sorted(all_meds.items())}

    # ---- active medications at the reference date
    active_meds = []
    for rxnorm, iv in sorted(active_on(intervals, reference).items(), key=lambda kv: kv[1].display):
        item = med_item(iv.display, rxnorm, tables)
        item["started"] = chain_start(intervals, iv).isoformat()
        item["category"] = iv.category
        item["interim_match"] = interim_match(
            iv.display, parse_ingredients(iv.display, tables), tables
        )
        active_meds.append(item)

    # ---- notes
    raw_notes = _raw_notes(src, encounters)
    selected = select_notes(raw_notes, reference, tables)
    conditions = _condition_rows(src)
    mr_by_encounter: dict[str, list[MedInterval]] = defaultdict(list)
    for iv in intervals:
        mr_by_encounter[iv.encounter_id].append(iv)
    # Validation only: how often would the FHIR-only heuristic have given the same answer?
    heuristic = fhir_heuristic_intervals(rows) if interval_source == "synthea_csv" else None

    notes: list[JsonObj] = []
    agreement = Counter[str]()
    id_counts: Counter[str] = Counter()
    for raw in selected:
        enc = raw.encounter
        sections = note_sections(raw.text)
        structured = active_on(intervals, raw.note_date)
        if heuristic is not None:
            same = set(active_on(heuristic, raw.note_date)) == set(structured)
            agreement["agree" if same else "disagree"] += 1
        meds: dict[str, JsonObj] = {}
        for rxnorm, iv in structured.items():
            item = med_item(iv.display, rxnorm, tables)
            item["sources"] = ["structured"]
            meds[rxnorm] = item
        for listed in note_medication_list(sections):
            rx = rxnorm_by_lower.get(listed.lower())
            if rx is not None and rx in meds:
                meds[rx]["sources"].append("note_section")
                continue
            display = all_meds.get(rx, listed) if rx else listed
            item = med_item(display, rx, tables)
            item["sources"] = ["note_section"]
            meds[rx or f"note:{listed.lower()}"] = item
        prescribed: dict[str, JsonObj] = {}
        for iv in mr_by_encounter.get(enc["id"], []):
            item = prescribed.setdefault(
                iv.rxnorm, {**med_item(iv.display, iv.rxnorm, tables), "category": iv.category}
            )
            item["n_orders"] = int(item.get("n_orders", 0)) + 1
        diagnosed: dict[str, JsonObj] = {}
        n_filtered = 0
        for code, display, _status, onset, cond_enc in conditions:
            if cond_enc != enc["id"]:
                continue
            if not is_clinical_condition(code, display, tables):
                n_filtered += 1
                continue
            diagnosed[code] = {
                "display": display,
                "snomed": code,
                "onset": onset.isoformat() if onset else None,
            }
        base_id = f"SYN-{label.replace('-', '')}-{raw.note_date.isoformat()}"
        id_counts[base_id] += 1
        note_id = base_id if id_counts[base_id] == 1 else f"{base_id}-{id_counts[base_id]}"
        notes.append(
            {
                "id": note_id,
                "label": label,
                "note_date": raw.note_date.isoformat(),
                "encounter_type": enc["type"],
                "encounter_class": enc["class"],
                "encounter_reason": enc["reason"],
                "source": tables.label,
                "text": redact(raw.text.strip()) + "\n",
                "ground_truth": {
                    "chief_complaints": chief_complaints(sections),
                    "active_medications_at_note": sorted(
                        meds.values(), key=lambda m: (m["display"].lower(), str(m["rxnorm"]))
                    ),
                    "prescribed_at_encounter": sorted(
                        prescribed.values(), key=lambda m: (m["display"].lower(), m["rxnorm"])
                    ),
                    "conditions_diagnosed_at_encounter": sorted(
                        diagnosed.values(), key=lambda c: c["display"]
                    ),
                    "n_conditions_excluded_by_filter": n_filtered,
                    "is_emergency_encounter": enc["class"] == "emergency",
                    "sources": {
                        "chief_complaints": "note_section (Synthea renders the person's symptom "
                        "list here; there is no structured chief-complaint resource)",
                        "active_medications_at_note": f"structured ({interval_source}) "
                        "+ note_section '# Medications'",
                        "prescribed_at_encounter": "fhir MedicationRequest.encounter",
                        "conditions_diagnosed_at_encounter": "fhir Condition.encounter, "
                        "filtered by condition_filter.json",
                        "is_emergency_encounter": "fhir Encounter.class == EMER",
                    },
                },
            }
        )

    comorbidities, n_dropped = _comorbidities(src, tables, reference)
    nsclc = _nsclc(src, tables, reference)
    recent_encounters = [
        {k: e[k] for k in ("date", "type", "class", "reason")}
        for e in encounter_list
        if since < date.fromisoformat(e["date"]) <= reference
    ]
    newest_texts = [n.text for n in reversed(raw_notes)]
    participant = {
        "label": label,
        "synthea_ref": synthea_ref(src.uuid),
        "source": tables.label,
        "synthea_run_seed": src.run.seed,
        "sex": src.patient.get("gender"),
        "age_at_reference": age_on(src.birth, reference),
        "nsclc": nsclc,
        "comorbidities": comorbidities,
        "allergies": _allergies(src),
        "active_medications": active_meds,
        "medication_interval_source": interval_source,
        "cancer_therapy": _cancer_therapy(src, tables, reference),
        "encounters_last_12m": recent_encounters,
        "baseline_vitals": _baseline_vitals(src, tables, reference),
        "smoking": _smoking(src, tables, reference, newest_texts),
        "note_ids": [n["id"] for n in notes],
        "counts": {
            "encounters_total": len(encounter_list),
            "encounters_last_12m": len(recent_encounters),
            "emergency_encounters_last_12m": sum(
                1 for e in recent_encounters if e["class"] == "emergency"
            ),
            "conditions_total": len(conditions),
            "comorbidities_excluded_by_filter": n_dropped,
            "medication_requests": len(src.of("MedicationRequest")),
            "medication_administrations": len(src.of("MedicationAdministration")),
            "observations": len(src.of("Observation")),
            "notes_total": len(raw_notes),
            "notes_last_12m": sum(1 for n in raw_notes if since < n.note_date <= reference),
            "notes_selected": len(notes),
        },
    }
    return Built(participant, notes, {"interval_agreement": dict(agreement)})


# --------------------------------------------------------------------------------------
# Whole import
# --------------------------------------------------------------------------------------


def _config_excerpt(config: JsonObj) -> JsonObj:
    keys = (
        "jar_url",
        "jar_sha256",
        "jar_bytes",
        "synthea_release",
        "synthea_version",
        "docker_image",
        "population",
        "age",
        "seed",
        "clinician_seed",
        "reference_date",
        "state",
        "years_of_history",
        "exporter_flags",
        "keep_module",
    )
    excerpt = {k: config[k] for k in keys if k in config}
    if "top_up" in config:
        excerpt["top_up"] = {k: v for k, v in config["top_up"].items() if k != "rationale"}
    return excerpt


def resolve_in_dirs(in_dirs: Sequence[Path] | None) -> list[Path]:
    if in_dirs:
        return [Path(p) for p in in_dirs]
    env = os.environ.get(IN_DIRS_ENV)
    if env:
        return [Path(p) for p in env.split(os.pathsep) if p]
    return []


def run_import(
    in_dirs: Sequence[Path],
    outdir: Path,
    *,
    config_path: Path = DEFAULT_CONFIG,
    tables_dir: Path = DEFAULT_OUTDIR,
) -> JsonObj:
    """Import every patient bundle under ``in_dirs`` and write the three outputs to
    ``outdir``. Returns the manifest (which carries the summary stats)."""
    tables = load_tables(tables_dir)
    config = read_json(config_path)
    reference = date.fromisoformat(
        f"{config['reference_date'][:4]}-{config['reference_date'][4:6]}-{config['reference_date'][6:8]}"
    )

    sources: list[Source] = []
    runs: list[RunInfo] = []
    for run_dir in in_dirs:
        if not (run_dir / "fhir").is_dir():
            raise FileNotFoundError(
                f"{run_dir}: no fhir/ directory (is this a Synthea output dir?)"
            )
        run = read_run_info(run_dir)
        runs.append(run)
        stops = load_csv_stops(run_dir) if run.has_csv else None
        for path in patient_bundle_paths(run_dir):
            src = load_source(path, run)
            if stops is not None:
                src.csv_stops = stops.get(src.uuid, {})
            sources.append(src)
    if not sources:
        raise FileNotFoundError(f"no patient bundles found under {[str(d) for d in in_dirs]}")

    sources.sort(key=lambda s: (s.birth.isoformat(), s.uuid))
    for i, src in enumerate(sources, start=1):
        src.label = f"P-{i:03d}"

    built = [build_participant(src, tables, reference) for src in sources]
    participants = [b.participant for b in built]
    notes = [n for b in built for n in b.notes]

    common: JsonObj = {
        "source": f"Synthea synthetic EHR (simulated): https://github.com/synthetichealth/synthea "
        f"(Apache-2.0), jar sha256 {config['jar_sha256'][:16]}..., imported by "
        f"scripts/synthea/import_synthea.py v{IMPORTER_VERSION}",
        "rationale": "Realistic but entirely synthetic NSCLC patients (FHIR R4) for chart-scan "
        "input and as an answer key built from the structured record. Every value is "
        "simulated. Labels P-001.. are assigned deterministically (birth date, then Synthea "
        "id) in Interim's participant label space; whether a chart is attached to the seeded "
        "kiosk participant with the same label is decided by the seed/API, not here "
        "(data/synthetic/synthea/README.md).",
        "label": tables.label,
        "reference_date": reference.isoformat(),
    }
    participants_doc = {
        **common,
        "generated_with": {**_config_excerpt(config), "importer_version": IMPORTER_VERSION},
        "participants": participants,
    }
    notes_doc = {**common, "n_notes": len(notes), "notes": notes}

    outdir.mkdir(parents=True, exist_ok=True)
    payloads = {
        "participants.json": dump_json(participants_doc),
        "notes.json": dump_json(notes_doc),
    }
    for name, payload in payloads.items():
        (outdir / name).write_bytes(payload)

    files = [
        {"path": name, "sha256": sha256_bytes(payload), "bytes": len(payload), "role": "output"}
        for name, payload in payloads.items()
    ]
    for name in TABLE_FILES:
        path = tables_dir / name
        files.append(
            {
                "path": name,
                "sha256": sha256_file(path),
                "bytes": path.stat().st_size,
                "role": "table",
            }
        )

    manifest = {
        **common,
        "importer_version": IMPORTER_VERSION,
        "generated_with": _config_excerpt(config),
        "matcher_medlist_sha256": sha256_file(MEDLIST_PATH) if MEDLIST_PATH.is_file() else None,
        "runs": [
            {
                "seed": r.seed,
                "synthea_version": r.synthea_version,
                "patient_count": r.patient_count,
                "run_time_s": r.run_time_s,
                "csv_exported": r.has_csv,
            }
            for r in sorted(runs, key=lambda r: r.seed or 0)
        ],
        "inputs": [
            {
                "label": s.label,
                "run_seed": s.run.seed,
                "bundle_sha256": s.bundle_sha256,
                "bundle_bytes": s.bundle_bytes,
            }
            for s in sources
        ],
        "files": files,
        "n_patients": len(participants),
        "n_notes": len(notes),
        "stats": summarize(built),
    }
    manifest_bytes = dump_json(manifest)
    (outdir / "manifest.json").write_bytes(manifest_bytes)
    return manifest


def summarize(built: Sequence[Built]) -> JsonObj:
    """Key numbers for the manifest and the console."""
    participants = [b.participant for b in built]
    notes = [n for b in built for n in b.notes]
    stages = Counter(str((p["nsclc"] or {}).get("stage")) for p in participants)
    meds_per = [len(p["active_medications"]) for p in participants]
    outcome: Counter[str] = Counter()
    distinct: dict[str, str] = {}
    for p in participants:
        for med in p["active_medications"]:
            agrees = med["interim_match"]["agrees_with_ingredient"]
            outcome["unmatched" if agrees is None else "correct" if agrees else "wrong"] += 1
            distinct[med["display"]] = (
                "unmatched" if agrees is None else "correct" if agrees else "wrong"
            )
    agreement: Counter[str] = Counter()
    for b in built:
        agreement.update(b.stats.get("interval_agreement", {}))
    n_meds = sum(outcome.values())
    return {
        "stage_distribution": dict(sorted(stages.items())),
        "sex_distribution": dict(sorted(Counter(str(p["sex"]) for p in participants).items())),
        "age_range": [
            min(p["age_at_reference"] for p in participants),
            max(p["age_at_reference"] for p in participants),
        ],
        "active_medications_per_participant": {
            "min": min(meds_per),
            "max": max(meds_per),
            "mean": round(statistics.mean(meds_per), 2),
            "total": sum(meds_per),
        },
        "notes_per_participant": dict(
            sorted(Counter(p["label"] for p in participants for _ in p["note_ids"]).items())
        ),
        "emergency_notes": sum(1 for n in notes if n["ground_truth"]["is_emergency_encounter"]),
        "conmed_matcher_on_active_medications": {
            "n": n_meds,
            "correct": outcome["correct"],
            "wrong": outcome["wrong"],
            "unmatched": outcome["unmatched"],
            "pct_correct": round(100 * outcome["correct"] / n_meds, 1) if n_meds else None,
            "distinct_displays": dict(sorted(distinct.items())),
            "definition": "correct = match_conmed(full RxNorm display) returns a generic equal to "
            "the display's parsed ingredient (salt words removed); wrong = a different drug; "
            "unmatched = no proposal",
        },
        "fhir_heuristic_vs_csv_on_selected_notes": {
            **dict(sorted(agreement.items())),
            "definition": "for participants whose run exported CSV: does the FHIR-only "
            "active-medication heuristic give the same RxNorm set as Synthea's CSV stop "
            "dates on each selected note date",
        },
        "medication_interval_source": dict(
            sorted(Counter(p["medication_interval_source"] for p in participants).items())
        ),
    }


def check(
    in_dirs: Sequence[Path],
    outdir: Path,
    config_path: Path,
    tables_dir: Path,
    *,
    strict: bool = False,
) -> int:
    """Re-import into a temp dir and require byte-identical outputs (determinism).

    Without the raw Synthea output (a clean clone, CI) only the manifest is verified: the
    committed files' hashes and the con-med matcher's medlist hash. That does NOT verify that
    the importer code still produces these files; the message says so, and ``strict`` turns
    it into a failure."""
    if not in_dirs or not all((d / "fhir").is_dir() for d in in_dirs):
        print(
            "check: WARNING, Synthea source directories not available (raw FHIR is not "
            f"committed; pass --in or set {IN_DIRS_ENV}). Verifying manifest hashes only: "
            "importer drift is NOT verified."
        )
        status = verify_manifest(outdir, tables_dir)
        if strict:
            print("check: FAIL, --strict requires the Synthea source directories")
            return 1
        return status
    with tempfile.TemporaryDirectory(prefix="interim-synthea-check-") as tmp:
        run_import(in_dirs, Path(tmp), config_path=config_path, tables_dir=tables_dir)
        bad = []
        for name in OUTPUT_FILES:
            committed = outdir / name
            fresh = Path(tmp) / name
            if not committed.is_file() or committed.read_bytes() != fresh.read_bytes():
                bad.append(name)
        if bad:
            print(f"check: FAIL, re-import differs from committed files: {', '.join(bad)}")
            return 1
    print(f"check: OK, re-import is byte-identical for {', '.join(OUTPUT_FILES)}")
    return verify_manifest(outdir, tables_dir)


def verify_manifest(
    outdir: Path, tables_dir: Path | None = None, medlist_path: Path = MEDLIST_PATH
) -> int:
    """Every file listed in outdir/manifest.json still has its recorded sha256, and the
    con-med matcher's medlist is the one the import ran against. Outputs are looked up in
    ``outdir``; the input tables in ``tables_dir`` (default: ``outdir``)."""
    manifest = read_json(outdir / "manifest.json")
    bad = []
    for entry in manifest["files"]:
        base = (tables_dir or outdir) if entry.get("role") == "table" else outdir
        path = base / entry["path"]
        if not path.is_file() or sha256_file(path) != entry["sha256"]:
            bad.append(entry["path"])
    if bad:
        print(f"check: FAIL, manifest hash mismatch: {', '.join(bad)}")
        return 1
    print(f"check: OK, manifest hashes match ({len(manifest['files'])} files)")
    return verify_matcher_medlist(manifest, medlist_path)


def verify_matcher_medlist(manifest: JsonObj, medlist_path: Path = MEDLIST_PATH) -> int:
    """participants.json embeds con-med matcher output (``interim_match``) computed against
    packages/rules/data/medlist.json. If that list changed since the import, the committed
    annotations and the matcher stats are stale even though every committed hash still
    matches, so fail and say how to refresh them."""
    recorded = manifest.get("matcher_medlist_sha256")
    current = sha256_file(medlist_path) if medlist_path.is_file() else None
    if recorded != current:
        print(
            f"check: FAIL, con-med matcher list changed since import: {medlist_path.name} "
            f"sha256 {str(current)[:16]} != manifest matcher_medlist_sha256 "
            f"{str(recorded)[:16]}. The committed interim_match annotations are stale; re-run "
            "the import with --in <Synthea output> (see data/synthetic/synthea/README.md)."
        )
        return 1
    print(f"check: OK, con-med matcher list unchanged ({medlist_path.name} sha256 matches)")
    return 0


def print_summary(manifest: JsonObj, outdir: Path) -> None:
    stats = manifest["stats"]
    matcher = stats["conmed_matcher_on_active_medications"]
    total = sum(f["bytes"] for f in manifest["files"])
    print(f"wrote {outdir}")
    for f in manifest["files"]:
        print(f"  {f['path']:<24} {f['bytes']:>9,} bytes  sha256 {f['sha256'][:16]}")
    print(f"  total {total:,} bytes (+ manifest.json, README.md)")
    print(
        f"patients: {manifest['n_patients']}  notes: {manifest['n_notes']}  "
        f"emergency notes: {stats['emergency_notes']}"
    )
    print(f"runs: {[(r['seed'], r['patient_count']) for r in manifest['runs']]}")
    print(
        f"stage distribution: {stats['stage_distribution']}  sex: {stats['sex_distribution']}  "
        f"age range: {stats['age_range']}"
    )
    print(f"active meds per participant: {stats['active_medications_per_participant']}")
    print(
        f"con-med matcher on active meds: {matcher['correct']}/{matcher['n']} correct "
        f"({matcher['pct_correct']}%), {matcher['wrong']} wrong, {matcher['unmatched']} unmatched"
    )
    agreement = {
        k: v
        for k, v in stats["fhir_heuristic_vs_csv_on_selected_notes"].items()
        if k != "definition"
    }
    print(f"FHIR heuristic vs CSV stop dates (selected notes): {agreement}")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--in",
        dest="in_dirs",
        type=Path,
        action="append",
        help="Synthea output dir (with fhir/, notes/, optional csv/, metadata/); repeat for a "
        f"top-up run. Default: ${IN_DIRS_ENV} (os.pathsep-separated). There is no built-in "
        "default: the raw output is not committed.",
    )
    parser.add_argument("--outdir", type=Path, default=DEFAULT_OUTDIR)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument(
        "--tables-dir",
        type=Path,
        default=None,
        help="Where condition_filter.json / import_tables.json live (default: --outdir's "
        "committed copy in data/synthetic/synthea)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Re-import into a temp dir and require byte-identical output vs --outdir "
        "(without the raw Synthea output: verify manifest and medlist hashes only, with a "
        "warning)",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="With --check: fail instead of falling back to hash-only verification when the "
        "Synthea source directories are not available",
    )
    args = parser.parse_args(argv)
    in_dirs = resolve_in_dirs(args.in_dirs)
    tables_dir = args.tables_dir or DEFAULT_OUTDIR
    if args.check:
        return check(in_dirs, args.outdir, args.config, tables_dir, strict=args.strict)
    if not in_dirs:
        parser.error(f"no Synthea output directory given; pass --in <dir> or set {IN_DIRS_ENV}")
    manifest = run_import(in_dirs, args.outdir, config_path=args.config, tables_dir=tables_dir)
    print_summary(manifest, args.outdir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
