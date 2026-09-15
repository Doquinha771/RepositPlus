from __future__ import annotations

import html
import json
import logging
import re
import secrets
import tempfile
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .backups import create_automatic_backup, export_reposit, import_reposit
from .config import APP_NAME, APP_RELEASE_LABEL, APP_VERSION, DEFAULT_SETTINGS, AppPaths, save_settings
from .database import CURRENT_SCHEMA_VERSION, Database, utcnow
from .file_service import file_mime, safe_unlink, save_stream_to_controlled_path
from .parser import parse_school_filename
from .search import search_activities
from .maintenance import attachment_diagnostics, clear_disposable_cache, storage_report
from .diagnostics import diagnostics_report, diagnostics_text
from .productivity import import_note_file, parse_note_search, sanitize_import_html, search_sql

NOTE_CONTENT_LIMIT = 120000



class RepositoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=1000)


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
    tags: list[str] = Field(default_factory=list)
    origin: str = "manual"
    pinned: bool = False






class NoteIn(BaseModel):
    title: str = Field(default="", max_length=220)
    kind: str = Field(default="Anotação", max_length=80)
    content: str = Field(default="", max_length=NOTE_CONTENT_LIMIT)
    tags: str = Field(default="", max_length=1000)
    pinned: bool = False
    content_format: str = Field(default="plain", max_length=20)
    parent_note_id: int | None = None




class AppState:
    def __init__(self, paths: AppPaths, db: Database, settings: dict[str, Any], identity: dict[str, Any], http_port: int, distribution: str = "source"):
        self.paths = paths
        self.db = db
        self.settings = settings
        self.identity = identity
        self.http_port = http_port
        self.distribution = distribution
        self.api_token = secrets.token_urlsafe(32)


