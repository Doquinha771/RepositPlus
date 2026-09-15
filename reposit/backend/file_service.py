from __future__ import annotations

import hashlib
import mimetypes
import os
import re
import shutil
from pathlib import Path

SAFE_EXTENSIONS = {
    ".pdf", ".doc", ".docx", ".odt", ".txt", ".md",
    ".xls", ".xlsx", ".ods", ".csv",
    ".ppt", ".pptx", ".odp",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
    ".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac",
    ".zip", ".rar", ".7z", ".py", ".js", ".html", ".css", ".sql", ".json"
}
MAX_FILE_SIZE = 150 * 1024 * 1024


def sanitize_filename(name: str) -> str:
    name = Path(name).name
    name = re.sub(r"[<>:\"/\\|?*\x00-\x1F]", "_", name).strip(" .")
    return name[:180] or "arquivo"


def validate_filename(name: str) -> None:
    ext = Path(name).suffix.lower()
    if ext and ext not in SAFE_EXTENSIONS:
        raise ValueError(f"Extensão não permitida nesta versão: {ext}")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def save_stream_to_controlled_path(stream, target_dir: Path, original_name: str, max_size: int = MAX_FILE_SIZE, allow_any_extension: bool = False) -> tuple[Path, str, int]:
    # Activity sources may use school/vendor-specific extensions. They are stored as inert files;
    # filename/path controls and the size limit still apply.
    if not allow_any_extension:
        validate_filename(original_name)
    safe_name = sanitize_filename(original_name)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = unique_path(target_dir / safe_name)
    digest = hashlib.sha256()
    total = 0
    try:
        with target.open("wb") as out:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_size:
                    raise ValueError("Arquivo excede o limite de 150 MB.")
                digest.update(chunk)
                out.write(chunk)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    return target, digest.hexdigest(), total


def copy_to_controlled_path(source: Path, target_dir: Path) -> tuple[Path, str, int]:
    validate_filename(source.name)
    if not source.is_file():
        raise ValueError("Arquivo de origem inválido.")
    size = source.stat().st_size
    if size > MAX_FILE_SIZE:
        raise ValueError("Arquivo excede o limite de 150 MB.")
    target = unique_path(target_dir / sanitize_filename(source.name))
    shutil.copy2(source, target)
    return target, sha256_file(target), size


def unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    i = 2
    while True:
        candidate = path.with_name(f"{path.stem} ({i}){path.suffix}")
        if not candidate.exists():
            return candidate
        i += 1


def file_mime(name: str) -> str:
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


def safe_unlink(path: str, allowed_root: Path) -> None:
    if not path:
        return
    target = Path(path).resolve()
    root = allowed_root.resolve()
    if target == root or root not in target.parents:
        return
    try:
        os.remove(target)
    except FileNotFoundError:
        pass
