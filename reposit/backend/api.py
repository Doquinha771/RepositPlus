from __future__ import annotations

import html
import json
import logging
import os
import re
import shutil
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .backups import export_reposit, import_reposit
from .config import APP_NAME, APP_VERSION, AppPaths, save_settings
from .database import Database, utcnow
from .email_service import build_default_message, build_note_message, compose_system_email, detect_system_mail_client
from .file_service import MAX_FILE_SIZE, file_mime, safe_unlink, sanitize_filename, save_stream_to_controlled_path
from .parser import parse_school_filename
from .p2p import send_share
from .search import search_activities

log = logging.getLogger("reposit.api")


class RepositoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=1000)


class ContactIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(default="", max_length=240)
    type: str = "Outro"
    nickname: str = ""
    notes: str = ""
    category: str = ""
    favorite: bool = False


class ActivityIn(BaseModel):
    title: str = Field(min_length=1, max_length=220)
    description: str = ""
    subject: str = ""
    repository_id: int | None = None
    teacher: str = ""
    week: int | None = None
    bimester: int | None = None
    activity_date: str | None = None
    status: str = "Não iniciada"
    notes: str = ""
    tags: list[str] = []
    origin: str = "manual"
    pinned: bool = False


class EmailPreviewIn(BaseModel):
    contact_id: int
    activity_ids: list[int]


class EmailSendIn(EmailPreviewIn):
    subject: str
    body: str


class MuralPostIn(BaseModel):
    activity_id: int | None = None
    title: str
    subject: str = ""
    week: int | None = None
    description: str = ""
    contains_answers: bool = False
    distribute: bool = True


class DirectShareIn(BaseModel):
    device_uuid: str
    activity_id: int
    contains_answers: bool = False


class NoteIn(BaseModel):
    title: str = Field(default="", max_length=220)
    kind: str = Field(default="Anotação", max_length=80)
    content: str = Field(default="", max_length=120000)
    tags: str = Field(default="", max_length=1000)
    pinned: bool = False
    content_format: str = Field(default="plain", max_length=20)
    parent_note_id: int | None = None


class NoteEmailPreviewIn(BaseModel):
    recipient: str = Field(min_length=3, max_length=320)
    note_ids: list[int] = []


class NoteEmailSendIn(NoteEmailPreviewIn):
    subject: str = Field(default="", max_length=500)
    body: str = Field(default="", max_length=100000)


class NoteMuralIn(BaseModel):
    note_id: int
    contains_answers: bool = False
    distribute: bool = True


class AppState:
    def __init__(self, paths: AppPaths, db: Database, settings: dict[str, Any], identity: dict[str, Any], http_port: int, distribution: str = "source"):
        self.paths = paths
        self.db = db
        self.settings = settings
        self.identity = identity
        self.http_port = http_port
        self.distribution = distribution


