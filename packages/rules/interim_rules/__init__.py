"""Interim rules engine (``interim_rules``).

A pure, deterministic Python package that turns one completed check-in into
provisional CTCAE grades, an escalation tier, a seriousness assessment, a
concomitant-medication match, de-duplication decisions and CDISC SDTM-shaped
draft records, where every output field points at the evidence that produced
it.

Design rules (CLAUDE.md §3.4, CONTRACTS.md §1):

* No I/O except reading the package's own JSON tables under ``packages/rules/data``.
* No network, no clock: the caller passes ``completed_at``.
* No LLM or generative component anywhere; everything is lookup tables and arithmetic.
* Vitals never change a grade; they can raise the escalation tier by at most one step.
* Every clinical number lives in a JSON table with a ``source`` and a ``rationale``.

Entry point::

    from interim_rules import evaluate_checkin, serialize
    result = evaluate_checkin(serialize.input_from_dict(payload))
    payload_out = serialize.result_to_dict(result)

Also exported for the API (CONTRACTS.md R3.1): the protocol models
(``ProtocolAssessment``, ``ProtocolContext``, ``ProtocolConMedFlag``, ``ProtocolRef``),
the template writer (``write``, ``validate_written``, ``WrittenText``) and the
time-saved estimate (``estimate``).
"""

from .engine import evaluate_checkin
from .models import (
    CheckInInput,
    CheckInResult,
    ConMedMatch,
    DraftField,
    DraftRecord,
    Evidence,
    GateAnswers,
    ItemResult,
    OpenAE,
    ProResponse,
    ProtocolAssessment,
    ProtocolConMedFlag,
    ProtocolContext,
    ProtocolRef,
    RuleFired,
    RuleSettings,
    SAEClock,
    VitalsAssessment,
    VitalsSampleIn,
    VitalsSummary,
)
from .narrative import WrittenText, validate_written, write
from .time_saved import estimate

INTERIM_VERSION = "0.1.0"
"""Product version. Read by the API for exports and the bundle manifest (CONTRACTS.md §7)."""

__version__ = INTERIM_VERSION

__all__ = [
    "INTERIM_VERSION",
    "CheckInInput",
    "CheckInResult",
    "ConMedMatch",
    "DraftField",
    "DraftRecord",
    "Evidence",
    "GateAnswers",
    "ItemResult",
    "OpenAE",
    "ProResponse",
    "ProtocolAssessment",
    "ProtocolConMedFlag",
    "ProtocolContext",
    "ProtocolRef",
    "RuleFired",
    "RuleSettings",
    "SAEClock",
    "VitalsAssessment",
    "VitalsSampleIn",
    "VitalsSummary",
    "WrittenText",
    "__version__",
    "estimate",
    "evaluate_checkin",
    "validate_written",
    "write",
]
