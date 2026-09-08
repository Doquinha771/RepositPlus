from __future__ import annotations

import json
import socket
import threading
import time
from typing import Any

from .config import APP_VERSION
from .database import Database, utcnow

DISCOVERY_PORT = 43821
MAGIC = "REPOSIT_PLUS_DISCOVERY"


class DiscoveryService:
    def __init__(self, db: Database, identity: dict[str, Any], http_port: int, enabled_getter):
        self.db = db
        self.identity = identity
        self.http_port = http_port
        self.enabled_getter = enabled_getter
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []

    def start(self) -> None:
        if self._threads:
            return
        self._threads = [
            threading.Thread(target=self._listen_loop, name="reposit-discovery-listener", daemon=True),
            threading.Thread(target=self._announce_loop, name="reposit-discovery-announcer", daemon=True),
        ]
        for thread in self._threads:
            thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _packet(self) -> bytes:
        payload = {
            "magic": MAGIC,
            "device_uuid": self.identity["device_uuid"],
            "device_name": self.identity.get("device_name", "Reposit-PC"),
            "version": APP_VERSION,
            "port": self.http_port,
        }
        return json.dumps(payload).encode("utf-8")

    def _announce_loop(self) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        while not self._stop.is_set():
            if self.enabled_getter():
                try:
                    sock.sendto(self._packet(), ("255.255.255.255", DISCOVERY_PORT))
                except OSError:
                    pass
            self._stop.wait(12.0 if self.enabled_getter() else 30.0)
        sock.close()

    def _listen_loop(self) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("", DISCOVERY_PORT))
        except OSError:
            return
        sock.settimeout(3.0)
        while not self._stop.is_set():
            if not self.enabled_getter():
                self._stop.wait(10.0)
                continue
            try:
                data, addr = sock.recvfrom(8192)
            except socket.timeout:
                continue
            except OSError:
                break
            if not self.enabled_getter():
                continue
            try:
                payload = json.loads(data.decode("utf-8"))
            except Exception:
                continue
            if payload.get("magic") != MAGIC:
                continue
            if payload.get("device_uuid") == self.identity.get("device_uuid"):
                continue
            self._upsert_device(payload, addr[0])
        sock.close()

    def _upsert_device(self, payload: dict[str, Any], ip: str) -> None:
        existing = self.db.fetchone("SELECT id, trusted FROM devices WHERE uuid=?", (payload.get("device_uuid"),))
        if existing:
            self.db.execute(
                "UPDATE devices SET name=?, ip=?, port=?, version=?, last_seen=? WHERE uuid=?",
                (
                    str(payload.get("device_name") or "Reposit-PC")[:120],
                    ip,
                    int(payload.get("port") or 0),
                    str(payload.get("version") or "")[:32],
                    utcnow(),
                    payload.get("device_uuid"),
                ),
            )
        else:
            self.db.execute(
                "INSERT INTO devices(uuid,name,ip,port,version,trusted,last_seen) VALUES (?,?,?,?,?,0,?)",
                (
                    payload.get("device_uuid"),
                    str(payload.get("device_name") or "Reposit-PC")[:120],
                    ip,
                    int(payload.get("port") or 0),
                    str(payload.get("version") or "")[:32],
                    utcnow(),
                ),
            )
