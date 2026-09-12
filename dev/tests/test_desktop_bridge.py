from pathlib import Path


def test_pywebview_bridge_uses_function_whitelist():
    root = Path(__file__).resolve().parents[2]
    source = (root / 'reposit' / 'main.py').read_text(encoding='utf-8')
    requirements = (root / 'dev' / 'requirements-runtime.txt').read_text(encoding='utf-8')

    assert 'js_api=self.bridge' not in source
    assert 'self.main_window.expose(*exposed)' in source
    assert 'self.quick_window.expose(*self.quick.exposed_functions())' in source
    assert 'pywebview==6.2.1' in requirements


def test_global_hotkey_uses_physical_left_modifiers_and_single_edge_latch():
    root = Path(__file__).resolve().parents[2]
    main = (root / 'reposit' / 'main.py').read_text(encoding='utf-8')
    hotkey = (root / 'reposit' / 'quick' / 'hotkey.py').read_text(encoding='utf-8')
    assert 'QuickHotkey(self.toggle_quick' in main
    assert 'keyboard_module.hook(self._on_keyboard_event' in hotkey
    assert 'keyboard_module.is_pressed("left ctrl")' in hotkey
    assert 'keyboard_module.is_pressed("left alt")' in hotkey
    assert 'self._chord_down' in hotkey
    assert 'reposit-hotkey-toggle' in hotkey
    assert 'ctrl+alt+space' not in (main + hotkey).lower()
