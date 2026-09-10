from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher
from typing import Any

from .database import Database


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    return re.sub(r"\s+", " ", text).strip()


def search_activities(db: Database, query: str, limit: int = 40) -> list[dict[str, Any]]:
    q = normalize(query)
    if not q:
        return []
    tokens = [t for t in re.findall(r"[\w-]+", q) if t]
    fts_query = " AND ".join(f'"{t}"*' for t in tokens)
    results: list[dict[str, Any]] = []
    if fts_query:
        try:
            ids = db.fetchall(
                "SELECT activity_id, bm25(activity_fts) score FROM activity_fts WHERE activity_fts MATCH ? ORDER BY score LIMIT ?",
                (fts_query, limit),
            )
            for row in ids:
                item = _activity_summary(db, int(row["activity_id"]))
                if item:
                    item["score"] = float(row["score"])
                    results.append(item)
        except Exception:
            results = []

    if len(results) < min(10, limit):
        candidates = db.fetchall(
            """
            SELECT a.id, a.title, a.description, a.week, a.status,
                   COALESCE(s.name,'') subject, COALESCE(r.name,'') repository,
                   COALESCE(t.name,'') teacher,
                   COALESCE(GROUP_CONCAT(DISTINCT tg.name),'') tags,
                   COALESCE(GROUP_CONCAT(DISTINCT f.filename),'') filename
            FROM activities a
            LEFT JOIN subjects s ON s.id=a.subject_id
            LEFT JOIN repositories r ON r.id=a.repository_id
            LEFT JOIN teachers t ON t.id=a.teacher_id
            LEFT JOIN activity_tags at ON at.activity_id=a.id
            LEFT JOIN tags tg ON tg.id=at.tag_id
            LEFT JOIN files f ON f.activity_id=a.id
            GROUP BY a.id
            ORDER BY a.updated_at DESC LIMIT 250
            """
        )
        seen = {r["id"] for r in results}
        fuzzy: list[tuple[float, dict[str, Any]]] = []
        for c in candidates:
            if c["id"] in seen:
                continue
            hay = normalize(" ".join(str(c.get(k, "")) for k in ["title", "description", "subject", "repository", "teacher", "tags", "filename", "week"]))
            if q in hay:
                score = 0.95
            else:
                score = max((SequenceMatcher(None, t, word).ratio() for t in tokens for word in hay.split()), default=0)
            if score >= 0.68:
                c["score"] = 1 - score
                fuzzy.append((score, c))
        fuzzy.sort(key=lambda x: x[0], reverse=True)
        results.extend(item for _, item in fuzzy[: max(0, limit - len(results))])
    return results[:limit]


def _activity_summary(db: Database, activity_id: int) -> dict[str, Any] | None:
    return db.fetchone(
        """
        SELECT a.id, a.title, a.description, a.week, a.bimester, a.status, a.updated_at,
               COALESCE(s.name,'') subject, COALESCE(r.name,'') repository, COALESCE(t.name,'') teacher
        FROM activities a
        LEFT JOIN subjects s ON s.id=a.subject_id
        LEFT JOIN repositories r ON r.id=a.repository_id
        LEFT JOIN teachers t ON t.id=a.teacher_id
        WHERE a.id=?
        """,
        (activity_id,),
    )
