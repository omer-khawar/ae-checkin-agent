"""App settings. Every value can be overridden with an environment variable or a .env file."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "AE Capture Desk API"
    study_id: str = "HACKRU-AE-001"
    site_name: str = "Rutgers Demo Research Site"

    # SQLite by default (zero setup). For Postgres use e.g.
    # postgresql+psycopg://user:pass@host:5432/dbname  (and `pip install "psycopg[binary]"`)
    database_url: str = "sqlite:///./ae_capture.db"

    # Load the synthetic personas / notes on startup if the database is empty.
    seed_on_startup: bool = True

    # Comma-separated list of allowed frontend origins, or "*" for any (fine for a hackathon demo).
    cors_origins: str = "*"

    # Hours the site has to report a serious AE once it becomes aware of it (ICH E6: "immediately",
    # sponsors typically require within 24h). Used for the SAE clock.
    sae_report_hours: int = 24

    # Presage SmartSpectra: minimum confidence (0-100) for a sample to count. Presage marks pulse
    # "stable" at >=40 and breathing "stable" at >=45.
    presage_min_pulse_confidence: float = 40.0
    presage_min_breathing_confidence: float = 45.0

    @property
    def cors_origin_list(self) -> list[str]:
        if self.cors_origins.strip() == "*":
            return ["*"]
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
