from __future__ import annotations

import json
import logging
from logging.handlers import RotatingFileHandler
import os
import socket
import sys
import tempfile
import shutil
import threading
import traceback
import time
from pathlib import Path
from typing import Any

import uvicorn
import webview

from reposit.backend.api import AppState, create_app
from reposit.backend.backups import export_reposit, import_reposit
from reposit.backend.config import APP_NAME, APP_VERSION, AppPaths, load_identity, load_settings, save_settings
from reposit.backend.database import Database
from reposit.backend.note_export import EXPORT_FORMATS, safe_filename, write_note_export
from reposit.quick import QuickHotkey, QuickManager, QuickStateStore
from reposit.quick.win32 import enable_per_monitor_v2

def _local_appdata_root() -> Path:
    """Return the writable Reposit+ root used by every Windows distribution.

    Setup and Portable intentionally share the same user-data location. The
    executable itself may live anywhere, but databases, attachments, logs and
    WebView2 storage never depend on that folder being writable.
    """
    override = os.environ.get("REPOSITPLUS_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    base = os.environ.get("LOCALAPPDATA")
    if base:
        return (Path(base) / "RepositPlus").resolve()
    # Non-Windows/source fallback. On Windows LOCALAPPDATA is always expected.
    return (Path.home() / "AppData" / "Local" / "RepositPlus").resolve()


def _runtime_paths() -> tuple[Path, Path, bool]:
    """Return (resource_root, data_root, portable_mode).

    All writable runtime state lives under ``%LOCALAPPDATA%\\RepositPlus``.
    Portable therefore remains a single EXE and no longer creates a
    ``RepositPlusData`` folder next to itself.
    """
    data_root = _local_appdata_root()
    if getattr(sys, "frozen", False):
        app_dir = Path(sys.executable).resolve().parent
        resource_root = Path(getattr(sys, "_MEIPASS", app_dir)).resolve()

        if "--self-test" in sys.argv:
            test_root = Path(tempfile.gettempdir()) / "RepositPlusSelfTest" / str(os.getpid())
            return resource_root, test_root, True

        installed = (app_dir / "installed.flag").is_file()
        return resource_root, data_root, not installed

    source_root = Path(__file__).resolve().parent
    # Development also stays out of the repository tree.
    return source_root, data_root / "Dev", False


def _migrate_legacy_portable_data(paths: AppPaths) -> None:
    """Best-effort migration from Rev5's sidecar RepositPlusData folder."""
    if not getattr(sys, "frozen", False):
        return
    try:
        legacy = Path(sys.executable).resolve().parent / "RepositPlusData"
        if not legacy.is_dir():
            return
        has_current_data = paths.db.exists() or paths.settings.exists() or any(paths.attachments.iterdir())
        if has_current_data:
            return
        shutil.copytree(legacy, paths.root, dirs_exist_ok=True)
    except Exception:
        # Migration must never prevent the app from opening.
        pass


RESOURCE_ROOT, DATA_ROOT, PORTABLE_MODE = _runtime_paths()
PATHS = AppPaths.from_roots(RESOURCE_ROOT, DATA_ROOT)
_migrate_legacy_portable_data(PATHS)


def configure_logging() -> None:
    """Keep source builds verbose, but avoid constant disk/console churn in packaged student builds."""
    PATHS.logs.mkdir(parents=True, exist_ok=True)
    packaged = bool(getattr(sys, "frozen", False))
    handlers: list[logging.Handler] = [RotatingFileHandler(PATHS.logs / "reposit.log", maxBytes=1_048_576, backupCount=2, encoding="utf-8")]
    if not packaged:
        handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(
        level=logging.WARNING if packaged else logging.INFO,
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        handlers=handlers,
    )


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def enable_windows_energy_saver(enabled: bool = False) -> None:
    """Best-effort: use lower-power scheduling only while Windows reports battery use."""
    if os.name != "nt" or not enabled:
        return
    try:
        import ctypes
        from ctypes import wintypes

        class SYSTEM_POWER_STATUS(ctypes.Structure):
            _fields_ = [("ACLineStatus", wintypes.BYTE), ("BatteryFlag", wintypes.BYTE), ("BatteryLifePercent", wintypes.BYTE), ("SystemStatusFlag", wintypes.BYTE), ("BatteryLifeTime", wintypes.DWORD), ("BatteryFullLifeTime", wintypes.DWORD)]

        power = SYSTEM_POWER_STATUS()
        if not ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(power)) or power.ACLineStatus != 0:
            return

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetCurrentProcess()
        kernel32.SetPriorityClass(handle, 0x00004000)  # BELOW_NORMAL_PRIORITY_CLASS

        class PROCESS_POWER_THROTTLING_STATE(ctypes.Structure):
            _fields_ = [("Version", wintypes.DWORD), ("ControlMask", wintypes.DWORD), ("StateMask", wintypes.DWORD)]

        qos = PROCESS_POWER_THROTTLING_STATE(1, 0x1, 0x1)
        kernel32.SetProcessInformation(handle, 4, ctypes.byref(qos), ctypes.sizeof(qos))
    except Exception:
        pass


