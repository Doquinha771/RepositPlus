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
  const method=String(opts.method||'GET').toUpperCase();
  if(method!=='GET'&&state?.appInfo?.api_token) opts.headers['X-Reposit-Token']=state.appInfo.api_token;
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
  appInfo:{name:'Reposit+',version:'0.7.4.2',distribution:'source',distribution_label:'Código-fonte',data_path:'',note_content_limit:120000},
  query:'', kind:'', tag:'', noteTags:[], period:'all', sort:'updated', view:'table', ecoMode:false, noteDirty:false, storage:null, searchHasMore:false, searchOffset:0
};
const NOTE_DRAFT_PREFIX='reposit.note-draft.';
const noteSessions=new Map();
const noteViewStates=new Map();
const specialHistories=new Map();
const uploadingFiles=new Set();
let selectedInlineBlock=null;
let replaceImageTarget=null;
const DEFAULT_NOTE_CONTENT_LIMIT=120000;
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
  setRange(noteId,range){const id=Number(noteId||0);if(!id||!range)return false;this.ranges.set(id,range.cloneRange());return true;}
  clear(noteId){this.ranges.delete(Number(noteId||0));}
}
const selectionManager=new SelectionManager();

function noteDraftKey(id){return `${NOTE_DRAFT_PREFIX}${Number(id)}`;}
function readNoteDraft(id){try{const raw=localStorage.getItem(noteDraftKey(id));return raw?JSON.parse(raw):null;}catch(_err){return null;}}
function clearNoteDraft(id){try{localStorage.removeItem(noteDraftKey(id));}catch(_err){}}
function persistNoteDraft(session){
  if(!session?.dirty||!session.payload)return;
  const now=Date.now();
  try{localStorage.setItem(noteDraftKey(session.id),JSON.stringify({note_id:session.id,title:session.payload.title||'',content:session.payload.content||'',revision:session.saveRevision,saveRevision:session.saveRevision,payload:session.payload,timestamp:now,updatedAt:now}));}
  catch(_err){session.error='Não foi possível guardar o rascunho local.';}
}
function noteSession(id,note=null){
  id=Number(id);if(!id)return null;
  let session=noteSessions.get(id);
  const serverRevision=Math.max(0,Number(note?.edit_revision||0));
  if(!session){
    const rawDraft=readNoteDraft(id);
    const draft=window.RepositEditor072?.recovery?.normalizeDraft(rawDraft,id)||rawDraft;
    const draftRevision=Math.max(0,Number(draft?.revision??draft?.saveRevision??0));
    const recoveryDraft=!!(draft?.payload&&draftRevision>serverRevision)?draft:null;
    session={id,saveRevision:serverRevision,savedRevision:serverRevision,payload:null,dirty:false,inFlight:null,timer:null,captureTimer:null,error:null,isComposing:false,recoveryDraft,recoveryOffered:false};
    noteSessions.set(id,session);
    if(!recoveryDraft&&rawDraft)clearNoteDraft(id);
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
function markEditorDirty(id){
  id=Number(id);const session=noteSession(id,state.active?.id===id?state.active:null);if(!session)return;session.saveRevision=Math.max(session.saveRevision,session.savedRevision)+1;session.dirty=true;session.payload=null;clearTimeout(session.captureTimer);session.captureTimer=setTimeout(()=>{session.captureTimer=null;captureNoteRevision(id);updateContentLimitUi();},180);syncSaveUi(id);
}
function contentLimit(){return Math.max(1000,Number(state.appInfo?.note_content_limit||DEFAULT_NOTE_CONTENT_LIMIT));}
function updateContentLimitUi(){const el=$('#content-limit-state'),editor=$('#notion-content');if(!el||!editor)return;const size=serializeEditorContent(editor).length,limit=contentLimit(),ratio=size/limit;el.textContent=ratio>=.85?`${Math.round(size/1000)}k / ${Math.round(limit/1000)}k`:'';el.classList.toggle('warn',ratio>=.85);el.classList.toggle('over',size>limit);}
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
    'angle-left':'E72B','angle-right':'E72A','book':'E736','apps':'F0E2','bolt':'E945','bookmark':'E8A4',
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
  document.documentElement.classList.toggle('soft-contrast',localStorage.getItem('reposit.soft-contrast')==='1');
}

function showSaveAnimation(){
  const el=$('#save-book');if(!el)return;
  el.classList.remove('play');void el.offsetWidth;el.classList.add('play');
  setTimeout(()=>el.classList.remove('play'),1600);
}
function saveNoteViewState(id=state.active?.id){
  const noteId=Number(id||0),scroll=$('.notion-scroll');if(!noteId)return;selectionManager.remember(noteId);
  const previous=noteViewStates.get(noteId)||{};
  const find=$('.note-findbar input')?.value ?? previous.find ?? '';
  noteViewStates.set(noteId,{...previous,scrollTop:Math.max(0,scroll?.scrollTop||0),find:String(find||'').slice(0,200)});
}
function restoreNoteViewState(id=state.active?.id){
  const noteId=Number(id||0),view=noteViewStates.get(noteId),scroll=$('.notion-scroll'),editor=$('#notion-content');
  if(scroll&&view)scroll.scrollTop=Math.max(0,Number(view.scrollTop||0));
  if(!selectionManager.restore(noteId))editor?.focus({preventScroll:true});
}
function persistWorkspaceSession(){
  if(state.active?.id&&$('#notion-content'))saveNoteViewState(state.active.id);
  const ws=window.RepositWorkspace073;if(!ws)return false;
  const tabs=state.openTabs.slice(0,ws.MAX_TABS||100).map(t=>{const view=noteViewStates.get(Number(t.id))||{};return{id:Number(t.id),scrollTop:Number(view.scrollTop||0),find:String(view.find||'')};});
  return ws.save({tabs,activeId:Number(state.active?.id||0)});
}
async function restoreWorkspaceSession(){
  if(state.settings?.restore_workspace===false)return 0;
  const saved=window.RepositWorkspace073?.load?.();if(!saved?.tabs?.length)return 0;
  try{
    const rows=await post('/api/notes/meta',{ids:saved.tabs.map(t=>t.id)});const byId=new Map(rows.map(r=>[Number(r.id),r]));
    state.openTabs=[];
    for(const entry of saved.tabs){const note=byId.get(Number(entry.id));if(!note)continue;ensureNoteTab(note,{persist:false});noteViewStates.set(Number(note.id),{scrollTop:Number(entry.scrollTop||0),find:String(entry.find||'')});}
    const active=state.openTabs.some(t=>t.id===Number(saved.activeId))?Number(saved.activeId):(state.openTabs[0]?.id||0);
    if(active){await openNote(active);restoreNoteViewState(active);}else await renderWorkspace();
    // Persist only after the restored scroll/find state has been applied. Doing
    // this before restoreNoteViewState would overwrite a saved scroll position
    // with the freshly rendered editor's initial scrollTop=0.
    persistWorkspaceSession();return state.openTabs.length;
  }catch(_err){window.RepositWorkspace073?.clear?.();return 0;}
}
async function leaveCurrentNote(target){
  if(!state.active||!$('#notion-content'))return true;
  const id=Number(state.active.id),session=captureNoteRevision(id);
  saveNoteViewState(id);
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
    if(['all','favorites','recent','trash'].includes(state.period)) return true;
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


function updateWindowUiScale(){
  // Keep the complete desktop layout instead of hiding controls when the native
  // window becomes smaller. CSS zoom is supported by WebView2 and effectively
  // behaves like a local DPI adjustment without changing Windows' global scale.
  const widthScale=window.innerWidth/1180;
  const heightScale=window.innerHeight/720;
  const scale=Math.max(0.74,Math.min(1,widthScale,heightScale));
  document.body.style.zoom=scale<0.995?scale.toFixed(3):'1';
  document.body.style.width=scale<0.995?`${window.innerWidth/scale}px`:'100%';
  document.body.style.height=scale<0.995?`${window.innerHeight/scale}px`:'100%';
  const stage=$('.app-stage');
  if(stage){stage.style.width=scale<0.995?`${window.innerWidth/scale}px`:'100%';stage.style.height=scale<0.995?`${window.innerHeight/scale}px`:'100vh';}
  document.documentElement.style.setProperty('--window-ui-scale',String(scale));
  document.documentElement.classList.toggle('window-ui-scaled',scale<0.995);
}

function workspacePeriodLabel(period=state.period){
  return ({favorites:'Favoritas',recent:'Recentes',today:'Hoje',week:'Esta semana',trash:'Lixeira'})[period]||'Sem filtro';
}
function closeWorkspaceFilterMenu({restoreFocus=false}={}){
  const menu=$('#period-filter-menu'),toggle=$('#period-filter-toggle');
  if(menu)menu.setAttribute('hidden','');
  if(toggle)toggle.setAttribute('aria-expanded','false');
  if(restoreFocus)toggle?.focus({preventScroll:true});
}
function syncWorkspaceFilterUi(){
  const active=['favorites','recent','today','week'].includes(state.period);
  const toggle=$('#period-filter-toggle');
  if(toggle){
    toggle.classList.toggle('active',active);
    const label=active?workspacePeriodLabel(state.period):'Filtrar notas';
    toggle.title=label;
    toggle.setAttribute('aria-label',label);
  }
  $$('[data-period-option]').forEach(button=>{
    const selected=button.dataset.periodOption===state.period;
    button.classList.toggle('selected',selected);
    button.setAttribute('aria-checked',String(selected));
    button.querySelector('.filter-option-check')?.toggleAttribute('hidden',!selected);
  });
  const clear=$('#period-filter-clear');
  if(clear)clear.hidden=!active;
  $('[data-period="all"]')?.classList.toggle('active',state.period==='all');
  $('#trash-filter')?.classList.toggle('active',state.period==='trash');
}
function applyWorkspacePeriod(period){
  state.period=period||'all';
  closeWorkspaceFilterMenu();
  syncWorkspaceFilterUi();
  return loadNotes();
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
  try{const n=await post(`/api/notes/${id}/duplicate`,{});ensureNoteTab(n);toast('Nota duplicada.','ok');await navigate('workspace');await openNote(n.id);return n;}catch(err){toast(err.message,'err');}
}

function execEditorCommand(command,value=null){
  const editor=$('#notion-content');
  if(!editor || !editor.contains(document.activeElement) && document.activeElement!==editor)return false;
  document.execCommand(command,false,value); return true;
}
function closeNoteFind(){document.querySelector('.note-findbar')?.remove();selectionManager.restore();}
function findTextInEditor(query,backwards=false){
  const editor=$('#notion-content');if(!editor||!query)return {found:false,index:0,total:0};
  const walker=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT);const nodes=[];let text='',node;
  while((node=walker.nextNode())){if(node.parentElement?.closest('.productivity-ephemeral'))continue;nodes.push({node,start:text.length,end:text.length+node.textContent.length});text+=node.textContent;}
  const hay=text.toLocaleLowerCase(),needle=String(query).toLocaleLowerCase();if(!needle)return {found:false,index:0,total:0};
  const matches=[];let pos=0;while((pos=hay.indexOf(needle,pos))>=0){matches.push(pos);pos+=Math.max(1,needle.length);}
  if(!matches.length)return {found:false,index:0,total:0};
  let cursor=backwards?hay.length:0;const sel=window.getSelection();
  if(sel?.rangeCount&&editor.contains(sel.anchorNode)){const range=sel.getRangeAt(0);const hit=nodes.find(x=>x.node===range.endContainer);if(hit)cursor=hit.start+range.endOffset+(backwards?-1:0);}
  let hitIndex;if(backwards){hitIndex=[...matches].map((v,i)=>[v,i]).filter(([v])=>v<=cursor).pop()?.[1]??matches.length-1;}else{hitIndex=matches.findIndex(v=>v>=cursor);if(hitIndex<0)hitIndex=0;}
  const index=matches[hitIndex],endIndex=index+needle.length,startNode=nodes.find(x=>index>=x.start&&index<x.end),endNode=nodes.find(x=>endIndex>x.start&&endIndex<=x.end);
  if(!startNode||!endNode)return {found:false,index:0,total:matches.length};
  const range=document.createRange();range.setStart(startNode.node,index-startNode.start);range.setEnd(endNode.node,endIndex-endNode.start);sel.removeAllRanges();sel.addRange(range);range.startContainer.parentElement?.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});selectionManager.remember();
  return {found:true,index:hitIndex+1,total:matches.length};
}
function openNoteFind(){
  if(!state.active||!$('#notion-content'))return;selectionManager.remember();let bar=$('.note-findbar');
  if(!bar){bar=document.createElement('div');bar.className='note-findbar';bar.innerHTML='<input type="search" placeholder="Procurar nesta nota" aria-label="Procurar nesta nota"><span class="note-find-result"></span><button type="button" data-find-prev title="Anterior">↑</button><button type="button" data-find-next title="Próximo">↓</button><button type="button" data-find-close title="Fechar">×</button>';$('.notion-page')?.appendChild(bar);
    const input=$('input',bar),result=$('.note-find-result',bar);const run=back=>{const found=findTextInEditor(input.value,back);result.textContent=input.value?(found.found?`${found.index} de ${found.total}`:'0 de 0'):'';};
    input.addEventListener('input',()=>{const view=noteViewStates.get(Number(state.active?.id||0))||{};view.find=input.value;noteViewStates.set(Number(state.active?.id||0),view);run(false);persistWorkspaceSession();});input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();run(e.shiftKey);}if(e.key==='Escape'){e.preventDefault();closeNoteFind();}});
    $('[data-find-prev]',bar).onclick=()=>run(true);$('[data-find-next]',bar).onclick=()=>run(false);$('[data-find-close]',bar).onclick=closeNoteFind;
  }
  const input=$('input',bar),view=noteViewStates.get(Number(state.active?.id||0));if(!input.value&&view?.find)input.value=view.find;input.focus();input.select();if(input.value){const found=findTextInEditor(input.value,false);$('.note-find-result',bar).textContent=found.found?`${found.index} de ${found.total}`:'0 de 0';}
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
async function checkStartupRecovery(){
  const keys=[];try{for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key?.startsWith(NOTE_DRAFT_PREFIX))keys.push(key);}}catch(_err){return;}
  const pending=[];
  for(const key of keys){
    const id=Number(key.slice(NOTE_DRAFT_PREFIX.length));if(!id)continue;
    try{
      const note=await get(`/api/notes/${id}`),draft=window.RepositEditor072?.recovery?.normalizeDraft(readNoteDraft(id),id);
      if(window.RepositEditor072?.recovery?.isNewer(draft,note))pending.push({note,draft});else clearNoteDraft(id);
    }catch(err){if(err?.status===404)clearNoteDraft(id);}
  }
  if(!pending.length)return;
  if(pending.length===1){await openNote(pending[0].note.id);return;}
  const applyOne=({note,draft})=>{const session=noteSession(note.id,note);session.recoveryDraft=null;session.recoveryOffered=true;session.payload={...draft.payload};session.saveRevision=Math.max(Number(draft.revision||0),session.savedRevision+1);session.dirty=true;persistNoteDraft(session);ensureNoteTab({...note,...draft.payload});};
  modal('Encontramos alterações não salvas.',`<p>${pending.length} notas possuem rascunhos mais recentes que o banco.</p><div class="recovery-list">${pending.map(x=>`<div><strong>${esc(x.draft?.payload?.title||x.note.title||'Sem título')}</strong><span>revisão ${Number(x.draft?.revision||0)} · ${fmt(new Date(x.draft?.timestamp||Date.now()).toISOString())}</span></div>`).join('')}</div>`,`<button class="btn soft" id="recovery-discard-all">Descartar todas</button><button class="btn soft" id="recovery-review">Revisar individualmente</button><button class="btn primary" id="recovery-restore-all">Restaurar todas</button>`,'recovery-modal');
  $('#recovery-discard-all').onclick=()=>{pending.forEach(x=>{clearNoteDraft(x.note.id);const s=noteSessions.get(Number(x.note.id));if(s){s.recoveryDraft=null;s.recoveryOffered=true;}});closeModal();toast('Rascunhos descartados.','ok');};
  $('#recovery-review').onclick=async()=>{closeModal();await openNote(pending[0].note.id);};
  $('#recovery-restore-all').onclick=async()=>{closeModal();pending.forEach(applyOne);for(const x of pending){if(state.settings.autosave_enabled)await saveNotionPage(x.note.id,true,{force:true});}persistWorkspaceSession();await openNote(pending[0].note.id);toast(`${pending.length} rascunhos restaurados.`,'ok');};
}
function offerRecoveryDraft(note,session){
  const draft=session?.recoveryDraft;if(!draft||session.recoveryOffered)return;session.recoveryOffered=true;const recovery=window.RepositEditor072?.recovery;
  const showChoice=()=>{modal('Encontramos alterações não salvas.',`<p>Existe um rascunho local mais recente que a revisão salva desta anotação.</p><p class="settings-help">Rascunho: ${new Date(draft.timestamp||Date.now()).toLocaleString('pt-BR')} · revisão ${draft.revision}</p>`,`<button class="btn soft" id="recovery-compare">Comparar</button><button class="btn soft" id="recovery-discard">Descartar</button><button class="btn primary" id="recovery-restore">Restaurar</button>`,'recovery-modal');
    $('#recovery-restore').onclick=()=>{session.recoveryDraft=null;session.payload={...draft.payload};session.saveRevision=Math.max(Number(draft.revision||0),session.savedRevision+1);session.dirty=true;persistNoteDraft(session);state.active={...note,...draft.payload};closeModal();renderNotionPage();toast('Rascunho restaurado.','ok');};
    $('#recovery-discard').onclick=()=>{session.recoveryDraft=null;clearNoteDraft(note.id);closeModal();toast('Rascunho descartado.','ok');};
    $('#recovery-compare').onclick=()=>{const saved=recovery?.plainPreview(note.content||'')||'',local=recovery?.plainPreview(draft.payload?.content||'')||'';modal('Comparar recuperação',`<div class="recovery-compare"><section><strong>Salvo</strong><pre>${esc(saved.slice(0,12000))}</pre></section><section><strong>Rascunho</strong><pre>${esc(local.slice(0,12000))}</pre></section></div>`,`<button class="btn soft" id="recovery-back">Voltar</button><button class="btn soft" id="recovery-discard">Descartar</button><button class="btn primary" id="recovery-restore">Restaurar</button>`,'recovery-compare-modal');$('#recovery-back').onclick=showChoice;$('#recovery-discard').onclick=()=>{session.recoveryDraft=null;clearNoteDraft(note.id);closeModal();};$('#recovery-restore').onclick=()=>{session.recoveryDraft=null;session.payload={...draft.payload};session.saveRevision=Math.max(Number(draft.revision||0),session.savedRevision+1);session.dirty=true;persistNoteDraft(session);state.active={...note,...draft.payload};closeModal();renderNotionPage();};};
  };showChoice();
}
async function init(){
  await configureNotebookMode();
  applyUiPreferences();renderShell();bindGlobal();
  const results=await Promise.allSettled([get('/api/settings'),get('/api/storage?details=false'),get('/api/app-info')]);
  if(results[0].status==='fulfilled')state.settings=results[0].value;
  if(results[1].status==='fulfilled'){state.storage=results[1].value;if(state.storage?.database_warning)toast('O banco local passou de aproximadamente 1 GB. Veja Armazenamento nas configurações.','err');}
  if(results[2].status==='fulfilled'){state.appInfo=results[2].value;if(state.appInfo?.database_recovery)toast('O banco apresentou corrupção. O original foi preservado e uma recuperação local foi criada.','err');}
  if(state.appInfo?.safe_mode)toast('Modo seguro ativo: workspace e cache temporário foram ignorados nesta inicialização.','ok');
  applyUiPreferences();renderShell();bindGlobal();
  const restored=await restoreWorkspaceSession();
  if(!restored)await navigate('workspace');
  await checkStartupRecovery();
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
    <section class="content-shell"><header class="topbar"><div class="header-copy"><h1 id="header-title">${esc(routeTitle(state.route))}</h1>${state.appInfo?.safe_mode?'<span class="safe-mode-chip" role="status">Modo seguro</span>':''}</div><label class="top-search">${icon('search')}<input id="top-search" placeholder="Pesquisar notas..." value="${esc(state.query)}"><span class="search-shortcut">Ctrl F</span></label><div class="top-spacer"></div><button class="top-menu" id="top-menu" title="Configurações" aria-label="Abrir configurações">${icon('settings')}</button></header><main class="main" id="main"></main></section>
  </div></div>`;
  $$('[data-route]').forEach(b=>b.onclick=()=>navigate(b.dataset.route));
  $('#sidebar-toggle').onclick=()=>setSidebarCollapsed(!state.sidebarCollapsed);
  $('#side-new-note').onclick=async()=>{if(state.route!=='workspace')await navigate('workspace');openNewNoteModal();};
  $('#top-menu').onclick=()=>navigate('settings');
  $('#top-search').oninput=e=>{state.query=e.target.value;clearTimeout(searchTimer);searchTimer=setTimeout(async()=>{if(state.route!=='workspace')await navigate('workspace');else await loadNotes();},180);};
  $('#top-search').onkeydown=e=>{if(e.key==='Enter'&&state.notes[0])openNote(state.notes[0].id);};
  const searchInput=$('#top-search');
  const showSearchHints=()=>{let panel=$('#search-filter-hints');if(panel)return;panel=document.createElement('div');panel.id='search-filter-hints';panel.className='search-filter-hints floating-search-hints';panel.innerHTML=['tag:escola','tipo:atividade','antes:10/09/2026','depois:01/09/2026','tem:arquivo','tem:imagem','tem:subnota'].map(v=>`<button type="button" data-search-hint="${esc(v)}">${esc(v)}</button>`).join('');document.body.append(panel);const r=searchInput.getBoundingClientRect();panel.style.left=`${Math.max(8,r.left)}px`;panel.style.top=`${Math.min(innerHeight-panel.offsetHeight-8,r.bottom+6)}px`;panel.querySelectorAll('[data-search-hint]').forEach(b=>b.onmousedown=e=>{e.preventDefault();const token=b.dataset.searchHint;const before=searchInput.value.trim();searchInput.value=(before?before+' ':'')+token+' ';state.query=searchInput.value;searchInput.focus();searchInput.dispatchEvent(new Event('input',{bubbles:true}));});};
  searchInput.onfocus=showSearchHints;searchInput.onblur=()=>setTimeout(()=>$('#search-filter-hints')?.remove(),120);
}



function bindGlobal(){
  const picker=$('#global-file-picker');
  if(picker)picker.onchange=()=>handleFiles([...picker.files]);
  const replacePicker=$('#replace-image-picker');if(replacePicker)replacePicker.onchange=()=>{const file=replacePicker.files?.[0];if(file)void replaceImageFile(file);};
  if(window.__repositGlobalBound)return;
  window.__repositGlobalBound=true;
  document.addEventListener('selectionchange',()=>{if(state.active&&$('#notion-content')){selectionManager.remember();updateToolbarState();updateFloatingToolbar();}else closeFloatingToolbar();});
  document.addEventListener('pointerdown',e=>{const bar=$('.selection-toolbar');if(bar&&!e.target.closest('.selection-toolbar')&&!e.target.closest('#notion-content'))closeFloatingToolbar();});
  document.addEventListener('keydown',async e=>{
    const key=e.key.toLowerCase();
    const editor=$('#notion-content');
    const editorFocused=!!(editor&&(editor===document.activeElement||editor.contains(document.activeElement)));
    if(e.key==='Escape'){
      if($('.note-findbar')){e.preventDefault();closeNoteFind();return;}
      if($('.selection-toolbar')){e.preventDefault();closeFloatingToolbar();return;}
      if($('.note-context-menu')){e.preventDefault();closeNoteContextMenu();return;}
      if($('#modal-root').innerHTML){e.preventDefault();closeModal();return;}
    }
    if(state.active&&editorFocused&&e.ctrlKey&&!e.altKey){
      if(key==='b'){e.preventDefault();editorFormat('bold');return;}
      if(key==='i'){e.preventDefault();editorFormat('italic');return;}
      if(key==='u'){e.preventDefault();editorFormat('underline');return;}
      if(key==='z'&&!e.shiftKey){e.preventDefault();if(!restoreSpecialHistory('undo'))editorFormat('undo');return;}
      if(key==='y'||(key==='z'&&e.shiftKey)){e.preventDefault();if(!restoreSpecialHistory('redo'))editorFormat('redo');return;}
      if(key==='k'){e.preventDefault();selectionManager.remember();insertLink();return;}
      if(key==='v'&&e.shiftKey){forcePlainPasteOnce=true;setTimeout(()=>{forcePlainPasteOnce=false;},1000);}
    }
    if(e.ctrlKey&&!e.altKey&&key==='n'){e.preventDefault();if(state.route!=='workspace')await navigate('workspace');openNewNoteModal();return;}
    if(e.ctrlKey&&!e.altKey&&key==='s'){e.preventDefault();if(state.active){captureNoteRevision(state.active.id);await saveNotionPage(state.active.id,false,{force:true});}else toast('Tudo salvo.','ok');return;}
    if(e.ctrlKey&&!e.altKey&&key==='f'&&!e.shiftKey){e.preventDefault();if(state.active&&editor)openNoteFind();else{$('#top-search')?.focus();$('#top-search')?.select();}return;}
    if(e.ctrlKey&&e.shiftKey&&key==='f'){e.preventDefault();$('#top-search')?.focus();$('#top-search')?.select();return;}
    if(e.ctrlKey&&e.shiftKey&&!e.altKey&&key==='p'){e.preventDefault();openCommandPalette();return;}
    if(e.ctrlKey&&!e.altKey&&key==='p'){e.preventDefault();$('#top-search')?.focus();$('#top-search')?.select();return;}
    if(e.ctrlKey&&key===','){e.preventDefault();await navigate('settings');return;}
    if(e.ctrlKey&&key==='/'){e.preventDefault();state.settingsTab='shortcuts';await navigate('settings','shortcuts');return;}
    if(e.ctrlKey&&key==='tab'){e.preventDefault();cycleNoteTab(e.shiftKey?-1:1);return;}
    if(e.ctrlKey&&(e.key==='PageUp'||e.key==='PageDown')){e.preventDefault();cycleNoteTab(e.key==='PageUp'?-1:1);return;}
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
  const compactActive=['favorites','recent','today','week'].includes(state.period);
  $('#main').innerHTML=`<section class="page workspace-page site-workspace"><div class="workspace-body"><div class="workspace-scroll" id="workspace-scroll"><section class="workspace-section notes-section sheet-section"><div class="workspace-top-controls"><div class="period-tabs period-tabs-large workspace-period-main" id="period-tabs"><button data-period="all" class="period-all ${state.period==='all'?'active':''}" aria-label="Todas as notas">${icon('book')}<span>Todas</span><b>${state.notes.length||''}</b></button></div><div class="period-filter"><button type="button" class="workspace-filter-toggle ${compactActive?'active':''}" id="period-filter-toggle" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(compactActive?workspacePeriodLabel():'Filtrar notas')}" title="${esc(compactActive?workspacePeriodLabel():'Filtrar notas')}">${icon('filter')}<span class="filter-active-dot" aria-hidden="true"></span></button><div class="period-filter-menu" id="period-filter-menu" role="menu" aria-label="Filtro de notas" hidden><div class="filter-menu-label">Mostrar</div><button type="button" role="menuitemradio" aria-checked="${state.period==='favorites'}" data-period-option="favorites"><span>Favoritas</span><span class="filter-option-check" ${state.period==='favorites'?'':'hidden'}>✓</span></button><button type="button" role="menuitemradio" aria-checked="${state.period==='recent'}" data-period-option="recent"><span>Recentes</span><span class="filter-option-check" ${state.period==='recent'?'':'hidden'}>✓</span></button><button type="button" role="menuitemradio" aria-checked="${state.period==='today'}" data-period-option="today"><span>Hoje</span><span class="filter-option-check" ${state.period==='today'?'':'hidden'}>✓</span></button><button type="button" role="menuitemradio" aria-checked="${state.period==='week'}" data-period-option="week"><span>Esta semana</span><span class="filter-option-check" ${state.period==='week'?'':'hidden'}>✓</span></button><button type="button" class="filter-menu-clear" id="period-filter-clear" ${compactActive?'':'hidden'}>Limpar filtro</button></div></div><button type="button" class="trash-filter-button ${state.period==='trash'?'active':''}" id="trash-filter" title="Lixeira" aria-label="Lixeira">${icon('trash')}</button><div class="toolbar-spacer"></div><span id="selection-info" class="selection-info"></span><select class="workspace-sort" id="workspace-sort" aria-label="Ordenar notas"><option value="updated">Modificação</option><option value="name">Nome</option><option value="created">Criação</option><option value="manual">Manual</option></select><label class="kind-filter">${icon('filter')}<input id="kind-filter" list="kind-options-filter" placeholder="Tipo" value="${esc(state.kind)}"><datalist id="kind-options-filter"><option>Anotação</option><option>Atividade</option><option>Material</option><option>Trabalho</option><option>Resumo</option><option>Lembrete</option></datalist></label><button class="btn soft" id="manage-tags">${icon('tags')} Tags</button>${state.period==='trash'?`<button class="btn soft trash-empty-button" id="empty-trash" title="Esvaziar Lixeira">Esvaziar</button>`:''}<button class="btn primary workspace-new-note" id="workspace-new-note">${icon('plus')} Nova nota</button></div><div id="workspace-tags" class="workspace-tags"></div><div id="notes-content" class="notes-content"><div class="loading-block">Carregando notas…</div></div></section></div><div class="drop-zone"><div>${icon('clip')}<strong>Solte os arquivos aqui</strong></div></div><div id="note-tabbar" class="note-tabbar"></div></div></section>`;
  $('#workspace-new-note').onclick=()=>openNewNoteModal();
  $('#empty-trash')?.addEventListener('click',()=>{modal('Esvaziar Lixeira','<p>Excluir definitivamente todas as notas da Lixeira? Esta ação não pode ser desfeita.</p>',`<button class="btn soft" data-close>Cancelar</button><button class="btn danger" id="confirm-empty-trash">Esvaziar Lixeira</button>`);$('#confirm-empty-trash').onclick=async()=>{try{const result=await post('/api/trash/empty',{});closeModal();toast(`${Number(result.deleted||0)} item(ns) excluído(s) definitivamente.`,'ok');await loadNotes();}catch(err){toast(err.message,'err');}};});
  $('#kind-filter').oninput=e=>{state.kind=e.target.value;clearTimeout(searchTimer);searchTimer=setTimeout(loadNotes,180);};$('#manage-tags').onclick=openTagManager;
  $('#workspace-sort').value=state.sort;$('#workspace-sort').onchange=e=>{state.sort=e.target.value;loadNotes();};
  $('[data-period="all"]')?.addEventListener('click',()=>applyWorkspacePeriod('all'));
  $('#trash-filter')?.addEventListener('click',()=>applyWorkspacePeriod('trash'));
  const filterToggle=$('#period-filter-toggle'),filterMenu=$('#period-filter-menu');
  const openFilterMenu=()=>{if(!filterMenu||!filterToggle)return;filterMenu.removeAttribute('hidden');filterToggle.setAttribute('aria-expanded','true');setTimeout(()=>filterMenu.querySelector('[aria-checked="true"]')?.focus({preventScroll:true})||filterMenu.querySelector('[data-period-option]')?.focus({preventScroll:true}),0);};
  filterToggle?.addEventListener('click',e=>{e.stopPropagation();filterMenu?.hasAttribute('hidden')?openFilterMenu():closeWorkspaceFilterMenu({restoreFocus:true});});
  filterToggle?.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){e.preventDefault();openFilterMenu();}else if(e.key==='Escape'){e.preventDefault();closeWorkspaceFilterMenu();}});
  filterMenu?.addEventListener('keydown',e=>{const items=$$('[data-period-option]',filterMenu),index=items.indexOf(document.activeElement);if(e.key==='Escape'){e.preventDefault();closeWorkspaceFilterMenu({restoreFocus:true});return;}if((e.key==='ArrowDown'||e.key==='ArrowUp')&&items.length){e.preventDefault();const step=e.key==='ArrowDown'?1:-1;items[(index+step+items.length)%items.length].focus({preventScroll:true});}});
  $$('[data-period-option]').forEach(button=>button.addEventListener('click',()=>applyWorkspacePeriod(button.dataset.periodOption)));
  $('#period-filter-clear')?.addEventListener('click',()=>applyWorkspacePeriod('all'));
  syncWorkspaceFilterUi();
  renderNoteTabs();await loadNotes();
}