def create_app(state: AppState) -> FastAPI:
    app = FastAPI(title=APP_NAME, version=APP_VERSION)
    app.state.reposit = state

    @app.middleware("http")
    async def local_api_guard(request: Request, call_next):
        host = request.client.host if request.client else ""
        local_hosts = {"127.0.0.1", "::1", "localhost", "testclient"}
        if host not in local_hosts and request.url.path != "/p2p/share":
            return JSONResponse(status_code=403, content={"detail": "Rota disponível apenas localmente."})
        return await call_next(request)

    app.mount("/static", StaticFiles(directory=state.paths.frontend), name="static")

    @app.get("/")
    async def frontend_index():
        return FileResponse(state.paths.frontend / "index.html")

    @app.get("/api/health")
    def health():
        return {"ok": True, "name": APP_NAME, "version": APP_VERSION, "device_uuid": state.identity["device_uuid"]}

    @app.get("/api/app-info")
    def app_info():
        labels = {"installed": "Setup", "portable": "Portable", "source": "Código-fonte"}
        return {
            "name": APP_NAME,
            "version": APP_VERSION,
            "distribution": state.distribution,
            "distribution_label": labels.get(state.distribution, state.distribution),
            "data_path": str(state.paths.root),
        }

    @app.get("/api/profile")
    def get_profile():
        return state.db.fetchone("SELECT * FROM profile WHERE id=1") or {}

    @app.patch("/api/profile")
    def patch_profile(payload: dict[str, Any]):
        allowed = ["name", "class_name", "grade", "school", "school_email", "course", "shift"]
        updates = {k: str(payload[k])[:250] for k in allowed if k in payload}
        if not updates:
            return get_profile()
        sets = ",".join(f"{k}=?" for k in updates)
        state.db.execute(f"UPDATE profile SET {sets} WHERE id=1", tuple(updates.values()))
        return get_profile()

    @app.get("/api/settings")
    def get_settings():
        public = json.loads(json.dumps(state.settings))
        # Legacy SMTP/OAuth values may still exist in settings.json from older
        # 0.1.0 builds. They are deliberately not exposed or used anymore.
        public.pop("smtp", None)
        public["account"] = {"provider": "system_mail", "connected": False}
        public["device_uuid"] = state.identity.get("device_uuid")
        public["device_name"] = state.identity.get("device_name")
        public["mail_client"] = detect_system_mail_client()
        return public

    @app.patch("/api/settings")
    def patch_settings(payload: dict[str, Any]):
        def merge(base: dict[str, Any], incoming: dict[str, Any]):
            for k, v in incoming.items():
                if k in {"device_uuid", "smtp", "account"}:
                    continue
                if isinstance(v, dict) and isinstance(base.get(k), dict):
                    merge(base[k], v)
                else:
                    base[k] = v
        merge(state.settings, payload)
        if payload.get("device_name"):
            state.identity["device_name"] = str(payload["device_name"])[:120]
            state.paths.identity.write_text(json.dumps(state.identity, ensure_ascii=False, indent=2), encoding="utf-8")
        save_settings(state.paths, state.settings)
        return get_settings()

    @app.get("/api/account")
    def get_account():
        profile = get_profile()
        mail_client = detect_system_mail_client()
        return {
            "email": profile.get("school_email") or "",
            "provider": "system_mail",
            "connected": bool(mail_client.get("mapi_client") or mail_client.get("mailto_handler")),
            "mail_client": mail_client,
            "credential_storage": "none",
        }

    @app.post("/api/account/logout")
    def account_logout():
        # Kept as a harmless compatibility route for old frontends. Reposit+
        # does not own a mail session anymore, so there is nothing to log out.
        return get_account()

    @app.get("/api/notes")
    def list_notes(q: str | None = None, kind: str | None = None, tag: str | None = None, include_children: bool = False, limit: int = 500):
        where = ["1=1"]
        params: list[Any] = []
        if not include_children:
            where.append("parent_note_id IS NULL")
        if q:
            like = f"%{q.strip()}%"
            where.append("(title LIKE ? OR content LIKE ? OR kind LIKE ? OR tags LIKE ?)")
            params.extend([like, like, like, like])
        if kind:
            where.append("kind=?")
            params.append(kind)
        if tag:
            where.append("(',' || REPLACE(tags,' ', '') || ',') LIKE ?")
            params.append(f"%,{tag.strip().replace(' ', '')},%")
        rows = state.db.fetchall(
            f"SELECT n.*, (SELECT COUNT(*) FROM note_files nf WHERE nf.note_id=n.id) file_count, (SELECT COUNT(*) FROM notes c WHERE c.parent_note_id=n.id) subnote_count FROM notes n WHERE {' AND '.join(where)} ORDER BY pinned DESC, updated_at DESC LIMIT ?",
            [*params, min(max(int(limit), 1), 1000)],
        )
        return rows

    @app.get("/api/note-tags")
    def list_note_tags():
        counts: dict[str, int] = {}
        for row in state.db.fetchall("SELECT tags FROM notes WHERE tags!=''"):
            for tag_name in _split_note_tags(row.get("tags") or ""):
                key = tag_name.casefold()
                if key not in counts:
                    counts[key] = 0
                counts[key] += 1
        display: dict[str, str] = {}
        for row in state.db.fetchall("SELECT tags FROM notes WHERE tags!=''"):
            for tag_name in _split_note_tags(row.get("tags") or ""):
                display.setdefault(tag_name.casefold(), tag_name)
        return [{"name": display[k], "count": counts[k]} for k in sorted(counts, key=lambda x: (-counts[x], display[x].casefold()))]

    @app.patch("/api/note-tags/rename")
    def rename_note_tag(payload: dict[str, Any]):
        old = str(payload.get("old") or "").strip()
        new = str(payload.get("new") or "").strip().lstrip("#")[:80]
        if not old or not new:
            raise HTTPException(400, "Informe a tag atual e o novo nome.")
        changed = 0
        for row in state.db.fetchall("SELECT id,tags FROM notes WHERE tags!=''"):
            tags = _split_note_tags(row.get("tags") or "")
            replaced = [new if t.casefold() == old.casefold() else t for t in tags]
            dedup = []
            seen = set()
            for tag_name in replaced:
                key = tag_name.casefold()
                if key not in seen:
                    seen.add(key); dedup.append(tag_name)
            if tags != dedup:
                state.db.execute("UPDATE notes SET tags=?,updated_at=? WHERE id=?", (", ".join(dedup), utcnow(), row["id"]))
                _rebuild_note_fts(state.db, int(row["id"])); changed += 1
        return {"ok": True, "changed": changed}

    @app.delete("/api/note-tags/{tag_name}")
    def remove_note_tag(tag_name: str):
        changed = 0
        for row in state.db.fetchall("SELECT id,tags FROM notes WHERE tags!=''"):
            tags = _split_note_tags(row.get("tags") or "")
            kept = [t for t in tags if t.casefold() != tag_name.casefold()]
            if kept != tags:
                state.db.execute("UPDATE notes SET tags=?,updated_at=? WHERE id=?", (", ".join(kept), utcnow(), row["id"]))
                _rebuild_note_fts(state.db, int(row["id"])); changed += 1
        return {"ok": True, "changed": changed}

    @app.post("/api/notes", status_code=201)
    def create_note(payload: NoteIn):
        now = utcnow()
        title = payload.title.strip() or "Nova anotação"
        if payload.parent_note_id and not state.db.fetchone("SELECT id FROM notes WHERE id=?", (payload.parent_note_id,)):
            raise HTTPException(404, "Nota principal não encontrada.")
        nid = state.db.execute(
            "INSERT INTO notes(title,kind,content,tags,pinned,content_format,parent_note_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (title, payload.kind.strip() or "Anotação", payload.content, payload.tags, int(payload.pinned), payload.content_format if payload.content_format in {"plain","html"} else "plain", payload.parent_note_id, now, now),
        )
        _rebuild_note_fts(state.db, nid)
        return _note_full(state, nid)

    @app.post("/api/notes/{note_id}/subnotes", status_code=201)
    def create_subnote(note_id: int, payload: dict[str, Any] | None = None):
        if not state.db.fetchone("SELECT id FROM notes WHERE id=?", (note_id,)):
            raise HTTPException(404, "Nota principal não encontrada.")
        data = payload or {}
        note = NoteIn(title=str(data.get("title") or "Nova subnota"), kind=str(data.get("kind") or "Subnota"), tags=str(data.get("tags") or ""), parent_note_id=note_id)
        return create_note(note)

    @app.get("/api/notes/{note_id}")
    def get_note(note_id: int):
        note = _note_full(state, note_id)
        if not note:
            raise HTTPException(404, "Anotação não encontrada.")
        return note

    @app.patch("/api/notes/{note_id}")
    def patch_note(note_id: int, payload: dict[str, Any]):
        allowed = {"title", "kind", "content", "tags", "pinned", "content_format", "parent_note_id"}
        updates = {k: payload[k] for k in allowed if k in payload}
        if not state.db.fetchone("SELECT id FROM notes WHERE id=?", (note_id,)):
            raise HTTPException(404, "Anotação não encontrada.")
        if updates:
            normalized: dict[str, Any] = {}
            for k, v in updates.items():
                if k == "pinned": normalized[k] = int(bool(v))
                elif k == "parent_note_id": normalized[k] = int(v) if v not in (None, "") else None
                elif k == "content_format": normalized[k] = "html" if str(v) == "html" else "plain"
                else: normalized[k] = str(v)[:120000 if k == "content" else 50000]
            normalized["updated_at"] = utcnow()
            sets = ",".join(f"{k}=?" for k in normalized)
            state.db.execute(f"UPDATE notes SET {sets} WHERE id=?", [*normalized.values(), note_id])
            _rebuild_note_fts(state.db, note_id)
        return _note_full(state, note_id)

    @app.delete("/api/notes/{note_id}")
    def delete_note(note_id: int):
        files = state.db.fetchall("SELECT filepath FROM note_files WHERE note_id=?", (note_id,))
        for row in files:
            safe_unlink(row.get("filepath") or "", state.paths.attachments)
        state.db.execute("UPDATE notes SET parent_note_id=NULL WHERE parent_note_id=?", (note_id,))
        state.db.execute("DELETE FROM notes WHERE id=?", (note_id,))
        state.db.execute("DELETE FROM note_fts WHERE note_id=?", (note_id,))
        return {"ok": True}

    @app.post("/api/notes/{note_id}/files", status_code=201)
    async def add_note_file(note_id: int, file: UploadFile = File(...)):
        if not state.db.fetchone("SELECT id FROM notes WHERE id=?", (note_id,)):
            raise HTTPException(404, "Anotação não encontrada.")
        try:
            path, digest, size = save_stream_to_controlled_path(file.file, state.paths.originals, file.filename or "arquivo")
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        duplicate = state.db.fetchone("SELECT nf.id,nf.note_id,n.title FROM note_files nf JOIN notes n ON n.id=nf.note_id WHERE nf.file_hash=? LIMIT 1", (digest,))
        if duplicate:
            path.unlink(missing_ok=True)
            raise HTTPException(409, f"Este arquivo já existe em ‘{duplicate.get('title') or 'outra anotação'}’." )
        fid = state.db.execute(
            "INSERT INTO note_files(note_id,filename,filepath,file_type,file_hash,size,created_at) VALUES (?,?,?,?,?,?,?)",
            (note_id, path.name, str(path), file_mime(path.name), digest, size, utcnow()),
        )
        state.db.execute("UPDATE notes SET updated_at=? WHERE id=?", (utcnow(), note_id))
        return state.db.fetchone("SELECT * FROM note_files WHERE id=?", (fid,))

    @app.delete("/api/note-files/{file_id}")
    def delete_note_file(file_id: int):
        row = state.db.fetchone("SELECT * FROM note_files WHERE id=?", (file_id,))
        if not row:
            raise HTTPException(404, "Arquivo não encontrado.")
        safe_unlink(row.get("filepath") or "", state.paths.attachments)
        state.db.execute("DELETE FROM note_files WHERE id=?", (file_id,))
        return {"ok": True}

    @app.get("/api/note-files/{file_id}")
    def get_note_file(file_id: int):
        row = state.db.fetchone("SELECT * FROM note_files WHERE id=?", (file_id,))
        if not row:
            raise HTTPException(404, "Arquivo não encontrado.")
        path = Path(row["filepath"])
        if not path.exists():
            raise HTTPException(404, "Arquivo físico não encontrado.")
        return FileResponse(path, filename=row["filename"], media_type=row.get("file_type") or "application/octet-stream")

    @app.post("/api/notes/email/preview")
    def preview_note_email(payload: NoteEmailPreviewIn):
        notes = [_note_full(state, nid) for nid in payload.note_ids]
        notes = [n for n in notes if n]
        if not notes:
            raise HTTPException(400, "Selecione pelo menos uma anotação.")
        subject, body = build_note_message(get_profile(), payload.recipient.strip(), notes)
        signature = str(state.settings.get("email_signature") or "").strip()
        if signature:
            body = f"{body}\n\n{signature}"
        return {"recipient": payload.recipient.strip(), "subject": subject, "body": body, "notes": notes}

    @app.post("/api/notes/email/send")
    def send_note_email(payload: NoteEmailSendIn):
        recipient = payload.recipient.strip()
        if "@" not in recipient:
            raise HTTPException(400, "Digite um e-mail de destino válido.")
        notes = [_note_full(state, nid) for nid in payload.note_ids]
        notes = [n for n in notes if n]
        if not notes:
            raise HTTPException(400, "Selecione pelo menos uma anotação.")
        attachments: list[Path] = []
        for note in notes:
            for f in note.get("files", []):
                p = Path(f["filepath"])
                if p.exists():
                    attachments.append(p)
        status = "rascunho aberto"
        error = ""
        result: dict[str, Any] = {}
        try:
            result = compose_system_email(
                recipient, payload.subject, payload.body, attachments, cache_dir=state.paths.cache
            )
            status = str(result.get("status") or status)
        except Exception as exc:
            status = "erro"
            error = str(exc)
        state.db.execute(
            "INSERT INTO email_history(recipient,recipient_name,contact_type,subject,status,activity_ids,error,created_at) VALUES (?,?,?,?,?,?,?,?)",
            (recipient, recipient, "Direto", payload.subject, status, ",".join(str(n["id"]) for n in notes), error, utcnow()),
        )
        if status == "erro":
            raise HTTPException(400, error)
        return {"ok": True, "status": status, **result}

    @app.post("/api/notes/mural", status_code=201)
    def publish_note_mural(payload: NoteMuralIn, background: BackgroundTasks):
        note = _note_full(state, payload.note_id)
        if not note:
            raise HTTPException(404, "Anotação não encontrada.")
        file_path = Path(note["files"][0]["filepath"]) if note.get("files") else None
        file_name = note["files"][0]["filename"] if note.get("files") else ""
        author = get_profile().get("name") or get_profile().get("school_email") or state.identity.get("device_name") or "Reposit+"
        post_id = state.db.execute(
            "INSERT INTO wall_posts(activity_id,title,subject,week,description,author,author_device,contains_answers,file_path,file_name,created_at) VALUES (NULL,?,?,?,?,?,?,?,?,?,?)",
            (note["title"], note["kind"], None, _note_plain_text(note), author, state.identity["device_uuid"], int(payload.contains_answers), str(file_path or ""), file_name, utcnow()),
        )
        post = state.db.fetchone("SELECT * FROM wall_posts WHERE id=?", (post_id,))
        if payload.distribute and state.settings.get("mural_enabled"):
            for peer in devices():
                background.add_task(_send_post_to_peer, state, peer, post, file_path)
        return post

    @app.get("/api/repositories")
    def list_repositories():
        return state.db.fetchall(
            """SELECT r.*, COUNT(a.id) activity_count
               FROM repositories r LEFT JOIN activities a ON a.repository_id=r.id
               GROUP BY r.id ORDER BY r.name COLLATE NOCASE"""
        )

    @app.post("/api/repositories", status_code=201)
    def create_repository(payload: RepositoryIn):
        try:
            rid = state.db.execute(
                "INSERT INTO repositories(name,description,created_at) VALUES (?,?,?)",
                (payload.name.strip(), payload.description.strip(), utcnow()),
            )
        except Exception as exc:
            raise HTTPException(409, "Já existe um repositório com esse nome.") from exc
        return state.db.fetchone("SELECT * FROM repositories WHERE id=?", (rid,))

    @app.patch("/api/repositories/{repository_id}")
    def update_repository(repository_id: int, payload: RepositoryIn):
        state.db.execute("UPDATE repositories SET name=?,description=? WHERE id=?", (payload.name.strip(), payload.description.strip(), repository_id))
        return state.db.fetchone("SELECT * FROM repositories WHERE id=?", (repository_id,))

    @app.delete("/api/repositories/{repository_id}")
    def delete_repository(repository_id: int):
        state.db.execute("DELETE FROM repositories WHERE id=?", (repository_id,))
        return {"ok": True}

    @app.get("/api/subjects")
    def list_subjects():
        return state.db.fetchall("SELECT * FROM subjects ORDER BY name COLLATE NOCASE")

    @app.get("/api/contacts")
    def list_contacts():
        return state.db.fetchall("SELECT * FROM contacts ORDER BY favorite DESC, name COLLATE NOCASE")

    @app.post("/api/contacts", status_code=201)
    def create_contact(payload: ContactIn):
        if payload.type not in {"Professor", "Aluno", "Grupo", "Outro"}:
            raise HTTPException(400, "Tipo de contato inválido.")
        cid = state.db.execute(
            "INSERT INTO contacts(name,email,type,nickname,notes,category,favorite,created_at) VALUES (?,?,?,?,?,?,?,?)",
            (payload.name.strip(), payload.email.strip(), payload.type, payload.nickname.strip(), payload.notes.strip(), payload.category.strip(), int(payload.favorite), utcnow()),
        )
        return state.db.fetchone("SELECT * FROM contacts WHERE id=?", (cid,))

    @app.patch("/api/contacts/{contact_id}")
    def update_contact(contact_id: int, payload: ContactIn):
        state.db.execute(
            "UPDATE contacts SET name=?,email=?,type=?,nickname=?,notes=?,category=?,favorite=? WHERE id=?",
            (payload.name.strip(), payload.email.strip(), payload.type, payload.nickname.strip(), payload.notes.strip(), payload.category.strip(), int(payload.favorite), contact_id),
        )
        return state.db.fetchone("SELECT * FROM contacts WHERE id=?", (contact_id,))

    @app.delete("/api/contacts/{contact_id}")
    def delete_contact(contact_id: int):
        state.db.execute("DELETE FROM contacts WHERE id=?", (contact_id,))
        return {"ok": True}

    @app.get("/api/activities")
    def list_activities(status: str | None = None, repository_id: int | None = None, week: int | None = None, archived: bool = False, limit: int = 200):
        where = []
        params: list[Any] = []
        if archived:
            where.append("a.status='Arquivada'")
        elif status:
            where.append("a.status=?")
            params.append(status)
        else:
            where.append("a.status!='Arquivada'")
        if repository_id is not None:
            where.append("a.repository_id=?")
            params.append(repository_id)
        if week is not None:
            where.append("a.week=?")
            params.append(week)
        params.append(min(max(limit, 1), 500))
        return state.db.fetchall(
            f"""
            SELECT a.*, COALESCE(s.name,'') subject, COALESCE(r.name,'') repository, COALESCE(t.name,'') teacher,
                   (SELECT COUNT(*) FROM files f WHERE f.activity_id=a.id) file_count
            FROM activities a
            LEFT JOIN subjects s ON s.id=a.subject_id
            LEFT JOIN repositories r ON r.id=a.repository_id
            LEFT JOIN teachers t ON t.id=a.teacher_id
            WHERE {' AND '.join(where)}
            ORDER BY a.pinned DESC, CASE WHEN a.activity_date IS NULL OR a.activity_date='' THEN 1 ELSE 0 END, a.activity_date ASC, a.updated_at DESC LIMIT ?
            """,
            params,
        )

    @app.post("/api/activities", status_code=201)
    def create_activity(payload: ActivityIn):
        aid = _insert_activity(state, payload)
        return _activity_full(state, aid)

    @app.get("/api/activities/{activity_id}")
    def get_activity(activity_id: int):
        item = _activity_full(state, activity_id)
        if not item:
            raise HTTPException(404, "Atividade não encontrada.")
        return item

    @app.patch("/api/activities/{activity_id}")
    def update_activity(activity_id: int, payload: ActivityIn):
        if not state.db.fetchone("SELECT id FROM activities WHERE id=?", (activity_id,)):
            raise HTTPException(404, "Atividade não encontrada.")
        subject_id = _ensure_named(state.db, "subjects", payload.subject)
        teacher_id = _ensure_teacher(state.db, payload.teacher)
        state.db.execute(
            """UPDATE activities SET title=?,description=?,subject_id=?,repository_id=?,teacher_id=?,week=?,bimester=?,activity_date=?,status=?,notes=?,pinned=?,completed_at=?,updated_at=? WHERE id=?""",
            (payload.title.strip(), payload.description, subject_id, payload.repository_id, teacher_id, payload.week, payload.bimester, payload.activity_date, payload.status, payload.notes, int(payload.pinned), utcnow() if payload.status in {"Respondida","Entregue","Concluída"} else "", utcnow(), activity_id),
        )
        _set_tags(state.db, activity_id, payload.tags)
        state.db.log_activity(activity_id, "editada")
        state.db.rebuild_activity_fts(activity_id)
        return _activity_full(state, activity_id)

    @app.patch("/api/activities/{activity_id}/state")
    def update_activity_state(activity_id: int, payload: dict[str, Any]):
        row = state.db.fetchone("SELECT * FROM activities WHERE id=?", (activity_id,))
        if not row:
            raise HTTPException(404, "Atividade não encontrada.")
        updates: dict[str, Any] = {}
        if "pinned" in payload: updates["pinned"] = int(bool(payload.get("pinned")))
        if "status" in payload:
            status = str(payload.get("status") or "Não iniciada")[:80]
            updates["status"] = status
            updates["completed_at"] = utcnow() if status in {"Respondida","Entregue","Concluída"} else ""
        if "activity_date" in payload: updates["activity_date"] = str(payload.get("activity_date") or "")[:32]
        if updates:
            updates["updated_at"] = utcnow()
            state.db.execute(f"UPDATE activities SET {','.join(f'{k}=?' for k in updates)} WHERE id=?", [*updates.values(), activity_id])
            state.db.log_activity(activity_id, "estado atualizado")
        return _activity_full(state, activity_id)

    @app.delete("/api/activities/{activity_id}")
    def delete_activity(activity_id: int, delete_files: bool = False):
        files = state.db.fetchall("SELECT filepath FROM files WHERE activity_id=?", (activity_id,))
        state.db.execute("DELETE FROM activities WHERE id=?", (activity_id,))
        state.db.execute("DELETE FROM activity_fts WHERE activity_id=?", (activity_id,))
        if delete_files:
            for f in files:
                safe_unlink(f["filepath"], state.paths.attachments)
        return {"ok": True}

    @app.post("/api/activities/{activity_id}/files", status_code=201)
    async def add_activity_file(activity_id: int, file: UploadFile = File(...), role: str = Form("attachment"), force: bool = Form(False)):
        if not state.db.fetchone("SELECT id FROM activities WHERE id=?", (activity_id,)):
            raise HTTPException(404, "Atividade não encontrada.")
        target_dir = state.paths.answered if role == "answered" else state.paths.originals if role == "original" else state.paths.attachments
        try:
            path, digest, size = save_stream_to_controlled_path(file.file, target_dir, file.filename or "arquivo", allow_any_extension=True)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        duplicate = state.db.fetchone("SELECT f.id,f.activity_id,a.title FROM files f LEFT JOIN activities a ON a.id=f.activity_id WHERE f.file_hash=? LIMIT 1", (digest,))
        if duplicate and not force:
            path.unlink(missing_ok=True)
            return JSONResponse(status_code=409, content={"detail": "Este arquivo já existe no Reposit+.", "duplicate": duplicate})
        fid = state.db.execute(
            "INSERT INTO files(activity_id,filename,filepath,file_type,file_hash,role,size,created_at) VALUES (?,?,?,?,?,?,?,?)",
            (activity_id, path.name, str(path), file_mime(path.name), digest, role, size, utcnow()),
        )
        state.db.log_activity(activity_id, "arquivo adicionado", path.name)
        state.db.rebuild_activity_fts(activity_id)
        return state.db.fetchone("SELECT * FROM files WHERE id=?", (fid,))

    @app.get("/api/files/{file_id}")
    def download_file(file_id: int):
        row = state.db.fetchone("SELECT * FROM files WHERE id=?", (file_id,))
        if not row or not Path(row["filepath"]).exists():
            raise HTTPException(404, "Arquivo não encontrado no disco.")
        return FileResponse(row["filepath"], filename=row["filename"])

    @app.post("/api/import/parse")
    async def parse_upload(file: UploadFile = File(...)):
        return parse_school_filename(file.filename or "arquivo")

    @app.post("/api/import/activity", status_code=201)
    async def import_activity(
        file: UploadFile = File(...),
        title: str = Form(...), subject: str = Form(""), repository_id: int | None = Form(None), teacher: str = Form(""),
        week: int | None = Form(None), bimester: int | None = Form(None), status: str = Form("Não iniciada"), tags: str = Form(""), force: bool = Form(False),
    ):
        try:
            path, digest, size = save_stream_to_controlled_path(file.file, state.paths.originals, file.filename or "arquivo", allow_any_extension=True)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        duplicate = state.db.fetchone("SELECT f.id,f.activity_id,a.title FROM files f LEFT JOIN activities a ON a.id=f.activity_id WHERE f.file_hash=? LIMIT 1", (digest,))
        if duplicate and not force:
            path.unlink(missing_ok=True)
            return JSONResponse(status_code=409, content={"detail": "Este arquivo já existe no Reposit+.", "duplicate": duplicate})
        payload = ActivityIn(
            title=title, subject=subject, repository_id=repository_id, teacher=teacher, week=week, bimester=bimester,
            status=status, tags=[t.strip() for t in tags.split(",") if t.strip()], origin="import",
        )
        aid = _insert_activity(state, payload)
        state.db.execute(
            "INSERT INTO files(activity_id,filename,filepath,file_type,file_hash,role,size,created_at) VALUES (?,?,?,?,?,?,?,?)",
            (aid, path.name, str(path), file_mime(path.name), digest, "original", size, utcnow()),
        )
        state.db.log_activity(aid, "importada", path.name)
        state.db.rebuild_activity_fts(aid)
        return _activity_full(state, aid)

    @app.get("/api/search")
    def search(q: str = Query(min_length=1, max_length=200)):
        return search_activities(state.db, q)

    @app.get("/api/weeks")
    def weeks():
        return state.db.fetchall(
            """
            SELECT week,
                   COUNT(*) total,
                   SUM(CASE WHEN status IN ('Respondida','Entregue') THEN 1 ELSE 0 END) completed,
                   SUM(CASE WHEN status='Em andamento' THEN 1 ELSE 0 END) in_progress,
                   SUM(CASE WHEN status='Não iniciada' THEN 1 ELSE 0 END) pending
            FROM activities WHERE week IS NOT NULL AND status!='Arquivada'
            GROUP BY week ORDER BY week DESC
            """
        )

    @app.get("/api/dashboard")
    def dashboard():
        stats = state.db.fetchone(
            """SELECT COUNT(*) total,
                      SUM(CASE WHEN status='Não iniciada' THEN 1 ELSE 0 END) pending,
                      SUM(CASE WHEN status='Em andamento' THEN 1 ELSE 0 END) in_progress,
                      SUM(CASE WHEN status IN ('Respondida','Entregue') THEN 1 ELSE 0 END) completed
               FROM activities WHERE status!='Arquivada'"""
        ) or {}
        recent = list_activities(limit=6)
        week_row = state.db.fetchone("SELECT MAX(week) week FROM activities WHERE status!='Arquivada'") or {"week": None}
        current_week = week_row.get("week")
        week_stats = state.db.fetchone(
            """SELECT COUNT(*) total, SUM(CASE WHEN status IN ('Respondida','Entregue') THEN 1 ELSE 0 END) completed
               FROM activities WHERE week=? AND status!='Arquivada'""",
            (current_week,),
        ) if current_week is not None else {"total": 0, "completed": 0}
        return {"stats": stats, "recent": recent, "current_week": current_week, "week_stats": week_stats, "mural_enabled": bool(state.settings.get("mural_enabled"))}

    @app.post("/api/email/preview")
    def email_preview(payload: EmailPreviewIn):
        contact = state.db.fetchone("SELECT * FROM contacts WHERE id=?", (payload.contact_id,))
        if not contact:
            raise HTTPException(404, "Contato não encontrado.")
        activities = [_activity_full(state, aid) for aid in payload.activity_ids]
        activities = [a for a in activities if a]
        if not activities:
            raise HTTPException(400, "Nenhuma atividade válida selecionada.")
        profile = get_profile()
        subject, body = build_default_message(profile, contact, activities)
        signature = state.settings.get("email_signature", "").strip()
        if signature:
            body = f"{body}\n\n{signature}"
        return {"recipient": contact["email"], "recipient_name": contact["name"], "contact_type": contact["type"], "subject": subject, "body": body}

    @app.post("/api/email/send")
    def email_send(payload: EmailSendIn):
        contact = state.db.fetchone("SELECT * FROM contacts WHERE id=?", (payload.contact_id,))
        if not contact:
            raise HTTPException(404, "Contato não encontrado.")
        activities = [_activity_full(state, aid) for aid in payload.activity_ids]
        activities = [a for a in activities if a]
        attachments: list[Path] = []
        for activity in activities:
            answered = [f for f in activity["files"] if f.get("role") == "answered"]
            chosen = answered if answered else [f for f in activity["files"] if f.get("role") in {"original", "attachment"}]
            attachments.extend(Path(f["filepath"]) for f in chosen)
        result: dict[str, Any] = {}
        try:
            result = compose_system_email(
                contact.get("email", ""), payload.subject, payload.body, attachments, cache_dir=state.paths.cache
            )
            status, error = str(result.get("status") or "rascunho aberto"), ""
        except Exception as exc:
            status, error = "erro", str(exc)
        state.db.execute(
            "INSERT INTO email_history(recipient,recipient_name,contact_type,subject,status,activity_ids,error,created_at) VALUES (?,?,?,?,?,?,?,?)",
            (contact.get("email", ""), contact.get("name", ""), contact.get("type", ""), payload.subject, status, ",".join(map(str, payload.activity_ids)), error, utcnow()),
        )
        if status == "erro":
            raise HTTPException(502, error)
        return {"ok": True, "status": status, **result}

    @app.get("/api/email/history")
    def email_history():
        return state.db.fetchall("SELECT * FROM email_history ORDER BY created_at DESC LIMIT 250")

    @app.get("/api/devices")
    def devices():
        return state.db.fetchall("SELECT * FROM devices ORDER BY trusted DESC,last_seen DESC")

    @app.patch("/api/devices/{device_uuid}/trust")
    def trust_device(device_uuid: str, payload: dict[str, Any]):
        state.db.execute("UPDATE devices SET trusted=? WHERE uuid=?", (int(bool(payload.get("trusted"))), device_uuid))
        return state.db.fetchone("SELECT * FROM devices WHERE uuid=?", (device_uuid,))

    @app.get("/api/mural")
    def mural(subject: str | None = None, week: int | None = None, author: str | None = None, contains_answers: bool | None = None, q: str | None = None):
        where = ["1=1"]
        params: list[Any] = []
        if subject:
            where.append("subject=?"); params.append(subject)
        if week is not None:
            where.append("week=?"); params.append(week)
        if author:
            where.append("author LIKE ?"); params.append(f"%{author}%")
        if contains_answers is not None:
            where.append("contains_answers=?"); params.append(int(contains_answers))
        if q:
            where.append("(title LIKE ? OR description LIKE ? OR subject LIKE ? OR author LIKE ?)")
            params.extend([f"%{q}%"] * 4)
        return state.db.fetchall(f"SELECT * FROM wall_posts WHERE {' AND '.join(where)} ORDER BY created_at DESC LIMIT 300", params)

    @app.get("/api/mural/{post_id}/file")
    def mural_file(post_id: int):
        row = state.db.fetchone("SELECT file_path,file_name FROM wall_posts WHERE id=?", (post_id,))
        if not row or not row.get("file_path"):
            raise HTTPException(404, "Esta publicação não possui arquivo.")
        path = Path(row["file_path"]).resolve()
        attachments_root = state.paths.attachments.resolve()
        if not path.is_relative_to(attachments_root):
            raise HTTPException(403, "Arquivo fora da área controlada do Reposit+.")
        if not path.exists() or not path.is_file():
            raise HTTPException(404, "Arquivo físico não encontrado.")
        return FileResponse(path, filename=row.get("file_name") or path.name, media_type=file_mime(path.name))

    @app.delete("/api/mural/{post_id}")
    def delete_mural_post(post_id: int):
        """Remove somente a publicação; anexos/notas originais permanecem intactos."""
        row = state.db.fetchone("SELECT id FROM wall_posts WHERE id=?", (post_id,))
        if not row:
            raise HTTPException(404, "Publicação do mural não encontrada.")
        state.db.execute("DELETE FROM wall_posts WHERE id=?", (post_id,))
        return {"ok": True, "id": post_id}

    @app.post("/api/mural", status_code=201)
    def publish_mural(payload: MuralPostIn, background: BackgroundTasks):
        file_path: Path | None = None
        file_name = ""
        author = (get_profile().get("name") or state.identity.get("device_name") or "Reposit+")
        if payload.activity_id:
            activity = _activity_full(state, payload.activity_id)
            if not activity:
                raise HTTPException(404, "Atividade não encontrada.")
            preferred = [f for f in activity["files"] if f.get("role") == ("answered" if payload.contains_answers else "original")]
            if not preferred:
                preferred = activity["files"][:1]
            if preferred:
                file_path = Path(preferred[0]["filepath"])
                file_name = preferred[0]["filename"]
        post_id = state.db.execute(
            "INSERT INTO wall_posts(activity_id,title,subject,week,description,author,author_device,contains_answers,file_path,file_name,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (payload.activity_id, payload.title, payload.subject, payload.week, payload.description, author, state.identity["device_uuid"], int(payload.contains_answers), str(file_path or ""), file_name, utcnow()),
        )
        post = state.db.fetchone("SELECT * FROM wall_posts WHERE id=?", (post_id,))
        if payload.distribute and state.settings.get("mural_enabled"):
            peers = devices()
            for peer in peers:
                background.add_task(_send_post_to_peer, state, peer, post, file_path)
        return post

    @app.post("/api/devices/share")
    def share_direct(payload: DirectShareIn, background: BackgroundTasks):
        peer = state.db.fetchone("SELECT * FROM devices WHERE uuid=?", (payload.device_uuid,))
        activity = _activity_full(state, payload.activity_id)
        if not peer or not activity:
            raise HTTPException(404, "Dispositivo ou atividade não encontrado.")
        preferred_role = "answered" if payload.contains_answers else "original"
        preferred = [f for f in activity["files"] if f.get("role") == preferred_role] or activity["files"][:1]
        file_path = Path(preferred[0]["filepath"]) if preferred else None
        metadata = {
            "title": activity["title"], "subject": activity.get("subject", ""), "week": activity.get("week"),
            "description": activity.get("description", ""), "contains_answers": payload.contains_answers,
            "author": get_profile().get("name") or state.identity.get("device_name"),
        }
        background.add_task(_send_share_safe, peer, state, metadata, file_path)
        return {"ok": True, "queued": True}

    @app.get("/api/mural/pending")
    def pending_shares():
        return state.db.fetchall("SELECT * FROM pending_shares WHERE status='pending' ORDER BY created_at DESC")

    @app.post("/api/mural/pending/{pending_id}/accept")
    async def accept_pending(pending_id: int, trust: bool = False):
        row = state.db.fetchone("SELECT * FROM pending_shares WHERE id=? AND status='pending'", (pending_id,))
        if not row:
            raise HTTPException(404, "Compartilhamento pendente não encontrado.")
        final_path = ""
        if row.get("temp_path"):
            source = Path(row["temp_path"])
            if source.exists():
                dest = state.paths.received / sanitize_filename(row.get("file_name") or source.name)
                counter = 2
                base = dest
                while dest.exists():
                    dest = base.with_name(f"{base.stem} ({counter}){base.suffix}"); counter += 1
                shutil.move(str(source), str(dest))
                final_path = str(dest)
        pid = state.db.execute(
            "INSERT INTO wall_posts(activity_id,title,subject,week,description,author,author_device,contains_answers,file_path,file_name,created_at) VALUES (NULL,?,?,?,?,?,?,?,?,?,?)",
            (row["title"], row["subject"], row["week"], row["description"], row["sender_name"], row["sender_uuid"], row["contains_answers"], final_path, row["file_name"], utcnow()),
        )
        state.db.execute("UPDATE pending_shares SET status='accepted' WHERE id=?", (pending_id,))
        if trust:
            state.db.execute("UPDATE devices SET trusted=1 WHERE uuid=?", (row["sender_uuid"],))
        post = state.db.fetchone("SELECT * FROM wall_posts WHERE id=?", (pid,))
        return post

    @app.post("/api/mural/pending/{pending_id}/reject")
    def reject_pending(pending_id: int):
        row = state.db.fetchone("SELECT * FROM pending_shares WHERE id=? AND status='pending'", (pending_id,))
        if not row:
            raise HTTPException(404, "Compartilhamento pendente não encontrado.")
        if row.get("temp_path"):
            safe_unlink(row["temp_path"], state.paths.pending)
        state.db.execute("UPDATE pending_shares SET status='rejected' WHERE id=?", (pending_id,))
        return {"ok": True}

    @app.post("/p2p/share")
    async def p2p_receive(request: Request, metadata: str = Form(...), file: UploadFile | None = File(None)):
        if not state.settings.get("mural_enabled"):
            raise HTTPException(403, "Mural Local está desligado.")
        try:
            meta = json.loads(metadata)
        except json.JSONDecodeError as exc:
            raise HTTPException(400, "Metadados inválidos.") from exc
        sender_uuid = str(meta.get("sender_uuid") or "")[:80]
        if not sender_uuid or sender_uuid == state.identity.get("device_uuid"):
            raise HTTPException(400, "Origem inválida.")
        sender_name = str(meta.get("sender_name") or "Dispositivo Reposit+")[:120]
        sender_ip = request.client.host if request.client else ""
        pending_count = state.db.fetchone("SELECT COUNT(*) AS n FROM pending_shares WHERE status='pending'") or {"n": 0}
        if int(pending_count.get("n") or 0) >= 50:
            raise HTTPException(429, "Limite de compartilhamentos pendentes atingido.")
        pending_bytes = sum(p.stat().st_size for p in state.paths.pending.rglob("*") if p.is_file())
        pending_quota = 500 * 1024 * 1024
        if pending_bytes >= pending_quota:
            raise HTTPException(507, "Área de recebimentos pendentes atingiu 500 MB.")
        sender_port = int(meta.get("sender_port") or 0)
        existing = state.db.fetchone("SELECT * FROM devices WHERE uuid=?", (sender_uuid,))
        trusted = bool(existing and existing.get("trusted") and existing.get("ip") == sender_ip)
        if existing:
            state.db.execute("UPDATE devices SET name=?,ip=?,port=?,last_seen=? WHERE uuid=?", (sender_name, sender_ip, sender_port, utcnow(), sender_uuid))
        else:
            state.db.execute("INSERT INTO devices(uuid,name,ip,port,version,trusted,last_seen) VALUES (?,?,?,?,?,0,?)", (sender_uuid, sender_name, sender_ip, sender_port, str(meta.get("version") or ""), utcnow()))

        temp_path = ""; file_name = ""
        if file:
            try:
                remaining = max(1, pending_quota - pending_bytes)
                saved, _, _ = save_stream_to_controlled_path(
                    file.file, state.paths.pending, file.filename or "arquivo", max_size=min(MAX_FILE_SIZE, remaining)
                )
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
            temp_path, file_name = str(saved), saved.name

        auto_accept = trusted and bool(state.settings.get("auto_accept_trusted", True))
        if auto_accept:
            final_path = ""
            if temp_path:
                source = Path(temp_path)
                dest = state.paths.received / source.name
                i = 2
                base = dest
                while dest.exists():
                    dest = base.with_name(f"{base.stem} ({i}){base.suffix}"); i += 1
                shutil.move(str(source), str(dest)); final_path = str(dest)
            post_id = state.db.execute(
                "INSERT INTO wall_posts(activity_id,title,subject,week,description,author,author_device,contains_answers,file_path,file_name,created_at) VALUES (NULL,?,?,?,?,?,?,?,?,?,?)",
                (str(meta.get("title") or "Compartilhamento")[:220], str(meta.get("subject") or "")[:120], _int_or_none(meta.get("week")), str(meta.get("description") or "")[:4000], str(meta.get("author") or sender_name)[:120], sender_uuid, int(bool(meta.get("contains_answers"))), final_path, file_name, utcnow()),
            )
            post = state.db.fetchone("SELECT * FROM wall_posts WHERE id=?", (post_id,)) or {}
            return {"ok": True, "accepted": True, "post_id": post_id}

        pending_id = state.db.execute(
            "INSERT INTO pending_shares(sender_uuid,sender_name,sender_ip,title,subject,week,description,contains_answers,temp_path,file_name,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?)",
            (sender_uuid, sender_name, sender_ip, str(meta.get("title") or "Compartilhamento")[:220], str(meta.get("subject") or "")[:120], _int_or_none(meta.get("week")), str(meta.get("description") or "")[:4000], int(bool(meta.get("contains_answers"))), temp_path, file_name, utcnow()),
        )
        return JSONResponse(status_code=202, content={"ok": True, "accepted": False, "pending_id": pending_id})

    @app.post("/api/backup/export")
    def backup_export(payload: dict[str, Any] | None = None):
        state.db.checkpoint()
        profile = get_profile()
        safe_name = sanitize_filename((profile.get("name") or "RepositPlus").replace(" ", "_"))
        output = state.paths.cache / f"{safe_name}.reposit"
        path = export_reposit(state.paths, output, bool((payload or {}).get("include_attachments", True)))
        return FileResponse(path, filename=path.name, media_type="application/octet-stream")

    @app.post("/api/backup/import")
    async def backup_import(file: UploadFile = File(...)):
        if not (file.filename or "").lower().endswith(".reposit"):
            raise HTTPException(400, "Selecione um arquivo .reposit.")
        with tempfile.NamedTemporaryFile(delete=False, suffix=".reposit") as tmp:
            while chunk := await file.read(1024 * 1024):
                tmp.write(chunk)
            temp_path = Path(tmp.name)
        try:
            manifest = import_reposit(state.paths, temp_path)
            state.db.migrate()
        except Exception as exc:
            raise HTTPException(400, str(exc)) from exc
        finally:
            temp_path.unlink(missing_ok=True)
        return {"ok": True, "manifest": manifest, "message": "Backup importado. Reinicie o Reposit+ para recarregar todas as configurações."}

    return app



