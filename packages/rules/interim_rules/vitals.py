"""Vitals eligibility, quality status and summary (CLAUDE.md §3.3 and §3.4(d)).

Eligibility is decided **per sample and per metric**, in this order:

* a metric with no value is simply absent;
* confidence missing, not a finite number, outside 0..1, or below
  ``min_confidence`` -> ``low_confidence`` (ignored, reason logged);
* the sample's averaging window shorter than the metric's ``min_window_s``
  (pulse 12 s, breathing 30 s, HRV 60 s) -> ``window_too_short`` (ignored,
  reason logged; the bridge is the primary timing gate, this is the auditable
  second check);
* value not finite or outside the plausibility bounds -> ``implausible``
  (ignored, reason logged);
* otherwise the reading is **usable** and goes into the summary (medians / maxima);
* a usable reading is additionally **corroboration-eligible** only if the sample
  is measured, or the admin demo toggle ``simulated_as_measured`` is on.

"Measured" is decided by :func:`effective_is_measured`: a sample whose
``source`` is listed in the table's ``simulated_sources`` (``mock``) is
simulated whatever its ``is_measured`` flag says. The source label wins in the
conservative direction, so a mis-set flag can never strip the SIMULATED label.

Session status precedence (first that applies):
``unavailable`` (no samples) > ``low_quality`` (nothing confident with a valid
window) > ``implausible`` (everything confident is implausible) >
``simulated_ignored`` (usable readings exist but none is corroboration-eligible)
> ``ok``.

Evidence economy: session-level rules and summary fields cite the **first and
last** sample of their span plus a count, not one pointer per sample; the full
list of usable sample ids is ``VitalsAssessment.eligible_sample_ids`` and the
per-reading reasons are ``VitalsAssessment.ignored``. Only the VS ``VSORRES``
field (a median) keeps one pointer per reading it was computed from.

Nothing here touches grades. Thresholds come from ``data/vitals_corroboration.json``.
"""

from __future__ import annotations

import math
import statistics
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Literal

from .conditions import VitalMax
from .evidence import sample_evidence, table_evidence
from .models import (
    Evidence,
    RuleFired,
    RuleSettings,
    VitalsAssessment,
    VitalsSampleIn,
    VitalsStatus,
    VitalsSummary,
)
from .tables import VitalsConfig, vitals_config
from .timefmt import parse_iso_utc

VITALS_TABLE_FILE = "vitals_corroboration.json"

Metric = Literal["pulse", "breathing", "hrv"]
METRICS: tuple[Metric, ...] = ("pulse", "breathing", "hrv")
METRIC_UNITS: dict[Metric, str] = {"pulse": "beats/min", "breathing": "breaths/min", "hrv": "ms"}
ReadingState = Literal["usable", "low_confidence", "window_too_short", "implausible"]
_NOT_CONFIDENT: frozenset[str] = frozenset({"low_confidence", "window_too_short"})


@dataclass(frozen=True)
class MetricReading:
    """One metric of one sample after eligibility checks.

    ``is_measured`` is the *effective* value (see :func:`effective_is_measured`).
    """

    sample_id: str
    ts: str
    source: str
    is_measured: bool
    metric: Metric
    value: float
    conf: float | None
    state: ReadingState
    reason: str | None
    corroboration_eligible: bool


def effective_min_confidence(settings: RuleSettings) -> float:
    """The confidence threshold in force: the settings override, else the table default."""
    return (
        settings.min_confidence
        if settings.min_confidence is not None
        else vitals_config().min_confidence
    )


def effective_is_measured(sample: VitalsSampleIn, cfg: VitalsConfig | None = None) -> bool:
    """Measured only if the flag says so AND the source is not simulated by definition."""
    config = cfg if cfg is not None else vitals_config()
    return sample.is_measured and sample.source not in config.simulated_sources


def measured_flag_inconsistent(sample: VitalsSampleIn, cfg: VitalsConfig | None = None) -> bool:
    """True when ``is_measured`` claims measured but the source is a simulated one."""
    config = cfg if cfg is not None else vitals_config()
    return sample.is_measured and sample.source in config.simulated_sources


def _metric_fields(sample: VitalsSampleIn, metric: Metric) -> tuple[float | None, float | None]:
    if metric == "pulse":
        return sample.pulse_bpm, sample.pulse_conf
    if metric == "breathing":
        return sample.breathing_bpm, sample.breathing_conf
    return sample.hrv_rmssd_ms, sample.hrv_conf


