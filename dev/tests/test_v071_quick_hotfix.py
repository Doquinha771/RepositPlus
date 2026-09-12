from pathlib import Path
import threading
import time

from reposit.quick.hotkey import QuickHotkey
from reposit.quick.manager import QuickManager
from reposit.quick.state import QuickStateStore

ROOT = Path(__file__).resolve().parents[2]


class FakeWindow:
    def __init__(self):
        self.shown = 0
        self.hidden = 0
        self.resizes = []
        self.js = []

    def show(self):
        self.shown += 1

    def hide(self):
        self.hidden += 1

    def resize(self, width, height):
        self.resizes.append((width, height))

    def evaluate_js(self, code):
        self.js.append(code)


def test_quick_state_keeps_only_finder_query(tmp_path: Path):
    store = QuickStateStore(tmp_path / 'quick-state.json')
    store.update({'query': 'matemática'})
    reloaded = QuickStateStore(tmp_path / 'quick-state.json').get()
    assert reloaded == {'query': 'matemática'}
    assert not list(tmp_path.glob('*.db'))


def test_quick_manager_reuses_the_same_window(monkeypatch, tmp_path: Path):
    manager = QuickManager(QuickStateStore(tmp_path / 'quick-state.json'))
    window = FakeWindow()
    manager.bind_window(window)
    monkeypatch.setattr('reposit.quick.manager.os.name', 'posix')
    manager.mark_ready()
    assert manager.show() is True
    assert manager.hide() is True
    assert manager.show() is True
    assert manager.window is window
    assert window.shown == 2
    assert window.hidden == 1
    assert window.resizes[-1] == manager.WINDOW_SIZE


def test_quick_is_single_state_finder_without_legacy_editor_or_capsule():
    main = (ROOT / 'reposit/main.py').read_text(encoding='utf-8')
    app_js = (ROOT / 'reposit/frontend/js/app.js').read_text(encoding='utf-8')
    main_css = (ROOT / 'reposit/frontend/css/main.css').read_text(encoding='utf-8')
    quick_html = (ROOT / 'reposit/frontend/quick/index.html').read_text(encoding='utf-8')
    quick_js = (ROOT / 'reposit/frontend/quick/quick.js').read_text(encoding='utf-8')
    quick_css = (ROOT / 'reposit/frontend/quick/quick.css').read_text(encoding='utf-8')
    api = (ROOT / 'reposit/backend/api.py').read_text(encoding='utf-8')

    assert 'f"{self.base_url}/quick"' in main
    assert '@app.get("/quick")' in api
    assert 'initOverlay' not in app_js
    assert '?overlay=1' not in app_js
    assert '.quick-box' not in main_css

    assert 'Buscar ou criar uma nota' in quick_html
    assert 'autofocus' in quick_html
    assert 'textarea' not in quick_html.lower()
    assert 'note-title' not in quick_html
    assert 'capsule' not in quick_html.lower()
    assert 'Recolher' not in quick_html
    assert 'Escreva algo rápido' not in quick_html

    assert 'quick_set_expanded' not in quick_js
    assert 'quick_save_state' in quick_js
    assert 'quick_open_note' in quick_js
    assert "type: 'create'" in quick_js
    assert "post('/api/notes'" in quick_js
    assert 'setInterval' not in quick_js
    assert 'requestAnimationFrame' not in quick_js
    assert "window.addEventListener('focus', focusSearch)" in quick_js
    assert "document.addEventListener('visibilitychange'" in quick_js
    assert 'search.focus({preventScroll: true})' in quick_js
    assert '⌘' not in quick_js
    assert 'page-back' in quick_js
    assert 'playEnterAnimation' not in quick_js
    assert 'setTimeout(() => load(search.value), 150)' not in quick_js
    assert 'load(search.value);' in quick_js
    assert 'prepareShow: () => focusSearch(true)' in quick_js
    assert 'onShown: () => {' in quick_js
    assert 'focusSearch(false);' in quick_js
    assert "window.addEventListener('DOMContentLoaded', init)" in quick_js
    assert 'Digite para pesquisar. Se não existir, crie uma nova nota.' not in quick_html
    assert 'quick-footer' not in quick_html

    assert '.search-box' in quick_css
    assert '.result-row' in quick_css
    assert '.traffic-close' in quick_css
    assert '.capsule' not in quick_css
    assert '.editor-card' not in quick_css
    assert '@keyframes quick-enter' not in quick_css


