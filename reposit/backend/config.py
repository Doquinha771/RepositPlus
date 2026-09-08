from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

APP_NAME = "Reposit+"
APP_VERSION = "0.5.0"
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
    "theme": "graphite",
    "use_system_theme": False,
    "start_with_windows": False,
    "minimize_to_tray": False,
    "mural_enabled": False,
    "auto_accept_trusted": True,
    "device_name": None,
    "data_folder": None,
    "email_signature": "",
    "email_template": "",
    # E-mail is intentionally zero-config. Reposit+ never authenticates with
    # Gmail/Outlook; it hands a prepared draft to the Windows mail handler.
    "email_mode": "system",
    "hotkey": "ctrl+alt",
    "first_run_complete": False,
    "ui_revision": 5,
}



def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def load_settings(paths: AppPaths) -> dict[str, Any]:
    existing: dict[str, Any] = {}
    if paths.settings.exists():
        try:
            existing = json.loads(paths.settings.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            existing = {}
    settings = _deep_merge(DEFAULT_SETTINGS, existing)
    revision = int(existing.get("ui_revision") or 0)
    if revision < 2:
        settings["theme"] = "dark"
        settings["use_system_theme"] = False
    if revision < 3:
        # Remove the old OAuth/SMTP account configuration from disk. Any
        # browser-based login flow is gone in revision 3. If an older build
        # stored an OAuth token in keyring, delete it best-effort as well.
        settings.pop("smtp", None)
        settings.pop("account", None)
        settings["email_mode"] = "system"
        old_oauth = paths.data / "google_oauth_client.json"
        try:
            old_oauth.unlink(missing_ok=True)
        except OSError:
            pass
        try:
            import keyring  # optional: present in upgraded installs only
            keyring.delete_password("reposit-plus-google-oauth", "google")
        except Exception:
            pass
    if revision < 5:
        # 0.5.0 adds named themes while preserving old light/system choices.
        if settings.get("theme") == "dark":
            settings["theme"] = "graphite"
    settings["ui_revision"] = 5
    _atomic_json_write(paths.settings, settings)
    return settings


def save_settings(paths: AppPaths, settings: dict[str, Any]) -> None:
    _atomic_json_write(paths.settings, settings)
