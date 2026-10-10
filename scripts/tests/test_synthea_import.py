"""Tests for the Synthea pipeline (scripts/synthea/import_synthea.py and run_synthea.py).

Three layers:
* pure units (ingredient heuristic, condition filter, command construction, jar pinning);
* a tiny hand-built FHIR bundle (below) imported end to end, so de-identification and
  determinism are tested in CI, where the raw Synthea output (~66 MB) does not exist;
* the committed fixtures in data/synthetic/synthea/ (schema, hashes, size budget, no
  identifiers), plus checks against the real Synthea source bundles when they are on disk
  (skipped otherwise).
No network; nothing here runs Synthea.
"""

from __future__ import annotations

import base64
import json
import re
import sys
from pathlib import Path
from typing import Any

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from synthea import import_synthea as imp  # noqa: E402
from synthea import run_synthea as runner  # noqa: E402

COMMITTED = imp.DEFAULT_OUTDIR
TABLES = imp.load_tables(COMMITTED)
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
PHONE_RE = re.compile(r"\b\d{3}-\d{3}-\d{4}\b")
SSN_RE = re.compile(r"\b999-\d{2}-\d{4}\b")

JsonObj = dict[str, Any]


# --------------------------------------------------------------------------------------
# Ingredient heuristic and condition filter
# --------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("display", "leading", "all_ingredients", "brand"),
    [
        (
            "24 HR metoprolol succinate 100 MG Extended Release Oral Tablet",
            "metoprolol",
            None,
            None,
        ),
        ("1 ML DOCEtaxel 20 MG/ML Injection", "docetaxel", None, None),
        ("Simvastatin 10 MG Oral Tablet", "simvastatin", None, None),
        # Combination: the leading (first-listed) ingredient, all ingredients kept separately.
        (
            "Acetaminophen 325 MG / Oxycodone Hydrochloride 5 MG Oral Tablet",
            "acetaminophen",
            ["acetaminophen", "oxycodone"],
            None,
        ),
        (
            "insulin isophane, human 70 UNT/ML / insulin, regular, human 30 UNT/ML "
            "Injectable Suspension [Humulin]",
            "insulin",
            None,
            "Humulin",
        ),
        ("0.25 ML Leuprolide Acetate 30 MG/ML Prefilled Syringe", "leuprolide", None, None),
        ("Naproxen sodium 220 MG Oral Tablet", "naproxen", None, None),
        # A name that starts with a salt word stays whole.
        ("sodium fluoride 0.0272 MG/MG Oral Gel", "sodium fluoride", None, None),
        ("Sodium Chloride 9 MG/ML Injectable Solution", "sodium chloride", None, None),
        ("1 ML heparin sodium, porcine 5000 UNT/ML Injection", "heparin", None, None),
        (
            "NDA020503 200 ACTUAT Albuterol 0.09 MG/ACTUAT Metered Dose Inhaler",
            "albuterol",
            None,
            None,
        ),
        ("Nitroglycerin 0.4 MG/ACTUAT Mucosal Spray", "nitroglycerin", None, None),
        ("Alendronic acid 10 MG Oral Tablet", "alendronic acid", None, None),
    ],
)
def test_parse_ingredients(
    display: str, leading: str, all_ingredients: list[str] | None, brand: str | None
) -> None:
    parsed = imp.parse_ingredients(display, TABLES)
    assert parsed.leading == leading
    assert list(parsed.all) == (all_ingredients or [leading])
    assert parsed.is_combination == (all_ingredients is not None and len(all_ingredients) > 1)
    assert parsed.brand == brand


@pytest.mark.parametrize(
    ("code", "display", "kept"),
    [
        ("59621000", "Essential hypertension (disorder)", True),
        ("160903007", "Full-time employment (finding)", False),
        ("706893006", "Victim of intimate partner abuse (finding)", False),
        ("162864005", "Body mass index 30+ - obesity (finding)", True),  # allow-listed finding
        ("162573006", "Suspected lung cancer (situation)", False),
        ("5602001", "Opioid abuse", True),  # no semantic tag
    ],
)
def test_condition_filter(code: str, display: str, kept: bool) -> None:
    assert imp.is_clinical_condition(code, display, TABLES) is kept


def test_keep_module_codes_match_import_tables() -> None:
    keep = json.loads((SCRIPTS / "synthea" / "keep_nsclc.json").read_text(encoding="utf-8"))
    conditions = keep["states"]["Initial"]["conditional_transition"][0]["condition"]["conditions"]
    keep_codes = {c["codes"][0]["code"] for c in conditions}
    assert keep_codes == set(TABLES.nsclc_stage)


