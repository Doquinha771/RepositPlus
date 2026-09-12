# Reposit+ 0.7.1 Stable

A 0.7.1 Stable consolida os hotfixes das três versões de pré-lançamento sem adicionar uma nova feature estrutural no fechamento.

O Quick continua separado da janela principal, usa uma única janela persistente e pode ser acionado pelo atalho global sem depender do estado visual do Reposit+. O foco do campo de busca é aplicado imediatamente, a janela é posicionada usando o monitor ativo e a área útil, e o cálculo de tamanho/posição considera DPI por monitor. A animação também foi ajustada para não iniciar acima da área útil.

O autosave usa revisões monotônicas por nota. Cada aba mantém seu próprio estado, uma resposta antiga não pode limpar uma revisão nova e o backend rejeita revisões obsoletas. Na validação final, a seção crítica dos PATCHs revisionados também foi serializada no SQLite para que duas gravações concorrentes sempre convirjam para a revisão mais nova.

`Ctrl+S` força o salvamento da revisão atual. Falhas e timeouts mantêm a nota pendente, o estado visual diferencia salvando, salvo, pendente e erro, e rascunhos locais protegem alterações durante debounce, PATCH e fechamento.

O editor mantém o Selection Manager, preservação de caret, inserção de anexos/subnotas no ponto correto, colagem sanitizada, `Ctrl+Shift+V` em texto puro, tratamento de IME e os atalhos próprios do editor.

Os arquivos estáticos agora usam o identificador de cache `071stable`, evitando que uma atualização a partir das versões Pré carregue JavaScript ou CSS antigos do WebView2.

A suíte automatizada da Stable cobre API, banco, migrações, integridade de dados, distribuição, editor, Quick, stress de concorrência, 20 toggles rápidos, 500 ciclos de abrir/fechar e uma matriz de posicionamento para 1366×768, 1080p, 1440p e 4K em 100%, 125%, 150%, 175% e 200% de DPI.
