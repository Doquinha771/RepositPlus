from pathlib import Path

from reposit.backend.config import AppPaths, load_settings
from reposit.backend.database import Database


def test_removed_account_features_do_not_exist_in_runtime(tmp_path: Path):
    root = Path(__file__).resolve().parents[2]
    js = (root / 'reposit/frontend/js/app.js').read_text(encoding='utf-8').lower()
    api = (root / 'reposit/backend/api.py').read_text(encoding='utf-8').lower()
    assert 'email' not in js
    assert 'smtp' not in js
    assert 'perfil' not in js
    assert '/api/profile' not in api
    assert '/api/email/' not in api
    assert not (root / 'reposit/backend/email_service.py').exists()

    paths = AppPaths.from_root(tmp_path / 'app')
    db = Database(paths.db)
    tables = {r['name'] for r in db.fetchall("SELECT name FROM sqlite_master WHERE type='table'")}
    assert 'profile' not in tables
    assert 'contacts' not in tables
    assert 'email_history' not in tables
    teacher_cols = {r['name'] for r in db.fetchall('PRAGMA table_info(teachers)')}
    assert 'email' not in teacher_cols


def test_stable_has_single_visual_mode_and_no_internal_zoom(tmp_path: Path):
    root = Path(__file__).resolve().parents[2]
    js = (root / 'reposit/frontend/js/app.js').read_text(encoding='utf-8')
    css = (root / 'reposit/frontend/css/main.css').read_text(encoding='utf-8')
    paths = AppPaths.from_root(tmp_path / 'app')
    settings = load_settings(paths)
    assert 'theme' not in settings
    assert 'ui_zoom' not in settings
    assert 'setUiZoom' not in js
    assert 'zoom-control' not in css


def test_windows_native_window_and_balanced_memory_governor_contract():
    root = Path(__file__).resolve().parents[2]
    main = (root / 'reposit/main.py').read_text(encoding='utf-8')
    assert 'frameless=False' in main
    assert 'WindowsMemoryGovernor' in main
    assert 'EmptyWorkingSet' in main
    assert '--renderer-process-limit=2' in main
    assert '--renderer-process-limit=1' not in main
    assert '--disable-gpu' not in main
    assert '_trim_cooldown = 120.0' in main
    assert 'self._stop.wait(60.0)' in main
    assert '--disk-cache-size=8388608' in main


def test_quick_is_persistent_and_hidden_instead_of_recreated():
    root = Path(__file__).resolve().parents[2]
    main = (root / 'reposit/main.py').read_text(encoding='utf-8')
    manager = (root / 'reposit/quick/manager.py').read_text(encoding='utf-8')
    assert 'self.window.hide()' in manager
    assert 'self.window.destroy()' not in manager
    assert 'webview.create_window(' in main
    assert 'f"{self.base_url}/quick"' in main
    assert 'self.quick_window.expose(*self.quick.exposed_functions())' in main
    assert 'spotlight_window' not in main
    assert 'hide_spotlight' not in main

def test_build_cleans_legacy_removed_modules_before_pytest():
    root = Path(__file__).resolve().parents[2]
    build = (root / 'dev/build/build_windows.ps1').read_text(encoding='utf-8-sig')
    assert r'reposit\backend\email_service.py' in build
    assert r'dev\tests\test_email_service.py' in build
    assert r'reposit\frontend\assets\icons8' in build
    assert r'reposit\backend\p2p.py' in build
    assert r'reposit\backend\discovery.py' in build
    assert build.index('email_service.py') < build.index('Step "Rodando testes"')
