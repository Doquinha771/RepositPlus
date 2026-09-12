from __future__ import annotations

from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import threading

from fastapi.testclient import TestClient

from reposit.backend.api import AppState, create_app
from reposit.backend.config import AppPaths, load_identity, load_settings
from reposit.backend.database import Database

ROOT = Path(__file__).resolve().parents[2]


def make_client(tmp_path: Path) -> TestClient:
    root = tmp_path / "app"
    (root / "frontend").mkdir(parents=True)
    (root / "frontend" / "index.html").write_text("<html>ok</html>", encoding="utf-8")
    paths = AppPaths.from_root(root)
    state = AppState(paths, Database(paths.db), load_settings(paths), load_identity(paths), 8777)
    return TestClient(create_app(state))


def test_note_revision_rejects_delayed_save(tmp_path: Path):
    client = make_client(tmp_path)
    note = client.post("/api/notes", json={"title": "A", "content": "inicial"}).json()
    assert note["edit_revision"] == 0

    newer = client.patch(
        f"/api/notes/{note['id']}",
        json={"content": "revisão nova", "content_format": "html", "save_revision": 2},
    )
    assert newer.status_code == 200
    assert newer.json()["edit_revision"] == 2

    delayed = client.patch(
        f"/api/notes/{note['id']}",
        json={"content": "resposta velha", "content_format": "html", "save_revision": 1},
    )
    assert delayed.status_code == 409
    assert delayed.json()["detail"]["current_revision"] == 2
    loaded = client.get(f"/api/notes/{note['id']}").json()
    assert loaded["content"] == "revisão nova"
    assert loaded["edit_revision"] == 2



def test_concurrent_revisioned_patches_always_converge_to_newest(tmp_path: Path):
    client = make_client(tmp_path)
    for index in range(30):
        note = client.post("/api/notes", json={"title": f"stress-{index}", "content": "base"}).json()
        barrier = threading.Barrier(3)

        def send(revision: int):
            barrier.wait()
            response = client.patch(
                f"/api/notes/{note['id']}",
                json={
                    "content": f"rev-{revision}",
                    "content_format": "html",
                    "save_revision": revision,
                },
            )
            return response.status_code

        with ThreadPoolExecutor(max_workers=2) as pool:
            old = pool.submit(send, 1)
            new = pool.submit(send, 2)
            barrier.wait()
            statuses = {old.result(), new.result()}

        assert statuses <= {200, 409}
        loaded = client.get(f"/api/notes/{note['id']}").json()
        assert loaded["edit_revision"] == 2
        assert loaded["content"] == "rev-2"

def test_same_save_revision_is_idempotent(tmp_path: Path):
    client = make_client(tmp_path)
    note = client.post("/api/notes", json={"title": "A"}).json()
    first = client.patch(
        f"/api/notes/{note['id']}",
        json={"content": "conteúdo confirmado", "content_format": "html", "save_revision": 1},
    )
    assert first.status_code == 200

    retry = client.patch(
        f"/api/notes/{note['id']}",
        json={"content": "não deve substituir", "content_format": "html", "save_revision": 1},
    )
    assert retry.status_code == 200
    assert retry.json()["content"] == "conteúdo confirmado"
    assert retry.json()["edit_revision"] == 1


def test_database_schema_has_monotonic_note_revision(tmp_path: Path):
    db = Database(tmp_path / "REPOSITINFOS.db")
    columns = {row["name"] for row in db.fetchall("PRAGMA table_info(notes)")}
    assert "edit_revision" in columns
    assert db.fetchone("PRAGMA user_version")["user_version"] == 6



def test_migration_to_revision_schema_preserves_existing_note(tmp_path: Path):
    import sqlite3

    db_path = tmp_path / "legacy.db"
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL DEFAULT '',
                kind TEXT NOT NULL DEFAULT 'Anotação',
                content TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '',
                pinned INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                content_format TEXT NOT NULL DEFAULT 'plain',
                parent_note_id INTEGER
            );
            CREATE VIRTUAL TABLE note_fts USING fts5(note_id UNINDEXED,title,kind,content,tags);
            PRAGMA user_version=5;
            """
        )
        conn.execute(
            "INSERT INTO notes(title,kind,content,tags,pinned,created_at,updated_at,content_format) VALUES (?,?,?,?,?,?,?,?)",
            ("Legada", "Anotação", "conteúdo intacto", "teste", 0, "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00", "html"),
        )
        conn.commit()
    finally:
        conn.close()

    db = Database(db_path)
    row = db.fetchone("SELECT title,content,edit_revision FROM notes WHERE title=?", ("Legada",))
    assert row["content"] == "conteúdo intacto"
    assert row["edit_revision"] == 0
    assert db.fetchone("PRAGMA user_version")["user_version"] == 6

def test_frontend_pre2_pre3_contract():
    js = (ROOT / "reposit/frontend/js/app.js").read_text(encoding="utf-8")
    css = (ROOT / "reposit/frontend/css/main.css").read_text(encoding="utf-8")

    # Pré-2: state and request ordering are per note, not global.
    assert "const noteSessions=new Map()" in js
    assert "saveRevision" in js and "savedRevision" in js
    assert "save_revision:sentRevision" in js
    assert "session.inFlight" in js
    assert "NOTE_DRAFT_PREFIX" in js
    assert "hasPendingNoteChanges()" in js
    assert "Alterações pendentes" in js
    assert "Erro ao salvar" in js
    assert "save-retry" in js
    assert "let saveTimer" not in js

    # Pré-3: selection, paste sanitation, IME and editor shortcuts.
    assert "class SelectionManager" in js
    assert "selectionManager.restore" in js
    assert "handleEditorPaste" in js
    assert "RICH_ALLOWED_TAGS" in js
    assert "compositionstart" in js and "compositionend" in js
    assert "forcePlainPasteOnce" in js
    assert "openNoteFind" in js
    assert "findTextInEditor" in js
    assert "editorFormat('bold')" in js
    assert "editorFormat('italic')" in js
    assert "editorFormat('underline')" in js
    assert "insertLink()" in js
    assert ".note-findbar" in css
