# Reposit+ 0.7.0 - validação de desempenho

A 0.7.0 evita colocar um limitador artificial de RAM. A meta é remover crescimento desnecessário e medir o processo real no Windows.

## Mudanças estruturais

- Mural/P2P foi removido do runtime da Stable; `httpx` não faz mais parte das dependências de runtime (permanece apenas no ambiente de testes do desenvolvedor).
- Listas de notas retornam somente metadados e até 420 caracteres de conteúdo.
- O conteúdo completo, subnotas e anexos de uma nota são carregados ao abrir.
- Imagens usam `loading=lazy` + `decoding=async`; áudio usa `preload=none`.
- Sem timers permanentes para manutenção do banco.
- SQLite usa WAL, índices e manutenção periódica na inicialização apenas quando passaram 7 dias.
- Logs rotacionam em 1 MB com dois backups.
- O boot consulta apenas o tamanho do banco; anexos/cache são somados quando o painel de armazenamento é aberto.

## Smoke test sintético executado no ambiente de desenvolvimento

Carga: 2.000 notas com 12.000 caracteres cada; consulta das 300 notas mais recentes.

- banco: aproximadamente 23,9 MB;
- resposta: 300 notas;
- prévia máxima por nota: 420 caracteres;
- payload da listagem: aproximadamente 194,9 KB;
- média da consulta HTTP local após aquecimento: aproximadamente 11,98 ms;
- pior amostra após aquecimento: aproximadamente 16,12 ms.

Esse teste valida o backend e a redução de payload. Ele não substitui medição do WebView2 no Windows.

## Teste real no Windows

Instale a ferramenta opcional:

```bat
py -3.12 -m pip install -r dev\requirements-profile.txt
```

Depois de gerar o Portable:

```bat
py -3.12 dev\profile_windows.py --exe dev\out\RepositPlus-v0.7.0-Portable.exe --seconds 1800
```

O profiler soma Reposit+ e subprocessos WebView2 e grava CSV em `dev/profile-results/`.

### Critérios sugeridos

- repouso: CPU próxima de 0% após estabilização;
- uso comum: sem CPU constante quando não há ação;
- estresse: tentar manter a parcela total perto de 1% a 2% quando a carga permitir;
- RAM: não apresentar crescimento monotônico contínuo em sessão de 30 a 60 minutos;
- Quick fechado: segunda janela WebView não deve existir antes do primeiro uso;
- abrir/fechar notas com mídia repetidamente não deve deixar o working set crescer indefinidamente.

Os números de CPU/RAM dependem do Windows, WebView2, escala, GPU e hardware. Por isso a meta deve ser validada no executável final em máquina Windows, não declarada como garantia apenas pelos testes de backend.
