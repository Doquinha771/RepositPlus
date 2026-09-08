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
  route:'workspace', notes:[], active:null, selected:new Set(), openTabs:[], emailHistoryCount:0,
  sidebarCollapsed: localStorage.getItem('reposit.sidebar.collapsed')==='1', settingsTab:'profile',
  settings:{theme:'dark',use_system_theme:false,minimize_to_tray:false,mural_enabled:false,mail_client:{}},
  profile:{name:'',school_email:'',school:'',class_name:'',grade:''},
  account:{provider:'system_mail',connected:false,mail_client:{}},
  appInfo:{name:'Reposit+',version:'0.5.0',distribution:'source',distribution_label:'Código-fonte',data_path:''},
  query:'', kind:'', tag:'', noteTags:[], period:'all', view:'table', ecoMode:false, overlay:new URLSearchParams(location.search).get('overlay')==='1'
};
let saveTimer = null;
let searchTimer = null;

function toast(message,type=''){
  const el=document.createElement('div'); el.className=`toast ${type}`; el.textContent=message;
  $('#toast-root').appendChild(el); setTimeout(()=>el.remove(),3500);
}
function icon(name){
  const glyph={
    'angle-left':'‹','angle-right':'›','apps':'▦','arrow-up-right-from-square':'↗','bolt':'ϟ','bookmark':'◆','clip':'⌇','clock':'◷','copy':'⧉','cross-small':'×','document':'▤','download':'↓','envelope':'✉','expand':'↗','file':'▱','filter':'▽','folder-open':'▰','inbox':'⌑','label':'◇','paper-plane':'➤','plus':'+','search':'⌕','settings':'⚙','share':'↗','shield-check':'✓','table-columns':'▦','tags':'#','trash':'⌫','upload':'↑','user':'○','wifi':'⌁'
  };
  return `<span class="rp-icon rp-icon-${name}" aria-hidden="true">${glyph[name]||'•'}</span>`;
}
function applyTheme(){
  const s=state.settings||{};
  let theme=s.theme||'dark';
  if(s.use_system_theme) theme=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';
  document.documentElement.dataset.theme=theme;
}
function modal(title,body,foot='',className=''){
  $('#modal-root').innerHTML=`<div class="modal-backdrop"><div class="modal ${className}"><div class="modal-head"><div><span class="modal-kicker">REPOSIT+</span><h2>${esc(title)}</h2></div><button class="btn icon soft" data-close>${icon('cross-small')}</button></div><div class="modal-body">${body}</div>${foot?`<div class="modal-foot">${foot}</div>`:''}</div></div>`;
  $$('[data-close]').forEach(b=>b.onclick=closeModal);
  $('.modal-backdrop')?.addEventListener('mousedown',e=>{if(e.target.classList.contains('modal-backdrop')) closeModal();});
}
function closeModal(){ $('#modal-root').innerHTML=''; }
function routeTitle(route){
  return ({workspace:'Notas',wall:'Mural',sends:'Caixa de entrada',settings:'Configurações'})[route] || 'Reposit+';
}
function routeSubtitle(route){
  return '';
}
function accountLabel(){
  if(state.profile?.name?.trim()) return state.profile.name.trim();
  if(state.profile?.school_email) return state.profile.school_email.split('@')[0];
  return 'Perfil';
}
function accountInitial(){ return (accountLabel().trim()[0] || 'R').toUpperCase(); }
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
function showFirstRunWelcome(){
  if(state.settings?.first_run_complete)return;
  modal('Bem-vindo ao Reposit+ 0.5',`<div class="welcome-v050"><div class="welcome-hero"><div class="welcome-mark"><img src="/static/assets/RepositPlus-Dark.png" alt="Reposit+"></div><div><span class="eyebrow">SEU ESPAÇO DE ESTUDO</span><h3>Organize primeiro. Corra depois.</h3><p>Notas ricas, subnotas, Quick e compartilhamento local em um app leve.</p></div></div><div class="welcome-profile"><label>Como quer aparecer?<input class="input" id="welcome-name" value="${esc(state.profile.name||'')}" placeholder="Seu nome"></label><div class="settings-row"><label>Turma<input class="input" id="welcome-class" value="${esc(state.profile.class_name||'')}" placeholder="3º A"></label><label>Curso<input class="input" id="welcome-course" value="${esc(state.profile.course||'')}" placeholder="ADS, Informática..."></label></div><label>Escola<input class="input" id="welcome-school" value="${esc(state.profile.school||'')}" placeholder="Nome da escola"></label></div><div class="welcome-feature-strip"><span>${icon('document')} Editor rico</span><span>${icon('layers')} Subnotas</span><span>${icon('bolt')} Quick</span><span>${icon('wifi')} Mural local</span></div></div>`,`<button class="btn soft" id="welcome-skip">Pular por agora</button><button class="btn primary" id="welcome-start">Entrar no Reposit+</button>`,'welcome-modal welcome-v050-modal');
  $('#welcome-start').onclick=async()=>{try{state.profile=await patch('/api/profile',{name:$('#welcome-name').value,class_name:$('#welcome-class').value,course:$('#welcome-course').value,school:$('#welcome-school').value});state.settings=await patch('/api/settings',{first_run_complete:true});closeModal();renderShell();bindGlobal();await navigate('workspace');toast('Perfil pronto. Bem-vindo ao Reposit+ 0.5.','ok');}catch(err){toast(err.message,'err');}};
  $('#welcome-skip').onclick=async()=>{state.settings=await patch('/api/settings',{first_run_complete:true});closeModal();};
}
async function init(){
  await configureNotebookMode();
  if(state.overlay){ document.body.classList.add('overlay'); return initOverlay(); }

  // Render first, hydrate second. The app must never sit on a splash screen
  // just because one optional Windows/mail probe is slow or unavailable.
  applyTheme();
  renderShell();
  bindGlobal();
  await navigate('workspace');

  const results = await Promise.allSettled([
    get('/api/settings'),
    get('/api/profile'),
    get('/api/account')
  ]);

  if(results[0].status==='fulfilled') state.settings=results[0].value;
  if(results[1].status==='fulfilled') state.profile=results[1].value || state.profile;
  if(results[2].status==='fulfilled') state.account=results[2].value || state.account;

  applyTheme();
  renderShell();
  bindGlobal();
  await navigate(state.route || 'workspace');
  showFirstRunWelcome();

  const failed=results.filter(r=>r.status==='rejected');
  if(failed.length) toast('Alguns recursos do Windows não responderam, mas o workspace foi aberto normalmente.','err');
}

function renderShell(){
  $('#app').innerHTML=`<div class="app-stage"><div class="app-shell ${state.sidebarCollapsed?'sidebar-collapsed':''}">
    <aside class="sidebar">
      <div class="brand-row">
        <div class="brand"><img class="brand-app-icon" src="/static/assets/RepositPlus.png" alt=""><span class="brand-name">REPOSIT<span>+</span></span></div>
        <button class="sidebar-toggle" id="sidebar-toggle" aria-label="${state.sidebarCollapsed?'Expandir lateral':'Recolher lateral'}" title="${state.sidebarCollapsed?'Expandir lateral':'Recolher lateral'}">${icon(state.sidebarCollapsed?'angle-right':'angle-left')}</button>
      </div>
      <button class="side-create" id="side-new-note">${icon('plus')}<span>Nova nota</span></button>
      <nav class="nav">
        <button data-route="workspace" class="${state.route==='workspace'?'active':''}">${icon('document')}<span>Notas</span></button>
        <button data-route="wall" class="${state.route==='wall'?'active':''}">${icon('share')}<span>Mural</span></button>
      </nav>
      <div class="sidebar-spacer"></div>
      <div class="sidebar-bottom"><button data-route="settings" class="${state.route==='settings'?'active':''}">${icon('settings')}<span>Configurações</span></button></div>
    </aside>
    <section class="content-shell">
      <header class="topbar">
        <div class="header-copy"><h1 id="header-title">${esc(routeTitle(state.route))}</h1></div>
        <label class="top-search">${icon('search')}<input id="top-search" placeholder="Pesquisar notas..." value="${esc(state.query)}"><span class="search-shortcut">Ctrl F</span></label>
        <div class="top-spacer"></div>
        <button class="inbox-button" id="mail-inbox" title="Histórico de e-mails">
          ${icon('inbox')}<span>Caixa de entrada</span><b id="mail-inbox-count" class="inbox-count ${state.emailHistoryCount?'':'hidden'}">${state.emailHistoryCount||''}</b>
        </button>
        <button class="top-menu" id="top-menu" title="Configurações">${icon('settings')}</button>
      </header>
      <main class="main" id="main"></main>
    </section>
  </div></div>`;
  $$('[data-route]').forEach(b=>b.onclick=()=>navigate(b.dataset.route));
  $('#sidebar-toggle').onclick=()=>setSidebarCollapsed(!state.sidebarCollapsed);
  $('#side-new-note').onclick=async()=>{ if(state.route!=='workspace') await navigate('workspace'); createBlankNote({},true); };
  $('#mail-inbox').onclick=()=>navigate('sends');
  $('#top-menu').onclick=()=>navigate('settings');
  $('#top-search').oninput=e=>{
    state.query=e.target.value; clearTimeout(searchTimer);
    searchTimer=setTimeout(async()=>{ if(state.route!=='workspace') await navigate('workspace'); else await loadNotes(); },140);
  };
  $('#top-search').onkeydown=e=>{ if(e.key==='Enter' && state.notes[0]) openNote(state.notes[0].id); };
  refreshEmailBadge();
}

