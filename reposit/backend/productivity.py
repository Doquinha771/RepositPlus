from __future__ import annotations

import html
import re
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

_FILTER_RE = re.compile(r'(?P<key>tag|tipo|type|antes|depois|before|after|tem|has):(?P<value>"[^"]+"|\S+)', re.I)


def _parse_date(value: str) -> str | None:
    value = value.strip().strip('"')
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y"):
        try:
            return datetime.strptime(value, fmt).replace(tzinfo=timezone.utc).date().isoformat()
        except ValueError:
            continue
    return None


def parse_note_search(raw: str) -> dict[str, Any]:
    """Parse the intentionally small 0.7.4 search grammar.

    Unknown filters are kept as free text rather than becoming magic behavior.
    This keeps the grammar useful without turning the search field into SQL cosplay.
    """
    raw = str(raw or "").strip()
    filters: dict[str, list[str]] = {"tags": [], "kinds": [], "has": []}
    dates: dict[str, str | None] = {"before": None, "after": None}
    spans: list[tuple[int, int]] = []
    for match in _FILTER_RE.finditer(raw):
        key = match.group("key").casefold()
        value = match.group("value").strip().strip('"')[:120]
        accepted = False
        if key == "tag" and value:
            filters["tags"].append(value); accepted = True
        elif key in {"tipo", "type"} and value:
            filters["kinds"].append(value); accepted = True
        elif key in {"antes", "before"}:
            parsed = _parse_date(value)
            if parsed: dates["before"] = parsed; accepted = True
        elif key in {"depois", "after"}:
            parsed = _parse_date(value)
            if parsed: dates["after"] = parsed; accepted = True
        elif key in {"tem", "has"} and value.casefold() in {"arquivo", "file", "imagem", "image", "subnota", "subnote"}:
            filters["has"].append(value.casefold()); accepted = True
        if accepted:
            spans.append(match.span())
    chars = list(raw)
    for start, end in spans:
        for i in range(start, end): chars[i] = " "
    text = re.sub(r"\s+", " ", "".join(chars)).strip()
    return {"text": text, **filters, **dates}


def search_sql(parsed: dict[str, Any], *, include_trashed: bool = False) -> tuple[str, list[Any], str | None]:
    where = ["1=1"]
    params: list[Any] = []
    where.append("n.trashed_at!=''" if include_trashed else "n.trashed_at='' ")
    for tag in parsed.get("tags", []):
        where.append("(',' || REPLACE(n.tags,' ', '') || ',') LIKE ?")
        params.append(f"%,{str(tag).replace(' ', '')},%")
    kinds = [str(x) for x in parsed.get("kinds", []) if str(x)]
    if kinds:
        where.append("(" + " OR ".join("n.kind=?" for _ in kinds) + ")")
        params.extend(kinds)
    if parsed.get("before"):
        where.append("date(n.updated_at) < date(?)"); params.append(parsed["before"])
    if parsed.get("after"):
        where.append("date(n.updated_at) > date(?)"); params.append(parsed["after"])
    for item in parsed.get("has", []):
        if item in {"arquivo", "file"}:
            where.append("EXISTS (SELECT 1 FROM note_files nf WHERE nf.note_id=n.id AND nf.state!='pending_delete')")
        elif item in {"imagem", "image"}:
            where.append("EXISTS (SELECT 1 FROM note_files nf WHERE nf.note_id=n.id AND nf.state!='pending_delete' AND nf.file_type LIKE 'image/%')")
        elif item in {"subnota", "subnote"}:
            where.append("EXISTS (SELECT 1 FROM notes c WHERE c.parent_note_id=n.id AND c.trashed_at='')")
    text = str(parsed.get("text") or "").strip()
    fts: str | None = None
    if text:
        terms = [t.replace('"', '') for t in re.findall(r"[\wÀ-ÿ]+", text, re.UNICODE) if t][:8]
        if terms:
            fts = " AND ".join(f'"{term}"*' for term in terms)
            where.append("n.id IN (SELECT CAST(note_id AS INTEGER) FROM note_fts WHERE note_fts MATCH ?)")
            params.append(fts)
        else:
            like = f"%{text}%"
            where.append("(n.title LIKE ? OR n.content LIKE ? OR n.tags LIKE ? OR n.kind LIKE ?)")
            params.extend([like, like, like, like])
    return " AND ".join(where), params, fts


