"""Generated-text writers (CLAUDE.md §00.3): rules decide, text tools write, people confirm.

* :mod:`.template` - the default, deterministic ``interim_rules.narrative`` template writer.
* :mod:`.llm` - an optional Claude writer, used only when ``ANTHROPIC_API_KEY`` is set; its
  output is accepted only if ``interim_rules.narrative.validate_written`` finds no problem,
  otherwise the template text is returned with ``fallback_reason``.
* :mod:`.base` - the shared interface, :func:`get_writer` and :func:`write_text`.

Other services (visit briefs, query answers) can call :func:`write_text` to get the same
template-or-validated-LLM behavior.
"""

from .base import Writer, get_writer, write_text, writer_status

__all__ = ["Writer", "get_writer", "write_text", "writer_status"]
