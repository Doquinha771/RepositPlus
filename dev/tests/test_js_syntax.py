from pathlib import Path
import shutil
import subprocess
import pytest

ROOT = Path(__file__).resolve().parents[2]


def test_app_js_has_valid_syntax():
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js não está disponível neste ambiente de teste.")
    result = subprocess.run(
        [node, "--check", str(ROOT / "reposit" / "frontend" / "js" / "app.js")],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr

    quick = subprocess.run(
        [node, "--check", str(ROOT / "reposit" / "frontend" / "quick" / "quick.js")],
        capture_output=True,
        text=True,
    )
    assert quick.returncode == 0, quick.stderr