def _confidence_problem(conf: float | None, min_conf: float) -> str | None:
    """Why a confidence value cannot be trusted, or ``None`` when it can."""
    if conf is None:
        return f"confidence missing (minimum {min_conf:.2f})"
    if not math.isfinite(conf):
        return f"confidence {conf} is not a finite number"
    if not 0.0 <= conf <= 1.0:
        return f"confidence {conf:g} outside 0..1"
    if conf < min_conf:
        return f"confidence {conf:.2f} below minimum {min_conf:.2f}"
    return None


def classify_samples(
    samples: Sequence[VitalsSampleIn], settings: RuleSettings
) -> tuple[MetricReading, ...]:
    """Classify every (sample, metric) pair that carries a value."""
    cfg = vitals_config()
    min_conf = effective_min_confidence(settings)
    readings: list[MetricReading] = []
    for sample in samples:
        measured = effective_is_measured(sample, cfg)
        for metric in METRICS:
            value, conf = _metric_fields(sample, metric)
            if value is None:
                continue
            unit = METRIC_UNITS[metric]
            bounds = cfg.plausibility.get(metric)
            min_window = cfg.min_window_s.get(metric)
            state: ReadingState
            reason: str | None
            problem = _confidence_problem(conf, min_conf)
            if problem is not None:
                state, reason = "low_confidence", f"{metric}: {problem}"
            elif min_window is not None and not sample.window_s >= min_window:
                state, reason = (
                    "window_too_short",
                    f"{metric}: averaging window {sample.window_s:g} s shorter than minimum "
                    f"{min_window:g} s",
                )
            elif not math.isfinite(value):
                state, reason = "implausible", f"{metric}: {value} is not a finite number"
            elif bounds is not None and not bounds.contains(value):
                span = f"{bounds.min:g}-{bounds.max:g}"
                state, reason = (
                    "implausible",
                    f"{metric}: {value:g} {unit} outside plausibility {span}",
                )
            else:
                state, reason = "usable", None
            readings.append(
                MetricReading(
                    sample_id=sample.sample_id,
                    ts=sample.ts_utc,
                    source=sample.source,
                    is_measured=measured,
                    metric=metric,
                    value=float(value),
                    conf=conf,
                    state=state,
                    reason=reason,
                    corroboration_eligible=state == "usable"
                    and (measured or settings.simulated_as_measured),
                )
            )
    return tuple(readings)


def corroboration_maxima(readings: Iterable[MetricReading]) -> dict[str, VitalMax]:
    """Per metric, the maximum corroboration-eligible value and the sample that carried it."""
    maxima: dict[str, VitalMax] = {}
    for reading in readings:
        if not reading.corroboration_eligible:
            continue
        current = maxima.get(reading.metric)
        if current is None or reading.value > current.value:
            maxima[reading.metric] = VitalMax(reading.value, reading.sample_id, reading.ts)
    return maxima


def _median(values: Sequence[float], digits: int) -> float | None:
    return round(statistics.median(values), digits) if values else None


def _max(values: Sequence[float]) -> float | None:
    return round(max(values), 1) if values else None


def _ordered_unique(ids: Iterable[str]) -> tuple[str, ...]:
    seen: dict[str, None] = {}
    for sample_id in ids:
        seen.setdefault(sample_id, None)
    return tuple(seen)


def span_evidence(points: Sequence[tuple[str, str]], what: str) -> tuple[Evidence, ...]:
    """First and last ``(sample_id, ts)`` of a span as evidence, with the count in the note.

    One pointer when the span has a single sample; nothing when it is empty.
    """
    if not points:
        return ()
    ordered = sorted(points, key=lambda p: parse_iso_utc(p[1]))
    n = len(ordered)
    first_id, first_ts = ordered[0]
    if n == 1:
        return (sample_evidence(first_id, first_ts, f"the only {what}"),)
    last_id, last_ts = ordered[-1]
    return (
        sample_evidence(first_id, first_ts, f"first of {n} {what}"),
        sample_evidence(last_id, last_ts, f"last of {n} {what}"),
    )


def _sample_points(samples: Iterable[VitalsSampleIn]) -> list[tuple[str, str]]:
    return [(s.sample_id, s.ts_utc) for s in samples]


def _reading_points(readings: Iterable[MetricReading]) -> list[tuple[str, str]]:
    seen: dict[str, str] = {}
    for reading in readings:
        seen.setdefault(reading.sample_id, reading.ts)
    return list(seen.items())


