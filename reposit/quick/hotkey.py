from __future__ import annotations

import logging
import threading
from typing import Any, Callable


class QuickHotkey:
    """Edge-triggered global Left Ctrl + Left Alt shortcut.

    The ``keyboard`` package does not guarantee that Windows modifier events are
    named ``left ctrl``/``left alt`` in a generic hook. Depending on the backend
    and keyboard layout they may arrive as ``ctrl``, ``alt`` or ``left menu``.
    Relying on ``event.name`` therefore made the Pré-1 shortcut silently stop
    working on real Windows machines.

    Instead, every keyboard event is only a wake-up signal. The actual chord is
    read with ``keyboard.is_pressed('left ctrl')`` and
    ``keyboard.is_pressed('left alt')``, which is the same sided-key mechanism
    that was proven to work in the 0.7.0 Stable. A rising-edge latch guarantees
    exactly one toggle until either modifier is released.
    """

    def __init__(self, callback: Callable[[], Any], logger: logging.Logger | None = None):
        self.callback = callback
        self.log = logger or logging.getLogger("reposit.quick.hotkey")
        self._keyboard: Any = None
        self._hook: Any = None
        self._chord_down = False
        self._state_lock = threading.Lock()
        self._invoke_lock = threading.Lock()

    @property
    def running(self) -> bool:
        return self._hook is not None

    def start(self, keyboard_module: Any = None) -> bool:
        if self.running:
            return True
        try:
            if keyboard_module is None:
                import keyboard as keyboard_module  # type: ignore[no-redef]
            self._keyboard = keyboard_module
            self._hook = keyboard_module.hook(self._on_keyboard_event, suppress=False)
            return True
        except Exception as exc:
            self._keyboard = None
            self._hook = None
            self.log.warning("Atalho global indisponível: %s", exc)
            return False

    def stop(self) -> None:
        keyboard_module = self._keyboard
        hook = self._hook
        self._hook = None
        self._keyboard = None
        with self._state_lock:
            self._chord_down = False
        if keyboard_module is not None and hook is not None:
            try:
                keyboard_module.unhook(hook)
            except Exception:
                pass

    def _left_chord_pressed(self) -> bool:
        keyboard_module = self._keyboard
        if keyboard_module is None:
            return False
        try:
            return bool(
                keyboard_module.is_pressed("left ctrl")
                and keyboard_module.is_pressed("left alt")
            )
        except Exception:
            return False

    def _on_keyboard_event(self, _event: Any) -> None:
        chord_down = self._left_chord_pressed()
        should_toggle = False
        with self._state_lock:
            if chord_down and not self._chord_down:
                self._chord_down = True
                should_toggle = True
            elif not chord_down:
                self._chord_down = False

        if should_toggle:
            self.log.info("Atalho global acionado: left ctrl + left alt")
            # Never block keyboard's low-level hook while pywebview/Win32 raises
            # the overlay. Windows can discard slow keyboard hooks entirely.
            threading.Thread(
                target=self._invoke,
                name="reposit-hotkey-toggle",
                daemon=True,
            ).start()

    def _invoke(self) -> None:
        # Fast release/re-press sequences are allowed, but native window toggles
        # themselves are serialized so two threads never race the same HWND.
        with self._invoke_lock:
            try:
                self.callback()
            except Exception as exc:
                self.log.warning("Falha ao alternar Reposit+ Quick: %s", exc)
