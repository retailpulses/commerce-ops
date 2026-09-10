from pathlib import Path

import pytest

from src.enrichment.config import EnrichmentConfig
from src.errors import MissingSecretError


def test_enrichment_config_is_fail_closed_and_canonical(sample_config_yaml: Path):
    cfg = EnrichmentConfig(sample_config_yaml)
    assert cfg.supabase_url == "http://127.0.0.1:55431"
    assert cfg.inquiry_enrichment_writes_enabled is False


def test_enrichment_config_requires_database_credentials(
    sample_config_yaml: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    with pytest.raises(MissingSecretError, match="SUPABASE_SERVICE_ROLE_KEY"):
        EnrichmentConfig(sample_config_yaml)


@pytest.mark.parametrize("value, expected", [
    ("true", True), ("1", True), ("false", False), ("TRUE", False), ("yes", False)
])
def test_enrichment_write_switch_requires_an_explicit_value(
    sample_config_yaml: Path,
    monkeypatch: pytest.MonkeyPatch,
    value: str,
    expected: bool,
):
    monkeypatch.setenv("INQUIRY_ENRICHMENT_WRITES_ENABLED", value)
    assert EnrichmentConfig(sample_config_yaml).inquiry_enrichment_writes_enabled is expected
