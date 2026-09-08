from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

CURRENT_SCHEMA_VERSION = 3


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Database:
    def __init__(self, path: Path):
        self.path = path
        self._local = threading.local()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.migrate()

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=20, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    @contextmanager
    def session(self):
        conn = self.connect()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def migrate(self) -> None:
        with self.session() as conn:
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            if version < 1:
                self._migration_1(conn)
                version = 1
            if version < 2:
                self._migration_2(conn)
                version = 2
            if version < 3:
                self._migration_3(conn)
                version = 3
            conn.execute(f"PRAGMA user_version={CURRENT_SCHEMA_VERSION}")

    def _migration_1(self, conn: sqlite3.Connection) -> None:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS profile (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                name TEXT NOT NULL DEFAULT '',
                class_name TEXT NOT NULL DEFAULT '',
                grade TEXT NOT NULL DEFAULT '',
                school TEXT NOT NULL DEFAULT '',
                school_email TEXT NOT NULL DEFAULT ''
            );
            INSERT OR IGNORE INTO profile(id) VALUES (1);

            CREATE TABLE IF NOT EXISTS repositories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                description TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS subjects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE
            );

            CREATE TABLE IF NOT EXISTS teachers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS contacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL DEFAULT '',
                type TEXT NOT NULL DEFAULT 'Outro' CHECK(type IN ('Professor','Aluno','Grupo','Outro')),
                nickname TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                category TEXT NOT NULL DEFAULT '',
                favorite INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS activities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                subject_id INTEGER,
                repository_id INTEGER,
                teacher_id INTEGER,
                week INTEGER,
                bimester INTEGER,
                activity_date TEXT,
                status TEXT NOT NULL DEFAULT 'Não iniciada',
                notes TEXT NOT NULL DEFAULT '',
                origin TEXT NOT NULL DEFAULT 'manual',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE SET NULL,
                FOREIGN KEY(repository_id) REFERENCES repositories(id) ON DELETE SET NULL,
                FOREIGN KEY(teacher_id) REFERENCES teachers(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                activity_id INTEGER,
                filename TEXT NOT NULL,
                filepath TEXT NOT NULL,
                file_type TEXT NOT NULL DEFAULT '',
                file_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'attachment',
                size INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_files_hash ON files(file_hash);
            CREATE INDEX IF NOT EXISTS idx_files_activity ON files(activity_id);

            CREATE TABLE IF NOT EXISTS tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE
            );
            CREATE TABLE IF NOT EXISTS activity_tags (
                activity_id INTEGER NOT NULL,
                tag_id INTEGER NOT NULL,
                PRIMARY KEY(activity_id, tag_id),
                FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE CASCADE,
                FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS activity_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                activity_id INTEGER NOT NULL,
                action TEXT NOT NULL,
                details TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS devices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uuid TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                ip TEXT NOT NULL DEFAULT '',
                port INTEGER NOT NULL DEFAULT 0,
                version TEXT NOT NULL DEFAULT '',
                trusted INTEGER NOT NULL DEFAULT 0,
                last_seen TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS wall_posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                activity_id INTEGER,
                title TEXT NOT NULL,
                subject TEXT NOT NULL DEFAULT '',
                week INTEGER,
                description TEXT NOT NULL DEFAULT '',
                author TEXT NOT NULL DEFAULT '',
                author_device TEXT NOT NULL DEFAULT '',
                contains_answers INTEGER NOT NULL DEFAULT 0,
                file_path TEXT NOT NULL DEFAULT '',
                file_name TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS pending_shares (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sender_uuid TEXT NOT NULL,
                sender_name TEXT NOT NULL,
                sender_ip TEXT NOT NULL,
                title TEXT NOT NULL,
                subject TEXT NOT NULL DEFAULT '',
                week INTEGER,
                description TEXT NOT NULL DEFAULT '',
                contains_answers INTEGER NOT NULL DEFAULT 0,
                temp_path TEXT NOT NULL DEFAULT '',
                file_name TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS email_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                recipient TEXT NOT NULL,
                recipient_name TEXT NOT NULL DEFAULT '',
                contact_type TEXT NOT NULL DEFAULT '',
                subject TEXT NOT NULL,
                status TEXT NOT NULL,
                activity_ids TEXT NOT NULL DEFAULT '',
                error TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS activity_fts USING fts5(
                activity_id UNINDEXED,
                title,
                description,
                subject,
                repository,
                teacher,
                tags,
                filename,
                tokenize='unicode61 remove_diacritics 2'
            );
            """
        )


    def _migration_2(self, conn: sqlite3.Connection) -> None:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL DEFAULT '',
                kind TEXT NOT NULL DEFAULT 'Anotação',
                content TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '',
                pinned INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS note_files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                note_id INTEGER NOT NULL,
                filename TEXT NOT NULL,
                filepath TEXT NOT NULL,
                file_type TEXT NOT NULL DEFAULT '',
                file_hash TEXT NOT NULL,
                size INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_notes_kind ON notes(kind);
            CREATE INDEX IF NOT EXISTS idx_note_files_note ON note_files(note_id);
            CREATE INDEX IF NOT EXISTS idx_note_files_hash ON note_files(file_hash);

            CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(
                note_id UNINDEXED,
                title,
                kind,
                content,
                tags,
                tokenize='unicode61 remove_diacritics 2'
            );
            """
        )



    def _migration_3(self, conn: sqlite3.Connection) -> None:
        """0.5.0: rich notes, subnotes, validator pinning and richer student profile."""
        columns = {row[1] for row in conn.execute("PRAGMA table_info(notes)").fetchall()}
        if "content_format" not in columns:
            conn.execute("ALTER TABLE notes ADD COLUMN content_format TEXT NOT NULL DEFAULT 'plain'")
        if "parent_note_id" not in columns:
            conn.execute("ALTER TABLE notes ADD COLUMN parent_note_id INTEGER")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_notes_parent ON notes(parent_note_id)")

        activity_columns = {row[1] for row in conn.execute("PRAGMA table_info(activities)").fetchall()}
        if "pinned" not in activity_columns:
            conn.execute("ALTER TABLE activities ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
        if "completed_at" not in activity_columns:
            conn.execute("ALTER TABLE activities ADD COLUMN completed_at TEXT NOT NULL DEFAULT ''")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_activities_pinned ON activities(pinned DESC, activity_date)")

        profile_columns = {row[1] for row in conn.execute("PRAGMA table_info(profile)").fetchall()}
        if "course" not in profile_columns:
            conn.execute("ALTER TABLE profile ADD COLUMN course TEXT NOT NULL DEFAULT ''")
        if "shift" not in profile_columns:
            conn.execute("ALTER TABLE profile ADD COLUMN shift TEXT NOT NULL DEFAULT ''")

    def checkpoint(self) -> None:
        """Move alterações do WAL para o arquivo principal antes de backup/cópia."""
        conn = self.connect()
        try:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            conn.close()

    def execute(self, sql: str, params: Iterable[Any] = ()) -> int:
        with self.session() as conn:
            cur = conn.execute(sql, tuple(params))
            return int(cur.lastrowid or 0)

    def fetchone(self, sql: str, params: Iterable[Any] = ()) -> dict[str, Any] | None:
        with self.session() as conn:
            row = conn.execute(sql, tuple(params)).fetchone()
            return dict(row) if row else None

    def fetchall(self, sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
        with self.session() as conn:
            return [dict(r) for r in conn.execute(sql, tuple(params)).fetchall()]

    def rebuild_activity_fts(self, activity_id: int) -> None:
        with self.session() as conn:
            row = conn.execute(
                """
                SELECT a.id, a.title, a.description,
                       COALESCE(s.name,'') subject,
                       COALESCE(r.name,'') repository,
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
                WHERE a.id=?
                GROUP BY a.id
                """,
                (activity_id,),
            ).fetchone()
            conn.execute("DELETE FROM activity_fts WHERE activity_id=?", (activity_id,))
            if row:
                conn.execute(
                    "INSERT INTO activity_fts(activity_id,title,description,subject,repository,teacher,tags,filename) VALUES (?,?,?,?,?,?,?,?)",
                    tuple(row),
                )

    def log_activity(self, activity_id: int, action: str, details: str = "") -> None:
        self.execute(
            "INSERT INTO activity_history(activity_id,action,details,created_at) VALUES (?,?,?,?)",
            (activity_id, action, details, utcnow()),
        )
