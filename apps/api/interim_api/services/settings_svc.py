"""Admin settings (``Setting`` table) and the public subset the kiosk/bridge read.

Three keys: ``vitals_source``, ``mock_scenario``, ``simulated_as_measured``
(default OFF; the demo toggle that lets simulated samples satisfy the
corroboration gate). Defaults come from the environment on first use.
``min_confidence`` and the timing gates are **not** settings: they are read
from the rules table so the bridge, the engine and the UI share one threshold.
"""

from __future__ import annotations

from typing import Any

from sqlmodel import Session as DbSession

from interim_rules.tables import vitals_config

from ..audit import Actor, append_event
from ..models import Setting
from ..settings import Settings
from ..util import dump_json, load_json, now_iso
from ..writers.base import writer_status

SETTING_KEYS: tuple[str, ...] = ("vitals_source", "mock_scenario", "simulated_as_measured")


def defaults(settings: Settings) -> dict[str, Any]:
    return {
        "vitals_source": settings.vitals_source,
        "mock_scenario": settings.vitals_scenario,
        "simulated_as_measured": False,
    }


def get_admin_settings(db: DbSession, settings: Settings) -> dict[str, Any]:
    out = defaults(settings)
    for key in SETTING_KEYS:
        row = db.get(Setting, key)
        if row is not None:
            out[key] = load_json(row.value_json)
    return out


def ensure_defaults(db: DbSession, settings: Settings, now: str | None = None) -> None:
    """Write the default rows once so the table is self-describing."""
    stamp = now or now_iso()
    for key, value in defaults(settings).items():
        if db.get(Setting, key) is None:
            db.add(Setting(key=key, value_json=dump_json(value), updated_at=stamp))
    db.flush()


def update_settings(
    db: DbSession,
    settings: Settings,
    actor: Actor,
    changes: dict[str, Any],
    *,
    now: str | None = None,
) -> dict[str, Any]:
    """Apply the non-``None`` keys of ``changes``; audit ``settings.changed`` with before/after."""
    stamp = now or now_iso()
    before = get_admin_settings(db, settings)
    applied = {k: v for k, v in changes.items() if k in SETTING_KEYS and v is not None}
    for key, value in applied.items():
        row = db.get(Setting, key)
        if row is None:
            db.add(Setting(key=key, value_json=dump_json(value), updated_at=stamp))
        else:
            row.value_json = dump_json(value)
            row.updated_at = stamp
            db.add(row)
    db.flush()
    after = get_admin_settings(db, settings)
    append_event(
        db,
        actor,
        "settings.changed",
        "settings",
        "admin",
        {"before": before, "after": after, "changed": applied},
        ts_utc=stamp,
    )
    return after


def public_settings(db: DbSession, settings: Settings) -> dict[str, Any]:
    cfg = vitals_config()
    admin = get_admin_settings(db, settings)
    gates = cfg.min_window_s
    return {
        "vitals_source": admin["vitals_source"],
        "mock_scenario": admin["mock_scenario"],
        "simulated_as_measured": admin["simulated_as_measured"],
        "site_phone": settings.site_phone,
        "site_name": settings.site_name,
        "min_confidence": cfg.min_confidence,
        "timing_gates": {
            "pulse_s": gates.get("pulse", 12.0),
            "breathing_s": gates.get("breathing", 30.0),
            "hrv_s": gates.get("hrv", 60.0),
        },
        "plausibility": {
            metric: {"min": b.min, "max": b.max, "unit": b.unit}
            for metric, b in cfg.plausibility.items()
        },
        # [packets agent] R3.2 writer selection: writer, llm_configured (never the key).
        **writer_status(settings),
    }


def effective_rule_settings(
    db: DbSession, settings: Settings, override: dict[str, Any] | None
) -> dict[str, Any]:
    """``RuleSettings`` dict for the engine: table/admin values with the admin override on top."""
    admin = get_admin_settings(db, settings)
    out: dict[str, Any] = {
        "simulated_as_measured": bool(admin["simulated_as_measured"]),
        "min_confidence": None,
        "dedup_window_days": None,
    }
    for key, value in (override or {}).items():
        if key in out and value is not None:
            out[key] = value
    return out