class NativeBridge:
    def __init__(self, paths: AppPaths, db: Database):
        self.paths = paths
        self.db = db
        self.main_window: Any = None
        self._main_maximized = False
        self._main_restore_rect: tuple[int, int, int, int] | None = None

    @staticmethod
    def _dialog_type(kind: str):
        enum = getattr(webview, "FileDialog", None)
        if enum is not None:
            names = ("SAVE",) if kind == "save" else ("OPEN", "LOAD")
            for name in names:
                if hasattr(enum, name):
                    return getattr(enum, name)
        legacy = "SAVE_DIALOG" if kind == "save" else "OPEN_DIALOG"
        return getattr(webview, legacy)

    def open_file(self, filepath: str) -> dict[str, Any]:
        try:
            path = Path(filepath).resolve()
            allowed = self.paths.attachments.resolve()
            if allowed not in path.parents or not path.is_file():
                return {"ok": False, "error": "Arquivo fora da área controlada do Reposit+."}
            if os.name == "nt":
                os.startfile(path)  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                os.system(f'open "{path}"')
            else:
                os.system(f'xdg-open "{path}"')
            return {"ok": True}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}


    def open_data_folder(self) -> dict[str, Any]:
        try:
            path = self.paths.root.resolve()
            path.mkdir(parents=True, exist_ok=True)
            if os.name == "nt":
                os.startfile(path)  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                os.system(f'open "{path}"')
            else:
                os.system(f'xdg-open "{path}"')
            return {"ok": True, "path": str(path)}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def export_backup(self) -> dict[str, Any]:
        try:
            if not self.main_window:
                return {"ok": False, "error": "Janela indisponível."}
            result = self.main_window.create_file_dialog(
                self._dialog_type("save"),
                save_filename="RepositPlus.reposit",
                file_types=("Backup Reposit+ (*.reposit)",),
            )
            if not result:
                return {"ok": False, "cancelled": True}
            chosen = result[0] if isinstance(result, (list, tuple)) else result
            target = Path(chosen)
            self.db.checkpoint()
            exported = export_reposit(self.paths, target, include_attachments=True)
            return {"ok": True, "path": str(exported)}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def import_backup(self) -> dict[str, Any]:
        try:
            if not self.main_window:
                return {"ok": False, "error": "Janela indisponível."}
            result = self.main_window.create_file_dialog(
                self._dialog_type("open"),
                allow_multiple=False,
                file_types=("Backup Reposit+ (*.reposit)",),
            )
            if not result:
                return {"ok": False, "cancelled": True}
            source = Path(result[0] if isinstance(result, (list, tuple)) else result)
            manifest = import_reposit(self.paths, source)
            self.db.migrate()
            return {"ok": True, "manifest": manifest}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def show_main(self) -> None:
        if self.main_window:
            self.main_window.show()

    def open_note(self, note_id: int) -> None:
        """Open a note in Main only after the user explicitly asks from Quick."""
        if self.main_window:
            self.main_window.show()
            self.main_window.evaluate_js(f"window.RepositUI && window.RepositUI.openNote({int(note_id)})")

    def export_note(self, note_id: int, fmt: str = "pdf") -> dict[str, Any]:
        try:
            fmt = str(fmt or "pdf").lower().lstrip(".")
            if fmt not in EXPORT_FORMATS:
                return {"ok": False, "error": "Formato de exportação não suportado."}
            note = self.db.fetchone("SELECT * FROM notes WHERE id=?", (int(note_id),))
            if not note:
                return {"ok": False, "error": "Anotação não encontrada."}
            note = dict(note)
            note["files"] = self.db.fetchall("SELECT id,filename,file_type,size,created_at FROM note_files WHERE note_id=? ORDER BY id", (int(note_id),))
            label, suffix = EXPORT_FORMATS[fmt]
            filename = safe_filename(str(note.get("title") or "Anotacao")) + suffix
            result = self.main_window.create_file_dialog(
                self._dialog_type("save"),
                save_filename=filename,
                file_types=(f"{label} (*{suffix})", "Todos os arquivos (*.*)"),
            )
            if not result:
                return {"ok": False, "cancelled": True}
            chosen = result[0] if isinstance(result, (list, tuple)) else result
            written = write_note_export(note, Path(chosen), fmt)
            return {"ok": True, "path": str(written), "format": fmt}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def close_main(self) -> None:
        if self.main_window:
            self.main_window.destroy()

    def exposed_functions(self) -> tuple[Any, ...]:
        """Return only the native functions that JavaScript is allowed to call.

        Passing the whole bridge through ``js_api`` makes pywebview recursively
        inspect public attributes. In pywebview 6.0 that can descend into
        ``Database.path``/``pathlib.WindowsPath`` and fail while inspecting
        private attributes such as ``_hash``. A strict function whitelist also
        prevents internal services, paths and window objects from being exposed
        accidentally.
        """
        return (
            self.open_file,
            self.open_data_folder,
            self.export_backup,
            self.import_backup,
            self.show_main,
            self.open_note,
            self.export_note,
        )


