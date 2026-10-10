"""JSON (de)serialization for engine inputs and outputs.

* :func:`result_to_dict` turns a :class:`CheckInResult` into plain JSON-safe
  data (dataclasses -> dicts, tuples -> lists).
* :func:`input_from_dict` builds a :class:`CheckInInput` from the persona-style
  payload used by ``personas.json`` and the eval harness, accepting responses as
  ``{item_id: {attribute: value}}`` or as a list of answer dicts, and vitals
  samples in the bridge's camelCase or the API's snake_case.
* :func:`build_input` is the keyword-argument convenience the API uses.

Ids the caller does not supply are synthesized deterministically from the
session id so that evidence pointers are never empty.
"""

from __future__ import annotations

import dataclasses
import math
from collections.abc import Mapping, Sequence
from typing import Any, cast

from .models import (
    ATTRIBUTES,
    Attribute,
    CheckInInput,
    CheckInResult,
    ConMedDirection,
    GateAnswers,
    OpenAE,
    ProResponse,
    RuleSettings,
    VitalsSampleIn,
)
from .timefmt import normalize_iso, shift

_MISSING = object()


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #


def to_jsonable(value: object) -> Any:
    """Recursively convert dataclasses/tuples/dicts to JSON-safe lists and dicts.

    A non-finite float (NaN / Infinity) is emitted as its text form: the input layer
    rejects such numbers and the engine never computes them, but strict JSON consumers
    (Starlette, browsers) refuse them outright, so this is the last line of defense.
    """
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {f.name: to_jsonable(getattr(value, f.name)) for f in dataclasses.fields(value)}
    if isinstance(value, list | tuple):
        return [to_jsonable(v) for v in cast(Sequence[object], value)]
    if isinstance(value, Mapping):
        return {str(k): to_jsonable(v) for k, v in cast(Mapping[object, object], value).items()}
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if value is None or isinstance(value, str | int | float | bool):
        return value
    raise TypeError(f"cannot serialize {type(value).__name__}")


def result_to_dict(result: CheckInResult) -> dict[str, Any]:
    """JSON-safe dict of a result; ``json.dumps`` works on it directly."""
    return cast(dict[str, Any], to_jsonable(result))


def input_to_dict(inp: CheckInInput) -> dict[str, Any]:
    """JSON-safe dict of an input (round-trips through :func:`input_from_dict`)."""
    return cast(dict[str, Any], to_jsonable(inp))


# --------------------------------------------------------------------------- #
# Input
# --------------------------------------------------------------------------- #


def _pick(source: Mapping[str, Any], *keys: str, default: object = None) -> Any:
    """First present (non-``None``) key among ``keys``."""
    for key in keys:
        value = source.get(key, _MISSING)
        if value is not _MISSING and value is not None:
            return value
    return default


def _float(value: object) -> float:
    """A finite number (``NaN``/``Infinity`` are rejected: strict JSON consumers refuse them)."""
    if isinstance(value, bool) or not isinstance(value, int | float | str):
        raise ValueError(f"expected a number, got {type(value).__name__}")
    try:
        number = float(value)
    except ValueError as exc:
        raise ValueError(f"expected a number, got {value!r}") from exc
    if not math.isfinite(number):
        raise ValueError(f"expected a finite number, got {value!r}")
    return number


def _float_or_none(value: object) -> float | None:
    return None if value is None else _float(value)


def _str_or_none(value: object) -> str | None:
    return None if value is None else str(value)


def _attribute(value: object) -> Attribute:
    if value not in ATTRIBUTES:
        raise ValueError(f"unknown attribute {value!r}")
    return value


_DIRECTIONS: tuple[ConMedDirection, ...] = ("started", "stopped", "both")


def _direction(value: object) -> ConMedDirection | None:
    if value is None or value == "":
        return None
    if value not in _DIRECTIONS:
        raise ValueError(f"unknown conmed_direction {value!r}")
    return value


