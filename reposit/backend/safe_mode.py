from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _atomic_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


@dataclass(slots=True)
class StartupGuard:
    """Tracks repeated unclean boots and decides when safe mode is appropriate.

    The marker contains no note content.  A crash/forced kill leaves ``running``
    set to true; a clean shutdown clears it.  Three consecutive unclean boots
    automatically disable workspace restore and disposable cache for one run.
    """

    path: Path
    forced: bool = False
    auto_enabled: bool = True
    threshold: int = 3
    safe_mode: bool = False
    crash_count: int = 0
    previous_unclean: bool = False

    def begin(self) -> dict[str, Any]:
        state: dict[str, Any] = {}
        try:
            state = json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else {}
        except (OSError, json.JSONDecodeError):
            state = {}
        self.previous_unclean = bool(state.get("running"))
        previous_count = max(0, int(state.get("consecutive_unclean") or 0))
        self.crash_count = previous_count + 1 if self.previous_unclean else 0
        self.safe_mode = bool(self.forced or (self.auto_enabled and self.crash_count >= self.threshold))
        payload = {
            "running": True,
            "consecutive_unclean": self.crash_count,
            "safe_mode": self.safe_mode,
            "started_at": _now(),
            "pid": os.getpid(),
        }
        _atomic_write(self.path, payload)
        return payload

    def clean_exit(self) -> None:
        _atomic_write(
            self.path,
            {
                "running": False,
                "consecutive_unclean": 0,
                "safe_mode": False,
                "clean_exit_at": _now(),
                "pid": os.getpid(),
            },
        )
