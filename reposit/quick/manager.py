from __future__ import annotations

import logging
import os
import threading
from typing import Any, Callable

from .state import QuickStateStore
from .win32 import QuickWin32


class QuickManager:
    """Owns the single persistent Quick window.

    The Quick has one visual state only: open. It behaves like a compact desktop
    finder, so there is no collapsed/expanded lifecycle to coordinate anymore.
    """

    WINDOW_SIZE = (660, 430)

    def __init__(self, state_store: QuickStateStore, *, title: str = "Reposit+ Quick"):
        self.log = logging.getLogger("reposit.quick")
        self.state_store = state_store
        self.title = title
        self.window: Any = None
        self._win32 = QuickWin32(title)
        self._lock = threading.RLock()
        self._visible = False
        self._ready = threading.Event()
        self._open_note_callback: Callable[[int], Any] | None = None

    def bind_window(self, window: Any) -> None:
        with self._lock:
            self.window = window

    def bind_open_note(self, callback: Callable[[int], Any]) -> None:
        self._open_note_callback = callback

    def mark_ready(self, *_args: Any) -> None:
        self._ready.set()
        if os.name == "nt":
            self._win32.prepare_hidden()

    def is_visible(self) -> bool:
        with self._lock:
            if os.name == "nt" and self._win32.available and self._win32.hwnd():
                self._visible = self._win32.is_visible()
            return self._visible

    def toggle(self) -> bool:
        with self._lock:
            if self._visible or (os.name == "nt" and self._win32.is_visible()):
                self.hide()
                return False
            return self.show()

    def show(self) -> bool:
        with self._lock:
            if not self.window:
                return False
            width, height = self.WINDOW_SIZE
            if os.name == "nt":
                self._win32.prepare_show()
            try:
                self.window.show()
            except Exception as exc:
                self.log.warning("Quick: pywebview não conseguiu mostrar a janela: %s", exc)
                return False

            native_ok = False
            if os.name == "nt":
                native_ok = self._win32.show(width, height)
            else:
                try:
                    self.window.resize(width, height)
                except Exception:
                    pass
            self._visible = True
            try:
                self.window.evaluate_js(
                    "window.RepositQuick && window.RepositQuick.onShown && window.RepositQuick.onShown()"
                )
            except Exception:
                pass
            if os.name == "nt" and not native_ok:
                self.log.warning("Quick abriu pelo pywebview, mas a promoção Win32 falhou; mantendo fallback seguro.")
            return True

    def hide(self) -> bool:
        with self._lock:
            if not self.window:
                return False
            try:
                self.window.evaluate_js(
                    "window.RepositQuick && window.RepositQuick.beforeHide && window.RepositQuick.beforeHide()"
                )
            except Exception:
                pass
            if os.name == "nt":
                self._win32.hide()
            try:
                self.window.hide()
            except Exception as exc:
                self.log.debug("Quick: fallback hide do pywebview falhou: %s", exc)
            self._visible = False
            return True

    def get_state(self) -> dict[str, Any]:
        return self.state_store.get()

    def save_state(self, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        return self.state_store.update(payload or {})

    def open_note_in_main(self, note_id: int) -> dict[str, Any]:
        """Open Main only after an explicit result/create action inside Quick."""
        try:
            if not self._open_note_callback:
                return {"ok": False, "error": "Janela principal indisponível."}
            self._open_note_callback(int(note_id))
            self.hide()
            return {"ok": True}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def hide_quick(self) -> bool:
        return self.hide()

    def quick_get_state(self) -> dict[str, Any]:
        return self.get_state()

    def quick_save_state(self, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        return self.save_state(payload)

    def quick_open_note(self, note_id: int) -> dict[str, Any]:
        return self.open_note_in_main(note_id)

    def exposed_functions(self) -> tuple[Any, ...]:
        return (
            self.hide_quick,
            self.quick_get_state,
            self.quick_save_state,
            self.quick_open_note,
        )
