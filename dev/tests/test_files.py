from io import BytesIO
from pathlib import Path

from reposit.backend.file_service import save_stream_to_controlled_path, sanitize_filename


def test_sanitize_filename():
    assert sanitize_filename('../../atividade?.docx') == 'atividade_.docx'


def test_save_stream_hash_and_size(tmp_path: Path):
    path, digest, size = save_stream_to_controlled_path(BytesIO(b'abc'), tmp_path, 'teste.txt')
    assert path.exists()
    assert size == 3
    assert digest == 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
