"""Tests for scripts/build_kiosk_audio.py (no network)."""

from __future__ import annotations

from pathlib import Path

import pytest

import build_kiosk_audio as b


def test_collects_known_strings() -> None:
    strings = b.collect_strings()
    assert len(strings) == len(set(strings))
    prefix = "In the last 7 days, how bad was your shortness of breath"
    assert any(s.startswith(prefix) for s in strings)
    assert "Very severe" in strings
    assert any("call 911" in s for s in strings)
    assert any("admitted to a hospital" in s for s in strings)


def test_hash_is_16_hex() -> None:
    h = b.text_hash("hello")
    assert len(h) == 16 and int(h, 16) >= 0


def test_dry_run_lists(capsys: pytest.CaptureFixture[str]) -> None:
    assert b.main(["--dry-run"]) == 0
    assert "Very severe" in capsys.readouterr().out


def test_no_key_exits_2(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    assert b.main(["--out", str(tmp_path)]) == 2
    assert "ELEVENLABS_API_KEY" in capsys.readouterr().err
