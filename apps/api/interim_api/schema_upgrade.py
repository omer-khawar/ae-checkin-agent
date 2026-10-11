"""Additive schema upgrade for an existing database (no migration framework).

``SQLModel.metadata.create_all`` creates missing *tables* but never adds a column to a
table that already exists, so a model that gains a field (``Session.consent_basis``,
CLAUDE.md §00) would break every SELECT on a database created by an earlier build with
"no such column". :func:`add_missing_columns` closes that gap for the one safe case:

* a column that is **nullable** is added as-is (existing rows read ``NULL``);
* a **NOT NULL** column is added only when the model gives it a scalar Python default
  (``str``/``int``/``float``/``bool``), which becomes the SQL ``DEFAULT`` for old rows;
* anything else (a NOT NULL column without a usable default, a primary-key or unique
  column) is skipped with a warning: that needs a real migration or ``POST /admin/reset``.

Nothing is ever dropped, renamed or retyped. Runs inside :func:`interim_api.db.create_all`,
so it applies at startup and after an admin reset (where it is a no-op).
"""

from __future__ import annotations

import logging

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.schema import Column
from sqlmodel import SQLModel

log = logging.getLogger("interim_api.schema_upgrade")


def _default_literal(column: Column) -> str | None:  # type: ignore[type-arg]
    default = column.default
    value = getattr(default, "arg", None) if default is not None else None
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int | float):
        return repr(value)
    if isinstance(value, str):
        return "'" + value.replace("'", "''") + "'"
    return None


def add_missing_columns(engine: Engine) -> list[str]:
    """Add every model column missing from an existing table; returns ``table.column`` names."""
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    added: list[str] = []
    with engine.begin() as conn:
        for table in SQLModel.metadata.sorted_tables:
            if table.name not in existing_tables:
                continue
            present = {c["name"] for c in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name in present:
                    continue
                if column.primary_key or column.unique:
                    log.warning(
                        "column %s.%s is missing and is a key; reset the database",
                        table.name,
                        column.name,
                    )
                    continue
                col_type = column.type.compile(dialect=engine.dialect)
                ddl = f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {col_type}'
                if not column.nullable:
                    literal = _default_literal(column)
                    if literal is None:
                        log.warning(
                            "column %s.%s is missing, NOT NULL and has no scalar default; "
                            "reset the database",
                            table.name,
                            column.name,
                        )
                        continue
                    ddl += f" NOT NULL DEFAULT {literal}"
                conn.execute(text(ddl))
                added.append(f"{table.name}.{column.name}")
    if added:
        log.info("schema upgrade: added column(s) %s", ", ".join(added))
    return added


__all__ = ["add_missing_columns"]