# --------------------------------------------------------------------------------------
# A tiny synthetic FHIR run (CI-safe end-to-end test)
# --------------------------------------------------------------------------------------

PT_UUID = "11111111-2222-3333-4444-555555555555"
ER_ENC = "aaaaaaaa-0000-0000-0000-000000000001"
CHEMO_ENC = "aaaaaaaa-0000-0000-0000-000000000002"
OLD_ENC = "aaaaaaaa-0000-0000-0000-000000000003"
FORBIDDEN_FIXTURE = [
    "Testy123", "Fakeface45", "Testy", "Fakeface", "Maidenly77", "42 Imaginary Lane",
    "Nowhereville", "01999", "555-123-4567", "999-12-3456", "S99912345", PT_UUID,
]  # fmt: skip


def _cc(system: str, code: str, display: str) -> JsonObj:
    return {"coding": [{"system": system, "code": code, "display": display}], "text": display}


def _snomed(code: str, display: str) -> JsonObj:
    return _cc("http://snomed.info/sct", code, display)


def _rx(code: str, display: str) -> JsonObj:
    return _cc("http://www.nlm.nih.gov/research/umls/rxnorm", code, display)


def _encounter(enc_id: str, start: str, cls: str, type_display: str, reason: str) -> JsonObj:
    return {
        "resourceType": "Encounter",
        "id": enc_id,
        "class": {"code": cls},
        "type": [_snomed("1", type_display)],
        "period": {"start": start, "end": start},
        "reasonCode": [_snomed("2", reason)],
        "subject": {"reference": f"urn:uuid:{PT_UUID}"},
    }


def _note(doc_id: str, enc_id: str, day: str, meds_line: str) -> JsonObj:
    text = (
        f"\n{day}\n\n# Chief Complaint\n- Cough\n- Fatigue\n\n\n# History of Present Illness\n"
        "Testy123 is a 70 year-old nonhispanic white male. Mr. Testy123 Fakeface45 reports "
        "fatigue.\n\n# Social History\nPatient has never smoked.\n\n# Allergies\nNo Known "
        f"Allergies.\n\n# Medications\n{meds_line}\n\n# Assessment and Plan\n\n## Plan\n"
    )
    return {
        "resourceType": "DocumentReference",
        "id": doc_id,
        "status": "current",
        "date": f"{day}T10:00:00+00:00",
        "content": [
            {
                "attachment": {
                    "contentType": "text/plain; charset=utf-8",
                    "data": base64.b64encode(text.encode("utf-8")).decode("ascii"),
                }
            }
        ],
        "context": {"encounter": [{"reference": f"urn:uuid:{enc_id}"}]},
    }


def _mr(mr_id: str, enc: str, authored: str, status: str, category: str, rx: JsonObj) -> JsonObj:
    return {
        "resourceType": "MedicationRequest",
        "id": mr_id,
        "status": status,
        "category": [_cc("x", category, category)],
        "medicationCodeableConcept": rx,
        "encounter": {"reference": f"urn:uuid:{enc}"},
        "authoredOn": authored,
    }


def _obs(obs_id: str, loinc: str, when: str, value: float) -> JsonObj:
    return {
        "resourceType": "Observation",
        "id": obs_id,
        "code": _cc("http://loinc.org", loinc, loinc),
        "effectiveDateTime": when,
        "valueQuantity": {"value": value},
    }


