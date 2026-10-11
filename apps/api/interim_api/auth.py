"""Demo authentication (CONTRACTS.md §2 "Auth").

* ``POST /auth/login {username, password}`` checks the password against
  ``DEMO_PASSWORD`` (shared by the three seeded users) and returns a token.
* Token = ``username.role.exp.sig`` where ``sig = HMAC-SHA256(AUTH_SECRET,
  "username.role.exp")`` (hex). Stdlib ``hmac``/``hashlib`` only; no PyJWT.
* ``Authorization: Bearer <token>``. Roles are enforced server-side with the
  dependencies below; the web app's client-side gating is cosmetic.
* Kiosk endpoints are unauthenticated but accept an *optional* bearer so an
  admin (seed script, eval harness) can use the override fields (D-004).

This is a demo auth model. Production needs SSO (OIDC/SAML), per-user
identities in the audit log, token revocation and password hashing per user;
the README lists these.
"""

from __future__ import annotations

import hashlib
import hmac
import time
from collections.abc import Callable

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .audit import Actor
from .problems import problem
from .settings import Settings

ROLES: tuple[str, ...] = ("coordinator", "investigator", "admin")
DASHBOARD_ROLES: tuple[str, ...] = ROLES

_bearer = HTTPBearer(auto_error=False)


def _sign(secret: str, message: str) -> str:
    return hmac.new(secret.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()


def issue_token(settings: Settings, username: str, role: str, *, now: float | None = None) -> str:
    exp = int((now if now is not None else time.time()) + settings.token_ttl_hours * 3600)
    message = f"{username}.{role}.{exp}"
    return f"{message}.{_sign(settings.auth_secret, message)}"


def parse_token(settings: Settings, token: str, *, now: float | None = None) -> Actor:
    """Return the actor encoded in a valid token; raise 401 otherwise."""
    parts = token.strip().split(".")
    if len(parts) != 4:
        raise problem(401, "Malformed bearer token", title="Unauthorized")
    username, role, exp_text, sig = parts
    message = f"{username}.{role}.{exp_text}"
    if not hmac.compare_digest(_sign(settings.auth_secret, message), sig):
        raise problem(401, "Bearer token signature is invalid", title="Unauthorized")
    try:
        exp = int(exp_text)
    except ValueError as exc:
        raise problem(401, "Malformed bearer token", title="Unauthorized") from exc
    if exp < (now if now is not None else time.time()):
        raise problem(401, "Bearer token has expired; log in again", title="Unauthorized")
    if role not in ROLES:
        raise problem(401, f"Unknown role {role!r} in token", title="Unauthorized")
    return Actor(id=username, role=role)


def check_password(settings: Settings, password: str) -> bool:
    return hmac.compare_digest(password.encode("utf-8"), settings.demo_password.encode("utf-8"))


# --------------------------------------------------------------------------- #
# FastAPI dependencies
# --------------------------------------------------------------------------- #


def get_settings(request: Request) -> Settings:
    return request.app.state.settings  # type: ignore[no-any-return]


def optional_actor(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> Actor | None:
    """The bearer's actor if a token is present (and valid), else ``None``."""
    if credentials is None:
        return None
    return parse_token(get_settings(request), credentials.credentials)


def current_actor(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> Actor:
    if credentials is None:
        raise problem(
            401,
            "A bearer token is required; POST /api/v1/auth/login first",
            title="Unauthorized",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return parse_token(get_settings(request), credentials.credentials)


def require_role(*roles: str) -> Callable[..., Actor]:
    """Dependency factory: ``Depends(require_role("admin"))``."""

    allowed = roles or ROLES

    def _dep(actor: Actor = Depends(current_actor)) -> Actor:
        if actor.role not in allowed:
            raise problem(
                403,
                f"This action needs role {' or '.join(allowed)}; you are {actor.role}",
                title="Forbidden",
            )
        return actor

    return _dep


CLINICAL_ROLES: tuple[str, ...] = ("coordinator", "investigator")
"""Roles that may make clinical decisions (ack an escalation, confirm/reject/edit a draft,
edit a packet, answer a sponsor query). The admin/dev role (CLAUDE.md §3.1) runs settings,
reset and eval only: it must not clear an urgent page or confirm an AE."""


def require_clinical() -> Callable[..., Actor]:
    """``Depends(require_clinical())``: coordinator or investigator only."""
    return require_role(*CLINICAL_ROLES)


def require_admin_for(actor: Actor | None, what: str) -> Actor:
    """403 unless ``actor`` is an admin; used for the override fields on kiosk endpoints."""
    if actor is None or not actor.is_admin:
        who = "anonymous" if actor is None else actor.role
        raise problem(403, f"{what} is admin-only (caller is {who})", title="Forbidden")
    return actor


def check_bridge_token(settings: Settings, header_value: str | None) -> None:
    """Enforce ``X-Bridge-Token`` only when ``BRIDGE_TOKEN`` is configured."""
    if not settings.bridge_token:
        return
    if header_value is None or not hmac.compare_digest(
        header_value.encode("utf-8"), settings.bridge_token.encode("utf-8")
    ):
        raise problem(401, "X-Bridge-Token is missing or wrong", title="Unauthorized")