def create_app(state: AppState) -> FastAPI:
    app = FastAPI(title=APP_NAME, version=APP_VERSION)
    app.state.reposit = state

    @app.exception_handler(Exception)
    async def global_exception_handler(request: Request, exc: Exception):
        logging.getLogger("reposit.api").exception("Erro inesperado em %s %s", request.method, request.url.path)
        return JSONResponse(status_code=500, content={"detail": "O Reposit+ encontrou um erro nesta operação."})

    @app.middleware("http")
    async def local_api_guard(request: Request, call_next):
        host = request.client.host if request.client else ""
        local_hosts = {"127.0.0.1", "::1", "localhost", "testclient"}
        if host not in local_hosts:
            return JSONResponse(status_code=403, content={"detail": "Rota disponível apenas localmente."})
        # Reject DNS-rebinding style Host headers even when the TCP peer is
        # loopback.  pywebview uses 127.0.0.1/localhost; tests use testserver.
        request_host = (request.url.hostname or "").casefold()
        if request_host not in {"127.0.0.1", "::1", "localhost", "testserver"}:
            return JSONResponse(status_code=403, content={"detail": "Host local inválido."})
        # A custom per-run token makes state-changing local endpoints resistant
        # to CSRF from arbitrary websites. TestClient remains exempt so the
        # regression suite can exercise API behavior without impersonating the UI.
        if host != "testclient" and request.url.path.startswith("/api/") and request.method.upper() in {"POST", "PATCH", "PUT", "DELETE"}:
            if request.headers.get("x-reposit-token") != state.api_token:
                return JSONResponse(status_code=403, content={"detail": "Sessão local inválida."})
        return await call_next(request)

    app.mount("/static", StaticFiles(directory=state.paths.frontend), name="static")

    @app.get("/")
    async def frontend_index():
        return FileResponse(state.paths.frontend / "index.html")

    @app.get("/quick")
    async def quick_index():
        return FileResponse(state.paths.frontend / "quick" / "index.html")

    @app.get("/api/health")
    def health():
        return {"ok": True, "name": APP_NAME, "version": APP_VERSION, "device_uuid": state.identity["device_uuid"]}

    @app.get("/api/app-info")
    def app_info():
        labels = {"installed": "Setup", "portable": "Portable", "source": "Código-fonte"}
        return {
            "name": APP_NAME,
            "version": APP_VERSION,
            "release_label": APP_RELEASE_LABEL,
            "distribution": state.distribution,
            "distribution_label": labels.get(state.distribution, state.distribution),
            "data_path": str(state.paths.root),
            "note_content_limit": NOTE_CONTENT_LIMIT,
            "schema_version": CURRENT_SCHEMA_VERSION,
            "migration_backup": state.db.last_migration_backup,
            "database_recovery": state.db.last_recovery,
            "safe_mode": bool(getattr(state, "safe_mode", False)),
            "startup_health": getattr(state, "startup_health", None) or state.db.startup_health_check(),
            "compatibility_metadata": state.db.get_metadata(),
            "api_token": state.api_token,
        }

    @app.get("/api/storage")
    def storage_info(details: bool = True):
        report = storage_report(state.paths)
        warning_at = int(state.settings.get("db_warning_bytes") or 1073741824)
        report.update({
            "warning_at": warning_at,
            "database_warning": report["database"] >= warning_at,
            "details": bool(details),
        })
        if not details:
            report["attachments"] = 0
            report["cache"] = 0
            report["backups"] = 0
            report["total"] = report["database"]
        return report

    @app.post("/api/storage/maintenance")
    def storage_maintenance(payload: dict[str, Any] | None = None):
        result = state.db.maintenance(force=bool((payload or {}).get("force")))
        result["storage"] = storage_info()
        return result

    @app.get("/api/storage/integrity")
    def storage_integrity():
        return state.db.integrity_check()

    @app.get("/api/storage/attachments/diagnose")
    def diagnose_attachments():
        return attachment_diagnostics(state.db, state.paths)

    @app.post("/api/storage/cache/clear")
    def clear_cache():
        result = clear_disposable_cache(state.paths)
        result["storage"] = storage_info()
        return result

    @app.get("/api/diagnostics")
    def diagnostics():
        result = diagnostics_report(state.db, state.paths)
        result["text"] = diagnostics_text(result)
        return result

    @app.post("/api/backup/automatic")
    def automatic_backup():
        created = create_automatic_backup(state.paths, keep=5, include_attachments=True)
        return {"ok": True, "path": str(created), "storage": storage_info()}

    @app.get("/api/settings")
    def get_settings():
        public = json.loads(json.dumps(state.settings))
        public.pop("last_db_maintenance", None)
        public["device_uuid"] = state.identity.get("device_uuid")
        public["device_name"] = state.identity.get("device_name")
        return public

    @app.patch("/api/settings")
    def patch_settings(payload: dict[str, Any]):
        def merge(base: dict[str, Any], incoming: dict[str, Any]):
            for k, v in incoming.items():
                if k not in DEFAULT_SETTINGS or k == "last_db_maintenance":
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

    @app.get("/api/notes")
    def list_notes(
        q: str | None = None, kind: str | None = None, tag: str | None = None,
        include_children: bool = False, limit: int = 200, offset: int = 0,
        view: str = "active", sort: str = "updated", favorite: bool | None = None,
    ):
        limit = min(max(int(limit), 1), 200)
        offset = max(int(offset), 0)
        params: list[Any] = []
        where: list[str] = ["1=1"]
        if view == "trash": where.append("n.trashed_at!=''")
        else: where.append("n.trashed_at=''")
        if not include_children: where.append("n.parent_note_id IS NULL")
        if kind: where.append("n.kind=?"); params.append(kind)
        if tag:
            where.append("(',' || REPLACE(n.tags,' ', '') || ',') LIKE ?")
            params.append(f"%,{tag.strip().replace(' ', '')},%")
        if favorite is not None: where.append("n.favorite=?"); params.append(int(bool(favorite)))
        query = (q or "").strip()
        if query:
            parsed = parse_note_search(query)
            advanced_where, advanced_params, _ = search_sql(parsed, include_trashed=(view == "trash"))
            # search_sql already adds the trash predicate, so replace our base one.
            where = [x for x in where if "trashed_at" not in x]
            where.append(f"({advanced_where})")
            params.extend(advanced_params)
        order_map = {
            "name": "n.pinned DESC,n.favorite DESC,n.title COLLATE NOCASE ASC,n.id ASC",
            "created": "n.pinned DESC,n.favorite DESC,n.created_at DESC,n.id DESC",
            "manual": "n.pinned DESC,n.favorite DESC,n.manual_order ASC,n.id ASC",
            "recent": "n.last_opened_at DESC,n.updated_at DESC",
            "updated": "n.pinned DESC,n.favorite DESC,n.updated_at DESC,n.id DESC",
        }
        order = order_map.get(sort, order_map["updated"])
        rows = state.db.fetchall(
            f"""SELECT n.id,n.title,n.kind,n.tags,n.pinned,n.favorite,n.trashed_at,n.manual_order,n.last_opened_at,n.content_format,n.parent_note_id,n.edit_revision,n.created_at,n.updated_at,
                       substr(n.content,1,420) content,
                       (SELECT title FROM notes p WHERE p.id=n.parent_note_id) parent_title,
                       (SELECT COUNT(*) FROM note_files nf WHERE nf.note_id=n.id AND nf.state!='pending_delete') file_count,
                       (SELECT COUNT(*) FROM notes c WHERE c.parent_note_id=n.id AND c.trashed_at='') subnote_count
                FROM notes n WHERE {' AND '.join(where)}
                ORDER BY {order} LIMIT ? OFFSET ?""",
            [*params, limit, offset],
        )
        return rows

    @app.get("/api/notes/search")
    def search_notes(
        q: str = Query(min_length=1, max_length=300), limit: int = 50, offset: int = 0,
        view: str = "active", favorite: bool | None = None, period: str = "",
    ):
        limit=min(max(int(limit),1),100);offset=max(int(offset),0)
        parsed=parse_note_search(q)
        free_text=str(parsed.get("text") or "").strip()
        filtered=dict(parsed); filtered["text"]=""
        where,params,_=search_sql(filtered,include_trashed=(view=="trash"))
        if favorite is not None:
            where += " AND n.favorite=?"; params.append(int(bool(favorite)))
        period = str(period or "").strip().lower()
        if period == "today":
            where += " AND date(n.updated_at,'localtime')=date('now','localtime')"
        elif period == "week":
            where += " AND datetime(n.updated_at)>=datetime('now','-7 days')"
        terms=[t.replace('"','') for t in re.findall(r"[\wÀ-ÿ]+",free_text,re.UNICODE) if t][:8]
        if terms:
            fts=" AND ".join(f'"{term}"*' for term in terms)
            rows=state.db.fetchall(
                f"""WITH matched AS (
                        SELECT CAST(note_id AS INTEGER) id,snippet(note_fts,3,'','', ' … ',18) snippet,bm25(note_fts) rank
                          FROM note_fts WHERE note_fts MATCH ?
                    )
                    SELECT n.id,n.title,n.kind,n.tags,n.parent_note_id,n.updated_at,n.created_at,n.favorite,n.pinned,n.trashed_at,
                           CASE WHEN n.parent_note_id IS NULL THEN 0 ELSE 1 END is_subnote,
                           COALESCE((SELECT title FROM notes p WHERE p.id=n.parent_note_id),'') parent_title,
                           (SELECT COUNT(*) FROM note_files nf WHERE nf.note_id=n.id AND nf.state!='pending_delete') file_count,
                           EXISTS(SELECT 1 FROM note_files nf WHERE nf.note_id=n.id AND nf.state!='pending_delete' AND nf.file_type LIKE 'image/%') has_image,
                           matched.snippet snippet
                      FROM matched JOIN notes n ON n.id=matched.id
                     WHERE {where}
                     ORDER BY {"n.last_opened_at DESC,n.updated_at DESC" if period == "recent" else "matched.rank,n.favorite DESC,n.pinned DESC,n.updated_at DESC"} LIMIT ? OFFSET ?""",
                [fts,*params,limit+1,offset],
            )
        else:
            rows=state.db.fetchall(
                f"""SELECT n.id,n.title,n.kind,n.tags,n.parent_note_id,n.updated_at,n.created_at,n.favorite,n.pinned,n.trashed_at,
                           CASE WHEN n.parent_note_id IS NULL THEN 0 ELSE 1 END is_subnote,
                           COALESCE((SELECT title FROM notes p WHERE p.id=n.parent_note_id),'') parent_title,
                           (SELECT COUNT(*) FROM note_files nf WHERE nf.note_id=n.id AND nf.state!='pending_delete') file_count,
                           EXISTS(SELECT 1 FROM note_files nf WHERE nf.note_id=n.id AND nf.state!='pending_delete' AND nf.file_type LIKE 'image/%') has_image,
                           substr(n.content,1,240) snippet
                      FROM notes n WHERE {where}
                     ORDER BY {"n.last_opened_at DESC,n.updated_at DESC" if period == "recent" else "n.favorite DESC,n.pinned DESC,n.updated_at DESC"} LIMIT ? OFFSET ?""",
                [*params,limit+1,offset],
            )
        more=len(rows)>limit;items=rows[:limit]
        return {"items":items,"offset":offset,"limit":limit,"has_more":more,"next_offset":offset+len(items) if more else None,"parsed":parsed}

    @app.post("/api/notes/meta")
    def notes_metadata(payload: dict[str, Any]):
        ids=[]
        for raw in payload.get("ids",[]):
            try:
                value=int(raw)
            except (TypeError,ValueError):
                continue
            if value>0 and value not in ids:ids.append(value)
            if len(ids)>=100:break
        if not ids:return []
        placeholders=','.join('?' for _ in ids)
        rows=state.db.fetchall(
            f"SELECT id,title,kind,parent_note_id,updated_at,(SELECT title FROM notes p WHERE p.id=n.parent_note_id) parent_title FROM notes n WHERE id IN ({placeholders})", ids
        )
        by_id={int(r['id']):r for r in rows}
        return [by_id[i] for i in ids if i in by_id]

    @app.get("/api/note-tags")
    def list_note_tags():
        counts: dict[str, int] = {}
        display: dict[str, str] = {}
        for row in state.db.fetchall("SELECT tags FROM notes WHERE tags!='' AND trashed_at=''"):
            for tag_name in _split_note_tags(row.get("tags") or ""):
                key = tag_name.casefold()
                counts[key] = counts.get(key, 0) + 1
                display.setdefault(key, tag_name)
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
        allowed = {"title", "kind", "content", "tags", "pinned", "favorite", "manual_order", "content_format", "parent_note_id"}
        updates = {k: payload[k] for k in allowed if k in payload}
        raw_revision = payload.get("save_revision", None)
        save_revision: int | None = None
        if raw_revision is not None:
            try:
                save_revision = max(0, int(raw_revision))
            except (TypeError, ValueError):
                raise HTTPException(400, "Revisão de salvamento inválida.")

        with state.db.session() as conn:
            # Revisioned editor saves are serialized at the SQLite write boundary.
            # Without this, two DEFERRED transactions can both read the same
            # edit_revision and make the newer request fail spuriously after the
            # older one commits. BEGIN IMMEDIATE makes the read/compare/update a
            # single ordered critical section while keeping non-editor PATCHes
            # on the normal lightweight path.
            if save_revision is not None:
                conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT id,edit_revision FROM notes WHERE id=?", (note_id,)).fetchone()
            if not row:
                raise HTTPException(404, "Anotação não encontrada.")
            current_revision = int(row["edit_revision"] or 0)

            # A repeated request for a revision that already committed is idempotent.
            # A genuinely older revision is rejected, so a delayed PATCH can never
            # overwrite newer editor content.
            if save_revision is not None:
                if save_revision < current_revision:
                    raise HTTPException(409, detail={
                        "message": "Uma revisão mais nova desta anotação já foi salva.",
                        "current_revision": current_revision,
                    })
                if save_revision == current_revision:
                    return _note_full(state, note_id)

            if updates:
                if any(k in updates for k in {"title","kind","content","tags"}):
                    _snapshot_note_conn(conn, note_id, reason="autosave" if save_revision is not None else "edit")
                normalized: dict[str, Any] = {}
                for k, v in updates.items():
                    if k in {"pinned","favorite"}: normalized[k] = int(bool(v))
                    elif k == "manual_order": normalized[k] = float(v or 0)
                    elif k == "parent_note_id": normalized[k] = int(v) if v not in (None, "") else None
                    elif k == "content_format": normalized[k] = "html" if str(v) == "html" else "plain"
                    elif k == "content":
                        value = str(v)
                        if len(value) > NOTE_CONTENT_LIMIT:
                            raise HTTPException(413, detail={
                                "message": "A anotação ultrapassou o limite de conteúdo.",
                                "limit": NOTE_CONTENT_LIMIT,
                                "current": len(value),
                            })
                        normalized[k] = value
                    else: normalized[k] = str(v)[:50000]
                normalized["updated_at"] = utcnow()
                if save_revision is not None:
                    normalized["edit_revision"] = save_revision
                sets = ",".join(f"{k}=?" for k in normalized)
                params = [*normalized.values(), note_id]
                sql = f"UPDATE notes SET {sets} WHERE id=?"
                if save_revision is not None:
                    sql += " AND edit_revision=?"
                    params.append(current_revision)
                cur = conn.execute(sql, tuple(params))
                if save_revision is not None and cur.rowcount != 1:
                    latest = conn.execute("SELECT edit_revision FROM notes WHERE id=?", (note_id,)).fetchone()
                    latest_revision = int(latest["edit_revision"] or 0) if latest else current_revision
                    raise HTTPException(409, detail={
                        "message": "O conteúdo mudou enquanto esta revisão era salva.",
                        "current_revision": latest_revision,
                    })

        if updates:
            _rebuild_note_fts(state.db, note_id)
        return _note_full(state, note_id)

    @app.delete("/api/notes/{note_id}")
    def delete_note(note_id: int):
        physical_paths: list[str] = []
        parent_id: int | None = None
        with state.db.session() as conn:
            conn.execute("BEGIN IMMEDIATE")
            note = conn.execute("SELECT id,parent_note_id FROM notes WHERE id=?", (note_id,)).fetchone()
            if not note:
                raise HTTPException(404, "Anotação não encontrada.")
            parent_id = note["parent_note_id"]
            physical_paths = [str(r[0] or "") for r in conn.execute("SELECT filepath FROM note_files WHERE note_id=?", (note_id,)).fetchall()]
            if parent_id:
                parent = conn.execute("SELECT content FROM notes WHERE id=?", (parent_id,)).fetchone()
                if parent:
                    token = re.compile(rf"\[\[reposit-subnote:{int(note_id)}(?:;[^\]]+)?\]\]", re.I)
                    original = str(parent["content"] or "")
                    cleaned = token.sub("", original)
                    if cleaned != original:
                        conn.execute("UPDATE notes SET content=?,updated_at=? WHERE id=?", (cleaned, utcnow(), parent_id))
            conn.execute("UPDATE notes SET parent_note_id=NULL WHERE parent_note_id=?", (note_id,))
            conn.execute("DELETE FROM notes WHERE id=?", (note_id,))
            conn.execute("DELETE FROM note_fts WHERE note_id=?", (note_id,))
            if parent_id:
                parent = conn.execute("SELECT id,title,kind,content,tags,content_format FROM notes WHERE id=?", (parent_id,)).fetchone()
                if parent:
                    conn.execute("DELETE FROM note_fts WHERE note_id=?", (parent_id,))
                    text = re.sub(r"<[^>]+>", " ", str(parent["content"] or "")) if parent["content_format"] == "html" else str(parent["content"] or "")
                    text = re.sub(r"\[\[reposit-(?:file|subnote):\d+(?:;[^\]]+)?\]\]", " ", text)
                    conn.execute("INSERT INTO note_fts(note_id,title,kind,content,tags) VALUES (?,?,?,?,?)", (parent["id"], parent["title"], parent["kind"], text, parent["tags"]))
        for filepath in physical_paths:
            if filepath and not state.db.fetchone("SELECT id FROM note_files WHERE filepath=? LIMIT 1", (filepath,)):
                safe_unlink(filepath, state.paths.attachments)
        return {"ok": True, "parent_note_id": parent_id, "permanent": True}

    @app.post("/api/notes/{note_id}/opened")
    def mark_note_opened(note_id: int):
        if not state.db.fetchone("SELECT id FROM notes WHERE id=?", (note_id,)):
            raise HTTPException(404, "Anotação não encontrada.")
        now = utcnow()
        state.db.execute("UPDATE notes SET last_opened_at=? WHERE id=?", (now, note_id))
        return {"ok": True, "last_opened_at": now}

    @app.post("/api/notes/{note_id}/trash")
    def trash_note(note_id: int):
        note = state.db.fetchone("SELECT id,trashed_at,parent_note_id FROM notes WHERE id=?", (note_id,))
        if not note:
            raise HTTPException(404, "Anotação não encontrada.")
        stamp = str(note.get("trashed_at") or "") or utcnow()
        with state.db.session() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                """WITH RECURSIVE tree(id) AS (
                       SELECT id FROM notes WHERE id=?
                       UNION ALL SELECT n.id FROM notes n JOIN tree t ON n.parent_note_id=t.id
                   ) UPDATE notes SET trashed_at=? WHERE id IN (SELECT id FROM tree) AND trashed_at=''""",
                (note_id, stamp),
            )
        return {"ok": True, "id": note_id, "trashed_at": stamp, "parent_note_id": note.get("parent_note_id")}

    @app.post("/api/notes/{note_id}/restore")
    def restore_note(note_id: int):
        note = state.db.fetchone("SELECT id,trashed_at,parent_note_id,title FROM notes WHERE id=?", (note_id,))
        if not note:
            raise HTTPException(404, "Anotação não encontrada.")
        stamp = str(note.get("trashed_at") or "")
        if not stamp:
            return _note_full(state, note_id)
        detached = False
        with state.db.session() as conn:
            conn.execute("BEGIN IMMEDIATE")
            parent_id = note.get("parent_note_id")
            if parent_id:
                parent = conn.execute("SELECT id,trashed_at FROM notes WHERE id=?", (int(parent_id),)).fetchone()
                # A subnote restored without an available active parent becomes
                # a normal top-level note instead of remaining invisible behind
                # a broken relationship.
                if not parent or str(parent["trashed_at"] or ""):
                    conn.execute("UPDATE notes SET parent_note_id=NULL WHERE id=?", (note_id,))
                    detached = True
            conn.execute(
                """WITH RECURSIVE tree(id) AS (
                       SELECT id FROM notes WHERE id=?
                       UNION ALL SELECT n.id FROM notes n JOIN tree t ON n.parent_note_id=t.id
                   ) UPDATE notes SET trashed_at='' WHERE id IN (SELECT id FROM tree) AND trashed_at=?""",
                (note_id, stamp),
            )
        restored = _note_full(state, note_id)
        if restored is not None:
            restored["restore_detached_from_missing_parent"] = detached
        return restored

    @app.post("/api/trash/empty")
    def empty_trash():
        ids = [int(r["id"]) for r in state.db.fetchall("SELECT id FROM notes WHERE trashed_at!='' ORDER BY CASE WHEN parent_note_id IS NULL THEN 1 ELSE 0 END,id DESC")]
        deleted = 0
        for nid in ids:
            if state.db.fetchone("SELECT id FROM notes WHERE id=?", (nid,)):
                delete_note(nid); deleted += 1
        return {"ok": True, "deleted": deleted}

    @app.post("/api/notes/batch")
    def batch_notes(payload: dict[str, Any]):
        ids: list[int] = []
        for raw in payload.get("ids", []):
            try: value = int(raw)
            except (TypeError, ValueError): continue
            if value > 0 and value not in ids: ids.append(value)
            if len(ids) >= 200: break
        if not ids:
            return {"ok": True, "changed": 0}
        action = str(payload.get("action") or "").casefold()
        changed = 0
        if action == "trash":
            for nid in ids: trash_note(nid); changed += 1
        elif action in {"favorite", "pin"}:
            field = "favorite" if action == "favorite" else "pinned"
            value = int(bool(payload.get("value", True)))
            ph = ','.join('?' for _ in ids)
            with state.db.session() as conn:
                cur = conn.execute(f"UPDATE notes SET {field}=?,updated_at=? WHERE id IN ({ph})", (value, utcnow(), *ids)); changed = cur.rowcount
        elif action in {"add-tag", "remove-tag"}:
            tag = str(payload.get("tag") or "").strip().lstrip('#')[:80]
            if not tag: raise HTTPException(400, "Informe uma tag.")
            for nid in ids:
                row = state.db.fetchone("SELECT tags FROM notes WHERE id=?", (nid,))
                if not row: continue
                tags = _split_note_tags(row.get("tags") or "")
                if action == "add-tag" and tag.casefold() not in {x.casefold() for x in tags}: tags.append(tag)
                if action == "remove-tag": tags = [x for x in tags if x.casefold() != tag.casefold()]
                state.db.execute("UPDATE notes SET tags=?,updated_at=? WHERE id=?", (", ".join(tags), utcnow(), nid)); _rebuild_note_fts(state.db, nid); changed += 1
        else:
            raise HTTPException(400, "Ação em lote inválida.")
        return {"ok": True, "changed": changed}

    @app.post("/api/notes/reorder")
    def reorder_notes(payload: dict[str, Any]):
        ids = []
        for raw in payload.get("ids", []):
            try: ids.append(int(raw))
            except (TypeError, ValueError): pass
        with state.db.session() as conn:
            conn.execute("BEGIN IMMEDIATE")
            for index, nid in enumerate(ids[:10000]):
                conn.execute("UPDATE notes SET manual_order=? WHERE id=?", (float(index), nid))
        return {"ok": True, "changed": len(ids[:10000])}

    def _template_safe_content(value: str) -> str:
        # Templates preserve structure/formatting, never live attachment/subnote references.
        return re.sub(r"\[\[reposit-(?:file|subnote):\d+(?:;[^\]]+)?\]\]", "", str(value or ""), flags=re.I)[:NOTE_CONTENT_LIMIT]

    @app.get("/api/note-templates")
    def list_note_templates():
        return state.db.fetchall("SELECT * FROM note_templates ORDER BY builtin DESC,name COLLATE NOCASE")

    @app.post("/api/note-templates", status_code=201)
    def create_note_template(payload: dict[str, Any]):
        name = str(payload.get("name") or "").strip()[:100]
        if not name: raise HTTPException(400, "Informe um nome para o modelo.")
        now = utcnow()
        try:
            tid = state.db.execute(
                "INSERT INTO note_templates(name,kind,content,content_format,tags,builtin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
                (name, str(payload.get("kind") or "Anotação")[:80], _template_safe_content(payload.get("content") or ""), "html" if payload.get("content_format") == "html" else "plain", str(payload.get("tags") or "")[:1000], 0, now, now),
            )
        except Exception as exc:
            raise HTTPException(409, "Já existe um modelo com esse nome.") from exc
        return state.db.fetchone("SELECT * FROM note_templates WHERE id=?", (tid,))

    @app.delete("/api/note-templates/{template_id}")
    def delete_note_template(template_id: int):
        row = state.db.fetchone("SELECT builtin FROM note_templates WHERE id=?", (template_id,))
        if not row: raise HTTPException(404, "Modelo não encontrado.")
        if row.get("builtin"): raise HTTPException(409, "Modelos padrão não podem ser removidos.")
        state.db.execute("DELETE FROM note_templates WHERE id=?", (template_id,))
        return {"ok": True}

    @app.post("/api/note-templates/{template_id}/create", status_code=201)
    def create_note_from_template(template_id: int, payload: dict[str, Any] | None = None):
        tpl = state.db.fetchone("SELECT * FROM note_templates WHERE id=?", (template_id,))
        if not tpl: raise HTTPException(404, "Modelo não encontrado.")
        data = payload or {}
        return create_note(NoteIn(title=str(data.get("title") or tpl["name"]), kind=tpl["kind"], content=tpl["content"], content_format=tpl["content_format"], tags=tpl["tags"]))

    @app.post("/api/notes/{note_id}/save-template", status_code=201)
    def save_note_as_template(note_id: int, payload: dict[str, Any] | None = None):
        note = _note_full(state, note_id)
        if not note: raise HTTPException(404, "Anotação não encontrada.")
        data = payload or {}
        return create_note_template({"name": str(data.get("name") or note["title"]), "kind": note["kind"], "content": note["content"], "content_format": note["content_format"], "tags": note["tags"]})

    @app.post("/api/notes/{note_id}/duplicate", status_code=201)
    def duplicate_note_endpoint(note_id: int):
        if not state.db.fetchone("SELECT id FROM notes WHERE id=?", (note_id,)):
            raise HTTPException(404, "Anotação não encontrada.")
        return _duplicate_note_tree(state, note_id)

    @app.get("/api/notes/{note_id}/history")
    def note_history(note_id: int, limit: int = 25):
        limit = min(max(int(limit), 1), 50)
        return state.db.fetchall("SELECT id,note_id,title,kind,tags,edit_revision,reason,created_at,length(content) content_size FROM note_history WHERE note_id=? ORDER BY id DESC LIMIT ?", (note_id, limit))

    @app.get("/api/notes/{note_id}/history/{history_id}")
    def note_history_item(note_id: int, history_id: int):
        row = state.db.fetchone("SELECT * FROM note_history WHERE id=? AND note_id=?", (history_id, note_id))
        if not row: raise HTTPException(404, "Versão não encontrada.")
        return row

    @app.post("/api/notes/{note_id}/history/{history_id}/restore")
    def restore_note_history(note_id: int, history_id: int):
        hist = state.db.fetchone("SELECT * FROM note_history WHERE id=? AND note_id=?", (history_id, note_id))
        if not hist: raise HTTPException(404, "Versão não encontrada.")
        with state.db.session() as conn:
            conn.execute("BEGIN IMMEDIATE")
            current = conn.execute("SELECT edit_revision FROM notes WHERE id=?", (note_id,)).fetchone()
            if not current: raise HTTPException(404, "Anotação não encontrada.")
            _snapshot_note_conn(conn, note_id, reason="before-restore")
            revision = int(current["edit_revision"] or 0) + 1
            conn.execute("UPDATE notes SET title=?,kind=?,content=?,content_format=?,tags=?,edit_revision=?,updated_at=? WHERE id=?", (hist["title"], hist["kind"], hist["content"], hist["content_format"], hist["tags"], revision, utcnow(), note_id))
        _rebuild_note_fts(state.db, note_id)
        return _note_full(state, note_id)

    @app.post("/api/notes/import", status_code=201)
    async def import_note(file: UploadFile = File(...)):
        name = file.filename or "nota.txt"
        suffix = Path(name).suffix.casefold()
        if suffix not in {".txt", ".md", ".markdown", ".html", ".htm"}:
            raise HTTPException(400, "Use TXT, Markdown ou HTML.")
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            while chunk := await file.read(1024 * 1024):
                tmp.write(chunk)
            temp = Path(tmp.name)
        try:
            data = import_note_file(temp, name)
            if len(data["content"]) > NOTE_CONTENT_LIMIT: raise HTTPException(413, "O arquivo importado ultrapassa o limite da nota.")
            return create_note(NoteIn(**data))
        finally:
            temp.unlink(missing_ok=True)

    @app.post("/api/notes/{note_id}/files", status_code=201)
    async def add_note_file(note_id: int, file: UploadFile = File(...)):
        if not state.db.fetchone("SELECT id FROM notes WHERE id=?", (note_id,)):
            raise HTTPException(404, "Anotação não encontrada.")
        path: Path | None = None
        try:
            path, digest, size = save_stream_to_controlled_path(file.file, state.paths.originals, file.filename or "arquivo")
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except OSError as exc:
            if path:
                path.unlink(missing_ok=True)
            raise HTTPException(507, "Não foi possível gravar o arquivo no armazenamento local.") from exc
        duplicate = state.db.fetchone("SELECT nf.id,nf.note_id,n.title FROM note_files nf JOIN notes n ON n.id=nf.note_id WHERE nf.file_hash=? AND nf.state!='pending_delete' LIMIT 1", (digest,))
        if duplicate:
            path.unlink(missing_ok=True)
            raise HTTPException(409, f"Este arquivo já existe em ‘{duplicate.get('title') or 'outra anotação'}’." )
        try:
            fid = state.db.execute(
                "INSERT INTO note_files(note_id,filename,filepath,file_type,file_hash,size,created_at,state,confirmed_revision,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (note_id, path.name, str(path), file_mime(path.name), digest, size, utcnow(), "staged", 0, ""),
            )
            state.db.execute("UPDATE notes SET updated_at=? WHERE id=?", (utcnow(), note_id))
        except Exception:
            path.unlink(missing_ok=True)
            raise
        return state.db.fetchone("SELECT * FROM note_files WHERE id=?", (fid,))

    @app.post("/api/note-files/{file_id}/confirm")
    def confirm_note_file(file_id: int, payload: dict[str, Any] | None = None):
        data = payload or {}
        expected_revision = max(0, int(data.get("revision") or 0))
        with state.db.session() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM note_files WHERE id=?", (file_id,)).fetchone()
            if not row:
                raise HTTPException(404, "Arquivo não encontrado.")
            note = conn.execute("SELECT content,edit_revision FROM notes WHERE id=?", (row["note_id"],)).fetchone()
            if not note:
                raise HTTPException(409, "A anotação associada ao arquivo não existe mais.")
            token = re.compile(rf"\[\[reposit-file:{int(file_id)}(?:;[^\]]+)?\]\]", re.I)
            if not token.search(str(note["content"] or "")):
                raise HTTPException(409, detail={"message": "O arquivo ainda não foi confirmado no conteúdo salvo.", "state": "staged"})
            revision = int(note["edit_revision"] or 0)
            if revision < expected_revision:
                raise HTTPException(409, detail={"message": "A revisão que referencia o arquivo ainda não foi confirmada.", "current_revision": revision})
            conn.execute("UPDATE note_files SET state='active',confirmed_revision=?,deleted_at='' WHERE id=?", (revision, file_id))
        return state.db.fetchone("SELECT * FROM note_files WHERE id=?", (file_id,))

    @app.post("/api/notes/{note_id}/files/reconcile")
    def reconcile_note_files(note_id: int):
        note = state.db.fetchone("SELECT content,edit_revision FROM notes WHERE id=?", (note_id,))
        if not note:
            raise HTTPException(404, "Anotação não encontrada.")
        content = str(note.get("content") or "")
        referenced = {int(x) for x in re.findall(r"\[\[reposit-file:(\d+)(?:;[^\]]+)?\]\]", content, re.I)}
        files = state.db.fetchall("SELECT * FROM note_files WHERE note_id=?", (note_id,))
        activated: list[int] = []
        staged: list[int] = []
        missing: list[int] = []
        for item in files:
            fid = int(item["id"])
            if not Path(item["filepath"]).exists():
                missing.append(fid)
            if fid in referenced:
                if item.get("state") != "active":
                    state.db.execute("UPDATE note_files SET state='active',confirmed_revision=? WHERE id=?", (int(note.get("edit_revision") or 0), fid))
                    activated.append(fid)
            elif item.get("state") == "staged":
                staged.append(fid)
        return {"ok": True, "referenced": sorted(referenced), "activated": activated, "staged": staged, "missing": missing}

    @app.delete("/api/note-files/{file_id}")
    def delete_note_file(file_id: int):
        filepath = ""
        # Phase 1: make the logical intent durable only after the note no longer
        # references this token. If physical deletion fails, the row remains as
        # pending_delete so maintenance/reconciliation can retry safely.
        with state.db.session() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM note_files WHERE id=?", (file_id,)).fetchone()
            if not row:
                raise HTTPException(404, "Arquivo não encontrado.")
            note = conn.execute("SELECT content FROM notes WHERE id=?", (row["note_id"],)).fetchone()
            token = re.compile(rf"\[\[reposit-file:{int(file_id)}(?:;[^\]]+)?\]\]", re.I)
            if note and token.search(str(note["content"] or "")):
                raise HTTPException(409, detail={"message": "Remova o bloco da nota e salve antes de excluir o arquivo físico.", "state": "referenced"})
            filepath = str(row["filepath"] or "")
            conn.execute("UPDATE note_files SET state='pending_delete',deleted_at=? WHERE id=?", (utcnow(), file_id))
            shared = int(conn.execute("SELECT COUNT(*) FROM note_files WHERE filepath=? AND id!=? AND state!='pending_delete'", (filepath, file_id)).fetchone()[0]) if filepath else 0
        # Duplicated notes share the same controlled physical file. Remove bytes only
        # when this metadata row is the last live reference.
        if not shared:
            try:
                safe_unlink(filepath, state.paths.attachments)
            except OSError as exc:
                raise HTTPException(423, detail={
                    "message": "O arquivo ficou marcado para exclusão, mas o Windows ainda está usando ou bloqueando o arquivo.",
                    "state": "pending_delete",
                }) from exc
            if filepath and Path(filepath).exists():
                raise HTTPException(423, detail={"message": "A exclusão física ficou pendente.", "state": "pending_delete"})
        state.db.execute("DELETE FROM note_files WHERE id=? AND state='pending_delete'", (file_id,))
        for thumb in state.paths.thumbnails.glob(f"{int(file_id)}-*.webp"):
            try:
                thumb.unlink()
            except OSError:
                pass
        return {"ok": True}

    @app.get("/api/note-files/{file_id}/thumbnail")
    def get_note_file_thumbnail(file_id: int):
        row = state.db.fetchone("SELECT * FROM note_files WHERE id=?", (file_id,))
        if not row:
            raise HTTPException(404, "Arquivo não encontrado.")
        source = Path(str(row.get("filepath") or ""))
        if not source.exists():
            raise HTTPException(404, "Arquivo físico não encontrado.")
        if not str(row.get("file_type") or "").startswith("image/"):
            return FileResponse(source, filename=row.get("filename") or source.name, media_type=row.get("file_type") or "application/octet-stream")
        key = f"{int(file_id)}-{str(row.get('file_hash') or '')[:16]}.webp"
        target = state.paths.thumbnails / key
        if not target.exists():
            try:
                from PIL import Image, ImageOps
                with Image.open(source) as image:
                    image = ImageOps.exif_transpose(image)
                    image.thumbnail((960, 960))
                    if image.mode not in ("RGB", "RGBA"):
                        image = image.convert("RGBA" if "transparency" in image.info else "RGB")
                    tmp = target.with_suffix(target.suffix + ".tmp")
                    image.save(tmp, format="WEBP", quality=82, method=4)
                    tmp.replace(target)
            except Exception:
                return FileResponse(source, filename=row.get("filename") or source.name, media_type=row.get("file_type") or "application/octet-stream")
        return FileResponse(target, media_type="image/webp", headers={"Cache-Control":"public, max-age=86400"})

    @app.get("/api/note-files/{file_id}")
    def get_note_file(file_id: int):
        row = state.db.fetchone("SELECT * FROM note_files WHERE id=?", (file_id,))
        if not row:
            raise HTTPException(404, "Arquivo não encontrado.")
        path = Path(row["filepath"])
        if not path.exists():
            raise HTTPException(404, "Arquivo físico não encontrado.")
        return FileResponse(path, filename=row["filename"], media_type=row.get("file_type") or "application/octet-stream")

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
        return {"stats": stats, "recent": recent, "current_week": current_week, "week_stats": week_stats}

    @app.post("/api/backup/export")
    def backup_export(payload: dict[str, Any] | None = None):
        state.db.checkpoint()
        safe_name = "RepositPlus"
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



