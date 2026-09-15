from __future__ import annotations

import sqlite3
import threading
import json
import shutil
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

CURRENT_SCHEMA_VERSION = 10


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Database:
    def __init__(self, path: Path):
        self.path = path
        self._local = threading.local()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.last_recovery: dict[str, Any] | None = None
        self.last_migration_backup: str | None = None
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
        """Create the current schema atomically without recursing through __init__."""
        conn = sqlite3.connect(self.path, timeout=20)
        try:
            conn.execute("PRAGMA foreign_keys=OFF")
            conn.execute("BEGIN IMMEDIATE")
            self._migration_1(conn)
            self._migration_2(conn)
            self._migration_3(conn)
            self._migration_4(conn)
            self._migration_5(conn)
            self._migration_6(conn)
            self._migration_7(conn)
            self._migration_8(conn)
            self._migration_9(conn)
            self._migration_10(conn)
            violations = conn.execute("PRAGMA foreign_key_check").fetchall()
            if violations:
                sample = ", ".join(str(tuple(row)) for row in violations[:5])
                raise RuntimeError(f"Bootstrap criaria relações inválidas: {sample}")
            conn.execute(f"PRAGMA user_version={CURRENT_SCHEMA_VERSION}")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
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

    def _backup_before_migration(self, from_version: int) -> Path | None:
        if not self.path.exists() or self.path.stat().st_size == 0:
            return None
        backup_dir = self.path.parent / "migration-backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        backup = backup_dir / f"{self.path.stem}.v{from_version}-before-v{CURRENT_SCHEMA_VERSION}-{stamp}{self.path.suffix}"
        source = sqlite3.connect(self.path, timeout=20)
        target = sqlite3.connect(backup, timeout=20)
        try:
            source.backup(target)
            target.commit()
        finally:
            target.close()
            source.close()
        self.last_migration_backup = str(backup)
        # Keep migration safety bounded. Five known-good snapshots are enough;
        # infinite backups are just a disk leak wearing a safety badge.
        candidates = sorted(backup_dir.glob(f"{self.path.stem}.v*-before-v*{self.path.suffix}"), key=lambda p: p.stat().st_mtime, reverse=True)
        for stale in candidates[5:]:
            try:
                stale.unlink()
            except OSError:
                pass
        return backup


    @staticmethod
    def _executescript_atomic(conn: sqlite3.Connection, script: str) -> None:
        """Execute a SQL script without sqlite3.executescript's implicit COMMIT.

        Migrations are wrapped by one explicit transaction in ``migrate``.
        ``sqlite3.Connection.executescript`` commits a pending transaction before
        running its script, which can leave half-migrated schemas behind when a
        later migration fails.  Split only at SQLite-complete statement
        boundaries and execute each statement through ``execute`` instead.
        """
        statement = ""
        for char in str(script):
            statement += char
            if char == ";" and sqlite3.complete_statement(statement):
                sql = statement.strip()
                statement = ""
                if sql:
                    conn.execute(sql)
        tail = statement.strip()
        if tail:
            if not sqlite3.complete_statement(tail + ";"):
                raise sqlite3.OperationalError("SQL de migration incompleto")
            conn.execute(tail)

    def migrate(self) -> None:
        probe = sqlite3.connect(self.path, timeout=20)
        try:
            version = int(probe.execute("PRAGMA user_version").fetchone()[0])
        finally:
            probe.close()
        if version > CURRENT_SCHEMA_VERSION:
            raise RuntimeError(f"Banco usa schema v{version}, mais novo que o suportado v{CURRENT_SCHEMA_VERSION}.")
        if version < CURRENT_SCHEMA_VERSION:
            self._backup_before_migration(version)
        with self.session() as conn:
            # Foreign-key mode must be selected before BEGIN.  Migrations may
            # rebuild referenced lookup tables, then we validate all relations
            # before the single transaction is allowed to commit.
            conn.execute("PRAGMA foreign_keys=OFF")
            conn.execute("BEGIN IMMEDIATE")
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
            if version < 7:
                self._migration_7(conn)
                version = 7
            if version < 8:
                self._migration_8(conn)
                version = 8
            if version < 9:
                self._migration_9(conn)
                version = 9
            if version < 10:
                self._migration_10(conn)
                version = 10
            violations = conn.execute("PRAGMA foreign_key_check").fetchall()
            if violations:
                sample = ", ".join(str(tuple(row)) for row in violations[:5])
                raise RuntimeError(f"Migration criaria relações inválidas: {sample}")
            conn.execute(f"PRAGMA user_version={version}")

    def _migration_1(self, conn: sqlite3.Connection) -> None:
        self._executescript_atomic(conn, 
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
        self._executescript_atomic(conn, 
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
        self._executescript_atomic(conn, 
            """
            CREATE INDEX IF NOT EXISTS idx_notes_parent_updated ON notes(parent_note_id, pinned DESC, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_notes_kind_updated ON notes(kind, updated_at DESC);
            """
        )

    def _migration_5(self, conn: sqlite3.Connection) -> None:
        """0.7 cleanup: retire account/mail/profile data from the active database."""
        for table in ("profile", "contacts", "email_history"):
            conn.execute(f"DROP TABLE IF EXISTS {table}")
        teacher_columns = {row[1] for row in conn.execute("PRAGMA table_info(teachers)").fetchall()}
        if "email" in teacher_columns:
            try:
                conn.execute("ALTER TABLE teachers DROP COLUMN email")
            except sqlite3.DatabaseError:
                # Compatibility path for older SQLite: rebuild the tiny lookup table.
                self._executescript_atomic(conn, """
                    CREATE TABLE teachers_v5 (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
                    INSERT OR IGNORE INTO teachers_v5(id,name) SELECT id,name FROM teachers;
                    DROP TABLE teachers;
                    ALTER TABLE teachers_v5 RENAME TO teachers;
                """)

    def _migration_6(self, conn: sqlite3.Connection) -> None:
        """0.7.1 Pré-2: monotonic editor revisions used by conflict-safe autosave."""
        columns = {row[1] for row in conn.execute("PRAGMA table_info(notes)").fetchall()}
        if "edit_revision" not in columns:
            conn.execute("ALTER TABLE notes ADD COLUMN edit_revision INTEGER NOT NULL DEFAULT 0")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_notes_revision ON notes(id, edit_revision)")

    def _migration_7(self, conn: sqlite3.Connection) -> None:
        """0.7.2: staged attachment reconciliation and safe two-phase deletion metadata."""
        conn.execute(
            """CREATE TABLE IF NOT EXISTS note_files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                note_id INTEGER NOT NULL,
                filename TEXT NOT NULL,
                filepath TEXT NOT NULL,
                file_type TEXT NOT NULL DEFAULT '',
                file_hash TEXT NOT NULL,
                size INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'active',
                confirmed_revision INTEGER NOT NULL DEFAULT 0,
                deleted_at TEXT NOT NULL DEFAULT '',
                FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
            )"""
        )
        columns = {row[1] for row in conn.execute("PRAGMA table_info(note_files)").fetchall()}
        if "state" not in columns:
            conn.execute("ALTER TABLE note_files ADD COLUMN state TEXT NOT NULL DEFAULT 'active'")
        if "confirmed_revision" not in columns:
            conn.execute("ALTER TABLE note_files ADD COLUMN confirmed_revision INTEGER NOT NULL DEFAULT 0")
        if "deleted_at" not in columns:
            conn.execute("ALTER TABLE note_files ADD COLUMN deleted_at TEXT NOT NULL DEFAULT ''")
        conn.execute("UPDATE note_files SET state='active' WHERE state IS NULL OR state='' ")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_note_files_state ON note_files(note_id, state)")


    def _migration_8(self, conn: sqlite3.Connection) -> None:
        """0.7.3: workspace/search longevity indexes only.

        Keep this migration deliberately boring: no table rewrites, no content
        conversion and no new hard dependency. FTS already exists from schema v2.
        """
        conn.execute("CREATE INDEX IF NOT EXISTS idx_notes_title_nocase ON notes(title COLLATE NOCASE)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_notes_updated_parent ON notes(parent_note_id, updated_at DESC)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_notes_pinned_updated ON notes(pinned DESC, updated_at DESC)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_note_files_note_state ON note_files(note_id, state)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_note_files_filepath ON note_files(filepath)")


    def _migration_9(self, conn: sqlite3.Connection) -> None:
        """0.7.4: productivity metadata, trash, templates and bounded note history.

        This migration deliberately avoids rewriting note content. New columns are
        additive so 0.7.0-0.7.3 data opens without manual conversion.
        """
        columns = {row[1] for row in conn.execute("PRAGMA table_info(notes)").fetchall()}
        additions = {
            "favorite": "INTEGER NOT NULL DEFAULT 0",
            "trashed_at": "TEXT NOT NULL DEFAULT ''",
            "manual_order": "REAL NOT NULL DEFAULT 0",
            "last_opened_at": "TEXT NOT NULL DEFAULT ''",
        }
        for name, definition in additions.items():
            if name not in columns:
                conn.execute(f"ALTER TABLE notes ADD COLUMN {name} {definition}")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_notes_trash_updated ON notes(trashed_at, updated_at DESC)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_notes_favorite_updated ON notes(favorite DESC, updated_at DESC)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_notes_recent ON notes(last_opened_at DESC)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_notes_manual_order ON notes(manual_order, id)")

        conn.execute(
            """CREATE TABLE IF NOT EXISTS note_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                note_id INTEGER NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                kind TEXT NOT NULL DEFAULT 'Anotação',
                content TEXT NOT NULL DEFAULT '',
                content_format TEXT NOT NULL DEFAULT 'plain',
                tags TEXT NOT NULL DEFAULT '',
                edit_revision INTEGER NOT NULL DEFAULT 0,
                reason TEXT NOT NULL DEFAULT 'autosave',
                created_at TEXT NOT NULL,
                FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
            )"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_note_history_note_created ON note_history(note_id, created_at DESC, id DESC)")

        conn.execute(
            """CREATE TABLE IF NOT EXISTS note_templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL DEFAULT 'Anotação',
                content TEXT NOT NULL DEFAULT '',
                content_format TEXT NOT NULL DEFAULT 'html',
                tags TEXT NOT NULL DEFAULT '',
                builtin INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"""
        )
        now = utcnow()
        templates = [
            ("Em branco", "Anotação", "", "html", "", 1),
            ("Atividade", "Atividade", "<h2>Objetivo</h2><p><br></p><h2>Desenvolvimento</h2><p><br></p><h2>Entrega</h2><p><br></p>", "html", "", 1),
            ("Resumo", "Resumo", "<h2>Resumo</h2><p><br></p><h2>Pontos principais</h2><ul><li><br></li></ul>", "html", "", 1),
            ("Anotação de aula", "Anotação", "<h2>Tópicos</h2><p><br></p><h2>Anotações</h2><p><br></p><h2>Dúvidas</h2><p><br></p>", "html", "", 1),
            ("Projeto", "Projeto", "<h2>Objetivo</h2><p><br></p><h2>Etapas</h2><div class=\"reposit-checklist\"><p data-check-item=\"0\">☐ Planejar</p><p data-check-item=\"0\">☐ Executar</p><p data-check-item=\"0\">☐ Revisar</p></div>", "html", "", 1),
            ("Checklist", "Checklist", "<div class=\"reposit-checklist\"><p data-check-item=\"0\">☐ Novo item</p></div>", "html", "", 1),
        ]
        for name, kind, content, fmt, tags, builtin in templates:
            conn.execute(
                "INSERT OR IGNORE INTO note_templates(name,kind,content,content_format,tags,builtin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
                (name, kind, content, fmt, tags, builtin, now, now),
            )

    def _migration_10(self, conn: sqlite3.Connection) -> None:
        """0.7.4.1: compatibility metadata for safe future upgrades.

        This is intentionally metadata-only.  The editor content format remains
        untouched so 0.8.0 can detect what it is opening without 0.7.4.1 trying
        to perform the structural editor migration early.
        """
        conn.execute(
            """CREATE TABLE IF NOT EXISTS app_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL
            )"""
        )
        now = utcnow()
        metadata = {
            "schema_version": str(CURRENT_SCHEMA_VERSION),
            "content_format": "html-tokens-v1",
            "editor_core": "legacy-contenteditable",
            "migration_family": "0.7.x",
        }
        for key, value in metadata.items():
            conn.execute(
                "INSERT INTO app_metadata(key,value,updated_at) VALUES (?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                (key, value, now),
            )

    def startup_health_check(self) -> dict[str, Any]:
        """Cheap startup validation; full integrity_check stays on-demand.

        We validate schema, a one-page quick_check and the handful of tables the
        runtime cannot function without.  This avoids a heavyweight scan on
        every boot while still detecting a half-migrated or obviously corrupt DB.
        """
        conn = self.connect()
        try:
            schema = int(conn.execute("PRAGMA user_version").fetchone()[0])
            quick = str(conn.execute("PRAGMA quick_check(1)").fetchone()[0])
            names = {
                str(row[0])
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('notes','note_files','note_fts','app_metadata')"
                ).fetchall()
            }
            required = {"notes", "note_files", "note_fts", "app_metadata"}
            missing = sorted(required - names)
            ok = schema == CURRENT_SCHEMA_VERSION and quick.lower() == "ok" and not missing
            return {"ok": ok, "schema_version": schema, "quick_check": quick, "missing_tables": missing}
        finally:
            conn.close()

    def set_metadata(self, key: str, value: str) -> None:
        key = str(key or "").strip()[:80]
        if not key:
            raise ValueError("Metadata key is required")
        self.execute(
            "INSERT INTO app_metadata(key,value,updated_at) VALUES (?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
            (key, str(value or "")[:500], utcnow()),
        )

    def get_metadata(self) -> dict[str, str]:
        return {str(r["key"]): str(r["value"]) for r in self.fetchall("SELECT key,value FROM app_metadata ORDER BY key")}

    def integrity_check(self) -> dict[str, Any]:
        """Run SQLite's full integrity check on demand, never on every startup."""
        conn = self.connect()
        try:
            rows = [str(row[0]) for row in conn.execute("PRAGMA integrity_check").fetchall()]
            ok = len(rows) == 1 and rows[0].lower() == "ok"
            fk = [tuple(row) for row in conn.execute("PRAGMA foreign_key_check").fetchall()]
            return {"ok": bool(ok and not fk), "integrity": rows, "foreign_keys": fk[:100]}
        finally:
            conn.close()

    def maintenance(self, force: bool = False) -> dict[str, Any]:
        """Run cheap SQLite upkeep. VACUUM is reserved for explicit/large cleanup."""
        before = self.path.stat().st_size if self.path.exists() else 0
        conn = self.connect()
        try:
            # History is already capped per note at write time.  This global cap
            # prevents thousands of barely-used notes from retaining 25 large
            # snapshots forever. Keep newest 10k snapshots across the database.
            try:
                history_count = int(conn.execute("SELECT COUNT(*) FROM note_history").fetchone()[0])
                if history_count > 10000:
                    conn.execute(
                        "DELETE FROM note_history WHERE id IN (SELECT id FROM note_history ORDER BY id ASC LIMIT ?)",
                        (history_count - 10000,),
                    )
                    conn.commit()
            except sqlite3.OperationalError:
                history_count = 0
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
        return {"ok": True, "before": before, "after": after, "vacuumed": vacuumed, "free_pages": freelist, "pages": pages, "history_snapshots": min(history_count, 10000)}

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
