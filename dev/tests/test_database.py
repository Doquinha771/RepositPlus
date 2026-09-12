from pathlib import Path

from reposit.backend.database import Database, utcnow
from reposit.backend.search import search_activities


def test_database_migrates_and_searches(tmp_path: Path):
    db = Database(tmp_path / 'REPOSITINFOS.db')
    repo = db.execute('INSERT INTO repositories(name,description,created_at) VALUES (?,?,?)', ('Programação Web','',utcnow()))
    subject = db.execute('INSERT INTO subjects(name) VALUES (?)', ('Programação Web',))
    now = utcnow()
    aid = db.execute(
        "INSERT INTO activities(title,description,subject_id,repository_id,week,status,origin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        ('CSS Grid', 'Layout responsivo', subject, repo, 19, 'Não iniciada', 'manual', now, now),
    )
    db.rebuild_activity_fts(aid)
    results = search_activities(db, 'CSS semana 19')
    assert any(r['id'] == aid for r in results)
    assert db.fetchone('PRAGMA user_version')['user_version'] == 6


def test_settings_cleanup_keeps_only_current_features(tmp_path: Path):
    import json
    from reposit.backend.config import AppPaths, load_settings
    root=tmp_path/'app';(root/'frontend').mkdir(parents=True)
    paths=AppPaths.from_root(root)
    paths.settings.write_text(json.dumps({'ui_revision':2,'theme':'paper','smtp':{'host':'old'},'account':{'x':1},'unknown':True}),encoding='utf-8')
    settings=load_settings(paths)
    assert settings['ui_revision']==9
    assert 'theme' not in settings
    assert 'smtp' not in settings and 'account' not in settings and 'unknown' not in settings
    assert settings['memory_soft_limit_mb']==192