def test_win32_quick_contract_is_event_driven_and_monitor_aware():
    win32 = (ROOT / 'reposit/quick/win32.py').read_text(encoding='utf-8')
    assert 'SetWindowPos' in win32
    assert 'SetForegroundWindow' in win32
    assert 'AttachThreadInput' in win32
    assert 'SetFocus' in win32
    assert 'GetForegroundWindow' in win32
    assert 'MonitorFromWindow' in win32
    assert 'MonitorFromPoint' in win32
    assert 'GetMonitorInfoW' in win32
    assert 'IVirtualDesktopManager' in win32
    assert 'MoveWindowToDesktop' in win32 or 'move_to_desktop' in win32.lower()
    assert 'HWND_TOPMOST' in win32
    assert 'HWND_NOTOPMOST' in win32
    assert '.AnimateWindow(' not in win32
    assert '_animate_slide_async' in win32
    assert 'SetWindowPos' in win32
    assert 'QUICK_ENTER_DURATION_MS = 135' in win32
    assert 'QUICK_ENTER_OFFSET_DIP = 28' in win32
    assert 'SetProcessDpiAwarenessContext' in win32


def test_hotkey_has_one_toggle_path_and_no_main_activation():
    main = (ROOT / 'reposit/main.py').read_text(encoding='utf-8')
    hotkey = (ROOT / 'reposit/quick/hotkey.py').read_text(encoding='utf-8')
    assert 'QuickHotkey(self.toggle_quick' in main
    assert 'keyboard_module.hook(self._on_keyboard_event' in hotkey
    assert 'keyboard_module.is_pressed("left ctrl")' in hotkey
    assert 'keyboard_module.is_pressed("left alt")' in hotkey
    assert 'ctrl+alt+space' not in (main + hotkey).lower()
    assert 'def show_quick(' not in main

    register = main[main.index('    def register_hotkey'):main.index('    def toggle_quick')]
    assert 'self.main_window.show()' not in register
    toggle = main[main.index('    def toggle_quick'):main.index('    def on_main_loaded')]
    assert 'self.main_window' not in toggle


class FakeKeyboard:
    def __init__(self):
        self.callback = None
        self.pressed = set()
        self.unhooked = []

    def hook(self, callback, suppress=False):
        self.callback = callback
        return object()

    def unhook(self, hook):
        self.unhooked.append(hook)

    def is_pressed(self, name):
        return name in self.pressed

    def emit(self, name, event_type):
        # The important regression case: Windows may call these events simply
        # ctrl/alt. QuickHotkey must ignore event.name and query sided state.
        assert self.callback is not None
        self.callback(type('Event', (), {'name': name, 'event_type': event_type})())


def test_hotkey_realistic_windows_alias_events_toggle_once_per_chord():
    keyboard = FakeKeyboard()
    called = []
    fired = threading.Event()

    def toggle():
        called.append('toggle')
        fired.set()

    hotkey = QuickHotkey(toggle)
    assert hotkey.start(keyboard) is True

    keyboard.pressed.add('left ctrl')
    keyboard.emit('ctrl', 'down')
    assert not fired.wait(0.05)

    keyboard.pressed.add('left alt')
    keyboard.emit('alt', 'down')
    assert fired.wait(0.5)
    assert called == ['toggle']

    # Repeat events while both modifiers remain held must not double-toggle.
    fired.clear()
    keyboard.emit('left menu', 'down')
    keyboard.emit('ctrl', 'down')
    time.sleep(0.05)
    assert called == ['toggle']

    # Releasing and pressing again creates exactly one new edge.
    keyboard.pressed.remove('left alt')
    keyboard.emit('alt', 'up')
    keyboard.pressed.add('left alt')
    keyboard.emit('alt', 'down')
    assert fired.wait(0.5)
    assert called == ['toggle', 'toggle']

    hotkey.stop()
    assert keyboard.unhooked


