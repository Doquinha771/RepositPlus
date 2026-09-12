from pathlib import Path


def test_frontend_uses_large_sheet_tabs_context_menu_and_flaticon():
    root = Path(__file__).resolve().parents[2]
    app_js = (root / "reposit" / "frontend" / "js" / "app.js").read_text(encoding="utf-8")
    css = (root / "reposit" / "frontend" / "css" / "main.css").read_text(encoding="utf-8")
    index = (root / "reposit" / "frontend" / "index.html").read_text(encoding="utf-8")

    assert "app-stage" in app_js
    assert "site-sheet" in app_js
    assert "Nova nota" in app_js
    assert "ondblclick" in app_js
    assert "renderNotionPage" in app_js
    assert 'contenteditable="true"' in app_js
    assert "renderNoteTabs" in app_js
    assert "note-tabbar" in app_js
    assert "openNoteContextMenu" in app_js
    assert "Anexar arquivo" in app_js
    assert "notion-files" not in app_js
    assert "Caixa de entrada" not in app_js
    assert "Seu espaço" not in app_js
    assert "Compartilhe sem complicação" not in app_js
    assert "notion-content" in css
    assert "site-sheet" in css
    assert "v0.1.0 rev.8" in css
    assert "note-context-menu" in css
    assert "period-tabs-large" in css
    assert "cdn-uicons.flaticon.com" not in index
    assert "rp-icon" in app_js
    assert "--stage:#090b10" in css
    assert "--sidebar-width" in css
    assert "Continuar com Google" not in app_js
    assert "login-password" not in app_js
    assert "applyUiPreferences" in app_js
    assert "boot-screen" in index


def test_frontend_remains_full_bleed_and_borderless_minimal():
    root = Path(__file__).resolve().parents[2]
    css = (root / "reposit" / "frontend" / "css" / "main.css").read_text(encoding="utf-8")
    assert "v0.1.0 rev.7" in css
    assert "padding:0!important" in css
    assert "border:0!important" in css
    assert "box-shadow:none!important" in css


def test_rev9_sidebar_autosave_shortcuts_and_palette():
    root = Path(__file__).resolve().parents[2]
    app_js = (root / "reposit" / "frontend" / "js" / "app.js").read_text(encoding="utf-8")
    css = (root / "reposit" / "frontend" / "css" / "main.css").read_text(encoding="utf-8")
    assert "sidebar-toggle" in app_js
    assert "sidebarCollapsed" in app_js
    assert "scheduleSettingsSave" in app_js
    assert "Alterações pendentes" in app_js
    assert "data-settings-tab" in app_js
    assert "openWallPost" not in app_js
    assert "wall-reader-content" not in app_js
    assert "data-row-delete" in app_js
    assert "Left Ctrl + Left Alt" in app_js
    assert "Quick alternativo" not in app_js
    assert "Ctrl + D" in app_js
    assert "email-compose-modal" not in app_js
    assert "v0.1.0 rev.9" in css
    assert "--accent:#28D968" in css
    assert "--mint:#79D6B2" in css
    assert "sidebar-collapsed" in css
    assert "@keyframes routeIn" in css
    assert "email-compose-modal" not in css
