from pathlib import Path

from reposit.backend.config import APP_VERSION, AppPaths


def test_single_source_of_truth_for_version():
    root = Path(__file__).resolve().parents[2]
    ps1 = (root / "dev" / "build" / "build_windows.ps1").read_text(encoding="utf-8")
    assert "reposit\\backend\\config.py" in ps1
    assert "Read-Version" in ps1
    assert APP_VERSION == "0.7.1"


def test_resource_and_user_roots_can_be_separated(tmp_path):
    resources = tmp_path / "resources"
    writable = tmp_path / "writable"
    (resources / "frontend").mkdir(parents=True)
    paths = AppPaths.from_roots(resources, writable)
    assert paths.frontend == (resources / "frontend").resolve()
    assert paths.db == (writable / "data" / "REPOSITINFOS.db").resolve()
    assert paths.attachments == (writable / "attachments").resolve()
    assert paths.logs == (writable / "logs").resolve()


def test_rev5_distribution_is_single_exe_and_dev_only_build_tools():
    root = Path(__file__).resolve().parents[2]
    runtime = (root / "dev" / "requirements-runtime.txt").read_text(encoding="utf-8")
    build = (root / "dev" / "requirements-build.txt").read_text(encoding="utf-8")
    ps1 = (root / "dev" / "build" / "build_windows.ps1").read_text(encoding="utf-8")
    spec = (root / "dev" / "build" / "RepositPlus.spec").read_text(encoding="utf-8")
    iss = (root / "dev" / "build" / "installer" / "RepositPlus.iss").read_text(encoding="utf-8")
    assert "pystray" not in runtime and "Pillow" not in runtime
    assert "pytest" in build and "pyinstaller" in build.lower()
    assert "ONEFILE" in spec and "COLLECT(" not in spec
    assert "analysis.binaries" in spec and "analysis.datas" in spec
    assert "Compress-Archive" not in ps1 and "Portable.zip" not in ps1
    assert "-Portable.exe" in ps1
    assert "installed.flag" in iss
    assert "python" not in iss.lower()
    assert not (root / "BUILD_PORTABLE.bat").exists()
    assert not (root / "BUILD_SETUP.bat").exists()
    assert not (root / "run.bat").exists()


def test_portable_and_setup_write_runtime_data_to_localappdata():
    root = Path(__file__).resolve().parents[2]
    main = (root / "reposit" / "main.py").read_text(encoding="utf-8")
    iss = (root / "dev" / "build" / "installer" / "RepositPlus.iss").read_text(encoding="utf-8")
    spec = (root / "dev" / "build" / "RepositPlus.spec").read_text(encoding="utf-8")
    assert 'LOCALAPPDATA' in main
    assert 'storage_path' in main and 'webview2' in main
    assert 'app_dir / "RepositPlusData"' not in main
    assert r'DefaultDirName={localappdata}\RepositPlus\App' in iss
    assert 'webview.platforms.winforms' in spec
    assert 'webview.platforms.edgechromium' in spec
    assert '"clr"' in spec


def test_windows_start_does_not_pass_png_icon_to_pywebview():
    root = Path(__file__).resolve().parents[2]
    main = (root / "reposit" / "main.py").read_text(encoding="utf-8")
    assert 'if os.name != "nt"' in main
    assert 'start_kwargs["icon"]' in main
    assert 'webview.start(debug=False, icon=' not in main


def test_inno_license_is_packaged_next_to_installer_script():
    root = Path(__file__).resolve().parents[2]
    installer = root / "dev" / "build" / "installer"
    iss = (installer / "RepositPlus.iss").read_text(encoding="utf-8")
    assert "LicenseFile=LICENSE.txt" in iss
    assert (installer / "LICENSE.txt").is_file()
    assert "MIT License" in (installer / "LICENSE.txt").read_text(encoding="utf-8")