def fixture_bundle() -> JsonObj:
    nsclc = _snomed("425048006", "Non-small cell carcinoma of lung, TNM stage 2 (disorder)")
    simva = _rx("314231", "Simvastatin 10 MG Oral Tablet")
    resources: list[JsonObj] = [
        {
            "resourceType": "Patient",
            "id": PT_UUID,
            "name": [
                {
                    "use": "official",
                    "family": "Fakeface45",
                    "given": ["Testy123"],
                    "prefix": ["Mr."],
                }
            ],
            "extension": [
                {
                    "url": "http://hl7.org/fhir/StructureDefinition/patient-mothersMaidenName",
                    "valueString": "Maidenly77",
                }
            ],
            "gender": "male",
            "birthDate": "1956-01-15",
            "address": [
                {"line": ["42 Imaginary Lane"], "city": "Nowhereville", "postalCode": "01999"}
            ],
            "telecom": [{"system": "phone", "value": "555-123-4567"}],
            "identifier": [
                {"system": "https://github.com/synthetichealth/synthea", "value": PT_UUID},
                {"system": "http://hl7.org/fhir/sid/us-ssn", "value": "999-12-3456"},
                {"system": "urn:oid:2.16.840.1.113883.4.3.25", "value": "S99912345"},
            ],
        },
        _encounter(OLD_ENC, "2025-01-10T10:00:00+00:00", "AMB", "Encounter for check up", "x"),
        _encounter(ER_ENC, "2026-05-01T10:00:00+00:00", "EMER", "Emergency room admission", "y"),
        _encounter(CHEMO_ENC, "2026-06-01T10:00:00+00:00", "IMP", "Encounter for problem", "z"),
        {
            "resourceType": "Condition",
            "id": "c1",
            "clinicalStatus": _cc("x", "active", "active"),
            "code": nsclc,
            "encounter": {"reference": f"urn:uuid:{ER_ENC}"},
            "onsetDateTime": "2026-05-01T10:00:00+00:00",
        },
        {
            "resourceType": "Condition",
            "id": "c2",
            "clinicalStatus": _cc("x", "active", "active"),
            "code": _snomed("59621000", "Essential hypertension (disorder)"),
            "encounter": {"reference": f"urn:uuid:{OLD_ENC}"},
            "onsetDateTime": "2025-01-10T10:00:00+00:00",
        },
        {
            "resourceType": "Condition",
            "id": "c3",
            "clinicalStatus": _cc("x", "active", "active"),
            "code": _snomed("160903007", "Full-time employment (finding)"),
            "encounter": {"reference": f"urn:uuid:{OLD_ENC}"},
            "onsetDateTime": "2025-01-10T10:00:00+00:00",
        },
        # Yearly statin renewal: completed in 2025, active since 2026 -> started 2025-01-10.
        _mr("m1", OLD_ENC, "2025-01-10T10:00:00+00:00", "completed", "community", simva),
        _mr("m2", ER_ENC, "2026-01-10T10:00:00+00:00", "active", "community", simva),
        _mr(
            "m3",
            CHEMO_ENC,
            "2026-06-01T10:00:00+00:00",
            "completed",
            "inpatient",
            _rx("1736854", "Cisplatin 50 MG Injection"),
        ),
        {
            "resourceType": "MedicationAdministration",
            "id": "a1",
            "status": "completed",
            "medicationCodeableConcept": _rx("1736854", "Cisplatin 50 MG Injection"),
            "effectiveDateTime": "2026-06-01T11:00:00+00:00",
            "reasonReference": [{"reference": "urn:uuid:c1", "display": nsclc["text"]}],
        },
        _obs("o1", "8867-4", "2025-01-10T10:00:00+00:00", 70),
        _obs("o2", "8867-4", "2026-05-01T10:00:00+00:00", 88),
        _obs("o3", "9279-1", "2026-05-01T10:00:00+00:00", 16),
        _note("d1", OLD_ENC, "2025-01-10", "No Active Medications."),
        _note("d2", ER_ENC, "2026-05-01", "simvastatin 10 mg oral tablet"),
        _note(
            "d3",
            CHEMO_ENC,
            "2026-06-01",
            "simvastatin 10 mg oral tablet; cisplatin 50 mg injection",
        ),
    ]
    return {
        "resourceType": "Bundle",
        "type": "transaction",
        "entry": [{"fullUrl": f"urn:uuid:{r['id']}", "resource": r} for r in resources],
    }


@pytest.fixture
def fixture_run(tmp_path: Path) -> Path:
    run_dir = tmp_path / "synthea_out"
    (run_dir / "fhir").mkdir(parents=True)
    (run_dir / "fhir" / "Testy123_Fakeface45_x.json").write_text(
        json.dumps(fixture_bundle()), encoding="utf-8"
    )
    (run_dir / "fhir" / "hospitalInformation1.json").write_text("{}", encoding="utf-8")
    (run_dir / "metadata").mkdir()
    (run_dir / "metadata" / "m.json").write_text(
        json.dumps({"seed": 7, "patientCount": 1, "version": "test\n"}), encoding="utf-8"
    )
    return run_dir


def _output_text(outdir: Path) -> str:
    return "".join((outdir / name).read_text(encoding="utf-8") for name in imp.OUTPUT_FILES)


