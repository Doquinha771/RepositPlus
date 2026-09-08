from __future__ import annotations

import ctypes
import html
import os
import re
import shutil
import threading
import urllib.parse
import uuid
import webbrowser
from ctypes import wintypes
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Message builders
# ---------------------------------------------------------------------------

def build_default_message(profile: dict[str, Any], contact: dict[str, Any], activities: list[dict[str, Any]]) -> tuple[str, str]:
    weeks = sorted({str(a.get("week")) for a in activities if a.get("week") is not None})
    week_label = weeks[0] if len(weeks) == 1 else ", ".join(weeks) if weeks else "-"
    person = profile.get("name") or "Aluno"
    subject = f"Atividades - {person} - Semana {week_label}" if week_label != "-" else f"Atividades - {person}"

    ctype = contact.get("type", "Outro")
    cname = contact.get("nickname") or contact.get("name") or ""
    if ctype == "Professor":
        greeting = f"Olá, professor(a) {cname}." if cname else "Olá, professor(a)."
    elif ctype == "Aluno":
        greeting = f"Olá, {cname}." if cname else "Olá."
    elif ctype == "Grupo":
        greeting = f"Olá, pessoal do {cname}." if cname else "Olá, pessoal."
    else:
        greeting = f"Olá, {cname}." if cname else "Olá."

    lines = [greeting, "", "Segue em anexo o material selecionado no Reposit+.", ""]
    if profile.get("name"):
        lines.append(f"Nome: {profile['name']}")
    if profile.get("class_name"):
        lines.append(f"Turma: {profile['class_name']}")
    if week_label != "-":
        lines.append(f"Semana: {week_label}")
    lines.extend(["", "Atividades:"])
    for activity in activities:
        subject_name = activity.get("subject") or activity.get("repository") or "Atividade"
        lines.append(f"- {subject_name} - {activity.get('title', 'Sem título')}")
    lines.extend(["", "Atenciosamente,", person])
    return subject, "\n".join(lines)


def build_note_message(profile: dict[str, Any], recipient: str, notes: list[dict[str, Any]]) -> tuple[str, str]:
    person = profile.get("name") or profile.get("school_email") or "Reposit+"
    if len(notes) == 1:
        subject = notes[0].get("title") or "Anotação do Reposit+"
    else:
        subject = f"{len(notes)} anotações - {person}"
    lines = ["Olá,", "", "Estou enviando pelo Reposit+ o conteúdo abaixo.", ""]
    for note in notes:
        title = note.get("title") or "Sem título"
        kind = note.get("kind") or "Anotação"
        lines.append(f"{title} [{kind}]")
        content = str(note.get("content") or "")
        if note.get("content_format") == "html":
            content = re.sub(r"<br\s*/?>", "\n", content, flags=re.I)
            content = re.sub(r"</(?:p|div|li|h[1-6]|blockquote|tr)>", "\n", content, flags=re.I)
            content = html.unescape(re.sub(r"<[^>]+>", "", content))
        content = re.sub(r"\[\[reposit-(?:file|subnote):\d+(?:;[^\]]+)?\]\]", "", content).strip()
        if content:
            lines.append(content)
        lines.append("")
    if profile.get("name"):
        lines.extend(["Atenciosamente,", str(profile["name"])])
    return subject, "\n".join(lines).strip()


# ---------------------------------------------------------------------------
# Zero-config e-mail handoff
# ---------------------------------------------------------------------------
# Reposit+ no longer authenticates with Gmail/Outlook and does not store any
# mail credential. It hands a prepared message to the mail client already
# configured by Windows. Simple MAPI is tried first because it supports file
# attachments. If no MAPI client is available, the standard mailto: handler is
# used as a fallback.

MAPI_TO = 1
MAPI_LOGON_UI = 0x00000001
MAPI_DIALOG = 0x00000008


class MapiRecipDescW(ctypes.Structure):
    _fields_ = [
        ("ulReserved", wintypes.ULONG),
        ("ulRecipClass", wintypes.ULONG),
        ("lpszName", wintypes.LPWSTR),
        ("lpszAddress", wintypes.LPWSTR),
        ("ulEIDSize", wintypes.ULONG),
        ("lpEntryID", ctypes.c_void_p),
    ]


