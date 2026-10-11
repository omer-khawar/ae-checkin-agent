"""The optional LLM writer and its fallback (CLAUDE.md §00 "Generated text works with no
API key"; CONTRACTS R3.2 "Writer selection"). Every test uses a fake client: no network."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest
from conftest import ZERO_RESPONSES, add_participant, login, make_settings, run_kiosk_checkin

from interim_api.writers.base import get_writer, writer_status
from interim_api.writers.llm import LlmWriter
from interim_api.writers.template import TemplateWriter
from interim_rules.narrative import validate_written

API = "/api/v1"

FACTS: dict[str, Any] = {
    "kind": "sae",
    "participant": {"value": "P-003", "evidence_ids": ["clock-1"]},
    "event": {"term": "Diarrhea", "plain_label": "diarrhea", "evidence_ids": ["ans-1"]},
    "provisional_grade": {"grade": 3, "evidence_ids": ["grade.provisional.diarrhea"]},
    "deadline": {"due_at": "2026-10-12T08:00:00.000Z", "hours": 24.0, "evidence_ids": ["clock-1"]},
}


class FakeMessages:
    def __init__(self, payload: Any, *, stop_reason: str = "end_turn", error: bool = False):
        self.payload = payload
        self.stop_reason = stop_reason
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if self.error:
            raise RuntimeError("network down")
        text = self.payload if isinstance(self.payload, str) else json.dumps(self.payload)
        return SimpleNamespace(
            stop_reason=self.stop_reason,
            model=kwargs["model"],
            content=[SimpleNamespace(type="text", text=text)],
        )


class FakeClient:
    """Anthropic-shaped fake: ``client.beta.messages.create(**kwargs)``."""

    def __init__(self, payload: Any, **kwargs: Any) -> None:
        self.beta = SimpleNamespace(messages=FakeMessages(payload, **kwargs))


def _good_payload() -> dict[str, Any]:
    return {
        "sentences": [
            {"text": "Participant P-003 reported diarrhea.", "evidence_ids": ["clock-1", "ans-1"]},
            {
                "text": "It was recorded as grade 3 (provisional, investigator to confirm).",
                "evidence_ids": ["grade.provisional.diarrhea"],
            },
        ]
    }


def test_valid_llm_text_is_accepted() -> None:
    client = FakeClient(_good_payload())
    out = LlmWriter(client=client, model="claude-sonnet-5-5").write("sae_narrative", FACTS)
    assert out["writer"] == "llm" and "fallback_reason" not in out
    assert validate_written(out, FACTS) == []
    call = client.beta.messages.calls[0]
    assert call["model"] == "claude-sonnet-5-5"
    assert call["output_config"]["format"]["type"] == "json_schema"
    assert "ans-1" in call["messages"][0]["content"]  # the facts travel with the request


def test_fabricated_evidence_id_is_rejected_and_template_used() -> None:
    payload = _good_payload()
    payload["sentences"][0]["evidence_ids"] = ["made-up-id"]
    out = LlmWriter(client=FakeClient(payload), model="m").write("sae_narrative", FACTS)
    template = TemplateWriter().write("sae_narrative", FACTS)
    assert out["writer"] == "template"
    assert "validate_written" in out["fallback_reason"] and "made-up-id" in out["fallback_reason"]
    assert out["sentences"] == template["sentences"] and out["text"] == template["text"]


@pytest.mark.parametrize(
    ("payload", "kwargs", "reason"),
    [
        ({"sentences": [{"text": "Grade 3.", "evidence_ids": ["ans-1"]}]}, {}, "investigator"),
        ('He said "very bad" was it.', {}, "expected JSON"),
        (_good_payload(), {"stop_reason": "refusal"}, "refusal"),
        (_good_payload(), {"stop_reason": "max_tokens"}, "max_tokens"),
        (_good_payload(), {"error": True}, "RuntimeError"),
    ],
)
def test_every_failure_falls_back_with_a_reason(
    payload: Any, kwargs: dict[str, Any], reason: str
) -> None:
    out = LlmWriter(client=FakeClient(payload, **kwargs), model="m").write("sae_narrative", FACTS)
    assert out["writer"] == "template" and reason in out["fallback_reason"]


def test_writer_selection_never_calls_out_in_tests(tmp_path) -> None:
    plain = make_settings(tmp_path, anthropic_api_key="")
    assert isinstance(get_writer(plain), TemplateWriter)
    assert writer_status(plain)["writer"] == "template"
    keyed = make_settings(tmp_path, anthropic_api_key="sk-test-not-real")
    status = writer_status(keyed)
    assert status["llm_configured"] is True and "sk-test" not in json.dumps(status)
    out = get_writer(keyed).write("sae_narrative", FACTS)  # under pytest: never a real client
    assert out["writer"] == "template" and "tests" in out["fallback_reason"]
    forced = make_settings(tmp_path, anthropic_api_key="sk-test", interim_writer="template")
    assert isinstance(get_writer(forced), TemplateWriter)


@pytest.fixture
def settings(tmp_path):
    return make_settings(tmp_path, anthropic_api_key="", interim_writer="auto")


def _aesi_packet(client, fake: Any) -> dict[str, Any]:
    client.app.state.llm_client = fake
    add_participant(client, "P-003")
    responses = {k: dict(v) for k, v in ZERO_RESPONSES.items()}
    responses["itching"] = {"severity": 3}
    done = run_kiosk_checkin(
        client,
        "P-003",
        responses=responses,
        gates={"hospitalization": False, "conmed_changed": False},
    )
    coord = login(client, "coordinator")
    detail = client.get(f"{API}/checkins/{done['session_id']}", headers=coord).json()
    res = client.post(
        f"{API}/packets", json={"clock_id": detail["aesi_clock"]["id"]}, headers=coord
    )
    assert res.status_code == 201, res.text
    return res.json()


def test_packet_with_fabricating_llm_falls_back_to_template(client) -> None:
    fake = FakeClient(
        {"sentences": [{"text": "The participant had a rash.", "evidence_ids": ["X1"]}]}
    )
    packet = _aesi_packet(client, fake)
    narrative = packet["narrative"]
    assert narrative["writer"] == "template" and "X1" in narrative["fallback_reason"]
    assert packet["writer"] == "template"
    assert fake.beta.messages.calls, "the fake LLM was asked"
    coord = login(client, "coordinator")
    created = client.get(f"{API}/audit?action=packet.created", headers=coord).json()["items"][0]
    assert created["payload"]["fallback_reason"] == narrative["fallback_reason"]
    page = client.get(f"{API}/packets/{packet['id']}/print", headers=coord).text
    assert "Written by template" in page and "Fallback:" in page


class EchoClient:
    """A well-behaved fake LLM: returns the template draft it was sent, as JSON."""

    def __init__(self) -> None:
        self.beta = SimpleNamespace(messages=self)

    def create(self, **kwargs: Any) -> Any:
        content = kwargs["messages"][0]["content"]
        block = content.split("Template draft (JSON sentences):\n", 1)[1].split("\n\n")[0]
        sentences = json.loads(block)
        return SimpleNamespace(
            stop_reason="end_turn",
            model=kwargs["model"],
            content=[SimpleNamespace(type="text", text=json.dumps({"sentences": sentences}))],
        )


def test_packet_with_valid_llm_text_says_written_by_claude(client) -> None:
    packet = _aesi_packet(client, EchoClient())
    assert packet["narrative"]["writer"] == "llm" and packet["writer"] == "llm"
    coord = login(client, "coordinator")
    page = client.get(f"{API}/packets/{packet['id']}/print", headers=coord).text
    assert "Written by Claude" in page
