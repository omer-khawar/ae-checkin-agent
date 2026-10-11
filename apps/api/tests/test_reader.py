"""The Gemini second reader (CONTRACTS.md R5.3): transport, cache, verification, wiring.

Gemini reads, rules decide, people confirm. Nothing here touches the network: the transport
is ``httpx.MockTransport`` and the cache lives in ``tmp_path``. Layers:

* ``gemini_reader.read`` with a fake transport: live answer, cache hit / miss / write, replay
  and off modes, a 404 that falls back to the newest stable flash model, a timeout, garbage,
  an HTTP error whose body echoes the key (it must never reach a reason), and the pytest guard;
* ``apply_reader`` (the verification gate): a quote that is not in the text, a negated finding,
  ``UNMAPPED``, a count that is not in the quote, additive merge, grades from rules;
* the routes: ``POST /scan`` and ``POST /notes`` with a recorded answer replayed through the
  real code path, phone calls read as ``call``, and the reader called OUTSIDE the write lock.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import date
from pathlib import Path
from typing import Any

import httpx
import pytest
from conftest import login
from fastapi.testclient import TestClient

from interim_api.readers import ReaderConfig, apply_reader, gemini_reader
from interim_api.readers.cache import ReaderCache, cache_key
from interim_rules import chartscan

KEY = "AIza-test-key-not-a-real-secret"
BASE = "https://gemini.test"
HYPO_TEXT = (
    "Clinic follow-up. Pt reports fatigue. Denies diarrhea. No rash. TSH 18.2, free T4 low. "
    "Assessment: Hypothyroidism, grade 2, likely immune-related. "
    "Started levothyroxine 50 mcg daily. Continue cemiplimab."
)
HYPO_ANSWER: dict[str, Any] = {
    "symptoms": [
        {"quote": "fatigue", "term": "Fatigue", "status": "current"},
        {"quote": "Hypothyroidism, grade 2", "term": "Hypothyroidism", "status": "current"},
        {"quote": "Denies diarrhea", "term": "Diarrhea", "status": "negated"},
    ],
    "medications": [
        {
            "quote": "Started levothyroxine 50 mcg daily",
            "name": "levothyroxine",
            "generic": "levothyroxine",
            "action": "started",
        }
    ],
}


@pytest.fixture(autouse=True)
def _fresh_discovery() -> Iterator[None]:
    gemini_reader._DISCOVERED.clear()
    yield
    gemini_reader._DISCOVERED.clear()


def cfg(tmp_path: Path, **over: Any) -> ReaderConfig:
    values: dict[str, Any] = {
        "mode": "auto",
        "api_key": KEY,
        "model": "gemini-3.5-flash",
        "timeout_s": 2.0,
        "cache_dir": tmp_path,
        "base_url": BASE,
    }
    values.update(over)
    return ReaderConfig(**values)


def answer_response(answer: Any, *, finish: str = "STOP") -> httpx.Response:
    text = answer if isinstance(answer, str) else json.dumps(answer)
    body = {"candidates": [{"content": {"parts": [{"text": text}]}, "finishReason": finish}]}
    return httpx.Response(200, json=body)


class Fake:
    """A ``MockTransport`` handler that records every request."""

    def __init__(self, handler: Callable[[httpx.Request], httpx.Response]) -> None:
        self.handler = handler
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.handler(request)

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)


def ok(answer: Any = HYPO_ANSWER) -> Fake:
    return Fake(lambda _req: answer_response(answer))


# ---------------------------------------------------------------- transport: live


def test_live_answer_is_returned_and_recorded(tmp_path: Path) -> None:
    fake = ok()
    out = gemini_reader.read(
        HYPO_TEXT,
        kind="note",
        note_date=date(2026, 10, 10),
        config=cfg(tmp_path),
        transport=fake.transport,
    )
    assert out.status == "live" and out.usable and not out.cached
    assert out.model == "gemini-3.5-flash"
    assert out.raw is not None and len(out.raw["symptoms"]) == 3
    # One POST to the model's generateContent, key in the header only, JSON mode, temperature 0.
    [req] = fake.requests
    assert req.method == "POST"
    assert req.url.path == "/v1beta/models/gemini-3.5-flash:generateContent"
    assert req.headers["x-goog-api-key"] == KEY
    assert KEY not in str(req.url)
    body = json.loads(req.content)
    assert body["generationConfig"]["temperature"] == 0
    assert body["generationConfig"]["responseMimeType"] == "application/json"
    assert "responseSchema" in body["generationConfig"]
    assert HYPO_TEXT in json.dumps(body)
    # Recorded under the contract's key, without the API key anywhere in the file.
    key = cache_key(gemini_reader.PROMPT_VERSION, "note", HYPO_TEXT)
    entry = ReaderCache(tmp_path / "gemini_reader.json").get(key)
    assert entry is not None and entry.model == "gemini-3.5-flash"
    assert entry.prompt_version == gemini_reader.PROMPT_VERSION
    assert KEY not in (tmp_path / "gemini_reader.json").read_text(encoding="utf-8")


def test_second_call_is_a_cache_hit_with_no_request(tmp_path: Path) -> None:
    fake = ok()
    c = cfg(tmp_path)
    first = gemini_reader.read(HYPO_TEXT, kind="note", config=c, transport=fake.transport)
    again = gemini_reader.read(HYPO_TEXT, kind="note", config=c, transport=fake.transport)
    assert first.status == "live" and again.status == "cache" and again.cached
    assert again.raw == first.raw and again.model == "gemini-3.5-flash"
    assert len(fake.requests) == 1


def test_cache_key_depends_on_kind_and_text(tmp_path: Path) -> None:
    fake = ok()
    c = cfg(tmp_path)
    gemini_reader.read("tired", kind="note", config=c, transport=fake.transport)
    other_kind = gemini_reader.read("tired", kind="call", config=c, transport=fake.transport)
    other_text = gemini_reader.read("tired.", kind="note", config=c, transport=fake.transport)
    assert other_kind.status == "live" and other_text.status == "live"
    assert len(fake.requests) == 3
    assert cache_key("v", "note", "x") == cache_key("v", "note", "x")
    assert cache_key("v", "note", "x") != cache_key("v", "call", "x")
    assert cache_key("v", "note", "x") != cache_key("w", "note", "x")


def test_replay_never_calls_the_network(tmp_path: Path) -> None:
    fake = ok()
    miss = gemini_reader.read(
        HYPO_TEXT, kind="note", config=cfg(tmp_path, mode="replay"), transport=fake.transport
    )
    assert miss.status == "off" and "replay" in (miss.reason or "")
    assert fake.requests == []
    ReaderCache(tmp_path / "gemini_reader.json").put(
        cache_key(gemini_reader.PROMPT_VERSION, "note", HYPO_TEXT),
        model="gemini-3.5-flash",
        prompt_version=gemini_reader.PROMPT_VERSION,
        recorded_at="2026-10-11T05:00:00+00:00",
        response=HYPO_ANSWER,
    )
    hit = gemini_reader.read(
        HYPO_TEXT,
        kind="note",
        config=cfg(tmp_path, mode="replay", api_key=""),
        transport=fake.transport,
    )
    assert hit.status == "cache" and hit.usable
    assert fake.requests == []


def test_off_mode_and_missing_key_are_off_not_errors(tmp_path: Path) -> None:
    fake = ok()
    off = gemini_reader.read(
        HYPO_TEXT, kind="note", config=cfg(tmp_path, mode="off"), transport=fake.transport
    )
    no_key = gemini_reader.read(
        HYPO_TEXT, kind="note", config=cfg(tmp_path, api_key=""), transport=fake.transport
    )
    blank = gemini_reader.read("   ", kind="note", config=cfg(tmp_path), transport=fake.transport)
    huge = gemini_reader.read(
        "x" * (gemini_reader.MAX_TEXT_CHARS + 1),
        kind="note",
        config=cfg(tmp_path),
        transport=fake.transport,
    )
    for result in (off, no_key, blank, huge):
        assert result.status == "off" and not result.usable and result.reason
    assert fake.requests == []


def test_no_network_under_pytest_without_a_transport(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*_a: Any, **_k: Any) -> None:
        raise AssertionError("the reader tried to open an HTTP client")

    monkeypatch.setattr(httpx, "Client", boom)
    out = gemini_reader.read("Fatigue noted.", kind="note", config=cfg(tmp_path))
    assert out.status == "off" and "pytest" in (out.reason or "")


def test_config_is_hermetic_under_pytest(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("INTERIM_LLM_MODE", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    assert ReaderConfig.from_env().mode == "off"  # the repo .env is not read under pytest
    assert ReaderConfig.from_env().api_key == ""
    monkeypatch.setenv("INTERIM_LLM_MODE", "replay")
    assert ReaderConfig.from_env().mode == "replay"


def test_config_defaults_and_environment() -> None:
    default = ReaderConfig.from_env({})
    assert default.model == "gemini-3.5-flash"
    assert default.timeout_s == 25.0
    assert default.mode == "auto" and default.api_key == ""
    custom = ReaderConfig.from_env(
        {
            "INTERIM_GEMINI_MODEL": "gemini-9-flash",
            "INTERIM_GEMINI_TIMEOUT_S": "7",
            "INTERIM_LLM_MODE": "REPLAY",
            "GEMINI_API_KEY": f" {KEY} ",
            "LLM_CACHE_DIR": "/somewhere",
        }
    )
    assert (custom.model, custom.timeout_s, custom.mode) == ("gemini-9-flash", 7.0, "replay")
    assert custom.api_key == KEY and custom.cache_dir == Path("/somewhere")
    assert ReaderConfig.from_env({"INTERIM_GEMINI_TIMEOUT_S": "nope"}).timeout_s == 25.0
    assert ReaderConfig.from_env({"INTERIM_LLM_MODE": "weird"}).mode == "auto"
    assert KEY not in repr(custom)  # the key never shows up in a repr or a log line


# ---------------------------------------------------------------- transport: failures


def test_404_falls_back_to_the_highest_stable_flash_model(tmp_path: Path) -> None:
    listing = {
        "models": [
            {"name": "models/gemini-2.0-flash", "supportedGenerationMethods": ["generateContent"]},
            {"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]},
            {
                "name": "models/gemini-2.5-flash-lite",
                "supportedGenerationMethods": ["generateContent"],
            },
            {
                "name": "models/gemini-3-flash-preview",
                "supportedGenerationMethods": ["generateContent"],
            },
            {
                "name": "models/gemini-2.5-flash-image",
                "supportedGenerationMethods": ["generateContent"],
            },
            {
                "name": "models/gemini-2.5-flash-preview-tts",
                "supportedGenerationMethods": ["generateContent"],
            },
            {
                "name": "models/gemini-flash-latest",
                "supportedGenerationMethods": ["generateContent"],
            },
            {
                "name": "models/gemini-3.1-flash-omni",
                "supportedGenerationMethods": ["generateContent"],
            },
            {"name": "models/gemini-2.9-flash", "supportedGenerationMethods": ["embedContent"]},
        ]
    }

    def handler(req: httpx.Request) -> httpx.Response:
        if req.method == "GET":
            return httpx.Response(200, json=listing)
        if req.url.path.endswith("gemini-3.5-flash:generateContent"):
            return httpx.Response(404, json={"error": {"message": "no longer available"}})
        return answer_response(HYPO_ANSWER)

    fake = Fake(handler)
    out = gemini_reader.read(HYPO_TEXT, kind="note", config=cfg(tmp_path), transport=fake.transport)
    assert out.status == "live" and out.model == "gemini-2.5-flash"
    assert "404" in (out.reason or "") and "gemini-2.5-flash" in (out.reason or "")
    paths = [(r.method, r.url.path) for r in fake.requests]
    assert paths == [
        ("POST", "/v1beta/models/gemini-3.5-flash:generateContent"),
        ("GET", "/v1beta/models"),
        ("POST", "/v1beta/models/gemini-2.5-flash:generateContent"),
    ]
    # The model list is read once per process, not once per request.
    gemini_reader.read("other text", kind="note", config=cfg(tmp_path), transport=fake.transport)
    assert sum(1 for r in fake.requests if r.method == "GET") == 1


def test_newest_flash_model_skips_unstable_variants() -> None:
    pick = gemini_reader.newest_flash_model
    assert pick([]) is None
    assert (
        pick([{"name": "models/gemini-2.5-flash-lite"}, {"name": "models/gemini-3-flash-preview"}])
        is None
    )
    assert (
        pick([{"name": "models/gemini-2.5-flash"}, {"name": "models/gemini-3-flash"}])
        == "gemini-3-flash"
    )
    assert (
        pick([{"name": "models/gemini-3.5-flash"}, {"name": "models/gemini-3-flash"}])
        == "gemini-3.5-flash"
    )
    assert (
        pick([{"name": "models/gemini-10-flash"}, {"name": "models/gemini-9-flash"}])
        == "gemini-10-flash"
    )
    assert pick(["junk", {"name": 5}, {"name": "models/gemini-2.5-flash-omni"}]) is None


def test_404_with_no_usable_model_is_a_clear_error(tmp_path: Path) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        if req.method == "GET":
            return httpx.Response(200, json={"models": []})
        return httpx.Response(404, json={"error": {"message": "no longer available to new users"}})

    out = gemini_reader.read(
        HYPO_TEXT, kind="note", config=cfg(tmp_path), transport=Fake(handler).transport
    )
    assert out.status == "error" and "404" in (out.reason or "")
    assert not out.usable and out.raw is None
    assert (
        ReaderCache(tmp_path / "gemini_reader.json").get(
            cache_key(gemini_reader.PROMPT_VERSION, "note", HYPO_TEXT)
        )
        is None
    )


def test_timeout_is_an_error_result_not_an_exception(tmp_path: Path) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=req)

    out = gemini_reader.read(
        HYPO_TEXT, kind="note", config=cfg(tmp_path), transport=Fake(handler).transport
    )
    assert out.status == "error" and "within 2 s" in (out.reason or "")
    assert not (tmp_path / "gemini_reader.json").exists()  # a failure is never recorded


def test_connection_failure_is_an_error_result(tmp_path: Path) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=req)

    out = gemini_reader.read(
        HYPO_TEXT, kind="note", config=cfg(tmp_path), transport=Fake(handler).transport
    )
    assert out.status == "error" and "could not be reached" in (out.reason or "")


@pytest.mark.parametrize(
    ("response", "expect"),
    [
        (answer_response("this is not json {"), "not valid JSON"),
        (answer_response("[1, 2, 3]"), "expected shape"),
        (answer_response('{"unrelated": true}'), "expected shape"),
        (answer_response("x" * (gemini_reader.MAX_ANSWER_CHARS + 1)), "too long"),
        (httpx.Response(200, json={"candidates": []}), "no answer"),
        (httpx.Response(200, json={"promptFeedback": {"blockReason": "SAFETY"}}), "SAFETY"),
        (httpx.Response(200, json={"candidates": [{"finishReason": "MAX_TOKENS"}]}), "no text"),
        (httpx.Response(200, content=b"<html>proxy page</html>"), "no answer"),
        (httpx.Response(500, json={"error": {"message": "backend down"}}), "HTTP 500"),
        (httpx.Response(429, text="slow down"), "HTTP 429"),
    ],
)
def test_garbage_and_http_errors_fall_back(
    tmp_path: Path, response: httpx.Response, expect: str
) -> None:
    out = gemini_reader.read(
        HYPO_TEXT, kind="note", config=cfg(tmp_path), transport=Fake(lambda _r: response).transport
    )
    assert out.status == "error" and expect in (out.reason or "")
    assert out.raw is None and not out.usable
    assert not (tmp_path / "gemini_reader.json").exists()
    # The caller carries on with the scanner alone.
    outcome = apply_reader(HYPO_TEXT, chartscan.scan_text(HYPO_TEXT), out)
    assert outcome.result == chartscan.scan_text(HYPO_TEXT) and not outcome.used
    assert outcome.info["status"] == "error"


def test_the_api_key_never_reaches_a_reason(tmp_path: Path) -> None:
    echo = httpx.Response(
        400, json={"error": {"message": f"API key not valid: {KEY}. Pass a valid key."}}
    )
    out = gemini_reader.read(
        HYPO_TEXT, kind="note", config=cfg(tmp_path), transport=Fake(lambda _r: echo).transport
    )
    assert out.status == "error" and "HTTP 400" in (out.reason or "")
    assert KEY not in (out.reason or "") and "***" in (out.reason or "")
    assert KEY not in json.dumps(out.info())


def test_answer_with_only_one_list_is_accepted(tmp_path: Path) -> None:
    out = gemini_reader.read(
        "Started aspirin.",
        kind="note",
        config=cfg(tmp_path),
        transport=ok(
            {"medications": [{"quote": "Started aspirin", "name": "aspirin", "action": "started"}]}
        ).transport,
    )
    assert out.status == "live" and out.raw is not None and out.raw["symptoms"] == []


def test_request_body_carries_the_vocabulary_and_the_no_judgement_rule() -> None:
    body = gemini_reader.request_body("Fever since Tuesday.", "call")
    system = body["systemInstruction"]["parts"][0]["text"]
    assert "Hypothyroidism" in system and "Diarrhea" in system and "UNMAPPED" in system
    assert "do not" in system.lower() or "not grade" in system.lower() or "do not\ngrade" in system
    assert "phone-call summary" in body["contents"][0]["parts"][0]["text"]
    assert (
        "chart note" in gemini_reader.request_body("x", "note")["contents"][0]["parts"][0]["text"]
    )


# ---------------------------------------------------------------- verification gate


def live(answer: dict[str, Any]) -> gemini_reader.ReaderResult:
    return gemini_reader.ReaderResult("live", "gemini-3.5-flash", None, answer)


def run(text: str, answer: dict[str, Any]):
    return apply_reader(text, chartscan.scan_text(text), live(answer))


def test_a_verified_finding_is_added_with_a_rules_grade() -> None:
    scan = chartscan.scan_text(HYPO_TEXT)
    assert "Hypothyroidism" not in {s.term for s in scan.symptoms}  # the scanner misses it
    out = run(HYPO_TEXT, HYPO_ANSWER)
    by_term = {s.term: s for s in out.result.symptoms}
    assert by_term["Hypothyroidism"].grade_hint == 2  # read by rules from "grade 2" in the quote
    assert (
        HYPO_TEXT[by_term["Hypothyroidism"].span_start : by_term["Hypothyroidism"].span_end]
        == by_term["Hypothyroidism"].quote
    )
    assert out.symptom_found_by("Hypothyroidism") == "gemini"
    assert out.symptom_found_by("Fatigue") in ("both", "scanner")
    assert out.used and out.reader_meta() == {
        "model": "gemini-3.5-flash",
        "prompt_version": gemini_reader.PROMPT_VERSION,
        "cached": False,
    }
    assert any(r["rule_id"] == "chartscan.gemini_symptom" for r in out.reader_rules())


def test_merge_is_additive_scanner_findings_are_untouched() -> None:
    scan = chartscan.scan_text(HYPO_TEXT)
    out = run(HYPO_TEXT, HYPO_ANSWER)
    for finding in scan.symptoms:
        assert finding in out.result.symptoms
    for med in scan.meds:
        assert med in out.result.meds
    assert out.result.red_flags == scan.red_flags
    assert out.result.excluded_symptoms == scan.excluded_symptoms


def test_quote_not_in_the_text_is_rejected_with_a_reason() -> None:
    answer = {
        "symptoms": [
            {"quote": "severe thyroid storm", "term": "Hypothyroidism", "status": "current"}
        ],
        "medications": [
            {"quote": "started prednisone 40 mg", "name": "prednisone", "action": "started"}
        ],
    }
    out = run(HYPO_TEXT, answer)
    assert "Hypothyroidism" not in {s.term for s in out.result.symptoms}
    assert "prednisone" not in {m.drug for m in out.result.meds}
    assert {r["label"] for r in out.rejected} == {"Hypothyroidism", "prednisone"}
    assert all("word for word" in r["reason"] for r in out.rejected)
    assert out.counts()["n_added_symptoms"] == 0 and out.counts()["n_rejected"] == 2


def test_negated_hypothetical_and_historical_are_listed_never_drafted() -> None:
    text = (
        "No rash today. Call us if you get a fever. Had nausea last year. Cough is bothering him."
    )
    answer = {
        "symptoms": [
            {"quote": "No rash today", "term": "Rash maculo-papular", "status": "negated"},
            {"quote": "if you get a fever", "term": "Fever", "status": "hypothetical"},
            {"quote": "Had nausea last year", "term": "Nausea", "status": "historical"},
        ],
        "medications": [],
    }
    out = run(text, answer)
    # Whatever the scanner kept on its own is unchanged; the reader added no draft.
    assert out.result.symptoms == chartscan.scan_text(text).symptoms
    assert out.counts()["n_added_symptoms"] == 0
    assert not {s.term for s in out.result.symptoms if out.symptom_found_by(s.term) == "gemini"}
    assert {n["status"] for n in out.notes} == {"negated", "hypothetical", "historical"}
    assert out.rejected == []


def test_unmapped_term_is_rejected() -> None:
    text = "He reports a strange metallic taste after infusions."
    out = run(
        text,
        {
            "symptoms": [
                {"quote": "strange metallic taste", "term": "UNMAPPED", "status": "current"}
            ],
            "medications": [],
        },
    )
    assert out.result.symptoms == () or all(s.term != "UNMAPPED" for s in out.result.symptoms)
    [rejected] = out.rejected
    assert "UNMAPPED" in rejected["reason"] and "vocabulary" in rejected["reason"]
    out2 = run(
        text,
        {
            "symptoms": [
                {"quote": "strange metallic taste", "term": "Dysgeusia-ish", "status": "current"}
            ],
            "medications": [],
        },
    )
    assert out2.rejected and "closed vocabulary" in out2.rejected[0]["reason"]


def test_count_not_in_the_quote_is_rejected_and_one_in_the_quote_grades_by_rules() -> None:
    text = "Per caregiver he had 7 BMs yesterday and again today."
    bad = run(
        text,
        {
            "symptoms": [
                {
                    "quote": "he had BMs yesterday",
                    "term": "Diarrhea",
                    "status": "current",
                    "count": 7,
                }
            ],
            "medications": [],
        },
    )
    assert "Diarrhea" not in {s.term for s in bad.result.symptoms}
    assert any(
        "does not appear as digits" in r["reason"] or "quote is not in the text" in r["reason"]
        for r in bad.rejected
    )
    wrong = run(
        text,
        {
            "symptoms": [
                {
                    "quote": "he had 7 BMs yesterday",
                    "term": "Diarrhea",
                    "status": "current",
                    "count": 9,
                }
            ],
            "medications": [],
        },
    )
    assert "Diarrhea" not in {s.term for s in wrong.result.symptoms}
    assert any("count 9" in r["reason"] for r in wrong.rejected)
    good = run(
        text,
        {
            "symptoms": [
                {
                    "quote": "he had 7 BMs yesterday",
                    "term": "Diarrhea",
                    "status": "current",
                    "count": 7,
                    "count_unit": "stools",
                }
            ],
            "medications": [],
        },
    )
    [finding] = [s for s in good.result.symptoms if s.term == "Diarrhea"]
    assert finding.grade_hint == 3  # the existing stool-count band (7 or more per day), by rules


def test_medication_name_must_appear_in_its_quote() -> None:
    text = "She started Imodium on Friday."
    out = run(
        text,
        {
            "symptoms": [],
            "medications": [
                {"quote": "started Imodium on Friday", "name": "loperamide", "action": "started"}
            ],
        },
    )
    assert out.result.meds == chartscan.scan_text(text).meds  # name not in quote: nothing added
    assert out.rejected and out.rejected[0]["label"] == "loperamide"


def test_off_reader_gives_exactly_the_scanner_result() -> None:
    scan = chartscan.scan_text(HYPO_TEXT)
    for reader in (None, gemini_reader.off("no key")):
        out = apply_reader(HYPO_TEXT, scan, reader)
        assert out.result is scan and not out.used
        assert out.symptom_found_by("Fatigue") == "scanner"
        assert out.reader_meta() is None and out.reader_rules() == []
    assert apply_reader(HYPO_TEXT, scan, gemini_reader.off("x")).info["status"] == "off"


def test_reader_answers_cannot_carry_a_grade_or_a_tier() -> None:
    answer = {
        "symptoms": [
            {
                "quote": "Hypothyroidism, grade 2",
                "term": "Hypothyroidism",
                "status": "current",
                "grade": 4,
                "tier": 3,
                "serious": True,
            }
        ],
        "medications": [],
    }
    out = run(HYPO_TEXT, answer)
    [finding] = [s for s in out.result.symptoms if s.term == "Hypothyroidism"]
    assert (
        finding.grade_hint == 2
    )  # the rules read "grade 2" from the quote; the model's 4 is ignored
    assert out.result.red_flags == chartscan.scan_text(HYPO_TEXT).red_flags


# ---------------------------------------------------------------- the routes


@pytest.fixture
def replay(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Reader in replay mode over a temp cache (the real config path, no monkeypatched read)."""
    monkeypatch.setenv("INTERIM_LLM_MODE", "replay")
    monkeypatch.setenv("LLM_CACHE_DIR", str(tmp_path))
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    return tmp_path


