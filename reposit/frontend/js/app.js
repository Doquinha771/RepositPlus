window.__REPOSIT_BOOT_OK__ = true;

class ApiError extends Error {
  constructor(message, status=0, data=null) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const opts = { ...options, signal: controller.signal, headers: { ...(options.headers || {}) } };
  try {
    if (opts.body && !(opts.body instanceof FormData) && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, opts);
    const type = res.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) {
      const message = typeof data === 'object' ? (data.detail || data.message || `Erro ${res.status}`) : (data || `Erro ${res.status}`);
      throw new ApiError(typeof message === 'string' ? message : JSON.stringify(message), res.status, data);
    }
    return data;
  } catch (err) {
    if (err && err.name === 'AbortError') throw new ApiError('O serviço local demorou demais para responder. Reinicie o Reposit+.', 0, null);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
const get = path => api(path);
const post = (path, body) => api(path, { method: 'POST', body });
const patch = (path, body) => api(path, { method: 'PATCH', body });
const del = path => api(path, { method: 'DELETE' });
const form = (path, data, method = 'POST') => api(path, { method, body: data });

const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const esc = (v='') => String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmt = iso => iso ? new Date(iso).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}) : '-';
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString('pt-BR',{day:'2-digit',month:'short',year:'numeric'}) : '-';
const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}) : '-';
const state = {
  route:'workspace', notes:[], active:null, selected:new Set(), openTabs:[],
  sidebarCollapsed: localStorage.getItem('reposit.sidebar.collapsed')==='1', settingsTab:'general',
  settings:{autosave_enabled:true,battery_saver:false,memory_soft_limit_mb:192},
  appInfo:{name:'Reposit+',version:'0.7.1',distribution:'source',distribution_label:'Código-fonte',data_path:''},
  query:'', kind:'', tag:'', noteTags:[], period:'all', view:'table', ecoMode:false, noteDirty:false, storage:null
};
const NOTE_DRAFT_PREFIX='reposit.note-draft.';
const noteSessions=new Map();
let searchTimer=null;
let openNoteRequestSeq=0;
let pendingAttachmentNoteId=null;
let forcePlainPasteOnce=false;

class SelectionManager {
  constructor(){this.ranges=new Map();}
  remember(noteId=state.active?.id){
    const editor=$('#notion-content'),sel=window.getSelection();
    const id=Number(noteId||0);
    if(!id||!editor||!sel?.rangeCount||!editor.contains(sel.anchorNode))return false;
    this.ranges.set(id,sel.getRangeAt(0).cloneRange());
    return true;
  }
  restore(noteId=state.active?.id){
    const editor=$('#notion-content'),id=Number(noteId||0),range=this.ranges.get(id);
    if(!editor)return false;
    editor.focus({preventScroll:true});
    if(!range||!range.startContainer?.isConnected||!editor.contains(range.startContainer))return false;
    const sel=window.getSelection();sel.removeAllRanges();sel.addRange(range.cloneRange());return true;
  }
  clear(noteId){this.ranges.delete(Number(noteId||0));}
}
const selectionManager=new SelectionManager();

function noteDraftKey(id){return `${NOTE_DRAFT_PREFIX}${Number(id)}`;}
function readNoteDraft(id){try{const raw=localStorage.getItem(noteDraftKey(id));return raw?JSON.parse(raw):null;}catch(_err){return null;}}
function clearNoteDraft(id){try{localStorage.removeItem(noteDraftKey(id));}catch(_err){}}
function persistNoteDraft(session){
  if(!session?.dirty||!session.payload)return;
  try{localStorage.setItem(noteDraftKey(session.id),JSON.stringify({saveRevision:session.saveRevision,payload:session.payload,updatedAt:Date.now()}));}
  catch(_err){session.error='Não foi possível guardar o rascunho local.';}
}
function noteSession(id,note=null){
  id=Number(id);if(!id)return null;
  let session=noteSessions.get(id);
  const serverRevision=Math.max(0,Number(note?.edit_revision||0));
  if(!session){
    const draft=readNoteDraft(id);
    const draftRevision=Math.max(0,Number(draft?.saveRevision||0));
    const useDraft=!!(draft?.payload&&draftRevision>serverRevision);
    session={id,saveRevision:useDraft?draftRevision:serverRevision,savedRevision:serverRevision,payload:useDraft?draft.payload:null,dirty:useDraft,inFlight:null,timer:null,error:null,isComposing:false};
    noteSessions.set(id,session);
    if(!useDraft&&draft)clearNoteDraft(id);
  }else if(note){
    session.savedRevision=Math.max(session.savedRevision,serverRevision);
    if(session.dirty&&session.saveRevision<=session.savedRevision)session.saveRevision=session.savedRevision+1;
    if(!session.dirty){session.saveRevision=session.savedRevision;session.payload=null;clearNoteDraft(id);}
  }
  return session;
}
function hasPendingNoteChanges(){return [...noteSessions.values()].some(s=>s.dirty||s.inFlight);}
function currentEditorPayload(){
  return {title:$('#notion-title')?.value||'Sem título',kind:$('#notion-kind')?.value||'Anotação',tags:$('#notion-tags')?.value||'',content:serializeEditorContent($('#notion-content')),content_format:'html'};
}
function captureNoteRevision(id,{increment=false}={}){
  id=Number(id);const session=noteSession(id,state.active?.id===id?state.active:null);if(!session)return null;
  if(state.active?.id===id&&$('#notion-content'))session.payload=currentEditorPayload();
  if(increment){session.saveRevision=Math.max(session.saveRevision,session.savedRevision)+1;session.dirty=true;}
  if(session.dirty)persistNoteDraft(session);
  syncSaveUi(id);return session;
}
function materializeSessionNote(note){
  const session=noteSession(note?.id,note);
  return session?.dirty&&session.payload?{...note,...session.payload,edit_revision:session.savedRevision}:note;
}
function syncSaveUi(id=state.active?.id){
  id=Number(id||0);const session=id?noteSessions.get(id):null;
  if(state.active?.id===id){
    state.noteDirty=!!session?.dirty;
    document.body.classList.toggle('note-dirty',state.noteDirty);
    const status=$('#autosave-state'),retry=$('#save-retry');
    if(status&&session){
      if(session.inFlight)status.textContent='Salvando…';
      else if(session.error&&session.dirty)status.textContent='Erro ao salvar';
      else if(session.dirty)status.textContent='Alterações pendentes';
      else status.textContent=state.settings.autosave_enabled?'Salvo':'Salvo · manual';
    }
    if(retry){retry.hidden=!(session?.error&&session?.dirty);retry.title=session?.error||'Tentar salvar novamente';}
  }
  renderNoteTabsDirtyOnly();
}
function renderNoteTabsDirtyOnly(){
  $$('[data-tab-note]').forEach(tab=>tab.classList.toggle('dirty',!!noteSessions.get(Number(tab.dataset.tabNote))?.dirty));
}
function setDirty(value=true){
  const id=state.active?.id;if(!id)return;const session=noteSession(id,state.active);
  if(value){session.dirty=true;if(session.saveRevision<=session.savedRevision)session.saveRevision=session.savedRevision+1;persistNoteDraft(session);}
  else if(session.savedRevision>=session.saveRevision){session.dirty=false;clearNoteDraft(id);}
  syncSaveUi(id);
}
function scheduleNoteSave(id,delay=850){
  const session=noteSession(id);if(!session)return;clearTimeout(session.timer);session.timer=null;syncSaveUi(id);
  if(state.settings.autosave_enabled&&!session.isComposing&&session.dirty)session.timer=setTimeout(()=>{session.timer=null;void saveNotionPage(id,true);},delay);
}

function toast(message,type=''){
  const el=document.createElement('div'); el.className=`toast ${type}`; el.textContent=message;
  $('#toast-root').appendChild(el); setTimeout(()=>el.remove(),3500);
}
function icon(name){
  // Native Windows symbol fonts: Segoe Fluent Icons (Windows 11) with
  // Segoe MDL2 Assets fallback (Windows 10). No network or bundled icon files.
  const glyphs={
    'angle-left':'E72B','angle-right':'E72A','apps':'F0E2','bolt':'E945','bookmark':'E8A4',
    'clip':'E723','clock':'E823','copy':'E8C8','cross-small':'E711','document':'E8A5','download':'E896',
    'expand':'E7AC','file':'E8A5','filter':'E71C','folder-open':'E838',
    'label':'E8EC','plus':'E710','search':'E721','settings':'E713','share':'E72D',
    'table-columns':'F0E2','tags':'E8EC','trash':'E74D','upload':'E898',
    'info':'E946','minus':'E738','maximize':'EF2E','close':'EF2C','undo':'E7A7','redo':'E7A6','bold':'E8DD',
    'italic':'E8DB','underline':'E8DC','strike':'EDE0','superscript':'E8E8','subscript':'E8E7',
    'align-left':'E8E4','align-center':'E8E3','align-right':'E8E2','align-justify':'E8E4',
    'list':'E8FD','numbered-list':'F0E3','indent':'E8F4','outdent':'E72B','table':'F0E2',
    'link':'E71B','horizontal-line':'E738','clear-format':'E894','export':'EDE1','save':'E74E','delete-row':'E74D',
    'font':'E8D2','palette':'E790','more':'E712','image':'EB9F'
  };
  const code=glyphs[name]||'E897';
  return `<span class="rp-icon rp-icon-${name}" aria-hidden="true" data-glyph="${code}">&#x${code};</span>`;
}
function applyUiPreferences(){
  const st=state.settings||{};
  document.documentElement.classList.toggle('eco-mode',!!st.battery_saver || state.ecoMode);
}

function showSaveAnimation(){
  const el=$('#save-book');if(!el)return;
  el.classList.remove('play');void el.offsetWidth;el.classList.add('play');
  setTimeout(()=>el.classList.remove('play'),1600);
}
async function leaveCurrentNote(target){
  if(!state.active||!$('#notion-content'))return true;
  const id=Number(state.active.id),session=captureNoteRevision(id);
  selectionManager.remember(id);
  if(!session?.dirty)return true;
  // Trocar de aba/rota não abandona a nota: a revisão fica no estado da aba e
  // também em rascunho local. O autosave pode terminar depois sem tocar na nota ativa.
  if(state.settings.autosave_enabled)void saveNotionPage(id,true);
  return true;
}
function modal(title,body,foot='',className=''){
  $('#modal-root').innerHTML=`<div class="modal-backdrop"><div class="modal ${className}"><div class="modal-head"><div><span class="modal-kicker">REPOSIT+</span><h2>${esc(title)}</h2></div><button class="btn icon soft" data-close>${icon('cross-small')}</button></div><div class="modal-body">${body}</div>${foot?`<div class="modal-foot">${foot}</div>`:''}</div></div>`;
  $$('[data-close]').forEach(b=>b.onclick=closeModal);
  $('.modal-backdrop')?.addEventListener('mousedown',e=>{if(e.target.classList.contains('modal-backdrop')) closeModal();});
}
function closeModal(){ $('#modal-root').innerHTML=''; }
function routeTitle(route){
  return ({workspace:'Notas',settings:'Configurações'})[route] || 'Reposit+';
}
function routeSubtitle(route){
  return '';
}
function setHeader(route=state.route){
  const title=$('#header-title'), subtitle=$('#header-subtitle');
  if(title) title.textContent=routeTitle(route);
  if(subtitle) subtitle.textContent=routeSubtitle(route);
}
function noteTone(note,index=0){
  const seed=Number(note?.id||0) + String(note?.kind||'').length*3 + index;
  return Math.abs(seed)%6;
}
function notePreview(note,max=160){
  const text=String(note?.content||'').replace(/<[^>]+>/g,' ').replace(/\[\[reposit-(?:file|subnote):\d+(?:;[^\]]+)?\]\]/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
  return text ? (text.length>max?`${text.slice(0,max).trim()}…`:text) : 'Sem conteúdo ainda. Abra e comece a escrever.';
}
function visibleNotes(){
  const now=new Date();
  return state.notes.filter(n=>{
    if(state.period==='all') return true;
    const d=new Date(n.updated_at||n.created_at||0);
    if(Number.isNaN(d.getTime())) return false;
    if(state.period==='today') return d.toDateString()===now.toDateString();
    if(state.period==='week'){
      const cutoff=new Date(now); cutoff.setDate(now.getDate()-7); return d>=cutoff;
    }
    if(state.period==='month'){
      return d.getMonth()===now.getMonth() && d.getFullYear()===now.getFullYear();
    }
    return true;
  });
}


