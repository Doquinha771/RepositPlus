(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const search = $('#search');
  const results = $('#results');
  const resultLabel = $('#result-label');
  const status = $('#status');

  let items = [];
  let selectedIndex = 0;
  let searchTimer = null;
  let stateTimer = null;
  let requestToken = 0;
  let initialized = false;

  const request = async (url, options = {}) => {
    const response = await fetch(url, options);
    if (!response.ok) {
      let message = `Erro ${response.status}`;
      try {
        const data = await response.json();
        message = data.detail || message;
      } catch (_) {}
      throw new Error(message);
    }
    return response.status === 204 ? null : response.json();
  };

  const get = (url) => request(url);
  const post = (url, data) => request(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(data)
  });

  const native = async (name, ...args) => {
    const fn = window.pywebview?.api?.[name];
    if (!fn) return null;
    try { return await fn(...args); }
    catch (error) { console.error(`Quick native ${name}:`, error); return null; }
  };

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));

  const plain = (value) => String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const setStatus = (text = '', kind = '') => {
    status.textContent = text;
    status.className = `status ${kind}`.trim();
  };

  const persistQuery = () => {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => native('quick_save_state', {query: search.value}), 350);
  };

  const flushState = () => {
    clearTimeout(stateTimer);
    native('quick_save_state', {query: search.value});
  };

  const createItemFor = (query) => ({
    type: 'create',
    id: null,
    title: query,
    content: '',
    kind: 'Nova nota'
  });

  const normalizeItems = (notes, query) => {
    const list = (Array.isArray(notes) ? notes : []).map((note) => ({...note, type: 'note'}));
    const trimmed = query.trim();
    if (!trimmed) return list;

    const exact = list.some((note) => String(note.title || '').trim().toLocaleLowerCase('pt-BR') === trimmed.toLocaleLowerCase('pt-BR'));
    if (!exact) list.push(createItemFor(trimmed));
    return list;
  };

  const rowHtml = (item, index) => {
    const selected = index === selectedIndex ? ' is-selected' : '';
    if (item.type === 'create') {
      return `
        <button class="result-row create${selected}" type="button" role="option" aria-selected="${index === selectedIndex}" data-index="${index}">
          <span class="result-icon">＋</span>
          <span class="result-copy">
            <strong>Criar “${escapeHtml(item.title)}”</strong>
            <span>Cria uma nova nota e abre no Reposit+</span>
          </span>
          <span class="result-meta">enter</span>
        </button>`;
    }

    const preview = plain(item.content) || 'Nota sem conteúdo';
    return `
      <button class="result-row${selected}" type="button" role="option" aria-selected="${index === selectedIndex}" data-index="${index}">
        <span class="result-icon">⌘</span>
        <span class="result-copy">
          <strong>${escapeHtml(item.title || 'Sem título')}</strong>
          <span>${escapeHtml(preview.slice(0, 105))}</span>
        </span>
        <span class="result-meta">${escapeHtml(item.kind || 'Anotação')}</span>
      </button>`;
  };

  const syncSelection = () => {
    results.querySelectorAll('[data-index]').forEach((element) => {
      const active = Number(element.dataset.index) === selectedIndex;
      element.classList.toggle('is-selected', active);
      element.setAttribute('aria-selected', String(active));
    });
  };

  const render = () => {
    if (!items.length) {
      results.innerHTML = '<div class="empty">Nenhuma nota encontrada.</div>';
      return;
    }
    selectedIndex = Math.max(0, Math.min(selectedIndex, items.length - 1));
    results.innerHTML = items.map(rowHtml).join('');
    results.querySelectorAll('[data-index]').forEach((element) => {
      element.addEventListener('mouseenter', () => {
        selectedIndex = Number(element.dataset.index);
        syncSelection();
      });
      element.addEventListener('click', () => activate(Number(element.dataset.index)));
    });
  };

  const load = async (query = '') => {
    const token = ++requestToken;
    const trimmed = query.trim();
    resultLabel.textContent = trimmed ? 'Resultados' : 'Notas recentes';
    setStatus('');
    try {
      const url = trimmed
        ? `/api/notes?q=${encodeURIComponent(trimmed)}&limit=7`
        : '/api/notes?limit=7';
      const notes = await get(url);
      if (token !== requestToken) return;
      selectedIndex = 0;
      items = normalizeItems(notes, trimmed);
      render();
    } catch (error) {
      if (token !== requestToken) return;
      items = [];
      results.innerHTML = '<div class="empty">Não foi possível carregar as notas.</div>';
      setStatus('Falha ao pesquisar notas.', 'error');
      console.error(error);
    }
  };

  const openNote = async (id) => {
    const response = await native('quick_open_note', Number(id));
    if (response && response.ok === false) setStatus(response.error || 'Não foi possível abrir a nota.', 'error');
  };

  const createNote = async (title) => {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) return;
    setStatus('Criando nota…');
    try {
      const note = await post('/api/notes', {
        title: cleanTitle,
        kind: 'Anotação',
        content: '',
        content_format: 'plain',
        tags: ''
      });
      search.value = '';
      flushState();
      setStatus('Nota criada.', 'success');
      await openNote(note.id);
    } catch (error) {
      setStatus('Não foi possível criar a nota.', 'error');
      console.error(error);
    }
  };

  const activate = (index = selectedIndex) => {
    const item = items[index];
    if (!item) return;
    if (item.type === 'create') createNote(item.title);
    else openNote(item.id);
  };

  const moveSelection = (delta) => {
    if (!items.length) return;
    selectedIndex = (selectedIndex + delta + items.length) % items.length;
    syncSelection();
    const selected = results.querySelector('.is-selected');
    selected?.scrollIntoView({block: 'nearest'});
  };

  const bind = () => {
    $('#close').addEventListener('click', () => {
      flushState();
      native('hide_quick');
    });

    search.addEventListener('input', () => {
      persistQuery();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => load(search.value), 150);
    });

    search.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveSelection(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveSelection(-1);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        activate();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        flushState();
        native('hide_quick');
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || document.activeElement === search) return;
      event.preventDefault();
      flushState();
      native('hide_quick');
    });
  };

  const init = async () => {
    if (initialized) return;
    initialized = true;
    bind();
    const saved = await native('quick_get_state');
    if (saved?.query) search.value = saved.query;
    await load(search.value);
  };

  window.RepositQuick = {
    onShown: () => {
      setTimeout(() => {
        search.focus();
        search.select();
      }, 0);
      load(search.value);
    },
    beforeHide: () => flushState()
  };

  window.addEventListener('pywebviewready', init);
  window.addEventListener('DOMContentLoaded', () => setTimeout(init, 120));
})();
