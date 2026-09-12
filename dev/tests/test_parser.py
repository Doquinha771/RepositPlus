from reposit.backend.parser import parse_school_filename


def test_parse_sis_filename():
    data = parse_school_filename('[SIS]ANO2C3B3S19A3AP.docx')
    assert data['year'] == 2
    assert data['class_code'] == 3
    assert data['bimester'] == 3
    assert data['week'] == 19
    assert data['activity_number'] == 3
    assert data['title'] == 'Atividade 3'
    assert data['pattern'] == 'sis_standard'


def test_unknown_filename_keeps_stem():
    data = parse_school_filename('Lista Probabilidade.pdf')
    assert data['title'] == 'Lista Probabilidade'
    assert data['pattern'] is None
