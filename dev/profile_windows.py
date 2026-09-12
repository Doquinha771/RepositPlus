"""Perfil simples do Reposit+ no Windows, incluindo subprocessos WebView2.

Uso:
  py -3.12 -m pip install -r dev/requirements-profile.txt
  py -3.12 dev/profile_windows.py --exe dev/out/RepositPlus-v0.7.0-Portable.exe --seconds 300

O relatório usa o processo do Reposit+ e seus descendentes, então RAM/CPU do
WebView2 também entram na conta. É ferramenta de desenvolvimento, não runtime.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import subprocess
import time
from pathlib import Path

try:
    import psutil
except ImportError as exc:  # pragma: no cover - utility script
    raise SystemExit("Instale dev/requirements-profile.txt antes de executar o profiler.") from exc


def process_tree(root: "psutil.Process") -> list["psutil.Process"]:
    try:
        return [root, *root.children(recursive=True)]
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return [root]


def sample_tree(root: "psutil.Process", logical_cpus: int) -> tuple[float, float, int]:
    ram = 0
    cpu = 0.0
    alive = 0
    for proc in process_tree(root):
        try:
            ram += proc.memory_info().rss
            cpu += proc.cpu_percent(interval=None)
            alive += 1
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    # psutil can report >100% when a process uses several logical cores.
    # Dividing gives a Task-Manager-like share of total machine CPU.
    return ram / 1024 / 1024, cpu / max(1, logical_cpus), alive


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", type=Path, required=True)
    parser.add_argument("--seconds", type=int, default=300)
    parser.add_argument("--interval", type=float, default=1.0)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    exe = args.exe.resolve()
    if not exe.is_file():
        raise SystemExit(f"Executável não encontrado: {exe}")

    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    output = args.output or Path(__file__).resolve().parent / "profile-results" / f"reposit-{stamp}.csv"
    output.parent.mkdir(parents=True, exist_ok=True)

    child = subprocess.Popen([str(exe)])
    root = psutil.Process(child.pid)
    logical = psutil.cpu_count(logical=True) or 1
    # Prime CPU counters before the first measured sample.
    for proc in process_tree(root):
        try:
            proc.cpu_percent(interval=None)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass

    rows: list[tuple[float, float, float, int]] = []
    started = time.monotonic()
    try:
        while time.monotonic() - started < max(1, args.seconds) and root.is_running():
            time.sleep(max(0.2, args.interval))
            elapsed = time.monotonic() - started
            ram_mb, cpu_pct, processes = sample_tree(root, logical)
            rows.append((elapsed, ram_mb, cpu_pct, processes))
            print(f"{elapsed:7.1f}s | RAM {ram_mb:7.1f} MB | CPU {cpu_pct:5.2f}% | processos {processes}")
    except KeyboardInterrupt:
        pass
    finally:
        with output.open("w", encoding="utf-8", newline="") as fp:
            writer = csv.writer(fp)
            writer.writerow(["seconds", "ram_mb", "cpu_percent_total_machine", "processes"])
            writer.writerows(rows)

    if rows:
        ram = [r[1] for r in rows]
        cpu = [r[2] for r in rows]
        print(f"\nRAM média/pico: {sum(ram)/len(ram):.1f}/{max(ram):.1f} MB")
        print(f"CPU média/pico: {sum(cpu)/len(cpu):.2f}/{max(cpu):.2f}%")
        print(f"Relatório: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
