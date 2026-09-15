from __future__ import annotations

import html
import json
import re
import textwrap
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape as xml_escape

EXPORT_FORMATS: dict[str, tuple[str, str]] = {
    "txt": ("Texto", ".txt"),
    "md": ("Markdown", ".md"),
    "html": ("HTML", ".html"),
    "json": ("JSON", ".json"),
    "rtf": ("Rich Text Format", ".rtf"),
    "docx": ("Microsoft Word", ".docx"),
    "pdf": ("PDF", ".pdf"),
}

_TOKEN_RE = re.compile(r"\[\[reposit-(?:file|subnote):\d+(?:;[^\]]+)?\]\]", re.I)


class _TextExtractor(HTMLParser):
    BREAK_TAGS = {"p", "div", "li", "br", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "tr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:  # noqa: ANN001
        if tag == "br":
            self.parts.append("\n")
        elif tag == "li":
            self.parts.append("\n- ")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.BREAK_TAGS and tag != "br":
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def note_plain_text(note: dict[str, Any]) -> str:
    raw = str(note.get("content") or "")
    if note.get("content_format") == "html":
        parser = _TextExtractor()
        parser.feed(_TOKEN_RE.sub("", raw))
        text = "".join(parser.parts)
    else:
        text = html.unescape(_TOKEN_RE.sub("", raw))
    text = text.replace("\xa0", " ")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _metadata_header(note: dict[str, Any]) -> str:
    rows = [f"# {note.get('title') or 'Sem título'}"]
    if note.get("kind"):
        rows.append(f"Tipo: {note['kind']}")
    if note.get("tags"):
        rows.append(f"Tags: {note['tags']}")
    if note.get("updated_at"):
        rows.append(f"Atualizado: {note['updated_at']}")
    return "\n".join(rows)


def note_markdown(note: dict[str, Any]) -> str:
    if note.get("content_format") != "html":
        body = note_plain_text(note)
    else:
        body = str(note.get("content") or "")
        body = _TOKEN_RE.sub("", body)
        substitutions = [
            (r"<\s*h1[^>]*>(.*?)</\s*h1\s*>", r"# \1\n\n"),
            (r"<\s*h2[^>]*>(.*?)</\s*h2\s*>", r"## \1\n\n"),
            (r"<\s*h3[^>]*>(.*?)</\s*h3\s*>", r"### \1\n\n"),
            (r"<\s*(?:strong|b)[^>]*>(.*?)</\s*(?:strong|b)\s*>", r"**\1**"),
            (r"<\s*(?:em|i)[^>]*>(.*?)</\s*(?:em|i)\s*>", r"*\1*"),
            (r"<\s*(?:s|strike)[^>]*>(.*?)</\s*(?:s|strike)\s*>", r"~~\1~~"),
            (r"<\s*br\s*/?>", "\n"),
            (r"<\s*li[^>]*>(.*?)</\s*li\s*>", r"- \1\n"),
            (r"</\s*(?:p|div|blockquote)\s*>", "\n\n"),
        ]
        for pattern, replacement in substitutions:
            body = re.sub(pattern, replacement, body, flags=re.I | re.S)
        body = re.sub(r"<a\s+[^>]*href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>", r"[\2](\1)", body, flags=re.I | re.S)
        body = re.sub(r"<[^>]+>", "", body)
        body = html.unescape(body)
        body = re.sub(r"\n{3,}", "\n\n", body).strip()
    return f"{_metadata_header(note)}\n\n{body}\n"


def note_html(note: dict[str, Any]) -> str:
    title = html.escape(str(note.get("title") or "Sem título"))
    body = str(note.get("content") or "") if note.get("content_format") == "html" else html.escape(note_plain_text(note)).replace("\n", "<br>\n")
    body = _TOKEN_RE.sub("", body)
    meta = []
    if note.get("kind"):
        meta.append(f"<span>Tipo: {html.escape(str(note['kind']))}</span>")
    if note.get("tags"):
        meta.append(f"<span>Tags: {html.escape(str(note['tags']))}</span>")
    return f"""<!doctype html>
<html lang=\"pt-BR\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{title}</title>
<style>body{{font-family:Segoe UI,Arial,sans-serif;max-width:900px;margin:48px auto;padding:0 28px;line-height:1.65;color:#1b1d20}}h1{{font-size:38px}}.meta{{display:flex;gap:14px;flex-wrap:wrap;color:#666;font-size:13px;margin-bottom:28px}}img{{max-width:100%}}table{{border-collapse:collapse}}td,th{{border:1px solid #aaa;padding:6px}}</style></head>
<body><h1>{title}</h1><div class=\"meta\">{''.join(meta)}</div><main>{body}</main></body></html>"""


def _rtf_escape(text: str) -> str:
    out: list[str] = []
    for ch in text:
        if ch in "\\{}":
            out.append("\\" + ch)
        elif ch == "\n":
            out.append("\\par\n")
        else:
            code = ord(ch)
            if 32 <= code <= 126:
                out.append(ch)
            else:
                signed = code if code < 32768 else code - 65536
                out.append(f"\\u{signed}?")
    return "".join(out)


def note_rtf(note: dict[str, Any]) -> str:
    title = str(note.get("title") or "Sem título")
    text = note_plain_text(note)
    return "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Segoe UI;}}\\fs24 " + f"\\b {_rtf_escape(title)}\\b0\\par\\par {_rtf_escape(text)}" + "}"


def _docx_document_xml(note: dict[str, Any]) -> str:
    lines = [str(note.get("title") or "Sem título"), ""] + note_plain_text(note).splitlines()
    paragraphs: list[str] = []
    for i, line in enumerate(lines):
        safe = xml_escape(line)
        run_props = "<w:rPr><w:b/><w:sz w:val=\"32\"/></w:rPr>" if i == 0 else ""
        paragraphs.append(f"<w:p><w:r>{run_props}<w:t xml:space=\"preserve\">{safe}</w:t></w:r></w:p>")
    return """<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>
<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>""" + "".join(paragraphs) + "<w:sectPr/></w:body></w:document>"


def _write_docx(note: dict[str, Any], target: Path) -> None:
    content_types = """<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>"""
    rels = """<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>"""
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types)
        zf.writestr("_rels/.rels", rels)
        zf.writestr("word/document.xml", _docx_document_xml(note))


