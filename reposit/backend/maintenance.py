from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any

from .config import AppPaths
from .database import Database

_FILE_TOKEN = re.compile(r"\[\[reposit-file:(\d+)(?:;[^\]]+)?\]\]", re.I)
_SUBNOTE_TOKEN = re.compile(r"\[\[reposit-subnote:(\d+)\]\]", re.I)


def _dir_size(root: Path) -> int:
    total = 0
    if not root.exists():
        return 0
    for item in root.rglob("*"):
        try:
            if item.is_file():
                total += item.stat().st_size
        except OSError:
            pass
    return total


def storage_report(paths: AppPaths) -> dict[str, int]:
    database = paths.db.stat().st_size if paths.db.exists() else 0
    attachments = _dir_size(paths.attachments)
    cache = _dir_size(paths.cache)
    backups = _dir_size(paths.backups) + _dir_size(paths.data / "migration-backups")
    return {
        "database": database,
        "attachments": attachments,
        "cache": cache,
        "backups": backups,
        "total": database + attachments + cache + backups,
    }


def attachment_diagnostics(db: Database, paths: AppPaths) -> dict[str, Any]:
    rows = db.fetchall("SELECT id,note_id,filename,filepath,size,state FROM note_files ORDER BY id")
    records = {int(row["id"]): row for row in rows}
    token_refs: dict[int, set[int]] = {}
    broken_subnotes: list[dict[str, int]] = []
    for note in db.fetchall("SELECT id,content FROM notes"):
        note_id = int(note["id"])
        content = str(note.get("content") or "")
        for raw in _FILE_TOKEN.findall(content):
            token_refs.setdefault(int(raw), set()).add(note_id)
        for raw in _SUBNOTE_TOKEN.findall(content):
            child_id = int(raw)
            if not db.fetchone("SELECT id FROM notes WHERE id=?", (child_id,)):
                broken_subnotes.append({"note_id": note_id, "subnote_id": child_id})

    missing_files = []
    records_without_token = []
    token_without_record = []
    for fid, row in records.items():
        path = Path(str(row.get("filepath") or ""))
        if not path.exists():
            missing_files.append({"id": fid, "note_id": int(row["note_id"]), "filename": row.get("filename") or ""})
        if fid not in token_refs and str(row.get("state") or "") != "staged":
            records_without_token.append({"id": fid, "note_id": int(row["note_id"]), "filename": row.get("filename") or "", "state": row.get("state")})
    for fid, notes in sorted(token_refs.items()):
        if fid not in records:
            token_without_record.append({"id": fid, "notes": sorted(notes)})

    registered_paths = set()
    for row in rows:
        try:
            registered_paths.add(Path(str(row.get("filepath") or "")).resolve())
        except OSError:
            pass
    physical_without_record = []
    for file in paths.attachments.rglob("*"):
        if not file.is_file() or paths.pending in file.parents:
            continue
        try:
            resolved = file.resolve()
        except OSError:
            continue
        if resolved not in registered_paths:
            physical_without_record.append({"path": str(file), "size": file.stat().st_size})

    return {
        "ok": not (missing_files or records_without_token or token_without_record or broken_subnotes),
        "registered": len(rows),
        "used_files": sum(1 for fid in records if fid in token_refs),
        "missing_files": missing_files,
        "records_without_token": records_without_token,
        "token_without_record": token_without_record,
        "physical_without_record": physical_without_record,
        "broken_subnotes": broken_subnotes,
        "space_used": _dir_size(paths.attachments),
    }


def clear_disposable_cache(paths: AppPaths) -> dict[str, int]:
    """Clear only data explicitly classified as derived cache.

    WebView2 storage is left alone while the application is running. Notes,
    drafts, original attachments and backups are never cache.
    """
    before = 0
    removed = 0
    for root in (paths.thumbnails, paths.cache / "exports", paths.cache / "tmp"):
        if not root.exists():
            continue
        before += _dir_size(root)
        for item in sorted(root.rglob("*"), reverse=True):
            try:
                if item.is_file() or item.is_symlink():
                    removed += item.stat().st_size if item.exists() else 0
                    item.unlink(missing_ok=True)
                elif item.is_dir():
                    item.rmdir()
            except OSError:
                pass
        root.mkdir(parents=True, exist_ok=True)
    return {"before": before, "removed": removed, "after": max(0, before - removed)}
