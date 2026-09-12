import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
TESTS = Path(__file__).resolve().parent
for path in (ROOT, TESTS):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))