def _note_plain_text(note: dict[str, Any]) -> str:
    content = str(note.get("content") or "")
    if note.get("content_format") == "html":
        content = re.sub(r"<br\s*/?>", "\n", content, flags=re.I)
        content = re.sub(r"</(?:p|div|li|h[1-6]|blockquote|tr)>", "\n", content, flags=re.I)
        content = re.sub(r"<[^>]+>", "", content)
        content = html.unescape(content)
    content = re.sub(r"\[\[reposit-(?:file|subnote):\d+(?:;[^\]]+)?\]\]", "", content)
    return re.sub(r"\n{3,}", "\n\n", content).strip()

def _note_full(state: AppState, note_id: int) -> dict[str, Any] | None:
    note = state.db.fetchone("SELECT * FROM notes WHERE id=?", (note_id,))
    if not note:
        return None
    note["files"] = state.db.fetchall("SELECT * FROM note_files WHERE note_id=? ORDER BY created_at", (note_id,))
    note["subnotes"] = state.db.fetchall("SELECT id,title,kind,tags,pinned,parent_note_id,updated_at FROM notes WHERE parent_note_id=? ORDER BY updated_at DESC", (note_id,))
    parent_id = note.get("parent_note_id")
    note["parent_note"] = state.db.fetchone(
        "SELECT id,title,kind,parent_note_id,updated_at FROM notes WHERE id=?", (parent_id,)
    ) if parent_id else None
    return note


