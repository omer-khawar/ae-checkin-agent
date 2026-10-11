"""Optional language-model readers (CONTRACTS.md R5.3): Gemini reads, rules decide, people
confirm. See :mod:`.gemini_reader` and ``interim_rules.llm_verify``."""

from .apply import ReaderOutcome, apply_reader
from .config import ReaderConfig
from .gemini_reader import PROMPT_VERSION, ReaderResult, read

__all__ = [
    "PROMPT_VERSION",
    "ReaderConfig",
    "ReaderOutcome",
    "ReaderResult",
    "apply_reader",
    "read",
]
