"""Engine, sessions and the append-only guard for the audit table.

* :func:`make_engine` builds the SQLAlchemy engine for ``DATABASE_URL`` (SQLite
  gets ``check_same_thread=False`` because FastAPI runs sync endpoints in a
  threadpool; foreign keys are not enforced because the demo keeps referential
  integrity in the service layer and SQLite's ``PRAGMA`` would differ from
  Postgres anyway).
* :func:`create_all` / :func:`drop_all` wrap ``SQLModel.metadata``.
* :class:`Database` holds the engine plus the **single-writer lock** every
  mutating request takes (see ``write_scope``): SQLite serializes writers
  anyway, and the audit chain needs ``read head -> hash -> insert`` to be
  atomic across threads. A Postgres deployment would swap the lock for an
  advisory lock on the audit head (documented in the README).
* The module-level SQLAlchemy listeners make ``audit_events`` append-only:
  any ORM flush that would UPDATE or DELETE an :class:`AuditEvent`, and any
  Core ``update()`` / ``delete()`` statement aimed at that table, raises
  :class:`AuditImmutableError` before it reaches the database. ``DROP TABLE``
  (the admin reset) is DDL and deliberately not covered.
"""

from __future__ import annotations

import contextlib
import logging
import threading
from collections.abc import Iterator

from sqlalchemy import event
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.orm import Mapper
from sqlalchemy.pool import StaticPool
from sqlalchemy.sql import Delete, Update
from sqlmodel import Session as DbSession
from sqlmodel import SQLModel, create_engine

from .models import AuditEvent

log = logging.getLogger("interim_api.db")


class AuditImmutableError(RuntimeError):
    """Raised when anything tries to UPDATE or DELETE an audit event."""


# --------------------------------------------------------------------------- #
# Append-only guard (registered once per process, applies to every engine)
# --------------------------------------------------------------------------- #


@event.listens_for(AuditEvent, "before_update")
def _refuse_orm_update(mapper: Mapper, connection: Connection, target: AuditEvent) -> None:
    raise AuditImmutableError(f"audit event {target.id} is append-only and cannot be updated")


@event.listens_for(AuditEvent, "before_delete")
def _refuse_orm_delete(mapper: Mapper, connection: Connection, target: AuditEvent) -> None:
    raise AuditImmutableError(f"audit event {target.id} is append-only and cannot be deleted")


def _guard_core_statement(
    conn: Connection,
    clauseelement: object,
    multiparams: object,
    params: object,
    execution_options: object,
) -> None:
    if isinstance(clauseelement, Update | Delete):
        table = getattr(clauseelement, "table", None)
        name = getattr(table, "name", None)
        if name == AuditEvent.__tablename__:
            kind = "UPDATE" if isinstance(clauseelement, Update) else "DELETE"
            raise AuditImmutableError(
                f"{kind} on audit_events refused: the audit log is append-only"
            )


def _install_core_guard(engine: Engine) -> None:
    event.listen(engine, "before_execute", _guard_core_statement)


# --------------------------------------------------------------------------- #
# Engine
# --------------------------------------------------------------------------- #


def make_engine(url: str, *, echo: bool = False) -> Engine:
    """Create an engine with the SQLite tweaks the threaded server needs."""
    kwargs: dict[str, object] = {"echo": echo}
    if url.startswith("sqlite"):
        connect_args: dict[str, object] = {"check_same_thread": False, "timeout": 30}
        kwargs["connect_args"] = connect_args
        if url.endswith(":memory:"):
            kwargs["poolclass"] = StaticPool
    engine = create_engine(url, **kwargs)
    _install_core_guard(engine)
    return engine


def create_all(engine: Engine) -> None:
    SQLModel.metadata.create_all(engine)
    # Additive columns on tables an earlier build created (create_all never alters a table).
    from .schema_upgrade import add_missing_columns

    add_missing_columns(engine)


def drop_all(engine: Engine) -> None:
    SQLModel.metadata.drop_all(engine)


class Database:
    """Engine + write lock, stored on ``app.state``."""

    def __init__(self, engine: Engine) -> None:
        self.engine = engine
        # A plain Lock (not RLock): FastAPI may run a yield-dependency's teardown on a
        # different threadpool thread than its setup, and only Lock allows that.
        self.write_lock = threading.Lock()

    def session(self) -> DbSession:
        return DbSession(self.engine, expire_on_commit=False)

    @contextlib.contextmanager
    def write_scope(self) -> Iterator[DbSession]:
        """A session under the single-writer lock; commits on success, rolls back on error."""
        with self.write_lock:
            session = self.session()
            try:
                yield session
                session.commit()
            except BaseException:
                session.rollback()
                raise
            finally:
                session.close()

    @contextlib.contextmanager
    def read_scope(self) -> Iterator[DbSession]:
        session = self.session()
        try:
            yield session
        finally:
            session.close()

    def dispose(self) -> None:
        self.engine.dispose()