class WindowsMemoryGovernor:
    """Low-frequency soft memory governor for Python + WebView2 descendants.

    It never imposes a hard allocation cap (which can crash Chromium). Instead it
    asks Windows to trim working sets only when the process tree grows above a
    conservative budget. The loop sleeps on an Event, so idle CPU cost is effectively zero.
    """
    def __init__(self, soft_limit_mb: int = 192):
        self.soft_limit_mb = max(160, min(int(soft_limit_mb), 384))
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_trim = 0.0
        self._trim_cooldown = 120.0

    def start(self) -> None:
        if os.name != "nt" or self._thread:
            return
        self._thread = threading.Thread(target=self._loop, name="reposit-memory-governor", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        # A minute between probes keeps idle CPU effectively at zero. Forced
        # trims (for example after Quick closes) bypass this interval.
        while not self._stop.wait(60.0):
            try:
                self.trim_if_needed()
            except Exception:
                pass

    @staticmethod
    def _process_tree() -> list[int]:
        import ctypes
        from ctypes import wintypes
        TH32CS_SNAPPROCESS = 0x00000002
        INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
        class PROCESSENTRY32W(ctypes.Structure):
            _fields_ = [("dwSize", wintypes.DWORD),("cntUsage", wintypes.DWORD),("th32ProcessID", wintypes.DWORD),("th32DefaultHeapID", ctypes.c_void_p),("th32ModuleID", wintypes.DWORD),("cntThreads", wintypes.DWORD),("th32ParentProcessID", wintypes.DWORD),("pcPriClassBase", wintypes.LONG),("dwFlags", wintypes.DWORD),("szExeFile", wintypes.WCHAR * 260)]
        k32=ctypes.windll.kernel32
        snap=k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0)
        if snap==INVALID_HANDLE_VALUE:return [os.getpid()]
        parent: dict[int,list[int]]={}
        try:
            entry=PROCESSENTRY32W();entry.dwSize=ctypes.sizeof(entry)
            ok=k32.Process32FirstW(snap,ctypes.byref(entry))
            while ok:
                parent.setdefault(int(entry.th32ParentProcessID),[]).append(int(entry.th32ProcessID))
                ok=k32.Process32NextW(snap,ctypes.byref(entry))
        finally:k32.CloseHandle(snap)
        out=[];stack=[os.getpid()]
        while stack:
            pid=stack.pop()
            if pid in out:continue
            out.append(pid);stack.extend(parent.get(pid,()))
        return out

    @staticmethod
    def _working_set(pid: int) -> int:
        import ctypes
        from ctypes import wintypes
        PROCESS_QUERY_INFORMATION=0x0400;PROCESS_SET_QUOTA=0x0100
        class PMC(ctypes.Structure):
            _fields_=[("cb",wintypes.DWORD),("PageFaultCount",wintypes.DWORD),("PeakWorkingSetSize",ctypes.c_size_t),("WorkingSetSize",ctypes.c_size_t),("QuotaPeakPagedPoolUsage",ctypes.c_size_t),("QuotaPagedPoolUsage",ctypes.c_size_t),("QuotaPeakNonPagedPoolUsage",ctypes.c_size_t),("QuotaNonPagedPoolUsage",ctypes.c_size_t),("PagefileUsage",ctypes.c_size_t),("PeakPagefileUsage",ctypes.c_size_t)]
        k32=ctypes.windll.kernel32;psapi=ctypes.windll.psapi
        h=k32.OpenProcess(PROCESS_QUERY_INFORMATION|PROCESS_SET_QUOTA,False,pid)
        if not h:return 0
        try:
            pm=PMC();pm.cb=ctypes.sizeof(pm)
            return int(pm.WorkingSetSize) if psapi.GetProcessMemoryInfo(h,ctypes.byref(pm),pm.cb) else 0
        finally:k32.CloseHandle(h)

    @staticmethod
    def _trim(pid: int) -> None:
        import ctypes
        PROCESS_QUERY_INFORMATION=0x0400;PROCESS_SET_QUOTA=0x0100
        k32=ctypes.windll.kernel32;psapi=ctypes.windll.psapi
        h=k32.OpenProcess(PROCESS_QUERY_INFORMATION|PROCESS_SET_QUOTA,False,pid)
        if h:
            try:psapi.EmptyWorkingSet(h)
            finally:k32.CloseHandle(h)

    def trim_if_needed(self, force: bool = False) -> int:
        import gc
        pids=self._process_tree();total=sum(self._working_set(pid) for pid in pids)
        limit=self.soft_limit_mb*1024*1024
        now = time.monotonic()
        should_trim = force or (total > limit and now - self._last_trim >= self._trim_cooldown)
        if should_trim:
            gc.collect()
            for pid in reversed(pids):
                self._trim(pid)
            self._last_trim = now
        return total