def test_fixture_import_is_deidentified(fixture_run: Path, tmp_path: Path) -> None:
    out = tmp_path / "out"
    imp.run_import([fixture_run], out)
    text = _output_text(out)
    for token in FORBIDDEN_FIXTURE:
        assert token not in text, token
    assert not imp.SYNTHEA_NAME_TOKEN.search(text)
    assert not UUID_RE.search(text)
    notes = json.loads((out / "notes.json").read_text(encoding="utf-8"))["notes"]
    assert all("P-001 is a 70 year-old" in n["text"] for n in notes)
    assert all("Mr. P-001" not in n["text"] and "P-001 P-001" not in n["text"] for n in notes)


def test_fixture_import_is_deterministic(fixture_run: Path, tmp_path: Path) -> None:
    imp.run_import([fixture_run], tmp_path / "a")
    imp.run_import([fixture_run], tmp_path / "b")
    for name in imp.OUTPUT_FILES:
        assert (tmp_path / "a" / name).read_bytes() == (tmp_path / "b" / name).read_bytes(), name
    assert imp.check([fixture_run], tmp_path / "a", imp.DEFAULT_CONFIG, COMMITTED) == 0


def test_fixture_ground_truth(fixture_run: Path, tmp_path: Path) -> None:
    out = tmp_path / "out"
    manifest = imp.run_import([fixture_run], out)
    participant = json.loads((out / "participants.json").read_text(encoding="utf-8"))[
        "participants"
    ][0]
    assert participant["label"] == "P-001"
    assert participant["synthea_ref"] == imp.synthea_ref(PT_UUID)
    assert participant["age_at_reference"] == 70
    assert participant["nsclc"]["stage"] == "2"
    assert [c["snomed"] for c in participant["comorbidities"]] == ["59621000"]
    assert participant["medication_interval_source"] == "fhir_status_heuristic"
    [statin] = participant["active_medications"]
    assert statin["ingredient"] == "simvastatin" and statin["started"] == "2025-01-10"
    assert statin["interim_match"]["agrees_with_ingredient"] is True
    assert participant["cancer_therapy"][0]["n_administrations"] == 1
    assert participant["baseline_vitals"]["pulse_bpm"]["median"] == 79.0
    assert participant["smoking"]["status"] == "never"

    notes = {
        n["note_date"]: n for n in json.loads((out / "notes.json").read_text("utf-8"))["notes"]
    }
    assert set(notes) == {"2026-05-01", "2026-06-01"}  # 2025 note is outside 12 months
    er = notes["2026-05-01"]
    assert er["id"] == "SYN-P001-2026-05-01"
    assert er["ground_truth"]["is_emergency_encounter"] is True
    assert er["ground_truth"]["chief_complaints"] == ["Cough", "Fatigue"]
    assert er["ground_truth"]["conditions_diagnosed_at_encounter"][0]["snomed"] == "425048006"
    [med] = er["ground_truth"]["active_medications_at_note"]
    assert med["sources"] == ["structured", "note_section"]
    chemo = notes["2026-06-01"]["ground_truth"]
    assert [m["ingredient"] for m in chemo["prescribed_at_encounter"]] == ["cisplatin"]
    assert {m["ingredient"] for m in chemo["active_medications_at_note"]} == {
        "simvastatin",
        "cisplatin",
    }
    assert manifest["n_patients"] == 1 and manifest["n_notes"] == 2


# --------------------------------------------------------------------------------------
# The committed fixtures
# --------------------------------------------------------------------------------------


def _committed(name: str) -> Any:
    return json.loads((COMMITTED / name).read_text(encoding="utf-8"))


PARTICIPANT_KEYS = {
    "label", "synthea_ref", "sex", "age_at_reference", "nsclc", "comorbidities", "allergies",
    "active_medications", "cancer_therapy", "encounters_last_12m", "baseline_vitals",
    "smoking", "counts", "source",
}  # fmt: skip
GROUND_TRUTH_KEYS = {
    "chief_complaints", "active_medications_at_note", "prescribed_at_encounter",
    "conditions_diagnosed_at_encounter", "is_emergency_encounter",
}  # fmt: skip


