# Changelog

## 0.7.1 - Stable

- consolidados os hotfixes validados das Pré-1, Pré-2 e Pré-3 sem adicionar feature estrutural nova;
- Quick permanece em janela independente e persistente, com foco imediato, posicionamento por monitor e suporte a DPI por monitor;
- entrada do Quick agora é limitada à área útil do monitor também durante a animação;
- autosave mantém revisão e estado separados por nota, com proteção contra resposta atrasada e rascunho local;
- saves revisionados passam por uma seção crítica SQLite serializada para eliminar corrida entre PATCHs concorrentes;
- `Ctrl+S`, troca/fechamento de abas, falha de salvamento e dirty-state mantêm o estado correto;
- seleção/caret, colagem sanitizada, IME e atalhos do editor mantidos a partir dos hotfixes anteriores;
- cache-busting dos frontends principal e Quick atualizado para `071stable`, evitando carregar assets de Pré-1 após atualização;
- validação automatizada ampliada com concorrência real de PATCHs, migração de banco, 20 toggles rápidos, 500 ciclos do Quick e matriz de resolução/DPI;
- versão e release label fechadas como `0.7.1 Stable`.

## 0.7.1 Pré-3 - Editor Input Hotfix

- criado Selection Manager para preservar seleção e caret durante ações da toolbar e menus;
- seleção restaurada para fonte, tamanho, títulos, links e comandos de formatação;
- anexos e subnotas voltam ao ponto do cursor após perda temporária de foco;
- colagem HTML interceptada e sanitizada por whitelist de tags, atributos e estilos;
- removidos scripts, event handlers, elementos perigosos e estilos inúteis do Word;
- `Ctrl+Shift+V` cola somente texto preservando quebras de linha e Unicode;
- tratamento de `compositionstart`/`compositionend` impede autosave durante composição IME;
- `Ctrl+F` pesquisa dentro da nota e `Ctrl+Shift+F` mantém a pesquisa global;
- `Ctrl+K` cria links no editor;
- atalhos de negrito, itálico, sublinhado, desfazer e refazer tratados diretamente no editor;
- Esc fecha primeiro busca interna, menus e modais antes de sair de outros modos.

## 0.7.1 Pré-2 - Data Integrity Hotfix

- autosave refeito com estado independente por nota;
- adicionados `saveRevision`, `savedRevision`, fila por nota e uma única requisição PATCH em voo;
- respostas antigas não podem marcar uma revisão nova como salva;
- backend passa a armazenar `edit_revision` e rejeitar revisões obsoletas com HTTP 409;
- `Ctrl+S` força o flush da revisão atual;
- troca de abas mantém rascunho e estado da nota original sem permitir que resposta atrasada altere a nota ativa;
- falhas e timeouts mantêm a nota como pendente e exibem erro persistente com ação de tentar novamente;
- rascunho local é salvo durante a edição para proteger fechamento durante debounce/PATCH;
- fechar aba com alterações pendentes exige confirmação;
- fechamento da aplicação continua protegido mesmo com autosave ativo;
- schema SQLite atualizado para versão 6.

## 0.7.1 Pré-1 - Quick Critical Hotfix

- corrigido bug visual em que a animação nativa podia exibir apenas um retângulo preto antes do WebView2 pintar o conteúdo;
- removido `AnimateWindow` do Quick; a entrada agora move o HWND já visível com `SetWindowPos`, preservando a superfície WebView2 viva;
- animação de entrada não bloqueia mais o foco: o campo recebe foco imediatamente enquanto a janela termina de descer;
- removido o debounce de 150 ms da pesquisa; consultas locais são disparadas imediatamente e respostas antigas continuam sendo descartadas por token;
- abertura anterior ao carregamento completo agora fica pendente e só revela o Quick quando o WebView está pronto, evitando janela vazia/preta;
- eventos repetidos de foco não selecionam novamente o texto depois que a digitação começou;
- corrigida regressão do atalho global que podia ignorar `Left Ctrl + Left Alt` no Windows por depender do nome textual dos eventos de teclado;
- detecção do atalho agora consulta diretamente o estado físico de `left ctrl` e `left alt`, independentemente de o backend reportar o evento como `ctrl`, `alt` ou `left menu`;
- toggle do Quick é despachado fora da thread do hook de teclado para não bloquear o listener global do Windows;
- adicionado teste funcional do atalho cobrindo nomes genéricos de eventos, repetição enquanto as teclas estão seguradas e novo acionamento após soltar;
- smoke tests no Linux validaram ciclo abrir/fechar do runtime, duas janelas, API local, foco da busca e interface do Quick em Chromium;
- Quick separado completamente da Main Window;
- criada uma Quick Window nativa, frameless, borderless, oculta na inicialização e reutilizada durante toda a execução;
- removida a implementação antiga baseada em `?overlay=1`;
- atalho global `Left Ctrl + Left Alt` refeito como um único toggle por transição, sem callbacks duplicados ou atalho alternativo concorrente;
- corrigido o foco inicial: ao chamar o Quick pelo atalho, o campo de busca já fica pronto para digitar;
- foco reforçado por ativação Win32 e eventos reais de foco/visibilidade do WebView, sem polling;
- corrigida a corrida em que o Quick podia ser aberto antes do WebView terminar de carregar;
- integração Win32 isolada em `reposit/quick/win32.py`;
- TOPMOST aplicado somente enquanto o Quick está visível e removido antes de ocultar;
- janela anterior é registrada antes da abertura e só recebe foco de volta quando o Quick ainda possuía o foco;
- monitor ativo detectado pela janela em foreground, depois pelo cursor e por fim pelo monitor principal;
- posicionamento usa a área útil do monitor e escala baseada no DPI;
- DPI awareness Per Monitor V2 solicitado antes da criação das janelas;
- tratamento best-effort de desktop virtual com `IVirtualDesktopManager`;
- ativação nativa reforçada com `BringWindowToTop`, `SetForegroundWindow`, `SetWindowPos`, `AttachThreadInput` e `SetFocus`, sem simulação de teclas;
- interface do Quick simplificada para um finder único inspirado no macOS;
- removidos modo cápsula, estado recolhido e editor de nota rápida;
- busca e criação de notas unificadas no mesmo campo;
- resultados aparecem durante a digitação e Enter abre ou cria;
- pesquisa usa o mesmo banco e API da aplicação principal;
- estado local guarda apenas a pesquisa atual;
- sem polling constante, animações contínuas ou recriação de WebView ao alternar o Quick;
- testes específicos cobrem instância única, foco, atalho único, arquitetura independente e contrato Win32.

## 0.7.0 - Stable

- janela principal usa moldura nativa do Windows;
- corrigidos arraste, Alt+Tab, barra de tarefas, minimizar, maximizar e restauração;
- removidos e-mail, perfil e dependências relacionadas do runtime ativo;
- removidos também o runtime de Mural/P2P e `httpx` das dependências de runtime, preservando apenas dados legados no banco;
- removidos modos visuais experimentais e caminhos de renderização especiais;
- removidos controles internos de escala da interface;
- mantidos ícones nativos do Windows para funcionamento offline;
- governor de memória ajustado para um orçamento único, com verificação de baixa frequência e cooldown entre trims;
- WebView2 mantém GPU ativa e dois renderers para equilibrar fluidez e consumo;
- caches do WebView2 recebem limites modestos para reduzir crescimento em sessões longas;
- listagem de notas continua carregando apenas resumos;
- mídias continuam usando carregamento preguiçoso quando possível;
- recuperação automática de SQLite corrompido preserva o banco original antes da reconstrução;
- manutenção de banco, checkpoint e logs rotativos mantidos.
