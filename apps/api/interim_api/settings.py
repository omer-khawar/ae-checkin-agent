"""Runtime configuration, read from the environment (and the repo-root ``.env``).

Every knob is listed in ``.env.example``. Nothing here is secret for the demo; the
README says what a real deployment must change (``AUTH_SECRET``, ``DEMO_PASSWORD``,
``BRIDGE_TOKEN``, ``DATABASE_URL``).
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .constants import MOCK_SCENARIOS, VITALS_SOURCES

REPO_ROOT = Path(__file__).resolve().parents[3]
"""``<repo>/apps/api/interim_api/settings.py`` -> ``<repo>``."""


class Settings(BaseSettings):
    """Environment-driven settings (``pydantic-settings``)."""

    model_config = SettingsConfigDict(
        env_file=str(REPO_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    database_url: str = Field(
        default="sqlite:///./data/runtime/interim.db",
        description=(
            "SQLAlchemy URL. A relative SQLite path is resolved against the repository root "
            "and its directory is created. Postgres: postgresql+psycopg://user:pw@host/db."
        ),
    )
    demo_password: str = Field(default="interim-demo")
    auth_secret: str = Field(default="change-me-in-production")
    bridge_token: str = Field(
        default="",
        description=(
            "Shared secret the vitals bridge sends as X-Bridge-Token. Empty = the header is not "
            "enforced AND no sample may claim isMeasured=true (a real sensor needs this set on "
            "both sides, or an admin token on the POST)."
        ),
    )
    cors_origins: str = Field(default="http://localhost:5173,http://127.0.0.1:5173")
    seed_on_start: bool = Field(default=True)
    allow_demo_reset: bool = Field(
        default=False,
        description=(
            "POST /admin/reset drops every table, audit chain included. Off unless the "
            "deployment is a demo (docker compose and `make dev` turn it on)."
        ),
    )
    demo_nct_id: str = Field(default="NCT03088540")
    vitals_source: str = Field(default="mock", description="Default for the admin setting.")
    vitals_scenario: str = Field(default="resting", description="Default for the admin setting.")
    token_ttl_hours: float = Field(default=12.0)
    site_phone: str = Field(
        default="(732) 555-0142",
        description="R5.1: the study team's phone line the kiosk shows on 'Need help?', the "
        "thank-you screen and the stop screen. A fictional 555-01xx number by default.",
    )
    site_name: str = Field(default="Study team", description="R5.1: the site's display name.")
    public_data_dir: Path = Field(default=REPO_ROOT / "data" / "public")
    log_level: str = Field(default="info")
    # [packets agent] Optional LLM writer (CLAUDE.md §00 "Generated text works with no API key").
    anthropic_api_key: str = Field(
        default="",
        description="Empty (the default) = the deterministic template writer only. When set, "
        "generated text may come from Claude, accepted only if it passes validate_written.",
    )
    interim_llm_model: str = Field(
        default="claude-sonnet-5-5", description="Model id the optional LLM writer uses."
    )
    interim_writer: str = Field(
        default="auto",
        description="'auto' (LLM when a key is set, else template) or 'template' (always).",
    )

    @field_validator("cors_origins")
    @classmethod
    def _strip(cls, value: str) -> str:
        return value.strip()

    @field_validator("vitals_source")
    @classmethod
    def _known_source(cls, value: str) -> str:
        """Fail at startup, not at the first check-in, on a mistyped ``VITALS_SOURCE``."""
        if value not in VITALS_SOURCES:
            raise ValueError(f"VITALS_SOURCE must be one of {', '.join(VITALS_SOURCES)}")
        return value

    @field_validator("vitals_scenario")
    @classmethod
    def _known_scenario(cls, value: str) -> str:
        if value not in MOCK_SCENARIOS:
            raise ValueError(f"VITALS_SCENARIO must be one of {', '.join(MOCK_SCENARIOS)}")
        return value

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def resolved_database_url(self) -> str:
        """Absolute SQLite path (directory created); other URLs pass through unchanged."""
        url = self.database_url
        prefix = "sqlite:///"
        if not url.startswith(prefix):
            return url
        raw = url[len(prefix) :]
        if raw == ":memory:" or raw.startswith("file:"):
            return url
        path = Path(raw)
        if not path.is_absolute():
            path = (REPO_ROOT / raw).resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        return f"{prefix}{path.as_posix()}"

    @property
    def database_label(self) -> str:
        """What ``GET /health`` shows: the backend name, never credentials."""
        url = self.database_url
        return url.split("://", 1)[0] if "://" in url else url
