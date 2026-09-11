from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any


_DEFAULT_STATE: dict[str, Any] = {
    "query": "",
}


class QuickStateStore:
    """Tiny durable state for the Quick finder.

    Notes continue to live only in REPOSITINFOS.db. The Quick stores just the
    last search text so hiding/showing the window does not unexpectedly erase
    what the user was looking for.
    """

    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._state = self._load()

    def _load(self) -> dict[str, Any]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                return self._normalize(raw)
        except (OSError, json.JSONDecodeError):
            pass
        return dict(_DEFAULT_STATE)

    @staticmethod
    def _normalize(raw: dict[str, Any]) -> dict[str, Any]:
        # Older Pré-1 state files may contain the removed editor fields. Ignore
        # them cleanly instead of carrying dead UI state forever.
        query = raw.get("query")
        if query is None and raw.get("title") and not raw.get("content"):
            query = raw.get("title")
        return {"query": str(query or "")[:220]}

    def get(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._state)

    def update(self, payload: dict[str, Any] | None) -> dict[str, Any]:
        with self._lock:
            merged = dict(self._state)
            if payload and "query" in payload:
                merged["query"] = payload["query"]
            self._state = self._normalize(merged)
            self._write_locked()
            return dict(self._state)

    def _write_locked(self) -> None:
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        try:
            tmp.write_text(json.dumps(self._state, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(self.path)
        except OSError:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
