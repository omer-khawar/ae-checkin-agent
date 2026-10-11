"""Presage SmartSpectra vitals -> one summary reading + plain-English signals.

SmartSpectra runs ON THE DEVICE (iOS / Android / C++ / Node-Electron SDK) and has no cloud API for
measurements, so the app (or presage-bridge/) sends us either:
  (a) a summary it computed itself, or
  (b) the raw decoded `Metrics` messages, which we summarize here.

Field reference: https://smartspectra.presagetech.com/docs/data-types/
  cardio.pulse_rate[]    MeasurementWithConfidence {value, stable, confidence 0-100, timestamp µs}
  breathing.rate[]       MeasurementWithConfidence
  cardio.hrv[]           Hrv {rmssd, mean_nn, sdnn, baevsky, confidence, stable, timestamp}
Presage's own validity ranges: pulse 40-110 bpm (12 s average), breathing 5-40 /min (30 s average).

These are NOT diagnostic. SmartSpectra is not a medical device. Vitals are used only as supporting
context next to what the patient reports. On their own they never create an AE or an emergency.
"""

from __future__ import annotations

from statistics import mean, median

from app.config import settings

ADULT_RESTING_BREATHING = (12, 20)
ADULT_RESTING_PULSE = (60, 100)
PRESAGE_PULSE_RANGE = (40, 110)
PRESAGE_BREATHING_RANGE = (5, 40)


def _samples(metrics: list[dict], group: str, field: str) -> list[dict]:
    out = []
    for m in metrics:
        for s in ((m or {}).get(group) or {}).get(field) or []:
            if isinstance(s, dict) and s.get("value") is not None:
                out.append(s)
    return out


def summarize_presage(metrics: list[dict]) -> dict:
    """Summarize decoded Presage Metrics (snake_case dicts) into one reading."""
    notes: list[str] = []
    pulse = _samples(metrics, "cardio", "pulse_rate")
    breathing = _samples(metrics, "breathing", "rate")
    hrv = [h for m in metrics for h in (((m or {}).get("cardio") or {}).get("hrv") or [])]

    good_pulse = [s for s in pulse if (s.get("confidence") or 0) >= settings.presage_min_pulse_confidence]
    good_br = [s for s in breathing if (s.get("confidence") or 0) >= settings.presage_min_breathing_confidence]
    good_hrv = [h for h in hrv if (h.get("confidence") or 0) >= 50 and h.get("rmssd") is not None]

    ts = [s.get("timestamp") for s in pulse + breathing if s.get("timestamp")]
    duration_s = (max(ts) - min(ts)) / 1e6 if len(ts) >= 2 else None

    if pulse and not good_pulse:
        notes.append(f"No pulse samples reached confidence {settings.presage_min_pulse_confidence:.0f}%; pulse not used")
    if breathing and not good_br:
        notes.append("No breathing samples reached the stability threshold (needs a ~30 s steady window)")
    if not pulse and not breathing:
        notes.append("No pulse or breathing samples in payload")

    out = {
        "pulse_bpm": round(median(s["value"] for s in good_pulse), 1) if good_pulse else None,
        "pulse_confidence": round(mean(s["confidence"] for s in good_pulse), 1) if good_pulse else None,
        "breathing_bpm": round(median(s["value"] for s in good_br), 1) if good_br else None,
        "breathing_confidence": round(mean(s["confidence"] for s in good_br), 1) if good_br else None,
        "hrv_rmssd_ms": round(float(good_hrv[-1]["rmssd"]), 1) if good_hrv else None,
        "hrv_confidence": round(float(good_hrv[-1]["confidence"]), 1) if good_hrv else None,
        "n_pulse_samples": len(good_pulse),
        "n_breathing_samples": len(good_br),
        "duration_s": round(duration_s, 1) if duration_s else None,
        "quality_notes": notes,
    }
    if out["pulse_bpm"] and out["pulse_bpm"] >= PRESAGE_PULSE_RANGE[1] - 2:
        notes.append("Pulse is at Presage's upper validity limit (110 bpm); true value may be higher")
    return out


def vitals_signals(
    pulse_bpm: float | None,
    breathing_bpm: float | None,
    baseline_pulse: float | None = None,
    baseline_breathing: float | None = None,
) -> list[dict]:
    """Plain-English observations. level: 'notable' (show to coordinator) or 'info'."""
    sig: list[dict] = []
    if breathing_bpm is not None:
        lo, hi = ADULT_RESTING_BREATHING
        if breathing_bpm >= 25:
            sig.append({"kind": "breathing_high", "level": "notable",
                        "text": f"Breathing rate {breathing_bpm:g}/min is well above the typical adult resting range ({lo}-{hi}/min)"})
        elif breathing_bpm > hi:
            sig.append({"kind": "breathing_elevated", "level": "notable",
                        "text": f"Breathing rate {breathing_bpm:g}/min is above the typical adult resting range ({lo}-{hi}/min)"})
        elif breathing_bpm < 10:
            sig.append({"kind": "breathing_low", "level": "notable",
                        "text": f"Breathing rate {breathing_bpm:g}/min is below the typical adult resting range"})
        if baseline_breathing is not None and breathing_bpm - baseline_breathing >= 6:
            sig.append({"kind": "breathing_up_from_baseline", "level": "notable",
                        "text": f"Breathing rate is up {breathing_bpm - baseline_breathing:+.0f}/min from this patient's baseline ({baseline_breathing:g}/min)"})
    if pulse_bpm is not None:
        lo, hi = ADULT_RESTING_PULSE
        if pulse_bpm > hi:
            sig.append({"kind": "pulse_elevated", "level": "notable",
                        "text": f"Pulse {pulse_bpm:g} bpm is above the typical resting range ({lo}-{hi} bpm)"})
        elif pulse_bpm < 50:
            sig.append({"kind": "pulse_low", "level": "notable", "text": f"Pulse {pulse_bpm:g} bpm is low"})
        if baseline_pulse is not None and pulse_bpm - baseline_pulse >= 15:
            sig.append({"kind": "pulse_up_from_baseline", "level": "notable",
                        "text": f"Pulse is up {pulse_bpm - baseline_pulse:+.0f} bpm from this patient's baseline ({baseline_pulse:g} bpm)"})
    return sig
