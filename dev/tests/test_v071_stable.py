from pathlib import Path

from reposit.backend.config import APP_RELEASE_LABEL, APP_VERSION

ROOT = Path(__file__).resolve().parents[2]


def test_v071_stable_release_identity_and_cache_busting():
    assert APP_VERSION == "0.7.1"
    assert APP_RELEASE_LABEL == "0.7.1 Stable"

    main_html = (ROOT / "reposit/frontend/index.html").read_text(encoding="utf-8")
    quick_html = (ROOT / "reposit/frontend/quick/index.html").read_text(encoding="utf-8")
    assert "?v=071stable" in main_html
    assert "?v=071stable" in quick_html
    assert "071pre" not in main_html.lower()
    assert "071pre" not in quick_html.lower()


def test_v071_stable_uses_repository_readme_and_license_baseline():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    license_text = (ROOT / "LICENSE").read_text(encoding="utf-8")
    installer_license = (ROOT / "dev/build/installer/LICENSE.txt").read_text(encoding="utf-8")

    assert readme.startswith("# Reposit+\n")
    assert "Reposit+ é um aplicativo para organizar atividades, anotações e arquivos escolares" in readme
    assert "# Reposit+ 0.7.1 Pré" not in readme
    assert license_text == installer_license
    assert "MIT License" in license_text


def test_v071_stable_runtime_has_no_quick_polling_loop():
    quick_js = (ROOT / "reposit/frontend/quick/quick.js").read_text(encoding="utf-8")
    quick_manager = (ROOT / "reposit/quick/manager.py").read_text(encoding="utf-8")
    hotkey = (ROOT / "reposit/quick/hotkey.py").read_text(encoding="utf-8")

    assert "setInterval" not in quick_js
    assert "requestAnimationFrame" not in quick_js
    assert "while True" not in quick_manager
    assert "keyboard_module.hook" in hotkey