class MapiFileDescW(ctypes.Structure):
    _fields_ = [
        ("ulReserved", wintypes.ULONG),
        ("flFlags", wintypes.ULONG),
        ("nPosition", wintypes.ULONG),
        ("lpszPathName", wintypes.LPWSTR),
        ("lpszFileName", wintypes.LPWSTR),
        ("lpFileType", ctypes.c_void_p),
    ]


class MapiMessageW(ctypes.Structure):
    _fields_ = [
        ("ulReserved", wintypes.ULONG),
        ("lpszSubject", wintypes.LPWSTR),
        ("lpszNoteText", wintypes.LPWSTR),
        ("lpszMessageType", wintypes.LPWSTR),
        ("lpszDateReceived", wintypes.LPWSTR),
        ("lpszConversationID", wintypes.LPWSTR),
        ("flFlags", wintypes.ULONG),
        ("lpOriginator", ctypes.POINTER(MapiRecipDescW)),
        ("nRecipCount", wintypes.ULONG),
        ("lpRecips", ctypes.POINTER(MapiRecipDescW)),
        ("nFileCount", wintypes.ULONG),
        ("lpFiles", ctypes.POINTER(MapiFileDescW)),
    ]


def build_mailto_uri(recipient: str, subject: str, body: str) -> str:
    recipient = recipient.strip()
    query = urllib.parse.urlencode({"subject": subject, "body": body}, quote_via=urllib.parse.quote)
    return f"mailto:{urllib.parse.quote(recipient, safe='@,+')}?{query}"


def detect_system_mail_client() -> dict[str, Any]:
    """Best-effort information only. Sending does not depend on this probe."""
    result: dict[str, Any] = {
        "platform": "windows" if os.name == "nt" else os.name,
        "mapi_client": "",
        "mailto_handler": "",
        "attachments_native": False,
    }
    if os.name != "nt":
        return result

    try:
        import winreg

        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            try:
                with winreg.OpenKey(hive, r"Software\Clients\Mail") as key:
                    value, _ = winreg.QueryValueEx(key, "")
                    if value:
                        result["mapi_client"] = str(value)
                        result["attachments_native"] = True
                        break
            except OSError:
                continue

        try:
            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\mailto\UserChoice",
            ) as key:
                value, _ = winreg.QueryValueEx(key, "ProgId")
                result["mailto_handler"] = str(value or "")
        except OSError:
            pass
    except Exception:
        pass
    return result


def _send_with_mapi(recipient: str, subject: str, body: str, attachments: list[Path]) -> int:
    if os.name != "nt":
        raise OSError("Simple MAPI só está disponível no Windows.")

    mapi = ctypes.WinDLL("MAPI32.DLL")
    fn = getattr(mapi, "MAPISendMailW")
    fn.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(MapiMessageW), wintypes.ULONG, wintypes.ULONG]
    fn.restype = wintypes.ULONG

    recipient_desc = MapiRecipDescW(
        0,
        MAPI_TO,
        recipient,
        f"SMTP:{recipient}",
        0,
        None,
    )

    clean_attachments = [Path(path).resolve() for path in attachments if Path(path).exists() and Path(path).is_file()]
    file_array = None
    file_ptr = None
    if clean_attachments:
        array_type = MapiFileDescW * len(clean_attachments)
        file_array = array_type(
            *[
                MapiFileDescW(
                    0,
                    0,
                    0xFFFFFFFF,
                    str(path),
                    path.name,
                    None,
                )
                for path in clean_attachments
            ]
        )
        file_ptr = ctypes.cast(file_array, ctypes.POINTER(MapiFileDescW))

    message = MapiMessageW(
        0,
        subject,
        body,
        None,
        None,
        None,
        0,
        None,
        1,
        ctypes.pointer(recipient_desc),
        len(clean_attachments),
        file_ptr,
    )

    # The call is intentionally made with MAPI_DIALOG. Reposit+ prepares the
    # message and attachments, while the user's mail app remains responsible
    # for authentication and the final Send action.
    return int(fn(None, 0, ctypes.byref(message), MAPI_LOGON_UI | MAPI_DIALOG, 0))


