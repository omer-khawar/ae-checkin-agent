#!/usr/bin/env python
"""Pre-render every fixed kiosk string to MP3 with ElevenLabs (docs/CONTRACTS.md R5.4).

Build time only; nothing calls ElevenLabs while the app runs. Output:
apps/web/public/audio/en/<sha256(text)[:16]>.mp3 plus manifest.json {hash: {text, file}}.

Env: ELEVENLABS_API_KEY (required unless --dry-run), ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL_ID.
Exit codes: 0 ok, 2 no API key, 1 request failure.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
RULES_DATA = ROOT / "packages" / "rules" / "data"
FIXED = Path(__file__).resolve().parent / "kiosk_fixed_strings.json"
OUT_DIR = ROOT / "apps" / "web" / "public" / "audio" / "en"
DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"  # stock ElevenLabs voice (Rachel)
DEFAULT_MODEL = "eleven_multilingual_v2"


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def collect_strings(rules_data: Path = RULES_DATA, fixed: Path = FIXED) -> list[str]:
    """Every unique fixed kiosk string, in a stable order."""
    out: list[str] = []

    def add(s: Any) -> None:
        if isinstance(s, str) and s.strip() and s not in out:
            out.append(s)

    gates = _load(rules_data / "gate_questions.json")
    for q in gates.get("questions", []):
        add(q.get("label"))
        for key in ("text_prompt", "direction_prompt"):
            add(q.get(key))
        for opt in q.get("options", {}):
            add(opt)
        for opt in q.get("direction_options", []):
            add(opt)
    items = _load(rules_data / "proctcae_items.json")
    for item in items.get("items", []):
        for prompt in item.get("prompts", {}).values():
            add(prompt)
        for options in item.get("response_options", {}).values():
            for label in options:
                add(label)
    ladder = _load(rules_data / "escalation_ladder.json")
    for tier in ladder.get("tiers", []):
        add(tier.get("stop_screen_text"))
    add(ladder.get("stop_screen_text"))
    if fixed.exists():
        for s in _load(fixed).get("strings", []):
            add(s)
    return out


def render(text: str, key: str, voice: str, model: str) -> bytes:
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice}",
        data=json.dumps({"text": text, "model_id": model}).encode("utf-8"),
        headers={
            "xi-api-key": key,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return bytes(resp.read())


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="list strings and exit")
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    args = ap.parse_args(argv)

    strings = collect_strings()
    if args.dry_run:
        for s in strings:
            print(f"{text_hash(s)}  {s}")
        print(f"{len(strings)} strings", file=sys.stderr)
        return 0

    key = os.environ.get("ELEVENLABS_API_KEY", "")
    if not key:
        print(
            "ELEVENLABS_API_KEY is not set; nothing rendered. Use --dry-run to list strings.",
            file=sys.stderr,
        )
        return 2
    voice = os.environ.get("ELEVENLABS_VOICE_ID") or DEFAULT_VOICE
    model = os.environ.get("ELEVENLABS_MODEL_ID") or DEFAULT_MODEL

    args.out.mkdir(parents=True, exist_ok=True)
    manifest_path = args.out / "manifest.json"
    manifest: dict[str, dict[str, str]] = _load(manifest_path) if manifest_path.exists() else {}
    for text in strings:
        h = text_hash(text)
        file = f"{h}.mp3"
        if h in manifest and (args.out / file).exists():
            continue
        try:
            audio = render(text, key, voice, model)
        except Exception as exc:
            print(f"render failed for {h}: {type(exc).__name__}", file=sys.stderr)
            return 1
        (args.out / file).write_bytes(audio)
        manifest[h] = {"text": text, "file": file}
        print(f"rendered {h}")
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