class _SafeImportParser(HTMLParser):
    """Tiny allow-list HTML importer for files, separate from browser sanitization."""
    ALLOWED = {"p", "div", "br", "h1", "h2", "h3", "h4", "strong", "b", "em", "i", "u", "s", "ul", "ol", "li", "blockquote", "pre", "code", "hr", "table", "thead", "tbody", "tr", "td", "th", "a"}
    VOID = {"br", "hr"}
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
    def handle_starttag(self, tag: str, attrs) -> None:  # noqa: ANN001
        tag = tag.lower()
        if tag not in self.ALLOWED: return
        safe_attrs: list[str] = []
        if tag == "a":
            for key, value in attrs:
                if key.lower() == "href" and re.match(r"^(https?:|mailto:|#)", value or "", re.I):
                    safe_attrs.append(f'href="{html.escape(value or "", quote=True)}"')
        attr_text = (" " + " ".join(safe_attrs)) if safe_attrs else ""
        self.out.append(f"<{tag}{attr_text}>")
    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in self.ALLOWED and tag not in self.VOID: self.out.append(f"</{tag}>")
    def handle_data(self, data: str) -> None:
        self.out.append(html.escape(data))


def sanitize_import_html(raw: str) -> str:
    parser = _SafeImportParser(); parser.feed(str(raw or "")); parser.close()
    return "".join(parser.out).strip()


def markdown_to_html(raw: str) -> str:
    lines = str(raw or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out: list[str] = []
    in_ul = in_ol = False
    def close_lists() -> None:
        nonlocal in_ul, in_ol
        if in_ul: out.append("</ul>"); in_ul = False
        if in_ol: out.append("</ol>"); in_ol = False
    for line in lines:
        stripped = line.rstrip()
        if stripped.startswith("### "): close_lists(); out.append(f"<h3>{html.escape(stripped[4:])}</h3>")
        elif stripped.startswith("## "): close_lists(); out.append(f"<h2>{html.escape(stripped[3:])}</h2>")
        elif stripped.startswith("# "): close_lists(); out.append(f"<h1>{html.escape(stripped[2:])}</h1>")
        elif stripped.startswith("> "): close_lists(); out.append(f"<blockquote>{html.escape(stripped[2:])}</blockquote>")
        elif re.match(r"^[-*] \[[ xX]\] ", stripped):
            close_lists(); checked = stripped[3].lower() == "x"; text = stripped[6:]
            out.append(f'<p data-check-item="{1 if checked else 0}" class="check-item">{"☑" if checked else "☐"} {html.escape(text)}</p>')
        elif re.match(r"^[-*] ", stripped):
            if in_ol: out.append("</ol>"); in_ol = False
            if not in_ul: out.append("<ul>"); in_ul = True
            out.append(f"<li>{html.escape(stripped[2:])}</li>")
        elif re.match(r"^\d+\. ", stripped):
            if in_ul: out.append("</ul>"); in_ul = False
            if not in_ol: out.append("<ol>"); in_ol = True
            out.append(f"<li>{html.escape(re.sub(r'^\\d+\\. ', '', stripped))}</li>")
        elif stripped.strip() in {"---", "***"}: close_lists(); out.append("<hr>")
        elif stripped == "": close_lists(); out.append("<p><br></p>")
        else:
            close_lists(); text = html.escape(stripped)
            text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
            text = re.sub(r"(?<!\*)\*(.+?)\*(?!\*)", r"<em>\1</em>", text)
            text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
            out.append(f"<p>{text}</p>")
    close_lists()
    return "".join(out)


def import_note_file(path: Path, filename: str | None = None) -> dict[str, str]:
    path = Path(path)
    name = filename or path.name
    suffix = Path(name).suffix.casefold()
    raw = path.read_text(encoding="utf-8-sig", errors="replace")
    title = Path(name).stem[:220] or "Nota importada"
    if suffix in {".md", ".markdown"}:
        return {"title": title, "kind": "Anotação", "content": markdown_to_html(raw), "content_format": "html"}
    if suffix in {".html", ".htm"}:
        return {"title": title, "kind": "Anotação", "content": sanitize_import_html(raw), "content_format": "html"}
    if suffix == ".txt":
        content = "".join(f"<p>{html.escape(line) if line else '<br>'}</p>" for line in raw.splitlines() or [""])
        return {"title": title, "kind": "Anotação", "content": content, "content_format": "html"}
    raise ValueError("Formato de importação não suportado. Use TXT, Markdown ou HTML.")