def test_committed_schema() -> None:
    participants = _committed("participants.json")
    assert participants["label"] == "Synthea synthetic EHR (simulated)"
    labels = [p["label"] for p in participants["participants"]]
    assert labels == [f"P-{i:03d}" for i in range(1, len(labels) + 1)]
    for p in participants["participants"]:
        assert set(p) >= PARTICIPANT_KEYS, p["label"]
        assert re.fullmatch(r"[0-9a-f]{12}", p["synthea_ref"])
        assert p["nsclc"] and p["nsclc"]["diagnosis_date"], p["label"]
        vitals = p["baseline_vitals"]
        assert vitals["label"] == "Synthea synthetic EHR (simulated)"
        assert vitals["is_measured"] is False
        assert any(isinstance(vitals[k], dict) for k in ("pulse_bpm", "breathing_bpm")), p["label"]
        for med in p["active_medications"]:
            assert {"display", "rxnorm", "ingredient", "started", "interim_match"} <= set(med)
    notes = _committed("notes.json")
    assert notes["n_notes"] == len(notes["notes"])
    ids = [n["id"] for n in notes["notes"]]
    assert len(ids) == len(set(ids))
    for note in notes["notes"]:
        assert re.fullmatch(r"SYN-P\d{3}-\d{4}-\d{2}-\d{2}(-\d+)?", note["id"])
        assert set(note["ground_truth"]) >= GROUND_TRUTH_KEYS
        assert note["source"] == "Synthea synthetic EHR (simulated)"
    per_label: dict[str, list[JsonObj]] = {}
    for note in notes["notes"]:
        per_label.setdefault(note["label"], []).append(note)
    assert all(len(v) <= 6 for v in per_label.values())


def test_committed_manifest_hashes_and_size_budget() -> None:
    assert imp.verify_manifest(COMMITTED) == 0
    manifest = _committed("manifest.json")
    assert manifest["n_patients"] == len(_committed("participants.json")["participants"])
    total = sum(p.stat().st_size for p in COMMITTED.iterdir() if p.is_file())
    assert total < 1_500_000, total


def test_committed_outputs_have_no_identifier_patterns() -> None:
    text = _output_text(COMMITTED)
    assert not UUID_RE.search(text)
    assert not imp.SYNTHEA_NAME_TOKEN.search(text)
    assert not PHONE_RE.search(text)
    assert not SSN_RE.search(text)


def _source_dirs() -> list[Path]:
    return [d for d in imp.resolve_in_dirs(None) if (d / "fhir").is_dir()]


def _forbidden_from_source(dirs: list[Path]) -> set[str]:
    """Every identifying string in the source Patient resources (and bundle filenames)."""
    forbidden: set[str] = set()
    for run_dir in dirs:
        for path in imp.patient_bundle_paths(run_dir):
            forbidden.update(t for t in path.stem.split("_") if t)
            bundle = json.loads(path.read_text(encoding="utf-8"))
            patient = next(
                e["resource"] for e in bundle["entry"] if e["resource"]["resourceType"] == "Patient"
            )
            for name in patient.get("name", []):
                for token in [*name.get("given", []), name.get("family", "")]:
                    forbidden.add(token)
                    stripped = re.sub(r"\d+$", "", token)
                    if len(stripped) >= 4:
                        forbidden.add(stripped)
            for ext in patient.get("extension", []):
                if ext["url"].endswith("mothersMaidenName"):
                    forbidden.update(ext["valueString"].split())
            for address in patient.get("address", []):
                forbidden.update(address.get("line", []))
                forbidden.update(str(address.get(k, "")) for k in ("city", "postalCode"))
            forbidden.update(t["value"] for t in patient.get("telecom", []))
            forbidden.update(i["value"] for i in patient.get("identifier", []))
            forbidden.add(patient["id"])
    forbidden.discard("")
    return forbidden


@pytest.mark.skipif(not _source_dirs(), reason="Synthea source output not on this machine")
def test_committed_outputs_contain_no_source_identifiers() -> None:
    forbidden = _forbidden_from_source(_source_dirs())
    assert len(forbidden) > 50  # names, addresses, phones, SSNs, MRNs, UUIDs for 12 patients
    text = _output_text(COMMITTED)
    leaks = sorted(t for t in forbidden if re.search(rf"(?<![\w-]){re.escape(t)}(?![\w-])", text))
    assert leaks == []


@pytest.mark.skipif(not _source_dirs(), reason="Synthea source output not on this machine")
def test_reimport_matches_committed(tmp_path: Path) -> None:
    imp.run_import(_source_dirs(), tmp_path)
    for name in imp.OUTPUT_FILES:
        assert (tmp_path / name).read_bytes() == (COMMITTED / name).read_bytes(), name


