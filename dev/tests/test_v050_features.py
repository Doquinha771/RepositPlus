from pathlib import Path
from test_api import build_client


def test_v050_database_features(tmp_path):
    client, _ = build_client(tmp_path)
    note = client.post('/api/notes', json={
        'title': 'Editor rico', 'kind': 'Anotação',
        'content': '<h3>Teste</h3><p>Texto verde</p>', 'content_format': 'html',
        'tags': 'prova, urgente'
    }).json()
    assert note['content_format'] == 'html'
    child = client.post(f"/api/notes/{note['id']}/subnotes", json={'title':'Parte 1'}).json()
    parent = client.get(f"/api/notes/{note['id']}").json()
    assert any(s['id'] == child['id'] for s in parent['subnotes'])
    tags = client.get('/api/note-tags').json()
    assert any(t['name'] == 'prova' and t['count'] >= 1 for t in tags)


def test_v050_validator_state(tmp_path):
    client, _ = build_client(tmp_path)
    activity = client.post('/api/activities', json={
        'title':'Atividade 7','subject':'Matemática','activity_date':'2026-09-10',
        'status':'Não iniciada','tags':['semana 7'],'pinned':True
    }).json()
    assert activity['pinned'] == 1
    done = client.patch(f"/api/activities/{activity['id']}/state", json={'status':'Concluída'}).json()
    assert done['status'] == 'Concluída'
    assert done['completed_at']


def test_v050_interface_contracts():
    root = Path(__file__).resolve().parents[2]
    js = (root/'reposit/frontend/js/app.js').read_text(encoding='utf-8')
    css = (root/'reposit/frontend/css/main.css').read_text(encoding='utf-8')
    index = (root/'reposit/frontend/index.html').read_text(encoding='utf-8')
    required_texts = [
        'Subnota',
        'Grade 3×3', 'Marca-texto', 'Texto'
    ]
    for text in required_texts:
        assert text in js
    assert 'inline-media-image' in css
    assert 'inline-audio' in css
    assert 'editor-table' in css
    assert 'theme-samples' not in css
    assert 'activity-file-picker' not in index
    assert "e.key==='Escape'" in js



def test_v050_rich_note_content_is_preserved(tmp_path):
    client, _ = build_client(tmp_path)
    note = client.post('/api/notes', json={
        'title':'Resumo HTML','content':'<h3>Título</h3><p>Resposta <b>forte</b></p>',
        'content_format':'html','tags':''
    }).json()
    loaded = client.get(f"/api/notes/{note['id']}").json()
    assert loaded['content_format'] == 'html'
    assert '<h3>Título</h3>' in loaded['content']


def test_v050_rev3_subnote_parent_navigation_api(tmp_path):
    client, _ = build_client(tmp_path)
    parent = client.post('/api/notes', json={'title':'Nota principal','kind':'Anotação'}).json()
    child = client.post(f"/api/notes/{parent['id']}/subnotes", json={'title':'Detalhe'}).json()
    loaded = client.get(f"/api/notes/{child['id']}").json()
    assert loaded['parent_note_id'] == parent['id']
    assert loaded['parent_note']['id'] == parent['id']
    assert loaded['parent_note']['title'] == 'Nota principal'


def test_v050_rev5_resize_navigation_close_and_standalone_contracts():
    root = Path(__file__).resolve().parents[2]
    js = (root/'reposit/frontend/js/app.js').read_text(encoding='utf-8')
    css = (root/'reposit/frontend/css/main.css').read_text(encoding='utf-8')
    main = (root/'reposit/main.py').read_text(encoding='utf-8')
    build = (root/'dev/BUILD.bat').read_text(encoding='utf-8')
    assert 'validator-kanban' not in js and 'data-route="validator"' not in js
    assert 'data-media-resize' in js and 'image-size-slider' in css
    assert 'notion-browser-trail' in js and 'subnote-banner' in css
    assert 'QuickHotkey(self.toggle_quick' in main
    assert 'self.quick.toggle()' in main
    assert 'self.quick_window.destroy()' in main
    assert 'self.quick_hotkey.stop()' in main
    assert 'reposit-exit-watchdog' in main and 'os._exit(0)' in main
    assert 'installed.flag' in main and '_local_appdata_root' in main and 'RepositPlusData' in main
    assert 'build_windows.ps1' in build
    assert (root/'reposit/frontend/assets/RepositPlus.png').exists()
    assert (root/'dev/build/assets/RepositPlus.ico').exists()
