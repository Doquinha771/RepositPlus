from pathlib import Path
import json

from fastapi.testclient import TestClient

from reposit.backend.api import AppState, create_app
from reposit.backend.config import AppPaths, load_identity, load_settings
from reposit.backend.database import Database


def test_new_database_schema_is_valid(tmp_path: Path):
    db=Database(tmp_path/'data'/'fresh.db')
    row=db.fetchone("SELECT count(*) AS n FROM notes")
    assert row['n']==0
    ok,detail=db._quick_check()
    assert ok and detail=='ok'


def test_corrupt_database_is_preserved_and_recreated(tmp_path: Path):
    path=tmp_path/'data'/'REPOSITINFOS.db'
    path.parent.mkdir(parents=True)
    path.write_bytes(b'not a sqlite database at all\x00\x01')
    db=Database(path)
    assert db.last_recovery and db.last_recovery['recovered'] is True
    assert Path(db.last_recovery['original']).exists()
    assert db._quick_check()[0] is True
    report=path.parent/'recovery'/'last-recovery.json'
    assert json.loads(report.read_text(encoding='utf-8'))['integrity_ok'] is True


def test_stable_quick_contract():
    root=Path(__file__).resolve().parents[2]
    js=(root/'reposit/frontend/js/app.js').read_text(encoding='utf-8')
    css=(root/'reposit/frontend/css/main.css').read_text(encoding='utf-8')
    quick_css=(root/'reposit/frontend/quick/quick.css').read_text(encoding='utf-8')
    main=(root/'reposit/main.py').read_text(encoding='utf-8')
    win32=(root/'reposit/quick/win32.py').read_text(encoding='utf-8')
    assert 'document.documentElement.style.zoom' not in js
    assert 'setUiZoom' not in js
    assert "addEventListener('wheel'" not in js
    assert 'Todas as notas' in js
    assert 'DwmSetWindowAttribute' in win32
    assert 'SetLayeredWindowAttributes' not in main
    assert '.search-box' in quick_css and '.result-row' in quick_css
    assert '.capsule' not in quick_css