def build_summary(
    samples: Sequence[VitalsSampleIn], usable: Sequence[MetricReading]
) -> VitalsSummary | None:
    """Medians/maxima over usable readings (measured or not). ``None`` when nothing is usable."""
    if not usable:
        return None
    by_metric: dict[Metric, list[float]] = {m: [] for m in METRICS}
    for reading in usable:
        by_metric[reading.metric].append(reading.value)
    sources = {r.source for r in usable}
    ordered = sorted(usable, key=lambda r: parse_iso_utc(r.ts))
    return VitalsSummary(
        n_samples=len(samples),
        n_eligible=len(_ordered_unique(r.sample_id for r in usable)),
        pulse_median=_median(by_metric["pulse"], 1),
        pulse_max=_max(by_metric["pulse"]),
        breathing_median=_median(by_metric["breathing"], 1),
        breathing_max=_max(by_metric["breathing"]),
        hrv_median=_median(by_metric["hrv"], 1),
        is_measured=all(r.is_measured for r in usable),
        source=sources.pop() if len(sources) == 1 else "mixed",
        first_ts=ordered[0].ts,
        last_ts=ordered[-1].ts,
    )


def _json_number(value: float) -> float | str:
    """A finite float as is; NaN/Infinity as text so the result stays strict-JSON-safe."""
    return value if math.isfinite(value) else str(value)


def _implausible_rules(readings: Sequence[MetricReading]) -> list[RuleFired]:
    """One ``vitals.implausible`` rule per sample that carried an implausible confident metric."""
    cfg = vitals_config()
    per_sample: dict[str, list[MetricReading]] = {}
    for reading in readings:
        if reading.state == "implausible":
            per_sample.setdefault(reading.sample_id, []).append(reading)
    rules: list[RuleFired] = []
    for sample_id, bad in per_sample.items():
        parts = "; ".join(r.reason or "" for r in bad)
        rules.append(
            RuleFired(
                rule_id="vitals.implausible",
                category="vitals_quality",
                description=f"Vitals: sample {sample_id} {parts}; ignored for rules",
                inputs={
                    "sample_id": sample_id,
                    **{f"{r.metric}": _json_number(r.value) for r in bad},
                    "bounds": {
                        m: [b.min, b.max]
                        for m, b in cfg.plausibility.items()
                        if m in {r.metric for r in bad}
                    },
                },
                effect="sample metric(s) ignored for rules (implausible)",
                evidence=(
                    sample_evidence(sample_id, bad[0].ts, parts),
                    table_evidence(VITALS_TABLE_FILE, "plausibility bounds"),
                ),
            )
        )
    return rules