async function loadNotes(append=false){
  const query=state.query.trim(),params=new URLSearchParams();
  if(state.kind.trim())params.set('kind',state.kind.trim());
  if(state.tag.trim())params.set('tag',state.tag.trim());
  params.set('limit','200');params.set('sort',state.period==='recent'?'recent':state.sort);if(state.period==='trash')params.set('view','trash');if(state.period==='favorites')params.set('favorite','true');
  try{
    let notes;
    if(query&&!state.kind.trim()&&!state.tag.trim()){
      const offset=append?Number(state.searchOffset||0):0;
      const searchParams=new URLSearchParams({q:query,limit:'100',offset:String(offset)});
      if(state.period==='trash')searchParams.set('view','trash');
      if(state.period==='favorites')searchParams.set('favorite','true');
      if(['recent','today','week'].includes(state.period))searchParams.set('period',state.period);
      const result=await get(`/api/notes/search?${searchParams}`);
      const page=(result.items||[]).map(n=>({...n,content:n.snippet||'',subnote_count:0,file_count:0}));
      notes=append?[...state.notes,...page]:page;state.searchHasMore=!!result.has_more;state.searchOffset=Number(result.next_offset||0);
    }else{if(query)params.set('q',query);notes=await get(`/api/notes?${params}`);state.searchHasMore=false;state.searchOffset=0;}
    const tags=append?state.noteTags:await get('/api/note-tags');state.notes=notes;state.noteTags=tags;renderSheet();
  }catch(err){toast(err.message,'err');}
}

function renderQuickSection(){}

function renderSheet(){
  const wrap=$('#notes-content'); if(!wrap)return;
  const notes=visibleNotes();
  renderWorkspaceTags();
  if(!notes.length){
    const isTrash=state.period==='trash',hasFilter=!!(state.query||state.kind||state.tag||state.period!=='all');
    const emptyTitle=isTrash?'A lixeira está vazia':state.query?`Nenhum resultado para “${esc(state.query)}”`:'Nenhuma nota ainda';
    const emptyCopy=isTrash?'Notas removidas aparecem aqui até você restaurar ou esvaziar a Lixeira.':hasFilter?'Tente limpar os filtros ou pesquisar outro termo.':'Ctrl+N cria sua primeira nota.';
    wrap.innerHTML=`<div class="empty-notes sheet-empty" role="status"><div class="empty-notes-icon">${icon(isTrash?'trash':'table-columns')}</div><h3>${emptyTitle}</h3><p>${emptyCopy}</p>${isTrash?'':`<button class="btn primary" id="empty-new">${icon('plus')} Nova nota</button>`}</div>`;
    $('#empty-new')?.addEventListener('click',()=>openNewNoteModal()); updateSelection(); return;
  }
  renderTableView(wrap,notes);
  if(state.searchHasMore){const more=document.createElement('button');more.className='btn soft search-load-more';more.textContent='Carregar mais resultados';more.onclick=()=>loadNotes(true);wrap.append(more);}
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
  $('#note-new-card').onclick=()=>openNewNoteModal();
  bindNoteInteractions('[data-note-card]');
}