def _snapshot_note_conn(conn, note_id: int, reason: str = "autosave") -> None:
    row = conn.execute("SELECT id,title,kind,content,content_format,tags,edit_revision FROM notes WHERE id=?", (note_id,)).fetchone()
    if not row:
        return
    last = conn.execute("SELECT title,kind,content,content_format,tags,edit_revision FROM note_history WHERE note_id=? ORDER BY id DESC LIMIT 1", (note_id,)).fetchone()
    current = (row["title"], row["kind"], row["content"], row["content_format"], row["tags"], int(row["edit_revision"] or 0))
    if last and current == (last["title"], last["kind"], last["content"], last["content_format"], last["tags"], int(last["edit_revision"] or 0)):
        return
    conn.execute(
        "INSERT INTO note_history(note_id,title,kind,content,content_format,tags,edit_revision,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (note_id, row["title"], row["kind"], row["content"], row["content_format"], row["tags"], int(row["edit_revision"] or 0), reason[:40], utcnow()),
    )
    conn.execute("DELETE FROM note_history WHERE note_id=? AND id NOT IN (SELECT id FROM note_history WHERE note_id=? ORDER BY id DESC LIMIT 25)", (note_id, note_id))


def _rewrite_token_ids(content: str, file_map: dict[int, int], sub_map: dict[int, int]) -> str:
    def repl_file(match):
        old = int(match.group(1)); suffix = match.group(2) or ""
        return f"[[reposit-file:{file_map.get(old, old)}{suffix}]]"
    def repl_sub(match):
        old = int(match.group(1)); suffix = match.group(2) or ""
        return f"[[reposit-subnote:{sub_map.get(old, old)}{suffix}]]"
    content = re.sub(r"\[\[reposit-file:(\d+)(;[^\]]+)?\]\]", repl_file, str(content or ""), flags=re.I)
    return re.sub(r"\[\[reposit-subnote:(\d+)(;[^\]]+)?\]\]", repl_sub, content, flags=re.I)