def assess_vitals(samples: Sequence[VitalsSampleIn], settings: RuleSettings) -> VitalsAssessment:
    """Classify, decide the session status, summarize, and explain it all as rules."""
    cfg = vitals_config()
    min_conf = effective_min_confidence(settings)
    readings = classify_samples(samples, settings)
    rules: list[RuleFired] = []

    if not samples:
        rules.append(
            RuleFired(
                rule_id="vitals.unavailable",
                category="vitals_quality",
                description=(
                    "Vitals: no samples were captured for this session; "
                    "check-in evaluated without vitals"
                ),
                inputs={"n_samples": 0},
                effect="vitals_status = unavailable; no corroboration possible",
                evidence=(table_evidence(VITALS_TABLE_FILE, "no samples"),),
            )
        )
        return VitalsAssessment("unavailable", (), (), None, tuple(rules))

    usable = [r for r in readings if r.state == "usable"]
    confident = [r for r in readings if r.state not in _NOT_CONFIDENT]
    ignored = tuple((r.sample_id, r.reason or "") for r in readings if r.state != "usable")
    eligible_ids = _ordered_unique(r.sample_id for r in usable)
    summary = build_summary(samples, usable)
    inconsistent = [s.sample_id for s in samples if measured_flag_inconsistent(s, cfg)]

    rules.extend(_implausible_rules(readings))

    status: VitalsStatus
    if not confident:
        status = "low_quality"
        n_low = sum(1 for r in readings if r.state == "low_confidence")
        n_short = sum(1 for r in readings if r.state == "window_too_short")
        rules.append(
            RuleFired(
                rule_id="vitals.low_quality",
                category="vitals_quality",
                description=(
                    f"Vitals: {len(samples)} sample(s) captured but no metric reached confidence "
                    f"{min_conf:.2f} with a valid averaging window ({n_low} low-confidence, "
                    f"{n_short} window-too-short reading(s)); vitals ignored"
                ),
                inputs={
                    "n_samples": len(samples),
                    "min_confidence": min_conf,
                    "min_window_s": dict(cfg.min_window_s),
                    "n_low_confidence_readings": n_low,
                    "n_window_too_short_readings": n_short,
                },
                effect="vitals_status = low_quality; no corroboration possible",
                evidence=(
                    *span_evidence(_sample_points(samples), "captured sample(s)"),
                    table_evidence(VITALS_TABLE_FILE, "min_confidence; min_window_s"),
                ),
            )
        )
    elif not usable:
        status = "implausible"
    elif not any(r.corroboration_eligible for r in usable):
        status = "simulated_ignored"
        sources = sorted({r.source for r in usable})
        flag_note = (
            f"; {len(inconsistent)} sample(s) carried is_measured = true with a simulated "
            "source and were treated as SIMULATED (the source label wins)"
            if inconsistent
            else ""
        )
        rules.append(
            RuleFired(
                rule_id="vitals.simulated_ignored",
                category="vitals_quality",
                description=(
                    f"Vitals: all usable samples are SIMULATED ({', '.join(sources)}) and "
                    "'treat simulated as measured' is OFF; summarized for the record but not "
                    f"eligible for corroboration{flag_note}"
                ),
                inputs={
                    "n_usable_samples": len(eligible_ids),
                    "sources": sources,
                    "simulated_as_measured": False,
                    "measured_flag_inconsistent_samples": inconsistent,
                },
                effect="vitals_status = simulated_ignored; corroboration rules not evaluated",
                evidence=(
                    *span_evidence(_reading_points(usable), "simulated usable sample(s)"),
                    table_evidence(VITALS_TABLE_FILE, "measured gate; simulated_sources"),
                ),
            )
        )
    else:
        status = "ok"

    simulated_usable = [r for r in usable if not r.is_measured]
    if settings.simulated_as_measured and simulated_usable:
        n_simulated = len(_ordered_unique(r.sample_id for r in simulated_usable))
        rules.append(
            RuleFired(
                rule_id="vitals.simulated_as_measured",
                category="vitals_quality",
                description=(
                    f"WARNING: demo toggle ON - {n_simulated} SIMULATED sample(s) are being "
                    "treated as measured for corroboration"
                ),
                inputs={"simulated_as_measured": True, "n_simulated_samples": n_simulated},
                effect="simulated samples eligible for corroboration (demo only)",
                evidence=(
                    table_evidence(VITALS_TABLE_FILE, "measured gate overridden by settings"),
                ),
            )
        )

    if summary is not None:
        rules.append(_summary_rule(summary, usable, inconsistent))

    return VitalsAssessment(status, eligible_ids, ignored, summary, tuple(rules))


def _fmt(value: float | None, unit: str) -> str:
    return "n/a" if value is None else f"{value:g} {unit}"


def _summary_rule(
    summary: VitalsSummary, usable: Sequence[MetricReading], inconsistent: Sequence[str]
) -> RuleFired:
    measured_label = "MEASURED" if summary.is_measured else "SIMULATED"
    points = _reading_points(usable)
    ordered = sorted(points, key=lambda p: parse_iso_utc(p[1]))
    inputs: dict[str, object] = {
        "n_samples": summary.n_samples,
        "n_eligible": summary.n_eligible,
        "first_sample_id": ordered[0][0],
        "last_sample_id": ordered[-1][0],
        "pulse_median": summary.pulse_median,
        "pulse_max": summary.pulse_max,
        "breathing_median": summary.breathing_median,
        "breathing_max": summary.breathing_max,
        "hrv_median": summary.hrv_median,
        "is_measured": summary.is_measured,
        "source": summary.source,
    }
    if inconsistent:
        inputs["measured_flag_inconsistent_samples"] = list(inconsistent)
    return RuleFired(
        rule_id="vitals.summary",
        category="vitals_quality",
        description=(
            f"Vitals summary over {summary.n_eligible} usable of {summary.n_samples} samples "
            f"({measured_label}, {summary.source}): pulse median "
            f"{_fmt(summary.pulse_median, 'beats/min')} max "
            f"{_fmt(summary.pulse_max, 'beats/min')}; breathing median "
            f"{_fmt(summary.breathing_median, 'breaths/min')} max "
            f"{_fmt(summary.breathing_max, 'breaths/min')}"
        ),
        inputs=inputs,
        effect="VS summary rows drafted; vitals never change a grade",
        evidence=(
            *span_evidence(points, "usable sample(s); ids in vitals.eligible_sample_ids"),
            table_evidence(VITALS_TABLE_FILE, "summary = median/max of usable readings"),
        ),
    )