function animateMain(kind='route'){
  const main=$('#main'); if(!main)return;
  main.classList.remove('motion-in','motion-tab');
  void main.offsetWidth;
  main.classList.add(kind==='tab'?'motion-tab':'motion-in');
}
function setSidebarCollapsed(value){
  state.sidebarCollapsed=!!value;
  localStorage.setItem('reposit.sidebar.collapsed',state.sidebarCollapsed?'1':'0');
  $('.app-shell')?.classList.toggle('sidebar-collapsed',state.sidebarCollapsed);
  const toggle=$('#sidebar-toggle');
  if(toggle){
    toggle.setAttribute('title',state.sidebarCollapsed?'Expandir lateral':'Recolher lateral');
    toggle.setAttribute('aria-label',state.sidebarCollapsed?'Expandir lateral':'Recolher lateral');
    toggle.innerHTML=icon(state.sidebarCollapsed?'angle-right':'angle-left');
  }
}
function copyText(text){
  if(navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();return Promise.resolve();
}
function cycleNoteTab(direction=1){
  if(!state.openTabs.length)return;
  const active=state.active?.id;
  let idx=state.openTabs.findIndex(t=>t.id===active);
  if(idx<0)idx=direction>0?-1:0;
  idx=(idx+direction+state.openTabs.length)%state.openTabs.length;
  openNote(state.openTabs[idx].id);
}
async function duplicateNote(id){
  try{const src=await get(`/api/notes/${id}`);const n=await post('/api/notes',{title:`${src.title||'Nota'} — cópia`,kind:src.kind||'Anotação',content:src.content||'',content_format:src.content_format||'plain',tags:src.tags||''});ensureNoteTab(n);toast('Nota duplicada.','ok');await navigate('workspace');await openNote(n.id);return n;}catch(err){toast(err.message,'err');}
}
function execEditorCommand(command,value=null){
  const editor=$('#notion-content');
  if(!editor || !editor.contains(document.activeElement) && document.activeElement!==editor)return false;
  document.execCommand(command,false,value); return true;
}
function closeNoteFind(){document.querySelector('.note-findbar')?.remove();selectionManager.restore();}
function findTextInEditor(query,backwards=false){
  const editor=$('#notion-content');if(!editor||!query)return false;
  const walker=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT);const nodes=[];let text='',node;
  while((node=walker.nextNode())){nodes.push({node,start:text.length,end:text.length+node.textContent.length});text+=node.textContent;}
  const hay=text.toLocaleLowerCase(),needle=String(query).toLocaleLowerCase();if(!needle)return false;
  let cursor=backwards?hay.length:0;const sel=window.getSelection();
  if(sel?.rangeCount&&editor.contains(sel.anchorNode)){const range=sel.getRangeAt(0);const hit=nodes.find(x=>x.node===range.endContainer);if(hit)cursor=hit.start+range.endOffset+(backwards?-1:0);}
  let index=backwards?hay.lastIndexOf(needle,Math.max(0,cursor)):hay.indexOf(needle,Math.max(0,cursor));
  if(index<0)index=backwards?hay.lastIndexOf(needle):hay.indexOf(needle);if(index<0)return false;
  const start=nodes.find(x=>index>=x.start&&index<x.end),endIndex=index+needle.length,end=nodes.find(x=>endIndex>x.start&&endIndex<=x.end);
  if(!start||!end)return false;const range=document.createRange();range.setStart(start.node,index-start.start);range.setEnd(end.node,endIndex-end.start);
  sel.removeAllRanges();sel.addRange(range);range.startContainer.parentElement?.scrollIntoView({block:'center'});selectionManager.remember();return true;
}
function openNoteFind(){
  if(!state.active||!$('#notion-content'))return;selectionManager.remember();let bar=$('.note-findbar');
  if(!bar){bar=document.createElement('div');bar.className='note-findbar';bar.innerHTML='<input type="search" placeholder="Procurar nesta nota" aria-label="Procurar nesta nota"><span class="note-find-result"></span><button type="button" data-find-prev title="Anterior">↑</button><button type="button" data-find-next title="Próximo">↓</button><button type="button" data-find-close title="Fechar">×</button>';$('.notion-page')?.appendChild(bar);
    const input=$('input',bar),result=$('.note-find-result',bar);const run=back=>{const ok=findTextInEditor(input.value,back);result.textContent=input.value?(ok?'Encontrado':'Sem resultado'):'';};
    input.addEventListener('input',()=>run(false));input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();run(e.shiftKey);}if(e.key==='Escape'){e.preventDefault();closeNoteFind();}});
    $('[data-find-prev]',bar).onclick=()=>run(true);$('[data-find-next]',bar).onclick=()=>run(false);$('[data-find-close]',bar).onclick=closeNoteFind;
  }
  const input=$('input',bar);input.focus();input.select();
}

async function configureNotebookMode(){
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const apply=(eco)=>{state.ecoMode=!!eco;document.documentElement.classList.toggle('eco-mode',state.ecoMode);};
  apply(reduced.matches);
  try{
    if(navigator.getBattery){
      const battery=await navigator.getBattery();
      const sync=()=>apply(!battery.charging||reduced.matches);
      sync();battery.addEventListener('chargingchange',sync);
    }
  }catch(_err){}
}
function showFirstRunWelcome(){}
async function init(){
  await configureNotebookMode();
  applyUiPreferences(); renderShell(); bindGlobal(); await navigate('workspace');
  const results=await Promise.allSettled([get('/api/settings'),get('/api/storage?details=false')]);
  if(results[0].status==='fulfilled')state.settings=results[0].value;
  if(results[1].status==='fulfilled'){state.storage=results[1].value;if(state.storage?.database_warning)toast('O banco local passou de aproximadamente 1 GB. Veja Armazenamento nas configurações.','err');}
  applyUiPreferences(); renderShell(); bindGlobal(); await navigate(state.route||'workspace');
}

function renderShell(){
  document.body.classList.toggle('note-open',!!state.active);
  $('#app').innerHTML=`<div class="app-stage"><div class="app-shell ${state.sidebarCollapsed?'sidebar-collapsed':''}">
    <aside class="sidebar">
      <div class="brand-row"><div class="brand"><img class="brand-app-icon" src="/static/assets/RepositPlus.png" alt=""><span class="brand-name">REPOSIT<span>+</span></span></div><button class="sidebar-toggle" id="sidebar-toggle" aria-label="${state.sidebarCollapsed?'Expandir lateral':'Recolher lateral'}" title="${state.sidebarCollapsed?'Expandir lateral':'Recolher lateral'}">${icon(state.sidebarCollapsed?'angle-right':'angle-left')}</button></div>
      <button class="side-create" id="side-new-note">${icon('plus')}<span>Nova nota</span></button>
      <nav class="nav"><button data-route="workspace" class="${state.route==='workspace'?'active':''}">${icon('document')}<span>Notas</span></button></nav>
      <div class="sidebar-spacer"></div><div class="sidebar-bottom"><button data-route="settings" class="sidebar-feature ${state.route==='settings'?'active':''}">${icon('settings')}<span>Configurações</span></button></div>
    </aside>
    <section class="content-shell"><header class="topbar"><div class="header-copy"><h1 id="header-title">${esc(routeTitle(state.route))}</h1></div><label class="top-search">${icon('search')}<input id="top-search" placeholder="Pesquisar notas..." value="${esc(state.query)}"><span class="search-shortcut">Ctrl F</span></label><div class="top-spacer"></div><button class="top-menu" id="top-menu" title="Configurações">${icon('settings')}</button></header><main class="main" id="main"></main></section>
  </div></div>`;
  $$('[data-route]').forEach(b=>b.onclick=()=>navigate(b.dataset.route));
  $('#sidebar-toggle').onclick=()=>setSidebarCollapsed(!state.sidebarCollapsed);
  $('#side-new-note').onclick=async()=>{if(state.route!=='workspace')await navigate('workspace');createBlankNote({},true);};
  $('#top-menu').onclick=()=>navigate('settings');
  $('#top-search').oninput=e=>{state.query=e.target.value;clearTimeout(searchTimer);searchTimer=setTimeout(async()=>{if(state.route!=='workspace')await navigate('workspace');else await loadNotes();},180);};
  $('#top-search').onkeydown=e=>{if(e.key==='Enter'&&state.notes[0])openNote(state.notes[0].id);};
}