def record(cache_dir: Path, kind: str, text: str, answer: dict[str, Any] = HYPO_ANSWER) -> None:
    ReaderCache(cache_dir / "gemini_reader.json").put(
        cache_key(gemini_reader.PROMPT_VERSION, kind, text),
        model="gemini-3.5-flash",
        prompt_version=gemini_reader.PROMPT_VERSION,
        recorded_at="2026-10-11T05:00:00+00:00",
        response=answer,
    )


def test_scan_route_replays_a_recorded_answer(client: TestClient, replay: Path) -> None:
    record(replay, "note", HYPO_TEXT)
    res = client.post(
        "/api/v1/scan",
        json={"text": HYPO_TEXT, "ref_date": "2026-10-10"},
        headers=login(client, "coordinator"),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["reader"] == {
        "status": "cache",
        "model": "gemini-3.5-flash",
        "cached": True,
        "reason": None,
    }
    by_term = {s["term"]: s for s in body["symptoms"]}
    assert by_term["Hypothyroidism"]["found_by"] == "gemini"
    assert by_term["Hypothyroidism"]["grade_hint"] == 2
    assert body["symptoms"][0]["found_by"] in ("scanner", "both")
    assert [m["found_by"] for m in body["meds"]] and all(
        m["found_by"] in ("scanner", "both", "gemini") for m in body["meds"]
    )
    assert body["reader_rejected"] == []
    # The negated mention is listed, not drafted.
    assert "Diarrhea" not in by_term
    assert any(n["status"] == "negated" for n in body["reader_notes"])


def test_scan_route_without_a_recorded_answer_is_scanner_only(
    client: TestClient, replay: Path
) -> None:
    res = client.post(
        "/api/v1/scan",
        json={"text": HYPO_TEXT, "ref_date": "2026-10-10"},
        headers=login(client, "coordinator"),
    )
    body = res.json()
    assert body["reader"]["status"] == "off" and body["reader"]["cached"] is False
    assert body["reader"]["reason"]
    assert "Hypothyroidism" not in {s["term"] for s in body["symptoms"]}
    assert all(s["found_by"] == "scanner" for s in body["symptoms"])


def test_note_route_drafts_the_reader_finding_with_evidence_and_audit(
    client: TestClient, replay: Path
) -> None:
    record(replay, "note", HYPO_TEXT)
    headers = login(client, "coordinator")
    from conftest import add_participant

    usubjid = add_participant(client, "P-021")
    res = client.post(
        "/api/v1/notes",
        json={
            "usubjid": usubjid,
            "note_date": "2026-10-10",
            "author": "J. Rivera, NP",
            "note_type": "progress_note",
            "text": HYPO_TEXT,
        },
        headers=headers,
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["reader"]["status"] == "cache"
    ae = {d["fields"]["AEDECOD"]: d for d in body["drafts"] if d["domain"] == "AE"}
    assert "Hypothyroidism" in ae and ae["Hypothyroidism"]["fields"]["AETOXGR"] == 2
    hypo = ae["Hypothyroidism"]
    assert "chartscan.gemini_symptom" in hypo["fields"]["INTERIM_RULES_FIRED"]
    evidence = json.dumps(hypo["evidence"])
    assert '"found_by": "gemini"' in evidence and "prompt_version" in evidence
    # Same note again through the detail endpoint: the reader block is stored with the note.
    detail = client.get(f"/api/v1/notes/{body['note']['id']}", headers=headers).json()
    assert detail["reader"]["status"] == "cache" and detail["reader_rejected"] == []
    audit = client.get("/api/v1/audit?limit=500", headers=headers).json()["items"]
    reads = [e for e in audit if e["action"] == "llm.read"]
    assert len(reads) == 1
    payload = reads[0]["payload"]
    assert (
        payload["reader"] == "gemini" and payload["kind"] == "note" and payload["status"] == "cache"
    )
    assert payload["model"] == "gemini-3.5-flash"
    assert KEY not in json.dumps(audit)
    # A reader-only finding never pages and never raises the note above tier 2 (D-017).
    assert body["escalation"] is None or body["escalation"]["tier"] <= 2


def test_note_route_with_no_reader_has_no_llm_read_event(client: TestClient, replay: Path) -> None:
    from conftest import add_participant

    headers = login(client, "coordinator")
    usubjid = add_participant(client, "P-022")
    res = client.post(
        "/api/v1/notes",
        json={
            "usubjid": usubjid,
            "note_date": "2026-10-10",
            "author": "RN",
            "note_type": "progress_note",
            "text": HYPO_TEXT,
        },
        headers=headers,
    )
    assert res.status_code == 201
    assert res.json()["reader"]["status"] == "off"
    audit = client.get("/api/v1/audit?limit=500", headers=headers).json()["items"]
    assert not [e for e in audit if e["action"] == "llm.read"]


def test_phone_calls_are_read_as_calls_and_notes_as_notes(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from conftest import add_participant

    from interim_api.routers import notes as notes_router

    kinds: list[str] = []

    def fake_read(
        text: str, *, kind: str, note_date: date | None = None, **_k: Any
    ) -> gemini_reader.ReaderResult:
        kinds.append(kind)
        return gemini_reader.off("test")

    monkeypatch.setattr(notes_router.gemini_reader, "read", fake_read)
    headers = login(client, "coordinator")
    usubjid = add_participant(client, "P-023")
    base = {
        "usubjid": usubjid,
        "note_date": "2026-10-10",
        "author": "RN",
        "text": "6 or 7 watery stools a day since Friday, started Imodium",
    }
    call = client.post(
        "/api/v1/notes",
        json={
            **base,
            "note_type": "phone_call",
            "caller": "participant",
            "call_direction": "inbound",
        },
        headers=headers,
    )
    note = client.post(
        "/api/v1/notes",
        json={**base, "usubjid": add_participant(client, "P-026"), "note_type": "progress_note"},
        headers=headers,
    )
    scan = client.post("/api/v1/scan", json={"text": base["text"]}, headers=headers)
    assert call.status_code == 201 and note.status_code == 201 and scan.status_code == 200
    assert kinds == ["call", "note", "note"]
    assert call.json()["note"]["is_phone_call"] is True
    # The stool-count fix: the scanner alone grades this diarrhea 3 and finds loperamide.
    ae = {
        d["fields"]["AEDECOD"]: d["fields"]["AETOXGR"]
        for d in call.json()["drafts"]
        if d["domain"] == "AE"
    }
    assert ae["Diarrhea"] == 3
    assert "loperamide" in json.dumps(call.json()["drafts"])


def test_the_reader_is_called_before_the_write_lock_is_taken(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from conftest import add_participant

    from interim_api.routers import notes as notes_router

    database = client.app.state.database  # type: ignore[attr-defined]
    original = database.write_scope
    depth = {"now": 0}

    @contextmanager
    def tracked() -> Iterator[Any]:
        with original() as session:
            depth["now"] += 1
            try:
                yield session
            finally:
                depth["now"] -= 1

    seen: list[int] = []

    def fake_read(
        text: str, *, kind: str, note_date: date | None = None, **_k: Any
    ) -> gemini_reader.ReaderResult:
        seen.append(depth["now"])
        return live(HYPO_ANSWER)

    monkeypatch.setattr(database, "write_scope", tracked)
    monkeypatch.setattr(notes_router.gemini_reader, "read", fake_read)
    headers = login(client, "coordinator")
    usubjid = add_participant(client, "P-024")
    entered_before = depth["now"]
    res = client.post(
        "/api/v1/notes",
        json={
            "usubjid": usubjid,
            "note_date": "2026-10-10",
            "author": "RN",
            "note_type": "progress_note",
            "text": HYPO_TEXT,
        },
        headers=headers,
    )
    assert res.status_code == 201, res.text
    assert seen == [0], "the model call must happen outside database.write_scope()"
    assert entered_before == 0 and depth["now"] == 0
    assert res.json()["reader"]["status"] == "live"
    assert any(
        d["fields"]["AEDECOD"] == "Hypothyroidism"
        for d in res.json()["drafts"]
        if d["domain"] == "AE"
    )


def test_a_failing_reader_never_fails_the_request(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from conftest import add_participant

    def failing(
        text: str, *, kind: str, note_date: date | None = None, **_k: Any
    ) -> gemini_reader.ReaderResult:
        return gemini_reader.ReaderResult(
            "error", "gemini-3.5-flash", "Gemini did not answer within 25 s", None
        )

    from interim_api.routers import notes as notes_router

    monkeypatch.setattr(notes_router.gemini_reader, "read", failing)
    headers = login(client, "coordinator")
    usubjid = add_participant(client, "P-025")
    res = client.post(
        "/api/v1/notes",
        json={
            "usubjid": usubjid,
            "note_date": "2026-10-10",
            "author": "RN",
            "note_type": "progress_note",
            "text": HYPO_TEXT,
        },
        headers=headers,
    )
    assert res.status_code == 201
    body = res.json()
    assert body["reader"]["status"] == "error" and "25 s" in body["reader"]["reason"]
    assert {d["fields"]["AEDECOD"] for d in body["drafts"] if d["domain"] == "AE"} == {"Fatigue"}
    scan = client.post("/api/v1/scan", json={"text": HYPO_TEXT}, headers=headers)
    assert scan.status_code == 200 and scan.json()["reader"]["status"] == "error"


def test_scan_and_notes_still_require_a_login(client: TestClient) -> None:
    assert client.post("/api/v1/scan", json={"text": HYPO_TEXT}).status_code in (401, 403)
    assert client.post("/api/v1/notes", json={"text": HYPO_TEXT}).status_code in (401, 403, 422)
