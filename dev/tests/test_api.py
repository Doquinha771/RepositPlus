from pathlib import Path

from fastapi.testclient import TestClient

from reposit.backend.api import AppState, create_app
from reposit.backend.config import AppPaths, load_identity, load_settings
from reposit.backend.database import Database


def build_client(tmp_path: Path):
    root = tmp_path / 'app'
    (root / 'frontend').mkdir(parents=True)
    (root / 'frontend' / 'index.html').write_text('<html>ok</html>', encoding='utf-8')
    paths = AppPaths.from_root(root)
    db = Database(paths.db)
    settings = load_settings(paths)
    identity = load_identity(paths)
    state = AppState(paths, db, settings, identity, 8777)
    return TestClient(create_app(state)), state


def test_core_crud_and_search(tmp_path: Path):
    client, state = build_client(tmp_path)

    repo = client.post('/api/repositories', json={'name':'Física','description':'Atividades'}).json()
    assert repo['name'] == 'Física'


    activity = client.post('/api/activities', json={
        'title':'Cinemática','description':'Lista','subject':'Física','repository_id':repo['id'],'teacher':'Otoniel',
        'week':19,'bimester':3,'status':'Respondida','tags':['movimento'],'origin':'manual'
    }).json()
    assert activity['week'] == 19


    found = client.get('/api/search', params={'q':'cinematica semana 19'}).json()
    assert found and found[0]['id'] == activity['id']


def test_removed_network_sharing_routes_are_not_exposed(tmp_path: Path):
    client, _ = build_client(tmp_path)
    assert client.get('/api/mural').status_code == 404
    assert client.get('/api/devices').status_code == 404
    assert client.post('/p2p/share', data={'metadata':'{}'}).status_code == 404



def test_note_workspace_crud(tmp_path: Path):
    client, state = build_client(tmp_path)
    note = client.post('/api/notes', json={
        'title': 'Probabilidade', 'kind': 'Atividade', 'content': 'Respostas da lista', 'tags': 'matemática, semana 19'
    }).json()
    assert note['title'] == 'Probabilidade'
    assert note['kind'] == 'Atividade'

    rows = client.get('/api/notes', params={'q': 'semana 19'}).json()
    assert any(row['id'] == note['id'] for row in rows)

    edited = client.patch(f"/api/notes/{note['id']}", json={'kind': 'Resumo', 'title': 'Probabilidade revisada'}).json()
    assert edited['kind'] == 'Resumo'


    deleted = client.delete(f"/api/notes/{note['id']}")
    assert deleted.status_code == 200
    assert client.get(f"/api/notes/{note['id']}").status_code == 404


def test_note_file_upload_and_duplicate_detection(tmp_path: Path):
    client, state = build_client(tmp_path)
    a = client.post('/api/notes', json={'title':'A','kind':'Material','content':'','tags':''}).json()
    b = client.post('/api/notes', json={'title':'B','kind':'Material','content':'','tags':''}).json()
    first = client.post(f"/api/notes/{a['id']}/files", files={'file':('arquivo.txt', b'conteudo', 'text/plain')})
    assert first.status_code == 201
    duplicate = client.post(f"/api/notes/{b['id']}/files", files={'file':('arquivo.txt', b'conteudo', 'text/plain')})
    assert duplicate.status_code == 409


