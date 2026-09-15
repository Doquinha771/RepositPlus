from __future__ import annotations

import os
from pathlib import Path
from typing import IO


class InstanceLock:
    """Cross-platform non-blocking lock protecting one writable data root."""
    def __init__(self, path: Path):
        self.path = Path(path)
        self._file: IO[str] | None = None

    def acquire(self) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fh = self.path.open("a+", encoding="utf-8")
        try:
            if os.name == "nt":
                import msvcrt
                fh.seek(0)
                if fh.tell() == 0:
                    fh.write("0")
                    fh.flush()
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            fh.seek(0)
            fh.truncate()
            fh.write(str(os.getpid()))
            fh.flush()
            self._file = fh
            return True
        except (OSError, BlockingIOError):
            fh.close()
            return False

    def release(self) -> None:
        fh, self._file = self._file, None
        if not fh:
            return
        try:
            if os.name == "nt":
                import msvcrt
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        finally:
            fh.close()