def _pdf_escape_cp1252(text: str) -> bytes:
    raw = text.encode("cp1252", errors="replace")
    return raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def _pdf_bytes(note: dict[str, Any]) -> bytes:
    lines: list[str] = [str(note.get("title") or "Sem título"), ""]
    for paragraph in note_plain_text(note).splitlines() or [""]:
        lines.extend(textwrap.wrap(paragraph, width=92, replace_whitespace=False, drop_whitespace=False) or [""])
    pages = [lines[i:i + 48] for i in range(0, max(1, len(lines)), 48)] or [[""]]
    objects: list[bytes] = []
    # 1 catalog, 2 pages. Page/content pairs start at 3, font follows.
    font_id = 3 + len(pages) * 2
    kids = " ".join(f"{3 + i * 2} 0 R" for i in range(len(pages)))
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode())
    for i, page_lines in enumerate(pages):
        page_id = 3 + i * 2
        content_id = page_id + 1
        commands = [b"BT", b"/F1 11 Tf", b"50 790 Td", b"14 TL"]
        for line in page_lines:
            commands.append(b"(" + _pdf_escape_cp1252(line) + b") Tj")
            commands.append(b"T*")
        commands.append(b"ET")
        stream = b"\n".join(commands)
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 {font_id} 0 R >> >> /Contents {content_id} 0 R >>".encode())
        objects.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream")
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for idx, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out.extend(f"{idx} 0 obj\n".encode())
        out.extend(obj)
        out.extend(b"\nendobj\n")
    xref = len(out)
    out.extend(f"xref\n0 {len(objects)+1}\n".encode())
    out.extend(b"0000000000 65535 f \n")
    for off in offsets[1:]:
        out.extend(f"{off:010d} 00000 n \n".encode())
    out.extend(f"trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(out)


def safe_filename(value: str, fallback: str = "Anotacao") -> str:
    value = re.sub(r"[<>:\"/\\|?*\x00-\x1f]", "-", str(value or "")).strip().strip(".")
    value = re.sub(r"\s+", " ", value)
    return (value[:120] or fallback)



def write_note_bundle(note: dict[str, Any], files: list[dict[str, Any]], target: Path) -> Path:
    """Write a portable HTML + attachments ZIP without mutating source files."""
    target = Path(target)
    if target.suffix.lower() != ".zip":
        target = target.with_suffix(".zip")
    target.parent.mkdir(parents=True, exist_ok=True)
    seen: set[str] = set()
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("nota.html", note_html(note).encode("utf-8"))
        for item in files:
            source = Path(str(item.get("filepath") or ""))
            if not source.is_file():
                continue
            base = safe_filename(str(item.get("filename") or source.name), fallback=f"arquivo-{item.get('id','x')}")
            candidate = base
            if candidate.casefold() in seen:
                stem, suffix = Path(base).stem, Path(base).suffix
                candidate = f"{stem}-{item.get('id','x')}{suffix}"
            seen.add(candidate.casefold())
            zf.write(source, f"arquivos/{candidate}")
    return target

def write_note_export(note: dict[str, Any], target: Path, fmt: str) -> Path:
    fmt = str(fmt or "txt").lower().lstrip(".")
    if fmt not in EXPORT_FORMATS:
        raise ValueError(f"Formato não suportado: {fmt}")
    target = Path(target)
    expected = EXPORT_FORMATS[fmt][1]
    if target.suffix.lower() != expected:
        target = target.with_suffix(expected)
    target.parent.mkdir(parents=True, exist_ok=True)
    if fmt == "txt":
        target.write_text(f"{str(note.get('title') or 'Sem título')}\n\n{note_plain_text(note)}\n", encoding="utf-8")
    elif fmt == "md":
        target.write_text(note_markdown(note), encoding="utf-8")
    elif fmt == "html":
        target.write_text(note_html(note), encoding="utf-8")
    elif fmt == "json":
        payload = {k: v for k, v in note.items() if k not in {"filepath"}}
        payload["plain_text"] = note_plain_text(note)
        target.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    elif fmt == "rtf":
        target.write_text(note_rtf(note), encoding="ascii", errors="backslashreplace")
    elif fmt == "docx":
        _write_docx(note, target)
    elif fmt == "pdf":
        target.write_bytes(_pdf_bytes(note))
    return target