def test_quick_waits_for_webview_ready_before_reveal_and_focuses_immediately(monkeypatch, tmp_path: Path):
    manager = QuickManager(QuickStateStore(tmp_path / 'quick-state.json'))
    window = FakeWindow()
    manager.bind_window(window)
    monkeypatch.setattr('reposit.quick.manager.os.name', 'posix')

    # Early hotkey is accepted but must not reveal an unpainted/black WebView.
    assert manager.show() is True
    assert window.shown == 0
    assert not any('onShown' in code for code in window.js)

    manager.mark_ready()
    assert window.shown == 1
    assert any('prepareShow' in code for code in window.js)
    assert any('onShown' in code for code in window.js)


def test_quick_toggle_can_cancel_pending_show_before_webview_ready(monkeypatch, tmp_path: Path):
    manager = QuickManager(QuickStateStore(tmp_path / 'quick-state.json'))
    window = FakeWindow()
    manager.bind_window(window)
    monkeypatch.setattr('reposit.quick.manager.os.name', 'posix')

    assert manager.toggle() is True
    assert manager.toggle() is False
    manager.mark_ready()
    assert window.shown == 0


def test_native_slide_moves_live_window_down_to_final_position(monkeypatch):
    from reposit.quick.win32 import QuickWin32

    class FakeUser32:
        def __init__(self):
            self.positions = []
        def IsWindow(self, _hwnd):
            return True
        def SetWindowPos(self, _hwnd, _insert_after, x, y, width, height, _flags):
            self.positions.append((x, y, width, height))
            return True

    helper = QuickWin32.__new__(QuickWin32)
    helper._user32 = FakeUser32()
    helper._kernel32 = None
    helper._hwnd = 1
    helper._previous_foreground = 0
    helper._monitor = None
    helper._animation_lock = threading.Lock()
    helper._animation_generation = 1
    monkeypatch.setattr('reposit.quick.win32.time.sleep', lambda _seconds: None)

    helper._animate_slide_async(1, 100, -14, 14, 660, 430, 1)
    ys = [item[1] for item in helper._user32.positions]
    assert ys
    assert ys[-1] == 14
    assert all(a <= b for a, b in zip(ys, ys[1:]))



def test_quick_position_stays_inside_common_monitor_sizes_and_dpi():
    from reposit.quick.win32 import MonitorWorkArea, QuickWin32

    helper = QuickWin32.__new__(QuickWin32)
    resolutions = [
        (1366, 728),   # 1366x768 minus a typical taskbar
        (1920, 1040),  # 1080p work area
        (2560, 1400),  # 1440p work area
        (3840, 2120),  # 4K work area
    ]
    dpis = [96, 120, 144, 168, 192]  # 100, 125, 150, 175, 200%

    for width, height in resolutions:
        for dpi in dpis:
            for left, top in ((0, 0), (-width, 0), (1920, -200)):
                area = MonitorWorkArea(left, top, left + width, top + height, dpi)
                x, y, quick_width, quick_height = helper._position(area, 660, 430)
                assert quick_width <= area.width
                assert quick_height <= area.height
                assert x >= area.left
                assert y >= area.top
                assert x + quick_width <= area.right
                assert y + quick_height <= area.bottom


def test_quick_stable_animation_never_starts_above_work_area():
    win32 = (ROOT / 'reposit/quick/win32.py').read_text(encoding='utf-8')
    assert 'start_y = max(area.top, y - offset)' in win32


def test_quick_rapid_20_toggles_keep_single_window(monkeypatch, tmp_path: Path):
    manager = QuickManager(QuickStateStore(tmp_path / 'quick-state.json'))
    window = FakeWindow()
    manager.bind_window(window)
    monkeypatch.setattr('reposit.quick.manager.os.name', 'posix')
    manager.mark_ready()

    original = manager.window
    for _ in range(20):
        manager.toggle()
    assert manager.window is original
    assert manager.is_visible() is False
    assert window.shown == 10
    assert window.hidden == 10

def test_quick_500_show_hide_cycles_reuse_one_window(monkeypatch, tmp_path: Path):
    manager = QuickManager(QuickStateStore(tmp_path / 'quick-state.json'))
    window = FakeWindow()
    manager.bind_window(window)
    monkeypatch.setattr('reposit.quick.manager.os.name', 'posix')
    manager.mark_ready()

    original_window = manager.window
    for _ in range(500):
        assert manager.show() is True
        assert manager.hide() is True

    assert manager.window is original_window
    assert window.shown == 500
    assert window.hidden == 500
    assert len(window.resizes) == 500
    assert manager.is_visible() is False
