from __future__ import annotations

import zipfile
from pathlib import Path

from reposit.backend.note_export import EXPORT_FORMATS, write_note_export


def test_note_exports_cover_common_interoperable_formats(tmp_path: Path):
    note = {
        "id": 7,
        "title": "Atividade de português",
        "kind": "Anotação",
        "tags": "escola, teste",
        "content_format": "html",
        "content": "<h2>Título</h2><p>Texto com <strong>acentuação</strong>.</p>",
        "updated_at": "2026-09-08T21:00:00",
    }
    assert set(EXPORT_FORMATS) == {"txt", "md", "html", "json", "rtf", "docx", "pdf"}
    for fmt, (_, ext) in EXPORT_FORMATS.items():
        target = write_note_export(note, tmp_path / f"saida-{fmt}", fmt)
        assert target.suffix == ext
        assert target.exists()
        assert target.stat().st_size > 20

    assert (tmp_path / "saida-pdf.pdf").read_bytes().startswith(b"%PDF-")
    with zipfile.ZipFile(tmp_path / "saida-docx.docx") as zf:
        assert "word/document.xml" in zf.namelist()
        assert "Atividade de portugu" in zf.read("word/document.xml").decode("utf-8")


def test_frontend_ui_input_hotfix_contract():
    root = Path(__file__).resolve().parents[2]
    js = (root / "reposit/frontend/js/app.js").read_text(encoding="utf-8")
    css = (root / "reposit/frontend/css/main.css").read_text(encoding="utf-8")
    quick_css = (root / "reposit/frontend/quick/quick.css").read_text(encoding="utf-8")
    main = (root / "reposit/main.py").read_text(encoding="utf-8")
    win32 = (root / "reposit/quick/win32.py").read_text(encoding="utf-8")

    # UI icons come from Windows itself. No CDN, download script or bundled icon files.
    assert "Segoe Fluent Icons" in css
    assert "Segoe MDL2 Assets" in css
    assert "/static/assets/icons8/" not in js
    assert not (root / "dev/vendor_icons8.py").exists()
    # Uma pasta legado deixada por extração sobre versão antiga não muda o runtime.
    # A build limpa esse diretório automaticamente antes dos testes.
    assert "--rp-icon" not in css

    # Main window uses native Windows chrome so drag, Alt+Tab and taskbar behavior stay native.
    assert "frameless=False" in main
    assert "begin_drag_main" not in js
    assert "DwmSetWindowAttribute" in win32
    assert "SetLayeredWindowAttributes" not in main
    assert "--window:#1d1d1f" in quick_css
    assert '.search-box' in quick_css
    assert '.editor-card' not in quick_css

    # Requested editor/input behaviors.
    assert "data-subnote-delete" in js
    assert "Excluir esta subnota" in js
    assert "['Backspace','Delete']" in js
    assert "context-submenu" in js
    assert "openExportModal" in js
    assert "tool-more" not in js
    assert "notion-trash" in css
    assert "setUiZoom" not in js
    assert "document.documentElement.style.zoom" not in js
    assert "ui-zoom" not in js
    assert "1600" in js


def test_sidebar_feature_routes_share_active_state_selector():
    root = Path(__file__).resolve().parents[2]
    js = (root / "reposit/frontend/js/app.js").read_text(encoding="utf-8")
    assert 'data-route="sends"' not in js
    assert 'data-route="settings" class="sidebar-feature' in js
    assert "$$('[data-route]').forEach" in js


def test_deleting_subnote_also_removes_parent_token(tmp_path: Path):
    from fastapi.testclient import TestClient
    from reposit.backend.api import AppState, create_app
    from reposit.backend.config import AppPaths, load_identity, load_settings
    from reposit.backend.database import Database

    root = tmp_path / "app"
    (root / "frontend").mkdir(parents=True)
    (root / "frontend" / "index.html").write_text("<html>ok</html>", encoding="utf-8")
    paths = AppPaths.from_root(root)
    state = AppState(paths, Database(paths.db), load_settings(paths), load_identity(paths), 8777)
    client = TestClient(create_app(state))
    parent = client.post("/api/notes", json={"title": "Pai", "content_format": "html", "content": "<p>Antes</p>"}).json()
    child = client.post(f"/api/notes/{parent['id']}/subnotes", json={"title": "Filha"}).json()
    token = f"[[reposit-subnote:{child['id']}]]"
    client.patch(f"/api/notes/{parent['id']}", json={"content": f"<p>Antes</p>{token}<p>Depois</p>", "content_format": "html"})

    deleted = client.delete(f"/api/notes/{child['id']}")
    assert deleted.status_code == 200
    assert deleted.json()["parent_note_id"] == parent["id"]
    loaded = client.get(f"/api/notes/{parent['id']}").json()
    assert token not in loaded["content"]
    assert "Antes" in loaded["content"] and "Depois" in loaded["content"]