function bindGlobal(){
  const picker=$('#global-file-picker');
  if(picker)picker.onchange=()=>handleFiles([...picker.files]);
  if(window.__repositGlobalBound)return;
  window.__repositGlobalBound=true;
  document.addEventListener('selectionchange',()=>{if(state.active&&$('#notion-content')){selectionManager.remember();updateToolbarState();}});
  document.addEventListener('keydown',async e=>{
    const key=e.key.toLowerCase();
    const editor=$('#notion-content');
    const editorFocused=!!(editor&&(editor===document.activeElement||editor.contains(document.activeElement)));
    if(e.key==='Escape'){
      if($('.note-findbar')){e.preventDefault();closeNoteFind();return;}
      if($('.note-context-menu')){e.preventDefault();closeNoteContextMenu();return;}
      if($('#modal-root').innerHTML){e.preventDefault();closeModal();return;}
    }
    if(state.active&&editorFocused&&e.ctrlKey&&!e.altKey){
      if(key==='b'){e.preventDefault();editorFormat('bold');return;}
      if(key==='i'){e.preventDefault();editorFormat('italic');return;}
      if(key==='u'){e.preventDefault();editorFormat('underline');return;}
      if(key==='z'&&!e.shiftKey){e.preventDefault();editorFormat('undo');return;}
      if(key==='y'||(key==='z'&&e.shiftKey)){e.preventDefault();editorFormat('redo');return;}
      if(key==='k'){e.preventDefault();selectionManager.remember();insertLink();return;}
      if(key==='v'&&e.shiftKey){forcePlainPasteOnce=true;setTimeout(()=>{forcePlainPasteOnce=false;},1000);}
    }
    if(e.ctrlKey&&!e.altKey&&key==='n'){e.preventDefault();if(state.route!=='workspace')await navigate('workspace');await createBlankNote({},true);return;}
    if(e.ctrlKey&&!e.altKey&&key==='s'){e.preventDefault();if(state.active){captureNoteRevision(state.active.id);await saveNotionPage(state.active.id,false,{force:true});}else toast('Tudo salvo.','ok');return;}
    if(e.ctrlKey&&!e.altKey&&key==='f'&&!e.shiftKey){e.preventDefault();if(state.active&&editor)openNoteFind();else{$('#top-search')?.focus();$('#top-search')?.select();}return;}
    if(e.ctrlKey&&e.shiftKey&&key==='f'){e.preventDefault();$('#top-search')?.focus();$('#top-search')?.select();return;}
    if(e.ctrlKey&&!e.altKey&&key==='p'){e.preventDefault();$('#top-search')?.focus();$('#top-search')?.select();return;}
    if(e.ctrlKey&&key===','){e.preventDefault();await navigate('settings');return;}
    if(e.ctrlKey&&key==='/'){e.preventDefault();state.settingsTab='shortcuts';await navigate('settings','shortcuts');return;}
    if(e.ctrlKey&&key==='tab'){e.preventDefault();cycleNoteTab(e.shiftKey?-1:1);return;}
    if(e.ctrlKey&&!e.altKey&&key==='w'&&state.active){e.preventDefault();await closeNoteTab(state.active.id);return;}
    if(e.altKey&&e.key==='ArrowLeft'&&state.active){e.preventDefault();await leaveCurrentNote('back');if(state.active?.parent_note_id)await openNote(state.active.parent_note_id);else{state.active=null;await renderWorkspace();}return;}
    if(e.ctrlKey&&!e.shiftKey&&/^[1-9]$/.test(e.key)){const idx=Number(e.key)-1;if(state.openTabs[idx]){e.preventDefault();openNote(state.openTabs[idx].id);}return;}
    if(e.ctrlKey&&!e.shiftKey&&key==='d'){const id=state.active?.id||([...state.selected][0]);if(id){e.preventDefault();await duplicateNote(id);}return;}
    if(e.ctrlKey&&e.key==='Enter'&&state.route==='workspace'&&!state.active&&state.selected.size===1){e.preventDefault();openNote([...state.selected][0]);return;}
    if((e.key==='Delete'||e.key==='Backspace'&&e.ctrlKey)&&state.route==='workspace'&&!state.active&&state.selected.size&&!['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)){
      e.preventDefault();const ids=[...state.selected];if(ids.length===1)confirmDeleteNote(ids[0]);else confirmDeleteMany(ids);return;
    }
    if(e.key==='F2'&&state.route==='workspace'&&!state.active&&state.selected.size===1){e.preventDefault();const id=[...state.selected][0];const input=$(`[data-inline="title"][data-id="${id}"]`);input?.focus();input?.select();}
  });
  window.addEventListener('dragover',e=>{if(state.route!=='workspace')return;e.preventDefault();$('.drop-zone')?.classList.add('show');});
  window.addEventListener('dragleave',e=>{if(!e.relatedTarget)$('.drop-zone')?.classList.remove('show');});
  window.addEventListener('drop',e=>{if(state.route!=='workspace')return;e.preventDefault();$('.drop-zone')?.classList.remove('show');handleFiles([...e.dataTransfer.files]);});
}

async function navigate(route,section=''){
  if(route==='validator'||route==='wall') route='workspace';
  if(state.active && $('#notion-content')){
    const ok=await leaveCurrentNote(route);if(!ok)return;
  }
  state.route=route;
  if(route==='workspace') state.active=null;
  document.body.classList.remove('note-open');
  $$('[data-route]').forEach(b=>b.classList.toggle('active',b.dataset.route===route));
  setHeader(route);
  if(route==='workspace') await renderWorkspace();
  if(route==='settings') await renderSettings(section);
  animateMain('route');
}

async function renderWorkspace(){
  document.body.classList.remove('note-open','note-dirty');state.noteDirty=false;
  $('#main').innerHTML=`<section class="page workspace-page site-workspace"><div class="workspace-body"><div class="workspace-scroll" id="workspace-scroll"><section class="workspace-section notes-section sheet-section"><div class="workspace-top-controls"><div class="period-tabs period-tabs-large" id="period-tabs"><button data-period="all" class="period-all ${state.period==='all'?'active':''}">${icon('apps')}<span>Todas as notas</span><b>${state.notes.length||''}</b></button><button data-period="today" class="${state.period==='today'?'active':''}">Hoje</button><button data-period="week" class="${state.period==='week'?'active':''}">Esta semana</button><button data-period="month" class="${state.period==='month'?'active':''}">Este mês</button></div><div class="toolbar-spacer"></div><span id="selection-info" class="selection-info"></span><label class="kind-filter">${icon('filter')}<input id="kind-filter" list="kind-options-filter" placeholder="Tipo" value="${esc(state.kind)}"><datalist id="kind-options-filter"><option>Anotação</option><option>Atividade</option><option>Material</option><option>Trabalho</option><option>Resumo</option><option>Lembrete</option></datalist></label><button class="btn soft" id="manage-tags">${icon('tags')} Tags</button><button class="btn primary workspace-new-note" id="workspace-new-note">${icon('plus')} Nova nota</button></div><div id="workspace-tags" class="workspace-tags"></div><div id="notes-content" class="notes-content"><div class="loading-block">Carregando notas…</div></div></section></div><div class="drop-zone"><div>${icon('clip')}<strong>Solte os arquivos aqui</strong></div></div><div id="note-tabbar" class="note-tabbar"></div></div></section>`;
  $('#workspace-new-note').onclick=()=>createBlankNote({},true);
  $('#kind-filter').oninput=e=>{state.kind=e.target.value;clearTimeout(searchTimer);searchTimer=setTimeout(loadNotes,180);};$('#manage-tags').onclick=openTagManager;
  $$('[data-period]').forEach(b=>b.onclick=()=>{state.period=b.dataset.period;$$('[data-period]').forEach(x=>x.classList.toggle('active',x===b));renderSheet();});
  renderNoteTabs();await loadNotes();
}

async function loadNotes(){
  const params=new URLSearchParams();
  if(state.query.trim())params.set('q',state.query.trim());
  if(state.kind.trim())params.set('kind',state.kind.trim());
  if(state.tag.trim())params.set('tag',state.tag.trim());
  params.set('limit','300');
  try{ const [notes,tags]=await Promise.all([get(`/api/notes?${params}`),get('/api/note-tags')]); state.notes=notes;state.noteTags=tags; renderSheet(); }catch(err){ toast(err.message,'err'); }
}

function renderQuickSection(){}

function renderSheet(){
  const wrap=$('#notes-content'); if(!wrap)return;
  const notes=visibleNotes();
  renderWorkspaceTags();
  if(!notes.length){
    wrap.innerHTML=`<div class="empty-notes sheet-empty"><div class="empty-notes-icon">${icon('table-columns')}</div><h3>Nenhuma nota ainda</h3><p>${state.query||state.kind||state.period!=='all'?'Tente limpar os filtros ou pesquise outra coisa.':'Crie sua primeira nota.'}</p><button class="btn primary" id="empty-new">${icon('plus')} Nova nota</button></div>`;
    $('#empty-new').onclick=()=>createBlankNote(); updateSelection(); return;
  }
  renderTableView(wrap,notes);
  wrap.classList.remove('list-refresh');void wrap.offsetWidth;wrap.classList.add('list-refresh');
  updateSelection();
}


function renderWorkspaceTags(){
  const wrap=$('#workspace-tags');if(!wrap)return;
  const tags=(state.noteTags||[]).slice(0,12);
  wrap.innerHTML=`<span class="workspace-tags-label">${icon('tags')} Tags rápidas</span>${tags.map(t=>`<button class="tag-filter-chip ${state.tag.toLowerCase()===String(t.name).toLowerCase()?'active':''}" data-filter-tag="${esc(t.name)}"><span>#${esc(t.name)}</span><b>${t.count}</b></button>`).join('')}${state.tag?`<button class="tag-filter-clear" id="clear-tag-filter">Limpar filtro</button>`:''}`;
  $$('[data-filter-tag]',wrap).forEach(b=>b.onclick=()=>{state.tag=b.dataset.filterTag;loadNotes();});
  $('#clear-tag-filter')?.addEventListener('click',()=>{state.tag='';loadNotes();});
}
function openTagManager(){
  const rows=(state.noteTags||[]);
  modal('Organizar tags',`<div class="tag-manager"><div class="tag-manager-head"><p>Renomeie, filtre ou remova tags de todas as notas. Menos “matematica2_final_agoraVai”, mais organização.</p></div><div class="tag-manager-list">${rows.length?rows.map(t=>`<div class="tag-manager-row"><button class="tag-manager-name" data-tag-filter="${esc(t.name)}">#${esc(t.name)}</button><span>${t.count} nota${t.count===1?'':'s'}</span><button class="row-action" data-tag-rename="${esc(t.name)}">Renomear</button><button class="row-action danger-action" data-tag-remove="${esc(t.name)}">${icon('trash')}</button></div>`).join(''):'<div class="empty-route"><p>Nenhuma tag criada ainda.</p></div>'}</div></div>`,`<button class="btn soft" data-close>Fechar</button>`,'tag-manager-modal');
  $$('[data-tag-filter]').forEach(b=>b.onclick=()=>{state.tag=b.dataset.tagFilter;closeModal();loadNotes();});
  $$('[data-tag-rename]').forEach(b=>b.onclick=async()=>{const old=b.dataset.tagRename;const next=prompt(`Novo nome para #${old}:`,old);if(!next||next===old)return;try{await patch('/api/note-tags/rename',{old,new:next});state.noteTags=await get('/api/note-tags');openTagManager();loadNotes();}catch(err){toast(err.message,'err');}});
  $$('[data-tag-remove]').forEach(b=>b.onclick=async()=>{const name=b.dataset.tagRemove;if(!confirm(`Remover #${name} de todas as notas?`))return;try{await del(`/api/note-tags/${encodeURIComponent(name)}`);state.noteTags=await get('/api/note-tags');openTagManager();loadNotes();}catch(err){toast(err.message,'err');}});
}
function renderCardView(wrap,notes){
  wrap.innerHTML=`<div class="note-grid">${notes.map((n,i)=>`<article class="note-card tone-${noteTone(n,i)} ${state.selected.has(n.id)?'selected':''} ${state.active?.id===n.id?'active':''}" data-note-card="${n.id}">
    <div class="note-card-top"><label class="note-select" title="Selecionar"><input type="checkbox" data-select="${n.id}" ${state.selected.has(n.id)?'checked':''}><span></span></label><span class="note-date">${fmtDate(n.updated_at)}</span><div class="note-actions"><button title="Abrir" data-row-open="${n.id}">${icon('angle-right')}</button></div></div>
    <div class="note-type"><span class="note-type-icon">${icon('document')}</span>${esc(n.kind||'Anotação')}</div>
    <h3>${esc(n.title)}</h3><p>${esc(notePreview(n))}</p>
    ${n.tags?`<div class="note-tags">${esc(n.tags)}</div>`:''}
    <div class="note-card-footer"><span>${icon('document')} ${n.file_count||0} arquivo${Number(n.file_count||0)===1?'':'s'}</span><span>${icon('bookmark')} ${n.pinned?'Fixada':'Nota'}</span><span>${fmtTime(n.updated_at)}</span></div>
  </article>`).join('')}<button class="note-new-card" id="note-new-card"><span>${icon('plus')}</span><strong>Nova nota</strong><small>Escreva, anexe e organize.</small></button></div>`;
  $('#note-new-card').onclick=()=>createBlankNote();
  bindNoteInteractions('[data-note-card]');
}

function renderTableView(wrap,notes){
  wrap.innerHTML=`<div class="table-card site-sheet"><table class="sheet"><thead><tr><th class="check-col"><input id="check-all" type="checkbox"></th><th class="cell-index-col">#</th><th class="title-col">Nome</th><th class="kind-col">Tipo</th><th class="tags-col">Tags</th><th class="date-col">Alterado</th><th class="action-col"></th></tr></thead><tbody>${notes.map((n,idx)=>`<tr data-note-row="${n.id}" class="tone-${noteTone(n,idx)} ${state.selected.has(n.id)?'selected':''}">
    <td class="check-col"><input type="checkbox" data-select="${n.id}" ${state.selected.has(n.id)?'checked':''}></td>
    <td class="cell-index-col"><span class="cell-number">${String(idx+1).padStart(2,'0')}</span></td>
    <td class="title-col"><div class="title-cell"><span class="cell-doc-icon">${icon('document')}</span><input class="cell-input" data-inline="title" data-id="${n.id}" value="${esc(n.title)}"></div></td>
    <td class="kind-col"><input class="cell-input" data-inline="kind" data-id="${n.id}" value="${esc(n.kind)}" list="kind-options"></td>
    <td class="tags-col"><input class="cell-input" data-inline="tags" data-id="${n.id}" value="${esc(n.tags||'')}" placeholder="sem tags"></td>
    <td class="date-col muted2">${fmt(n.updated_at)}</td>
    <td class="action-col"><div class="row-actions"><button class="row-action" title="Abrir" data-row-open="${n.id}">${icon('expand')}</button><button class="row-action danger-action" title="Excluir" data-row-delete="${n.id}">${icon('trash')}</button></div></td>
  </tr>`).join('')}</tbody><tfoot><tr class="sheet-new-row" id="sheet-new-row"><td></td><td class="cell-index-col">+</td><td colspan="5"><button class="sheet-new-inline" id="sheet-new-inline">${icon('plus')} Nova nota</button></td></tr></tfoot></table><datalist id="kind-options"><option>Anotação</option><option>Atividade</option><option>Material</option><option>Trabalho</option><option>Resumo</option><option>Lembrete</option><option>Outro</option></datalist></div>`;
  $('#check-all').onchange=e=>{ if(e.target.checked)notes.forEach(n=>state.selected.add(n.id));else notes.forEach(n=>state.selected.delete(n.id));renderSheet(); };
  $('#sheet-new-inline').onclick=()=>createBlankNote({},true);
  $$('[data-inline]').forEach(i=>{
    i.onblur=async()=>{const id=Number(i.dataset.id), field=i.dataset.inline; try{await patch(`/api/notes/${id}`,{[field]:i.value}); const n=state.notes.find(x=>x.id===id);if(n)n[field]=i.value;updateTabTitle(id,i.value,field);}catch(err){toast(err.message,'err');}};
    i.onclick=e=>e.stopPropagation();
    i.ondblclick=e=>{e.stopPropagation();openNote(Number(i.dataset.id));};
  });
  bindNoteInteractions('[data-note-row]');
}

function bindNoteInteractions(rowSelector){
  $$('[data-select]').forEach(c=>c.onchange=e=>{const id=Number(e.target.dataset.select);e.target.checked?state.selected.add(id):state.selected.delete(id);e.target.closest('tr')?.classList.toggle('selected',e.target.checked);updateSelection();});
  $$(rowSelector).forEach(r=>{
    r.onclick=e=>{
      if(e.target.closest('button,input,label'))return;
      const id=Number(r.dataset.noteRow);
      if(state.selected.has(id))state.selected.delete(id);else state.selected.add(id);
      r.classList.toggle('selected',state.selected.has(id));
      const cb=r.querySelector('[data-select]'); if(cb)cb.checked=state.selected.has(id);
      updateSelection();
    };
    r.ondblclick=e=>{
      if(e.target.closest('button,label'))return;
      e.preventDefault();
      openNote(Number(r.dataset.noteRow));
    };
  });
  $$('[data-row-open]').forEach(b=>b.onclick=e=>{e.stopPropagation();openNote(Number(b.dataset.rowOpen));});
  $$('[data-row-delete]').forEach(b=>b.onclick=e=>{e.stopPropagation();confirmDeleteNote(Number(b.dataset.rowDelete));});
}

function updateSelection(){
  const el=$('#selection-info');
  if(el) el.textContent=state.selected.size?`${state.selected.size} selecionada${state.selected.size>1?'s':''}`:'';

}

function ensureNoteTab(note){
  if(!note?.id)return;
  const payload={
    id:Number(note.id),title:note.title||'Sem título',kind:note.kind||'Anotação',
    parent_note_id:note.parent_note_id?Number(note.parent_note_id):null,
    parent_title:note.parent_note?.title||note.parent_title||''
  };
  const existing=state.openTabs.find(t=>t.id===payload.id);
  if(existing)Object.assign(existing,payload);
  else state.openTabs.push(payload);
}
function updateTabTitle(id,value,field='title'){
  if(field!=='title')return;
  const tab=state.openTabs.find(t=>t.id===Number(id));
  if(tab){tab.title=value||'Sem título';renderNoteTabs();}
}
async function closeNoteTab(id){
  id=Number(id);const idx=state.openTabs.findIndex(t=>t.id===id);
  if(state.active?.id===id&&$('#notion-content'))captureNoteRevision(id);
  const session=noteSessions.get(id);
  if(session?.dirty&&state.settings.autosave_enabled)await saveNotionPage(id,true,{force:true});
  if(session?.dirty){
    const closeAnyway=confirm('Esta nota ainda tem alterações pendentes. Fechar a aba mesmo assim? O Reposit+ manterá um rascunho local para recuperar depois.');
    if(!closeAnyway)return;
  }
  if(session?.timer){clearTimeout(session.timer);session.timer=null;}
  state.openTabs=state.openTabs.filter(t=>t.id!==id);
  if(!session?.dirty&&!session?.inFlight){noteSessions.delete(id);clearNoteDraft(id);selectionManager.clear(id);}
  if(state.active?.id===id){
    const fallback=state.openTabs[Math.min(Math.max(idx-1,0),Math.max(state.openTabs.length-1,0))];
    state.active=null;
    if(fallback)await openNote(fallback.id);else await renderWorkspace();
  }else renderNoteTabs();
}
function renderNoteTabs(){
  const bar=$('#note-tabbar');if(!bar)return;
  const activeId=state.active?.id||0;
  bar.innerHTML=`<button class="note-tab note-tab-home ${!activeId?'active':''}" id="tab-home" title="Todas as notas">${icon('apps')}<span>Todas</span></button>
    <div class="note-tabs-scroll">${state.openTabs.map(t=>`<button class="note-tab ${activeId===t.id?'active':''} ${noteSessions.get(t.id)?.dirty?'dirty':''} ${t.parent_note_id?'subnote-tab':''}" data-tab-note="${t.id}" title="${esc(t.parent_note_id?`${t.parent_title||'Nota'} › ${t.title}`:t.title)}"><span class="tab-doc">${t.parent_note_id?icon('angle-right'):icon('document')}</span><span class="tab-title">${esc(t.title||'Sem título')}</span><span class="tab-close" data-close-tab="${t.id}">${icon('cross-small')}</span></button>`).join('')}</div>
    <button class="note-tab-add" id="tab-new" title="Nova nota">${icon('plus')}</button>`;
  $('#tab-home').onclick=async()=>{if(!(await leaveCurrentNote('workspace')))return;state.active=null;await renderWorkspace();};
  $$('[data-tab-note]').forEach(b=>b.onclick=e=>{if(e.target.closest('[data-close-tab]'))return;openNote(Number(b.dataset.tabNote));});
  $$('[data-close-tab]').forEach(b=>b.onclick=e=>{e.stopPropagation();closeNoteTab(Number(b.dataset.closeTab));});
  $('#tab-new').onclick=()=>createBlankNote({},true);
}
async function createBlankNote(prefill={}, openAfter=false){
  try{
    const n=await post('/api/notes',{title:prefill.title||'Nova anotação',kind:prefill.kind||'Anotação',content:prefill.content||'',tags:prefill.tags||''});
    state.query=''; state.kind='';
    if($('#top-search'))$('#top-search').value='';
    if($('#kind-filter'))$('#kind-filter').value='';
    ensureNoteTab(n);
    await loadNotes();
    state.selected.clear(); state.selected.add(n.id);
    if(openAfter) await openNote(n.id);
    else {renderSheet();toast('Nota criada. Dê dois cliques para abrir.','ok');setTimeout(()=>{const input=$(`[data-inline="title"][data-id="${n.id}"]`);input?.focus();input?.select();},30);}
    return n;
  }catch(err){toast(err.message,'err');}
}
async function openNote(id){
  id=Number(id);const requestSeq=++openNoteRequestSeq;
  try{
    if(state.active&&state.active.id!==id&&$('#notion-content'))await leaveCurrentNote('note');
    state.route='workspace';
    const loaded=await get(`/api/notes/${id}`);
    if(requestSeq!==openNoteRequestSeq)return;
    state.active=materializeSessionNote(loaded);
    if(state.active.parent_note)ensureNoteTab({...state.active.parent_note,parent_note_id:state.active.parent_note.parent_note_id||null});
    ensureNoteTab(state.active);
    $$('[data-route]').forEach(b=>b.classList.toggle('active',b.dataset.route==='workspace'));
    setHeader('workspace');renderNotionPage();animateMain('tab');
  }catch(err){if(requestSeq===openNoteRequestSeq)toast(err.message,'err');}
}
function humanSize(bytes=0){
  const n=Number(bytes)||0;if(n<1024)return `${n} B`;if(n<1048576)return `${(n/1024).toFixed(1)} KB`;return `${(n/1048576).toFixed(1)} MB`;
}
function isImageFile(file){return String(file?.file_type||'').startsWith('image/');}
function isAudioFile(file){return String(file?.file_type||'').startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(file?.filename||'');}
function normalizeMediaLayout(layout={}){
  const rawWidth=String(layout.width??'auto').trim();
  let width='auto';
  if(rawWidth!=='auto' && /^\d{1,3}$/.test(rawWidth)) width=String(Math.max(15,Math.min(100,Number(rawWidth))));
  const ratio=['auto','1x1','4x3','16x9'].includes(String(layout.ratio||''))?String(layout.ratio):'auto';
  const fit=['contain','cover'].includes(String(layout.fit||''))?String(layout.fit):'contain';
  return {width,ratio,fit};
}
function mediaFileToken(fileId,layout={}){
  const m=normalizeMediaLayout(layout);let token=`[[reposit-file:${fileId}`;
  if(m.width!=='auto')token+=`;w=${m.width}`;
  if(m.ratio!=='auto')token+=`;r=${m.ratio}`;
  if(m.fit!=='contain')token+=`;fit=${m.fit}`;
  return `${token}]]`;
}
function parseMediaFileToken(token=''){
  const m=String(token).match(/^\[\[reposit-file:(\d+)(?:;w=(auto|\d{1,3}))?(?:;r=(auto|1x1|4x3|16x9))?(?:;fit=(contain|cover))?\]\]$/);
  return m?{id:m[1],...normalizeMediaLayout({width:m[2]||'auto',ratio:m[3]||'auto',fit:m[4]||'contain'})}:null;
}
function attachmentBlockHtml(file,layout={}){
  const media=normalizeMediaLayout(layout);const token=mediaFileToken(file.id,media);const widthStyle=media.width==='auto'?'':` style="--media-width:${media.width}%"`;
  if(isImageFile(file))return `<figure class="inline-attachment inline-media-image" contenteditable="false" draggable="true" data-file-id="${file.id}" data-media-width="${media.width}" data-media-ratio="${media.ratio}" data-media-fit="${media.fit}" data-file-token="${token}"${widthStyle}><img src="/api/note-files/${file.id}" alt="${esc(file.filename)}" loading="lazy" decoding="async"><span class="media-size-badge">${media.width==='auto'?'Auto':media.width+'%'}</span><span class="media-resize-handle media-resize-left" data-media-resize="left" title="Arraste para redimensionar"></span><span class="media-resize-handle media-resize-right" data-media-resize="right" title="Arraste para redimensionar"></span><span class="inline-media-actions"><button type="button" data-inline-layout="${file.id}" title="Tamanho e proporção">${icon('image')}</button><button type="button" data-inline-open="${file.id}" title="Abrir">${icon('expand')}</button><button type="button" data-inline-delete="${file.id}" title="Remover">${icon('trash')}</button></span></figure>`;
  if(isAudioFile(file))return `<div class="inline-attachment inline-audio" contenteditable="false" draggable="true" data-file-id="${file.id}" data-file-token="[[reposit-file:${file.id}]]"><div class="inline-audio-head"><span>${icon('file')}</span><strong>${esc(file.filename)}</strong><small>${humanSize(file.size)}</small></div><audio controls preload="none" src="/api/note-files/${file.id}"></audio><span class="inline-attachment-actions"><button type="button" data-inline-open="${file.id}" title="Abrir">${icon('expand')}</button><button type="button" data-inline-delete="${file.id}" title="Remover">${icon('trash')}</button></span></div>`;
  return `<span class="inline-attachment inline-file" contenteditable="false" draggable="true" data-file-id="${file.id}" data-file-token="[[reposit-file:${file.id}]]"><span class="inline-attachment-icon">${icon('file')}</span><span class="inline-attachment-copy"><strong>${esc(file.filename)}</strong><small>${esc(file.file_type||'Arquivo')} · ${humanSize(file.size)}</small></span><span class="inline-attachment-actions"><button type="button" data-inline-open="${file.id}" title="Abrir">${icon('expand')}</button><button type="button" data-inline-delete="${file.id}" title="Remover">${icon('trash')}</button></span></span>`;
}
function subnoteBlockHtml(note){
  return `<span class="inline-subnote" contenteditable="false" draggable="true" data-subnote-id="${note.id}" data-subnote-token="[[reposit-subnote:${note.id}]]"><span class="inline-subnote-icon">${icon('document')}</span><span class="inline-subnote-copy"><small>SUBNOTA</small><strong>${esc(note.title||'Sem título')}</strong><span>${esc(note.kind||'Subnota')} · ${fmtDate(note.updated_at)}</span></span><span class="inline-subnote-actions"><button type="button" data-subnote-open="${note.id}" title="Abrir">${icon('angle-right')}</button><button type="button" data-subnote-delete="${note.id}" title="Excluir subnota">${icon('trash')}</button></span></span>`;
}
function textToEditorHtml(text='',files=[]){
  const byId=new Map((files||[]).map(f=>[String(f.id),f]));
  const seen=new Set();
  const parts=String(text||'').split(/(\[\[reposit-file:\d+(?:;w=(?:auto|\d{1,3}))?(?:;r=(?:auto|1x1|4x3|16x9))?(?:;fit=(?:contain|cover))?\]\])/g).map(part=>{
    const token=parseMediaFileToken(part);
    if(token&&byId.has(token.id)){seen.add(token.id);return attachmentBlockHtml(byId.get(token.id),token);}
    return esc(part).replace(/\n/g,'<br>');
  });
  const orphan=(files||[]).filter(f=>!seen.has(String(f.id)));
  if(orphan.length)parts.push((text?'<br>':'')+orphan.map(attachmentBlockHtml).join('<br>'));
  return parts.join('');
}
function contentToEditorHtml(note){
  const files=new Map((note.files||[]).map(f=>[String(f.id),f]));
  const subs=new Map((note.subnotes||[]).map(n=>[String(n.id),n]));
  if(note.content_format!=='html'){
    let html=textToEditorHtml(note.content||'',note.files||[]);
    for(const sub of note.subnotes||[]){
      const token=`[[reposit-subnote:${sub.id}]]`;
      if(!String(note.content||'').includes(token))html+=(html?'<br>':'')+subnoteBlockHtml(sub);
    }
    return html.replace(/\[\[reposit-subnote:(\d+)\]\]/g,(_,id)=>subs.has(id)?subnoteBlockHtml(subs.get(id)):'');
  }
  let html=sanitizeRichHtml(String(note.content||''));
  html=html.replace(/\[\[reposit-file:(\d+)(?:;w=(auto|\d{1,3}))?(?:;r=(auto|1x1|4x3|16x9))?(?:;fit=(contain|cover))?\]\]/g,(_,id,width,ratio,fit)=>files.has(id)?attachmentBlockHtml(files.get(id),{width:width||'auto',ratio:ratio||'auto',fit:fit||'contain'}):'');
  html=html.replace(/\[\[reposit-subnote:(\d+)\]\]/g,(_,id)=>subs.has(id)?subnoteBlockHtml(subs.get(id)):'');
  const presentFiles=new Set([...html.matchAll(/data-file-id="(\d+)"/g)].map(m=>m[1]));
  const orphanFiles=(note.files||[]).filter(f=>!presentFiles.has(String(f.id)));
  if(orphanFiles.length)html+=orphanFiles.map(attachmentBlockHtml).join('');
  return html;
}
const RICH_ALLOWED_TAGS=new Set(['P','DIV','BR','H1','H2','H3','H4','H5','H6','STRONG','B','EM','I','U','S','STRIKE','SUP','SUB','UL','OL','LI','BLOCKQUOTE','A','TABLE','THEAD','TBODY','TFOOT','TR','TD','TH','SPAN','FONT','HR','PRE','CODE']);
const RICH_ALLOWED_STYLES=new Set(['color','background-color','text-align','font-weight','font-style','text-decoration','font-family','font-size','white-space']);
function sanitizeInlineStyle(value=''){
  return String(value).split(';').map(part=>part.trim()).filter(Boolean).map(part=>{const idx=part.indexOf(':');if(idx<1)return '';const key=part.slice(0,idx).trim().toLowerCase(),val=part.slice(idx+1).trim();if(!RICH_ALLOWED_STYLES.has(key))return '';if(/expression|url\s*\(|javascript:/i.test(val))return '';return `${key}:${val}`;}).filter(Boolean).join(';');
}
function sanitizeRichHtml(raw=''){
  const box=document.createElement('div');box.innerHTML=String(raw||'');
  box.querySelectorAll('script,style,iframe,object,embed,link,meta,form,input,button,textarea,select,svg,math').forEach(n=>n.remove());
  [...box.querySelectorAll('*')].forEach(el=>{
    if(!RICH_ALLOWED_TAGS.has(el.tagName)){el.replaceWith(...el.childNodes);return;}
    [...el.attributes].forEach(attr=>{
      const name=attr.name.toLowerCase();
      const allowed=(name==='style')||(el.tagName==='A'&&['href','title','target'].includes(name))||(el.tagName==='FONT'&&['face','size','color'].includes(name))||(['TD','TH'].includes(el.tagName)&&['colspan','rowspan'].includes(name))||(el.tagName==='TABLE'&&name==='data-editor-table')||(el.tagName==='TABLE'&&name==='class');
      if(!allowed||/^on/i.test(name)||name==='srcdoc')el.removeAttribute(attr.name);
    });
    if(el.hasAttribute('style')){const clean=sanitizeInlineStyle(el.getAttribute('style'));if(clean)el.setAttribute('style',clean);else el.removeAttribute('style');}
    if(el.tagName==='TABLE'){if(el.getAttribute('class')!=='editor-table')el.removeAttribute('class');if(el.getAttribute('data-editor-table')!=='1')el.removeAttribute('data-editor-table');}
    if(el.tagName==='A'){const href=el.getAttribute('href')||'';if(!/^(https?:|mailto:|#)/i.test(href))el.removeAttribute('href');if(el.getAttribute('target')==='_blank')el.setAttribute('rel','noopener noreferrer');}
  });
  return box.innerHTML;
}
function insertPlainTextAtSelection(text=''){
  const editor=$('#notion-content');if(!editor)return;selectionManager.restore();const normalized=String(text).replace(/\r\n?/g,'\n');
  if(!document.execCommand('insertText',false,normalized)){const sel=window.getSelection(),range=sel?.rangeCount?sel.getRangeAt(0):null;if(range&&editor.contains(range.startContainer)){range.deleteContents();const node=document.createTextNode(normalized);range.insertNode(node);range.setStartAfter(node);range.collapse(true);sel.removeAllRanges();sel.addRange(range);}}
}
function handleEditorPaste(event){
  const editor=$('#notion-content');if(!editor)return;event.preventDefault();selectionManager.remember();
  const plain=event.clipboardData?.getData('text/plain')||'';const html=event.clipboardData?.getData('text/html')||'';
  if(forcePlainPasteOnce||!html)insertPlainTextAtSelection(plain);else{selectionManager.restore();document.execCommand('insertHTML',false,sanitizeRichHtml(html));}
  forcePlainPasteOnce=false;editor.dispatchEvent(new Event('input',{bubbles:true}));selectionManager.remember();
}
function serializeEditorContent(editor){
  if(!editor)return '';
  const clone=editor.cloneNode(true);
  clone.querySelectorAll('[data-file-token]').forEach(block=>block.replaceWith(document.createTextNode(block.dataset.fileToken||'')));
  clone.querySelectorAll('[data-subnote-token]').forEach(block=>block.replaceWith(document.createTextNode(block.dataset.subnoteToken||'')));
  clone.querySelectorAll('[contenteditable],[draggable]').forEach(el=>{el.removeAttribute('contenteditable');el.removeAttribute('draggable');});
  return sanitizeRichHtml(clone.innerHTML).trim();
}
function insertNodeAtCaret(editor,node){
  editor.focus();const sel=window.getSelection();
  if(sel?.rangeCount&&editor.contains(sel.anchorNode)){const range=sel.getRangeAt(0);range.deleteContents();range.insertNode(node);range.setStartAfter(node);range.collapse(true);sel.removeAllRanges();sel.addRange(range);}else editor.append(node);
  editor.dispatchEvent(new Event('input',{bubbles:true}));
}
function placeAttachmentAtCaret(editor,file){
  if(!editor)return;const wrap=document.createElement('div');wrap.innerHTML=attachmentBlockHtml(file);insertNodeAtCaret(editor,wrap.firstElementChild);
}
function placeSubnoteAtCaret(editor,note){
  if(!editor)return;const wrap=document.createElement('div');wrap.innerHTML=subnoteBlockHtml(note);insertNodeAtCaret(editor,wrap.firstElementChild);
}
function bindInlineAttachments(note){
  const editor=$('#notion-content');if(!editor)return;
  $$('[data-inline-open]',editor).forEach(b=>b.onclick=e=>{e.stopPropagation();window.open(`/api/note-files/${b.dataset.inlineOpen}`,'_blank');});
  $$('[data-inline-layout]',editor).forEach(b=>b.onclick=e=>{e.stopPropagation();const block=b.closest('.inline-media-image');const fake={preventDefault(){},clientX:e.clientX||block.getBoundingClientRect().right-10,clientY:e.clientY||block.getBoundingClientRect().top+36,target:block};openNoteContextMenu(fake,note);});
  $$('[data-inline-delete]',editor).forEach(b=>b.onclick=async e=>{e.stopPropagation();try{await del(`/api/note-files/${b.dataset.inlineDelete}`);e.target.closest('[data-file-token]')?.remove();editor.dispatchEvent(new Event('input',{bubbles:true}));toast('Anexo removido.','ok');}catch(err){toast(err.message,'err');}});
  $$('[data-subnote-open]',editor).forEach(b=>b.onclick=e=>{e.stopPropagation();openNote(Number(b.dataset.subnoteOpen));});
  $$('[data-subnote-delete]',editor).forEach(b=>b.onclick=e=>{e.stopPropagation();deleteInlineSubnote(Number(b.dataset.subnoteDelete),note.id,b.closest('[data-subnote-token]'));});
  $$('[data-subnote-token]',editor).forEach(el=>el.ondblclick=()=>openNote(Number(el.dataset.subnoteId)));
  $$('.inline-media-image',editor).forEach(block=>{
    block.addEventListener('click',e=>{if(e.target.closest('button,.media-resize-handle'))return;$$('.inline-media-image.selected',editor).forEach(x=>x!==block&&x.classList.remove('selected'));block.classList.add('selected');});
    $$('[data-media-resize]',block).forEach(handle=>handle.addEventListener('pointerdown',e=>{
      e.preventDefault();e.stopPropagation();block.classList.add('selected','resizing');block.setAttribute('draggable','false');
      const side=handle.dataset.mediaResize;const startX=e.clientX;const editorWidth=Math.max(240,editor.getBoundingClientRect().width);const startPx=block.getBoundingClientRect().width;
      handle.setPointerCapture?.(e.pointerId);
      const move=ev=>{
        const dx=ev.clientX-startX;const px=side==='left'?startPx-dx:startPx+dx;const pct=Math.round(Math.max(15,Math.min(100,(px/editorWidth)*100)));
        block.dataset.mediaWidth=String(pct);block.style.setProperty('--media-width',`${pct}%`);block.dataset.fileToken=mediaFileToken(block.dataset.fileId,{width:String(pct),ratio:block.dataset.mediaRatio,fit:block.dataset.mediaFit});
        const badge=$('.media-size-badge',block);if(badge)badge.textContent=`${pct}%`;
      };
      const up=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',up);handle.removeEventListener('pointercancel',up);block.classList.remove('resizing');block.setAttribute('draggable','true');editor.dispatchEvent(new Event('input',{bubbles:true}));};
      handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',up);handle.addEventListener('pointercancel',up);
    }));
  });
  editor.addEventListener('pointerdown',e=>{if(!e.target.closest?.('.inline-media-image'))$$('.inline-media-image.selected',editor).forEach(x=>x.classList.remove('selected'));});
  let dragged=null;
  editor.addEventListener('dragstart',e=>{const block=e.target.closest?.('[data-file-token],[data-subnote-token]');if(!block||block.classList.contains('resizing'))return;dragged=block;block.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/x-reposit-block',block.dataset.fileId||block.dataset.subnoteId||'');});
  editor.addEventListener('dragend',()=>{dragged?.classList.remove('dragging');dragged=null;});
  editor.addEventListener('dragover',e=>{if(!dragged)return;e.preventDefault();const target=e.target.closest?.('[data-file-token],[data-subnote-token]');if(target&&target!==dragged){const r=target.getBoundingClientRect();target.parentNode.insertBefore(dragged,e.clientY<r.top+r.height/2?target:target.nextSibling);}});
  editor.addEventListener('drop',e=>{if(dragged){e.preventDefault();dragged.classList.remove('dragging');dragged=null;editor.dispatchEvent(new Event('input',{bubbles:true}));}});
  editor.addEventListener('keydown',e=>{
    if(!['Backspace','Delete'].includes(e.key))return;
    const sel=window.getSelection();if(!sel?.rangeCount||!sel.isCollapsed)return;const range=sel.getRangeAt(0);let candidate=null;
    if(range.startContainer.nodeType===1){candidate=e.key==='Backspace'?range.startContainer.childNodes[range.startOffset-1]:range.startContainer.childNodes[range.startOffset];}
    else if(range.startContainer.nodeType===3){const text=range.startContainer;if(e.key==='Backspace'&&range.startOffset===0)candidate=text.previousSibling;if(e.key==='Delete'&&range.startOffset===text.textContent.length)candidate=text.nextSibling;}
    const block=candidate?.nodeType===1?(candidate.matches?.('[data-subnote-token]')?candidate:candidate.closest?.('[data-subnote-token]')):null;
    if(block){e.preventDefault();deleteInlineSubnote(Number(block.dataset.subnoteId),note.id,block);}
  });
}
function updateInlineImageLayout(block,patch={}){
  if(!block)return;const current=normalizeMediaLayout({width:block.dataset.mediaWidth,ratio:block.dataset.mediaRatio,fit:block.dataset.mediaFit});
  const next=normalizeMediaLayout({...current,...patch});block.dataset.mediaWidth=next.width;block.dataset.mediaRatio=next.ratio;block.dataset.mediaFit=next.fit;block.dataset.fileToken=mediaFileToken(block.dataset.fileId,next);
  if(next.width==='auto')block.style.removeProperty('--media-width');else block.style.setProperty('--media-width',`${next.width}%`);
  const badge=$('.media-size-badge',block);if(badge)badge.textContent=next.width==='auto'?'Auto':`${next.width}%`;
  block.closest('#notion-content')?.dispatchEvent(new Event('input',{bubbles:true}));
}
function imageLayoutMenuHtml(block){
  const m=normalizeMediaLayout({width:block.dataset.mediaWidth,ratio:block.dataset.mediaRatio,fit:block.dataset.mediaFit});
  const active=(kind,value)=>m[kind]===value?' active':'';const slider=m.width==='auto'?100:Number(m.width);
  return `<div class="context-title">Imagem · tamanho</div><div class="image-size-slider"><input type="range" min="15" max="100" step="1" value="${slider}" data-image-slider><output>${m.width==='auto'?'Auto':m.width+'%'}</output></div><div class="context-grid context-grid-5"><button class="${active('width','auto')}" data-image-width="auto">Auto</button><button class="${active('width','25')}" data-image-width="25">25%</button><button class="${active('width','50')}" data-image-width="50">50%</button><button class="${active('width','75')}" data-image-width="75">75%</button><button class="${active('width','100')}" data-image-width="100">100%</button></div><div class="context-title">Proporção</div><div class="context-grid"><button class="${active('ratio','auto')}" data-image-ratio="auto">Original</button><button class="${active('ratio','1x1')}" data-image-ratio="1x1">1:1</button><button class="${active('ratio','4x3')}" data-image-ratio="4x3">4:3</button><button class="${active('ratio','16x9')}" data-image-ratio="16x9">16:9</button></div><div class="context-title">Encaixe</div><div class="context-grid context-grid-2"><button class="${active('fit','contain')}" data-image-fit="contain">Ajustar inteira</button><button class="${active('fit','cover')}" data-image-fit="cover">Preencher/cortar</button></div>`;
}
function rememberEditorSelection(){return selectionManager.remember();}
function restoreEditorSelection(){return selectionManager.restore();}
function contextEditorFormat(command,value=null){selectionManager.restore();editorFormat(command,value);}
function contextEditorBlock(tag){selectionManager.restore();editorBlock(tag);}
function editorFormat(command,value=null){
  const editor=$('#notion-content');if(!editor)return;selectionManager.restore();document.execCommand(command,false,value);editor.dispatchEvent(new Event('input',{bubbles:true}));selectionManager.remember();updateToolbarState();
}
function editorBlock(tag){editorFormat('formatBlock',tag);}
function insertLink(){const url=prompt('Cole o link:','https://');if(url)editorFormat('createLink',url);}
function insertTable(rows=3,cols=3){
  const editor=$('#notion-content');if(!editor)return;const table=document.createElement('table');table.className='editor-table';table.setAttribute('data-editor-table','1');
  const body=document.createElement('tbody');for(let r=0;r<rows;r++){const tr=document.createElement('tr');for(let c=0;c<cols;c++){const td=document.createElement('td');td.innerHTML='<br>';tr.appendChild(td);}body.appendChild(tr);}table.appendChild(body);insertNodeAtCaret(editor,table);
}
function tableCell(){const sel=window.getSelection();return sel?.anchorNode?.nodeType===1?sel.anchorNode.closest?.('td,th'):sel?.anchorNode?.parentElement?.closest?.('td,th');}
function editTable(action){
  const cell=tableCell();if(!cell)return toast('Clique dentro de uma grade primeiro.','err');const row=cell.parentElement,table=cell.closest('table');
  if(action==='row+'){const clone=row.cloneNode(true);clone.querySelectorAll('td,th').forEach(c=>c.innerHTML='<br>');row.after(clone);}
  if(action==='row-'&&table.rows.length>1)row.remove();
  if(action==='col+'){const idx=[...row.children].indexOf(cell);[...table.rows].forEach(r=>{const td=document.createElement('td');td.innerHTML='<br>';r.insertBefore(td,r.children[idx+1]||null);});}
  if(action==='col-'&&row.children.length>1){const idx=[...row.children].indexOf(cell);[...table.rows].forEach(r=>r.children[idx]?.remove());}
  $('#notion-content').dispatchEvent(new Event('input',{bubbles:true}));
}
function commandColorHex(value=''){
  const raw=String(value||'').trim();if(/^#[0-9a-f]{6}$/i.test(raw))return raw;
  const rgb=raw.match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/i);if(!rgb)return null;
  return `#${[rgb[1],rgb[2],rgb[3]].map(v=>Math.max(0,Math.min(255,Number(v))).toString(16).padStart(2,'0')).join('')}`;
}
function updateToolbarState(){
  const editor=$('#notion-content'),toolbar=$('#editor-toolbar'),sel=window.getSelection();if(!editor||!toolbar||!sel?.rangeCount||!editor.contains(sel.anchorNode))return;
  const stateCommands=['bold','italic','underline','justifyLeft','justifyCenter','justifyRight','insertUnorderedList','insertOrderedList'];
  stateCommands.forEach(cmd=>{try{$(`[data-cmd="${cmd}"]`,toolbar)?.classList.toggle('active',document.queryCommandState(cmd));}catch(_err){}});
  try{const block=String(document.queryCommandValue('formatBlock')||'p').replace(/[<>]/g,'').toLowerCase();const select=$('#block-format');if(select&&[...select.options].some(o=>o.value===block))select.value=block;}catch(_err){}
  try{const size=String(document.queryCommandValue('fontSize')||'');const select=$('#font-size');if(select&&[...select.options].some(o=>o.value===size))select.value=size;}catch(_err){}
  try{const color=commandColorHex(document.queryCommandValue('foreColor'));if(color&&$('#text-color'))$('#text-color').value=color;}catch(_err){}
}

function closeNoteContextMenu(){document.querySelector('.note-context-menu')?.remove();}
function openNoteContextMenu(event,n){
  event.preventDefault();rememberEditorSelection();closeNoteContextMenu();
  const menu=document.createElement('div');menu.className='note-context-menu';
  const files=n.files||[];const imageBlock=event.target?.closest?.('.inline-media-image');const subnoteBlock=event.target?.closest?.('[data-subnote-token]');const editor=event.target?.closest?.('#notion-content')||$('#notion-content');
  const selection=window.getSelection();const hasSelection=!!(selection&&selection.toString().trim()&&editor&&editor.contains(selection.anchorNode));
  const submenu=(label,ic,body)=>`<div class="context-entry has-submenu"><button class="context-item">${icon(ic)}<span>${label}</span>${icon('angle-right')}</button><div class="context-submenu">${body}</div></div>`;
  if(imageBlock){
    menu.classList.add('image-context-menu');
    menu.innerHTML=`${imageLayoutMenuHtml(imageBlock)}<div class="context-separator"></div><button class="context-item" data-context-image-open>${icon('expand')}<span>Abrir original</span></button><button class="context-item context-danger" data-context-image-delete>${icon('trash')}<span>Remover imagem</span></button>`;
  }else if(subnoteBlock){
    const sid=Number(subnoteBlock.dataset.subnoteId);
    menu.classList.add('subnote-context-menu');
    menu.innerHTML=`<div class="context-title">Subnota</div><button class="context-item" data-subnote-context-open="${sid}">${icon('document')}<span>Abrir subnota</span></button><button class="context-item context-danger" data-subnote-context-delete="${sid}">${icon('trash')}<span>Excluir subnota</span></button>`;
  }else{
    const formatSub=`<div class="context-subtitle">Estilo</div><button data-context-block="p">${icon('document')} Texto normal</button><button data-context-block="h1"><span class="context-text-icon">H1</span> Título 1</button><button data-context-block="h2"><span class="context-text-icon">H2</span> Título 2</button><button data-context-block="h3"><span class="context-text-icon">H3</span> Título 3</button><div class="context-separator"></div><button data-context-cmd="strikeThrough">${icon('strike')} Tachado</button><button data-context-cmd="superscript">${icon('superscript')} Sobrescrito</button><button data-context-cmd="subscript">${icon('subscript')} Subscrito</button><button data-context-cmd="removeFormat">${icon('clear-format')} Limpar formatação</button><div class="context-separator"></div><label class="context-control">${icon('font')}<span>Fonte</span><select data-context-font><option>Segoe UI</option><option>Arial</option><option>Georgia</option><option>Verdana</option><option>Times New Roman</option><option>Courier New</option></select></label><label class="context-control">${icon('palette')}<span>Texto</span><input type="color" data-context-color value="#55d98b"></label><label class="context-control">${icon('palette')}<span>Marca-texto</span><input type="color" data-context-highlight value="#335d42"></label>`;
    const layoutSub=`<button data-context-cmd="justifyLeft">${icon('align-left')} Alinhar à esquerda</button><button data-context-cmd="justifyCenter">${icon('align-center')} Centralizar</button><button data-context-cmd="justifyRight">${icon('align-right')} Alinhar à direita</button><button data-context-cmd="justifyFull">${icon('align-justify')} Justificar</button><div class="context-separator"></div><button data-context-cmd="insertUnorderedList">${icon('list')} Lista com marcadores</button><button data-context-cmd="insertOrderedList">${icon('numbered-list')} Lista numerada</button><button data-context-cmd="outdent">${icon('outdent')} Diminuir recuo</button><button data-context-cmd="indent">${icon('indent')} Aumentar recuo</button>`;
    const insertSub=`<button data-note-menu="attach">${icon('clip')} Anexar arquivo</button><button data-note-menu="subnote">${icon('plus')} Criar subnota</button><button data-note-menu="table">${icon('table')} Grade 3×3</button><button data-context-cmd="insertHorizontalRule">${icon('horizontal-line')} Linha horizontal</button><button data-note-menu="link">${icon('link')} Link</button>`;
    const fileSub=files.length?submenu(`Anexos (${files.length})`,'file',files.map(f=>`<div class="context-file"><button data-context-open="${f.id}" title="Abrir"><span>${icon('file')} ${esc(f.filename)}</span></button><button class="context-file-remove" data-context-delete="${f.id}" title="Remover">${icon('trash')}</button></div>`).join('')):'';
    menu.innerHTML=`<div class="context-title">${hasSelection?'Texto selecionado':'Nota'}</div><div class="context-quick-actions"><button data-context-cmd="bold" title="Negrito">${icon('bold')}</button><button data-context-cmd="italic" title="Itálico">${icon('italic')}</button><button data-context-cmd="underline" title="Sublinhado">${icon('underline')}</button></div><div class="context-separator"></div>${submenu('Formatação','font',formatSub)}${submenu('Parágrafo e listas','align-left',layoutSub)}${submenu('Inserir','plus',insertSub)}${fileSub}<div class="context-separator"></div><button class="context-item" data-note-menu="export">${icon('export')}<span>Exportar anotação</span></button>${n.parent_note_id?`<button class="context-item context-danger" data-note-menu="delete-subnote">${icon('trash')}<span>Excluir esta subnota</span></button>`:''}`;
  }
  if(event.clientX>window.innerWidth-470)menu.classList.add('submenu-left');
  document.body.appendChild(menu);const rect=menu.getBoundingClientRect();menu.style.left=`${Math.max(8,Math.min(event.clientX,window.innerWidth-rect.width-8))}px`;menu.style.top=`${Math.max(8,Math.min(event.clientY,window.innerHeight-rect.height-8))}px`;
  if(imageBlock){
    $$('[data-image-width]',menu).forEach(b=>b.onclick=()=>{updateInlineImageLayout(imageBlock,{width:b.dataset.imageWidth});closeNoteContextMenu();});
    const sizeSlider=$('[data-image-slider]',menu);if(sizeSlider){sizeSlider.oninput=e=>{updateInlineImageLayout(imageBlock,{width:e.target.value});const out=$('output',menu);if(out)out.textContent=`${e.target.value}%`;};sizeSlider.onchange=()=>closeNoteContextMenu();}
    $$('[data-image-ratio]',menu).forEach(b=>b.onclick=()=>{updateInlineImageLayout(imageBlock,{ratio:b.dataset.imageRatio,fit:b.dataset.imageRatio==='auto'?'contain':imageBlock.dataset.mediaFit});closeNoteContextMenu();});
    $$('[data-image-fit]',menu).forEach(b=>b.onclick=()=>{updateInlineImageLayout(imageBlock,{fit:b.dataset.imageFit});closeNoteContextMenu();});
    $('[data-context-image-open]',menu).onclick=()=>{closeNoteContextMenu();window.open(`/api/note-files/${imageBlock.dataset.fileId}`,'_blank');};
    $('[data-context-image-delete]',menu).onclick=async()=>{try{await del(`/api/note-files/${imageBlock.dataset.fileId}`);imageBlock.remove();editor?.dispatchEvent(new Event('input',{bubbles:true}));closeNoteContextMenu();toast('Imagem removida.','ok');}catch(err){toast(err.message,'err');}};
  }else if(subnoteBlock){
    $('[data-subnote-context-open]',menu).onclick=()=>{const id=Number($('[data-subnote-context-open]',menu).dataset.subnoteContextOpen);closeNoteContextMenu();openNote(id);};
    $('[data-subnote-context-delete]',menu).onclick=()=>{const id=Number($('[data-subnote-context-delete]',menu).dataset.subnoteContextDelete);closeNoteContextMenu();deleteInlineSubnote(id,n.id,subnoteBlock);};
  }else{
    $$('[data-context-cmd]',menu).forEach(b=>b.onmousedown=e=>{e.preventDefault();contextEditorFormat(b.dataset.contextCmd);closeNoteContextMenu();});
    $$('[data-context-block]',menu).forEach(b=>b.onmousedown=e=>{e.preventDefault();contextEditorBlock(b.dataset.contextBlock);closeNoteContextMenu();});
    $('[data-context-font]',menu)?.addEventListener('change',e=>{contextEditorFormat('fontName',e.target.value);closeNoteContextMenu();});
    $('[data-context-color]',menu)?.addEventListener('input',e=>contextEditorFormat('foreColor',e.target.value));
    $('[data-context-highlight]',menu)?.addEventListener('input',e=>contextEditorFormat('hiliteColor',e.target.value));
    $('[data-note-menu="attach"]',menu)?.addEventListener('click',()=>{restoreEditorSelection();closeNoteContextMenu();$('#global-file-picker').click();});
    $('[data-note-menu="subnote"]',menu)?.addEventListener('click',()=>{restoreEditorSelection();closeNoteContextMenu();createSubnote(n.id);});
    $('[data-note-menu="table"]',menu)?.addEventListener('click',()=>{restoreEditorSelection();closeNoteContextMenu();insertTable(3,3);});
    $('[data-note-menu="link"]',menu)?.addEventListener('click',()=>{restoreEditorSelection();closeNoteContextMenu();insertLink();});
    $('[data-note-menu="export"]',menu)?.addEventListener('click',()=>{closeNoteContextMenu();openExportModal(n.id);});
    $('[data-note-menu="delete-subnote"]',menu)?.addEventListener('click',()=>{closeNoteContextMenu();confirmDeleteNote(n.id);});
    $$('[data-context-open]',menu).forEach(b=>b.onclick=()=>{closeNoteContextMenu();window.open(`/api/note-files/${b.dataset.contextOpen}`,'_blank');});
    $$('[data-context-delete]',menu).forEach(b=>b.onclick=async()=>{try{await del(`/api/note-files/${b.dataset.contextDelete}`);closeNoteContextMenu();state.active=materializeSessionNote(await get(`/api/notes/${n.id}`));renderNotionPage();toast('Anexo removido.','ok');}catch(err){toast(err.message,'err');}});
  }
  setTimeout(()=>document.addEventListener('mousedown',e=>{if(!e.target.closest('.note-context-menu'))closeNoteContextMenu();},{once:true}),0);
}
function renderNotionPage(){
  const n=state.active;if(!n)return;
  const session=noteSession(n.id,n);
  document.body.classList.add('note-open');state.noteDirty=!!session?.dirty;
  const main=$('#main');if(!main)return;
  const tagSuggestions=(state.noteTags||[]).map(t=>`<option value="${esc(t.name)}"></option>`).join('');
  const parent=n.parent_note||null;
  main.innerHTML=`<section class="page notion-page rich-note-page ${parent?'subnote-page':''}"><div class="notion-topline"><button class="notion-back" id="notion-back">${icon('angle-left')} Voltar</button><div class="notion-browser-trail">${parent?`<button data-parent-note="${parent.id}">${esc(parent.title||'Nota principal')}</button><span>${icon('angle-right')}</span>`:''}<strong>${esc(n.title||'Sem título')}</strong></div><div class="notion-top-actions"><span class="save-book" id="save-book" aria-hidden="true"><i></i><i></i><i></i></span><span class="autosave-state" id="autosave-state"></span><button class="save-retry" id="save-retry" type="button" hidden>Tentar novamente</button><button class="btn soft" id="notion-pin">${icon('bookmark')} ${n.pinned?'Fixada':'Fixar'}</button><button class="btn soft" id="notion-export">${icon('export')} Exportar</button><button class="btn ghost-danger notion-trash" id="notion-delete" title="Excluir anotação">${icon('trash')}</button></div></div>
    <div class="editor-toolbar editor-toolbar-primary" id="editor-toolbar" role="toolbar"><div class="tool-group tool-history"><button data-cmd="undo" title="Desfazer">${icon('undo')}</button><button data-cmd="redo" title="Refazer">${icon('redo')}</button></div><div class="tool-group tool-block"><select id="block-format" title="Estilo"><option value="p">Texto</option><option value="h1">Título 1</option><option value="h2">Título 2</option><option value="h3">Título 3</option></select><select id="font-size" title="Tamanho"><option value="2">12</option><option value="3" selected>14</option><option value="4">18</option><option value="5">24</option><option value="6">32</option><option value="7">48</option></select></div><div class="tool-group text-tools primary-text-tools"><button data-cmd="bold" title="Negrito">${icon('bold')}</button><button data-cmd="italic" title="Itálico">${icon('italic')}</button><button data-cmd="underline" title="Sublinhado">${icon('underline')}</button></div><div class="tool-group primary-lists"><button data-cmd="insertUnorderedList" title="Lista com marcadores">${icon('list')}</button><button data-cmd="insertOrderedList" title="Lista numerada">${icon('numbered-list')}</button></div><div class="tool-group insert-tools primary-insert"><button id="tool-attach" class="tool-action">${icon('clip')}<span>Arquivo</span></button><button id="tool-subnote" class="tool-action">${icon('plus')}<span>Subnota</span></button></div></div>
    <div class="notion-scroll"><article class="notion-document" id="note-context-area">${parent?`<div class="subnote-banner"><span>SUBNOTA</span><button data-parent-note="${parent.id}">${icon('angle-left')} ${esc(parent.title||'Nota principal')}</button></div>`:''}<input id="notion-title" class="notion-title" value="${esc(n.title)}" placeholder="Sem título"><div class="notion-properties notion-properties-inline"><label><span>${icon('label')}</span><input id="notion-kind" list="notion-kind-options" value="${esc(n.kind||'Anotação')}" aria-label="Tipo"><datalist id="notion-kind-options"><option>Anotação</option><option>Atividade</option><option>Material</option><option>Trabalho</option><option>Resumo</option><option>Lembrete</option><option>Subnota</option><option>Outro</option></datalist></label><label class="tag-property"><span>${icon('tags')}</span><input id="notion-tags" list="note-tag-suggestions" value="${esc(n.tags||'')}" placeholder="Tags separadas por vírgula"><datalist id="note-tag-suggestions">${tagSuggestions}</datalist></label><div class="notion-property-static"><span>${icon('clock')}</span><strong>${fmt(n.updated_at)}</strong></div></div><div class="note-tag-chips" id="note-tag-chips">${renderTagChips(n.tags||'')}</div><div id="notion-content" class="notion-content rich-editor" contenteditable="true" spellcheck="true" data-placeholder="Comece a escrever…">${contentToEditorHtml(n)}</div></article></div><div id="note-tabbar" class="note-tabbar"></div></section>`;
  const leave=async target=>{if(!(await leaveCurrentNote(target)))return false;return true;};
  $('#notion-back').onclick=async()=>{if(!(await leave(parent?'parent':'workspace')))return;if(parent)await openNote(parent.id);else{state.active=null;await renderWorkspace();}};
  $$('[data-parent-note]').forEach(b=>b.onclick=async()=>{if(await leave('parent'))await openNote(Number(b.dataset.parentNote));});
  $('#notion-pin').onclick=async()=>{captureNoteRevision(n.id);if(noteSessions.get(n.id)?.dirty)await saveNotionPage(n.id,true,{force:true});if(noteSessions.get(n.id)?.dirty)return toast('Salve as alterações antes de fixar a nota.','err');const saved=await patch(`/api/notes/${n.id}`,{pinned:!n.pinned});if(state.active?.id===n.id)state.active=materializeSessionNote(saved);ensureNoteTab(saved);renderNotionPage();};
  $('#notion-export').onclick=()=>openExportModal(n.id);$('#notion-delete').onclick=()=>confirmDeleteNote(n.id);$('#note-context-area').oncontextmenu=e=>openNoteContextMenu(e,n);
  const onEditorChange=()=>{captureNoteRevision(n.id,{increment:true});scheduleNoteSave(n.id);};
  ['#notion-title','#notion-kind','#notion-tags','#notion-content'].forEach(sel=>$(sel)?.addEventListener('input',()=>{if(sel==='#notion-tags')$('#note-tag-chips').innerHTML=renderTagChips($('#notion-tags').value);if(sel==='#notion-title')updateTabTitle(n.id,$('#notion-title').value);onEditorChange();}));
  ['#notion-title','#notion-kind','#notion-tags'].forEach(sel=>$(sel)?.addEventListener('blur',()=>{const current=noteSessions.get(n.id);if(state.settings.autosave_enabled&&current?.dirty&&!current.isComposing)void saveNotionPage(n.id,true);}));
  const editor=$('#notion-content');
  editor?.addEventListener('paste',handleEditorPaste);
  editor?.addEventListener('compositionstart',()=>{const current=noteSession(n.id);current.isComposing=true;if(current.timer){clearTimeout(current.timer);current.timer=null;}syncSaveUi(n.id);});
  editor?.addEventListener('compositionend',()=>{const current=noteSession(n.id);current.isComposing=false;captureNoteRevision(n.id);scheduleNoteSave(n.id,450);});
  editor?.addEventListener('keyup',()=>selectionManager.remember(n.id));editor?.addEventListener('mouseup',()=>selectionManager.remember(n.id));
  $('#editor-toolbar')?.addEventListener('pointerdown',()=>selectionManager.remember(n.id),true);
  $$('[data-cmd]').forEach(b=>b.onmousedown=e=>{e.preventDefault();selectionManager.restore(n.id);editorFormat(b.dataset.cmd);});
  $('#block-format').onchange=e=>{selectionManager.restore(n.id);editorBlock(e.target.value);};$('#font-size').onchange=e=>{selectionManager.restore(n.id);editorFormat('fontSize',e.target.value);};
  $('#tool-attach').onclick=()=>{selectionManager.remember(n.id);pendingAttachmentNoteId=n.id;$('#global-file-picker').click();};
  $('#tool-subnote').onclick=()=>{selectionManager.remember(n.id);createSubnote(n.id);};
  $('#save-retry').onclick=async()=>{captureNoteRevision(n.id);await saveNotionPage(n.id,false,{force:true});};
  $$('[data-tag-jump]').forEach(b=>b.onclick=async()=>{if(!(await leave('tag')))return;state.tag=b.dataset.tagJump;state.active=null;await renderWorkspace();});
  bindInlineAttachments(n);renderNoteTabs();syncSaveUi(n.id);setTimeout(()=>{editor?.focus();selectionManager.remember(n.id);updateToolbarState();},30);
}

function renderTagChips(raw=''){
  const tags=String(raw||'').split(/[,;\n]+/).map(x=>x.trim().replace(/^#/, '')).filter(Boolean);
  return [...new Set(tags.map(x=>x.toLowerCase()))].map(k=>tags.find(x=>x.toLowerCase()===k)).map(t=>`<button type="button" class="note-tag-chip" data-tag-jump="${esc(t)}">#${esc(t)}</button>`).join('');
}
async function createSubnote(parentId){
  parentId=Number(parentId);
  try{
    selectionManager.remember(parentId);
    const child=await post(`/api/notes/${parentId}/subnotes`,{title:'Nova subnota'});
    if(state.active?.id!==parentId)return;
    selectionManager.restore(parentId);placeSubnoteAtCaret($('#notion-content'),child);
    await saveNotionPage(parentId,true,{force:true});
    ensureNoteTab(state.active);ensureNoteTab({...child,parent_note_id:parentId,parent_title:state.active.title});
    await openNote(child.id);setTimeout(()=>{$('#notion-title')?.focus();$('#notion-title')?.select();},60);toast('Subnota criada em uma nova aba.','ok');
  }catch(err){toast(err.message,'err');}
}
function applySavedNoteResult(id,saved,sentRevision){
  const session=noteSessions.get(Number(id));if(!session)return;
  const tabNote=session.dirty&&session.payload&&session.saveRevision>sentRevision?{...saved,...session.payload}:saved;
  ensureNoteTab(tabNote);const idx=state.notes.findIndex(x=>Number(x.id)===Number(id));if(idx>=0)Object.assign(state.notes[idx],saved);
  if(state.active?.id===Number(id)){
    const hasNewer=session.dirty&&session.saveRevision>sentRevision;
    state.active=hasNewer&&session.payload?{...saved,...session.payload,edit_revision:session.savedRevision}:saved;
    const crumb=$('.notion-browser-trail strong');if(crumb)crumb.textContent=(hasNewer?session.payload?.title:saved.title)||'Sem título';
    const stamp=$('.notion-property-static strong');if(stamp)stamp.textContent=fmt(saved.updated_at);
    showSaveAnimation();
  }
}
async function saveNotionPage(id,quiet=false,options={}){
  id=Number(id);const force=!!options.force;const session=noteSession(id,state.active?.id===id?state.active:null);if(!session)return true;
  if(state.active?.id===id&&$('#notion-content'))captureNoteRevision(id);
  if(session.timer){clearTimeout(session.timer);session.timer=null;}
  if(!session.dirty){syncSaveUi(id);return true;}
  const maxPasses=force?6:3;
  for(let pass=0;pass<maxPasses&&session.dirty;pass++){
    if(session.inFlight){await session.inFlight;continue;}
    if(!session.payload){session.error='A revisão pendente não possui conteúdo recuperável.';persistNoteDraft(session);syncSaveUi(id);break;}
    const sentRevision=session.saveRevision;const payload={...session.payload,save_revision:sentRevision};session.error=null;syncSaveUi(id);
    session.inFlight=(async()=>{
      try{
        const saved=await patch(`/api/notes/${id}`,payload);const ack=Math.max(sentRevision,Number(saved?.edit_revision||sentRevision));
        session.savedRevision=Math.max(session.savedRevision,ack);session.error=null;
        if(session.savedRevision>=session.saveRevision){session.dirty=false;session.payload=null;clearNoteDraft(id);}else{session.dirty=true;persistNoteDraft(session);}
        applySavedNoteResult(id,saved,sentRevision);return true;
      }catch(err){
        const latest=Number(err?.data?.detail?.current_revision);
        if(err?.status===409&&Number.isFinite(latest)){
          session.savedRevision=Math.max(session.savedRevision,latest);session.saveRevision=Math.max(session.saveRevision,latest+1);session.dirty=true;session.error='Conflito de revisão detectado. A versão atual será reenviada.';persistNoteDraft(session);return 'retry';
        }
        session.dirty=true;session.error=err?.message||'Erro ao salvar';persistNoteDraft(session);if(!quiet)toast(session.error,'err');return false;
      }finally{session.inFlight=null;syncSaveUi(id);}
    })();
    syncSaveUi(id);
    const result=await session.inFlight;
    if(result===false)break;
    if(result==='retry')continue;
    if(!force&&!session.dirty)break;
  }
  if(session.dirty&&state.settings.autosave_enabled&&!session.error)scheduleNoteSave(id,900);
  syncSaveUi(id);return !session.dirty;
}

async function deleteInlineSubnote(id,parentId,block=null){
  modal('Excluir subnota','<p>A subnota será removida da nota principal. Essa ação não apaga os outros conteúdos.</p>',`<button class="btn soft" data-close>Cancelar</button><button class="btn danger" id="confirm-delete-subnote">${icon('trash')} Excluir subnota</button>`);
  $('#confirm-delete-subnote').onclick=async()=>{try{await del(`/api/notes/${id}`);state.openTabs=state.openTabs.filter(t=>t.id!==Number(id));block?.remove();closeModal();if(state.active?.id===Number(parentId)){const editor=$('#notion-content');editor?.dispatchEvent(new Event('input',{bubbles:true}));await saveNotionPage(Number(parentId),true,{force:true});state.active=materializeSessionNote(await get(`/api/notes/${parentId}`));}toast('Subnota excluída.','ok');}catch(err){toast(err.message,'err');}};
}
function openExportModal(id){
  const formats=[['pdf','PDF'],['docx','Word (.docx)'],['html','HTML'],['md','Markdown'],['rtf','RTF'],['txt','Texto (.txt)'],['json','JSON']];
  modal('Exportar anotação',`<div class="export-format-grid">${formats.map(([fmt,label])=>`<button class="export-format" data-export-format="${fmt}">${icon(fmt==='pdf'?'document':'export')}<span>${label}</span></button>`).join('')}</div><p class="settings-help">PDF e Word exportam uma cópia independente. HTML preserva melhor a formatação rica; TXT, Markdown, RTF e JSON servem para edição e interoperabilidade.</p>`,`<button class="btn soft" data-close>Cancelar</button>`,'export-note-modal');
  $$('[data-export-format]').forEach(b=>b.onclick=async()=>{try{if(state.active?.id===Number(id)&&noteSessions.get(Number(id))?.dirty){const saved=await saveNotionPage(Number(id),false,{force:true});if(!saved)return toast('A exportação foi cancelada porque ainda existem alterações pendentes.','err');}const result=await window.pywebview?.api?.export_note?.(Number(id),b.dataset.exportFormat);if(result?.ok){closeModal();toast(`Anotação exportada em ${String(result.format||'').toUpperCase()}.`,'ok');}else if(result?.error)toast(result.error,'err');}catch(err){toast(err.message,'err');}});
}
function confirmDeleteNote(id){const current=state.active?.id===Number(id)?state.active:null;const parentId=current?.parent_note_id||current?.parent_note?.id||null;const isSub=!!parentId;modal(isSub?'Excluir subnota':'Excluir anotação',`<p>${isSub?'Essa subnota':'Essa anotação'} será removida do Reposit+.</p>`,`<button class="btn soft" data-close>Cancelar</button><button class="btn danger" id="confirm-delete">${icon('trash')} Excluir</button>`);$('#confirm-delete').onclick=async()=>{try{await del(`/api/notes/${id}`);state.selected.delete(id);state.openTabs=state.openTabs.filter(t=>t.id!==Number(id));state.active=null;closeModal();toast(isSub?'Subnota excluída.':'Nota excluída.','ok');if(parentId)await openNote(Number(parentId));else await renderWorkspace();}catch(err){toast(err.message,'err');}};}
function confirmDeleteMany(ids){modal('Excluir anotações',`<p>${ids.length} anotações serão removidas permanentemente.</p>`,`<button class="btn soft" data-close>Cancelar</button><button class="btn danger" id="confirm-delete-many">Excluir ${ids.length}</button>`);$('#confirm-delete-many').onclick=async()=>{try{for(const id of ids)await del(`/api/notes/${id}`);ids.forEach(id=>{state.selected.delete(id);state.openTabs=state.openTabs.filter(t=>t.id!==Number(id));});closeModal();toast('Anotações excluídas.','ok');await renderWorkspace();}catch(err){toast(err.message,'err');}};}

async function handleFiles(files){
  if(!files.length)return;
  let targetId=Number(pendingAttachmentNoteId||state.active?.id||0);pendingAttachmentNoteId=null;
  for(const file of files){
    try{
      let note=targetId?(state.active?.id===targetId?state.active:await get(`/api/notes/${targetId}`)):null;
      if(!note){const title=file.name.replace(/\.[^.]+$/,'');note=await post('/api/notes',{title,kind:'Material',content:'',tags:''});targetId=Number(note.id);state.active=note;ensureNoteTab(note);renderNotionPage();}
      const fd=new FormData();fd.append('file',file);const uploaded=await form(`/api/notes/${note.id}/files`,fd);
      if(state.active?.id===Number(note.id)){
        const fresh=await get(`/api/notes/${note.id}`);state.active=materializeSessionNote(fresh);
        selectionManager.restore(note.id);placeAttachmentAtCaret($('#notion-content'),uploaded);bindInlineAttachments(state.active);
        await saveNotionPage(note.id,true,{force:true});
      }
    }catch(err){toast(`${file.name}: ${err.message}`,'err');}
  }
  const picker=$('#global-file-picker');if(picker)picker.value='';await loadNotes();
}



async function renderSettings(section=''){
  [state.settings,state.appInfo,state.storage]=await Promise.all([get('/api/settings'),get('/api/app-info'),get('/api/storage')]);applyUiPreferences();
  if(section)state.settingsTab=section;
  if(!['general','shortcuts','backup','about'].includes(state.settingsTab))state.settingsTab='general';
  const tabs=[['general','settings','Geral'],['shortcuts','bolt','Atalhos'],['backup','download','Backup'],['about','info','Sobre']];
  $('#main').innerHTML=`<section class="page route-page settings-v2"><div class="settings-layout"><aside class="settings-tabs">${tabs.map(([id,ic,label])=>`<button data-settings-tab="${id}" class="${state.settingsTab===id?'active':''}">${icon(ic)}<span>${label}</span></button>`).join('')}</aside><div class="settings-panel"><div class="settings-save-state"><span class="settings-pulse"></span><b id="settings-save-state">Configurações salvas</b></div><div id="settings-pane"></div></div></div></section>`;
  $$('[data-settings-tab]').forEach(b=>b.onclick=()=>{state.settingsTab=b.dataset.settingsTab;renderSettingsPane();$$('[data-settings-tab]').forEach(x=>x.classList.toggle('active',x===b));});renderSettingsPane();animateMain('route');
}
function renderSettingsPane(){
  const pane=$('#settings-pane');if(!pane)return;const tab=state.settingsTab;
  if(tab==='general')pane.innerHTML=`<div class="settings-pane-head"><span class="settings-accent violet"></span><div><h2>Geral e desempenho</h2><p>Interface única, consistente e equilibrada para uso diário.</p></div></div><div class="settings-form"><label class="settings-switch"><span><strong>Salvamento automático</strong><small>Quando desligado, alterações ficam marcadas até Ctrl+S.</small></span><input id="autosave-enabled" type="checkbox" ${state.settings.autosave_enabled?'checked':''}></label><label class="settings-switch"><span><strong>Economia de bateria</strong><small>Reduz animações e atividade em segundo plano quando você preferir.</small></span><input id="battery-saver" type="checkbox" ${state.settings.battery_saver?'checked':''}></label></div>`;
  if(tab==='shortcuts')pane.innerHTML=`<div class="settings-pane-head"><span class="settings-accent green"></span><div><h2>Atalhos</h2><p>Comandos principais.</p></div></div><div class="shortcut-grid">${[['Ctrl + N','Nova nota'],['Ctrl + S','Salvar agora'],['Ctrl + F','Buscar nesta nota'],['Ctrl + Shift + F / Ctrl + P','Pesquisar notas'],['Ctrl + K','Inserir link'],['Ctrl + Tab','Próxima nota'],['Ctrl + Shift + Tab','Nota anterior'],['Ctrl + W','Fechar nota'],['Ctrl + 1…9','Ir para aba'],['Ctrl + D','Duplicar nota'],['F2','Renomear'],['Delete','Excluir'],['Left Ctrl + Left Alt','Abrir/fechar Quick'],['Esc','Fechar Quick/menu']].map(([k,v])=>`<div><kbd>${k}</kbd><span>${v}</span></div>`).join('')}</div>`;
  if(tab==='backup')pane.innerHTML=`<div class="settings-pane-head"><span class="settings-accent green"></span><div><h2>Backup</h2><p>Banco, configurações e anexos em um arquivo .reposit.</p></div></div><div class="backup-actions"><button class="btn primary" id="export-backup">${icon('download')} Exportar</button><button class="btn soft" id="import-backup">${icon('upload')} Importar</button></div>`;
  if(tab==='about'){const info=state.appInfo||{},st=state.storage||{};pane.innerHTML=`<div class="settings-pane-head"><span class="settings-accent violet"></span><div><h2>Sobre e armazenamento</h2><p>Uso local do Reposit+.</p></div></div><div class="about-app-card"><div class="about-app-mark">R+</div><div class="grow"><strong>Reposit+ ${esc(info.version||'')}</strong><span>${esc(info.distribution_label||'Aplicativo')}</span></div><span class="about-build-chip">v${esc(info.version||'')}</span></div><div class="storage-grid"><div><small>Banco</small><strong>${humanSize(st.database||0)}</strong></div><div><small>Anexos</small><strong>${humanSize(st.attachments||0)}</strong></div><div><small>Cache</small><strong>${humanSize(st.cache||0)}</strong></div><div><small>Total</small><strong>${humanSize(st.total||0)}</strong></div></div>${st.database_warning?'<div class="storage-warning">O banco local passou de aproximadamente 1 GB. Rode a manutenção.</div>':''}<div class="about-info-grid"><div><small>Dados do usuário</small><strong class="path-value">${esc(info.data_path||'-')}</strong></div><div><small>Ícones</small><strong>Windows · Segoe Fluent/MDL2</strong></div></div><div class="about-actions"><button class="btn soft" id="open-data-folder">${icon('folder-open')} Abrir pasta</button><button class="btn soft" id="run-maintenance">Manutenção do banco</button></div>`;}
  bindSettingsAutosave();
}

function settingsSaving(text='Salvando…'){$('#settings-save-state')&&($('#settings-save-state').textContent=text);$('.settings-pulse')?.classList.toggle('saving',text.includes('Salvando'));}
let settingsSaveTimer=null;
function scheduleSettingsSave(fn){settingsSaving();clearTimeout(settingsSaveTimer);settingsSaveTimer=setTimeout(async()=>{try{await fn();settingsSaving('Configurações salvas');}catch(err){settingsSaving('Erro ao salvar');toast(err.message,'err');}},420);}
function bindSettingsAutosave(){
  $('#autosave-enabled')?.addEventListener('change',e=>scheduleSettingsSave(async()=>{state.settings=await patch('/api/settings',{autosave_enabled:e.target.checked});if(state.settings.autosave_enabled){noteSessions.forEach(session=>{if(session.dirty)scheduleNoteSave(session.id,120);});}else{noteSessions.forEach(session=>{if(session.timer){clearTimeout(session.timer);session.timer=null;}});}if(state.active?.id)syncSaveUi(state.active.id);}));
  $('#battery-saver')?.addEventListener('change',e=>scheduleSettingsSave(async()=>{state.settings=await patch('/api/settings',{battery_saver:e.target.checked});applyUiPreferences();}));
  $('#open-data-folder')?.addEventListener('click',async()=>{const r=await window.pywebview?.api?.open_data_folder();if(r?.error)toast(r.error,'err');});
  $('#run-maintenance')?.addEventListener('click',async()=>{try{const r=await post('/api/storage/maintenance',{force:false});state.storage=r.storage;toast('Manutenção concluída sem tocar nos seus anexos.','ok');renderSettingsPane();}catch(err){toast(err.message,'err');}});
  $('#export-backup')?.addEventListener('click',async()=>{try{const r=await window.pywebview?.api?.export_backup();if(r?.ok)toast('Backup exportado.','ok');else if(r?.error)toast(r.error,'err');}catch(err){toast(err.message,'err');}});
  $('#import-backup')?.addEventListener('click',async()=>{try{const r=await window.pywebview?.api?.import_backup();if(r?.ok)toast('Backup importado. Reinicie o app.','ok');else if(r?.error)toast(r.error,'err');}catch(err){toast(err.message,'err');}});
}

window.addEventListener('beforeunload',event=>{
  if(state.active?.id&&$('#notion-content'))captureNoteRevision(state.active.id);
  noteSessions.forEach(session=>{if(session.dirty)persistNoteDraft(session);});
  if(hasPendingNoteChanges()){event.preventDefault();event.returnValue='';}
});
window.addEventListener('pagehide',()=>{if(state.active?.id&&$('#notion-content'))captureNoteRevision(state.active.id);noteSessions.forEach(session=>{if(session.dirty)persistNoteDraft(session);});});
window.addEventListener('error', event => {
  console.error('Reposit+ frontend error:', event.error || event.message);
});
window.addEventListener('unhandledrejection', event => {
  console.error('Reposit+ unhandled promise:', event.reason);
  const root=document.getElementById('app');
  if(root && root.querySelector('.boot-screen')){
    root.innerHTML='<div class="fatal-error">A interface encontrou um erro ao iniciar. Feche e abra o Reposit+ novamente.</div>';
  }
});

window.RepositUI={
  openNote: async id=>{await navigate('workspace');await openNote(id);},
  createBlankNote: ()=>createBlankNote({},false),
  refreshSettings: async()=>{state.settings=await get('/api/settings');applyUiPreferences();},
  runCommand: async id=>{
    if(id==='new-note') return createBlankNote({},false);
    if(id==='settings') return navigate('settings');
  }
};

init();
