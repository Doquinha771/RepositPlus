from __future__ import annotations

import sqlite3
import threading
import json
import shutil
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

CURRENT_SCHEMA_VERSION = 6


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Database:
    def __init__(self, path: Path):
        self.path = path
        self._local = threading.local()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.last_recovery: dict[str, Any] | None = None
        self._recover_if_corrupt()
        self.migrate()


    def _quick_check(self, path: Path | None = None) -> tuple[bool, str]:
        target = Path(path or self.path)
        if not target.exists() or target.stat().st_size == 0:
            return True, "new"
        try:
            conn = sqlite3.connect(target, timeout=5)
            try:
                row = conn.execute("PRAGMA quick_check(1)").fetchone()
                message = str(row[0] if row else "unknown")
                return message.lower() == "ok", message
            finally:
                conn.close()
        except sqlite3.DatabaseError as exc:
            return False, str(exc)

    def _bootstrap_empty_database(self) -> None:
        """Create the current schema without recursing through __init__."""
        conn = sqlite3.connect(self.path, timeout=20)
        try:
            conn.execute("PRAGMA foreign_keys=OFF")
            self._migration_1(conn)
            self._migration_2(conn)
            self._migration_3(conn)
            self._migration_4(conn)
            self._migration_5(conn)
            self._migration_6(conn)
            conn.execute(f"PRAGMA user_version={CURRENT_SCHEMA_VERSION}")
            conn.commit()
        finally:
            conn.close()

    def _recover_if_corrupt(self) -> None:
        """Best-effort rescue to a fresh DB when SQLite reports corruption.

        The original file is never destroyed. It is moved to data/recovery and
        a new current-schema DB is created. Rows are copied table-by-table in
        small chunks so one damaged area has less chance of killing the whole
        rescue. FTS tables are intentionally rebuilt instead of copied.
        """
        ok, detail = self._quick_check()
        if ok:
            return
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        recovery_dir = self.path.parent / "recovery"
        recovery_dir.mkdir(parents=True, exist_ok=True)
        original = recovery_dir / f"{self.path.stem}.corrupt-{stamp}{self.path.suffix or '.sqlite'}"
        report_path = recovery_dir / "last-recovery.json"
        # Preserve sidecars too. The main file is moved so a clean DB can take its place.
        for suffix in ("-wal", "-shm"):
            side = Path(str(self.path) + suffix)
            if side.exists():
                try:
                    shutil.copy2(side, recovery_dir / f"{side.name}.{stamp}")
                except OSError:
                    pass
        shutil.move(str(self.path), str(original))
        self._bootstrap_empty_database()

        tables = [
            "repositories", "subjects", "teachers", "activities", "files",
            "tags", "activity_tags", "activity_history", "devices", "wall_posts", "pending_shares",
            "notes", "note_files",
        ]
        copied: dict[str, int] = {}
        failed: dict[str, str] = {}
        source = None
        target = None
        try:
            source = sqlite3.connect(original, timeout=5)
            source.row_factory = sqlite3.Row
            target = sqlite3.connect(self.path, timeout=20)
            target.execute("PRAGMA foreign_keys=OFF")
            for table in tables:
                try:
                    target_cols = [r[1] for r in target.execute(f"PRAGMA table_info({table})").fetchall()]
                    source_cols = [r[1] for r in source.execute(f"PRAGMA table_info({table})").fetchall()]
                    cols = [c for c in target_cols if c in source_cols]
                    if not cols:
                        continue
                    quoted = ",".join(f'"{c}"' for c in cols)
                    placeholders = ",".join("?" for _ in cols)
                    total = 0
                    offset = 0
                    chunk = 128
                    while True:
                        try:
                            rows = source.execute(f"SELECT {quoted} FROM {table} LIMIT ? OFFSET ?", (chunk, offset)).fetchall()
                        except sqlite3.DatabaseError as exc:
                            # Skip the problematic logical chunk and continue trying later pages.
                            failed[f"{table}@{offset}"] = str(exc)
                            offset += chunk
                            if offset > 1000000:
                                break
                            continue
                        if not rows:
                            break
                        for row in rows:
                            try:
                                target.execute(
                                    f"INSERT OR IGNORE INTO {table} ({quoted}) VALUES ({placeholders})",
                                    tuple(row[c] for c in cols),
                                )
                                total += 1
                            except sqlite3.DatabaseError as exc:
                                failed[f"{table}#row{offset+total}"] = str(exc)
                        target.commit()
                        offset += len(rows)
                        if len(rows) < chunk:
                            break
                    copied[table] = total
                except sqlite3.DatabaseError as exc:
                    failed[table] = str(exc)
            target.commit()
        except sqlite3.DatabaseError as exc:
            failed["source"] = str(exc)
        finally:
            if source is not None:
                source.close()
            if target is not None:
                target.close()

        # Rebuild FTS from authoritative tables. Corrupt FTS pages are disposable.
        try:
            with self.session() as conn:
                conn.execute("DELETE FROM note_fts")
                rows = conn.execute("SELECT id,title,kind,content,tags FROM notes").fetchall()
                conn.executemany(
                    "INSERT INTO note_fts(note_id,title,kind,content,tags) VALUES (?,?,?,?,?)",
                    [(r[0], r[1], r[2], r[3], r[4]) for r in rows],
                )
                conn.execute("PRAGMA optimize")
            vacuum = sqlite3.connect(self.path, timeout=20)
            try:
                vacuum.execute("VACUUM")
            finally:
                vacuum.close()
        except sqlite3.DatabaseError as exc:
            failed["rebuild"] = str(exc)

        final_ok, final_detail = self._quick_check()
        report = {
            "recovered": True,
            "original": str(original),
            "new_database": str(self.path),
            "detected_error": detail,
            "integrity_after": final_detail,
            "integrity_ok": final_ok,
            "copied_rows": copied,
            "warnings": failed,
            "created_at": utcnow(),
        }
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        self.last_recovery = report
    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=20, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA temp_store=MEMORY")
        conn.execute("PRAGMA cache_size=-2048")
        conn.execute("PRAGMA wal_autocheckpoint=256")
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
            if version < 4:
                self._migration_4(conn)
                version = 4
            if version < 5:
                self._migration_5(conn)
                version = 5
            if version < 6:
                self._migration_6(conn)
                version = 6
            conn.execute(f"PRAGMA user_version={version}")

    def _migration_1(self, conn: sqlite3.Connection) -> None:
        conn.executescript(
            """

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
                name TEXT NOT NULL UNIQUE
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
                edit_revision INTEGER NOT NULL DEFAULT 0,
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
        """0.5.0: rich notes, subnotes and validator pinning."""
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

    def _migration_4(self, conn: sqlite3.Connection) -> None:
        """0.7.0: indexes used by lazy note lists and maintenance-friendly queries."""
        conn.executescript(
            """
            CREATE INDEX IF NOT EXISTS idx_notes_parent_updated ON notes(parent_note_id, pinned DESC, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_notes_kind_updated ON notes(kind, updated_at DESC);
            """
        )

    def _migration_5(self, conn: sqlite3.Connection) -> None:
        """0.7 cleanup: retire account/mail/profile data from the active database."""
        conn.execute("PRAGMA foreign_keys=OFF")
        for table in ("profile", "contacts", "email_history"):
            conn.execute(f"DROP TABLE IF EXISTS {table}")
        teacher_columns = {row[1] for row in conn.execute("PRAGMA table_info(teachers)").fetchall()}
        if "email" in teacher_columns:
            try:
                conn.execute("ALTER TABLE teachers DROP COLUMN email")
            except sqlite3.DatabaseError:
                # Compatibility path for older SQLite: rebuild the tiny lookup table.
                conn.executescript("""
                    CREATE TABLE teachers_v5 (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
                    INSERT OR IGNORE INTO teachers_v5(id,name) SELECT id,name FROM teachers;
                    DROP TABLE teachers;
                    ALTER TABLE teachers_v5 RENAME TO teachers;
                """)
        conn.execute("PRAGMA foreign_keys=ON")

    def _migration_6(self, conn: sqlite3.Connection) -> None:
        """0.7.1 Pré-2: monotonic editor revisions used by conflict-safe autosave."""
        columns = {row[1] for row in conn.execute("PRAGMA table_info(notes)").fetchall()}
        if "edit_revision" not in columns:
            conn.execute("ALTER TABLE notes ADD COLUMN edit_revision INTEGER NOT NULL DEFAULT 0")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_notes_revision ON notes(id, edit_revision)")

    def maintenance(self, force: bool = False) -> dict[str, Any]:
        """Run cheap SQLite upkeep. VACUUM is reserved for explicit/large cleanup."""
        before = self.path.stat().st_size if self.path.exists() else 0
        conn = self.connect()
        try:
            conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
            conn.execute("PRAGMA optimize")
            freelist = int(conn.execute("PRAGMA freelist_count").fetchone()[0])
            pages = max(1, int(conn.execute("PRAGMA page_count").fetchone()[0]))
        finally:
            conn.close()
        vacuumed = False
        if force or (before > 64 * 1024 * 1024 and freelist / pages > 0.22):
            conn = self.connect()
            try:
                conn.execute("VACUUM")
                vacuumed = True
            finally:
                conn.close()
        after = self.path.stat().st_size if self.path.exists() else 0
        return {"ok": True, "before": before, "after": after, "vacuumed": vacuumed, "free_pages": freelist, "pages": pages}

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