def _open_mailto(recipient: str, subject: str, body: str) -> None:
    uri = build_mailto_uri(recipient, subject, body)
    if os.name == "nt":
        os.startfile(uri)  # type: ignore[attr-defined]
    else:
        if not webbrowser.open(uri, new=1):
            raise OSError("Nenhum aplicativo de e-mail padrão respondeu ao link mailto:.")


def _stage_attachments_for_fallback(attachments: list[Path], cache_dir: Path | None) -> Path | None:
    clean = [Path(path) for path in attachments if Path(path).exists() and Path(path).is_file()]
    if not clean or cache_dir is None:
        return None
    target = Path(cache_dir) / "mail-outbox" / uuid.uuid4().hex[:10]
    target.mkdir(parents=True, exist_ok=True)
    for source in clean:
        destination = target / source.name
        if destination.exists():
            destination = target / f"{source.stem}-{uuid.uuid4().hex[:5]}{source.suffix}"
        shutil.copy2(source, destination)
    return target


def compose_system_email(
    recipient: str,
    subject: str,
    body: str,
    attachments: list[Path] | None = None,
    cache_dir: Path | None = None,
) -> dict[str, Any]:
    """Open a prepared draft without any Reposit+ mail credential or API.

    On Windows, a registered Simple MAPI client is preferred because it can
    receive attachments directly. The MAPI dialog runs in a daemon thread so
    the Reposit+ UI does not wait for the user to finish composing the e-mail.
    If no MAPI client is registered, the standard mailto: handler is opened.
    """
    recipient = recipient.strip()
    if "@" not in recipient or recipient.startswith("@") or recipient.endswith("@"):
        raise ValueError("Digite um e-mail de destino válido.")

    attachments = [Path(path) for path in (attachments or []) if Path(path).exists() and Path(path).is_file()]
    client = detect_system_mail_client()

    if os.name == "nt" and client.get("mapi_client"):
        def worker() -> None:
            try:
                result = _send_with_mapi(recipient, subject, body, attachments)
                # 0 = sent/accepted by the client, 1 is commonly user abort.
                # Any other result means the client rejected the MAPI request;
                # in that case we still hand the message to the mailto handler.
                if result not in {0, 1}:
                    _open_mailto(recipient, subject, body)
                    folder = _stage_attachments_for_fallback(attachments, cache_dir)
                    if folder is not None and os.name == "nt":
                        os.startfile(folder)  # type: ignore[attr-defined]
            except Exception:
                try:
                    _open_mailto(recipient, subject, body)
                    folder = _stage_attachments_for_fallback(attachments, cache_dir)
                    if folder is not None and os.name == "nt":
                        os.startfile(folder)  # type: ignore[attr-defined]
                except Exception:
                    pass

        threading.Thread(target=worker, name="reposit-system-mail", daemon=True).start()
        return {
            "ok": True,
            "status": "rascunho aberto",
            "method": "mapi",
            "client": client.get("mapi_client") or "Aplicativo de e-mail do Windows",
            "attachments": len(attachments),
            "attachments_manual": False,
        }

    # No MAPI client. mailto: still works with browser handlers such as Gmail
    # when the user has configured them as the default mail handler. Standard
    # mailto does not provide a portable attachment mechanism, so attachments
    # are staged in one folder for quick drag-and-drop if needed.
    _open_mailto(recipient, subject, body)
    staged = _stage_attachments_for_fallback(attachments, cache_dir)
    if staged is not None and os.name == "nt":
        try:
            os.startfile(staged)  # type: ignore[attr-defined]
        except Exception:
            pass
    return {
        "ok": True,
        "status": "rascunho aberto",
        "method": "mailto",
        "client": client.get("mailto_handler") or "Aplicativo de e-mail padrão",
        "attachments": len(attachments),
        "attachments_manual": bool(attachments),
        "attachments_folder": str(staged) if staged else "",
    }
