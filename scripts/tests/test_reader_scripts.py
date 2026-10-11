"""Tests for scripts/record_gemini_cache.py and scripts/eval_reader.py (CONTRACTS.md R5.3).

No network and no API key: the recorder runs against ``httpx.MockTransport`` and a temporary
cache directory; the evaluator replays hand-made recorded answers. The committed cache and the
committed ``docs/eval/reader_results.md`` are only read.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
REPO = SCRIPTS.parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

# The reader lives in apps/api and talks HTTP through httpx. The CI "scripts" job installs only
# the rules package, so skip there. Modules are imported dynamically (mypy needs no httpx stubs).
pytest.importorskip("httpx")
if importlib.util.find_spec("interim_api") is None and not (REPO / "apps" / "api").is_dir():
    pytest.skip("apps/api is not available", allow_module_level=True)
sys.path.insert(0, str(REPO / "apps" / "api"))

httpx: Any = importlib.import_module("httpx")
rec: Any = importlib.import_module("record_gemini_cache")
evr: Any = importlib.import_module("eval_reader")
reader: Any = importlib.import_module("interim_api.readers.gemini_reader")
cache_mod: Any = importlib.import_module("interim_api.readers.cache")

from interim_rules import llm_verify  # noqa: E402

KEY = "AIza-test-key-not-a-real-secret"


@pytest.fixture(autouse=True)
def _hermetic(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("INTERIM_LLM_MODE", "auto")
    reader._DISCOVERED.clear()


def answer_for(text: str) -> dict[str, Any]:
    return {
        "symptoms": [{"quote": text.split()[0], "term": "Fatigue", "status": "current"}],
        "medications": [],
    }


def fake_gemini(calls: list[str]) -> Any:
    def handler(request: Any) -> Any:
        body = json.loads(request.content)
        calls.append(body["contents"][0]["parts"][0]["text"])
        payload = {
            "candidates": [
                {"content": {"parts": [{"text": json.dumps(answer_for("Fatigue today"))}]}}
            ]
        }
        return httpx.Response(200, json=payload)

    return httpx.MockTransport(handler)


# --------------------------------------------------------------------------------------
# record_gemini_cache.py
# --------------------------------------------------------------------------------------


def test_targets_cover_seed_key_and_demo_and_are_deduplicated() -> None:
    targets = rec.collect(synthea=False)
    labels = {t.label for t in targets}
    assert {"seed:N1", "seed:N3", "seed:N6", "seed:UC1"} <= labels
    assert {"key:N-HYPO", "key:C-STOOLS", "demo:hypothyroidism"} <= labels
    assert len({(t.kind, t.text) for t in targets}) == len(targets)
    kinds = {t.label: t.kind for t in targets}
    assert kinds["seed:N3"] == "call" and kinds["seed:N1"] == "note"
    assert kinds["key:C-STOOLS"] == "call" and kinds["key:N-HYPO"] == "note"
    # --synthea adds the 72 Synthea notes on top.
    with_synthea = rec.collect(synthea=True)
    assert len(with_synthea) - len(targets) == 72
    assert all(t.kind == "note" for t in with_synthea if t.label.startswith("synthea:"))


def test_every_reader_key_case_is_a_target() -> None:
    wanted = {(c.kind, c.text) for c in llm_verify.reader_answer_key()}
    have = {(t.kind, t.text) for t in rec.collect(synthea=False)}
    assert wanted <= have


def test_demo_note_equals_the_text_in_docs_demo_md() -> None:
    demo = (REPO / "docs" / "DEMO.md").read_text(encoding="utf-8")
    quoted = re.findall(r"^\s*>\s*(Clinic follow-up, cycle 4 day 1\..*)$", demo, re.MULTILINE)
    assert quoted, "the DEMO.md hypothyroidism note was not found"
    assert quoted[0].strip() == rec.DEMO_HYPO_NOTE


def test_dry_run_lists_without_a_key_or_network(
    capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    code = rec.main(["--dry-run", "--cache-dir", str(tmp_path)])
    out = capsys.readouterr().out
    assert code == 0
    assert "would record seed:N1" in out and "would record demo:hypothyroidism" in out
    assert not (tmp_path / "gemini_reader.json").exists()


def test_without_a_key_nothing_is_recorded_and_exit_is_2(
    capsys: pytest.CaptureFixture[str], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Make sure no developer .env key leaks into this test.
    monkeypatch.setattr(
        importlib.import_module("interim_api.readers.config"), "_dotenv_values", dict
    )
    code = rec.main(["--cache-dir", str(tmp_path)])
    captured = capsys.readouterr()
    assert code == 2 and "GEMINI_API_KEY" in captured.err
    assert not (tmp_path / "gemini_reader.json").exists()


def test_records_every_missing_text_then_skips_cached_ones(
    capsys: pytest.CaptureFixture[str], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", KEY)
    calls: list[str] = []
    transport = fake_gemini(calls)
    wanted = len(rec.collect(synthea=False))
    code = rec.main(["--cache-dir", str(tmp_path), "--pause", "0"], transport=transport)
    out = capsys.readouterr().out
    assert code == 0 and f"recorded {wanted}, failed 0" in out
    assert len(calls) == wanted
    store = cache_mod.ReaderCache(tmp_path / "gemini_reader.json")
    assert len(store) == wanted
    for target in rec.collect(synthea=False):
        assert store.get(cache_mod.cache_key(reader.PROMPT_VERSION, target.kind, target.text))
    # Counts only: neither the key nor any note text is printed, and the file has no key.
    assert KEY not in out and "Imodium" not in out
    assert KEY not in (tmp_path / "gemini_reader.json").read_text(encoding="utf-8")
    # A second run finds everything cached and makes no request.
    calls.clear()
    assert rec.main(["--cache-dir", str(tmp_path), "--pause", "0"], transport=transport) == 0
    assert calls == [] and "nothing to record" in capsys.readouterr().out
    # --force re-records one at a time, and a failing re-record keeps the old answer.
    failing = httpx.MockTransport(lambda _r: httpx.Response(500, json={"error": {"message": "x"}}))
    code = rec.main(["--cache-dir", str(tmp_path), "--pause", "0", "--force"], transport=failing)
    out = capsys.readouterr().out
    assert code == 1 and f"failed {wanted}" in out
    assert len(cache_mod.ReaderCache(tmp_path / "gemini_reader.json")) == wanted


def test_failures_are_reported_and_exit_1(
    capsys: pytest.CaptureFixture[str], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", KEY)
    transport = httpx.MockTransport(
        lambda _r: httpx.Response(400, json={"error": {"message": KEY}})
    )
    code = rec.main(["--cache-dir", str(tmp_path), "--pause", "0"], transport=transport)
    captured = capsys.readouterr()
    assert code == 1 and "FAILED seed:N1" in captured.out
    assert KEY not in captured.out + captured.err


# --------------------------------------------------------------------------------------
# eval_reader.py
# --------------------------------------------------------------------------------------

HYPO_ANSWER = {
    "symptoms": [
        {"quote": "more tired than usual", "term": "Fatigue", "status": "current"},
        {"quote": "Hypothyroidism, grade 2", "term": "Hypothyroidism", "status": "current"},
        {"quote": "Denies diarrhea", "term": "Diarrhea", "status": "negated"},
    ],
    "medications": [
        {"quote": "Started levothyroxine 50 mcg", "name": "levothyroxine", "action": "started"}
    ],
}
STOOLS_ANSWER = {
    "symptoms": [
        {
            "quote": "6 or 7 watery stools a day",
            "term": "Diarrhea",
            "status": "current",
            "count": 7,
            "count_unit": "stools",
        }
    ],
    "medications": [
        {
            "quote": "started Imodium",
            "name": "Imodium",
            "generic": "loperamide",
            "action": "started",
        }
    ],
}


def record_answers(directory: Path, answers: dict[str, dict[str, Any]]) -> None:
    store = cache_mod.ReaderCache(directory / "gemini_reader.json")
    for case in llm_verify.reader_answer_key():
        if case.id in answers:
            store.put(
                cache_mod.cache_key(reader.PROMPT_VERSION, case.kind, case.text),
                model="gemini-3.5-flash",
                prompt_version=reader.PROMPT_VERSION,
                recorded_at="2026-10-11T05:00:00+00:00",
                response=answers[case.id],
            )


def test_missing_answers_are_reported_as_not_recorded_never_scored(tmp_path: Path) -> None:
    doc, problems, unrecorded = evr.build(tmp_path)
    assert problems == [] and unrecorded == 2
    assert doc.count("not recorded yet") >= 10
    assert "smoke test, not an accuracy estimate" in doc
    assert "N-HYPO" in doc and "C-STOOLS" in doc


def test_scanner_only_side_matches_the_keys_own_flags(tmp_path: Path) -> None:
    # If this fails, the answer key's scanner_finds flags are wrong (or the scanner regressed).
    _doc, problems, _n = evr.build(tmp_path)
    assert problems == []


def test_recorded_answers_add_what_the_scanner_misses(tmp_path: Path) -> None:
    record_answers(tmp_path, {"N-HYPO": HYPO_ANSWER, "C-STOOLS": STOOLS_ANSWER})
    doc, problems, unrecorded = evr.build(tmp_path)
    assert problems == [] and unrecorded == 0
    assert "not recorded yet" not in doc
    assert "Hypothyroidism (found by Gemini)" in doc
    assert "Rejected by the quote check: none" in doc
    # Scanner alone found 2 of 3 expected side effects; with the reader, 3 of 3.
    assert "| Expected side effects found | 2/3 (67%) | 3/3 (100%) |" in doc
    assert "| Negated terms wrongly kept as side effects (want 0) | 0 | 0 |" in doc
    # The negated mention is listed, not kept.
    assert "Diarrhea (negated): Denies diarrhea" in doc


def test_a_hallucinated_quote_is_rejected_and_shown(tmp_path: Path) -> None:
    bad = {
        "symptoms": [{"quote": "Pt has severe colitis", "term": "Colitis", "status": "current"}],
        "medications": [],
    }
    record_answers(tmp_path, {"N-HYPO": bad})
    doc, _problems, unrecorded = evr.build(tmp_path)
    assert unrecorded == 1  # C-STOOLS still has no answer
    assert "`Pt has severe colitis`: the quote is not in the text word for word" in doc


def test_document_is_deterministic_and_check_mode_works(tmp_path: Path) -> None:
    out = tmp_path / "reader_results.md"
    cache_dir = tmp_path / "cache"
    record_answers(cache_dir, {"N-HYPO": HYPO_ANSWER})
    assert evr.main(["--out", str(out), "--cache-dir", str(cache_dir)]) == 0
    assert evr.main(["--out", str(out), "--cache-dir", str(cache_dir), "--check"]) == 0
    record_answers(cache_dir, {"C-STOOLS": STOOLS_ANSWER})
    assert evr.main(["--out", str(out), "--cache-dir", str(cache_dir), "--check"]) == 1
    assert evr.main(["--out", str(out), "--cache-dir", str(cache_dir), "--strict-reader"]) == 0
    empty = tmp_path / "empty"
    assert evr.main(["--out", str(out), "--cache-dir", str(empty), "--strict-reader"]) == 2


def test_committed_results_file_is_current() -> None:
    committed = REPO / "docs" / "eval" / "reader_results.md"
    assert committed.is_file()
    assert evr.main(["--out", str(committed), "--check"]) == 0