def responses_from(raw: object, session_id: str, default_ts: str) -> tuple[ProResponse, ...]:
    """Accept ``{item_id: {attribute: value}}`` or a list of answer dicts."""
    out: list[ProResponse] = []
    if raw is None:
        return ()
    if isinstance(raw, Mapping):
        for item_id, attrs in cast(Mapping[str, Any], raw).items():
            if not isinstance(attrs, Mapping):
                raise ValueError(f"responses[{item_id!r}] must be an object of attribute -> value")
            for attribute, value in cast(Mapping[str, Any], attrs).items():
                out.append(
                    ProResponse(
                        answer_id=f"{session_id}:{item_id}.{attribute}",
                        item_id=str(item_id),
                        attribute=_attribute(attribute),
                        value=int(value),
                        ts=default_ts,
                    )
                )
        return tuple(out)
    if isinstance(raw, Sequence) and not isinstance(raw, str):
        for idx, entry in enumerate(cast(Sequence[object], raw)):
            if isinstance(entry, ProResponse):
                out.append(entry)
                continue
            if not isinstance(entry, Mapping):
                raise ValueError(f"responses[{idx}] must be an object")
            d = cast(Mapping[str, Any], entry)
            item_id = str(_pick(d, "item_id", "itemId"))
            attribute = _attribute(_pick(d, "attribute"))
            out.append(
                ProResponse(
                    answer_id=str(
                        _pick(
                            d,
                            "answer_id",
                            "answerId",
                            "id",
                            default=f"{session_id}:{item_id}.{attribute}",
                        )
                    ),
                    item_id=item_id,
                    attribute=attribute,
                    value=int(_pick(d, "value", "value_int", "valueInt")),
                    ts=str(_pick(d, "ts", "ts_server", "tsServer", default=default_ts)),
                )
            )
        return tuple(out)
    raise ValueError("responses must be a mapping or a list")


def _answer_id(source: Mapping[str, Any], key: str, synthesized: str) -> str | None:
    """A gate answer id: the given value, an explicit ``None`` kept as is, or synthesized.

    Keeping an explicit ``None`` lets ``input_from_dict(input_to_dict(x)) == x`` hold; the
    engine synthesizes evidence ids itself when it finds ``None``.
    """
    if key not in source:
        return synthesized
    value = source[key]
    return None if value is None else str(value)


def gates_from(raw: object, session_id: str) -> GateAnswers:
    """Build :class:`GateAnswers` from a dict; missing answers default to 'no'/'none'."""
    if isinstance(raw, GateAnswers):
        return raw
    d = cast(Mapping[str, Any], raw) if isinstance(raw, Mapping) else {}
    conmed_text = _str_or_none(_pick(d, "conmed_text", "conmedText"))
    return GateAnswers(
        hospitalization=bool(_pick(d, "hospitalization", default=False)),
        hospitalization_answer_id=_answer_id(
            d, "hospitalization_answer_id", f"{session_id}:gate_hospitalization"
        ),
        conmed_changed=bool(_pick(d, "conmed_changed", "conmedChanged", default=False)),
        conmed_text=conmed_text,
        conmed_direction=_direction(_pick(d, "conmed_direction", "conmedDirection")),
        conmed_answer_id=_answer_id(d, "conmed_answer_id", f"{session_id}:gate_conmed"),
        other_text=_str_or_none(_pick(d, "other_text", "otherText")),
        other_answer_id=_answer_id(d, "other_answer_id", f"{session_id}:gate_other"),
        temp_c=_float_or_none(_pick(d, "temp_c", "tempC")),
        temp_answer_id=_answer_id(d, "temp_answer_id", f"{session_id}:gate_temp_c"),
    )


def sample_from(raw: object, index: int, session_id: str, base_ts: str) -> VitalsSampleIn:
    """One sample from camelCase (bridge) or snake_case (API) keys.

    A sample without a timestamp but with ``tsOffsetS`` (persona style) is
    placed ``tsOffsetS`` seconds after ``base_ts``.
    """
    if isinstance(raw, VitalsSampleIn):
        return raw
    if not isinstance(raw, Mapping):
        raise ValueError(f"vitals[{index}] must be an object")
    d = cast(Mapping[str, Any], raw)
    ts = _pick(d, "ts_utc", "tsUtc", "ts")
    if ts is None:
        offset = _pick(d, "ts_offset_s", "tsOffsetS")
        if offset is None:
            raise ValueError(f"vitals[{index}] needs tsUtc/ts_utc or tsOffsetS")
        ts = shift(base_ts, seconds=float(offset))
    flags = _pick(d, "quality_flags", "qualityFlags", default=[])
    return VitalsSampleIn(
        sample_id=str(
            _pick(d, "sample_id", "sampleId", "id", default=f"{session_id}:vs{index:04d}")
        ),
        ts_utc=normalize_iso(str(ts)),
        source=str(_pick(d, "source", default="mock")),
        is_measured=bool(_pick(d, "is_measured", "isMeasured", default=False)),
        pulse_bpm=_float_or_none(_pick(d, "pulse_bpm", "pulseBpm")),
        pulse_conf=_float_or_none(_pick(d, "pulse_conf", "pulseConf")),
        breathing_bpm=_float_or_none(_pick(d, "breathing_bpm", "breathingBpm")),
        breathing_conf=_float_or_none(_pick(d, "breathing_conf", "breathingConf")),
        hrv_rmssd_ms=_float_or_none(_pick(d, "hrv_rmssd_ms", "hrvRmssdMs")),
        hrv_conf=_float_or_none(_pick(d, "hrv_conf", "hrvConf")),
        # A sample without a window is given 0 s, which every metric's window gate then
        # rejects with a logged reason; the bridge always sends windowS (CLAUDE.md §7.1).
        window_s=_float(_pick(d, "window_s", "windowS", default=0.0)),
        quality_flags=tuple(str(f) for f in cast(Sequence[object], flags)),
    )


