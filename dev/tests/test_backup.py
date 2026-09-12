from pathlib import Path

from reposit.backend.backups import export_reposit, import_reposit
from reposit.backend.config import AppPaths
from reposit.backend.database import Database, utcnow


def test_backup_relocates_attachment_paths(tmp_path: Path):
    root_a = tmp_path / 'a'
    paths_a = AppPaths.from_root(root_a)
    db_a = Database(paths_a.db)
    now = utcnow()
    aid = db_a.execute(
        "INSERT INTO activities(title,status,origin,created_at,updated_at) VALUES (?,?,?,?,?)",
        ('Teste', 'Não iniciada', 'manual', now, now),
    )
    file_a = paths_a.originals / 'teste.txt'
    file_a.write_text('abc', encoding='utf-8')
    db_a.execute(
        "INSERT INTO files(activity_id,filename,filepath,file_type,file_hash,role,size,created_at) VALUES (?,?,?,?,?,?,?,?)",
        (aid, 'teste.txt', str(file_a), 'text/plain', 'hash', 'original', 3, now),
    )

    nid = db_a.execute(
        "INSERT INTO notes(title,kind,content,tags,pinned,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
        ('Nota', 'Material', '', '', 0, now, now),
    )
    note_file = paths_a.originals / 'nota.txt'
    note_file.write_text('nota', encoding='utf-8')
    db_a.execute(
        "INSERT INTO note_files(note_id,filename,filepath,file_type,file_hash,size,created_at) VALUES (?,?,?,?,?,?,?)",
        (nid, 'nota.txt', str(note_file), 'text/plain', 'hash-note', 4, now),
    )
    db_a.checkpoint()
    backup = export_reposit(paths_a, tmp_path / 'backup.reposit')

    root_b = tmp_path / 'b'
    paths_b = AppPaths.from_root(root_b)
    Database(paths_b.db).checkpoint()
    import_reposit(paths_b, backup)
    db_b = Database(paths_b.db)
    row = db_b.fetchone('SELECT filepath FROM files LIMIT 1')
    assert row is not None
    assert Path(row['filepath']).resolve() == (paths_b.originals / 'teste.txt').resolve()
    assert (paths_b.originals / 'teste.txt').read_text(encoding='utf-8') == 'abc'
    note_row = db_b.fetchone('SELECT filepath FROM note_files LIMIT 1')
    assert note_row is not None
    assert Path(note_row['filepath']).resolve() == (paths_b.originals / 'nota.txt').resolve()
    assert (paths_b.originals / 'nota.txt').read_text(encoding='utf-8') == 'nota'


def test_backup_validation_rejects_traversal_but_accepts_normal_members(tmp_path: Path):
    import json
    import sqlite3
    import zipfile

    from reposit.backend.backups import validate_backup

    good = tmp_path / 'good.reposit'
    db_file = tmp_path / 'empty.db'
    sqlite3.connect(db_file).close()
    with zipfile.ZipFile(good, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('manifest.json', json.dumps({'format': 'reposit', 'version': '0.5.0'}))
        zf.write(db_file, 'data/REPOSITINFOS.db')
        zf.writestr('attachments/original/teste.txt', 'ok')
    assert validate_backup(good)['format'] == 'reposit'

    bad = tmp_path / 'bad.reposit'
    with zipfile.ZipFile(bad, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('manifest.json', json.dumps({'format': 'reposit', 'version': '0.5.0'}))
        zf.write(db_file, 'data/REPOSITINFOS.db')
        zf.writestr('../escape.txt', 'não')
    try:
        validate_backup(bad)
    except ValueError as exc:
        assert 'caminho inseguro' in str(exc).lower()
    else:
        raise AssertionError('Backup com path traversal deveria ser rejeitado')