class DesktopRuntime:
    def __init__(self) -> None:
        configure_logging()
        self.log = logging.getLogger("reposit.runtime")
        self.identity = load_identity(PATHS)
        self.settings = load_settings(PATHS)
        if self.settings.get("device_name"):
            self.identity["device_name"] = self.settings["device_name"]
        self.db = Database(PATHS.db)
        self._run_startup_maintenance()
        self.port = free_port()
        self.state = AppState(PATHS, self.db, self.settings, self.identity, self.port, "portable" if PORTABLE_MODE else ("installed" if getattr(sys, "frozen", False) else "source"))
        self.app = create_app(self.state)
        self.server: uvicorn.Server | None = None
        self.bridge = NativeBridge(PATHS, self.db)
        self.quick = QuickManager(QuickStateStore(PATHS.data / "quick-state.json"))
        self.main_window = None
        self.quick_window = None
        self.force_exit = False
        self._cleaned = False
        self._cleanup_lock = threading.Lock()
        self.quick_hotkey = QuickHotkey(self.toggle_quick, self.log)
        self._webview_stopped = threading.Event()
        self.base_url = ""
        self.memory_governor = WindowsMemoryGovernor(
            int(self.settings.get("memory_soft_limit_mb") or 192)
        )


    def _run_startup_maintenance(self) -> None:
        """Perform bounded housekeeping at startup, never on an idle timer."""
        now = time.time()
        last = float(self.settings.get("last_db_maintenance") or 0)
        if now - last >= 7 * 24 * 60 * 60:
            try:
                self.db.maintenance(force=False)
                self.settings["last_db_maintenance"] = int(now)
                save_settings(PATHS, self.settings)
            except Exception:
                logging.getLogger("reposit.runtime").warning("Falha na manutenção periódica do banco.", exc_info=True)

    def start_server(self) -> None:
        config = uvicorn.Config(
            self.app,
            host="127.0.0.1",
            port=self.port,
            log_level="warning",
            access_log=False,
            loop="asyncio",
            http="h11",
            ws="none",
            lifespan="off",
            timeout_keep_alive=2,
            backlog=32,
        )
        self.server = uvicorn.Server(config)
        thread = threading.Thread(target=self.server.run, name="reposit-fastapi", daemon=True)
        thread.start()
        for _ in range(60):
            if self.server.started:
                return
            time.sleep(0.05)
        raise RuntimeError("API local não iniciou.")

    def register_hotkey(self) -> None:
        """Register the real global Left Ctrl + Left Alt Quick toggle.

        QuickHotkey deliberately checks the physical sided modifiers with
        keyboard.is_pressed instead of trusting event.name. Windows can report
        the same keys as ctrl/alt/left menu depending on layout/backend.
        """
        if self.quick_hotkey.start():
            self.log.info("Atalho global registrado: left ctrl + left alt")

    def toggle_quick(self) -> None:
        try:
            self.quick.toggle()
        except Exception as exc:
            self.log.warning("Falha ao alternar Reposit+ Quick: %s", exc)

    def on_main_loaded(self):
        self.log.info("Interface HTML carregada pelo pywebview")

    def shutdown_runtime(self) -> None:
        """Stop every background component exactly once.

        The Quick window is a second WebView. If it remains hidden while the main
        window closes, the GUI loop can stay alive and leave python.exe behind.
        Closing now means closing the whole application, not becoming a tray ghost.
        """
        with self._cleanup_lock:
            if self._cleaned:
                return
            self._cleaned = True
        self.force_exit = True
        self.memory_governor.stop()
        if self.server:
            try:
                self.server.should_exit = True
                self.server.force_exit = True
            except Exception:
                pass
        try:
            self.quick_hotkey.stop()
        except Exception:
            pass
        try:
            self.db.checkpoint()
        except Exception:
            pass

    def on_closing(self):
        self.force_exit = True
        # pywebview only terminates after all windows are gone. The hidden Quick
        # window counts, because apparently invisible windows still have opinions.
        try:
            if self.quick_window:
                self.quick_window.destroy()
        except Exception:
            pass
        self.shutdown_runtime()

        def force_exit_if_webview_hangs():
            if not self._webview_stopped.wait(2.5):
                os._exit(0)

        threading.Thread(target=force_exit_if_webview_hangs, name="reposit-exit-watchdog", daemon=True).start()
        return True

    def run(self) -> None:
        enable_per_monitor_v2()
        enable_windows_energy_saver(bool(self.settings.get("battery_saver")))
        self.log.info("Iniciando %s %s (%s)", APP_NAME, APP_VERSION, "portable" if PORTABLE_MODE else "installed/source")
        if os.name == "nt":
            args = [
                "--disable-background-networking", "--disable-component-update", "--disable-sync",
                "--disable-extensions", "--disable-default-apps",
                "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,BackForwardCache",
            ]
            # Keep GPU acceleration for responsive editing, but cap renderer count
            # and cache sizes so long sessions do not grow without bound.
            args += ["--renderer-process-limit=2", "--disk-cache-size=8388608", "--media-cache-size=4194304"]
            os.environ.setdefault("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", " ".join(args))
        self.memory_governor.start()
        self.start_server()
        self.base_url = f"http://127.0.0.1:{self.port}"
        self.main_window = webview.create_window(
            APP_NAME,
            self.base_url,
            width=1380,
            height=860,
            min_size=(1050, 650),
            background_color="#303236",
            confirm_close=False,
            frameless=False,
            easy_drag=True,
            shadow=True,
        )
        self.bridge.main_window = self.main_window

        # Expose only callable bridge methods instead of the entire bridge object.
        # This avoids pywebview recursively serializing Database/AppPaths/Window
        # instances and keeps the JavaScript boundary intentionally small.
        exposed = self.bridge.exposed_functions()
        self.main_window.expose(*exposed)

        # Quick is created once and kept hidden. Toggling never recreates its HWND,
        # WebView2 renderer, listeners or JS state. It is fully independent from Main.
        self.quick_window = webview.create_window(
            self.quick.title,
            f"{self.base_url}/quick",
            width=self.quick.WINDOW_SIZE[0],
            height=self.quick.WINDOW_SIZE[1],
            min_size=self.quick.WINDOW_SIZE,
            frameless=True,
            on_top=False,
            hidden=True,
            resizable=False,
            easy_drag=False,
            shadow=True,
            transparent=False,
            background_color="#111312",
        )
        self.quick.bind_window(self.quick_window)
        self.quick.bind_open_note(self.bridge.open_note)
        self.quick_window.expose(*self.quick.exposed_functions())
        self.quick_window.events.loaded += self.quick.mark_ready
        self.main_window.events.closing += self.on_closing
        self.main_window.events.loaded += self.on_main_loaded
        self.register_hotkey()
        # WebView2 needs a writable storage folder. Keeping it in AppData fixes
        # silent startup failures when a Portable EXE is launched from a
        # read-only/protected directory. The Windows executable already carries
        # its .ico resource, so do not pass a PNG to webview.start (Windows only
        # accepts .ico there).
        webview_storage = PATHS.cache / "webview2"
        webview_storage.mkdir(parents=True, exist_ok=True)
        start_kwargs: dict[str, Any] = {
            "debug": False,
            "private_mode": True,
            "storage_path": str(webview_storage),
        }
        if os.name != "nt":
            icon_path = RESOURCE_ROOT / "frontend" / "assets" / "RepositPlus.png"
            if icon_path.exists():
                start_kwargs["icon"] = str(icon_path)
        try:
            webview.start(**start_kwargs)
        finally:
            self.shutdown_runtime()
            self._webview_stopped.set()
            self.log.info("Reposit+ encerrado")


