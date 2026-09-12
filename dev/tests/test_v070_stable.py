from pathlib import Path

from reposit.backend.config import APP_VERSION, AppPaths, load_settings


def test_stable_release_metadata_and_docs(tmp_path: Path):
    root = Path(__file__).resolve().parents[2]
    assert APP_VERSION == '0.7.1'
    assert not (root / 'PREVIEW-NOTES.md').exists()
    assert (root / 'RELEASE-NOTES.md').is_file()
    readme = (root / 'README.md').read_text(encoding='utf-8').lower()
    changelog = (root / 'CHANGELOG.md').read_text(encoding='utf-8').lower()
    assert 'stable' in changelog
    assert 'reposit+ é um aplicativo para organizar atividades' in readme
    assert '0.7.1 pré' not in readme

    paths = AppPaths.from_root(tmp_path / 'app')
    settings = load_settings(paths)
    assert set(settings).issuperset({'autosave_enabled','battery_saver','memory_soft_limit_mb','ui_revision','last_db_maintenance'})
    assert 'theme' not in settings and 'ui_zoom' not in settings
    assert settings['ui_revision'] == 9


def test_stable_frontend_has_no_theme_or_zoom_controls():
    root = Path(__file__).resolve().parents[2]
    js = (root / 'reposit/frontend/js/app.js').read_text(encoding='utf-8')
    index = (root / 'reposit/frontend/index.html').read_text(encoding='utf-8')
    css = (root / 'reposit/frontend/css/main.css').read_text(encoding='utf-8')
    assert 'value="windows_xp"' not in js
    assert 'theme-samples' not in css
    assert 'id="ui-zoom"' not in js
    assert 'zoom-reset' not in js
    assert '?v=071stable' in index



def test_identity_version_is_refreshed_without_changing_device_id(tmp_path: Path):
    import json
    from reposit.backend.config import load_identity
    paths = AppPaths.from_root(tmp_path / 'app')
    paths.identity.write_text(json.dumps({'device_uuid':'abc-123','device_name':'PC','version':'0.6.0'}), encoding='utf-8')
    identity = load_identity(paths)
    assert identity['device_uuid'] == 'abc-123'
    assert identity['version'] == APP_VERSION


def test_database_connection_has_busy_timeout(tmp_path: Path):
    from reposit.backend.database import Database
    db = Database(tmp_path / 'stable.db')
    conn = db.connect()
    try:
        assert int(conn.execute('PRAGMA busy_timeout').fetchone()[0]) >= 5000
    finally:
        conn.close()


def test_removed_network_stack_is_not_packaged():
    root = Path(__file__).resolve().parents[2]
    runtime = (root / 'dev/requirements-runtime.txt').read_text(encoding='utf-8').lower()
    build = (root / 'dev/requirements-build.txt').read_text(encoding='utf-8').lower()
    api = (root / 'reposit/backend/api.py').read_text(encoding='utf-8').lower()
    assert 'httpx' not in runtime
    assert 'httpx==0.28.1' in build  # only the test client needs it during developer builds
    assert not (root / 'reposit/backend/p2p.py').exists()
    assert not (root / 'reposit/backend/discovery.py').exists()
    assert '/api/mural' not in api
    assert '/p2p/share' not in api


def test_memory_governor_uses_cooldown(monkeypatch):
    import importlib
    import sys
    import types
    monkeypatch.setitem(sys.modules, 'webview', types.SimpleNamespace())
    main = importlib.import_module('reposit.main')

    governor = main.WindowsMemoryGovernor(soft_limit_mb=160)
    trims = []
    monkeypatch.setattr(governor, '_process_tree', lambda: [1, 2])
    monkeypatch.setattr(governor, '_working_set', lambda _pid: 100 * 1024 * 1024)
    monkeypatch.setattr(governor, '_trim', lambda pid: trims.append(pid))

    ticks = iter([1000.0, 1030.0, 1040.0])
    monkeypatch.setattr(main.time, 'monotonic', lambda: next(ticks))
    governor.trim_if_needed()
    assert trims == [2, 1]
    governor.trim_if_needed()
    assert trims == [2, 1]
    governor.trim_if_needed(force=True)
    assert trims == [2, 1, 2, 1]
