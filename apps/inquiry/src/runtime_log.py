from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from src.errors import RuntimeLogError
from src.models import RuntimeLogEntry


class RunLogger:
    """Writes structured runtime logs in JSONL format.

    Each run produces one JSON line with run_id, job_name, timestamps,
    status, counters, and error summary.

    Usage:
        logger = RunLogger(".runtime/runs.jsonl")
        run_id = logger.start_run("fetch_email")
        # ... do work ...
        logger.end_run(run_id, status="completed", counters={"fetched": 10})
    """

    def __init__(self, file_path: str = ".runtime/runs.jsonl") -> None:
        self._file_path = Path(file_path)

    def start_run(self, job_name: str, extra: Dict[str, Any] | None = None) -> str:
        run_id = _generate_run_id(job_name)
        entry = RuntimeLogEntry(
            run_id=run_id,
            job_name=job_name,
            started_at=_now_iso(),
            status="running",
            extra=extra or {},
        )
        self._append(entry)
        return run_id

    def end_run(
        self,
        run_id: str,
        status: str = "completed",
        counters: Dict[str, int] | None = None,
        error_summary: str | None = None,
        extra: Dict[str, Any] | None = None,
    ) -> None:
        entry = RuntimeLogEntry(
            run_id=run_id,
            job_name="",
            started_at="",
            finished_at=_now_iso(),
            status=status,
            counters=counters or {},
            error_summary=error_summary,
            extra=extra or {},
        )
        self._overwrite(run_id, entry)

    def log_event(
        self,
        run_id: str,
        event: str,
        details: Dict[str, Any] | None = None,
    ) -> None:
        entry = RuntimeLogEntry(
            run_id=run_id,
            job_name="",
            started_at=_now_iso(),
            status="event",
            extra={"event": event, "details": details or {}},
        )
        self._append(entry)

    def get_run(self, run_id: str) -> Optional[RuntimeLogEntry]:
        for entry in self.read_all():
            if entry.run_id == run_id:
                return entry
        return None

    def read_all(self) -> List[RuntimeLogEntry]:
        if not self._file_path.exists():
            return []
        entries: List[RuntimeLogEntry] = []
        try:
            with open(self._file_path, "r") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                        entries.append(RuntimeLogEntry.from_dict(data))
                    except (json.JSONDecodeError, KeyError):
                        pass
        except OSError as e:
            raise RuntimeLogError(f"Failed to read log file: {e}") from e
        return entries

    def _append(self, entry: RuntimeLogEntry) -> None:
        os.makedirs(self._file_path.parent, exist_ok=True)
        try:
            with open(self._file_path, "a") as f:
                f.write(json.dumps(entry.to_dict(), ensure_ascii=False) + "\n")
        except OSError as e:
            raise RuntimeLogError(f"Failed to write log: {e}") from e

    def _overwrite(self, run_id: str, entry: RuntimeLogEntry) -> None:
        lines: List[str] = []
        found = False
        if self._file_path.exists():
            try:
                with open(self._file_path, "r") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            data = json.loads(line)
                            if data.get("run_id") == run_id:
                                lines.append(
                                    json.dumps(entry.to_dict(), ensure_ascii=False)
                                )
                                found = True
                            else:
                                lines.append(line)
                        except json.JSONDecodeError:
                            lines.append(line)
            except OSError as e:
                raise RuntimeLogError(f"Failed to read log for overwrite: {e}") from e

        if not found:
            lines.append(json.dumps(entry.to_dict(), ensure_ascii=False))

        os.makedirs(self._file_path.parent, exist_ok=True)
        try:
            with open(self._file_path, "w") as f:
                f.write("\n".join(lines) + "\n")
        except OSError as e:
            raise RuntimeLogError(f"Failed to write log for overwrite: {e}") from e


def _generate_run_id(job_name: str) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    sanitized = job_name.replace(" ", "_").replace("/", "_")
    return f"{sanitized}_{ts}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
