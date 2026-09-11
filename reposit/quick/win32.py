from __future__ import annotations

import ctypes
import os
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
HWND_TOPMOST = ctypes.c_void_p(-1)
HWND_NOTOPMOST = ctypes.c_void_p(-2)
GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_APPWINDOW = 0x00040000
DWMWA_WINDOW_CORNER_PREFERENCE = 33
DWMWCP_ROUND = 2


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
            get_long = getattr(u, "GetWindowLongPtrW", None)
            set_long = getattr(u, "SetWindowLongPtrW", None)
            if get_long is not None:
                get_long.argtypes = [hwnd, ctypes.c_int]
                get_long.restype = ctypes.c_ssize_t
            if set_long is not None:
                set_long.argtypes = [hwnd, ctypes.c_int, ctypes.c_ssize_t]
                set_long.restype = ctypes.c_ssize_t
        except Exception:
            # The Quick must retain the pywebview fallback even if one declaration
            # is unavailable on an older Windows build.
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
        # Prefer the target monitor's DPI. GetDpiForWindow can still reflect the
        # monitor where the Quick was previously shown, which is wrong when the
        # hotkey is invoked from a different monitor.
        try:
            shcore = ctypes.windll.shcore
            shcore.GetDpiForMonitor.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.POINTER(wintypes.UINT), ctypes.POINTER(wintypes.UINT)]
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
        """Capture foreground and monitor before pywebview has a chance to activate Quick."""
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

    def _apply_native_style(self, hwnd: int) -> None:
        try:
            get_style = getattr(self._user32, "GetWindowLongPtrW", None) or self._user32.GetWindowLongW
            set_style = getattr(self._user32, "SetWindowLongPtrW", None) or self._user32.SetWindowLongW
            style = int(get_style(hwnd, GWL_EXSTYLE))
            style = (style | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW
            set_style(hwnd, GWL_EXSTYLE, style)
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

    def prepare_hidden(self) -> bool:
        """Apply tool-window styling while hidden without activating or promoting it."""
        if not self.available:
            return False
        hwnd = self.hwnd()
        if not hwnd:
            return False
        try:
            self._apply_native_style(hwnd)
            self._user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
            return True
        except Exception:
            return False

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
            self._user32.ShowWindow(hwnd, SW_SHOW)
            self._user32.SetWindowPos(hwnd, HWND_TOPMOST, x, y, width, height, SWP_SHOWWINDOW)
            self._user32.BringWindowToTop(hwnd)
            self._user32.SetForegroundWindow(hwnd)
            return True
        except Exception:
            return False

    def resize(self, width_dip: int, height_dip: int) -> bool:
        if not self.available:
            return False
        hwnd = self.hwnd()
        if not hwnd:
            return False
        try:
            area = self._monitor or self.active_monitor()
            if not area:
                return False
            x, y, width, height = self._position(area, width_dip, height_dip)
            if self._user32.IsWindowVisible(hwnd):
                self._user32.SetWindowPos(hwnd, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE)
            else:
                self._user32.SetWindowPos(hwnd, 0, x, y, width, height, SWP_NOACTIVATE | SWP_NOZORDER)
            return True
        except Exception:
            return False

    def hide(self) -> bool:
        if not self.available:
            return False
        hwnd = self.hwnd()
        if not hwnd:
            return False
        try:
            foreground = int(self._user32.GetForegroundWindow() or 0)
            self._user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
            self._user32.ShowWindow(hwnd, SW_HIDE)
            previous = self._previous_foreground
            # Only return focus when the Quick itself still owned it. If the user
            # already switched to another app, leave Windows alone.
            if foreground == hwnd and previous and previous != hwnd and self._is_window(previous):
                self._user32.SetForegroundWindow(previous)
            self._monitor = None
            return True
        except Exception:
            return False

    def is_visible(self) -> bool:
        hwnd = self.hwnd()
        if not hwnd or not self.available:
            return False
        try:
            return bool(self._user32.IsWindowVisible(hwnd))
        except Exception:
            return False
