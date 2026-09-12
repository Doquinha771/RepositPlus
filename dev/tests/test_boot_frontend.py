from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_frontend_boot_does_not_use_es_modules():
    html = (ROOT / "reposit" / "frontend" / "index.html").read_text(encoding="utf-8")
    js = (ROOT / "reposit" / "frontend" / "js" / "app.js").read_text(encoding="utf-8")
    assert 'type="module"' not in html
    assert "import { get, post, patch, del, form }" not in js
    assert "window.__REPOSIT_BOOT_OK__ = true" in js


def test_frontend_renders_before_optional_hydration():
    js = (ROOT / "reposit" / "frontend" / "js" / "app.js").read_text(encoding="utf-8")
    init = js[js.index("async function init(){"):js.index("function renderShell(){")]
    assert init.index("renderShell();") < init.index("Promise.allSettled")
    assert "AbortController" in js
    assert "8000" in js
