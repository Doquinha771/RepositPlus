from pathlib import Path

from fastapi.testclient import TestClient

from reposit.backend.api import AppState, create_app
from reposit.backend.config import AppPaths, APP_VERSION, load_identity, load_settings
from reposit.backend.database import Database


def build_client(tmp_path: Path):
    root = tmp_path / "app"
    (root / "frontend").mkdir(parents=True)
    (root / "frontend" / "index.html").write_text("<html>ok</html>", encoding="utf-8")
    paths = AppPaths.from_root(root)
    db = Database(paths.db)
    settings = load_settings(paths)
    identity = load_identity(paths)
    state = AppState(paths, db, settings, identity, 8777)
    return TestClient(create_app(state)), state


def test_v070_defaults_disable_mural_and_add_efficiency_controls(tmp_path: Path):
    client, state = build_client(tmp_path)
    settings = client.get("/api/settings").json()
    assert APP_VERSION == "0.7.1"
    assert settings["memory_soft_limit_mb"] == 192
    assert settings["autosave_enabled"] is True
    assert settings["battery_saver"] is False


def test_note_listing_is_summary_only_but_full_note_is_preserved(tmp_path: Path):
    client, state = build_client(tmp_path)
    content = "A" * 9000 + " fim-do-conteudo"
    note = client.post("/api/notes", json={"title": "Nota longa", "content": content, "kind": "Material"}).json()

    rows = client.get("/api/notes", params={"limit": 10}).json()
    row = next(item for item in rows if item["id"] == note["id"])
    assert len(row["content"]) <= 420
    assert "fim-do-conteudo" not in row["content"]

    full = client.get(f"/api/notes/{note['id']}").json()
    assert full["content"] == content


def test_storage_boot_probe_skips_recursive_attachment_scan(tmp_path: Path):
    client, state = build_client(tmp_path)
    payload = b"x" * 2048
    note = client.post("/api/notes", json={"title": "Com anexo"}).json()
    client.post(f"/api/notes/{note['id']}/files", files={"file": ("a.txt", payload, "text/plain")})

    quick = client.get("/api/storage", params={"details": "false"}).json()
    assert quick["details"] is False
    assert quick["attachments"] == 0
    detailed = client.get("/api/storage").json()
    assert detailed["details"] is True
    assert detailed["attachments"] >= len(payload)


def test_storage_maintenance_does_not_delete_user_attachments(tmp_path: Path):
    client, state = build_client(tmp_path)
    note = client.post("/api/notes", json={"title": "Arquivo importante"}).json()
    uploaded = client.post(
        f"/api/notes/{note['id']}/files",
        files={"file": ("atividade.txt", b"nao apagar", "text/plain")},
    ).json()
    attachment = Path(uploaded["filepath"])
    assert attachment.exists()

    result = client.post("/api/storage/maintenance", json={"force": False})
    assert result.status_code == 200
    assert attachment.exists()
    assert client.get(f"/api/note-files/{uploaded['id']}").content == b"nao apagar"


def test_frontend_contains_v070_efficiency_and_editor_features():
    root = Path(__file__).resolve().parents[2]
    js = (root / "reposit/frontend/js/app.js").read_text(encoding="utf-8")
    css = (root / "reposit/frontend/css/main.css").read_text(encoding="utf-8")
    index = (root / "reposit/frontend/index.html").read_text(encoding="utf-8")

    assert "/api/storage?details=false" in js
    assert "autosave_enabled" in js
    assert "battery_saver" in js
    assert "Excluir subnota" in js
    assert "Agenda de contatos" not in js
    assert "preload=\"none\"" in js
    assert "decoding=\"async\"" in js
    assert "note-open" in css
    assert "savePageFlip" in css
    assert "?v=071stable" in index


