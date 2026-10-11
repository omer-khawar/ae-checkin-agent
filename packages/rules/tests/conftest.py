"""Shared pytest configuration. Test helpers live in ``helpers.py`` next to this file."""

from __future__ import annotations

import sys
from pathlib import Path

# Make ``from helpers import ...`` work regardless of pytest's import mode.
_TESTS_DIR = str(Path(__file__).resolve().parent)
if _TESTS_DIR not in sys.path:
    sys.path.insert(0, _TESTS_DIR)