def _rebuild_note_fts(db: Database, note_id: int) -> None:
    row = db.fetchone("SELECT id,title,kind,content,tags,content_format FROM notes WHERE id=?", (note_id,))
    db.execute("DELETE FROM note_fts WHERE note_id=?", (note_id,))
    if row:
        content = row["content"] or ""
        if row.get("content_format") == "html":
            content = re.sub(r"<[^>]+>", " ", content)
            content = re.sub(r"\[\[reposit-(?:file|subnote):\d+(?:;[^\]]+)?\]\]", " ", content)
        db.execute("INSERT INTO note_fts(note_id,title,kind,content,tags) VALUES (?,?,?,?,?)", (row["id"], row["title"], row["kind"], content, row["tags"]))


def _split_note_tags(raw: str) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for part in re.split(r"[,;\n]+", raw or ""):
        tag_name = part.strip().lstrip("#")[:80]
        key = tag_name.casefold()
        if tag_name and key not in seen:
            seen.add(key); result.append(tag_name)
    return result


def _ensure_named(db: Database, table: str, name: str) -> int | None:
    name = (name or "").strip()
    if not name:
        return None
    if table not in {"subjects"}:
        raise ValueError("Tabela não permitida")
    row = db.fetchone(f"SELECT id FROM {table} WHERE name=? COLLATE NOCASE", (name,))
    if row:
        return int(row["id"])
    return db.execute(f"INSERT INTO {table}(name) VALUES (?)", (name,))


