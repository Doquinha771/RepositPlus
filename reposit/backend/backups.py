from __future__ import annotations

import json
import shutil
import sqlite3
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

from .config import APP_VERSION, AppPaths


def export_reposit(paths: AppPaths, destination: Path, include_attachments: bool = True) -> Path:
    destination = destination.with_suffix(".reposit")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        if paths.db.exists():
            zf.write(paths.db, "data/REPOSITINFOS.db")
        if paths.settings.exists():
            zf.write(paths.settings, "data/settings.json")
        zf.writestr("manifest.json", json.dumps({"format": "reposit", "version": APP_VERSION}, ensure_ascii=False, indent=2))
        if include_attachments:
            for file in paths.attachments.rglob("*"):
                if file.is_file() and paths.pending not in file.parents:
                    zf.write(file, str(Path("attachments") / file.relative_to(paths.attachments)))
    return destination


def _safe_zip_parts(name: str) -> tuple[str, ...]:
    """Return normalized ZIP member parts or reject path traversal.

    ZIP member names are POSIX-style regardless of the host OS.  The old
    validation resolved them against ``Path('/')`` and then checked for a
    leading slash.  That works on POSIX, but on Windows ``Path('/').resolve()``
    becomes something like ``C:\\``; consequently every perfectly valid
    member was rejected.  Keep the validation platform-independent instead.
    """
    normalized = name.replace("\\", "/")
    member = PurePosixPath(normalized)
    parts = tuple(part for part in member.parts if part not in ("", "."))

    # Absolute paths, parent traversal and drive/ADS-like prefixes must never
    # leave the temporary import directory.
    if member.is_absolute() or ".." in parts:
        raise ValueError("Backup contém caminho inseguro.")
    if parts and (":" in parts[0] or parts[0].startswith("~")):
        raise ValueError("Backup contém caminho inseguro.")
    return parts


def validate_backup(source: Path) -> dict[str, Any]:
    if source.suffix.lower() != ".reposit":
        raise ValueError("Arquivo precisa usar a extensão .reposit")
    with zipfile.ZipFile(source, "r") as zf:
        names = set(zf.namelist())
        if "manifest.json" not in names or "data/REPOSITINFOS.db" not in names:
            raise ValueError("Backup .reposit inválido ou incompleto.")
        manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
        if manifest.get("format") != "reposit":
            raise ValueError("Formato de backup desconhecido.")
        for name in names:
            _safe_zip_parts(name)
        return manifest


def _extract_backup_safely(zf: zipfile.ZipFile, destination: Path) -> None:
    """Extract a validated backup without relying on platform path semantics."""
    destination = destination.resolve()
    for info in zf.infolist():
        parts = _safe_zip_parts(info.filename)
        if not parts:
            continue
        target = (destination.joinpath(*parts)).resolve()
        try:
            target.relative_to(destination)
        except ValueError as exc:
            raise ValueError("Backup contém caminho inseguro.") from exc
        if info.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(info, "r") as src, target.open("wb") as dst:
            shutil.copyfileobj(src, dst)


def _relocate_path(raw: str, attachments_root: Path) -> str:
    if not raw:
        return raw
    normalized = raw.replace("\\", "/")
    marker = "/attachments/"
    if marker in normalized:
        suffix = normalized.split(marker, 1)[1]
        return str((attachments_root / Path(suffix)).resolve())
    # Banco antigo pode guardar caminho relativo começando em attachments/.
    if normalized.startswith("attachments/"):
        return str((attachments_root / Path(normalized[len("attachments/"):])).resolve())
    return raw


def _relocate_db_paths(db_path: Path, attachments_root: Path) -> None:
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute("SELECT id, filepath FROM files").fetchall()
        for row_id, raw in rows:
            conn.execute("UPDATE files SET filepath=? WHERE id=?", (_relocate_path(raw, attachments_root), row_id))
        # v0.1 simplificada: anexos das anotações também precisam sobreviver à mudança de pasta.
        try:
            rows = conn.execute("SELECT id, filepath FROM note_files").fetchall()
            for row_id, raw in rows:
                conn.execute("UPDATE note_files SET filepath=? WHERE id=?", (_relocate_path(raw, attachments_root), row_id))
        except sqlite3.OperationalError:
            pass
        rows = conn.execute("SELECT id, file_path FROM wall_posts WHERE file_path != ''").fetchall()
        for row_id, raw in rows:
            conn.execute("UPDATE wall_posts SET file_path=? WHERE id=?", (_relocate_path(raw, attachments_root), row_id))
        # Pendências não são transportadas entre instalações por segurança.
        conn.execute("DELETE FROM pending_shares")
        conn.commit()
    finally:
        conn.close()


def import_reposit(paths: AppPaths, source: Path) -> dict[str, Any]:
    manifest = validate_backup(source)
    with tempfile.TemporaryDirectory(prefix="reposit-import-") as tmp_name:
        tmp = Path(tmp_name)
        with zipfile.ZipFile(source, "r") as zf:
            _extract_backup_safely(zf, tmp)
        backup_current = paths.data / "REPOSITINFOS.before-import.db"
        if paths.db.exists():
            shutil.copy2(paths.db, backup_current)
        for sidecar in [paths.db.with_name(paths.db.name + "-wal"), paths.db.with_name(paths.db.name + "-shm")]:
            sidecar.unlink(missing_ok=True)
        shutil.copy2(tmp / "data" / "REPOSITINFOS.db", paths.db)
        if (tmp / "data" / "settings.json").exists():
            shutil.copy2(tmp / "data" / "settings.json", paths.settings)
        imported_attachments = tmp / "attachments"
        if imported_attachments.exists():
            for file in imported_attachments.rglob("*"):
                if file.is_file():
                    dest = paths.attachments / file.relative_to(imported_attachments)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(file, dest)
        _relocate_db_paths(paths.db, paths.attachments)
    return manifest