def open_ae_from(raw: object, index: int) -> OpenAE:
    if isinstance(raw, OpenAE):
        return raw
    if not isinstance(raw, Mapping):
        raise ValueError(f"open_aes[{index}] must be an object")
    d = cast(Mapping[str, Any], raw)
    return OpenAE(
        ae_open_id=str(_pick(d, "ae_open_id", "aeOpenId", "id")),
        aedecod=str(_pick(d, "aedecod", "AEDECOD")),
        first_reported_at=normalize_iso(str(_pick(d, "first_reported_at", "firstReportedAt"))),
        last_reported_at=normalize_iso(str(_pick(d, "last_reported_at", "lastReportedAt"))),
        last_session_id=str(_pick(d, "last_session_id", "lastSessionId", default="")),
    )


def settings_from(raw: object) -> RuleSettings:
    if isinstance(raw, RuleSettings):
        return raw
    d = cast(Mapping[str, Any], raw) if isinstance(raw, Mapping) else {}
    window = _pick(d, "dedup_window_days", "dedupWindowDays")
    return RuleSettings(
        simulated_as_measured=bool(
            _pick(d, "simulated_as_measured", "simulatedAsMeasured", default=False)
        ),
        min_confidence=_float_or_none(_pick(d, "min_confidence", "minConfidence")),
        dedup_window_days=None if window is None else int(window),
    )


def input_from_dict(data: Mapping[str, Any]) -> CheckInInput:
    """Build a :class:`CheckInInput` from a persona-style or API-style dict."""
    session_id = str(_pick(data, "session_id", "sessionId", "id", default="session"))
    completed_raw = _pick(data, "completed_at", "completedAt")
    if completed_raw is None:
        raise ValueError("completed_at is required")
    completed_at = normalize_iso(str(completed_raw))
    usubjid = _pick(data, "usubjid", "USUBJID")
    if usubjid is None:
        raise ValueError("usubjid is required")
    base_ts = normalize_iso(str(_pick(data, "started_at", "startedAt", default=completed_at)))
    raw_vitals = _pick(data, "vitals", "vitals_samples", "vitalsSamples", default=[])
    raw_open = _pick(data, "open_aes", "openAes", default=[])
    nct = _pick(data, "nct_id", "nctId")
    return CheckInInput(
        session_id=session_id,
        studyid=str(_pick(data, "studyid", "study_id", "STUDYID", default="STUDY")),
        usubjid=str(usubjid),
        completed_at=completed_at,
        responses=responses_from(data.get("responses"), session_id, completed_at),
        gates=gates_from(data.get("gates"), session_id),
        vitals=tuple(
            sample_from(s, i, session_id, base_ts)
            for i, s in enumerate(cast(Sequence[object], raw_vitals))
        ),
        open_aes=tuple(open_ae_from(a, i) for i, a in enumerate(cast(Sequence[object], raw_open))),
        settings=settings_from(data.get("settings")),
        next_aeseq=int(_pick(data, "next_aeseq", "nextAeseq", default=1)),
        nct_id=None if nct is None else str(nct),
    )


def build_input(
    *,
    session_id: str,
    studyid: str,
    usubjid: str,
    completed_at: str,
    responses: object,
    gates: object,
    vitals: Sequence[object] = (),
    open_aes: Sequence[object] = (),
    settings: object = None,
    next_aeseq: int = 1,
    nct_id: str | None = None,
    started_at: str | None = None,
) -> CheckInInput:
    """Keyword convenience for the API: each piece may be a dataclass instance or a dict."""
    return input_from_dict(
        {
            "session_id": session_id,
            "studyid": studyid,
            "usubjid": usubjid,
            "completed_at": completed_at,
            "started_at": started_at,
            "responses": responses,
            "gates": gates,
            "vitals": list(vitals),
            "open_aes": list(open_aes),
            "settings": settings,
            "next_aeseq": next_aeseq,
            "nct_id": nct_id,
        }
    )
