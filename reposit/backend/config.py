from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

APP_NAME = "Reposit+"
APP_VERSION = "0.7.1"
APP_RELEASE_LABEL = "0.7.1 Pré-1"
INTERNAL_NAME = "reposit-plus"
DB_NAME = "REPOSITINFOS.db"


@dataclass(slots=True)
class AppPaths:
    root: Path
    data: Path
    db: Path
    attachments: Path
    originals: Path
    answered: Path
    received: Path
    pending: Path
    cache: Path
    logs: Path
    frontend: Path
    identity: Path
    settings: Path

    @classmethod
    def from_roots(cls, resource_root: Path, data_root: Path) -> "AppPaths":
        """Create application paths with resources and writable data separated.

        Installed builds keep user data outside the executable directory while
        portable/source builds may intentionally point both roots to the same
        place. This avoids permission errors under Program Files and makes
        upgrades safe because the installer never needs to overwrite user data.
        """
        resource_root = resource_root.resolve()
        data_root = data_root.resolve()
        data = data_root / "data"
        attachments = data_root / "attachments"
        paths = cls(
            root=data_root,
            data=data,
            db=data / DB_NAME,
            attachments=attachments,
            originals=attachments / "original",
            answered=attachments / "answered",
            received=attachments / "received",
            pending=attachments / "pending",
            cache=data_root / "cache",
            logs=data_root / "logs",
            frontend=resource_root / "frontend",
            identity=data / "identity.json",
            settings=data / "settings.json",
        )
        for directory in [
            paths.data,
            paths.attachments,
            paths.originals,
            paths.answered,
            paths.received,
            paths.pending,
            paths.cache,
            paths.logs,
        ]:
            directory.mkdir(parents=True, exist_ok=True)
        return paths

    @classmethod
    def from_root(cls, root: Path) -> "AppPaths":
        return cls.from_roots(root, root)


def _atomic_json_write(path: Path, payload: dict[str, Any]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def load_identity(paths: AppPaths) -> dict[str, Any]:
    if paths.identity.exists():
        try:
            data = json.loads(paths.identity.read_text(encoding="utf-8"))
            if data.get("device_uuid"):
                if data.get("version") != APP_VERSION:
                    data["version"] = APP_VERSION
                    _atomic_json_write(paths.identity, data)
                return data
        except (OSError, json.JSONDecodeError):
            pass
    identity = {
        "device_uuid": str(uuid.uuid4()),
        "device_name": os.environ.get("COMPUTERNAME") or os.environ.get("HOSTNAME") or "Reposit-PC",
        "version": APP_VERSION,
    }
    _atomic_json_write(paths.identity, identity)
    return identity


DEFAULT_SETTINGS: dict[str, Any] = {
    "autosave_enabled": True,
    "battery_saver": False,
    "db_warning_bytes": 1073741824,
    "memory_soft_limit_mb": 192,
    "hotkey": "ctrl+alt",
    "ui_revision": 9,
    "last_db_maintenance": 0,
}



def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def _clamp_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def load_settings(paths: AppPaths) -> dict[str, Any]:
    existing: dict[str, Any] = {}
    if paths.settings.exists():
        try:
            existing = json.loads(paths.settings.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            existing = {}
    # Keep only settings that still exist in this reduced build. Old feature
    # keys are discarded automatically instead of being carried forever.
    existing = {k: v for k, v in existing.items() if k in DEFAULT_SETTINGS}
    settings = _deep_merge(DEFAULT_SETTINGS, existing)
    settings["autosave_enabled"] = bool(settings.get("autosave_enabled", True))
    settings["battery_saver"] = bool(settings.get("battery_saver", False))
    settings["db_warning_bytes"] = _clamp_int(settings.get("db_warning_bytes"), 1073741824, 104857600, 1099511627776)
    settings["memory_soft_limit_mb"] = _clamp_int(settings.get("memory_soft_limit_mb"), 192, 160, 384)
    settings["last_db_maintenance"] = _clamp_int(settings.get("last_db_maintenance"), 0, 0, 4102444800)
    settings["ui_revision"] = 9
    _atomic_json_write(paths.settings, settings)
    return settings

def save_settings(paths: AppPaths, settings: dict[str, Any]) -> None:
    _atomic_json_write(paths.settings, settings)
