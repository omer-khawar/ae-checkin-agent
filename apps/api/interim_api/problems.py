"""RFC 7807 ``application/problem+json`` for every error the API emits.

Three handlers cover everything: ``HTTPException`` (ours and Starlette's),
``RequestValidationError`` (422 with the field errors as an ``errors`` extension)
and a last-resort 500 that never leaks a stack trace. ``raise problem(...)`` is
the one way service code signals an HTTP error; it keeps the title/detail split
the web client renders (``ApiError`` in ``apps/web/src/lib/api.ts``).
"""

from __future__ import annotations

import logging
from http import HTTPStatus
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

PROBLEM_TYPE = "about:blank"
MEDIA_TYPE = "application/problem+json"

log = logging.getLogger("interim_api")


class Problem(HTTPException):
    """An HTTP error with an RFC 7807 title and optional extension members."""

    def __init__(
        self,
        status: int,
        detail: str,
        *,
        title: str | None = None,
        type_: str = PROBLEM_TYPE,
        headers: dict[str, str] | None = None,
        **extensions: Any,
    ) -> None:
        super().__init__(status_code=status, detail=detail, headers=headers)
        self.title = title or HTTPStatus(status).phrase
        self.type_ = type_
        self.extensions = extensions


def problem(status: int, detail: str, **kwargs: Any) -> Problem:
    """``raise problem(404, "No participant with usubjid P-999")``."""
    return Problem(status, detail, **kwargs)


def _render(
    request: Request,
    status: int,
    title: str,
    detail: str | None,
    *,
    type_: str = PROBLEM_TYPE,
    headers: dict[str, str] | None = None,
    **extensions: Any,
) -> JSONResponse:
    body: dict[str, Any] = {
        "type": type_,
        "title": title,
        "status": status,
        "instance": str(request.url.path),
    }
    if detail:
        body["detail"] = detail
    body.update(extensions)
    return JSONResponse(body, status_code=status, media_type=MEDIA_TYPE, headers=headers)


def install_problem_handlers(app: FastAPI) -> None:
    """Register the three exception handlers on ``app``."""

    @app.exception_handler(Problem)
    async def _problem(request: Request, exc: Problem) -> JSONResponse:
        return _render(
            request,
            exc.status_code,
            exc.title,
            str(exc.detail),
            type_=exc.type_,
            headers=exc.headers,
            **exc.extensions,
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
        title = HTTPStatus(exc.status_code).phrase
        return _render(request, exc.status_code, title, detail, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        errors = []
        for err in exc.errors():
            loc = ".".join(str(part) for part in err.get("loc", ()))
            errors.append({"loc": loc, "msg": err.get("msg", ""), "type": err.get("type", "")})
        summary = "; ".join(f"{e['loc']}: {e['msg']}" for e in errors[:5]) or "invalid request"
        return _render(request, 422, "Unprocessable Entity", summary, errors=errors)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error on %s %s", request.method, request.url.path)
        return _render(
            request,
            500,
            "Internal Server Error",
            "The server hit an unexpected error; see the API log for the trace.",
        )
