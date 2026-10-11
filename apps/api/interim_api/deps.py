"""FastAPI dependencies shared by the routers."""

from __future__ import annotations

from fastapi import Query, Request

from .db import Database
from .settings import Settings


def get_database(request: Request) -> Database:
    return request.app.state.database  # type: ignore[no-any-return]


def get_settings(request: Request) -> Settings:
    return request.app.state.settings  # type: ignore[no-any-return]


class Pagination:
    """``?limit=&offset=`` (CONTRACTS.md); lists return ``{items, total, limit, offset}``."""

    def __init__(
        self,
        limit: int = Query(50, ge=1, le=500, description="page size"),
        offset: int = Query(0, ge=0, description="items to skip"),
    ) -> None:
        self.limit = limit
        self.offset = offset

    def page(self, items: list[object]) -> dict[str, object]:
        return {
            "items": items[self.offset : self.offset + self.limit],
            "total": len(items),
            "limit": self.limit,
            "offset": self.offset,
        }