def _ensure_teacher(db: Database, name: str) -> int | None:
    name = (name or "").strip()
    if not name:
        return None
    row = db.fetchone("SELECT id FROM teachers WHERE name=? COLLATE NOCASE", (name,))
    if row:
        return int(row["id"])
    return db.execute("INSERT INTO teachers(name,email) VALUES (?, '')", (name,))


def _set_tags(db: Database, activity_id: int, tags: list[str]) -> None:
    db.execute("DELETE FROM activity_tags WHERE activity_id=?", (activity_id,))
    for raw in tags:
        name = raw.strip().lstrip("#")[:80]
        if not name:
            continue
        row = db.fetchone("SELECT id FROM tags WHERE name=? COLLATE NOCASE", (name,))
        tid = int(row["id"]) if row else db.execute("INSERT INTO tags(name) VALUES (?)", (name,))
        db.execute("INSERT OR IGNORE INTO activity_tags(activity_id,tag_id) VALUES (?,?)", (activity_id, tid))


def _insert_activity(state: AppState, payload: ActivityIn) -> int:
    subject_id = _ensure_named(state.db, "subjects", payload.subject)
    teacher_id = _ensure_teacher(state.db, payload.teacher)
    now = utcnow()
    aid = state.db.execute(
        """INSERT INTO activities(title,description,subject_id,repository_id,teacher_id,week,bimester,activity_date,status,notes,origin,pinned,completed_at,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (payload.title.strip(), payload.description, subject_id, payload.repository_id, teacher_id, payload.week, payload.bimester, payload.activity_date, payload.status, payload.notes, payload.origin, int(payload.pinned), now if payload.status in {"Respondida","Entregue","Concluída"} else "", now, now),
    )
    _set_tags(state.db, aid, payload.tags)
    state.db.log_activity(aid, "criada")
    state.db.rebuild_activity_fts(aid)
    return aid


def _activity_full(state: AppState, aid: int) -> dict[str, Any] | None:
    activity = state.db.fetchone(
        """SELECT a.*,COALESCE(s.name,'') subject,COALESCE(r.name,'') repository,COALESCE(t.name,'') teacher
           FROM activities a LEFT JOIN subjects s ON s.id=a.subject_id LEFT JOIN repositories r ON r.id=a.repository_id LEFT JOIN teachers t ON t.id=a.teacher_id
           WHERE a.id=?""",
        (aid,),
    )
    if not activity:
        return None
    activity["tags"] = [r["name"] for r in state.db.fetchall("SELECT t.name FROM tags t JOIN activity_tags at ON at.tag_id=t.id WHERE at.activity_id=? ORDER BY t.name", (aid,))]
    activity["files"] = state.db.fetchall("SELECT * FROM files WHERE activity_id=? ORDER BY created_at", (aid,))
    activity["history"] = state.db.fetchall("SELECT * FROM activity_history WHERE activity_id=? ORDER BY created_at DESC LIMIT 100", (aid,))
    return activity


def _send_post_to_peer(state: AppState, peer: dict[str, Any], post: dict[str, Any], file_path: Path | None) -> None:
    metadata = {
        "title": post.get("title"), "subject": post.get("subject"), "week": post.get("week"),
        "description": post.get("description"), "contains_answers": bool(post.get("contains_answers")),
        "author": post.get("author"), "version": APP_VERSION,
    }
    _send_share_safe(peer, state, metadata, file_path)


def _send_share_safe(peer: dict[str, Any], state: AppState, metadata: dict[str, Any], file_path: Path | None) -> None:
    try:
        sender = dict(state.identity)
        sender["port"] = state.http_port
        send_share(peer, sender, metadata, file_path)
    except Exception as exc:
        log.warning("Falha ao compartilhar com %s: %s", peer.get("name"), exc)


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None
