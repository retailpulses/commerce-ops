from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict


@dataclass
class RuntimeLogEntry:
    run_id: str
    job_name: str
    started_at: str
    finished_at: str | None = None
    status: str = "running"
    counters: Dict[str, int] = field(default_factory=dict)
    error_summary: str | None = None
    extra: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "run_id": self.run_id,
            "job_name": self.job_name,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "status": self.status,
            "counters": self.counters,
            "error_summary": self.error_summary,
            **self.extra,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> RuntimeLogEntry:
        extra = {key: value for key, value in data.items() if key not in cls._direct_fields()}
        return cls(
            run_id=data.get("run_id", ""),
            job_name=data.get("job_name", ""),
            started_at=data.get("started_at", ""),
            finished_at=data.get("finished_at"),
            status=data.get("status", "running"),
            counters=data.get("counters", {}),
            error_summary=data.get("error_summary"),
            extra=extra,
        )

    @staticmethod
    def _direct_fields() -> set[str]:
        return {
            "run_id",
            "job_name",
            "started_at",
            "finished_at",
            "status",
            "counters",
            "error_summary",
        }
