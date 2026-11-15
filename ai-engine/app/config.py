from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    SERVICE_TOKEN: str = Field(
        validation_alias="ANALYTICS_SERVICE_TOKEN",
        min_length=32,
    )
    SERVICE_VERSION: str = "1.0.0"


settings = Settings()
