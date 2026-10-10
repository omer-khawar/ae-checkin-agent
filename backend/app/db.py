from collections.abc import Iterator

from sqlmodel import Session, SQLModel, create_engine

from app.config import settings

_connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
engine = create_engine(settings.database_url, connect_args=_connect_args)


def init_db() -> None:
    # Import models so their tables are registered before create_all.
    from app import models  # noqa: F401

    SQLModel.metadata.create_all(engine)


def reset_db() -> None:
    from app import models  # noqa: F401

    SQLModel.metadata.drop_all(engine)
    SQLModel.metadata.create_all(engine)


def new_session() -> Session:
    # expire_on_commit=False so objects stay readable (and serializable) after commit.
    return Session(engine, expire_on_commit=False)


def get_session() -> Iterator[Session]:
    with new_session() as session:
        yield session
