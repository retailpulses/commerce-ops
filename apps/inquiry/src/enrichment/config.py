"""Configuration boundary for the active VPS enrichment runtime."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict

import yaml

from src.errors import ConfigError, MissingSecretError


class EnrichmentConfig:
    """Load only the canonical database and browser-enrichment settings."""

    def __init__(self, config_path: str | Path = "config.yaml") -> None:
        path = Path(config_path)
        if not path.exists():
            raise ConfigError(f"Config file not found: {path}")
        parsed = yaml.safe_load(path.read_text())
        if not isinstance(parsed, dict):
            raise ConfigError(f"Config file is empty or invalid: {path}")
        self._raw: Dict[str, Any] = parsed
        missing = [
            key
            for key in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")
            if not os.environ.get(key)
        ]
        if missing:
            raise MissingSecretError(
                f"Required environment variable(s) not set: {', '.join(missing)}"
            )

    @property
    def supabase_url(self) -> str:
        return os.environ["SUPABASE_URL"]

    @property
    def supabase_service_role_key(self) -> str:
        return os.environ["SUPABASE_SERVICE_ROLE_KEY"]

    @property
    def inquiry_enrichment_writes_enabled(self) -> bool:
        return os.environ.get("INQUIRY_ENRICHMENT_WRITES_ENABLED", "") in {
            "1", "true"
        }

    @property
    def log_file(self) -> str:
        return str(self._raw.get("runtime", {}).get("log_file", ".runtime/runs.jsonl"))

    @property
    def enrichment_chrome_data_dir(self) -> str:
        return str(self._raw.get("enrichment", {}).get(
            "chrome_data_dir",
            os.path.expanduser("~/Library/Application Support/Google/Chrome"),
        ))

    @property
    def enrichment_headless(self) -> bool:
        return bool(self._raw.get("enrichment", {}).get("headless", True))

    @property
    def enrichment_timeout(self) -> int:
        return int(self._raw.get("enrichment", {}).get("timeout", 120))

    @property
    def enrichment_default_profile(self) -> str:
        return str(self._raw.get("enrichment", {}).get(
            "default_chrome_profile", "Default"
        ))

    @property
    def enrichment_shop_profiles(self) -> Dict[str, str]:
        raw = self._raw.get("enrichment", {}).get("shop_profiles", {})
        return {str(key): str(value) for key, value in raw.items()}
