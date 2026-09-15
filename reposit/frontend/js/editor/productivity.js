(()=>{
  const COMMANDS=[
    {id:'text',label:'Texto',hint:'Parágrafo normal'},
    {id:'h1',label:'Título',hint:'Título principal'},
    {id:'h2',label:'Subtítulo',hint:'Título secundário'},
    {id:'check',label:'Checklist',hint:'Item marcável'},
    {id:'ul',label:'Lista',hint:'Lista com marcadores'},
    {id:'ol',label:'Lista numerada',hint:'Lista ordenada'},
    {id:'table',label:'Tabela',hint:'Tabela 3 × 3'},
    {id:'image',label:'Imagem',hint:'Inserir imagem/arquivo'},
    {id:'file',label:'Arquivo',hint:'Anexar arquivo'},
    {id:'subnote',label:'Subnota',hint:'Criar subnota'},
    {id:'code',label:'Código',hint:'Bloco monoespaçado'},
    {id:'quote',label:'Citação',hint:'Destacar uma citação'},
    {id:'callout',label:'Callout',hint:'Bloco de destaque'},
    {id:'divider',label:'Separador',hint:'Linha horizontal'},
  ];
  const BLOCKS='P,DIV,H1,H2,H3,H4,H5,H6,LI,BLOCKQUOTE,PRE';
  let menu=null,activeIndex=0,currentEditor=null,currentApi=null,currentBlock=null;
  function esc(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function selectionBlock(editor){
    const sel=window.getSelection();if(!sel?.rangeCount||!editor?.contains(sel.anchorNode))return null;
    let el=sel.anchorNode?.nodeType===1?sel.anchorNode:sel.anchorNode?.parentElement;
    el=el?.closest?.(BLOCKS)||null;return el&&editor.contains(el)?el:null;
  }
  function caretAtStart(block){const sel=window.getSelection();if(!sel?.rangeCount)return false;const r=sel.getRangeAt(0).cloneRange();const pre=r.cloneRange();pre.selectNodeContents(block);pre.setEnd(r.startContainer,r.startOffset);return pre.toString().length===0;}
  function setCaretEnd(el){const r=document.createRange(),s=window.getSelection();r.selectNodeContents(el);r.collapse(false);s.removeAllRanges();s.addRange(r);el.focus?.();}
  function record(before,label){currentApi?.record?.(before,label);currentApi?.changed?.();}
  function replaceBlock(block,html,label='productivity-block'){
    const before=currentEditor.innerHTML,box=document.createElement('div');box.innerHTML=html;const nodes=[...box.childNodes];block.replaceWith(...nodes);const target=nodes.find(n=>n.nodeType===1);if(target)setCaretEnd(target);record(before,label);bindDecorations(currentEditor,currentApi);
  }
  function transformMarkdown(editor,api){
    const block=selectionBlock(editor);if(!block||block.closest('[contenteditable="false"]'))return false;
    const text=(block.textContent||'').replace(/\u00a0/g,' ');
    const triggers={
      '# ':['h1','# '],'## ':['h2','## '],'> ':['blockquote','> '],'- ':['ul','- '],'* ':['ul','* '],'1. ':['ol','1. '],
    };
    if(text==='---'||text==='***'){currentEditor=editor;currentApi=api;currentBlock=block;replaceBlock(block,'<hr><p><br></p>','markdown-divider');return true;}
    if(text==='[] '||text==='[ ] '){currentEditor=editor;currentApi=api;currentBlock=block;replaceBlock(block,'<p class="check-item" data-check-item="0"><span class="check-box">☐</span><span class="check-text"><br></span></p>','markdown-checklist');return true;}
    const hit=triggers[text];if(!hit)return false;
    const before=editor.innerHTML,tag=hit[0],trigger=hit[1];
    if(tag==='ul'||tag==='ol'){
      block.textContent='';setCaretEnd(block);document.execCommand(tag==='ul'?'insertUnorderedList':'insertOrderedList',false,null);
      const now=selectionBlock(editor);if(now)now.dataset.mdTrigger=trigger;
    }else{
      const fresh=document.createElement(tag);fresh.innerHTML='<br>';fresh.dataset.mdTrigger=trigger;block.replaceWith(fresh);setCaretEnd(fresh);
    }
    api?.record?.(before,'markdown-shortcut');api?.changed?.();return true;
  }
  function restoreMarkdownOnBackspace(event,editor,api){
    if(event.key!=='Backspace')return false;const block=selectionBlock(editor);const trigger=block?.dataset?.mdTrigger;if(!block||!trigger||!caretAtStart(block)||(block.textContent||'').trim())return false;
    event.preventDefault();const before=editor.innerHTML,p=document.createElement('p');p.textContent=trigger;block.closest('ul,ol')?.replaceWith(p) || block.replaceWith(p);setCaretEnd(p);api?.record?.(before,'markdown-untransform');api?.changed?.();return true;
  }
  function menuRect(){const sel=window.getSelection();if(!sel?.rangeCount)return {left:24,top:80,bottom:100};const rect=sel.getRangeAt(0).getBoundingClientRect();return rect.width||rect.height?rect:{left:24,top:80,bottom:100};}
  function closeMenu(){menu?.remove();menu=null;currentBlock=null;}
  function filteredCommands(query){query=query.toLocaleLowerCase().trim();return COMMANDS.filter(c=>!query||c.label.toLocaleLowerCase().includes(query)||c.id.includes(query));}
  function renderMenu(query=''){
    if(!menu)return;const items=filteredCommands(query);activeIndex=Math.min(activeIndex,Math.max(0,items.length-1));menu.innerHTML=items.length?items.map((c,i)=>`<button type="button" role="option" aria-selected="${i===activeIndex}" class="${i===activeIndex?'active':''}" data-slash-command="${c.id}"><strong>${esc(c.label)}</strong><small>${esc(c.hint)}</small></button>`).join(''):'<div class="slash-empty">Nenhum comando</div>';
    menu.querySelectorAll('[data-slash-command]').forEach(b=>b.onmousedown=e=>{e.preventDefault();executeCommand(b.dataset.slashCommand);});
  }
  function openMenu(editor,api,block,query){currentEditor=editor;currentApi=api;currentBlock=block;if(!menu){menu=document.createElement('div');menu.className='slash-command-menu productivity-ephemeral';menu.setAttribute('role','listbox');document.body.append(menu);}activeIndex=0;renderMenu(query);const r=menuRect(),mr=menu.getBoundingClientRect();menu.style.left=`${Math.max(8,Math.min(r.left,innerWidth-mr.width-8))}px`;menu.style.top=`${Math.max(8,Math.min(r.bottom+8,innerHeight-mr.height-8))}px`;}
  function executeCommand(id){
    if(!currentEditor||!currentBlock)return closeMenu();const editor=currentEditor,block=currentBlock,api=currentApi,before=editor.innerHTML;
    block.textContent='';setCaretEnd(block);closeMenu();
    if(id==='text'||id==='h1'||id==='h2'||id==='quote'){
      document.execCommand('formatBlock',false,id==='text'?'p':id==='quote'?'blockquote':id);api?.record?.(before,'slash-'+id);api?.changed?.();return;
    }
    if(id==='ul'||id==='ol'){document.execCommand(id==='ul'?'insertUnorderedList':'insertOrderedList',false,null);api?.record?.(before,'slash-'+id);api?.changed?.();return;}
    if(id==='check'){replaceBlock(block,'<p class="check-item" data-check-item="0"><span class="check-box">☐</span><span class="check-text"><br></span></p>','slash-check');return;}
    if(id==='divider'){replaceBlock(block,'<hr><p><br></p>','slash-divider');return;}
    if(id==='code'){replaceBlock(block,'<pre class="reposit-code-block" data-language="text"><code><br></code></pre><p><br></p>','slash-code');return;}
    if(id==='callout'){replaceBlock(block,'<div class="reposit-callout"><strong>💡 Importante</strong><p><br></p></div><p><br></p>','slash-callout');return;}
    if(id==='table'){api?.insertTable?.();return;}
    if(id==='subnote'){api?.subnote?.();return;}
    if(id==='image'||id==='file'){api?.attach?.(id);return;}
  }
  function maybeSlash(editor,api){
    const block=selectionBlock(editor);if(!block||block.closest('[contenteditable="false"]'))return closeMenu();const text=(block.textContent||'').trimStart();if(!text.startsWith('/')||text.includes('\n'))return closeMenu();const query=text.slice(1);openMenu(editor,api,block,query);
  }
  function bindDecorations(editor,api){
    editor.querySelectorAll('.check-item,[data-check-item]').forEach(item=>{item.classList.add('check-item');
      let box=item.querySelector('.check-box');let text=item.querySelector('.check-text');
      if(!box){const raw=(item.textContent||'').replace(/^[☐☑]\s*/, '');item.textContent='';box=document.createElement('span');box.className='check-box';text=document.createElement('span');text.className='check-text';text.textContent=raw;item.append(box,text);}
      box.contentEditable='false';box.textContent=item.dataset.checkItem==='1'?'☑':'☐';
    });
    editor.querySelectorAll('pre.reposit-code-block').forEach(pre=>{
      if(pre.nextElementSibling?.classList.contains('code-copy-button'))return;const b=document.createElement('button');b.type='button';b.className='code-copy-button productivity-ephemeral';b.textContent='Copiar código';b.contentEditable='false';b.onclick=async e=>{e.preventDefault();e.stopPropagation();try{await navigator.clipboard.writeText(pre.innerText||'');b.textContent='Copiado';setTimeout(()=>b.textContent='Copiar código',900);}catch(_e){}};pre.after(b);
    });
  }
  function bind(editor,api={}){
    if(!editor||editor.dataset.productivity074==='1'){bindDecorations(editor,api);return;}
    editor.dataset.productivity074='1';bindDecorations(editor,api);
    editor.addEventListener('input',()=>{transformMarkdown(editor,api);maybeSlash(editor,api);bindDecorations(editor,api);});
    editor.addEventListener('keydown',e=>{
      if(menu){const items=[...menu.querySelectorAll('[data-slash-command]')];if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();activeIndex=(activeIndex+(e.key==='ArrowDown'?1:-1)+Math.max(1,items.length))%Math.max(1,items.length);renderMenu((currentBlock?.textContent||'').trimStart().slice(1));return;}if(e.key==='Enter'&&items.length){e.preventDefault();executeCommand(items[activeIndex]?.dataset.slashCommand);return;}if(e.key==='Escape'){e.preventDefault();closeMenu();return;}}
      restoreMarkdownOnBackspace(e,editor,api);
    });
    editor.addEventListener('click',e=>{const box=e.target.closest?.('.check-box');if(!box||!editor.contains(box))return;e.preventDefault();const item=box.closest('.check-item');if(!item)return;const before=editor.innerHTML;item.dataset.checkItem=item.dataset.checkItem==='1'?'0':'1';box.textContent=item.dataset.checkItem==='1'?'☑':'☐';api?.record?.(before,'checklist-toggle');api?.changed?.();});
    editor.addEventListener('blur',()=>setTimeout(()=>{if(!menu?.matches(':hover'))closeMenu();},80));
  }
  window.RepositProductivity074={bind,closeMenu,commands:COMMANDS};
})();
