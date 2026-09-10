from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ACTIVE_PATHS = (
    ROOT / "apps" / "worker" / "src",
    ROOT / "apps" / "dashboard" / "functions",
    ROOT / "src",
    ROOT / "scripts",
)
FORBIDDEN = (
    "api.baserow.io",
    "BASEROW_TOKEN",
    "BASEROW_API_TOKEN",
    "BASEROW_BASE_URL",
    "baserow_client",
)


def test_active_runtime_has_no_baserow_dependency() -> None:
    violations: list[str] = []
    for root in ACTIVE_PATHS:
        for path in root.rglob("*"):
            if not path.is_file() or "node_modules" in path.parts or "__pycache__" in path.parts:
                continue
            try:
                text = path.read_text()
            except UnicodeDecodeError:
                continue
            for token in FORBIDDEN:
                if token.lower() in text.lower():
                    violations.append(f"{path.relative_to(ROOT)}: {token}")

    assert violations == [], "Active Baserow dependencies found:\n" + "\n".join(violations)
