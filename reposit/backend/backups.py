from __future__ import annotations

import json
import os
import shutil
import sqlite3
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from .config import APP_VERSION, AppPaths
from .database import CURRENT_SCHEMA_VERSION


def _sqlite_snapshot(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    src = sqlite3.connect(source, timeout=20)
    dst = sqlite3.connect(destination, timeout=20)
    try:
        src.backup(dst)
        dst.commit()
    finally:
        dst.close()
        src.close()


def _db_health(path: Path) -> dict[str, Any]:
    conn = sqlite3.connect(path, timeout=10)
    try:
        integrity = [str(row[0]) for row in conn.execute("PRAGMA integrity_check").fetchall()]
        version = int(conn.execute("PRAGMA user_version").fetchone()[0])
        fk = [tuple(row) for row in conn.execute("PRAGMA foreign_key_check").fetchall()]
        return {
            "ok": len(integrity) == 1 and integrity[0].lower() == "ok" and not fk,
            "integrity": integrity,
            "schema_version": version,
            "foreign_keys": fk,
        }
    finally:
        conn.close()


def export_reposit(paths: AppPaths, destination: Path, include_attachments: bool = True) -> Path:
    """Write an atomic .reposit archive from a consistent SQLite snapshot."""
    destination = destination.with_suffix(".reposit")
    destination.parent.mkdir(parents=True, exist_ok=True)
    tmp_archive = destination.with_suffix(destination.suffix + ".tmp")
    tmp_archive.unlink(missing_ok=True)
    with tempfile.TemporaryDirectory(prefix="reposit-export-") as tmp_name:
        snapshot = Path(tmp_name) / "REPOSITINFOS.db"
        if paths.db.exists():
            _sqlite_snapshot(paths.db, snapshot)
        else:
            sqlite3.connect(snapshot).close()
        health = _db_health(snapshot)
        if not health["ok"]:
            raise ValueError("O banco atual não passou na verificação de integridade; backup automático foi cancelado.")
        with zipfile.ZipFile(tmp_archive, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.write(snapshot, "data/REPOSITINFOS.db")
            if paths.settings.exists():
                zf.write(paths.settings, "data/settings.json")
            manifest = {
                "format": "reposit",
                "version": APP_VERSION,
                "schema_version": health["schema_version"],
                "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "attachments": bool(include_attachments),
            }
            zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
            if include_attachments:
                for file in paths.attachments.rglob("*"):
                    if file.is_file() and paths.pending not in file.parents:
                        zf.write(file, str(Path("attachments") / file.relative_to(paths.attachments)))
    os.replace(tmp_archive, destination)
    return destination


def create_automatic_backup(paths: AppPaths, *, keep: int = 5, include_attachments: bool = True) -> Path:
    paths.backups.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    target = paths.backups / f"RepositPlus-auto-{stamp}.reposit"
    created = export_reposit(paths, target, include_attachments=include_attachments)
    backups = sorted(paths.backups.glob("RepositPlus-auto-*.reposit"), key=lambda p: p.stat().st_mtime, reverse=True)
    for stale in backups[max(1, int(keep)):]:
        try:
            stale.unlink()
        except OSError:
            pass
    return created


def _safe_zip_parts(name: str) -> tuple[str, ...]:
    normalized = name.replace("\\", "/")
    member = PurePosixPath(normalized)
    parts = tuple(part for part in member.parts if part not in ("", "."))
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
    if normalized.startswith("attachments/"):
        return str((attachments_root / Path(normalized[len("attachments/"):])).resolve())
    return raw


def _relocate_db_paths(db_path: Path, attachments_root: Path) -> None:
    conn = sqlite3.connect(db_path)
    try:
        for table, column in (("files", "filepath"), ("note_files", "filepath")):
            try:
                rows = conn.execute(f"SELECT id, {column} FROM {table}").fetchall()
            except sqlite3.OperationalError:
                continue
            for row_id, raw in rows:
                conn.execute(f"UPDATE {table} SET {column}=? WHERE id=?", (_relocate_path(raw, attachments_root), row_id))
        try:
            rows = conn.execute("SELECT id, file_path FROM wall_posts WHERE file_path != ''").fetchall()
            for row_id, raw in rows:
                conn.execute("UPDATE wall_posts SET file_path=? WHERE id=?", (_relocate_path(raw, attachments_root), row_id))
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("DELETE FROM pending_shares")
        except sqlite3.OperationalError:
            pass
        conn.commit()
    finally:
        conn.close()


def import_reposit(paths: AppPaths, source: Path) -> dict[str, Any]:
    """Validate the complete backup before replacing any current user data."""
    manifest = validate_backup(source)
    with tempfile.TemporaryDirectory(prefix="reposit-import-") as tmp_name:
        tmp = Path(tmp_name)
        with zipfile.ZipFile(source, "r") as zf:
            _extract_backup_safely(zf, tmp)
        candidate = tmp / "data" / "REPOSITINFOS.db"
        health = _db_health(candidate)
        if not health["ok"]:
            raise ValueError("O banco dentro do backup está corrompido ou inconsistente.")
        if health["schema_version"] > CURRENT_SCHEMA_VERSION:
            raise ValueError(f"Backup usa schema v{health['schema_version']}, mais novo que o suportado v{CURRENT_SCHEMA_VERSION}.")

        # The current state gets its own full backup before the restore. If the
        # restore later fails, the user still has a self-contained recovery file.
        if paths.db.exists() and paths.db.stat().st_size:
            stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
            export_reposit(paths, paths.backups / f"RepositPlus-before-restore-{stamp}.reposit", include_attachments=True)

        staged_db = paths.db.with_suffix(paths.db.suffix + ".restore")
        shutil.copy2(candidate, staged_db)
        _relocate_db_paths(staged_db, paths.attachments)
        staged_health = _db_health(staged_db)
        if not staged_health["ok"]:
            staged_db.unlink(missing_ok=True)
            raise ValueError("O backup ficou inconsistente durante a preparação da restauração.")

        # Only now replace the live database. WAL sidecars from the old DB must
        # never be replayed into the restored file.
        for sidecar in [paths.db.with_name(paths.db.name + "-wal"), paths.db.with_name(paths.db.name + "-shm")]:
            sidecar.unlink(missing_ok=True)
        os.replace(staged_db, paths.db)
        if (tmp / "data" / "settings.json").exists():
            shutil.copy2(tmp / "data" / "settings.json", paths.settings)
        imported_attachments = tmp / "attachments"
        if imported_attachments.exists():
            for file in imported_attachments.rglob("*"):
                if file.is_file():
                    dest = paths.attachments / file.relative_to(imported_attachments)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(file, dest)
        # Relocate paths a second time after attachments are in their final root.
        _relocate_db_paths(paths.db, paths.attachments)
    return manifest