async function refreshEmailBadge(){
  try{
    const rows=await get('/api/email/history');
    state.emailHistoryCount=Array.isArray(rows)?rows.length:0;
    const count=$('#mail-inbox-count');
    if(count){count.textContent=state.emailHistoryCount||'';count.classList.toggle('hidden',!state.emailHistoryCount);}
  }catch(_err){}
}

function bindGlobal(){
  const picker=$('#global-file-picker');
  if(picker) picker.onchange=()=>handleFiles([...picker.files]);
  if(window.__repositGlobalBound)return;
  window.__repositGlobalBound=true;
  document.addEventListener('selectionchange',()=>{if(state.active&&$('#notion-content'))updateToolbarState();});
  document.addEventListener('keydown',async e=>{
    const key=e.key.toLowerCase();
    if(e.key==='Escape'){
      if($('#modal-root').innerHTML){closeModal();return;}
      if($('.note-context-menu')){closeNoteContextMenu();return;}
    }
    if(e.ctrlKey && !e.altKey && key==='n'){e.preventDefault(); if(state.route!=='workspace')await navigate('workspace'); await createBlankNote({},true);return;}
    if(e.ctrlKey && !e.altKey && key==='s'){e.preventDefault(); if(state.active)await saveNotionPage(state.active.id); else toast('Tudo salvo.','ok');return;}
    if(e.ctrlKey && !e.altKey && key==='f'){e.preventDefault();$('#top-search')?.focus();$('#top-search')?.select();return;}
    if(e.ctrlKey && !e.altKey && (key==='k'||key==='p')){e.preventDefault();$('#top-search')?.focus();$('#top-search')?.select();return;}
    if(e.ctrlKey && key===','){e.preventDefault();await navigate('settings');return;}
    if(e.ctrlKey && key==='/'){e.preventDefault();state.settingsTab='shortcuts';await navigate('settings','shortcuts');return;}
    if(e.ctrlKey && key==='tab'){e.preventDefault();cycleNoteTab(e.shiftKey?-1:1);return;}
    if(e.ctrlKey && !e.altKey && key==='w' && state.active){e.preventDefault();await closeNoteTab(state.active.id);return;}
    if(e.altKey && e.key==='ArrowLeft' && state.active){e.preventDefault();await saveNotionPage(state.active.id,true);if(state.active.parent_note_id)await openNote(state.active.parent_note_id);else{state.active=null;await renderWorkspace();}return;}
    if(e.ctrlKey && e.shiftKey && key==='e' && state.active){e.preventDefault();openEmailModal([state.active.id]);return;}
    if(e.ctrlKey && e.shiftKey && key==='m' && state.active){e.preventDefault();publishSelectedToWall([state.active.id]);return;}
    if(e.ctrlKey && !e.shiftKey && /^[1-9]$/.test(e.key)){
      const idx=Number(e.key)-1;if(state.openTabs[idx]){e.preventDefault();openNote(state.openTabs[idx].id);}return;
    }
    if(e.ctrlKey && !e.shiftKey && key==='d'){const id=state.active?.id||([...state.selected][0]);if(id){e.preventDefault();await duplicateNote(id);}return;}
    if(e.ctrlKey && e.key==='Enter' && state.route==='workspace' && !state.active && state.selected.size===1){e.preventDefault();openNote([...state.selected][0]);return;}
    if((e.key==='Delete'||e.key==='Backspace'&&e.ctrlKey) && state.route==='workspace' && !state.active && state.selected.size && !['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)){
      e.preventDefault(); const ids=[...state.selected]; if(ids.length===1)confirmDeleteNote(ids[0]); else confirmDeleteMany(ids);return;
    }
    if(e.key==='F2' && state.route==='workspace' && !state.active && state.selected.size===1){
      e.preventDefault();const id=[...state.selected][0];const input=$(`[data-inline="title"][data-id="${id}"]`);input?.focus();input?.select();return;
    }
    if(state.active && $('#notion-content')){
    }
  });
  window.addEventListener('dragover',e=>{if(state.route!=='workspace')return;e.preventDefault();$('.drop-zone')?.classList.add('show');});
  window.addEventListener('dragleave',e=>{if(!e.relatedTarget)$('.drop-zone')?.classList.remove('show');});
  window.addEventListener('drop',e=>{if(state.route!=='workspace')return;e.preventDefault();$('.drop-zone')?.classList.remove('show');handleFiles([...e.dataTransfer.files]);});
}

async function navigate(route,section=''){
  if(route==='validator') route='workspace';
  if(state.active && $('#notion-content')) await saveNotionPage(state.active.id,true);
  state.route=route;
  if(route==='workspace') state.active=null;
  $$('.nav button,[data-route="settings"]').forEach(b=>b.classList.toggle('active',b.dataset.route===route));
  setHeader(route);
  if(route==='workspace') await renderWorkspace();
  if(route==='wall') await renderWall();
  if(route==='sends') await renderSends();
  if(route==='settings') await renderSettings(section);
  animateMain('route');
}

async function renderWorkspace(){
  $('#main').innerHTML=`<section class="page workspace-page site-workspace">
    <div class="workspace-body">
      <div class="workspace-scroll" id="workspace-scroll">
        <section class="workspace-section notes-section sheet-section">
          <div class="workspace-top-controls">
            <div class="period-tabs period-tabs-large" id="period-tabs">
              <button data-period="all" class="${state.period==='all'?'active':''}">Todas</button>
              <button data-period="today" class="${state.period==='today'?'active':''}">Hoje</button>
              <button data-period="week" class="${state.period==='week'?'active':''}">Esta semana</button>
              <button data-period="month" class="${state.period==='month'?'active':''}">Este mês</button>
            </div>
            <div class="toolbar-spacer"></div>
            <span id="selection-info" class="selection-info"></span>
            <button class="btn soft hidden" id="send-selected">${icon('envelope')} Enviar</button>
            <button class="btn soft hidden" id="wall-selected">${icon('share')} Mural</button>
            <label class="kind-filter">${icon('filter')}<input id="kind-filter" list="kind-options-filter" placeholder="Tipo" value="${esc(state.kind)}"><datalist id="kind-options-filter"><option>Anotação</option><option>Atividade</option><option>Material</option><option>Trabalho</option><option>Resumo</option><option>Lembrete</option></datalist></label>
            <button class="btn soft" id="manage-tags">${icon('tags')} Tags</button>
            <button class="btn primary workspace-new-note" id="workspace-new-note">${icon('plus')} Nova nota</button>
          </div>
          <div id="workspace-tags" class="workspace-tags"></div>
          <div id="notes-content" class="notes-content"><div class="loading-block">Carregando notas…</div></div>
        </section>
      </div>
      <div class="drop-zone"><div>${icon('clip')}<strong>Solte os arquivos aqui</strong></div></div>
      <div id="note-tabbar" class="note-tabbar"></div>
    </div>
  </section>`;
  $('#workspace-new-note').onclick=()=>createBlankNote({},true);
  $('#send-selected').onclick=()=>openEmailModal([...state.selected]);
  $('#wall-selected').onclick=()=>publishSelectedToWall([...state.selected]);
  $('#kind-filter').oninput=e=>{state.kind=e.target.value;clearTimeout(searchTimer);searchTimer=setTimeout(loadNotes,160);};
  $('#manage-tags').onclick=openTagManager;
  $$('[data-period]').forEach(b=>b.onclick=()=>{state.period=b.dataset.period;$$('[data-period]').forEach(x=>x.classList.toggle('active',x===b));renderSheet();});
  renderNoteTabs();
  await loadNotes();
}

async function loadNotes(){
  const params=new URLSearchParams();
  if(state.query.trim())params.set('q',state.query.trim());
  if(state.kind.trim())params.set('kind',state.kind.trim());
  if(state.tag.trim())params.set('tag',state.tag.trim());
  params.set('limit','800');
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
    <div class="note-card-top"><label class="note-select" title="Selecionar"><input type="checkbox" data-select="${n.id}" ${state.selected.has(n.id)?'checked':''}><span></span></label><span class="note-date">${fmtDate(n.updated_at)}</span><div class="note-actions"><button title="Enviar" data-row-send="${n.id}">${icon('paper-plane')}</button><button title="Abrir" data-row-open="${n.id}">${icon('angle-right')}</button></div></div>
    <div class="note-type"><span class="note-type-icon">${icon('document')}</span>${esc(n.kind||'Anotação')}</div>
    <h3>${esc(n.title)}</h3><p>${esc(notePreview(n))}</p>
    ${n.tags?`<div class="note-tags">${esc(n.tags)}</div>`:''}
    <div class="note-card-footer"><span>${icon('document')} ${n.file_count||0} arquivo${Number(n.file_count||0)===1?'':'s'}</span><span>${icon('bookmark')} ${n.pinned?'Fixada':'Nota'}</span><span>${fmtTime(n.updated_at)}</span></div>
  </article>`).join('')}<button class="note-new-card" id="note-new-card"><span>${icon('plus')}</span><strong>Nova nota</strong><small>Escreva, anexe e compartilhe.</small></button></div>`;
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
    <td class="action-col"><div class="row-actions"><button class="row-action" title="Enviar" data-row-send="${n.id}">${icon('envelope')}</button><button class="row-action" title="Abrir" data-row-open="${n.id}">${icon('expand')}</button><button class="row-action danger-action" title="Excluir" data-row-delete="${n.id}">${icon('trash')}</button></div></td>
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
  $$('[data-row-send]').forEach(b=>b.onclick=e=>{e.stopPropagation();openEmailModal([Number(b.dataset.rowSend)]);});
  $$('[data-row-delete]').forEach(b=>b.onclick=e=>{e.stopPropagation();confirmDeleteNote(Number(b.dataset.rowDelete));});
}

function updateSelection(){
  const el=$('#selection-info'), send=$('#send-selected'), wall=$('#wall-selected');
  if(el) el.textContent=state.selected.size?`${state.selected.size} selecionada${state.selected.size>1?'s':''}`:'';
  [send,wall].forEach(b=>b?.classList.toggle('hidden',!state.selected.size));
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
  id=Number(id);
  const idx=state.openTabs.findIndex(t=>t.id===id);
  if(state.active?.id===id && $('#notion-content')) await saveNotionPage(id,true);
  state.openTabs=state.openTabs.filter(t=>t.id!==id);
  if(state.active?.id===id){
    const fallback=state.openTabs[Math.min(Math.max(idx-1,0),Math.max(state.openTabs.length-1,0))];
    state.active=null;
    if(fallback) await openNote(fallback.id);
    else await renderWorkspace();
  }else renderNoteTabs();
}
function renderNoteTabs(){
  const bar=$('#note-tabbar');if(!bar)return;
  const activeId=state.active?.id||0;
  bar.innerHTML=`<button class="note-tab note-tab-home ${!activeId?'active':''}" id="tab-home" title="Todas as notas">${icon('apps')}<span>Notas</span></button>
    <div class="note-tabs-scroll">${state.openTabs.map(t=>`<button class="note-tab ${activeId===t.id?'active':''} ${t.parent_note_id?'subnote-tab':''}" data-tab-note="${t.id}" title="${esc(t.parent_note_id?`${t.parent_title||'Nota'} › ${t.title}`:t.title)}"><span class="tab-doc">${t.parent_note_id?'↳':icon('document')}</span><span class="tab-title">${esc(t.title||'Sem título')}</span><span class="tab-close" data-close-tab="${t.id}">${icon('cross-small')}</span></button>`).join('')}</div>
    <button class="note-tab-add" id="tab-new" title="Nova nota">${icon('plus')}</button>`;
  $('#tab-home').onclick=async()=>{if(state.active&&$('#notion-content'))await saveNotionPage(state.active.id,true);state.active=null;await renderWorkspace();};
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
  try{
    if(state.active && state.active.id!==Number(id) && $('#notion-content')) await saveNotionPage(state.active.id,true);
    state.route='workspace';
    state.active=await get(`/api/notes/${id}`);
    if(state.active.parent_note){
      ensureNoteTab({...state.active.parent_note,parent_note_id:state.active.parent_note.parent_note_id||null});
    }
    ensureNoteTab(state.active);
    $$('.nav button,[data-route="settings"]').forEach(b=>b.classList.toggle('active',b.dataset.route==='workspace'));
    setHeader('workspace');
    renderNotionPage();
    animateMain('tab');
  }catch(err){toast(err.message,'err');}
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
  if(isImageFile(file))return `<figure class="inline-attachment inline-media-image" contenteditable="false" draggable="true" data-file-id="${file.id}" data-media-width="${media.width}" data-media-ratio="${media.ratio}" data-media-fit="${media.fit}" data-file-token="${token}"${widthStyle}><img src="/api/note-files/${file.id}" alt="${esc(file.filename)}" loading="lazy"><span class="media-size-badge">${media.width==='auto'?'Auto':media.width+'%'}</span><span class="media-resize-handle media-resize-left" data-media-resize="left" title="Arraste para redimensionar"></span><span class="media-resize-handle media-resize-right" data-media-resize="right" title="Arraste para redimensionar"></span><span class="inline-media-actions"><button type="button" data-inline-layout="${file.id}" title="Tamanho e proporção">▣</button><button type="button" data-inline-open="${file.id}" title="Abrir">${icon('expand')}</button><button type="button" data-inline-delete="${file.id}" title="Remover">${icon('trash')}</button></span></figure>`;
  if(isAudioFile(file))return `<div class="inline-attachment inline-audio" contenteditable="false" draggable="true" data-file-id="${file.id}" data-file-token="[[reposit-file:${file.id}]]"><div class="inline-audio-head"><span>${icon('file')}</span><strong>${esc(file.filename)}</strong><small>${humanSize(file.size)}</small></div><audio controls preload="metadata" src="/api/note-files/${file.id}"></audio><span class="inline-attachment-actions"><button type="button" data-inline-open="${file.id}" title="Abrir">${icon('expand')}</button><button type="button" data-inline-delete="${file.id}" title="Remover">${icon('trash')}</button></span></div>`;
  return `<span class="inline-attachment inline-file" contenteditable="false" draggable="true" data-file-id="${file.id}" data-file-token="[[reposit-file:${file.id}]]"><span class="inline-attachment-icon">${icon('file')}</span><span class="inline-attachment-copy"><strong>${esc(file.filename)}</strong><small>${esc(file.file_type||'Arquivo')} · ${humanSize(file.size)}</small></span><span class="inline-attachment-actions"><button type="button" data-inline-open="${file.id}" title="Abrir">${icon('expand')}</button><button type="button" data-inline-delete="${file.id}" title="Remover">${icon('trash')}</button></span></span>`;
}
function subnoteBlockHtml(note){
  return `<span class="inline-subnote" contenteditable="false" draggable="true" data-subnote-id="${note.id}" data-subnote-token="[[reposit-subnote:${note.id}]]"><span class="inline-subnote-icon">${icon('document')}</span><span class="inline-subnote-copy"><small>SUBNOTA</small><strong>${esc(note.title||'Sem título')}</strong><span>${esc(note.kind||'Subnota')} · ${fmtDate(note.updated_at)}</span></span><button type="button" data-subnote-open="${note.id}">${icon('angle-right')}</button></span>`;
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
function sanitizeRichHtml(raw=''){
  const box=document.createElement('div');box.innerHTML=raw;
  box.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach(n=>n.remove());
  box.querySelectorAll('*').forEach(el=>{
    [...el.attributes].forEach(a=>{if(/^on/i.test(a.name) || ['srcdoc'].includes(a.name))el.removeAttribute(a.name);});
    if(el.tagName==='A'){const href=el.getAttribute('href')||'';if(!/^(https?:|mailto:|#)/i.test(href))el.removeAttribute('href');el.setAttribute('rel','noopener');}
  });
  return box.innerHTML;
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
function rememberEditorSelection(){const editor=$('#notion-content'),sel=window.getSelection();if(editor&&sel?.rangeCount&&editor.contains(sel.anchorNode))savedEditorRange=sel.getRangeAt(0).cloneRange();}
function restoreEditorSelection(){const editor=$('#notion-content');if(!editor)return;editor.focus();if(savedEditorRange){const sel=window.getSelection();sel.removeAllRanges();sel.addRange(savedEditorRange);}}
function contextEditorFormat(command,value=null){restoreEditorSelection();editorFormat(command,value);}
function contextEditorBlock(tag){restoreEditorSelection();editorBlock(tag);}
function editorFormat(command,value=null){
  const editor=$('#notion-content');if(!editor)return;editor.focus();document.execCommand(command,false,value);editor.dispatchEvent(new Event('input',{bubbles:true}));updateToolbarState();
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
  event.preventDefault();
  rememberEditorSelection();
  closeNoteContextMenu();
  const menu=document.createElement('div');menu.className='note-context-menu';
  const files=n.files||[];const imageBlock=event.target?.closest?.('.inline-media-image');const editor=event.target?.closest?.('#notion-content')||$('#notion-content');
  const selection=window.getSelection();const hasSelection=!!(selection&&selection.toString().trim()&&editor&&editor.contains(selection.anchorNode));
  if(imageBlock){
    menu.classList.add('image-context-menu');
    menu.innerHTML=`${imageLayoutMenuHtml(imageBlock)}<div class="context-separator"></div><div class="context-grid context-grid-2"><button data-context-image-open>${icon('expand')} Abrir original</button><button class="context-danger" data-context-image-delete>${icon('trash')} Remover</button></div>`;
  }else{
    menu.innerHTML=`<div class="context-title">${hasSelection?'Texto selecionado':'Formatação'}</div>
      <div class="context-grid context-format-grid"><button data-context-cmd="bold"><b>B</b></button><button data-context-cmd="italic"><i>I</i></button><button data-context-cmd="underline"><u>U</u></button><button data-context-cmd="strikeThrough"><s>S</s></button><button data-context-cmd="superscript">x²</button><button data-context-cmd="subscript">x₂</button></div>
      <div class="context-grid context-grid-4"><button data-context-block="p">Texto</button><button data-context-block="h1">H1</button><button data-context-block="h2">H2</button><button data-context-block="h3">H3</button></div>
      <div class="context-row"><label>Fonte<select data-context-font><option>Segoe UI</option><option>Arial</option><option>Georgia</option><option>Verdana</option><option>Times New Roman</option><option>Courier New</option></select></label><label>Cor do texto<input type="color" data-context-color value="#55d98b"></label><label>Marca-texto<input type="color" data-context-highlight value="#335d42"></label></div>
      <div class="context-title">Layout</div><div class="context-grid context-grid-4"><button data-context-cmd="justifyLeft">Esq.</button><button data-context-cmd="justifyCenter">Centro</button><button data-context-cmd="justifyRight">Dir.</button><button data-context-cmd="justifyFull">Just.</button><button data-context-cmd="insertUnorderedList">• Lista</button><button data-context-cmd="insertOrderedList">1. Lista</button><button data-context-cmd="outdent">⇤ Recuo</button><button data-context-cmd="indent">⇥ Recuo</button></div>
      <div class="context-title">Inserir</div><div class="context-grid context-grid-2"><button data-note-menu="attach">${icon('clip')} Anexar arquivo</button><button data-note-menu="subnote">${icon('plus')} Subnota</button><button data-note-menu="table">▦ Adicionar grade 3×3</button><button data-context-cmd="insertHorizontalRule">― Linha</button><button data-note-menu="link">🔗 Link</button><button data-context-cmd="removeFormat">Tx Limpar</button></div>
      <div class="context-separator"></div><div class="context-grid context-grid-2"><button data-note-menu="email">${icon('envelope')} Enviar</button><button data-note-menu="wall">${icon('share')} Mural</button></div>
      ${files.length?`<div class="context-separator"></div><div class="context-title">Anexos · ${files.length}</div>${files.map(f=>`<div class="context-file"><button data-context-open="${f.id}" title="Abrir"><span>${icon('file')} ${esc(f.filename)}</span></button><button class="context-file-remove" data-context-delete="${f.id}" title="Remover">${icon('trash')}</button></div>`).join('')}`:''}`;
  }
  document.body.appendChild(menu);
  const rect=menu.getBoundingClientRect();menu.style.left=`${Math.max(8,Math.min(event.clientX,window.innerWidth-rect.width-8))}px`;menu.style.top=`${Math.max(8,Math.min(event.clientY,window.innerHeight-rect.height-8))}px`;
  if(imageBlock){
    $$('[data-image-width]',menu).forEach(b=>b.onclick=()=>{updateInlineImageLayout(imageBlock,{width:b.dataset.imageWidth});closeNoteContextMenu();});
    const sizeSlider=$('[data-image-slider]',menu);if(sizeSlider){sizeSlider.oninput=e=>{updateInlineImageLayout(imageBlock,{width:e.target.value});const out=$('output',menu);if(out)out.textContent=`${e.target.value}%`;};sizeSlider.onchange=()=>closeNoteContextMenu();}
    $$('[data-image-ratio]',menu).forEach(b=>b.onclick=()=>{updateInlineImageLayout(imageBlock,{ratio:b.dataset.imageRatio,fit:b.dataset.imageRatio==='auto'?'contain':imageBlock.dataset.mediaFit});closeNoteContextMenu();});
    $$('[data-image-fit]',menu).forEach(b=>b.onclick=()=>{updateInlineImageLayout(imageBlock,{fit:b.dataset.imageFit});closeNoteContextMenu();});
    $('[data-context-image-open]',menu).onclick=()=>{closeNoteContextMenu();window.open(`/api/note-files/${imageBlock.dataset.fileId}`,'_blank');};
    $('[data-context-image-delete]',menu).onclick=async()=>{try{await del(`/api/note-files/${imageBlock.dataset.fileId}`);imageBlock.remove();editor?.dispatchEvent(new Event('input',{bubbles:true}));closeNoteContextMenu();toast('Imagem removida.','ok');}catch(err){toast(err.message,'err');}};
  }else{
    $$('[data-context-cmd]',menu).forEach(b=>b.onmousedown=e=>{e.preventDefault();contextEditorFormat(b.dataset.contextCmd);closeNoteContextMenu();});
    $$('[data-context-block]',menu).forEach(b=>b.onmousedown=e=>{e.preventDefault();contextEditorBlock(b.dataset.contextBlock);closeNoteContextMenu();});
    $('[data-context-font]',menu)?.addEventListener('change',e=>{contextEditorFormat('fontName',e.target.value);closeNoteContextMenu();});
    $('[data-context-color]',menu)?.addEventListener('input',e=>contextEditorFormat('foreColor',e.target.value));
    $('[data-context-highlight]',menu)?.addEventListener('input',e=>contextEditorFormat('hiliteColor',e.target.value));
    $('[data-note-menu="attach"]',menu).onclick=()=>{restoreEditorSelection();closeNoteContextMenu();$('#global-file-picker').click();};
    $('[data-note-menu="subnote"]',menu).onclick=()=>{restoreEditorSelection();closeNoteContextMenu();createSubnote(n.id);};
    $('[data-note-menu="table"]',menu).onclick=()=>{restoreEditorSelection();closeNoteContextMenu();insertTable(3,3);};
    $('[data-note-menu="link"]',menu).onclick=()=>{restoreEditorSelection();closeNoteContextMenu();insertLink();};
    $('[data-note-menu="email"]',menu).onclick=()=>{closeNoteContextMenu();openEmailModal([n.id]);};
    $('[data-note-menu="wall"]',menu).onclick=()=>{closeNoteContextMenu();publishSelectedToWall([n.id]);};
    $$('[data-context-open]',menu).forEach(b=>b.onclick=()=>{closeNoteContextMenu();window.open(`/api/note-files/${b.dataset.contextOpen}`,'_blank');});
    $$('[data-context-delete]',menu).forEach(b=>b.onclick=async()=>{try{await del(`/api/note-files/${b.dataset.contextDelete}`);closeNoteContextMenu();state.active=await get(`/api/notes/${n.id}`);renderNotionPage();toast('Anexo removido.','ok');}catch(err){toast(err.message,'err');}});
  }
  setTimeout(()=>document.addEventListener('mousedown',e=>{if(!e.target.closest('.note-context-menu'))closeNoteContextMenu();},{once:true}),0);
}
function renderNotionPage(){
  const n=state.active; if(!n)return;
  setHeader('workspace');
  const main=$('#main'); if(!main)return;
  const tagSuggestions=(state.noteTags||[]).map(t=>`<option value="${esc(t.name)}"></option>`).join('');
  const parent=n.parent_note||null;
  const backLabel=parent?esc(parent.title||'Nota principal'):'Notas';
  const browserTrail=parent?`<button class="crumb-home" data-note-home>${icon('apps')} Notas</button><span>›</span><button data-parent-note="${parent.id}">${esc(parent.title||'Nota principal')}</button><span>›</span><strong>${esc(n.title||'Sem título')}</strong>`:`<button class="crumb-home" data-note-home>${icon('apps')} Notas</button><span>›</span><strong>${esc(n.title||'Sem título')}</strong>`;
  main.innerHTML=`<section class="page notion-page rich-note-page ${parent?'subnote-page':''}">
    <div class="notion-topline">
      <button class="notion-back" id="notion-back">${icon('angle-left')} ${backLabel}</button>
      <div class="notion-browser-trail">${browserTrail}</div>
      <div class="notion-top-actions">
        <span class="autosave-state" id="autosave-state">Salvo</span>
        <button class="btn soft" id="notion-pin">${icon('bookmark')} ${n.pinned?'Fixada':'Fixar'}</button>
        <button class="btn soft" id="notion-send">${icon('envelope')} Enviar</button>
        <button class="btn soft" id="notion-wall">${icon('share')} Mural</button>
        <button class="btn ghost-danger" id="notion-delete" title="Excluir">${icon('trash')}</button>
      </div>
    </div>
    <div class="editor-toolbar editor-toolbar-primary" id="editor-toolbar" role="toolbar" aria-label="Formatação principal do texto">
      <div class="tool-group tool-history"><button data-cmd="undo" title="Desfazer">↶</button><button data-cmd="redo" title="Refazer">↷</button></div>
      <div class="tool-group tool-block"><select id="block-format" title="Estilo do texto"><option value="p">Texto</option><option value="h1">Título 1</option><option value="h2">Título 2</option><option value="h3">Título 3</option></select><select id="font-size" title="Tamanho"><option value="2">12</option><option value="3" selected>14</option><option value="4">18</option><option value="5">24</option><option value="6">32</option><option value="7">48</option></select></div>
      <div class="tool-group text-tools primary-text-tools"><button data-cmd="bold" title="Negrito"><b>B</b></button><button data-cmd="italic" title="Itálico"><i>I</i></button><button data-cmd="underline" title="Sublinhado"><u>U</u></button></div>
      <div class="tool-group primary-lists"><button data-cmd="insertUnorderedList" title="Lista com marcadores">•≡</button><button data-cmd="insertOrderedList" title="Lista numerada">1≡</button></div>
      <div class="tool-group insert-tools primary-insert"><button id="tool-attach" class="tool-action">${icon('clip')}<span>Arquivo</span></button><button id="tool-subnote" class="tool-action">${icon('plus')}<span>Subnota</span></button></div>
      <div class="tool-group toolbar-more-group"><button id="tool-more" class="tool-action tool-more" title="Mais ferramentas">•••<span>Mais</span></button></div>
      <div class="toolbar-context-hint">Clique direito para mais</div>
    </div>
    <div class="notion-scroll">
      <article class="notion-document" id="note-context-area">
        ${parent?`<div class="subnote-banner"><span>SUBNOTA DE</span><button data-parent-note="${parent.id}">${icon('angle-left')} ${esc(parent.title||'Nota principal')}</button></div>`:''}
        <input id="notion-title" class="notion-title" value="${esc(n.title)}" placeholder="Sem título">
        <div class="notion-properties notion-properties-inline">
          <label><span>${icon('label')}</span><input id="notion-kind" list="notion-kind-options" value="${esc(n.kind||'Anotação')}" aria-label="Tipo"><datalist id="notion-kind-options"><option>Anotação</option><option>Atividade</option><option>Material</option><option>Trabalho</option><option>Resumo</option><option>Lembrete</option><option>Subnota</option><option>Outro</option></datalist></label>
          <label class="tag-property"><span>${icon('tags')}</span><input id="notion-tags" list="note-tag-suggestions" value="${esc(n.tags||'')}" placeholder="Tags separadas por vírgula" aria-label="Tags"><datalist id="note-tag-suggestions">${tagSuggestions}</datalist></label>
          <div class="notion-property-static"><span>${icon('clock')}</span><strong>${fmt(n.updated_at)}</strong></div>
        </div>
        <div class="note-tag-chips" id="note-tag-chips">${renderTagChips(n.tags||'')}</div>
        <div id="notion-content" class="notion-content rich-editor" contenteditable="true" spellcheck="true" data-placeholder="Comece a escrever…">${contentToEditorHtml(n)}</div>
      </article>
    </div>
    <div id="note-tabbar" class="note-tabbar"></div>
  </section>`;
  $('#notion-back').onclick=async()=>{await saveNotionPage(n.id,true);if(parent)await openNote(parent.id);else{state.active=null;await renderWorkspace();}};
  $$('[data-parent-note]').forEach(b=>b.onclick=async()=>{await saveNotionPage(n.id,true);await openNote(Number(b.dataset.parentNote));});
  $$('[data-note-home]').forEach(b=>b.onclick=async()=>{await saveNotionPage(n.id,true);state.active=null;await renderWorkspace();});
  $('#notion-pin').onclick=async()=>{state.active=await patch(`/api/notes/${n.id}`,{pinned:!n.pinned});ensureNoteTab(state.active);renderNotionPage();};
  $('#notion-send').onclick=()=>openEmailModal([n.id]);
  $('#notion-wall').onclick=()=>publishSelectedToWall([n.id]);
  $('#notion-delete').onclick=()=>confirmDeleteNote(n.id);
  $('#note-context-area').oncontextmenu=e=>openNoteContextMenu(e,n);
  const scheduleSave=()=>{const status=$('#autosave-state'); if(status)status.textContent='Salvando…';clearTimeout(saveTimer); saveTimer=setTimeout(()=>saveNotionPage(n.id),650);};
  ['#notion-title','#notion-kind','#notion-tags','#notion-content'].forEach(sel=>$(sel)?.addEventListener('input',()=>{if(sel==='#notion-tags')$('#note-tag-chips').innerHTML=renderTagChips($('#notion-tags').value);scheduleSave();}));
  ['#notion-title','#notion-kind','#notion-tags'].forEach(sel=>$(sel)?.addEventListener('blur',()=>saveNotionPage(n.id)));
  $$('[data-cmd]').forEach(b=>b.onmousedown=e=>{e.preventDefault();editorFormat(b.dataset.cmd);});
  $('#block-format').onchange=e=>editorBlock(e.target.value);
  $('#font-size').onchange=e=>editorFormat('fontSize',e.target.value);
  $('#tool-attach').onclick=()=>$('#global-file-picker').click();
  $('#tool-subnote').onclick=()=>createSubnote(n.id);
  $('#tool-more').onclick=e=>{rememberEditorSelection();const r=e.currentTarget.getBoundingClientRect();openNoteContextMenu({preventDefault(){},clientX:r.right-8,clientY:r.bottom+6,target:$('#notion-content')},n);};
  $$('[data-tag-jump]').forEach(b=>b.onclick=async()=>{await saveNotionPage(n.id,true);state.tag=b.dataset.tagJump;state.active=null;await renderWorkspace();});
  bindInlineAttachments(n);
  renderNoteTabs();
  setTimeout(()=>{$('#notion-content')?.focus();updateToolbarState();},40);
}
function renderTagChips(raw=''){
  const tags=String(raw||'').split(/[,;\n]+/).map(x=>x.trim().replace(/^#/, '')).filter(Boolean);
  return [...new Set(tags.map(x=>x.toLowerCase()))].map(k=>tags.find(x=>x.toLowerCase()===k)).map(t=>`<button type="button" class="note-tag-chip" data-tag-jump="${esc(t)}">#${esc(t)}</button>`).join('');
}
async function createSubnote(parentId){
  try{
    rememberEditorSelection();
    const child=await post(`/api/notes/${parentId}/subnotes`,{title:'Nova subnota'});
    state.active=await get(`/api/notes/${parentId}`);
    placeSubnoteAtCaret($('#notion-content'),child);
    await saveNotionPage(parentId,true);
    ensureNoteTab(state.active);ensureNoteTab({...child,parent_note_id:parentId,parent_title:state.active.title});
    await openNote(child.id);
    setTimeout(()=>{$('#notion-title')?.focus();$('#notion-title')?.select();},60);
    toast('Subnota criada em uma nova aba.','ok');
  }catch(err){toast(err.message,'err');}
}
async function saveNotionPage(id,quiet=false){
  if(!state.active||state.active.id!==id)return;
  const contentEl=$('#notion-content');
  const payload={
    title:$('#notion-title')?.value||'Sem título',
    kind:$('#notion-kind')?.value||'Anotação',
    tags:$('#notion-tags')?.value||'',
    content:serializeEditorContent(contentEl),
    content_format:'html'
  };
  try{
    state.active=await patch(`/api/notes/${id}`,payload);
    ensureNoteTab(state.active);
    const idx=state.notes.findIndex(x=>x.id===id); if(idx>=0)Object.assign(state.notes[idx],state.active);
    const status=$('#autosave-state'); if(status)status.textContent='Salvo';
    const crumb=$('.notion-breadcrumb strong');if(crumb)crumb.textContent=state.active.title||'Sem título';
    renderNoteTabs();
  }catch(err){if(!quiet)toast(err.message,'err');const status=$('#autosave-state');if(status)status.textContent='Erro ao salvar';}
}

function confirmDeleteNote(id){modal('Excluir anotação','<p>Essa anotação será removida do Reposit+.</p>',`<button class="btn soft" data-close>Cancelar</button><button class="btn danger" id="confirm-delete">Excluir</button>`);$('#confirm-delete').onclick=async()=>{try{await del(`/api/notes/${id}`);state.selected.delete(id);state.openTabs=state.openTabs.filter(t=>t.id!==Number(id));state.active=null;closeModal();toast('Nota excluída.','ok');await renderWorkspace();}catch(err){toast(err.message,'err');}};}
function confirmDeleteMany(ids){modal('Excluir anotações',`<p>${ids.length} anotações serão removidas permanentemente.</p>`,`<button class="btn soft" data-close>Cancelar</button><button class="btn danger" id="confirm-delete-many">Excluir ${ids.length}</button>`);$('#confirm-delete-many').onclick=async()=>{try{for(const id of ids)await del(`/api/notes/${id}`);ids.forEach(id=>{state.selected.delete(id);state.openTabs=state.openTabs.filter(t=>t.id!==Number(id));});closeModal();toast('Anotações excluídas.','ok');await renderWorkspace();}catch(err){toast(err.message,'err');}};}

async function handleFiles(files){
  if(!files.length)return;
  for(const file of files){
    try{
      let note=state.active;
      if(!note){const title=file.name.replace(/\.[^.]+$/,'');note=await post('/api/notes',{title,kind:'Material',content:'',tags:''});state.active=note;ensureNoteTab(note);renderNotionPage();}
      const fd=new FormData();fd.append('file',file);const uploaded=await form(`/api/notes/${note.id}/files`,fd);
      if(state.active?.id===note.id){state.active=await get(`/api/notes/${note.id}`);placeAttachmentAtCaret($('#notion-content'),uploaded);await saveNotionPage(note.id,true);}
    }catch(err){toast(`${file.name}: ${err.message}`,'err');}
  }
  $('#global-file-picker').value='';await loadNotes();if(state.active){state.active=await get(`/api/notes/${state.active.id}`);renderNotionPage();}
}

async function openEmailModal(ids){
  ids=ids.filter(Boolean);if(!ids.length)return toast('Selecione pelo menos uma anotação.','err');
  const nativeAttach=!!state.account?.mail_client?.attachments_native;
  const hint=nativeAttach
    ? `${icon('clip')} Os anexos serão entregues ao seu aplicativo de e-mail do Windows.`
    : `${icon('clip')} Se houver anexos e o seu e-mail abrir no navegador, o Reposit+ também abrirá uma pasta com os arquivos para você arrastar.`;
  modal('Enviar por e-mail',`<div class="modal-callout">${icon('shield-check')}<div><strong>Sem login dentro do Reposit+</strong><p>A mensagem será aberta no e-mail que já está configurado no Windows ou no navegador. O Reposit+ não recebe senha, token ou sessão.</p></div></div><div class="field"><label>Para</label><input id="mail-to" class="input large-input" type="email" placeholder="aluno@escola.sp.gov.br" autofocus></div><div id="mail-compose" class="hidden compose-block"><div class="field"><label>Assunto</label><input id="mail-subject" class="input"></div><div class="field"><label>Mensagem</label><textarea id="mail-body" class="textarea email-preview"></textarea></div><div class="compose-hint">${hint}</div></div>`,`<button class="btn soft" data-close>Cancelar</button><button class="btn soft" id="preview-mail">Preparar</button><button class="btn primary hidden" id="send-mail">${icon('paper-plane')} Abrir no meu e-mail</button>`,'email-compose-modal');
  $('#preview-mail').onclick=async()=>{const recipient=$('#mail-to').value.trim();try{const p=await post('/api/notes/email/preview',{recipient,note_ids:ids});$('#mail-compose').classList.remove('hidden');$('#mail-subject').value=p.subject;$('#mail-body').value=p.body;$('#preview-mail').classList.add('hidden');$('#send-mail').classList.remove('hidden');}catch(err){toast(err.message,'err');}};
  $('#send-mail').onclick=async()=>{try{const r=await post('/api/notes/email/send',{recipient:$('#mail-to').value.trim(),note_ids:ids,subject:$('#mail-subject').value,body:$('#mail-body').value});closeModal();if(r.attachments_manual)toast('Rascunho aberto. A pasta dos anexos também foi aberta para arrastar no e-mail.','ok');else toast('Rascunho aberto no seu e-mail. Revise e clique em Enviar.','ok');state.selected.clear();if(state.route==='workspace')renderSheet();}catch(err){toast(err.message,'err');}};
}

async function publishSelectedToWall(ids){
  ids=ids.filter(Boolean);if(!ids.length)return toast('Selecione uma anotação para publicar.','err');
  modal('Publicar no mural',`<div class="modal-callout">${icon('share')}<div><strong>${ids.length} anotaç${ids.length===1?'ão':'ões'} pronta${ids.length===1?'':'s'} para o mural.</strong><p>Outros Reposit+ na mesma rede poderão receber o conteúdo.</p></div></div><label class="check-line"><input id="contains-answers" type="checkbox"><span>Marcar como “contém respostas”</span></label>`,`<button class="btn soft" data-close>Cancelar</button><button class="btn primary" id="confirm-wall">Publicar</button>`);
  $('#confirm-wall').onclick=async()=>{try{for(const id of ids)await post('/api/notes/mural',{note_id:id,contains_answers:$('#contains-answers').checked,distribute:true});closeModal();toast('Publicado no mural.','ok');}catch(err){toast(err.message,'err');}};
}

async function openWallPost(wallPost){
  const fileButton=wallPost.file_name?`<a class="btn soft" href="/api/mural/${wallPost.id}/file" download>${icon('download')} Baixar arquivo</a>`:'';
  modal(wallPost.title||'Anotação do mural',`<div class="wall-reader-meta"><span class="badge">${esc(wallPost.subject||'Anotação')}</span>${wallPost.contains_answers?'<span class="badge answer">Contém respostas</span>':''}<span>${esc(wallPost.author||'Reposit+')} · ${fmt(wallPost.created_at)}</span></div><div id="wall-reader-content" class="wall-reader-content" contenteditable="true" spellcheck="true">${textToEditorHtml(wallPost.description||'')}</div><div class="wall-reader-note">Você pode selecionar, copiar e colar aqui. Alterações só ficam permanentes se salvar como uma nova nota.</div>`,`<button class="btn ghost-danger" id="wall-delete">${icon('trash')} Apagar do mural</button><span class="modal-foot-spacer"></span><button class="btn soft" data-close>Fechar</button><button class="btn soft" id="wall-copy">${icon('copy')} Copiar</button><button class="btn soft" id="wall-save-note">${icon('document')} Salvar como nota</button>${fileButton}`,'wall-reader-modal');
  $('#wall-copy').onclick=async()=>{await copyText($('#wall-reader-content')?.innerText||'');toast('Conteúdo copiado.','ok');};
  $('#wall-save-note').onclick=async()=>{try{const n=await post('/api/notes',{title:wallPost.title||'Nota do mural',kind:wallPost.subject||'Anotação',content:$('#wall-reader-content')?.innerText||'',tags:'mural'});closeModal();toast('Salvo como nova nota.','ok');await navigate('workspace');await openNote(n.id);}catch(err){toast(err.message,'err');}};
  $('#wall-delete').onclick=()=>confirmDeleteWallPost(wallPost);
}

function confirmDeleteWallPost(wallPost){
  modal('Apagar publicação?',`<div class="delete-confirm"><div class="delete-confirm-icon">${icon('trash')}</div><div><strong>${esc(wallPost.title||'Publicação sem título')}</strong><p>Ela sairá do mural, mas a nota e o arquivo originais não serão apagados.</p></div></div>`,`<button class="btn soft" data-close>Cancelar</button><button class="btn danger" id="confirm-wall-delete">Apagar publicação</button>`);
  $('#confirm-wall-delete').onclick=async()=>{try{await del(`/api/mural/${wallPost.id}`);closeModal();toast('Publicação removida do mural.','ok');await renderWall();}catch(err){toast(err.message,'err');}};
}

async function renderWall(){
  let posts=[],pending=[];
  try{[posts,pending]=await Promise.all([get('/api/mural'),get('/api/mural/pending')]);}catch(err){toast(err.message,'err');}
  const pendingHtml=pending.length?`<section class="surface-block pending-zone"><div class="section-heading compact"><div><span class="eyebrow">AGUARDANDO</span><h2>Recebimentos pendentes</h2></div></div><div class="pending-list">${pending.map(p=>`<div class="pending-card"><div class="pending-icon">${icon('document')}</div><div class="grow"><strong>${esc(p.title)}</strong><span>${esc(p.sender_name)}</span></div><button class="btn soft" data-reject="${p.id}">Recusar</button><button class="btn primary" data-accept="${p.id}">Aceitar</button></div>`).join('')}</div></section>`:'';
  const postsHtml=posts.length?posts.map((p,i)=>`<article class="wall-card tone-${i%6}" data-wall-post="${p.id}" tabindex="0"><div class="wall-card-head"><span class="badge">${esc(p.subject||'Anotação')}</span>${p.contains_answers?'<span class="badge answer">Contém respostas</span>':''}<button class="wall-card-delete" data-wall-delete="${p.id}" title="Apagar do mural" aria-label="Apagar ${esc(p.title)}">${icon('trash')}</button></div><h3 class="wall-card-title">${esc(p.title)}</h3><div class="wall-post-body"><p>${esc((p.description||'Sem conteúdo.').slice(0,420))}</p></div><div class="wall-meta"><span>${icon('user')} ${esc(p.author||'Reposit+')}</span><span>${fmt(p.created_at)}</span>${p.file_name?`<span>${icon('clip')} ${esc(p.file_name)}</span>`:''}</div><button class="wall-open" data-wall-open="${p.id}">${icon('expand')} Abrir publicação</button></article>`).join(''):`<div class="empty-route"><div>${icon('share')}</div><h3>Nada no mural ainda</h3><p>Quando você publicar ou receber algo, aparece aqui.</p></div>`;
  $('#main').innerHTML=`<section class="page route-page"><div class="route-scroll"><div class="simple-route-bar"><div class="route-color-key"><span></span><strong>Mural local</strong></div><button class="status-button ${state.settings.mural_enabled?'on':''}" id="toggle-wall">${icon('wifi')}<span>${state.settings.mural_enabled?'Mural ligado':'Mural desligado'}</span></button></div>${pendingHtml}<section class="surface-block mural-zone"><div class="wall-grid">${postsHtml}</div></section></div></section>`;
  $('#toggle-wall').onclick=async()=>{state.settings=await patch('/api/settings',{mural_enabled:!state.settings.mural_enabled});renderWall();};
  $$('[data-accept]').forEach(b=>b.onclick=async()=>{await post(`/api/mural/pending/${b.dataset.accept}/accept?trust=false`,{});renderWall();});
  $$('[data-reject]').forEach(b=>b.onclick=async()=>{await post(`/api/mural/pending/${b.dataset.reject}/reject`,{});renderWall();});
  $$('[data-wall-open]').forEach(b=>b.onclick=e=>{e.stopPropagation();openWallPost(posts.find(p=>p.id===Number(b.dataset.wallOpen)));});
  $$('[data-wall-delete]').forEach(b=>b.onclick=e=>{e.stopPropagation();confirmDeleteWallPost(posts.find(p=>p.id===Number(b.dataset.wallDelete)));});
  $$('[data-wall-post]').forEach(el=>{const open=()=>openWallPost(posts.find(p=>p.id===Number(el.dataset.wallPost)));el.ondblclick=open;el.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();open();}};});
  animateMain('route');
}

async function renderSends(){
  let rows=[];
  try {
    rows=await get('/api/email/history');
  } catch(err) {
    toast(err.message,'err');
  }

  const rowsHtml=rows.length
    ? rows.map(r=>{
        const errorHtml=r.error ? `<small>${esc(r.error)}</small>` : '';
        const okClass=String(r.status||'').toLowerCase().includes('rascunho') ? 'ok' : '';
        return `<article class="send-row"><div class="send-avatar">${icon('paper-plane')}</div><div class="send-main"><strong>${esc(r.subject)}</strong><span>Para ${esc(r.recipient)}</span>${errorHtml}</div><span class="send-status ${okClass}">${esc(r.status)}</span><time>${fmt(r.created_at)}</time></article>`;
      }).join('')
    : `<div class="empty-route"><div>${icon('paper-plane')}</div><h3>Nenhum e-mail preparado ainda</h3><p>Quando você abrir uma nota no seu e-mail pelo Reposit+, o registro aparece aqui.</p></div>`;

  $('#main').innerHTML=`<section class="page route-page inbox-page"><div class="route-scroll"><div class="inbox-toolbar"><div><h2>Caixa de entrada</h2><span>${rows.length} registro${rows.length===1?'':'s'}</span></div><button class="btn primary" id="sends-new">${icon('plus')} Nova nota</button></div><section class="surface-block inbox-surface"><div class="send-list">${rowsHtml}</div></section></div></section>`;
  $('#sends-new').onclick=async()=>{await navigate('workspace');createBlankNote();};
}

async function renderSettings(section=''){
  [state.settings,state.profile,state.account,state.appInfo]=await Promise.all([get('/api/settings'),get('/api/profile'),get('/api/account'),get('/api/app-info')]);applyTheme();
  if(section)state.settingsTab=section==='account'?'email':section;
  const mail=state.account?.mail_client||state.settings?.mail_client||{};
  const clientName=mail.mapi_client||mail.mailto_handler||'Aplicativo de e-mail padrão do Windows';
  const attachText=mail.attachments_native?'Anexos automáticos disponíveis.':'Webmail pode exigir arrastar anexos manualmente.';
  const tabs=[['profile','user','Perfil'],['appearance','palette','Aparência'],['email','envelope','E-mail'],['wall','wifi','Mural'],['shortcuts','keyboard','Atalhos'],['backup','download','Backup'],['about','info','Sobre']];
  $('#main').innerHTML=`<section class="page route-page settings-v2"><div class="settings-layout"><aside class="settings-tabs">${tabs.map(([id,ic,label])=>`<button data-settings-tab="${id}" class="${state.settingsTab===id?'active':''}">${icon(ic)}<span>${label}</span></button>`).join('')}</aside><div class="settings-panel"><div class="settings-save-state"><span class="settings-pulse"></span><b id="settings-save-state">Salvo automaticamente</b></div><div id="settings-pane"></div></div></div></section>`;
  $$('[data-settings-tab]').forEach(b=>b.onclick=()=>{state.settingsTab=b.dataset.settingsTab;renderSettingsPane(clientName,attachText);$$('[data-settings-tab]').forEach(x=>x.classList.toggle('active',x===b));});
  renderSettingsPane(clientName,attachText);
  animateMain('route');
}

function renderSettingsPane(clientName,attachText){
  const pane=$('#settings-pane');if(!pane)return;
  pane.classList.remove('pane-swap');void pane.offsetWidth;pane.classList.add('pane-swap');
  const tab=state.settingsTab;
  if(tab==='profile')pane.innerHTML=`<div class="profile-settings-hero"><div class="profile-avatar-large">${esc(accountInitial())}</div><div><span class="eyebrow">PERFIL ESTUDANTIL</span><h2>${esc(accountLabel())}</h2><p>Esses dados aparecem em envios e ajudam a deixar atividades organizadas.</p></div></div><div class="settings-form settings-profile"><label>Nome<input class="input" data-profile="name" value="${esc(state.profile.name||'')}" placeholder="Seu nome"></label><label>E-mail escolar<input class="input" data-profile="school_email" type="email" value="${esc(state.profile.school_email||'')}" placeholder="voce@escola.sp.gov.br"></label><label>Escola<input class="input" data-profile="school" value="${esc(state.profile.school||'')}" placeholder="Nome da escola"></label><div class="settings-row"><label>Turma<input class="input" data-profile="class_name" value="${esc(state.profile.class_name||'')}" placeholder="3º A"></label><label>Série<input class="input" data-profile="grade" value="${esc(state.profile.grade||'')}" placeholder="3º ano"></label></div><div class="settings-row"><label>Curso<input class="input" data-profile="course" value="${esc(state.profile.course||'')}" placeholder="ADS, Informática..."></label><label>Período<input class="input" data-profile="shift" value="${esc(state.profile.shift||'')}" placeholder="Integral, manhã..."></label></div></div>`;
  if(tab==='appearance'){const t=state.settings.use_system_theme?'system':state.settings.theme;pane.innerHTML=`<div class="settings-pane-head"><span class="settings-accent violet"></span><div><h2>Aparência</h2><p>Temas simples, legíveis e sem carnaval de RGB.</p></div></div><div class="settings-form"><label>Tema<select class="input" id="theme"><option value="graphite" ${t==='graphite'?'selected':''}>Graphite</option><option value="forest" ${t==='forest'?'selected':''}>Forest</option><option value="dark" ${t==='dark'?'selected':''}>Preto clássico</option><option value="light" ${t==='light'?'selected':''}>Claro</option><option value="paper" ${t==='paper'?'selected':''}>Paper</option><option value="system" ${t==='system'?'selected':''}>Seguir sistema</option></select></label><div class="theme-samples"><button data-theme-preview="graphite"><i></i><span>Graphite</span></button><button data-theme-preview="forest"><i></i><span>Forest</span></button><button data-theme-preview="paper"><i></i><span>Paper</span></button></div></div>`;}
  if(tab==='email')pane.innerHTML=`<div class="settings-pane-head"><span class="settings-accent apricot"></span><div><h2>E-mail</h2><p>O Reposit+ usa seu aplicativo de e-mail do Windows.</p></div></div><div class="mail-client-panel"><div class="mail-client-icon">${icon('envelope')}</div><div class="grow"><strong>${esc(clientName)}</strong><span>${esc(attachText)}</span></div><span class="privacy-chip">${icon('shield-check')} Sem credenciais</span></div><button class="btn soft" id="open-mail-settings">${icon('settings')} Configurar aplicativo padrão</button>`;
  if(tab==='wall')pane.innerHTML=`<div class="settings-pane-head"><span class="settings-accent coral"></span><div><h2>Mural local</h2><p>Descoberta e compartilhamento entre Reposit+ na mesma rede.</p></div></div><div class="settings-form"><label class="settings-switch"><span><strong>Habilitar mural</strong><small>Permite descobrir dispositivos e receber publicações.</small></span><input id="mural-enabled" type="checkbox" ${state.settings.mural_enabled?'checked':''}></label><label class="settings-switch"><span><strong>Aceitar dispositivos confiáveis</strong><small>Recebe automaticamente de máquinas já aprovadas.</small></span><input id="auto-trusted" type="checkbox" ${state.settings.auto_accept_trusted?'checked':''}></label></div>`;
  if(tab==='shortcuts')pane.innerHTML=`<div class="settings-pane-head"><span class="settings-accent green"></span><div><h2>Atalhos</h2><p>Os principais comandos funcionam em qualquer área compatível.</p></div></div><div class="shortcut-grid">${[['Ctrl + N','Nova nota'],['Ctrl + S','Salvar agora'],['Ctrl + F / K / P','Pesquisar'],['Ctrl + Tab','Próxima nota'],['Ctrl + Shift + Tab','Nota anterior'],['Ctrl + W','Fechar nota'],['Ctrl + 1…9','Ir para aba'],['Ctrl + D','Duplicar nota'],['Ctrl + Enter','Abrir selecionada'],['Ctrl + ,','Configurações'],['Ctrl + /','Lista de atalhos'],['Alt + ←','Voltar para notas'],['F2','Renomear selecionada'],['Delete','Excluir selecionada'],['Ctrl + Shift + E','Enviar nota por e-mail'],['Ctrl + Shift + M','Publicar no mural'],['Ctrl + Z / Ctrl + Y','Desfazer / refazer'],['Ctrl + C / X / V','Copiar / recortar / colar'],['Ctrl + A','Selecionar tudo no campo atual'],['Ctrl + Alt','Reposit+ Quick'],['Ctrl + Alt + Espaço','Quick (fallback)']].map(([k,v])=>`<div><kbd>${k}</kbd><span>${v}</span></div>`).join('')}</div>`;
  if(tab==='backup')pane.innerHTML=`<div class="settings-pane-head"><span class="settings-accent green"></span><div><h2>Backup</h2><p>Leve banco, configurações e anexos em um .reposit.</p></div></div><div class="backup-actions"><button class="btn primary" id="export-backup">${icon('download')} Exportar Reposit+</button><button class="btn soft" id="import-backup">${icon('upload')} Importar backup</button></div>`;
  if(tab==='about'){const info=state.appInfo||{};pane.innerHTML=`<div class="settings-pane-head"><span class="settings-accent violet"></span><div><h2>Sobre o Reposit+</h2><p>Informações desta instalação e onde seus dados ficam guardados.</p></div></div><div class="about-app-card"><div class="about-app-mark">R+</div><div class="grow"><strong>Reposit+ ${esc(info.version||'')}</strong><span>${esc(info.distribution_label||'Aplicativo')}</span></div><span class="about-build-chip">v${esc(info.version||'')}</span></div><div class="about-info-grid"><div><small>Modo</small><strong>${esc(info.distribution_label||'-')}</strong></div><div><small>Dados do usuário</small><strong class="path-value">${esc(info.data_path||'-')}</strong></div></div><div class="about-actions"><button class="btn soft" id="open-data-folder">${icon('folder-open')} Abrir pasta de dados</button></div><p class="about-note">O Setup mantém os dados fora da pasta do programa. O Portable guarda tudo em <code>user-data\</code>, então pode ser movido como uma pasta comum.</p>`;}
  bindSettingsAutosave();
}

function settingsSaving(text='Salvando…'){$('#settings-save-state') && ($('#settings-save-state').textContent=text);$('.settings-pulse')?.classList.toggle('saving',text.includes('Salvando'));}
let settingsSaveTimer=null;
function scheduleSettingsSave(fn){settingsSaving();clearTimeout(settingsSaveTimer);settingsSaveTimer=setTimeout(async()=>{try{await fn();settingsSaving('Salvo automaticamente');}catch(err){settingsSaving('Erro ao salvar');toast(err.message,'err');}},420);}
function bindSettingsAutosave(){
  $$('[data-profile]').forEach(el=>el.oninput=()=>{const payload={};$$('[data-profile]').forEach(x=>payload[x.dataset.profile]=x.value);scheduleSettingsSave(async()=>{state.profile=await patch('/api/profile',payload);});});
  $('#theme')?.addEventListener('change',e=>{const t=e.target.value;scheduleSettingsSave(async()=>{state.settings=await patch('/api/settings',{use_system_theme:t==='system',theme:t==='system'?(state.settings.theme||'graphite'):t});applyTheme();});});
  $$('[data-theme-preview]').forEach(b=>b.onclick=()=>{const sel=$('#theme');if(sel){sel.value=b.dataset.themePreview;sel.dispatchEvent(new Event('change'));}});
  $('#mural-enabled')?.addEventListener('change',e=>{const checked=e.target.checked;scheduleSettingsSave(async()=>{state.settings=await patch('/api/settings',{mural_enabled:checked});});});
  $('#auto-trusted')?.addEventListener('change',e=>{const checked=e.target.checked;scheduleSettingsSave(async()=>{state.settings=await patch('/api/settings',{auto_accept_trusted:checked});});});
  $('#open-mail-settings')?.addEventListener('click',async()=>{try{const r=await window.pywebview?.api?.open_default_mail_settings();if(r?.error)toast(r.error,'err');}catch(err){toast(err.message,'err');}});
  $('#open-data-folder')?.addEventListener('click',async()=>{try{const r=await window.pywebview?.api?.open_data_folder();if(r?.error)toast(r.error,'err');}catch(err){toast(err.message,'err');}});
  $('#export-backup')?.addEventListener('click',async()=>{try{const r=await window.pywebview?.api?.export_backup();if(r?.ok)toast(`Backup exportado: ${r.path}`,'ok');else if(r?.error)toast(r.error,'err');}catch(err){toast(err.message,'err');}});
  $('#import-backup')?.addEventListener('click',async()=>{try{const r=await window.pywebview?.api?.import_backup();if(r?.ok)toast('Backup importado. Reinicie o app.','ok');else if(r?.error)toast(r.error,'err');}catch(err){toast(err.message,'err');}});
}

async function initOverlay(){
  document.documentElement.dataset.theme='dark';
  $('#app').innerHTML=`<div class="overlay-shell"><div class="quick-box"><div class="quick-brand"><img class="quick-app-icon" src="/static/assets/RepositPlus.png" alt=""><strong>REPOSIT+</strong><span>QUICK</span></div><div class="quick-input">${icon('search')}<input id="quick-query" placeholder="Pesquisar ou criar no Reposit+" autocomplete="off"><span class="quick-hint">Esc</span></div><div id="quick-results" class="quick-results"></div><div class="quick-footer"><span>Enter abre</span><span>Ctrl + Alt abre em qualquer lugar</span></div></div></div>`;
  const input=$('#quick-query');let cursor=0,items=[];
  async function refresh(){const q=input.value.trim();if(!q){items=(await get('/api/notes?limit=6')).slice(0,6);}else if(q.startsWith('>')){items=[{command:'new',title:'Criar nova anotação',kind:'Comando'},{command:'wall',title:'Abrir mural',kind:'Comando'},{command:'send',title:'Abrir envios',kind:'Comando'}].filter(x=>x.title.toLowerCase().includes(q.slice(1).trim().toLowerCase())||!q.slice(1).trim());}else{items=(await get(`/api/notes?q=${encodeURIComponent(q)}&limit=7`)).slice(0,7);}cursor=0;render();}
  function render(){const q=input.value.trim();const rows=items.map((n,i)=>`<div class="quick-row ${i===cursor?'active':''}" data-quick="${i}"><span class="quick-row-icon">${icon(n.command?'bolt':'document')}</span><div class="grow"><strong>${esc(n.title)}</strong><small>${esc(n.kind||'Anotação')}${n.tags?` • ${esc(n.tags)}`:''}</small></div><span>${icon('angle-right')}</span></div>`).join('');const create=!q.startsWith('>')&&q?`<div class="quick-row create ${items.length===cursor?'active':''}" data-create><span class="quick-row-icon">${icon('plus')}</span><div class="grow"><strong>Criar “${esc(q)}”</strong><small>Nova anotação</small></div></div>`:'';$('#quick-results').innerHTML=rows+create;$$('[data-quick]').forEach(el=>el.onclick=()=>activate(Number(el.dataset.quick)));$('[data-create]')?.addEventListener('click',()=>createFromQuery());}
  async function activate(i){const n=items[i];if(!n)return;if(n.command){if(n.command==='new')return createFromQuery('Nova anotação');if(window.pywebview?.api?.run_command)return window.pywebview.api.run_command(n.command==='wall'?'open-wall':n.command==='send'?'open-sends':'settings','');}if(window.pywebview?.api?.open_note)await window.pywebview.api.open_note(n.id);}
  async function createFromQuery(title=input.value.trim()||'Nova anotação'){if(window.pywebview?.api?.create_note_from_search)await window.pywebview.api.create_note_from_search(title);}
  const closeQuick=()=>window.pywebview?.api?.hide_spotlight?.();
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();closeQuick();}});
  input.oninput=()=>refresh();input.onkeydown=e=>{if(e.key==='Escape'){closeQuick();}if(e.key==='ArrowDown'){e.preventDefault();cursor=Math.min(cursor+1,items.length+(input.value.trim()&&!input.value.trim().startsWith('>')?0:-1));render();}if(e.key==='ArrowUp'){e.preventDefault();cursor=Math.max(0,cursor-1);render();}if(e.key==='Enter'){e.preventDefault();if(cursor<items.length)activate(cursor);else createFromQuery();}};
  window.RepositUI={focusSpotlight:()=>{input.value='';refresh();setTimeout(()=>input.focus(),30);}};await refresh();setTimeout(()=>input.focus(),50);
}

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
  openNote: async id=>{if(state.overlay)return;await navigate('workspace');await openNote(id);},
  createNoteFromOverlay: async payload=>{if(state.overlay)return;await navigate('workspace');await createBlankNote(payload||{},true);},
  createBlankNote: ()=>createBlankNote({},false),
  focusSpotlight: ()=>$('#quick-query')?.focus(),
  refreshSettings: async()=>{state.settings=await get('/api/settings');applyTheme();},
  runCommand: async id=>{
    if(id==='open-wall') return navigate('wall');
    if(id==='open-sends') return navigate('sends');
    if(id==='new-note') return createBlankNote({},false);
    if(id==='settings') return navigate('settings');
  }
};

init();