def _duplicate_note_tree(state: AppState, source_id: int, parent_id: int | None = None, *, root: bool = True, depth: int = 0) -> dict[str, Any]:
    if depth > 16:
        raise HTTPException(409, "A árvore de subnotas é profunda demais para duplicação segura.")
    source = state.db.fetchone("SELECT * FROM notes WHERE id=?", (source_id,))
    if not source:
        raise HTTPException(404, "Anotação não encontrada.")
    now = utcnow()
    title = f"{source['title']} — cópia" if root else str(source["title"])
    new_id = state.db.execute(
        "INSERT INTO notes(title,kind,content,tags,pinned,edit_revision,created_at,updated_at,content_format,parent_note_id,favorite,trashed_at,manual_order,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (title, source["kind"], source["content"], source["tags"], 0, 0, now, now, source["content_format"], parent_id, 0, "", 0, ""),
    )
    file_map: dict[int, int] = {}
    for item in state.db.fetchall("SELECT * FROM note_files WHERE note_id=? AND state!='pending_delete' ORDER BY id", (source_id,)):
        new_file_id = state.db.execute(
            "INSERT INTO note_files(note_id,filename,filepath,file_type,file_hash,size,created_at,state,confirmed_revision,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (new_id, item["filename"], item["filepath"], item["file_type"], item["file_hash"], item["size"], now, "active", 0, ""),
        )
        file_map[int(item["id"])] = int(new_file_id)
    sub_map: dict[int, int] = {}
    children = state.db.fetchall("SELECT id FROM notes WHERE parent_note_id=? AND trashed_at='' ORDER BY id", (source_id,))
    for child in children:
        duplicated = _duplicate_note_tree(state, int(child["id"]), new_id, root=False, depth=depth + 1)
        sub_map[int(child["id"])] = int(duplicated["id"])
    rewritten = _rewrite_token_ids(source["content"], file_map, sub_map)
    state.db.execute("UPDATE notes SET content=? WHERE id=?", (rewritten, new_id))
    _rebuild_note_fts(state.db, new_id)
    return _note_full(state, new_id) or {"id": new_id}


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
    for item in note["files"]:
        item["missing"] = not Path(str(item.get("filepath") or "")).exists()
    note["subnotes"] = state.db.fetchall("SELECT id,title,kind,tags,pinned,favorite,trashed_at,parent_note_id,updated_at FROM notes WHERE parent_note_id=? ORDER BY updated_at DESC", (note_id,))
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
    return db.execute("INSERT INTO teachers(name) VALUES (?)", (name,))


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
