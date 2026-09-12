from __future__ import annotations

import ctypes
import os
import threading
import time
import uuid
from ctypes import wintypes
from dataclasses import dataclass
from typing import Any


MONITOR_DEFAULTTOPRIMARY = 1
MONITOR_DEFAULTTONEAREST = 2
SW_HIDE = 0
SW_SHOW = 5
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040
SWP_FRAMECHANGED = 0x0020
QUICK_ENTER_DURATION_MS = 135
QUICK_ENTER_OFFSET_DIP = 28
QUICK_ENTER_STEPS = 9
HWND_TOPMOST = ctypes.c_void_p(-1)
HWND_NOTOPMOST = ctypes.c_void_p(-2)
GWL_STYLE = -16
GWL_EXSTYLE = -20
WS_CAPTION = 0x00C00000
WS_THICKFRAME = 0x00040000
WS_MINIMIZEBOX = 0x00020000
WS_MAXIMIZEBOX = 0x00010000
WS_SYSMENU = 0x00080000
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_APPWINDOW = 0x00040000
DWMWA_WINDOW_CORNER_PREFERENCE = 33
DWMWCP_ROUND = 2
CLSCTX_INPROC_SERVER = 0x1
COINIT_APARTMENTTHREADED = 0x2


class POINT(ctypes.Structure):
    _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", wintypes.LONG),
        ("top", wintypes.LONG),
        ("right", wintypes.LONG),
        ("bottom", wintypes.LONG),
    ]


class MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", RECT),
        ("rcWork", RECT),
        ("dwFlags", wintypes.DWORD),
    ]


class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", wintypes.DWORD),
        ("Data2", wintypes.WORD),
        ("Data3", wintypes.WORD),
        ("Data4", ctypes.c_ubyte * 8),
    ]

    @classmethod
    def from_string(cls, value: str) -> "GUID":
        raw = uuid.UUID(value).bytes_le
        result = cls()
        ctypes.memmove(ctypes.byref(result), raw, 16)
        return result


CLSID_VIRTUAL_DESKTOP_MANAGER = GUID.from_string("AA509086-5CA9-4C25-8F95-589D3C07B48A")
IID_I_VIRTUAL_DESKTOP_MANAGER = GUID.from_string("A5CD92FF-29BE-454C-8D04-D82879FB3F1B")


@dataclass(frozen=True)
class MonitorWorkArea:
    left: int
    top: int
    right: int
    bottom: int
    dpi: int = 96

    @property
    def width(self) -> int:
        return max(1, self.right - self.left)

    @property
    def height(self) -> int:
        return max(1, self.bottom - self.top)


def enable_per_monitor_v2() -> None:
    """Best-effort Per Monitor V2 DPI awareness before any window is created."""
    if os.name != "nt":
        return
    try:
        # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        return
    except Exception:
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