def run_self_test() -> int:
    """Tiny packaged-runtime smoke test used by the developer build pipeline."""
    try:
        required = [
            PATHS.frontend / "index.html",
            PATHS.frontend / "css" / "main.css",
            PATHS.frontend / "js" / "app.js",
            PATHS.frontend / "quick" / "index.html",
            PATHS.frontend / "quick" / "quick.css",
            PATHS.frontend / "quick" / "quick.js",
        ]
        if not all(path.is_file() for path in required):
            return 2
        db = Database(PATHS.db)
        db.checkpoint()
        if os.name == "nt":
            # Catch the most common "Portable does nothing" packaging failure:
            # pythonnet/WebView2 bridge omitted by the freezer. No GUI is opened.
            import clr  # type: ignore[import-not-found]  # noqa: F401
            import webview.platforms.win32  # noqa: F401
            import webview.platforms.winforms  # noqa: F401
            import webview.platforms.edgechromium  # noqa: F401
        return 0
    except Exception:
        return 3
    finally:
        if "--self-test" in sys.argv:
            try:
                shutil.rmtree(PATHS.root, ignore_errors=True)
            except Exception:
                pass


def _write_boot_error(exc: BaseException) -> Path:
    """Persist startup failures even in console-less packaged builds."""
    try:
        log_dir = _local_appdata_root() / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        target = log_dir / "boot-error.log"
        target.write_text(
            f"Reposit+ {APP_VERSION} startup failure\n\n"
            + "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
            encoding="utf-8",
        )
        return target
    except Exception:
        return Path(tempfile.gettempdir()) / "RepositPlus-boot-error.log"


def _show_boot_error(exc: BaseException) -> None:
    path = _write_boot_error(exc)
    message = (
        "O Reposit+ não conseguiu iniciar.\n\n"
        f"Erro: {exc}\n\n"
        f"O diagnóstico foi salvo em:\n{path}"
    )
    if os.name == "nt":
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, message, "Reposit+ - erro ao iniciar", 0x10)
            return
        except Exception:
            pass
    try:
        print(message, file=sys.stderr)
    except Exception:
        pass


def main() -> int:
    try:
        if "--self-test" in sys.argv:
            return run_self_test()
        DesktopRuntime().run()
        return 0
    except BaseException as exc:
        # SystemExit from a successful explicit exit should remain successful.
        if isinstance(exc, SystemExit) and (exc.code in (0, None)):
            return 0
        _show_boot_error(exc)
        return int(exc.code) if isinstance(exc, SystemExit) and isinstance(exc.code, int) else 1


if __name__ == "__main__":
    raise SystemExit(main())