function renderTableView(wrap,notes){
  wrap.innerHTML=`<div class="table-card site-sheet"><table class="sheet"><thead><tr><th class="check-col"><input id="check-all" type="checkbox"></th><th class="cell-index-col">#</th><th class="title-col">Nome</th><th class="kind-col">Tipo</th><th class="tags-col">Tags</th><th class="date-col">Alterado</th><th class="action-col"></th></tr></thead><tbody>${notes.map((n,idx)=>`<tr data-note-row="${n.id}" class="tone-${noteTone(n,idx)} ${state.selected.has(n.id)?'selected':''}">
    <td class="check-col"><input type="checkbox" data-select="${n.id}" ${state.selected.has(n.id)?'checked':''}></td>
    <td class="cell-index-col"><span class="cell-number">${String(idx+1).padStart(2,'0')}</span></td>
    <td class="title-col"><div class="title-cell"><span class="cell-doc-icon">${icon(n.is_subnote?'angle-right':'document')}</span><div class="cell-title-stack"><input class="cell-input" data-inline="title" data-id="${n.id}" value="${esc(n.title)}">${state.query?`<small class="cell-search-snippet">${n.is_subnote?`Subnota de ${esc(n.parent_title||'nota')} · `:''}${esc(notePreview(n,120))}</small>`:''}</div></div></td>
    <td class="kind-col"><input class="cell-input" data-inline="kind" data-id="${n.id}" value="${esc(n.kind)}" list="kind-options"></td>
    <td class="tags-col"><input class="cell-input" data-inline="tags" data-id="${n.id}" value="${esc(n.tags||'')}" placeholder="sem tags"></td>
    <td class="date-col muted2">${fmt(n.updated_at)}</td>
    <td class="action-col"><div class="row-actions">${state.period==='trash'?`<button class="row-action" title="Restaurar" data-row-restore="${n.id}">↩</button><button class="row-action danger-action" title="Excluir definitivamente" data-row-purge="${n.id}">${icon('trash')}</button>`:`<button class="row-action ${n.favorite?'is-favorite':''}" title="${n.favorite?'Remover dos favoritos':'Favoritar'}" data-row-favorite="${n.id}" data-favorite="${n.favorite?1:0}">${n.favorite?'★':'☆'}</button><button class="row-action" title="Abrir" data-row-open="${n.id}">${icon('expand')}</button><button class="row-action danger-action" title="Mover para Lixeira" data-row-delete="${n.id}">${icon('trash')}</button>`}</div></td>
  </tr>`).join('')}</tbody><tfoot><tr class="sheet-new-row" id="sheet-new-row"><td></td><td class="cell-index-col">+</td><td colspan="5"><button class="sheet-new-inline" id="sheet-new-inline">${icon('plus')} Nova nota</button></td></tr></tfoot></table><datalist id="kind-options"><option>Anotação</option><option>Atividade</option><option>Material</option><option>Trabalho</option><option>Resumo</option><option>Lembrete</option><option>Outro</option></datalist></div>`;
  $('#check-all').onchange=e=>{ if(e.target.checked)notes.forEach(n=>state.selected.add(n.id));else notes.forEach(n=>state.selected.delete(n.id));renderSheet(); };
  $('#sheet-new-inline').onclick=()=>openNewNoteModal();
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
    r.oncontextmenu=e=>openWorkspaceNoteMenu(e,Number(r.dataset.noteRow));
    if(state.sort==='manual'&&state.period==='all'){r.draggable=true;r.ondragstart=e=>{e.dataTransfer.setData('text/reposit-note',r.dataset.noteRow);e.dataTransfer.effectAllowed='move';};r.ondragover=e=>{if(e.dataTransfer.types.includes('text/reposit-note'))e.preventDefault();};r.ondrop=async e=>{const from=Number(e.dataTransfer.getData('text/reposit-note')),to=Number(r.dataset.noteRow);if(!from||!to||from===to)return;e.preventDefault();const list=[...state.notes],a=list.findIndex(n=>Number(n.id)===from),b=list.findIndex(n=>Number(n.id)===to);if(a<0||b<0)return;const [moved]=list.splice(a,1);list.splice(b,0,moved);state.notes=list;renderSheet();try{await post('/api/notes/reorder',{ids:list.map(n=>n.id)});}catch(err){toast(err.message,'err');}};}
  });
  $$('[data-row-open]').forEach(b=>b.onclick=e=>{e.stopPropagation();openNote(Number(b.dataset.rowOpen));});
  $$('[data-row-delete]').forEach(b=>b.onclick=e=>{e.stopPropagation();confirmDeleteNote(Number(b.dataset.rowDelete));});
  $$('[data-row-restore]').forEach(b=>b.onclick=e=>{e.stopPropagation();restoreNoteFromTrash(Number(b.dataset.rowRestore));});
  $$('[data-row-purge]').forEach(b=>b.onclick=e=>{e.stopPropagation();purgeNoteConfirm(Number(b.dataset.rowPurge));});
  $$('[data-row-favorite]').forEach(b=>b.onclick=async e=>{e.stopPropagation();try{const id=Number(b.dataset.rowFavorite),saved=await patch(`/api/notes/${id}`,{favorite:b.dataset.favorite!=='1'});const n=state.notes.find(x=>Number(x.id)===id);if(n)n.favorite=saved.favorite;renderSheet();}catch(err){toast(err.message,'err');}});
}

function updateSelection(){
  const el=$('#selection-info');if(!el)return;
  el.textContent=state.selected.size?`${state.selected.size} selecionada${state.selected.size>1?'s':''}`:'';
  let actions=$('#selection-actions');
  if(!state.selected.size){actions?.remove();return;}
  if(!actions){actions=document.createElement('div');actions.id='selection-actions';actions.className='selection-actions';el.after(actions);}
  actions.innerHTML=state.period==='trash'?`<button data-batch="restore">Restaurar</button><button class="danger-action" data-batch="purge">Excluir definitivamente</button>`:`<button data-batch="favorite">★ Favoritar</button><button data-batch="add-tag">+ Tag</button><button data-batch="remove-tag">− Tag</button><button class="danger-action" data-batch="trash">Lixeira</button>`;
  actions.querySelectorAll('[data-batch]').forEach(b=>b.onclick=async()=>{const ids=[...state.selected],action=b.dataset.batch;try{
    if(action==='restore'){for(const id of ids)await post(`/api/notes/${id}/restore`,{});}
    else if(action==='purge'){if(!confirm(`Excluir definitivamente ${ids.length} nota(s)?`))return;for(const id of ids)await del(`/api/notes/${id}`);}
    else if(action==='trash')await post('/api/notes/batch',{ids,action:'trash'});
    else if(action==='favorite')await post('/api/notes/batch',{ids,action:'favorite',value:true});
    else if(action==='add-tag'||action==='remove-tag'){const tag=prompt(action==='add-tag'?'Adicionar qual tag?':'Remover qual tag?','');if(!tag?.trim())return;await post('/api/notes/batch',{ids,action,tag:tag.trim()});}
    state.selected.clear();await loadNotes();
  }catch(err){toast(err.message,'err');}});
}
function closeWorkspaceNoteMenu(){document.querySelector('.workspace-note-menu')?.remove();}
function openWorkspaceNoteMenu(event,id){
  event.preventDefault();event.stopPropagation();closeWorkspaceNoteMenu();const n=state.notes.find(x=>Number(x.id)===Number(id));if(!n)return;
  const menu=document.createElement('div');menu.className='note-context-menu workspace-note-menu';menu.setAttribute('role','menu');
  menu.innerHTML=state.period==='trash'?`<button role="menuitem" data-wm="restore">Restaurar</button><button role="menuitem" class="context-danger" data-wm="purge">Excluir definitivamente</button>`:`<button role="menuitem" data-wm="open">Abrir</button><button role="menuitem" data-wm="favorite">${n.favorite?'Remover dos favoritos':'Favoritar'}</button><button role="menuitem" data-wm="pin">${n.pinned?'Desafixar':'Fixar no topo'}</button><button role="menuitem" data-wm="duplicate">Duplicar</button><button role="menuitem" data-wm="template">Salvar como modelo</button><div class="context-separator"></div><button role="menuitem" class="context-danger" data-wm="trash">Mover para Lixeira</button>`;
  document.body.append(menu);const r=menu.getBoundingClientRect();menu.style.left=`${Math.max(8,Math.min(event.clientX,innerWidth-r.width-8))}px`;menu.style.top=`${Math.max(8,Math.min(event.clientY,innerHeight-r.height-8))}px`;
  menu.querySelectorAll('[data-wm]').forEach(b=>b.onclick=async()=>{const action=b.dataset.wm;closeWorkspaceNoteMenu();try{if(action==='open')return openNote(id);if(action==='restore')return restoreNoteFromTrash(id);if(action==='purge')return purgeNoteConfirm(id);if(action==='trash')return confirmDeleteNote(id);if(action==='duplicate')return duplicateNote(id);if(action==='favorite'||action==='pin'){await patch(`/api/notes/${id}`,{[action==='favorite'?'favorite':'pinned']:!(action==='favorite'?n.favorite:n.pinned)});return loadNotes();}if(action==='template'){const name=prompt('Nome do modelo:',n.title);if(name?.trim())await post(`/api/notes/${id}/save-template`,{name:name.trim()});toast('Modelo salvo.','ok');}}catch(err){toast(err.message,'err');}});
}


