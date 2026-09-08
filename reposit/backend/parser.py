from __future__ import annotations

import re
from pathlib import Path
from typing import Any

PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        "sis_standard",
        re.compile(
            r"^\[SIS\]ANO(?P<ano>\d+)C(?P<classe>\d+)B(?P<bimestre>\d+)S(?P<semana>\d+)A(?P<atividade>\d+)AP$",
            re.IGNORECASE,
        ),
    ),
    (
        "week_activity",
        re.compile(r"(?:semana|s)[ _-]?(?P<semana>\d+).*?(?:atividade|a)[ _-]?(?P<atividade>\d+)", re.IGNORECASE),
    ),
]


def parse_school_filename(filename: str) -> dict[str, Any]:
    stem = Path(filename).stem.strip()
    suggestion: dict[str, Any] = {
        "filename": filename,
        "title": stem,
        "year": None,
        "class_code": None,
        "bimester": None,
        "week": None,
        "activity_number": None,
        "pattern": None,
    }
    for name, pattern in PATTERNS:
        match = pattern.search(stem)
        if not match:
            continue
        groups = match.groupdict()
        suggestion.update(
            {
                "year": _to_int(groups.get("ano")),
                "class_code": _to_int(groups.get("classe")),
                "bimester": _to_int(groups.get("bimestre")),
                "week": _to_int(groups.get("semana")),
                "activity_number": _to_int(groups.get("atividade")),
                "pattern": name,
            }
        )
        if suggestion["activity_number"]:
            suggestion["title"] = f"Atividade {suggestion['activity_number']}"
        break
    return suggestion


def _to_int(value: str | None) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None