# --------------------------------------------------------------------------------------
# run_synthea.py
# --------------------------------------------------------------------------------------

CONFIG = runner.load_config(runner.DEFAULT_CONFIG)


def test_dry_run_docker_command_shape(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    code = runner.main(
        [
            "--dry-run",
            "--runner",
            "docker",
            "--cache-dir",
            str(tmp_path / "c"),
            "--out",
            str(tmp_path / "o"),
        ]
    )
    assert code == 0
    out = capsys.readouterr().out
    lines = [line for line in out.splitlines() if line.startswith("docker run")]
    assert len(lines) == 2  # primary + top-up preview
    primary = lines[0]
    assert (
        "eclipse-temurin:17-jre java -Xmx3g -jar /synthea/synthea-with-dependencies.jar" in primary
    )
    for fragment in (
        "-p 12", "-a 50-80", "-s 20261010", "-cs 20261010", "-r 20261010",
        "-k /keep/keep_nsclc.json", "--exporter.baseDirectory=/out",
        "--exporter.fhir.export=true", "--exporter.csv.export=true",
        "--exporter.clinical_note.export=true", "--exporter.years_of_history=3",
        "--generate.only_alive_patients=true", "--generate.max_attempts_to_keep_patient=5000",
    ):  # fmt: skip
        assert fragment in primary, fragment
    assert primary.endswith(" Massachusetts")
    assert "-s 20261011" in lines[1] and "--exporter.csv.export=false" in lines[1]
    assert "import_synthea.py" in out and "would download" in out
    assert not (tmp_path / "c").exists() and not (tmp_path / "o").exists()  # touched nothing


def test_build_command_java_uses_absolute_host_paths(tmp_path: Path) -> None:
    spec = runner.primary_spec(CONFIG, tmp_path / "out")
    jar, keep = tmp_path / "cache" / runner.JAR_NAME, tmp_path / "keep_nsclc.json"
    cmd = runner.build_command(CONFIG, spec, runner="java", jar=jar, keep_module=keep)
    assert cmd[:3] == ["java", "-Xmx3g", "-jar"]
    assert Path(cmd[3]).is_absolute()
    assert cmd[cmd.index("-k") + 1] == str(keep.resolve())
    assert f"--exporter.baseDirectory={(tmp_path / 'out' / 'primary').resolve()}" in cmd
    with pytest.raises(ValueError, match="unknown runner"):
        runner.build_command(CONFIG, spec, runner="podman", jar=jar, keep_module=keep)


def test_top_up_spec_uses_next_seed_and_shortfall(tmp_path: Path) -> None:
    spec = runner.top_up_spec(CONFIG, tmp_path, 3)
    assert (spec.seed, spec.clinician_seed, spec.population) == (20261011, 20261011, 3)
    assert spec.flags["exporter.csv.export"] is False
    assert spec.flags["exporter.fhir.export"] is True


def test_verify_jar_pinning(tmp_path: Path) -> None:
    jar = tmp_path / runner.JAR_NAME
    jar.write_bytes(b"not the real jar")
    config_path = tmp_path / "synthea_config.json"
    config = dict(CONFIG)
    config_path.write_text(json.dumps(config), encoding="utf-8")
    with pytest.raises(runner.JarMismatchError, match="--accept-new-jar"):
        runner.verify_jar(jar, dict(config), config_path, accept_new=False)
    new_hash = runner.verify_jar(jar, dict(config), config_path, accept_new=True)
    recorded = json.loads(config_path.read_text(encoding="utf-8"))
    assert recorded["jar_sha256"] == new_hash and recorded["jar_bytes"] == len(b"not the real jar")
    assert runner.verify_jar(jar, recorded, config_path, accept_new=False) == new_hash


def test_bad_arguments_exit_2() -> None:
    with pytest.raises(SystemExit) as exc:
        runner.parse_args(["--runner", "podman"])
    assert exc.value.code == 2


def test_subprocess_env_disables_msys_path_conversion() -> None:
    env = runner.subprocess_env()
    assert env["MSYS_NO_PATHCONV"] == "1"


def test_config_pins_the_committed_jar() -> None:
    assert re.fullmatch(r"[0-9a-f]{64}", CONFIG["jar_sha256"])
    assert CONFIG["jar_sha256"].startswith("018ad7f04f7aacb9")
    manifest = _committed("manifest.json")
    assert manifest["generated_with"]["jar_sha256"] == CONFIG["jar_sha256"]
