"""Typed settings loaded from environment / .env file.

Every service reads config through `get_settings()`. Validated on startup so
mis-configuration fails loudly at boot, never silently at request time.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

Environment = Literal["local", "dev", "staging", "prod"]
LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]


class Settings(BaseSettings):
    """Aegis runtime configuration.

    Loaded from:
        1. Environment variables (highest priority)
        2. .env file at repo root
        3. Defaults defined below
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ---------- Environment ----------
    aegis_env: Environment = Field(default="local")
    aegis_log_level: LogLevel = Field(default="INFO")

    # ---------- Google Cloud ----------
    gcp_project_id: str = Field(default="aegis-local")
    gcp_region: str = Field(default="asia-south1")
    google_application_credentials: str | None = Field(default=None)

    # ---------- Vertex AI / Gemini ----------
    vertex_ai_location: str = Field(default="asia-south1")
    gemini_pro_model: str = Field(default="gemini-2.5-pro")
    gemini_flash_model: str = Field(default="gemini-2.5-flash")
    medgemma_endpoint: str | None = Field(default=None)
    google_api_key: str | None = Field(default=None)

    # ---------- Firebase ----------
    firebase_project_id: str = Field(default="aegis-local")
    firebase_admin_credentials: str | None = Field(default=None)

    # ---------- Firestore ----------
    firestore_emulator_host: str | None = Field(default=None)
    firestore_database: str = Field(default="(default)")

    # ---------- Pub/Sub ----------
    pubsub_emulator_host: str | None = Field(default=None)
    pubsub_topic_raw_frames: str = Field(default="raw-frames")
    pubsub_topic_audio: str = Field(default="audio-chunks")
    pubsub_topic_sensors: str = Field(default="sensor-events")
    pubsub_topic_perceptual: str = Field(default="perceptual-signals")
    pubsub_topic_incidents: str = Field(default="incident-events")
    pubsub_topic_dispatch: str = Field(default="dispatch-events")
    pubsub_topic_audit: str = Field(default="audit-events")

    # ---------- Cloud Storage ----------
    storage_bucket_evidence: str = Field(default="aegis-evidence-local")
    storage_bucket_reports: str = Field(default="aegis-reports-local")
    storage_bucket_assets: str = Field(default="aegis-venue-assets-local")

    # ---------- BigQuery ----------
    bq_dataset_audit: str = Field(default="aegis_audit")
    bq_dataset_analytics: str = Field(default="aegis_analytics")
    bq_dataset_learning: str = Field(default="aegis_learning")

    # ---------- Security ----------
    service_internal_secret: str = Field(default="change-me")
    webhook_signing_key: str | None = Field(default=None)
    # CORS origins for the API. Default is permissive for local dev; in production
    # set via environment variable (comma-separated) to the specific frontend URLs.
    cors_allowed_origins: list[str] = Field(
        default=[
            "http://localhost:3000",
            "http://localhost:3001",
            "http://localhost:3002",
        ]
    )

    @property
    def is_local(self) -> bool:
        """True when running locally (emulators on, relaxed auth)."""
        return self.aegis_env == "local"

    @property
    def is_prod(self) -> bool:
        return self.aegis_env == "prod"

    @property
    def using_firestore_emulator(self) -> bool:
        return bool(self.firestore_emulator_host)

    @property
    def using_pubsub_emulator(self) -> bool:
        return bool(self.pubsub_emulator_host)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return a cached Settings instance (singleton)."""
    return Settings()