class QuickWin32:
    """Event-driven native window helper used only by the Quick window."""

    def __init__(self, title: str):
        self.title = title
        self._hwnd = 0
        self._previous_foreground = 0
        self._monitor: MonitorWorkArea | None = None
        self._user32: Any = ctypes.windll.user32 if os.name == "nt" else None
        self._kernel32: Any = ctypes.windll.kernel32 if os.name == "nt" else None
        self._animation_lock = threading.Lock()
        self._animation_generation = 0
        if self._user32 is not None:
            self._configure_api()

    def _configure_api(self) -> None:
        """Declare pointer-sized Win32 signatures so x64 HWND/HMONITOR values are not truncated."""
        try:
            u = self._user32
            hwnd = wintypes.HWND
            hmonitor = wintypes.HANDLE
            u.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
            u.FindWindowW.restype = hwnd
            u.GetForegroundWindow.argtypes = []
            u.GetForegroundWindow.restype = hwnd
            u.GetWindowThreadProcessId.argtypes = [hwnd, ctypes.POINTER(wintypes.DWORD)]
            u.GetWindowThreadProcessId.restype = wintypes.DWORD
            self._kernel32.GetCurrentThreadId.argtypes = []
            self._kernel32.GetCurrentThreadId.restype = wintypes.DWORD
            u.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
            u.AttachThreadInput.restype = wintypes.BOOL
            u.SetFocus.argtypes = [hwnd]
            u.SetFocus.restype = hwnd
            u.IsWindow.argtypes = [hwnd]
            u.IsWindow.restype = wintypes.BOOL
            u.IsWindowVisible.argtypes = [hwnd]
            u.IsWindowVisible.restype = wintypes.BOOL
            u.GetCursorPos.argtypes = [ctypes.POINTER(POINT)]
            u.GetCursorPos.restype = wintypes.BOOL
            u.MonitorFromWindow.argtypes = [hwnd, wintypes.DWORD]
            u.MonitorFromWindow.restype = hmonitor
            u.MonitorFromPoint.argtypes = [POINT, wintypes.DWORD]
            u.MonitorFromPoint.restype = hmonitor
            u.GetMonitorInfoW.argtypes = [hmonitor, ctypes.POINTER(MONITORINFO)]
            u.GetMonitorInfoW.restype = wintypes.BOOL
            u.ShowWindow.argtypes = [hwnd, ctypes.c_int]
            u.ShowWindow.restype = wintypes.BOOL
            u.SetWindowPos.argtypes = [hwnd, hwnd, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
            u.SetWindowPos.restype = wintypes.BOOL
            u.BringWindowToTop.argtypes = [hwnd]
            u.BringWindowToTop.restype = wintypes.BOOL
            u.SetForegroundWindow.argtypes = [hwnd]
            u.SetForegroundWindow.restype = wintypes.BOOL
            if hasattr(u, "GetDpiForWindow"):
                u.GetDpiForWindow.argtypes = [hwnd]
                u.GetDpiForWindow.restype = wintypes.UINT
            for name in ("GetWindowLongPtrW", "SetWindowLongPtrW"):
                fn = getattr(u, name, None)
                if fn is None:
                    continue
                if name.startswith("Get"):
                    fn.argtypes = [hwnd, ctypes.c_int]
                    fn.restype = ctypes.c_ssize_t
                else:
                    fn.argtypes = [hwnd, ctypes.c_int, ctypes.c_ssize_t]
                    fn.restype = ctypes.c_ssize_t
        except Exception:
            # Quick keeps the pywebview fallback even on older Windows builds.
            pass

    @property
    def available(self) -> bool:
        return bool(self._user32)

    def _is_window(self, hwnd: int) -> bool:
        if not self.available or not hwnd:
            return False
        try:
            return bool(self._user32.IsWindow(hwnd))
        except Exception:
            return False

    def hwnd(self) -> int:
        if not self.available:
            return 0
        if self._is_window(self._hwnd):
            return self._hwnd
        try:
            self._hwnd = int(self._user32.FindWindowW(None, self.title) or 0)
        except Exception:
            self._hwnd = 0
        return self._hwnd

    def _dpi_for_monitor(self, monitor: int, hwnd: int = 0) -> int:
        try:
            shcore = ctypes.windll.shcore
            shcore.GetDpiForMonitor.argtypes = [
                wintypes.HANDLE,
                ctypes.c_int,
                ctypes.POINTER(wintypes.UINT),
                ctypes.POINTER(wintypes.UINT),
            ]
            shcore.GetDpiForMonitor.restype = ctypes.c_long
            x = wintypes.UINT(96)
            y = wintypes.UINT(96)
            if shcore.GetDpiForMonitor(monitor, 0, ctypes.byref(x), ctypes.byref(y)) == 0:
                return max(96, int(x.value))
        except Exception:
            pass
        try:
            if hwnd and hasattr(self._user32, "GetDpiForWindow"):
                value = int(self._user32.GetDpiForWindow(hwnd) or 0)
                if value:
                    return value
        except Exception:
            pass
        return 96

    def _monitor_info(self, monitor: int, hwnd: int = 0) -> MonitorWorkArea | None:
        if not monitor:
            return None
        info = MONITORINFO()
        info.cbSize = ctypes.sizeof(MONITORINFO)
        try:
            if not self._user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
                return None
            return MonitorWorkArea(
                int(info.rcWork.left),
                int(info.rcWork.top),
                int(info.rcWork.right),
                int(info.rcWork.bottom),
                self._dpi_for_monitor(monitor, hwnd),
            )
        except Exception:
            return None

    def active_monitor(self) -> MonitorWorkArea | None:
        if not self.available:
            return None
        hwnd_quick = self.hwnd()
        foreground = 0
        try:
            foreground = int(self._user32.GetForegroundWindow() or 0)
        except Exception:
            pass
        monitor = 0
        if foreground and foreground != hwnd_quick and self._is_window(foreground):
            try:
                monitor = int(self._user32.MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST) or 0)
            except Exception:
                monitor = 0
        if not monitor:
            point = POINT()
            try:
                if self._user32.GetCursorPos(ctypes.byref(point)):
                    monitor = int(self._user32.MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST) or 0)
            except Exception:
                monitor = 0
        if not monitor:
            try:
                monitor = int(self._user32.MonitorFromWindow(0, MONITOR_DEFAULTTOPRIMARY) or 0)
            except Exception:
                monitor = 0
        return self._monitor_info(monitor, hwnd_quick)

    def capture_previous_foreground(self) -> int:
        if not self.available:
            return 0
        try:
            current = int(self._user32.GetForegroundWindow() or 0)
            if current and current != self.hwnd() and self._is_window(current):
                self._previous_foreground = current
        except Exception:
            pass
        return self._previous_foreground

    def prepare_show(self) -> None:
        """Capture context before pywebview has a chance to activate Quick."""
        if not self.available:
            return
        self.capture_previous_foreground()
        area = self.active_monitor()
        if area:
            self._monitor = area

    @staticmethod
    def _scaled(value: int, dpi: int) -> int:
        return max(1, int(round(value * max(96, dpi) / 96.0)))

    def _position(self, area: MonitorWorkArea, width_dip: int, height_dip: int) -> tuple[int, int, int, int]:
        width = min(area.width, self._scaled(width_dip, area.dpi))
        height = min(area.height, self._scaled(height_dip, area.dpi))
        margin_top = self._scaled(14, area.dpi)
        x = area.left + max(0, (area.width - width) // 2)
        y = min(area.bottom - height, area.top + margin_top)
        return x, max(area.top, y), width, height

    def _window_long_functions(self):
        get_style = getattr(self._user32, "GetWindowLongPtrW", None) or self._user32.GetWindowLongW
        set_style = getattr(self._user32, "SetWindowLongPtrW", None) or self._user32.SetWindowLongW
        return get_style, set_style

    def _apply_native_style(self, hwnd: int) -> None:
        """Enforce a borderless tool window without touching the Main window."""
        try:
            get_style, set_style = self._window_long_functions()
            ex_style = int(get_style(hwnd, GWL_EXSTYLE))
            ex_style = (ex_style | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW
            set_style(hwnd, GWL_EXSTYLE, ex_style)

            style = int(get_style(hwnd, GWL_STYLE))
            style &= ~(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU)
            set_style(hwnd, GWL_STYLE, style)
            self._user32.SetWindowPos(
                hwnd,
                0,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            )
        except Exception:
            pass
        try:
            preference = ctypes.c_int(DWMWCP_ROUND)
            dwmapi = ctypes.windll.dwmapi
            dwmapi.DwmSetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
            dwmapi.DwmSetWindowAttribute.restype = ctypes.c_long
            dwmapi.DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                ctypes.byref(preference),
                ctypes.sizeof(preference),
            )
        except Exception:
            pass

    def _move_to_previous_virtual_desktop(self, hwnd: int) -> bool:
        """Best effort: place our Quick on the desktop of the previously focused app.

        IVirtualDesktopManager is a public Windows COM API. Failure is harmless:
        Windows builds/policies that reject the call simply keep the current desktop.
        """
        reference = self._previous_foreground
        if not self.available or not reference or reference == hwnd or not self._is_window(reference):
            return False

        ole32 = None
        manager = ctypes.c_void_p()
        initialized_here = False
        try:
            ole32 = ctypes.windll.ole32
            ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, wintypes.DWORD]
            ole32.CoInitializeEx.restype = ctypes.c_long
            hr_init = int(ole32.CoInitializeEx(None, COINIT_APARTMENTTHREADED))
            initialized_here = hr_init in (0, 1)  # S_OK / S_FALSE

            ole32.CoCreateInstance.argtypes = [
                ctypes.POINTER(GUID),
                ctypes.c_void_p,
                wintypes.DWORD,
                ctypes.POINTER(GUID),
                ctypes.POINTER(ctypes.c_void_p),
            ]
            ole32.CoCreateInstance.restype = ctypes.c_long
            hr = int(
                ole32.CoCreateInstance(
                    ctypes.byref(CLSID_VIRTUAL_DESKTOP_MANAGER),
                    None,
                    CLSCTX_INPROC_SERVER,
                    ctypes.byref(IID_I_VIRTUAL_DESKTOP_MANAGER),
                    ctypes.byref(manager),
                )
            )
            if hr < 0 or not manager.value:
                return False

            vtable_ptr = ctypes.cast(manager, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
            winfunctype = getattr(ctypes, "WINFUNCTYPE", ctypes.CFUNCTYPE)
            release = winfunctype(wintypes.ULONG, ctypes.c_void_p)(vtable_ptr[2])
            get_desktop_id = winfunctype(ctypes.c_long, ctypes.c_void_p, wintypes.HWND, ctypes.POINTER(GUID))(vtable_ptr[4])
            move_to_desktop = winfunctype(ctypes.c_long, ctypes.c_void_p, wintypes.HWND, ctypes.POINTER(GUID))(vtable_ptr[5])

            desktop_id = GUID()
            if int(get_desktop_id(manager, reference, ctypes.byref(desktop_id))) < 0:
                return False
            return int(move_to_desktop(manager, hwnd, ctypes.byref(desktop_id))) >= 0
        except Exception:
            return False
        finally:
            if manager.value:
                try:
                    vtable_ptr = ctypes.cast(manager, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
                    winfunctype = getattr(ctypes, "WINFUNCTYPE", ctypes.CFUNCTYPE)
                    release = winfunctype(wintypes.ULONG, ctypes.c_void_p)(vtable_ptr[2])
                    release(manager)
                except Exception:
                    pass
            if initialized_here and ole32 is not None:
                try:
                    ole32.CoUninitialize()
                except Exception:
                    pass

    def _activate_foreground(self, hwnd: int) -> bool:
        """Foreground Quick after an explicit user hotkey without synthetic keys.

        AttachThreadInput is used only around the activation call. This avoids the
        old Alt-key/sleep hacks and lets the browser child receive DOM focus once
        the native top-level window becomes active.
        """
        if not self.available or not hwnd:
            return False

        attached: list[tuple[int, int]] = []
        try:
            current_tid = int(self._kernel32.GetCurrentThreadId() or 0)
            quick_tid = int(self._user32.GetWindowThreadProcessId(hwnd, None) or 0)
            foreground = int(self._user32.GetForegroundWindow() or 0)
            foreground_tid = int(self._user32.GetWindowThreadProcessId(foreground, None) or 0) if foreground else 0

            for other_tid in (foreground_tid, quick_tid):
                if current_tid and other_tid and current_tid != other_tid:
                    try:
                        if self._user32.AttachThreadInput(current_tid, other_tid, True):
                            attached.append((current_tid, other_tid))
                    except Exception:
                        pass

            self._user32.BringWindowToTop(hwnd)
            foreground_ok = bool(self._user32.SetForegroundWindow(hwnd))
            try:
                self._user32.SetFocus(hwnd)
            except Exception:
                pass
            return foreground_ok or int(self._user32.GetForegroundWindow() or 0) == hwnd
        except Exception:
            return False
        finally:
            for first, second in reversed(attached):
                try:
                    self._user32.AttachThreadInput(first, second, False)
                except Exception:
                    pass

    def prepare_hidden(self) -> bool:
        """Apply tool-window styling while hidden without activating or promoting it."""
        self._next_animation_generation()
        if not self.available:
            return False
        hwnd = self.hwnd()
        if not hwnd:
            return False
        try:
            self._apply_native_style(hwnd)
            self._user32.SetWindowPos(
                hwnd,
                HWND_NOTOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )
            return True
        except Exception:
            return False

    def _next_animation_generation(self) -> int:
        with self._animation_lock:
            self._animation_generation += 1
            return self._animation_generation

    def _animate_slide_async(
        self, hwnd: int, x: int, start_y: int, end_y: int, width: int, height: int, generation: int
    ) -> None:
        """Move the live HWND down without freezing WebView2 painting or input.

        AnimateWindow is intentionally avoided: with WebView2 child windows it can
        animate an unpainted parent surface, producing the black rectangle seen on
        Windows. This short worker only runs during the entrance animation.
        """
        if start_y == end_y:
            return
        duration = QUICK_ENTER_DURATION_MS / 1000.0
        steps = max(2, QUICK_ENTER_STEPS)
        frame = duration / steps
        for index in range(1, steps + 1):
            with self._animation_lock:
                if generation != self._animation_generation:
                    return
            if not self._is_window(hwnd):
                return
            # Ease-out cubic: quick initial movement, gentle stop at final position.
            t = index / steps
            eased = 1.0 - (1.0 - t) ** 3
            y = int(round(start_y + (end_y - start_y) * eased))
            try:
                self._user32.SetWindowPos(
                    hwnd, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE
                )
            except Exception:
                return
            if index < steps:
                time.sleep(frame)

    def show(self, width_dip: int, height_dip: int) -> bool:
        if not self.available:
            return False
        hwnd = self.hwnd()
        if not hwnd:
            return False
        try:
            area = self._monitor or self.active_monitor() or self._monitor_info(
                int(self._user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) or 0), hwnd
            )
            if not area:
                return False
            self._monitor = area
            x, y, width, height = self._position(area, width_dip, height_dip)
            self._apply_native_style(hwnd)
            self._move_to_previous_virtual_desktop(hwnd)

            # Reveal the already-loaded WebView normally, slightly above its final
            # position. Unlike AnimateWindow, this keeps the live WebView2 surface
            # painting throughout the movement.
            offset = self._scaled(QUICK_ENTER_OFFSET_DIP, area.dpi)
            start_y = max(area.top, y - offset)
            generation = self._next_animation_generation()
            self._user32.SetWindowPos(
                hwnd, HWND_TOPMOST, x, start_y, width, height, SWP_NOACTIVATE
            )
            self._user32.ShowWindow(hwnd, SW_SHOW)
            self._user32.SetWindowPos(
                hwnd, HWND_TOPMOST, x, start_y, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW
            )

            # Activation happens before animation starts. QuickManager can therefore
            # focus the HTML input immediately while this worker only changes Y.
            self._activate_foreground(hwnd)
            threading.Thread(
                target=self._animate_slide_async,
                args=(hwnd, x, start_y, y, width, height, generation),
                name="reposit-quick-slide",
                daemon=True,
            ).start()
            return bool(self._user32.IsWindowVisible(hwnd))
        except Exception:
            return False

    def hide(self) -> bool:
        self._next_animation_generation()
        if not self.available:
            return False
        hwnd = self.hwnd()
        if not hwnd:
            return False

        foreground = 0
        topmost_removed = False
        hidden = False
        try:
            foreground = int(self._user32.GetForegroundWindow() or 0)
        except Exception:
            pass
        try:
            topmost_removed = bool(
                self._user32.SetWindowPos(
                    hwnd,
                    HWND_NOTOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                )
            )
        except Exception:
            pass
        try:
            self._user32.ShowWindow(hwnd, SW_HIDE)
            hidden = not bool(self._user32.IsWindowVisible(hwnd))
        except Exception:
            pass

        previous = self._previous_foreground
        if foreground == hwnd and previous and previous != hwnd and self._is_window(previous):
            try:
                self._user32.SetForegroundWindow(previous)
            except Exception:
                pass
        self._monitor = None
        return hidden and topmost_removed

    def is_visible(self) -> bool:
        hwnd = self.hwnd()
        if not hwnd or not self.available:
            return False
        try:
            return bool(self._user32.IsWindowVisible(hwnd))
        except Exception:
            return False
