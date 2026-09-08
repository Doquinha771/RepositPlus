from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx


def send_share(device: dict[str, Any], sender: dict[str, Any], metadata: dict[str, Any], file_path: Path | None = None) -> dict[str, Any]:
    ip = device.get("ip")
    port = int(device.get("port") or 0)
    if not ip or not port:
        raise ValueError("Dispositivo sem endereço válido.")
    payload = dict(metadata)
    payload["sender_uuid"] = sender.get("device_uuid")
    payload["sender_name"] = sender.get("device_name")
    payload["sender_port"] = sender.get("port")
    files = None
    handle = None
    try:
        if file_path and file_path.exists():
            handle = file_path.open("rb")
            files = {"file": (file_path.name, handle, "application/octet-stream")}
        response = httpx.post(
            f"http://{ip}:{port}/p2p/share",
            data={"metadata": json.dumps(payload, ensure_ascii=False)},
            files=files,
            timeout=20.0,
        )
        response.raise_for_status()
        return response.json()
    finally:
        if handle:
            handle.close()
