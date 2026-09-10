from __future__ import annotations

from pathlib import Path

from src.runtime_log import RunLogger


def test_start_run(temp_dir: Path) -> None:
    log_path = str(temp_dir / "runs.jsonl")
    logger = RunLogger(log_path)

    run_id = logger.start_run("fetch_email")
    assert run_id.startswith("fetch_email_")

    entries = logger.read_all()
    assert len(entries) == 1
    assert entries[0].run_id == run_id
    assert entries[0].job_name == "fetch_email"
    assert entries[0].status == "running"


def test_end_run(temp_dir: Path) -> None:
    log_path = str(temp_dir / "runs.jsonl")
    logger = RunLogger(log_path)

    run_id = logger.start_run("classify_link")
    logger.end_run(
        run_id,
        status="completed",
        counters={"classified": 5, "linked": 3},
    )

    entry = logger.get_run(run_id)
    assert entry is not None
    assert entry.status == "completed"
    assert entry.counters == {"classified": 5, "linked": 3}
    assert entry.finished_at is not None


def test_end_run_updates_in_place(temp_dir: Path) -> None:
    log_path = str(temp_dir / "runs.jsonl")
    logger = RunLogger(log_path)

    run_id = logger.start_run("fetch")
    logger.end_run(run_id, status="failed", error_summary="timeout")

    entry = logger.get_run(run_id)
    assert entry.status == "failed"
    assert entry.error_summary == "timeout"

    entries = logger.read_all()
    assert len(entries) == 1


def test_log_event(temp_dir: Path) -> None:
    log_path = str(temp_dir / "runs.jsonl")
    logger = RunLogger(log_path)

    run_id = logger.start_run("test")
    logger.log_event(run_id, "progress", {"step": 1})

    entries = logger.read_all()
    assert len(entries) == 2

    event_entry = entries[1]
    assert event_entry.status == "event"


def test_get_run_not_found(temp_dir: Path) -> None:
    log_path = str(temp_dir / "runs.jsonl")
    logger = RunLogger(log_path)
    assert logger.get_run("nonexistent") is None


def test_read_all_empty_file(temp_dir: Path) -> None:
    log_path = str(temp_dir / "runs.jsonl")
    logger = RunLogger(log_path)
    assert logger.read_all() == []


def test_multiple_runs(temp_dir: Path) -> None:
    log_path = str(temp_dir / "runs.jsonl")
    logger = RunLogger(log_path)

    r1 = logger.start_run("job_a")
    r2 = logger.start_run("job_b")
    logger.end_run(r1, status="completed")
    logger.end_run(r2, status="completed")

    entries = logger.read_all()
    assert len(entries) == 2
    assert all(e.status == "completed" for e in entries)


def test_log_creates_dir(temp_dir: Path) -> None:
    nested = str(temp_dir / "sub" / "nested" / "runs.jsonl")
    logger = RunLogger(nested)
    logger.start_run("test")
    assert Path(nested).exists()