function ensureNoteTab(note,{persist=true}={}){
  if(!note?.id)return;
  const payload={
    id:Number(note.id),title:note.title||'Sem título',kind:note.kind||'Anotação',
    parent_note_id:note.parent_note_id?Number(note.parent_note_id):null,
    parent_title:note.parent_note?.title||note.parent_title||''
  };
  const existing=state.openTabs.find(t=>t.id===payload.id);
  if(existing)Object.assign(existing,payload);
  else{
    state.openTabs.push(payload);
    if(state.openTabs.length>100){
      const removable=state.openTabs.find(t=>t.id!==Number(state.active?.id||0)&&!noteSessions.get(t.id)?.dirty);
      if(removable){state.openTabs=state.openTabs.filter(t=>t.id!==removable.id);selectionManager.clear(removable.id);specialHistories.delete(removable.id);noteViewStates.delete(removable.id);}
      else state.openTabs=state.openTabs.slice(-100);
    }
  }
  if(persist)persistWorkspaceSession();
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
  if(session?.captureTimer){clearTimeout(session.captureTimer);session.captureTimer=null;}
  if(session?.dirty)persistNoteDraft(session);else clearNoteDraft(id);
  state.openTabs=state.openTabs.filter(t=>t.id!==id);
  noteSessions.delete(id);selectionManager.clear(id);specialHistories.get(id)?.clear?.();specialHistories.delete(id);noteViewStates.delete(id);
  persistWorkspaceSession();
  if(state.active?.id===id){
    const fallback=state.openTabs[Math.min(Math.max(idx-1,0),Math.max(state.openTabs.length-1,0))];
    state.active=null;
    if(fallback)await openNote(fallback.id);else await renderWorkspace();
  }else renderNoteTabs();
}
function closeTabContextMenu(){document.querySelector('.tab-context-menu')?.remove();}
function openTabContextMenu(event,id){
  event.preventDefault();closeTabContextMenu();id=Number(id);const index=state.openTabs.findIndex(t=>t.id===id);if(index<0)return;
  const menu=document.createElement('div');menu.className='tab-context-menu note-context-menu';menu.setAttribute('role','menu');
  menu.innerHTML=`<button role="menuitem" data-tab-action="close">Fechar</button><button role="menuitem" data-tab-action="others">Fechar outras</button><button role="menuitem" data-tab-action="right">Fechar à direita</button><button role="menuitem" data-tab-action="all">Fechar todas</button>`;
  document.body.append(menu);const rect=menu.getBoundingClientRect();menu.style.left=`${Math.max(8,Math.min(event.clientX,innerWidth-rect.width-8))}px`;menu.style.top=`${Math.max(8,Math.min(event.clientY,innerHeight-rect.height-8))}px`;
  const closeIds=async ids=>{for(const target of [...ids]){if(state.openTabs.some(t=>t.id===target))await closeNoteTab(target);}};
  menu.querySelectorAll('[data-tab-action]').forEach(b=>b.onclick=async()=>{const action=b.dataset.tabAction;closeTabContextMenu();if(action==='close')return closeNoteTab(id);if(action==='others')return closeIds(state.openTabs.filter(t=>t.id!==id).map(t=>t.id));if(action==='right')return closeIds(state.openTabs.slice(index+1).map(t=>t.id));if(action==='all')return closeIds(state.openTabs.map(t=>t.id));});
}
function renderNoteTabs(){
  const bar=$('#note-tabbar');if(!bar)return;
  const activeId=state.active?.id||0;
  bar.setAttribute('role','tablist');bar.setAttribute('aria-label','Notas abertas');
  bar.innerHTML=`<button class="note-tab note-tab-home ${!activeId?'active':''}" id="tab-home" role="tab" aria-selected="${!activeId}" title="Todas as notas">${icon('book')}<span>Todas</span></button>
    <div class="note-tabs-scroll">${state.openTabs.map(t=>`<button class="note-tab ${activeId===t.id?'active':''} ${noteSessions.get(t.id)?.dirty?'dirty':''} ${t.parent_note_id?'subnote-tab':''}" data-tab-note="${t.id}" role="tab" aria-selected="${activeId===t.id}" aria-controls="note-editor-panel" title="${esc(t.parent_note_id?`${t.parent_title||'Nota'} › ${t.title}`:t.title)}"><span class="tab-doc">${t.parent_note_id?icon('angle-right'):icon('document')}</span><span class="tab-title">${esc(t.title||'Sem título')}</span><span class="tab-dirty" aria-hidden="true"></span><span class="tab-close" data-close-tab="${t.id}" aria-label="Fechar aba">${icon('cross-small')}</span></button>`).join('')}</div>
    <button class="note-tab-add" id="tab-new" title="Nova nota">${icon('plus')}</button>`;
  $('#tab-home').onclick=async()=>{if(!(await leaveCurrentNote('workspace')))return;state.active=null;persistWorkspaceSession();await renderWorkspace();};
  $$('[data-tab-note]').forEach(b=>{b.onclick=e=>{if(e.target.closest('[data-close-tab]'))return;openNote(Number(b.dataset.tabNote));};b.onauxclick=e=>{if(e.button===1){e.preventDefault();closeNoteTab(Number(b.dataset.tabNote));}};b.oncontextmenu=e=>openTabContextMenu(e,Number(b.dataset.tabNote));});
  $$('[data-close-tab]').forEach(b=>b.onclick=e=>{e.stopPropagation();closeNoteTab(Number(b.dataset.closeTab));});
  $('#tab-new').onclick=()=>createBlankNote({},true);
}
async function openNewNoteModal(){
  try{
    const templates=await get('/api/note-templates');
    modal('Nova nota',`<div class="template-picker"><button class="template-card primary-template" data-template-blank><strong>Em branco</strong><span>Começar sem estrutura.</span></button>${templates.filter(t=>t.name!=='Em branco').map(t=>`<button class="template-card" data-template-id="${t.id}"><strong>${esc(t.name)}</strong><span>${t.builtin?'Modelo padrão':'Meu modelo'} · ${esc(t.kind)}</span></button>`).join('')}</div>`,`<button class="btn soft" data-close>Cancelar</button>`,'template-modal');
    $('[data-template-blank]')?.addEventListener('click',async()=>{closeModal();await createBlankNote({},true);});
    $$('[data-template-id]').forEach(b=>b.onclick=async()=>{try{const n=await post(`/api/note-templates/${b.dataset.templateId}/create`,{});closeModal();ensureNoteTab(n);await loadNotes();await openNote(n.id);}catch(err){toast(err.message,'err');}});
  }catch(err){toast(err.message,'err');}
}
async function saveCurrentAsTemplate(){
  if(!state.active?.id)return toast('Abra uma nota primeiro.','err');
  captureNoteRevision(state.active.id);if(noteSessions.get(state.active.id)?.dirty)await saveNotionPage(state.active.id,true,{force:true});
  const name=prompt('Nome do modelo:',state.active.title||'Meu modelo');if(!name?.trim())return;
  try{await post(`/api/notes/${state.active.id}/save-template`,{name:name.trim()});toast('Modelo salvo.','ok');}catch(err){toast(err.message,'err');}
}
async function openNoteHistory(id){
  try{
    const rows=await get(`/api/notes/${id}/history?limit=25`);
    modal('Histórico da nota',`<div class="history-list">${rows.length?rows.map(r=>`<div class="history-row"><div><strong>${fmt(r.created_at)}</strong><span>${esc(r.reason||'versão')} · rev. ${Number(r.edit_revision||0)} · ${Math.round(Number(r.content_size||0)/1000)}k</span></div><div><button class="btn soft" data-history-view="${r.id}">Visualizar</button><button class="btn soft" data-history-restore="${r.id}">Restaurar</button></div></div>`).join(''):'<div class="empty-route"><p>Ainda não há versões anteriores desta nota.</p></div>'}</div>`,`<button class="btn soft" data-close>Fechar</button>`,'history-modal');
    $$('[data-history-view]').forEach(b=>b.onclick=async()=>{try{const item=await get(`/api/notes/${id}/history/${b.dataset.historyView}`);modal('Visualizar versão',`<div class="history-preview"><h3>${esc(item.title)}</h3><div>${item.content_format==='html'?sanitizeRichHtml(item.content):esc(item.content).replace(/\n/g,'<br>')}</div></div>`,`<button class="btn soft" onclick="closeModal()">Fechar</button>`,'history-preview-modal');}catch(err){toast(err.message,'err');}});
    $$('[data-history-restore]').forEach(b=>b.onclick=async()=>{if(!confirm('Restaurar esta versão? A versão atual será preservada no histórico.'))return;try{const saved=await post(`/api/notes/${id}/history/${b.dataset.historyRestore}/restore`,{});closeModal();state.active=saved;noteSessions.delete(Number(id));renderNotionPage();toast('Versão restaurada.','ok');}catch(err){toast(err.message,'err');}});
  }catch(err){toast(err.message,'err');}
}
function toggleSoftContrast(){const on=!document.documentElement.classList.contains('soft-contrast');document.documentElement.classList.toggle('soft-contrast',on);localStorage.setItem('reposit.soft-contrast',on?'1':'0');toast(on?'Contraste suave ativado.':'Contraste suave desativado.','ok');}
function openCommandPalette(){
  const commands=[
    {id:'new',label:'Criar nova nota',hint:'Ctrl+N'},
    {id:'open',label:'Abrir nota…',hint:'Pesquisar por título'},
    {id:'search',label:'Pesquisar…',hint:'Busca global'},
    {id:'template',label:'Salvar nota como modelo',hint:'Nota atual'},
    {id:'history',label:'Histórico da nota',hint:'Versões anteriores'},
    {id:'export',label:'Exportar nota',hint:'TXT, MD, HTML, PDF…'},
    {id:'theme',label:'Alternar contraste',hint:'Visual discreto'},
    {id:'settings',label:'Abrir configurações',hint:'Ctrl+,'},
    {id:'shortcuts',label:'Mostrar atalhos',hint:'Ctrl+/'},
  ];
  modal('Comandos',`<div class="command-palette"><input id="command-search" type="search" placeholder="Digite um comando…" autocomplete="off"><div id="command-results" role="listbox"></div></div>`,'','command-palette-modal');
  const input=$('#command-search'),results=$('#command-results');let active=0,filtered=commands;
  const render=()=>{const q=(input.value||'').toLocaleLowerCase().trim();filtered=commands.filter(c=>!q||c.label.toLocaleLowerCase().includes(q)||c.hint.toLocaleLowerCase().includes(q));active=Math.min(active,Math.max(0,filtered.length-1));results.innerHTML=filtered.map((c,i)=>`<button type="button" role="option" aria-selected="${i===active}" class="${i===active?'active':''}" data-command="${c.id}"><strong>${esc(c.label)}</strong><small>${esc(c.hint)}</small></button>`).join('')||'<div class="slash-empty">Nenhum comando</div>';$$('[data-command]',results).forEach(b=>b.onclick=()=>run(b.dataset.command));};
  const run=async id=>{closeModal();if(id==='new')return openNewNoteModal();if(id==='open'||id==='search'){if(state.route!=='workspace')await navigate('workspace');setTimeout(()=>{$('#top-search')?.focus();$('#top-search')?.select();},30);return;}if(id==='template')return saveCurrentAsTemplate();if(id==='history'&&state.active)return openNoteHistory(state.active.id);if(id==='export'&&state.active)return openExportModal(state.active.id);if(id==='theme')return toggleSoftContrast();if(id==='settings')return navigate('settings');if(id==='shortcuts'){state.settingsTab='shortcuts';return navigate('settings','shortcuts');}};
  input.addEventListener('input',()=>{active=0;render();});input.addEventListener('keydown',e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();active=(active+(e.key==='ArrowDown'?1:-1)+Math.max(1,filtered.length))%Math.max(1,filtered.length);render();}else if(e.key==='Enter'&&filtered[active]){e.preventDefault();run(filtered[active].id);}else if(e.key==='Escape'){e.preventDefault();closeModal();}});render();setTimeout(()=>input.focus(),0);
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
    const loaded=await get(`/api/notes/${id}`);void post(`/api/notes/${id}/opened`,{}).catch(()=>{});
    if(requestSeq!==openNoteRequestSeq)return;
    state.active=materializeSessionNote(loaded);
    if(state.active.parent_note)ensureNoteTab({...state.active.parent_note,parent_note_id:state.active.parent_note.parent_note_id||null});
    ensureNoteTab(state.active);
    $$('[data-route]').forEach(b=>b.classList.toggle('active',b.dataset.route==='workspace'));
    setHeader('workspace');renderNotionPage();animateMain('tab');
    const searchText=String(state.query||'').replace(/(?:tag|tipo|type|antes|depois|before|after|tem|has):(?:"[^"]+"|\S+)/gi,' ').trim();
    if(searchText)setTimeout(()=>findTextInEditor(searchText.split(/\s+/)[0]||''),80);
  }catch(err){if(requestSeq===openNoteRequestSeq)toast(err.message,'err');}
}
function humanSize(bytes=0){
  const n=Number(bytes)||0;if(n<1024)return `${n} B`;if(n<1048576)return `${(n/1024).toFixed(1)} KB`;return `${(n/1048576).toFixed(1)} MB`;
}
function isImageFile(file){return String(file?.file_type||'').startsWith('image/');}
function isAudioFile(file){return String(file?.file_type||'').startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(file?.filename||'');}
function tokenValue(value=''){return encodeURIComponent(String(value||'')).replace(/%20/g,'+');}
function tokenValueDecode(value=''){try{return decodeURIComponent(String(value||'').replace(/\+/g,' '));}catch(_err){return String(value||'');}}
function normalizeMediaLayout(layout={}){
  const rawWidth=String(layout.width??'auto').trim();
  let width='auto';
  if(rawWidth!=='auto' && /^\d{1,3}$/.test(rawWidth)) width=String(Math.max(15,Math.min(100,Number(rawWidth))));
  const ratio=['auto','1x1','4x3','16x9'].includes(String(layout.ratio||''))?String(layout.ratio):'auto';
  const fit=['contain','cover'].includes(String(layout.fit||''))?String(layout.fit):'contain';
  const align=['left','center','right'].includes(String(layout.align||''))?String(layout.align):'center';
  const alt=String(layout.alt||'').slice(0,300);
  const caption=String(layout.caption||'').slice(0,500);
  return {width,ratio,fit,align,alt,caption};
}
function mediaFileToken(fileId,layout={}){
  const m=normalizeMediaLayout(layout);let token=`[[reposit-file:${fileId}`;
  if(m.width!=='auto')token+=`;w=${m.width}`;
  if(m.ratio!=='auto')token+=`;r=${m.ratio}`;
  if(m.fit!=='contain')token+=`;fit=${m.fit}`;
  if(m.align!=='center')token+=`;a=${m.align}`;
  if(m.alt)token+=`;alt=${tokenValue(m.alt)}`;
  if(m.caption)token+=`;cap=${tokenValue(m.caption)}`;
  return `${token}]]`;
}
function parseMediaFileToken(token=''){
  const raw=String(token||'');const match=raw.match(/^\[\[reposit-file:(\d+)((?:;[^\]]+)*)\]\]$/);if(!match)return null;
  const props={};String(match[2]||'').split(';').filter(Boolean).forEach(part=>{const idx=part.indexOf('=');if(idx>0)props[part.slice(0,idx)]=part.slice(idx+1);});
  return {id:match[1],...normalizeMediaLayout({width:props.w||'auto',ratio:props.r||'auto',fit:props.fit||'contain',align:props.a||'center',alt:tokenValueDecode(props.alt||''),caption:tokenValueDecode(props.cap||'')})};
}
function attachmentBlockHtml(file,layout={}){
  const media=normalizeMediaLayout(layout);const token=mediaFileToken(file.id,media);const widthStyle=media.width==='auto'?'':` style="--media-width:${media.width}%"`;const missing=!!file.missing;
  if(isImageFile(file))return `<figure class="inline-attachment inline-media-image align-${media.align}${missing?' missing':''}" contenteditable="false" draggable="true" tabindex="0" role="group" aria-label="Imagem: ${esc(media.alt||file.filename)}" data-file-id="${file.id}" data-media-width="${media.width}" data-media-ratio="${media.ratio}" data-media-fit="${media.fit}" data-media-align="${media.align}" data-media-alt="${esc(media.alt)}" data-media-caption="${esc(media.caption)}" data-file-token="${esc(token)}"${widthStyle}>${missing?`<div class="broken-media"><strong>Imagem não encontrada</strong><span>${esc(file.filename)}</span></div>`:`<img src="/api/note-files/${file.id}/thumbnail" data-original-src="/api/note-files/${file.id}" alt="${esc(media.alt||file.filename)}" loading="lazy" decoding="async">`}<span class="media-size-badge">${media.width==='auto'?'Auto':media.width+'%'}</span><span class="media-resize-handle media-resize-left" data-media-resize="left" title="Arraste para redimensionar"></span><span class="media-resize-handle media-resize-right" data-media-resize="right" title="Arraste para redimensionar"></span><span class="inline-media-actions"><button type="button" data-inline-layout="${file.id}" title="Imagem e layout" aria-label="Imagem e layout">${icon('image')}</button>${missing?'':`<button type="button" data-inline-open="${file.id}" title="Abrir original" aria-label="Abrir original">${icon('expand')}</button>`}<button type="button" data-inline-delete="${file.id}" title="Remover" aria-label="Remover imagem">${icon('trash')}</button></span>${media.caption?`<figcaption>${esc(media.caption)}</figcaption>`:''}</figure>`;
  if(isAudioFile(file))return `<div class="inline-attachment inline-audio${missing?' missing':''}" contenteditable="false" draggable="true" tabindex="0" role="group" aria-label="Áudio: ${esc(file.filename)}" data-file-id="${file.id}" data-file-token="[[reposit-file:${file.id}]]"><div class="inline-audio-head"><span>${icon('file')}</span><strong>${esc(file.filename)}</strong><small>${humanSize(file.size)}</small></div>${missing?'<div class="broken-file">Arquivo não encontrado</div>':`<audio controls preload="none" src="/api/note-files/${file.id}"></audio>`}<span class="inline-attachment-actions">${missing?'':`<button type="button" data-inline-open="${file.id}" title="Abrir">${icon('expand')}</button>`}<button type="button" data-inline-delete="${file.id}" title="Remover">${icon('trash')}</button></span></div>`;
  return `<div class="inline-attachment inline-file${missing?' missing':''}" contenteditable="false" draggable="true" tabindex="0" role="group" aria-label="Arquivo: ${esc(file.filename)}" data-file-id="${file.id}" data-file-token="[[reposit-file:${file.id}]]"><span class="inline-attachment-icon">${icon('file')}</span><span class="inline-attachment-copy"><strong>${esc(file.filename)}</strong><small>${missing?'Arquivo não encontrado':`${esc(file.file_type||'Arquivo')} · ${humanSize(file.size)}`}</small></span><span class="inline-attachment-actions">${missing?'':`<button type="button" data-inline-open="${file.id}" title="Abrir">${icon('expand')}</button>`}<button type="button" data-inline-delete="${file.id}" title="Remover">${icon('trash')}</button></span></div>`;
}
function subnoteBlockHtml(note){
  const trashed=!!note.trashed_at;
  return `<div class="inline-subnote${note.missing?' missing':''}${trashed?' trashed':''}" contenteditable="false" draggable="true" tabindex="0" role="group" aria-label="Subnota: ${esc(note.title||'Sem título')}" data-subnote-id="${note.id}" data-subnote-token="[[reposit-subnote:${note.id}]]"><span class="inline-subnote-icon">${icon('document')}</span><span class="inline-subnote-copy"><small>SUBNOTA</small><strong>${esc(note.title||'Sem título')}</strong><span>${note.missing?'Subnota não encontrada':trashed?'Na lixeira':`${esc(note.kind||'Subnota')} · ${fmtDate(note.updated_at)}`}</span></span><span class="inline-subnote-actions">${note.missing?'':`<button type="button" data-subnote-open="${note.id}" title="Abrir">${icon('angle-right')}</button>`}<button type="button" data-subnote-delete="${note.id}" title="${note.missing?'Remover referência':'Excluir subnota'}">${icon('trash')}</button></span></div>`;
}
function textToEditorHtml(text='',files=[]){
  const byId=new Map((files||[]).map(f=>[String(f.id),f]));const seen=new Set();
  const parts=String(text||'').split(/(\[\[reposit-file:\d+(?:;[^\]]+)?\]\])/g).map(part=>{const token=parseMediaFileToken(part);if(token&&byId.has(token.id)){seen.add(token.id);return attachmentBlockHtml(byId.get(token.id),token);}return esc(part).replace(/\n/g,'<br>');});
  const orphan=(files||[]).filter(f=>!seen.has(String(f.id)));if(orphan.length)parts.push((text?'<br>':'')+orphan.map(attachmentBlockHtml).join(''));return parts.join('');
}
function contentToEditorHtml(note){
  const files=new Map((note.files||[]).map(f=>[String(f.id),f]));const subs=new Map((note.subnotes||[]).map(n=>[String(n.id),n]));
  if(note.content_format!=='html'){
    let html=textToEditorHtml(note.content||'',note.files||[]);for(const sub of note.subnotes||[]){const token=`[[reposit-subnote:${sub.id}]]`;if(!String(note.content||'').includes(token))html+=(html?'<br>':'')+subnoteBlockHtml(sub);}return html.replace(/\[\[reposit-subnote:(\d+)(?:;[^\]]+)?\]\]/g,(_,id)=>subs.has(id)?subnoteBlockHtml(subs.get(id)):subnoteBlockHtml({id,title:'Subnota não encontrada',missing:true}));
  }
  let html=sanitizeRichHtml(String(note.content||''));
  html=html.replace(/\[\[reposit-file:\d+(?:;[^\]]+)?\]\]/g,token=>{const parsed=parseMediaFileToken(token);return parsed&&files.has(parsed.id)?attachmentBlockHtml(files.get(parsed.id),parsed):'';});
  html=html.replace(/\[\[reposit-subnote:(\d+)(?:;[^\]]+)?\]\]/g,(_,id)=>subs.has(id)?subnoteBlockHtml(subs.get(id)):subnoteBlockHtml({id,title:'Subnota não encontrada',missing:true}));
  const presentFiles=new Set([...html.matchAll(/data-file-id="(\d+)"/g)].map(m=>m[1]));const orphanFiles=(note.files||[]).filter(f=>!presentFiles.has(String(f.id))&&f.state==='active');if(orphanFiles.length)html+=orphanFiles.map(attachmentBlockHtml).join('');
  const presentSubs=new Set([...html.matchAll(/data-subnote-id="(\d+)"/g)].map(m=>m[1]));const orphanSubs=(note.subnotes||[]).filter(sub=>!presentSubs.has(String(sub.id)));if(orphanSubs.length)html+=orphanSubs.map(subnoteBlockHtml).join('');return html;
}
const RICH_ALLOWED_TAGS=new Set(['P','DIV','BR','H1','H2','H3','H4','H5','H6','STRONG','B','EM','I','U','S','STRIKE','SUP','SUB','UL','OL','LI','BLOCKQUOTE','A','TABLE','THEAD','TBODY','TFOOT','TR','TD','TH','SPAN','FONT','HR','PRE','CODE']);
const RICH_ALLOWED_CLASSES=new Set(['reposit-callout','reposit-checklist','check-item','check-box','check-text','reposit-code-block','reposit-code-wrap']);
const RICH_ALLOWED_STYLES=new Set(['color','background-color','text-align','font-weight','font-style','text-decoration','font-family','font-size','white-space','width','min-width','max-width']);
function sanitizeInlineStyle(value=''){
  return String(value).split(';').map(part=>part.trim()).filter(Boolean).map(part=>{const idx=part.indexOf(':');if(idx<1)return '';const key=part.slice(0,idx).trim().toLowerCase(),val=part.slice(idx+1).trim();if(!RICH_ALLOWED_STYLES.has(key))return '';if(/expression|url\s*\(|javascript:/i.test(val))return '';return `${key}:${val}`;}).filter(Boolean).join(';');
}
function sanitizeRichHtml(raw=''){
  // Parse in an inert document first. Assigning untrusted markup to an element in
  // the live document can fire resource/error handlers before we get a chance to
  // strip them. DOMParser's text/html document is inert until nodes are adopted.
  const parsed=new DOMParser().parseFromString(String(raw||''),'text/html');
  const box=parsed.body;
  box.querySelectorAll('script,style,iframe,object,embed,link,meta,form,input,button,textarea,select,svg,math').forEach(n=>n.remove());
  [...box.querySelectorAll('*')].forEach(el=>{
    if(!RICH_ALLOWED_TAGS.has(el.tagName)){el.replaceWith(...el.childNodes);return;}
    [...el.attributes].forEach(attr=>{
      const name=attr.name.toLowerCase();
      const classAllowed=name==='class'&&String(attr.value||'').split(/\s+/).every(c=>!c||RICH_ALLOWED_CLASSES.has(c)||(el.tagName==='TABLE'&&c==='editor-table'));
      const dataAllowed=(el.tagName==='P'&&name==='data-check-item')||(el.tagName==='PRE'&&name==='data-language');
      const allowed=(name==='style')||classAllowed||dataAllowed||(el.tagName==='A'&&['href','title','target'].includes(name))||(el.tagName==='FONT'&&['face','size','color'].includes(name))||(['TD','TH'].includes(el.tagName)&&['colspan','rowspan'].includes(name))||(el.tagName==='TABLE'&&name==='data-editor-table');
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
  const editor=$('#notion-content');if(!editor)return;selectionManager.remember();
  const image=window.RepositEditor072?.clipboard?.imageFromClipboard(event);
  if(image){event.preventDefault();const sel=window.getSelection();const range=sel?.rangeCount?sel.getRangeAt(0).cloneRange():null;void handleFiles([image],range);forcePlainPasteOnce=false;return;}
  event.preventDefault();const plain=event.clipboardData?.getData('text/plain')||'';const html=event.clipboardData?.getData('text/html')||'';
  if(forcePlainPasteOnce||!html)insertPlainTextAtSelection(plain);else{selectionManager.restore();document.execCommand('insertHTML',false,sanitizeRichHtml(html));}
  forcePlainPasteOnce=false;editor.dispatchEvent(new Event('input',{bubbles:true}));selectionManager.remember();
}
function serializeEditorContent(editor){
  if(!editor)return '';
  const clone=editor.cloneNode(true);
  clone.querySelectorAll('.inline-drop-indicator,[data-upload-temp],.productivity-ephemeral').forEach(el=>el.remove());
  clone.querySelectorAll('[data-file-token]').forEach(block=>block.replaceWith(document.createTextNode(block.dataset.fileToken||'')));
  clone.querySelectorAll('[data-subnote-token]').forEach(block=>block.replaceWith(document.createTextNode(block.dataset.subnoteToken||'')));
  clone.querySelectorAll('[contenteditable],[draggable],[tabindex],[role],[aria-label]').forEach(el=>{el.removeAttribute('contenteditable');el.removeAttribute('draggable');el.removeAttribute('tabindex');el.removeAttribute('role');el.removeAttribute('aria-label');});
  return sanitizeRichHtml(clone.innerHTML).trim();
}
function historyFor(noteId=state.active?.id){const id=Number(noteId||0);if(!id)return null;if(!specialHistories.has(id)&&window.RepositEditor072?.SpecialHistory)specialHistories.set(id,new window.RepositEditor072.SpecialHistory(128));return specialHistories.get(id)||null;}
function recordSpecialHistory(before,label='operation'){const editor=$('#notion-content');if(!editor||before===null||before===undefined)return;historyFor()?.record(before,editor.innerHTML,label);}
function restoreSpecialHistory(direction){const editor=$('#notion-content'),history=historyFor();if(!editor||!history)return false;const html=direction==='undo'?history.undo(editor.innerHTML):history.redo(editor.innerHTML);if(html===null)return false;editor.innerHTML=html;bindInlineAttachments(state.active);editor.dispatchEvent(new Event('input',{bubbles:true}));return true;}
function insertNodeAtCaret(editor,node,rangeOverride=null){
  editor.focus({preventScroll:true});const sel=window.getSelection();let range=rangeOverride?.cloneRange?.()||null;
  if(!range&&sel?.rangeCount&&editor.contains(sel.anchorNode))range=sel.getRangeAt(0).cloneRange();
  const before=editor.innerHTML;
  if(range&&range.startContainer?.isConnected&&editor.contains(range.startContainer)){const block=range.startContainer.nodeType===1?range.startContainer.closest?.('[contenteditable="false"]'):range.startContainer.parentElement?.closest?.('[contenteditable="false"]');if(block&&editor.contains(block)){const fixed=document.createRange();fixed.setStartAfter(block);fixed.collapse(true);range=fixed;}range.deleteContents();range.insertNode(node);range.setStartAfter(node);range.collapse(true);sel.removeAllRanges();sel.addRange(range);}else{editor.append(node);const end=document.createRange();end.setStartAfter(node);end.collapse(true);sel.removeAllRanges();sel.addRange(end);}
  recordSpecialHistory(before,'insert-block');editor.dispatchEvent(new Event('input',{bubbles:true}));selectionManager.remember();
}
function placeAttachmentAtCaret(editor,file){
  if(!editor)return;const wrap=document.createElement('div');wrap.innerHTML=attachmentBlockHtml(file);insertNodeAtCaret(editor,wrap.firstElementChild);
}
function placeSubnoteAtCaret(editor,note){
  if(!editor)return;const wrap=document.createElement('div');wrap.innerHTML=subnoteBlockHtml(note);insertNodeAtCaret(editor,wrap.firstElementChild);
}
function clearInlineBlockSelection(){
  const editor=$('#notion-content');editor?.querySelectorAll('.block-selected,.selected').forEach(x=>x.classList.remove('block-selected','selected'));selectedInlineBlock=null;
}
function selectInlineBlock(block){
  if(!block)return;clearInlineBlockSelection();selectedInlineBlock=block;block.classList.add('block-selected');block.focus?.({preventScroll:true});
}
async function removeInlineFileBlock(block){
  if(!block?.dataset.fileId)return;const id=Number(block.dataset.fileId),editor=$('#notion-content');const before=editor?.innerHTML||'';const next=block.nextSibling,clone=block.cloneNode(true);block.remove();recordSpecialHistory(before,'remove-attachment');editor?.dispatchEvent(new Event('input',{bubbles:true}));
  const saved=await saveNotionPage(state.active.id,true,{force:true});
  if(!saved){toast('O bloco foi removido localmente, mas a exclusão física ficou pendente até a nota salvar.','err');return;}
  try{await del(`/api/note-files/${id}`);}catch(err){if(err?.status!==409)toast(`Arquivo mantido com segurança: ${err.message}`,'err');}
  if(next?.isConnected)window.RepositEditor072?.inlineBlocks?.placeCaret(next,false);else if(clone)selectionManager.remember();
}
function bindInlineAttachments(note){
  const editor=$('#notion-content');if(!editor)return;
  if(editor.dataset.inlineBound==='1')return;editor.dataset.inlineBound='1';
  editor.addEventListener('click',e=>{
    const open=e.target.closest?.('[data-inline-open]');if(open){e.stopPropagation();window.open(`/api/note-files/${open.dataset.inlineOpen}`,'_blank');return;}
    const layout=e.target.closest?.('[data-inline-layout]');if(layout){e.stopPropagation();const block=layout.closest('.inline-media-image');const rect=block.getBoundingClientRect();openNoteContextMenu({preventDefault(){},clientX:rect.right-8,clientY:rect.top+30,target:block},state.active);return;}
    const remove=e.target.closest?.('[data-inline-delete]');if(remove){e.stopPropagation();void removeInlineFileBlock(remove.closest('[data-file-token]'));return;}
    const subOpen=e.target.closest?.('[data-subnote-open]');if(subOpen){e.stopPropagation();openNote(Number(subOpen.dataset.subnoteOpen));return;}
    const subDelete=e.target.closest?.('[data-subnote-delete]');if(subDelete){e.stopPropagation();const block=subDelete.closest('[data-subnote-token]');if(block?.classList.contains('missing')){const before=editor.innerHTML;block.remove();recordSpecialHistory(before,'remove-missing-subnote');editor.dispatchEvent(new Event('input',{bubbles:true}));}else deleteInlineSubnote(Number(subDelete.dataset.subnoteDelete),state.active.id,block);return;}
    const block=e.target.closest?.('[data-file-token],[data-subnote-token]');if(block){selectInlineBlock(block);return;}clearInlineBlockSelection();
  });
  editor.addEventListener('dblclick',e=>{const block=e.target.closest?.('[data-subnote-token]:not(.missing)');if(block)openNote(Number(block.dataset.subnoteId));});
  editor.addEventListener('pointerdown',e=>{
    const handle=e.target.closest?.('[data-media-resize]');
    if(handle){const block=handle.closest('.inline-media-image');if(!block)return;e.preventDefault();e.stopPropagation();selectInlineBlock(block);block.classList.add('resizing');block.setAttribute('draggable','false');const before=editor.innerHTML,side=handle.dataset.mediaResize,startX=e.clientX,editorWidth=Math.max(240,editor.getBoundingClientRect().width),startPx=block.getBoundingClientRect().width;handle.setPointerCapture?.(e.pointerId);
      const move=ev=>{const dx=ev.clientX-startX,px=side==='left'?startPx-dx:startPx+dx,pct=Math.round(Math.max(15,Math.min(100,(px/editorWidth)*100)));block.dataset.mediaWidth=String(pct);block.style.setProperty('--media-width',`${pct}%`);block.dataset.fileToken=mediaFileToken(block.dataset.fileId,{width:String(pct),ratio:block.dataset.mediaRatio,fit:block.dataset.mediaFit,align:block.dataset.mediaAlign,alt:block.dataset.mediaAlt,caption:block.dataset.mediaCaption});const badge=$('.media-size-badge',block);if(badge)badge.textContent=`${pct}%`;};
      const up=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',up);handle.removeEventListener('pointercancel',up);block.classList.remove('resizing');block.setAttribute('draggable','true');recordSpecialHistory(before,'resize-image');editor.dispatchEvent(new Event('input',{bubbles:true}));};handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',up);handle.addEventListener('pointercancel',up);return;}
    if(!e.target.closest?.('[data-file-token],[data-subnote-token]'))clearInlineBlockSelection();
  });
  editor.addEventListener('dragstart',e=>{const block=e.target.closest?.('[data-file-token],[data-subnote-token]');if(!block||block.classList.contains('resizing'))return;editor.__draggedBlock=block;editor.__dragBefore=editor.innerHTML;block.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/x-reposit-block',block.dataset.fileId||block.dataset.subnoteId||'');});
  editor.addEventListener('dragend',()=>{editor.__draggedBlock?.classList.remove('dragging');editor.__draggedBlock=null;window.RepositEditor072?.inlineBlocks?.clearIndicator(editor);});
  editor.addEventListener('dragover',e=>{const files=e.dataTransfer?.types?.includes?.('Files');if(!editor.__draggedBlock&&!files)return;e.preventDefault();e.stopPropagation();const range=window.RepositEditor072?.inlineBlocks?.rangeFromPoint(editor,e.clientX,e.clientY);if(range)window.RepositEditor072?.inlineBlocks?.insertIndicator(editor,range);});
  editor.addEventListener('dragleave',e=>{if(!editor.contains(e.relatedTarget))window.RepositEditor072?.inlineBlocks?.clearIndicator(editor);});
  editor.addEventListener('drop',e=>{const dragged=editor.__draggedBlock;const files=[...(e.dataTransfer?.files||[])];if(!dragged&&!files.length)return;e.preventDefault();e.stopPropagation();const indicator=editor.querySelector('.inline-drop-indicator');if(dragged){dragged.classList.remove('dragging');if(indicator)indicator.replaceWith(dragged);recordSpecialHistory(editor.__dragBefore||'', 'move-block');editor.__draggedBlock=null;editor.__dragBefore='';editor.dispatchEvent(new Event('input',{bubbles:true}));window.RepositEditor072?.inlineBlocks?.placeCaret(dragged,true);return;}const range=indicator?(()=>{const r=document.createRange();r.setStartBefore(indicator);r.collapse(true);indicator.remove();return r;})():window.RepositEditor072?.inlineBlocks?.rangeFromPoint(editor,e.clientX,e.clientY);void handleFiles(files,range);});
  editor.addEventListener('keydown',e=>{
    if(e.key==='Tab'){const before=editor.innerHTML;if(window.RepositEditor072?.tables?.handleTab(e)){if(before!==editor.innerHTML)recordSpecialHistory(before,'table-tab-row');editor.dispatchEvent(new Event('input',{bubbles:true}));return;}}
    if(e.key==='Escape'&&selectedInlineBlock){e.preventDefault();const block=selectedInlineBlock;clearInlineBlockSelection();window.RepositEditor072?.inlineBlocks?.placeCaret(block,true);return;}
    if(selectedInlineBlock&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();const block=selectedInlineBlock,after=['ArrowRight','ArrowDown'].includes(e.key);clearInlineBlockSelection();window.RepositEditor072?.inlineBlocks?.placeCaret(block,after);return;}
    if(!['Backspace','Delete'].includes(e.key))return;const sel=window.getSelection(),range=sel?.rangeCount?sel.getRangeAt(0):null;
    if(selectedInlineBlock?.isConnected){e.preventDefault();const block=selectedInlineBlock;clearInlineBlockSelection();if(block.matches('[data-subnote-token]')){if(block.classList.contains('missing')){const before=editor.innerHTML;block.remove();recordSpecialHistory(before,'remove-missing-subnote');editor.dispatchEvent(new Event('input',{bubbles:true}));}else deleteInlineSubnote(Number(block.dataset.subnoteId),state.active.id,block);}else void removeInlineFileBlock(block);return;}
    const block=window.RepositEditor072?.inlineBlocks?.adjacentBlock(range,e.key,editor);if(block){e.preventDefault();selectInlineBlock(block);}
  });
}
function updateInlineImageLayout(block,patch={}){
  if(!block)return;const before=block.closest('#notion-content')?.innerHTML||'';const current=normalizeMediaLayout({width:block.dataset.mediaWidth,ratio:block.dataset.mediaRatio,fit:block.dataset.mediaFit,align:block.dataset.mediaAlign,alt:block.dataset.mediaAlt,caption:block.dataset.mediaCaption});
  const next=normalizeMediaLayout({...current,...patch});Object.assign(block.dataset,{mediaWidth:next.width,mediaRatio:next.ratio,mediaFit:next.fit,mediaAlign:next.align,mediaAlt:next.alt,mediaCaption:next.caption});block.dataset.fileToken=mediaFileToken(block.dataset.fileId,next);
  block.classList.remove('align-left','align-center','align-right');block.classList.add(`align-${next.align}`);if(next.width==='auto')block.style.removeProperty('--media-width');else block.style.setProperty('--media-width',`${next.width}%`);
  const img=$('img',block);if(img)img.alt=next.alt||img.alt;let caption=$('figcaption',block);if(next.caption){if(!caption){caption=document.createElement('figcaption');block.appendChild(caption);}caption.textContent=next.caption;}else caption?.remove();
  const badge=$('.media-size-badge',block);if(badge)badge.textContent=next.width==='auto'?'Auto':`${next.width}%`;recordSpecialHistory(before,'image-layout');block.closest('#notion-content')?.dispatchEvent(new Event('input',{bubbles:true}));
}
function imageLayoutMenuHtml(block){
  const m=normalizeMediaLayout({width:block.dataset.mediaWidth,ratio:block.dataset.mediaRatio,fit:block.dataset.mediaFit,align:block.dataset.mediaAlign,alt:block.dataset.mediaAlt,caption:block.dataset.mediaCaption});
  const active=(kind,value)=>m[kind]===value?' active':'';const slider=m.width==='auto'?100:Number(m.width);
  return `<div class="context-title">Imagem · tamanho</div><div class="image-size-slider"><input type="range" min="15" max="100" step="1" value="${slider}" data-image-slider><output>${m.width==='auto'?'Auto':m.width+'%'}</output></div><div class="context-grid context-grid-5"><button class="${active('width','auto')}" data-image-width="auto">Auto</button><button class="${active('width','25')}" data-image-width="25">25%</button><button class="${active('width','50')}" data-image-width="50">50%</button><button class="${active('width','75')}" data-image-width="75">75%</button><button class="${active('width','100')}" data-image-width="100">100%</button></div><div class="context-title">Alinhamento</div><div class="context-grid"><button class="${active('align','left')}" data-image-align="left">Esquerda</button><button class="${active('align','center')}" data-image-align="center">Centro</button><button class="${active('align','right')}" data-image-align="right">Direita</button></div><div class="context-title">Proporção</div><div class="context-grid"><button class="${active('ratio','auto')}" data-image-ratio="auto">Original</button><button class="${active('ratio','1x1')}" data-image-ratio="1x1">1:1</button><button class="${active('ratio','4x3')}" data-image-ratio="4x3">4:3</button><button class="${active('ratio','16x9')}" data-image-ratio="16x9">16:9</button></div><div class="context-title">Encaixe</div><div class="context-grid context-grid-2"><button class="${active('fit','contain')}" data-image-fit="contain">Ajustar inteira</button><button class="${active('fit','cover')}" data-image-fit="cover">Preencher/cortar</button></div>`;
}
async function copyImageToClipboard(block){
  try{const res=await fetch(`/api/note-files/${block.dataset.fileId}`),blob=await res.blob();if(navigator.clipboard?.write&&window.ClipboardItem){await navigator.clipboard.write([new ClipboardItem({[blob.type||'image/png']:blob})]);toast('Imagem copiada.','ok');return;}throw new Error('Clipboard de imagem indisponível.');}catch(err){toast(err.message,'err');}
}
function duplicateImageBlock(block){const editor=$('#notion-content');if(!editor||!block)return;const before=editor.innerHTML,clone=block.cloneNode(true);clone.classList.remove('block-selected','selected');block.after(clone);recordSpecialHistory(before,'duplicate-image');editor.dispatchEvent(new Event('input',{bubbles:true}));}
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
  const editor=$('#notion-content');if(!editor)return;const table=document.createElement('table');table.className='editor-table';table.setAttribute('data-editor-table','1');table.setAttribute('aria-label','Tabela da anotação');
  const body=document.createElement('tbody');for(let r=0;r<rows;r++){const tr=document.createElement('tr');for(let c=0;c<cols;c++){const td=document.createElement('td');td.innerHTML='<br>';tr.appendChild(td);}body.appendChild(tr);}table.appendChild(body);insertNodeAtCaret(editor,table);
}
function tableCell(){return window.RepositEditor072?.tables?.cellFromSelection?.()||null;}
function editTable(action){
  const cell=tableCell();if(!cell)return toast('Clique dentro de uma tabela primeiro.','err');const editor=$('#notion-content'),before=editor.innerHTML;const map={'row+':'row-below','row-':'row-remove','col+':'col-after','col-':'col-remove'};const normalized=map[action]||action;if(!window.RepositEditor072?.tables?.operate(normalized,cell))return;recordSpecialHistory(before,`table-${normalized}`);editor.dispatchEvent(new Event('input',{bubbles:true}));
}
function tableMenuHtml(){return `<div class="context-title">Tabela</div><div class="context-grid context-grid-2"><button data-table-action="row-above">Linha acima</button><button data-table-action="row-below">Linha abaixo</button><button data-table-action="col-before">Coluna antes</button><button data-table-action="col-after">Coluna depois</button></div><button class="context-item" data-table-action="header-toggle">Alternar primeira linha como cabeçalho</button><div class="context-separator"></div><div class="context-grid"><button data-table-align="left">Esquerda</button><button data-table-align="center">Centro</button><button data-table-align="right">Direita</button></div><label class="context-control"><span>Largura da coluna</span><input type="number" min="60" max="600" step="10" value="140" data-table-width></label><div class="context-separator"></div><div class="context-grid context-grid-2"><button class="context-danger" data-table-action="row-remove">Remover linha</button><button class="context-danger" data-table-action="col-remove">Remover coluna</button></div>`;}
function commandColorHex(value=''){
  const raw=String(value||'').trim();if(/^#[0-9a-f]{6}$/i.test(raw))return raw;
  const rgb=raw.match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/i);if(!rgb)return null;
  return `#${[rgb[1],rgb[2],rgb[3]].map(v=>Math.max(0,Math.min(255,Number(v))).toString(16).padStart(2,'0')).join('')}`;
}
function updateToolbarState(){
  const editor=$('#notion-content'),toolbar=$('#editor-toolbar'),sel=window.getSelection();if(!editor||!toolbar||!sel?.rangeCount||!editor.contains(sel.anchorNode))return;
  const stateCommands=['bold','italic','underline','justifyLeft','justifyCenter','justifyRight','insertUnorderedList','insertOrderedList'];
  stateCommands.forEach(cmd=>{try{const button=$(`[data-cmd="${cmd}"]`,toolbar),active=document.queryCommandState(cmd);button?.classList.toggle('active',active);if(button)button.setAttribute('aria-pressed',String(!!active));}catch(_err){}});
  try{const block=String(document.queryCommandValue('formatBlock')||'p').replace(/[<>]/g,'').toLowerCase();const select=$('#block-format');if(select&&[...select.options].some(o=>o.value===block))select.value=block;}catch(_err){}
  try{const size=String(document.queryCommandValue('fontSize')||'');const select=$('#font-size');if(select&&[...select.options].some(o=>o.value===size))select.value=size;}catch(_err){}
  try{const color=commandColorHex(document.queryCommandValue('foreColor'));if(color&&$('#text-color'))$('#text-color').value=color;}catch(_err){}
}
function closeFloatingToolbar(){document.querySelector('.selection-toolbar')?.remove();}
function updateFloatingToolbar(){
  const editor=$('#notion-content'),sel=window.getSelection();if(!editor||!sel?.rangeCount||sel.isCollapsed||!editor.contains(sel.anchorNode)||!sel.toString().trim()){closeFloatingToolbar();return;}selectionManager.remember();let bar=$('.selection-toolbar');if(!bar){bar=document.createElement('div');bar.className='selection-toolbar';bar.setAttribute('role','toolbar');bar.setAttribute('aria-label','Formatação da seleção');bar.innerHTML=`<button data-float-cmd="bold" aria-label="Negrito" title="Negrito · Ctrl+B"><b>B</b></button><button data-float-cmd="italic" aria-label="Itálico" title="Itálico · Ctrl+I"><i>I</i></button><button data-float-cmd="underline" aria-label="Sublinhado" title="Sublinhado · Ctrl+U"><u>U</u></button><input type="color" data-float-color aria-label="Cor do texto"><button data-float-link aria-label="Inserir link" title="Link · Ctrl+K">${icon('link')}</button>`;document.body.appendChild(bar);bar.addEventListener('pointerdown',e=>{if(e.target.closest('button'))e.preventDefault();selectionManager.restore();});$$('[data-float-cmd]',bar).forEach(b=>b.onclick=()=>editorFormat(b.dataset.floatCmd));$('[data-float-color]',bar).oninput=e=>{selectionManager.restore();editorFormat('foreColor',e.target.value);};$('[data-float-link]',bar).onclick=()=>{selectionManager.restore();insertLink();};}
  const rect=sel.getRangeAt(0).getBoundingClientRect(),br=bar.getBoundingClientRect(),left=Math.max(8,Math.min(rect.left+rect.width/2-br.width/2,window.innerWidth-br.width-8)),top=Math.max(8,rect.top-br.height-8);bar.style.left=`${left}px`;bar.style.top=`${top}px`;
}

function closeNoteContextMenu(){document.querySelector('.note-context-menu')?.remove();}
function openNoteContextMenu(event,n){
  event.preventDefault();rememberEditorSelection();closeNoteContextMenu();
  const menu=document.createElement('div');menu.className='note-context-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label','Menu do editor');
  const files=n.files||[],imageBlock=event.target?.closest?.('.inline-media-image'),subnoteBlock=event.target?.closest?.('[data-subnote-token]'),tableCellBlock=event.target?.closest?.('td,th'),editor=event.target?.closest?.('#notion-content')||$('#notion-content');
  const selection=window.getSelection(),hasSelection=!!(selection&&selection.toString().trim()&&editor&&editor.contains(selection.anchorNode));
  const submenu=(label,ic,body)=>`<div class="context-entry has-submenu"><button class="context-item">${icon(ic)}<span>${label}</span>${icon('angle-right')}</button><div class="context-submenu">${body}</div></div>`;
  if(imageBlock){
    menu.classList.add('image-context-menu');const missing=imageBlock.classList.contains('missing');
    menu.innerHTML=`${imageLayoutMenuHtml(imageBlock)}<div class="context-separator"></div><button class="context-item" data-context-image-alt><span>Texto alternativo</span></button><button class="context-item" data-context-image-caption><span>Legenda</span></button><button class="context-item" data-context-image-replace><span>${missing?'Localizar/substituir':'Substituir imagem'}</span></button><button class="context-item" data-context-image-copy ${missing?'disabled':''}>${icon('copy')}<span>Copiar imagem</span></button><button class="context-item" data-context-image-duplicate>${icon('copy')}<span>Duplicar bloco</span></button>${missing?'':`<button class="context-item" data-context-image-open>${icon('expand')}<span>Abrir original</span></button>`}<button class="context-item context-danger" data-context-image-delete>${icon('trash')}<span>Remover imagem</span></button>`;
  }else if(subnoteBlock){
    const sid=Number(subnoteBlock.dataset.subnoteId),missing=subnoteBlock.classList.contains('missing');menu.classList.add('subnote-context-menu');
    menu.innerHTML=`<div class="context-title">Subnota</div>${missing?'':`<button class="context-item" data-subnote-context-open="${sid}">${icon('document')}<span>Abrir subnota</span></button><button class="context-item" data-subnote-context-rename="${sid}"><span>Renomear</span></button>`}<button class="context-item context-danger" data-subnote-context-delete="${sid}">${icon('trash')}<span>${missing?'Remover referência':'Excluir subnota'}</span></button>`;
  }else if(tableCellBlock){
    menu.classList.add('table-context-menu');menu.innerHTML=tableMenuHtml();
  }else{
    const formatSub=`<div class="context-subtitle">Estilo</div><button data-context-block="p">${icon('document')} Texto normal</button><button data-context-block="h1"><span class="context-text-icon">H1</span> Título 1</button><button data-context-block="h2"><span class="context-text-icon">H2</span> Título 2</button><button data-context-block="h3"><span class="context-text-icon">H3</span> Título 3</button><div class="context-separator"></div><button data-context-cmd="strikeThrough">${icon('strike')} Tachado</button><button data-context-cmd="superscript">${icon('superscript')} Sobrescrito</button><button data-context-cmd="subscript">${icon('subscript')} Subscrito</button><button data-context-cmd="removeFormat">${icon('clear-format')} Limpar formatação</button><div class="context-separator"></div><label class="context-control">${icon('font')}<span>Fonte</span><select data-context-font><option>Segoe UI</option><option>Arial</option><option>Georgia</option><option>Verdana</option><option>Times New Roman</option><option>Courier New</option></select></label><label class="context-control">${icon('palette')}<span>Texto</span><input type="color" data-context-color value="#55d98b"></label><label class="context-control">${icon('palette')}<span>Marca-texto</span><input type="color" data-context-highlight value="#335d42"></label>`;
    const layoutSub=`<button data-context-cmd="justifyLeft">${icon('align-left')} Alinhar à esquerda</button><button data-context-cmd="justifyCenter">${icon('align-center')} Centralizar</button><button data-context-cmd="justifyRight">${icon('align-right')} Alinhar à direita</button><button data-context-cmd="justifyFull">${icon('align-justify')} Justificar</button><div class="context-separator"></div><button data-context-cmd="insertUnorderedList">${icon('list')} Lista com marcadores</button><button data-context-cmd="insertOrderedList">${icon('numbered-list')} Lista numerada</button><button data-context-cmd="outdent">${icon('outdent')} Diminuir recuo</button><button data-context-cmd="indent">${icon('indent')} Aumentar recuo</button>`;
    const insertSub=`<button data-note-menu="attach">${icon('clip')} Anexar arquivo</button><button data-note-menu="subnote">${icon('plus')} Criar subnota</button><button data-note-menu="table">${icon('table')} Grade 3×3</button><button data-context-cmd="insertHorizontalRule">${icon('horizontal-line')} Linha horizontal</button><button data-note-menu="link">${icon('link')} Link</button>`;
    const fileSub=files.length?submenu(`Anexos (${files.length})`,'file',files.map(f=>`<div class="context-file"><button data-context-open="${f.id}" title="Abrir"><span>${icon('file')} ${esc(f.filename)}</span></button><button class="context-file-remove" data-context-delete="${f.id}" title="Remover">${icon('trash')}</button></div>`).join('')):'';
    menu.innerHTML=`<div class="context-title">${hasSelection?'Texto selecionado':'Nota'}</div><div class="context-quick-actions"><button data-context-cmd="bold" title="Negrito">${icon('bold')}</button><button data-context-cmd="italic" title="Itálico">${icon('italic')}</button><button data-context-cmd="underline" title="Sublinhado">${icon('underline')}</button></div><div class="context-separator"></div>${submenu('Formatação','font',formatSub)}${submenu('Parágrafo e listas','align-left',layoutSub)}${submenu('Inserir','plus',insertSub)}${fileSub}<div class="context-separator"></div><button class="context-item" data-note-menu="export">${icon('export')}<span>Exportar anotação</span></button>${n.parent_note_id?`<button class="context-item context-danger" data-note-menu="delete-subnote">${icon('trash')}<span>Excluir esta subnota</span></button>`:''}`;
  }
  if(event.clientX>window.innerWidth-470)menu.classList.add('submenu-left');document.body.appendChild(menu);const rect=menu.getBoundingClientRect();menu.style.left=`${Math.max(8,Math.min(event.clientX,window.innerWidth-rect.width-8))}px`;menu.style.top=`${Math.max(8,Math.min(event.clientY,window.innerHeight-rect.height-8))}px`;
  if(imageBlock){
    $$('[data-image-width]',menu).forEach(b=>b.onclick=()=>{updateInlineImageLayout(imageBlock,{width:b.dataset.imageWidth});closeNoteContextMenu();});const sizeSlider=$('[data-image-slider]',menu);if(sizeSlider){let before='';sizeSlider.onpointerdown=()=>before=editor.innerHTML;sizeSlider.oninput=e=>{const current=normalizeMediaLayout({width:e.target.value,ratio:imageBlock.dataset.mediaRatio,fit:imageBlock.dataset.mediaFit,align:imageBlock.dataset.mediaAlign,alt:imageBlock.dataset.mediaAlt,caption:imageBlock.dataset.mediaCaption});imageBlock.dataset.mediaWidth=current.width;imageBlock.style.setProperty('--media-width',`${current.width}%`);imageBlock.dataset.fileToken=mediaFileToken(imageBlock.dataset.fileId,current);const out=$('output',menu);if(out)out.textContent=`${e.target.value}%`;};sizeSlider.onchange=()=>{recordSpecialHistory(before,'resize-image-slider');editor.dispatchEvent(new Event('input',{bubbles:true}));closeNoteContextMenu();};}
    $$('[data-image-ratio]',menu).forEach(b=>b.onclick=()=>{updateInlineImageLayout(imageBlock,{ratio:b.dataset.imageRatio,fit:b.dataset.imageRatio==='auto'?'contain':imageBlock.dataset.mediaFit});closeNoteContextMenu();});$$('[data-image-fit]',menu).forEach(b=>b.onclick=()=>{updateInlineImageLayout(imageBlock,{fit:b.dataset.imageFit});closeNoteContextMenu();});$$('[data-image-align]',menu).forEach(b=>b.onclick=()=>{updateInlineImageLayout(imageBlock,{align:b.dataset.imageAlign});closeNoteContextMenu();});
    $('[data-context-image-alt]',menu).onclick=()=>{const value=prompt('Texto alternativo da imagem:',imageBlock.dataset.mediaAlt||'');if(value!==null)updateInlineImageLayout(imageBlock,{alt:value});closeNoteContextMenu();};$('[data-context-image-caption]',menu).onclick=()=>{const value=prompt('Legenda da imagem:',imageBlock.dataset.mediaCaption||'');if(value!==null)updateInlineImageLayout(imageBlock,{caption:value});closeNoteContextMenu();};$('[data-context-image-replace]',menu).onclick=()=>{replaceImageTarget=imageBlock;closeNoteContextMenu();$('#replace-image-picker')?.click();};$('[data-context-image-copy]',menu).onclick=()=>{closeNoteContextMenu();void copyImageToClipboard(imageBlock);};$('[data-context-image-duplicate]',menu).onclick=()=>{duplicateImageBlock(imageBlock);closeNoteContextMenu();};$('[data-context-image-open]',menu)?.addEventListener('click',()=>{closeNoteContextMenu();window.open(`/api/note-files/${imageBlock.dataset.fileId}`,'_blank');});$('[data-context-image-delete]',menu).onclick=()=>{closeNoteContextMenu();void removeInlineFileBlock(imageBlock);};
  }else if(subnoteBlock){
    $('[data-subnote-context-open]',menu)?.addEventListener('click',()=>{closeNoteContextMenu();openNote(Number(subnoteBlock.dataset.subnoteId));});$('[data-subnote-context-rename]',menu)?.addEventListener('click',async()=>{const title=prompt('Novo nome da subnota:',subnoteBlock.querySelector('strong')?.textContent||'');if(title?.trim()){try{const saved=await patch(`/api/notes/${subnoteBlock.dataset.subnoteId}`,{title:title.trim()});subnoteBlock.querySelector('strong').textContent=saved.title;ensureNoteTab(saved);}catch(err){toast(err.message,'err');}}closeNoteContextMenu();});$('[data-subnote-context-delete]',menu).onclick=()=>{closeNoteContextMenu();if(subnoteBlock.classList.contains('missing')){const before=editor.innerHTML;subnoteBlock.remove();recordSpecialHistory(before,'remove-missing-subnote');editor.dispatchEvent(new Event('input',{bubbles:true}));}else deleteInlineSubnote(Number(subnoteBlock.dataset.subnoteId),n.id,subnoteBlock);};
  }else if(tableCellBlock){
    $$('[data-table-action]',menu).forEach(b=>b.onclick=()=>{selectionManager.restore(n.id);editTable(b.dataset.tableAction);closeNoteContextMenu();});$$('[data-table-align]',menu).forEach(b=>b.onclick=()=>{selectionManager.restore(n.id);const cell=tableCell();if(cell){const before=editor.innerHTML;cell.style.textAlign=b.dataset.tableAlign;recordSpecialHistory(before,'table-align');editor.dispatchEvent(new Event('input',{bubbles:true}));}closeNoteContextMenu();});$('[data-table-width]',menu)?.addEventListener('change',e=>{selectionManager.restore(n.id);const cell=tableCell(),before=editor.innerHTML;if(window.RepositEditor072?.tables?.setColumnWidth(cell,e.target.value)){recordSpecialHistory(before,'table-width');editor.dispatchEvent(new Event('input',{bubbles:true}));}closeNoteContextMenu();});
  }else{
    $$('[data-context-cmd]',menu).forEach(b=>b.onmousedown=e=>{e.preventDefault();contextEditorFormat(b.dataset.contextCmd);closeNoteContextMenu();});$$('[data-context-block]',menu).forEach(b=>b.onmousedown=e=>{e.preventDefault();contextEditorBlock(b.dataset.contextBlock);closeNoteContextMenu();});$('[data-context-font]',menu)?.addEventListener('change',e=>{contextEditorFormat('fontName',e.target.value);closeNoteContextMenu();});$('[data-context-color]',menu)?.addEventListener('input',e=>contextEditorFormat('foreColor',e.target.value));$('[data-context-highlight]',menu)?.addEventListener('input',e=>contextEditorFormat('hiliteColor',e.target.value));$('[data-note-menu="attach"]',menu)?.addEventListener('click',()=>{restoreEditorSelection();pendingAttachmentNoteId=n.id;closeNoteContextMenu();$('#global-file-picker').click();});$('[data-note-menu="subnote"]',menu)?.addEventListener('click',()=>{restoreEditorSelection();closeNoteContextMenu();createSubnote(n.id);});$('[data-note-menu="table"]',menu)?.addEventListener('click',()=>{restoreEditorSelection();closeNoteContextMenu();insertTable(3,3);});$('[data-note-menu="link"]',menu)?.addEventListener('click',()=>{restoreEditorSelection();closeNoteContextMenu();insertLink();});$('[data-note-menu="export"]',menu)?.addEventListener('click',()=>{closeNoteContextMenu();openExportModal(n.id);});$('[data-note-menu="delete-subnote"]',menu)?.addEventListener('click',()=>{closeNoteContextMenu();confirmDeleteNote(n.id);});$$('[data-context-open]',menu).forEach(b=>b.onclick=()=>{closeNoteContextMenu();window.open(`/api/note-files/${b.dataset.contextOpen}`,'_blank');});$$('[data-context-delete]',menu).forEach(b=>b.onclick=async()=>{const block=editor.querySelector(`[data-file-id="${b.dataset.contextDelete}"]`);closeNoteContextMenu();if(block)void removeInlineFileBlock(block);else try{await del(`/api/note-files/${b.dataset.contextDelete}`);}catch(err){toast(err.message,'err');}});
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
  main.innerHTML=`<section class="page notion-page rich-note-page ${parent?'subnote-page':''}" id="note-editor-panel" role="tabpanel" aria-label="Editor da nota"><div class="notion-topline"><button class="notion-back" id="notion-back">${icon('angle-left')} Voltar</button><div class="notion-browser-trail">${parent?`<button data-parent-note="${parent.id}">${esc(parent.title||'Nota principal')}</button><span>${icon('angle-right')}</span>`:''}<strong>${esc(n.title||'Sem título')}</strong></div><div class="notion-top-actions"><span class="save-book" id="save-book" aria-hidden="true"><i></i><i></i><i></i></span><span class="content-limit-state" id="content-limit-state" aria-live="polite"></span><span class="autosave-state" id="autosave-state" aria-live="polite"></span><button class="save-retry" id="save-retry" type="button" hidden>Tentar novamente</button><button class="btn soft" id="notion-favorite">${n.favorite?'★':'☆'} ${n.favorite?'Favorita':'Favoritar'}</button><button class="btn soft" id="notion-pin">${icon('bookmark')} ${n.pinned?'Fixada':'Fixar'}</button><button class="btn soft" id="notion-history">Histórico</button><button class="btn soft" id="notion-export">${icon('export')} Exportar</button><button class="btn ghost-danger notion-trash" id="notion-delete" title="Mover para a Lixeira">${icon('trash')}</button></div></div>
    <div class="editor-toolbar editor-toolbar-primary" id="editor-toolbar" role="toolbar" aria-label="Ferramentas do editor"><div class="tool-group tool-history"><button data-cmd="undo" aria-label="Desfazer" aria-keyshortcuts="Control+Z" title="Desfazer · Ctrl+Z">${icon('undo')}</button><button data-cmd="redo" aria-label="Refazer" aria-keyshortcuts="Control+Y" title="Refazer · Ctrl+Y">${icon('redo')}</button></div><div class="tool-group tool-block"><select id="block-format" aria-label="Estilo do texto" title="Texto/Título"><option value="p">Texto</option><option value="h1">Título 1</option><option value="h2">Título 2</option><option value="h3">Título 3</option></select></div><div class="tool-group text-tools primary-text-tools"><button data-cmd="bold" aria-label="Negrito" aria-pressed="false" aria-keyshortcuts="Control+B" title="Negrito · Ctrl+B">${icon('bold')}</button><button data-cmd="italic" aria-label="Itálico" aria-pressed="false" aria-keyshortcuts="Control+I" title="Itálico · Ctrl+I">${icon('italic')}</button><button data-cmd="underline" aria-label="Sublinhado" aria-pressed="false" aria-keyshortcuts="Control+U" title="Sublinhado · Ctrl+U">${icon('underline')}</button></div><div class="tool-group primary-lists"><button data-cmd="insertUnorderedList" aria-label="Lista com marcadores" aria-pressed="false" title="Lista com marcadores">${icon('list')}</button><button data-cmd="insertOrderedList" aria-label="Lista numerada" aria-pressed="false" title="Lista numerada">${icon('numbered-list')}</button></div><label class="tool-color" title="Cor do texto"><span>${icon('palette')}</span><input id="text-color" type="color" value="#e8edf5" aria-label="Cor do texto"></label><div class="tool-group insert-tools primary-insert"><button id="tool-attach" class="tool-action" aria-label="Inserir arquivo" title="Inserir arquivo">${icon('clip')}<span>Inserir</span></button><button id="tool-subnote" class="tool-action" aria-label="Criar subnota" title="Criar subnota">${icon('plus')}<span>Subnota</span></button><button id="tool-table" class="tool-action" aria-label="Inserir tabela" title="Inserir tabela 3 por 3">${icon('table')}</button></div></div>
    <div class="notion-scroll"><article class="notion-document" id="note-context-area">${parent?`<div class="subnote-banner"><span>SUBNOTA</span><button data-parent-note="${parent.id}">${icon('angle-left')} ${esc(parent.title||'Nota principal')}</button></div>`:''}<input id="notion-title" class="notion-title" value="${esc(n.title)}" placeholder="Sem título"><div class="notion-properties notion-properties-inline"><label><span>${icon('label')}</span><input id="notion-kind" list="notion-kind-options" value="${esc(n.kind||'Anotação')}" aria-label="Tipo"><datalist id="notion-kind-options"><option>Anotação</option><option>Atividade</option><option>Material</option><option>Trabalho</option><option>Resumo</option><option>Lembrete</option><option>Subnota</option><option>Outro</option></datalist></label><label class="tag-property"><span>${icon('tags')}</span><input id="notion-tags" list="note-tag-suggestions" value="${esc(n.tags||'')}" placeholder="Tags separadas por vírgula"><datalist id="note-tag-suggestions">${tagSuggestions}</datalist></label><div class="notion-property-static"><span>${icon('clock')}</span><strong>${fmt(n.updated_at)}</strong></div></div><div class="note-tag-chips" id="note-tag-chips">${renderTagChips(n.tags||'')}</div><div id="notion-content" class="notion-content rich-editor" contenteditable="true" spellcheck="true" role="textbox" aria-multiline="true" aria-label="Conteúdo da anotação" data-placeholder="Comece a escrever…">${contentToEditorHtml(n)}</div></article></div><div id="note-tabbar" class="note-tabbar"></div></section>`;
  const leave=async target=>{if(!(await leaveCurrentNote(target)))return false;return true;};
  $('#notion-back').onclick=async()=>{if(!(await leave(parent?'parent':'workspace')))return;if(parent)await openNote(parent.id);else{state.active=null;await renderWorkspace();}};
  $$('[data-parent-note]').forEach(b=>b.onclick=async()=>{if(await leave('parent'))await openNote(Number(b.dataset.parentNote));});
  $('#notion-favorite').onclick=async()=>{captureNoteRevision(n.id);if(noteSessions.get(n.id)?.dirty)await saveNotionPage(n.id,true,{force:true});if(noteSessions.get(n.id)?.dirty)return toast('Salve as alterações antes de favoritar.','err');const saved=await patch(`/api/notes/${n.id}`,{favorite:!n.favorite});state.active=materializeSessionNote(saved);ensureNoteTab(saved);renderNotionPage();};
  $('#notion-history').onclick=()=>openNoteHistory(n.id);
  $('#notion-pin').onclick=async()=>{captureNoteRevision(n.id);if(noteSessions.get(n.id)?.dirty)await saveNotionPage(n.id,true,{force:true});if(noteSessions.get(n.id)?.dirty)return toast('Salve as alterações antes de fixar a nota.','err');const saved=await patch(`/api/notes/${n.id}`,{pinned:!n.pinned});if(state.active?.id===n.id)state.active=materializeSessionNote(saved);ensureNoteTab(saved);renderNotionPage();};
  $('#notion-export').onclick=()=>openExportModal(n.id);$('#notion-delete').onclick=()=>confirmDeleteNote(n.id);$('#note-context-area').oncontextmenu=e=>openNoteContextMenu(e,n);
  const onEditorChange=()=>{markEditorDirty(n.id);scheduleNoteSave(n.id);};
  ['#notion-title','#notion-kind','#notion-tags','#notion-content'].forEach(sel=>$(sel)?.addEventListener('input',()=>{if(sel==='#notion-tags')$('#note-tag-chips').innerHTML=renderTagChips($('#notion-tags').value);if(sel==='#notion-title')updateTabTitle(n.id,$('#notion-title').value);onEditorChange();}));
  ['#notion-title','#notion-kind','#notion-tags'].forEach(sel=>$(sel)?.addEventListener('blur',()=>{const current=noteSessions.get(n.id);if(state.settings.autosave_enabled&&current?.dirty&&!current.isComposing)void saveNotionPage(n.id,true);}));
  const editor=$('#notion-content');
  editor?.addEventListener('paste',handleEditorPaste);
  editor?.addEventListener('compositionstart',()=>{const current=noteSession(n.id);current.isComposing=true;if(current.timer){clearTimeout(current.timer);current.timer=null;}syncSaveUi(n.id);});
  editor?.addEventListener('compositionend',()=>{const current=noteSession(n.id);current.isComposing=false;captureNoteRevision(n.id);scheduleNoteSave(n.id,450);});
  editor?.addEventListener('keyup',()=>selectionManager.remember(n.id));editor?.addEventListener('mouseup',()=>selectionManager.remember(n.id));
  window.RepositProductivity074?.bind(editor,{record:(before,label)=>recordSpecialHistory(before,label),changed:()=>{markEditorDirty(n.id);scheduleNoteSave(n.id);},insertTable:()=>insertTable(3,3),attach:()=>{selectionManager.remember(n.id);pendingAttachmentNoteId=n.id;$('#global-file-picker').click();},subnote:()=>{selectionManager.remember(n.id);createSubnote(n.id);}});
  $('#editor-toolbar')?.addEventListener('pointerdown',()=>selectionManager.remember(n.id),true);
  $$('[data-cmd]').forEach(b=>b.onmousedown=e=>{e.preventDefault();selectionManager.restore(n.id);editorFormat(b.dataset.cmd);});
  $('#block-format').onchange=e=>{selectionManager.restore(n.id);editorBlock(e.target.value);};$('#text-color').oninput=e=>{selectionManager.restore(n.id);editorFormat('foreColor',e.target.value);};
  $('#tool-attach').onclick=()=>{selectionManager.remember(n.id);pendingAttachmentNoteId=n.id;$('#global-file-picker').click();};
  $('#tool-subnote').onclick=()=>{selectionManager.remember(n.id);createSubnote(n.id);};$('#tool-table').onclick=()=>{selectionManager.remember(n.id);insertTable(3,3);};
  $('#save-retry').onclick=async()=>{captureNoteRevision(n.id);await saveNotionPage(n.id,false,{force:true});};
  $$('[data-tag-jump]').forEach(b=>b.onclick=async()=>{if(!(await leave('tag')))return;state.tag=b.dataset.tagJump;state.active=null;await renderWorkspace();});
  bindInlineAttachments(n);renderNoteTabs();syncSaveUi(n.id);updateContentLimitUi();setTimeout(()=>{restoreNoteViewState(n.id);selectionManager.remember(n.id);updateToolbarState();offerRecoveryDraft(n,session);},30);
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
    const linked=await saveNotionPage(parentId,true,{force:true});
    ensureNoteTab(state.active);ensureNoteTab({...child,parent_note_id:parentId,parent_title:state.active.title});
    if(!linked)toast('A subnota foi criada, mas o vínculo com a posição da nota pai ficou no rascunho para reconciliação.','err');
    await openNote(child.id);setTimeout(()=>{$('#notion-title')?.focus();$('#notion-title')?.select();},60);if(linked)toast('Subnota criada em uma nova aba.','ok');
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
    if(!session.payload){captureNoteRevision(id);}
    if(!session.payload){session.error='A revisão pendente não possui conteúdo recuperável.';persistNoteDraft(session);syncSaveUi(id);break;}
    const limit=contentLimit(),contentSize=String(session.payload.content||'').length;if(contentSize>limit){session.error=`Conteúdo acima do limite (${contentSize}/${limit}). Nada foi truncado.`;persistNoteDraft(session);syncSaveUi(id);updateContentLimitUi();if(!quiet)toast(session.error,'err');break;}
    const sentRevision=session.saveRevision;const payload={...session.payload,save_revision:sentRevision};session.error=null;syncSaveUi(id);
    session.inFlight=(async()=>{
      try{
        const saved=await patch(`/api/notes/${id}`,payload);const ack=Math.max(sentRevision,Number(saved?.edit_revision||sentRevision));
        session.savedRevision=Math.max(session.savedRevision,ack);session.error=null;
        if(session.savedRevision>=session.saveRevision){session.dirty=false;session.payload=null;clearNoteDraft(id);}else{session.dirty=true;persistNoteDraft(session);}
        applySavedNoteResult(id,saved,sentRevision);return true;
      }catch(err){
        if(err?.status===413){session.dirty=true;session.error=err?.data?.detail?.message||'Conteúdo acima do limite permitido.';persistNoteDraft(session);updateContentLimitUi();if(!quiet)toast(session.error,'err');return false;}
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
  modal('Mover subnota para a Lixeira','<p>A subnota poderá ser restaurada depois e sua posição na nota principal será preservada.</p>',`<button class="btn soft" data-close>Cancelar</button><button class="btn danger" id="confirm-delete-subnote">${icon('trash')} Mover para Lixeira</button>`);const button=$('#confirm-delete-subnote');button.onclick=async()=>{if(button.disabled)return;button.disabled=true;try{await post(`/api/notes/${id}/trash`,{});state.openTabs=state.openTabs.filter(t=>t.id!==Number(id));noteSessions.delete(Number(id));selectionManager.clear(Number(id));specialHistories.delete(Number(id));noteViewStates.delete(Number(id));if(block){block.classList.add('trashed');const label=block.querySelector('.inline-subnote-copy span');if(label)label.textContent='Na lixeira';}closeModal();toast('Subnota movida para a Lixeira.','ok');}catch(err){button.disabled=false;toast(err.message,'err');}};
}

function openExportModal(id){
  const formats=[['pdf','PDF'],['docx','Word (.docx)'],['html','HTML'],['md','Markdown'],['rtf','RTF'],['txt','Texto (.txt)'],['json','JSON']];
  modal('Exportar anotação',`<div class="export-format-grid">${formats.map(([fmt,label])=>`<button class="export-format" data-export-format="${fmt}">${icon(fmt==='pdf'?'document':'export')}<span>${label}</span></button>`).join('')}<button class="export-format" data-export-bundle>${icon('clip')}<span>HTML + anexos (.zip)</span></button></div><p class="settings-help">PDF e Word exportam uma cópia independente. O pacote ZIP inclui um HTML e cópias dos anexos sem modificar os arquivos originais.</p>`,`<button class="btn soft" data-close>Cancelar</button>`,'export-note-modal');
  $$('[data-export-format]').forEach(b=>b.onclick=async()=>{try{if(state.active?.id===Number(id)&&noteSessions.get(Number(id))?.dirty){const saved=await saveNotionPage(Number(id),false,{force:true});if(!saved)return toast('A exportação foi cancelada porque ainda existem alterações pendentes.','err');}const result=await window.pywebview?.api?.export_note?.(Number(id),b.dataset.exportFormat);if(result?.ok){closeModal();toast(`Anotação exportada em ${String(result.format||'').toUpperCase()}.`,'ok');}else if(result?.error)toast(result.error,'err');}catch(err){toast(err.message,'err');}});
  $('[data-export-bundle]')?.addEventListener('click',async()=>{try{if(state.active?.id===Number(id)&&noteSessions.get(Number(id))?.dirty){const saved=await saveNotionPage(Number(id),false,{force:true});if(!saved)return toast('A exportação foi cancelada porque ainda existem alterações pendentes.','err');}const result=await window.pywebview?.api?.export_note_bundle?.(Number(id));if(result?.ok){closeModal();toast(`Pacote exportado com ${Number(result.files||0)} anexo(s).`,'ok');}else if(result?.error)toast(result.error,'err');}catch(err){toast(err.message,'err');}});
}
async function restoreNoteFromTrash(id){try{const n=await post(`/api/notes/${id}/restore`,{});toast('Nota restaurada.','ok');state.selected.delete(Number(id));await loadNotes();return n;}catch(err){toast(err.message,'err');}}
function purgeNoteConfirm(id){modal('Excluir definitivamente','<p>Esta ação remove a nota e seus arquivos sem passar pela Lixeira. Não há botão mágico depois disso.</p>',`<button class="btn soft" data-close>Cancelar</button><button class="btn danger" id="confirm-purge">Excluir definitivamente</button>`);$('#confirm-purge').onclick=async()=>{try{await del(`/api/notes/${id}`);state.selected.delete(Number(id));state.openTabs=state.openTabs.filter(t=>t.id!==Number(id));closeModal();toast('Nota excluída definitivamente.','ok');await loadNotes();}catch(err){toast(err.message,'err');}};}
function confirmDeleteNote(id){const current=state.active?.id===Number(id)?state.active:null;const isSub=!!(current?.parent_note_id||current?.parent_note?.id);modal('Mover para a Lixeira',`<p>${isSub?'A subnota':'A nota'} será movida para a Lixeira e poderá ser restaurada.</p>`,`<button class="btn soft" data-close>Cancelar</button><button class="btn danger" id="confirm-delete">${icon('trash')} Mover para Lixeira</button>`);const button=$('#confirm-delete');button.onclick=async()=>{if(button.disabled)return;button.disabled=true;try{await post(`/api/notes/${id}/trash`,{});state.selected.delete(Number(id));state.openTabs=state.openTabs.filter(t=>t.id!==Number(id));noteSessions.delete(Number(id));selectionManager.clear(Number(id));specialHistories.delete(Number(id));noteViewStates.delete(Number(id));if(state.active?.id===Number(id))state.active=null;closeModal();toast('Movida para a Lixeira.','ok');await renderWorkspace();}catch(err){button.disabled=false;toast(err.message,'err');}};}
function confirmDeleteMany(ids){modal('Mover para a Lixeira',`<p>${ids.length} notas serão movidas para a Lixeira.</p>`,`<button class="btn soft" data-close>Cancelar</button><button class="btn danger" id="confirm-delete-many">Mover ${ids.length}</button>`);$('#confirm-delete-many').onclick=async()=>{try{await post('/api/notes/batch',{ids,action:'trash'});ids.forEach(id=>{state.selected.delete(id);state.openTabs=state.openTabs.filter(t=>t.id!==Number(id));});closeModal();toast('Notas movidas para a Lixeira.','ok');await loadNotes();}catch(err){toast(err.message,'err');}};}

function uploadNoteFileXHR(noteId,file,onProgress=()=>{}){
  return new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST',`/api/notes/${noteId}/files`);if(state.appInfo?.api_token)xhr.setRequestHeader('X-Reposit-Token',state.appInfo.api_token);xhr.timeout=120000;xhr.upload.onprogress=e=>{if(e.lengthComputable)onProgress(Math.max(0,Math.min(100,Math.round((e.loaded/e.total)*100))));};xhr.onerror=()=>reject(new ApiError('Falha de conexão com o backend local.'));xhr.ontimeout=()=>reject(new ApiError('O upload demorou demais e foi interrompido.'));xhr.onabort=()=>reject(new ApiError('Upload cancelado.'));xhr.onload=()=>{let data=null;try{data=JSON.parse(xhr.responseText||'null');}catch(_err){data=xhr.responseText;}if(xhr.status>=200&&xhr.status<300)resolve(data);else{const detail=typeof data==='object'?(data?.detail||data?.message):data;reject(new ApiError(typeof detail==='string'?detail:`Erro ${xhr.status}`,xhr.status,data));}};const fd=new FormData();fd.append('file',file);xhr.send(fd);});
}
function uploadPlaceholder(file,range){const editor=$('#notion-content');if(!editor)return null;const el=document.createElement('div');el.className='inline-upload-state';el.contentEditable='false';el.dataset.uploadTemp='1';el.innerHTML=`<strong>${esc(file.name)}</strong><span data-upload-status>Preparando</span><progress max="100" value="0"></progress>`;const r=range?.cloneRange?.();if(r&&r.startContainer?.isConnected&&editor.contains(r.startContainer)){r.deleteContents();r.insertNode(el);}else editor.append(el);return el;}
async function confirmUploadedFile(fileId,noteId){const session=noteSessions.get(Number(noteId));try{return await post(`/api/note-files/${fileId}/confirm`,{revision:session?.savedRevision||0});}catch(err){try{await post(`/api/notes/${noteId}/files/reconcile`,{});}catch(_reconcile){}throw err;}}
async function replaceImageFile(file){const block=replaceImageTarget;replaceImageTarget=null;const picker=$('#replace-image-picker');if(picker)picker.value='';if(!block?.isConnected||!state.active?.id||!file)return;const noteId=state.active.id,key=`replace:${file.name}:${file.size}:${file.lastModified||0}`;if(uploadingFiles.has(key))return;uploadingFiles.add(key);block.classList.add('uploading');const before=$('#notion-content')?.innerHTML||'',oldId=Number(block.dataset.fileId);try{const uploaded=await uploadNoteFileXHR(noteId,file,pct=>{block.dataset.uploadProgress=String(pct);});const layout=normalizeMediaLayout({width:block.dataset.mediaWidth,ratio:block.dataset.mediaRatio,fit:block.dataset.mediaFit,align:block.dataset.mediaAlign,alt:block.dataset.mediaAlt,caption:block.dataset.mediaCaption});const wrap=document.createElement('div');wrap.innerHTML=attachmentBlockHtml(uploaded,layout);const replacement=wrap.firstElementChild;block.replaceWith(replacement);recordSpecialHistory(before,'replace-image');$('#notion-content')?.dispatchEvent(new Event('input',{bubbles:true}));const saved=await saveNotionPage(noteId,true,{force:true});if(saved){try{await confirmUploadedFile(uploaded.id,noteId);}catch(err){toast(`Imagem salva, mas a confirmação ficou pendente: ${err.message}`,'err');}try{await del(`/api/note-files/${oldId}`);}catch(_err){}}else toast('A nova imagem ficou no rascunho local até o salvamento ser confirmado.','err');}catch(err){block.classList.remove('uploading');toast(err.message,'err');}finally{uploadingFiles.delete(key);}}
async function handleFiles(files,insertionRange=null){
  if(!files.length)return;let targetId=Number(pendingAttachmentNoteId||state.active?.id||0);pendingAttachmentNoteId=null;
  const importable=file=>/\.(txt|md|markdown|html?|htm)$/i.test(file.name||'');
  if(!targetId&&files.every(importable)&&confirm(`Criar ${files.length===1?'uma nota':'notas'} a partir ${files.length===1?'deste arquivo':'destes arquivos'}?`)){let last=null;for(const file of files){const fd=new FormData();fd.append('file',file);try{last=await form('/api/notes/import',fd);toast(`${file.name}: nota importada.`,'ok');}catch(err){toast(`${file.name}: ${err.message}`,'err');}}await loadNotes();if(last)await openNote(last.id);const picker=$('#global-file-picker');if(picker)picker.value='';return;}
  if(!targetId){const first=files[0],title=first.name.replace(/\.[^.]+$/,'');const note=await post('/api/notes',{title,kind:'Material',content:'',tags:''});targetId=Number(note.id);await loadNotes();await openNote(targetId);}
  if(state.active?.id!==targetId)await openNote(targetId);
  const editor=$('#notion-content');let range=insertionRange?.cloneRange?.()||selectionManager.ranges.get(targetId)?.cloneRange?.()||null;
  for(const file of files){const key=`${targetId}:${file.name}:${file.size}:${file.lastModified||0}`;if(uploadingFiles.has(key)){toast(`${file.name}: upload já em andamento.`,'err');continue;}uploadingFiles.add(key);const beforeUpload=editor?.innerHTML||'';const placeholder=uploadPlaceholder(file,range);const status=placeholder?.querySelector('[data-upload-status]'),progress=placeholder?.querySelector('progress');try{if(status)status.textContent='Enviando';const uploaded=await uploadNoteFileXHR(targetId,file,pct=>{if(status)status.textContent=`Enviando ${pct}%`;if(progress)progress.value=pct;});if(status)status.textContent='Concluído';const wrap=document.createElement('div');wrap.innerHTML=attachmentBlockHtml(uploaded);const block=wrap.firstElementChild;placeholder?.replaceWith(block);if(!placeholder)insertNodeAtCaret(editor,block,range);else{recordSpecialHistory(beforeUpload,'insert-attachment');editor.dispatchEvent(new Event('input',{bubbles:true}));}
      const nextRange=document.createRange();nextRange.setStartAfter(block);nextRange.collapse(true);range=nextRange;selectionManager.setRange(targetId,nextRange);const saved=await saveNotionPage(targetId,true,{force:true});if(saved){try{await confirmUploadedFile(uploaded.id,targetId);}catch(err){toast(`${file.name}: upload salvo, reconciliação pendente. ${err.message}`,'err');}}else toast(`${file.name}: mantido localmente até o salvamento da nota ser concluído.`,'err');
    }catch(err){if(status)status.textContent='Erro';placeholder?.classList.add('error');setTimeout(()=>placeholder?.remove(),2500);toast(`${file.name}: ${err.message}`,'err');}finally{uploadingFiles.delete(key);}}
  selectionManager.restore(targetId);const picker=$('#global-file-picker');if(picker)picker.value='';await loadNotes();
}



async function renderSettings(section=''){
  [state.settings,state.appInfo,state.storage]=await Promise.all([get('/api/settings'),get('/api/app-info'),get('/api/storage')]);applyUiPreferences();
  if(section)state.settingsTab=section;
  if(!['general','shortcuts','backup','storage','diagnostics','about'].includes(state.settingsTab))state.settingsTab='general';
  const tabs=[['general','settings','Geral'],['shortcuts','bolt','Atalhos'],['backup','download','Backup'],['storage','folder-open','Armazenamento'],['diagnostics','info','Diagnóstico'],['about','document','Sobre']];
  $('#main').innerHTML=`<section class="page route-page settings-v2"><div class="settings-layout"><aside class="settings-tabs" role="tablist" aria-label="Categorias de configurações">${tabs.map(([id,ic,label])=>`<button data-settings-tab="${id}" role="tab" aria-selected="${state.settingsTab===id}" class="${state.settingsTab===id?'active':''}">${icon(ic)}<span>${label}</span></button>`).join('')}</aside><div class="settings-panel"><div class="settings-save-state" aria-live="polite"><span class="settings-pulse"></span><b id="settings-save-state">Configurações salvas</b></div><div id="settings-pane" role="tabpanel"></div></div></div></section>`;
  $$('[data-settings-tab]').forEach(b=>b.onclick=()=>{state.settingsTab=b.dataset.settingsTab;void renderSettingsPane();$$('[data-settings-tab]').forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-selected',String(x===b));});});await renderSettingsPane();animateMain('route');
}
async function renderSettingsPane(){
  const pane=$('#settings-pane');if(!pane)return;const tab=state.settingsTab;
  if(tab==='general')pane.innerHTML=`<div class="settings-pane-head"><span class="settings-accent violet"></span><div><h2>Geral e desempenho</h2><p>Configurações que realmente têm efeito. Revolucionário, eu sei.</p></div></div><div class="settings-form"><label class="settings-switch"><span><strong>Salvamento automático</strong><small>Quando desligado, alterações ficam marcadas até Ctrl+S.</small></span><input id="autosave-enabled" type="checkbox" ${state.settings.autosave_enabled?'checked':''}></label><label class="settings-switch"><span><strong>Restaurar workspace</strong><small>Reabre abas, ordem e posições de scroll da última sessão.</small></span><input id="restore-workspace" type="checkbox" ${state.settings.restore_workspace!==false?'checked':''}></label><label class="settings-switch"><span><strong>Modo seguro automático</strong><small>Após três inicializações interrompidas, abre sem restaurar workspace e ignora cache temporário.</small></span><input id="safe-mode-auto" type="checkbox" ${state.settings.safe_mode_auto!==false?'checked':''}></label><label class="settings-switch"><span><strong>Economia de bateria</strong><small>Reduz animações e atividade em segundo plano.</small></span><input id="battery-saver" type="checkbox" ${state.settings.battery_saver?'checked':''}></label><label class="settings-number"><span><strong>Retenção da Lixeira</strong><small>Referência para limpeza manual. 0 mantém itens até você esvaziar a Lixeira.</small></span><input id="trash-retention-days" type="number" min="0" max="3650" value="${Number(state.settings.trash_retention_days??30)}"><em>dias</em></label></div>`;
  if(tab==='shortcuts')pane.innerHTML=`<div class="settings-pane-head"><span class="settings-accent green"></span><div><h2>Atalhos de teclado</h2><p>Workspace, editor e navegação.</p></div></div><div class="shortcut-grid">${[['Ctrl + N','Nova nota'],['Ctrl + S','Salvar agora'],['Ctrl + F','Buscar nesta nota'],['Ctrl + Shift + F / Ctrl + P','Pesquisar notas'],['Ctrl + Shift + P','Paleta de comandos'],['Ctrl + B','Negrito'],['Ctrl + I','Itálico'],['Ctrl + U','Sublinhado'],['Ctrl + K','Inserir link'],['Ctrl + Z','Desfazer'],['Ctrl + Y / Ctrl + Shift + Z','Refazer'],['/ em linha vazia','Comandos rápidos do editor'],['Ctrl + Tab / Ctrl + PageDown','Próxima nota'],['Ctrl + Shift + Tab / Ctrl + PageUp','Nota anterior'],['Ctrl + W','Fechar nota'],['Clique do meio','Fechar aba'],['Ctrl + 1…9','Ir para aba'],['Ctrl + D','Duplicar nota'],['F2','Renomear'],['Delete','Mover para Lixeira'],['Left Ctrl + Left Alt','Abrir/fechar Quick'],['Esc','Fechar Quick/menu/modal']].map(([k,v])=>`<div><kbd>${k}</kbd><span>${v}</span></div>`).join('')}</div>`;
  if(tab==='backup')pane.innerHTML=`<div class="settings-pane-head"><span class="settings-accent green"></span><div><h2>Backup</h2><p>Banco, configurações e anexos em um arquivo .reposit validado antes de restaurar.</p></div></div><div class="backup-actions"><button class="btn primary" id="export-backup">${icon('download')} Exportar</button><button class="btn soft" id="import-backup">${icon('upload')} Importar</button><button class="btn soft" id="auto-backup">Criar backup automático agora</button></div><p class="settings-help">O Reposit+ mantém no máximo os 5 backups automáticos mais recentes.</p>`;
  if(tab==='storage'){
    state.storage=await get('/api/storage');const st=state.storage||{};
    pane.innerHTML=`<div class="settings-pane-head"><span class="settings-accent green"></span><div><h2>Armazenamento</h2><p>Diagnóstico primeiro. Apagar às cegas continua sendo uma péssima tradição da indústria.</p></div></div><div class="storage-grid"><div><small>Banco</small><strong>${humanSize(st.database||0)}</strong></div><div><small>Anexos</small><strong>${humanSize(st.attachments||0)}</strong></div><div><small>Cache</small><strong>${humanSize(st.cache||0)}</strong></div><div><small>Backups</small><strong>${humanSize(st.backups||0)}</strong></div><div><small>Total</small><strong>${humanSize(st.total||0)}</strong></div></div><div class="about-actions"><button class="btn soft" id="check-files">Verificar arquivos</button><button class="btn soft" id="clear-cache">Limpar cache descartável</button><button class="btn soft" id="integrity-check">Verificar banco</button></div><div id="storage-result" class="settings-help"></div>`;
  }
  if(tab==='diagnostics'){
    const d=await get('/api/diagnostics');pane.innerHTML=`<div class="settings-pane-head"><span class="settings-accent violet"></span><div><h2>Diagnóstico</h2><p>Informação suficiente para depurar sem copiar suas notas.</p></div></div><div class="about-info-grid"><div><small>Versão</small><strong>${esc(d.version)}</strong></div><div><small>Banco</small><strong>schema v${esc(d.schema_version)} · ${d.database_ok?'OK':'atenção'}</strong></div><div><small>Notas</small><strong>${Number(d.notes||0)}</strong></div><div><small>Anexos</small><strong>${Number(d.attachments||0)}</strong></div><div><small>Último backup</small><strong>${esc(d.last_backup||'Nenhum')}</strong></div><div><small>Caminho de dados</small><strong class="path-value">${esc(d.data_path||'')}</strong></div></div><div class="about-actions"><button class="btn soft" id="copy-diagnostics">Copiar diagnóstico</button><button class="btn soft" id="export-diagnostics">Exportar diagnóstico</button><button class="btn soft" id="open-data-folder">${icon('folder-open')} Abrir pasta de dados</button></div><pre id="diagnostics-text" hidden>${esc(d.text||'')}</pre>`;
  }
  if(tab==='about'){const info=state.appInfo||{},st=state.storage||{};pane.innerHTML=`<div class="settings-pane-head"><span class="settings-accent violet"></span><div><h2>Sobre</h2><p>Reposit+ local-first.</p></div></div><div class="about-app-card"><div class="about-app-mark">R+</div><div class="grow"><strong>Reposit+ ${esc(info.version||'')}</strong><span>${esc(info.distribution_label||'Aplicativo')}</span></div><span class="about-build-chip">v${esc(info.version||'')}</span></div><div class="about-info-grid"><div><small>Dados do usuário</small><strong class="path-value">${esc(info.data_path||'-')}</strong></div><div><small>Schema</small><strong>v${esc(info.schema_version||'')}</strong></div></div><div class="about-actions"><button class="btn soft" id="run-maintenance">Manutenção do banco</button></div>`;}
  bindSettingsAutosave();
}
function settingsSaving(text='Salvando…'){$('#settings-save-state')&&($('#settings-save-state').textContent=text);$('.settings-pulse')?.classList.toggle('saving',text.includes('Salvando'));}
let settingsSaveTimer=null;
function scheduleSettingsSave(fn){settingsSaving();clearTimeout(settingsSaveTimer);settingsSaveTimer=setTimeout(async()=>{try{await fn();settingsSaving('Configurações salvas');}catch(err){settingsSaving('Erro ao salvar');toast(err.message,'err');}},420);}
function bindSettingsAutosave(){
  $('#autosave-enabled')?.addEventListener('change',e=>scheduleSettingsSave(async()=>{state.settings=await patch('/api/settings',{autosave_enabled:e.target.checked});if(state.settings.autosave_enabled){noteSessions.forEach(session=>{if(session.dirty)scheduleNoteSave(session.id,120);});}else{noteSessions.forEach(session=>{if(session.timer){clearTimeout(session.timer);session.timer=null;}});}if(state.active?.id)syncSaveUi(state.active.id);}));
  $('#restore-workspace')?.addEventListener('change',e=>scheduleSettingsSave(async()=>{state.settings=await patch('/api/settings',{restore_workspace:e.target.checked});if(!e.target.checked)window.RepositWorkspace073?.clear?.();else persistWorkspaceSession();}));
  $('#safe-mode-auto')?.addEventListener('change',e=>scheduleSettingsSave(async()=>{state.settings=await patch('/api/settings',{safe_mode_auto:e.target.checked});}));
  $('#battery-saver')?.addEventListener('change',e=>scheduleSettingsSave(async()=>{state.settings=await patch('/api/settings',{battery_saver:e.target.checked});applyUiPreferences();}));
  $('#trash-retention-days')?.addEventListener('change',e=>scheduleSettingsSave(async()=>{const days=Math.max(0,Math.min(3650,Number(e.target.value)||0));e.target.value=String(days);state.settings=await patch('/api/settings',{trash_retention_days:days});}));
  $('#open-data-folder')?.addEventListener('click',async()=>{const r=await window.pywebview?.api?.open_data_folder();if(r?.error)toast(r.error,'err');});
  $('#run-maintenance')?.addEventListener('click',async()=>{try{const r=await post('/api/storage/maintenance',{force:false});state.storage=r.storage;toast('Manutenção concluída.','ok');}catch(err){toast(err.message,'err');}});
  $('#export-backup')?.addEventListener('click',async()=>{try{const r=await window.pywebview?.api?.export_backup();if(r?.ok)toast('Backup exportado.','ok');else if(r?.error)toast(r.error,'err');}catch(err){toast(err.message,'err');}});
  $('#import-backup')?.addEventListener('click',async()=>{try{const r=await window.pywebview?.api?.import_backup();if(r?.ok)toast('Backup importado. Reinicie o app.','ok');else if(r?.error)toast(r.error,'err');}catch(err){toast(err.message,'err');}});
  $('#auto-backup')?.addEventListener('click',async()=>{try{await post('/api/backup/automatic',{});toast('Backup automático criado.','ok');}catch(err){toast(err.message,'err');}});
  $('#integrity-check')?.addEventListener('click',async()=>{try{const r=await get('/api/storage/integrity');$('#storage-result').textContent=r.ok?'Banco íntegro.':'O banco encontrou inconsistências. Faça backup antes de qualquer reparo.';}catch(err){toast(err.message,'err');}});
  $('#check-files')?.addEventListener('click',async()=>{try{const r=await get('/api/storage/attachments/diagnose');const issues=(r.missing_files?.length||0)+(r.records_without_token?.length||0)+(r.token_without_record?.length||0)+(r.physical_without_record?.length||0)+(r.broken_subnotes?.length||0);$('#storage-result').textContent=issues?`${issues} inconsistência(s) detectada(s). Nada foi apagado automaticamente.`:`Arquivos verificados: ${r.registered||0} registros, nenhuma inconsistência.`;}catch(err){toast(err.message,'err');}});
  $('#clear-cache')?.addEventListener('click',async()=>{try{const r=await post('/api/storage/cache/clear',{});state.storage=r.storage;$('#storage-result').textContent=`Cache descartável removido: ${humanSize(r.removed||0)}.`;toast('Cache descartável limpo.','ok');}catch(err){toast(err.message,'err');}});
  $('#copy-diagnostics')?.addEventListener('click',async()=>{const text=$('#diagnostics-text')?.textContent||'';try{await navigator.clipboard.writeText(text);toast('Diagnóstico copiado.','ok');}catch(_err){toast('Não foi possível copiar o diagnóstico.','err');}});
  $('#export-diagnostics')?.addEventListener('click',async()=>{try{const r=await window.pywebview?.api?.export_diagnostics();if(r?.ok)toast('Diagnóstico exportado.','ok');else if(r?.error)toast(r.error,'err');}catch(err){toast(err.message,'err');}});
}

window.addEventListener('beforeunload',()=>{
  prepareShutdownSync();
});
window.addEventListener('pagehide',()=>{if(state.active?.id&&$('#notion-content'))captureNoteRevision(state.active.id);persistWorkspaceSession();noteSessions.forEach(session=>{if(session.dirty)persistNoteDraft(session);});});
let lastGlobalErrorToast=0;
function reportFrontendError(detail){
  console.error('Reposit+ frontend error:',detail);const now=Date.now();
  if(now-lastGlobalErrorToast>5000&&document.getElementById('toast-root')){lastGlobalErrorToast=now;toast('O Reposit+ encontrou um erro nesta operação.','err');}
}
window.addEventListener('error',event=>reportFrontendError(event.error||event.message));
window.addEventListener('unhandledrejection',event=>reportFrontendError(event.reason));
document.addEventListener('pointerdown',e=>{if(!e.target.closest('.tab-context-menu'))closeTabContextMenu();if(!e.target.closest('.workspace-note-menu'))closeWorkspaceNoteMenu();if(!e.target.closest('.period-filter'))closeWorkspaceFilterMenu();});

function prepareShutdownSync(){
  // Native close must never wait for network/WebView promises. Persist every
  // dirty revision locally first; the next startup can recover it even if the
  // backend is already shutting down.
  if(state.active?.id&&$('#notion-content'))captureNoteRevision(state.active.id);
  persistWorkspaceSession();
  noteSessions.forEach(session=>{
    if(session.dirty)persistNoteDraft(session);
    if(session.timer){clearTimeout(session.timer);session.timer=null;}
    if(session.captureTimer){clearTimeout(session.captureTimer);session.captureTimer=null;}
  });
  persistWorkspaceSession();
  return true;
}

async function prepareShutdown(){
  prepareShutdownSync();
  const sessions=[...noteSessions.values()];
  for(const session of sessions){if(session.dirty&&state.settings.autosave_enabled){try{await Promise.race([saveNotionPage(session.id,true,{force:true}),new Promise(resolve=>setTimeout(()=>resolve(false),1200))]);}catch(_err){persistNoteDraft(session);}}}
  persistWorkspaceSession();return true;
}

window.RepositUI={
  prepareShutdown,
  prepareShutdownSync,
  openNote: async id=>{await navigate('workspace');await openNote(id);},
  createBlankNote: ()=>createBlankNote({},false),
  refreshSettings: async()=>{state.settings=await get('/api/settings');applyUiPreferences();},
  runCommand: async id=>{
    if(id==='new-note') return createBlankNote({},false);
    if(id==='settings') return navigate('settings');
    if(id==='palette') return openCommandPalette();
  }
};

window.addEventListener('resize',updateWindowUiScale,{passive:true});
updateWindowUiScale();
init();
