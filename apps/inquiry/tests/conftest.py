from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Generator

import pytest


@pytest.fixture(autouse=True)
def _env() -> Generator[None, None, None]:
    old = dict(os.environ)
    os.environ["SUPABASE_URL"] = "http://127.0.0.1:55431"
    os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "local-test-service-role-key"
    yield
    os.environ.clear()
    os.environ.update(old)


@pytest.fixture
def temp_dir() -> Generator[Path, None, None]:
    with tempfile.TemporaryDirectory() as directory:
        yield Path(directory)


@pytest.fixture
def sample_config_yaml(temp_dir: Path) -> Path:
    path = temp_dir / "config.yaml"
    path.write_text(
        """\
runtime:
  log_file: ".runtime/runs.jsonl"
enrichment:
  chrome_data_dir: "/tmp/mercari-playwright-chrome"
  headless: true
  timeout: 120
  default_chrome_profile: "shop4"
  shop_profiles:
    Shop4: "shop4"
"""
    )
    return path
