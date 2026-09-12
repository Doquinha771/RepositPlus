from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

# dev/build/RepositPlus.spec -> repository root
root = Path(SPEC).resolve().parents[2]
icon = root / "dev" / "build" / "assets" / "RepositPlus.ico"
version_info = root / "dev" / ".build" / "version_info.txt"

webview_datas = collect_data_files("webview", subdir="lib") + collect_data_files("webview", subdir="js")
webview_binaries = collect_dynamic_libs("webview")

analysis = Analysis(
    [str(root / "reposit" / "main.py")],
    pathex=[str(root)],
    binaries=webview_binaries,
    datas=[(str(root / "reposit" / "frontend"), "frontend")] + webview_datas,
    hiddenimports=[
        "uvicorn.logging",
        "uvicorn.loops.asyncio",
        "uvicorn.protocols.http.h11_impl",
        # pywebview chooses the Windows backend dynamically, which is easy for
        # a freezer to miss even though source mode works perfectly.
        "clr",
        "pythonnet",
        "clr_loader",
        "webview.platforms.win32",
        "webview.platforms.winforms",
        "webview.platforms.edgechromium",
        "webview.platforms.mshtml",
    ],
    excludes=[
        "tkinter", "matplotlib", "numpy", "pandas", "scipy", "IPython", "jupyter",
        "pytest", "test", "unittest", "PyQt5", "PyQt6", "PySide2", "PySide6",
        "PIL", "pystray", "websockets", "uvloop", "httptools",
    ],
    optimize=2,
    noarchive=False,
)
pyz = PYZ(analysis.pure)

# ONEFILE on purpose: the portable release is one actual .exe, not a ZIP full
# of Python DLLs. The Setup installs this same self-contained binary.
exe = EXE(
    pyz,
    analysis.scripts,
    analysis.binaries,
    analysis.datas,
    [],
    name="RepositPlus",
    console=False,
    icon=str(icon),
    version=str(version_info),
    upx=True,
    strip=False,
    disable_windowed_traceback=False,
)
