from __future__ import annotations

import json
import platform
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import APP_VERSION, AppPaths
from .database import CURRENT_SCHEMA_VERSION, Database
from .maintenance import storage_report


def diagnostics_report(db: Database, paths: AppPaths) -> dict[str, Any]:
    note_count = int(db.fetchone("SELECT COUNT(*) count FROM notes")["count"])
    attachment_count = int(db.fetchone("SELECT COUNT(*) count FROM note_files")["count"])
    backups = sorted(paths.backups.glob("*.reposit"), key=lambda p: p.stat().st_mtime, reverse=True)
    health = db.startup_health_check()
    return {
        "version": APP_VERSION,
        "schema_version": int(db.fetchone("PRAGMA user_version")["user_version"]),
        "data_path": str(paths.root),
        "database_path": str(paths.db),
        "notes": note_count,
        "attachments": attachment_count,
        "last_backup": str(backups[0]) if backups else "",
        "storage": storage_report(paths),
        "database_ok": bool(health.get("ok")),
        "database_quick_check": str(health.get("quick_check") or ""),
        "platform": platform.platform(),
        "python": platform.python_version(),
    }


def diagnostics_text(report: dict[str, Any]) -> str:
    st = report.get("storage") or {}
    lines = [
        f"Reposit+ {report.get('version', '')}",
        f"Schema: v{report.get('schema_version', '')}",
        f"Dados: {report.get('data_path', '')}",
        f"Banco: {st.get('database', 0)} bytes",
        f"Notas: {report.get('notes', 0)}",
        f"Anexos: {report.get('attachments', 0)}",
        f"Backups: {st.get('backups', 0)} bytes",
        f"Cache: {st.get('cache', 0)} bytes",
        f"Último backup: {report.get('last_backup') or 'nenhum'}",
        f"Banco: {'OK' if report.get('database_ok') else 'ATENÇÃO'}",
        f"Sistema: {report.get('platform', '')}",
    ]
    return "\n".join(lines)


def export_diagnostics_bundle(db: Database, paths: AppPaths, destination: Path) -> Path:
    """Export a privacy-safe diagnostics ZIP without note bodies or attachments."""
    destination = Path(destination)
    if destination.suffix.lower() != ".zip":
        destination = destination.with_suffix(".zip")
    destination.parent.mkdir(parents=True, exist_ok=True)
    report = diagnostics_report(db, paths)
    report["exported_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    text = diagnostics_text(report)
    tmp = destination.with_suffix(destination.suffix + ".tmp")
    tmp.unlink(missing_ok=True)
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("diagnostico.txt", text.encode("utf-8"))
        zf.writestr("diagnostico.json", json.dumps(report, ensure_ascii=False, indent=2).encode("utf-8"))
        log = paths.logs / "reposit.log"
        if log.is_file():
            try:
                lines = log.read_text(encoding="utf-8", errors="replace").splitlines()[-300:]
                # Logs intentionally do not contain note bodies.  Still remove
                # control characters so the support bundle remains plain text.
                cleaned = "\n".join("".join(ch for ch in line if ch == "\t" or ord(ch) >= 32) for line in lines)
                zf.writestr("logs/reposit-tail.log", cleaned.encode("utf-8"))
            except OSError:
                pass
    tmp.replace(destination)
    return destination
