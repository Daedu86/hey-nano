async function getTargetTab() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ command: 'getActiveTargetTab' }, (resp) => resolve(resp?.tab || null));
  });
}

function setMicBadge(enabled) {
  const badge = document.getElementById('micBadge');
  if (!badge) return;
  badge.textContent = enabled ? 'ON' : 'OFF';
  badge.classList.toggle('on', !!enabled);
  badge.classList.toggle('off', !enabled);
}

function setMicButtonState(enabled) {
  const toggle = document.getElementById('toggleMic');
  if (toggle) {
    if (toggle instanceof HTMLInputElement) {
      toggle.checked = !!enabled;
      toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    } else {
      toggle.textContent = enabled ? 'Disable Mic' : 'Enable Mic';
      toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    }
  }
  const label = document.querySelector('.toggle-label');
  if (label) label.textContent = enabled ? 'Mic On' : 'Mic Off';
  setMicBadge(enabled);
}

function appendMsg(role, text, ts, tokens, chars) {
  const chat = document.getElementById('chat');
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  const body = document.createElement('div');
  body.className = 'text';
  body.textContent = text || '';
  const meta = document.createElement('div');
  meta.className = 'meta';
  const when = ts ? new Date(ts).toLocaleTimeString() : '';
  const parts = [role === 'you' ? 'You' : (role === 'assistant' ? 'Assistant' : 'System')];
  if (when) parts.push(when);
  if (typeof tokens === 'number') parts.push(`${tokens} tok`);
  if (typeof chars === 'number') parts.push(`${chars} chars`);
  meta.textContent = parts.join('  ');
  const header = document.createElement('div');
  header.className = 'msg-header';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'msg-copy';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const value = body.textContent || '';
    if (!value) return;
    const original = copyBtn.textContent;
    const markCopied = () => {
      copyBtn.textContent = 'Copied!';
      copyBtn.disabled = true;
      setTimeout(() => {
        copyBtn.textContent = original;
        copyBtn.disabled = false;
      }, 1500);
    };
    let copied = false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(value);
        copied = true;
      }
    } catch (err) {
      console.warn('Clipboard API unavailable:', err);
    }
    if (!copied) {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'absolute';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        copied = true;
      } catch (fallbackErr) {
        console.error('Copy failed:', fallbackErr);
      }
    }
    if (copied) markCopied();
  });
  header.appendChild(meta);
  header.appendChild(copyBtn);
  el.appendChild(header);
  el.appendChild(body);
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}



function hydrateLog(log) {
  const chat = document.getElementById('chat');
  chat.innerHTML = '';
  (log || []).forEach(entry => appendMsg(entry.role, entry.text, entry.ts, entry.tokens, entry.chars));
}

// Context window tracking and banner
let windowTokens = null;
let usedTokens = 0;
let usedChars = 0;

function updateContextBanner() {
  const el = document.getElementById('contextInfo');
  if (!el) return;
  const parts = ['Live: your speech and assistant replies appear here.'];
  if (typeof usedTokens === 'number') {
    if (typeof windowTokens === 'number') parts.push(`Context: ${usedTokens}/${windowTokens} tok`);
    else parts.push(`Context: ${usedTokens} tok`);
  }
  if (typeof usedChars === 'number') parts.push(`Chars: ${usedChars}`);
  el.textContent = parts.join('  ');
}

function recalcUsageFromLog(log) {
  usedTokens = 0;
  usedChars = 0;
  (log || []).forEach((e) => {
    if (typeof e.tokens === 'number') usedTokens += e.tokens;
    if (typeof e.chars === 'number') usedChars += e.chars;
  });
  updateContextBanner();
}

function incrementUsage(tokens, chars) {
  if (typeof tokens === 'number') usedTokens += tokens;
  if (typeof chars === 'number') usedChars += chars;
  updateContextBanner();
}

const CONTEXT_TITLE_LIMIT = 80;
const CONTEXT_PREVIEW_LIMIT = 260;
const CONTEXT_SEND_LIMIT = 5;
const CONTEXT_BODY_LIMIT = 1200;
const CONTEXT_ATTACHMENT_LIMIT = 3;
const CONTEXT_IMAGE_LIMIT = 3;
const CONTEXT_IMAGE_MAX_BYTES = 512 * 1024; // 512 KB per image
const CONTEXT_HIGHLIGHT_LIMIT = 3;
const CONTEXT_HIGHLIGHT_LENGTH = 220;
const CONTEXT_AUDIO_MAX_BYTES = 1.5 * 1024 * 1024; // 1.5 MB per audio clip
const CONTEXT_ATTACHMENT_NAME_LIMIT = 80;
const CONTEXT_IMAGE_NAME_LIMIT = 80;
const CONTEXT_STORAGE_KEY = 'heyNano.popup.contextItems';
const CONTEXT_STORAGE_MAX_ITEMS = 20;
const CONTEXT_IMAGE_DATAURL_MAX_LENGTH = 2 * 1024 * 1024; // limit base64 size we send onward
const CONTEXT_STORAGE_DEFAULT_SESSION = 'default';
const CONTEXT_STORAGE_TAB_PREFIX = `${CONTEXT_STORAGE_KEY}.tab.`;

function getContextStorageKey(tabId, sessionId) {
  const sessionPart = (typeof sessionId === 'string' && sessionId.trim()) ? sessionId.trim() : CONTEXT_STORAGE_DEFAULT_SESSION;
  if (typeof tabId === 'number' && Number.isFinite(tabId) && tabId > 0) {
    return `${CONTEXT_STORAGE_TAB_PREFIX}${tabId}.session.${sessionPart}`;
  }
  return `${CONTEXT_STORAGE_TAB_PREFIX}default.session.${sessionPart}`;
}

let currentTargetTab = null;
let currentTabSessionId = null;
let contextStorageKey = getContextStorageKey(null, null);

const PANEL_ORDER_STORAGE_KEY = 'heyNano.popup.panelOrder';
let panelsContainer = null;

function applyPanelOrder(container) {
  try {
    const stored = localStorage.getItem(PANEL_ORDER_STORAGE_KEY);
    if (!stored) return;
    const order = JSON.parse(stored);
    if (!Array.isArray(order) || order.length === 0) return;
    const panels = Array.from(container.querySelectorAll('.panel'));
    order.forEach((name) => {
      const panel = panels.find((node) => (node.dataset.panel || '') === name);
      if (panel) container.appendChild(panel);
    });
  } catch {
    // ignore malformed storage
  }
}

function savePanelOrder(container) {
  try {
    const order = Array.from(container.querySelectorAll('.panel')).map((panel) => panel.dataset.panel || '');
    localStorage.setItem(PANEL_ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    // storage may be unavailable
  }
}

function initPanelDrag(container) {
  if (!container || container.dataset.panelsDndInit === 'true') return;
  container.dataset.panelsDndInit = 'true';

  const draggablePanels = Array.from(container.querySelectorAll('.panel'));
  draggablePanels.forEach((panel) => {
    panel.setAttribute('draggable', 'true');
  });

  let draggingPanel = null;
  let activeHandle = null;
  const disallowSelector = [
    'textarea',
    'input',
    'button',
    'select',
    'label',
    'a',
    '.chat',
    '#chat',
    '.msg',
    '.meta',
    '.text',
    '.context-item',
    '.context-list',
    '.context-form',
    '.context-pane',
    '.composer',
    'form'
  ].join(',');

  container.addEventListener('dragstart', (event) => {
    const targetPanel = event.target.closest('.panel');
    const handle = event.target.closest('.panel-handle');
    if (!targetPanel) return;
    if (!handle) {
      if (event.target.closest('.context-drag-handle') || event.target.closest('.context-remove')) return;
      if (event.target.closest(disallowSelector)) return;
    }
    draggingPanel = targetPanel;
    activeHandle = handle || targetPanel;
    draggingPanel.classList.add('dragging');
    if (handle) handle.setAttribute('aria-grabbed', 'true');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggingPanel.dataset.panel || '');
    try {
      const rect = draggingPanel.getBoundingClientRect();
      event.dataTransfer.setDragImage(draggingPanel, event.clientX - rect.left, event.clientY - rect.top);
    } catch {
      // ignore lack of custom drag image support
    }
  });

  container.addEventListener('dragover', (event) => {
    if (!draggingPanel) return;
    event.preventDefault();
    const panels = Array.from(container.querySelectorAll('.panel:not([hidden])'));
    if (panels.length === 0) return;
    const target = event.target.closest('.panel');
    if (!target || target === draggingPanel) return;
    const containerStyle = window.getComputedStyle(container);
    const isColumn = (containerStyle.flexDirection || '').includes('column');
    const rect = target.getBoundingClientRect();
    const before = isColumn
      ? event.clientY < rect.top + rect.height / 2
      : event.clientX < rect.left + rect.width / 2;
    if (before) {
      container.insertBefore(draggingPanel, target);
    } else {
      container.insertBefore(draggingPanel, target.nextSibling);
    }
  });

  const finalize = () => {
    if (!draggingPanel) return;
    draggingPanel.classList.remove('dragging');
    if (activeHandle && activeHandle.classList?.contains('panel-handle')) {
      activeHandle.setAttribute('aria-grabbed', 'false');
    }
    draggingPanel = null;
    activeHandle = null;
    savePanelOrder(container);
  };

  container.addEventListener('drop', (event) => {
    if (!draggingPanel) return;
    event.preventDefault();
    finalize();
  });

  container.addEventListener('dragend', () => {
    finalize();
  });
}

const contextState = {
  open: false,
  items: [],
};

function refreshContextItemsFromStorage() {
  contextState.items = [];
  loadContextItems();
  renderContextItems();
}

function applyContextStorageKeyFor(tabId, sessionId, { clearPrevious = false } = {}) {
  const previousKey = contextStorageKey;
  const newKey = getContextStorageKey(tabId, sessionId);
  if (previousKey === newKey) return false;
  contextStorageKey = newKey;
  if (clearPrevious && previousKey) {
    try { localStorage.removeItem(previousKey); } catch {}
  }
  refreshContextItemsFromStorage();
  return true;
}

function setCurrentTargetTab(tab) {
  const validTab = tab && typeof tab.id === 'number' ? tab : null;
  currentTargetTab = validTab;
  if (!validTab) {
    currentTabSessionId = null;
    applyContextStorageKeyFor(null, null);
    return;
  }
  const targetId = validTab.id;
  chrome.runtime.sendMessage({ command: 'getTabSession', tabId: targetId }, (resp) => {
    if (!currentTargetTab || currentTargetTab.id !== targetId) return;
    const previousSessionId = currentTabSessionId;
    if (chrome.runtime.lastError) {
      currentTabSessionId = null;
      applyContextStorageKeyFor(targetId, null, { clearPrevious: Boolean(previousSessionId) });
      return;
    }
    const sessionId = typeof resp?.sessionId === 'string' ? resp.sessionId : null;
    currentTabSessionId = sessionId;
    applyContextStorageKeyFor(targetId, sessionId, { clearPrevious: Boolean(previousSessionId && previousSessionId !== sessionId) });
  });
}

const contextFormState = {
  images: [],
};

function normalizeContextValue(value) {
  return String(value || '').trim();
}

function deriveContextTitle(title, body, images = []) {
  const trimmedTitle = normalizeContextValue(title);
  if (trimmedTitle) return trimmedTitle.slice(0, CONTEXT_TITLE_LIMIT);
  const normalizedBody = normalizeContextValue(body);
  if (normalizedBody) {
    const firstLine = normalizedBody.split(/\n/).find(Boolean) || 'Untitled';
    return firstLine.slice(0, CONTEXT_TITLE_LIMIT);
  }
  const firstImage = Array.isArray(images) && images.length ? images[0] : null;
  const fallback = firstImage && typeof firstImage.name === 'string' && firstImage.name.trim()
    ? firstImage.name.trim()
    : 'Image snippet';
  return fallback.slice(0, CONTEXT_TITLE_LIMIT);
}

function deriveContextPreview(body, images = []) {
  const text = normalizeContextValue(body);
  const trimmed = text.length > CONTEXT_PREVIEW_LIMIT ? text.slice(0, CONTEXT_PREVIEW_LIMIT).trim() + '...' : text;
  const imageNames = Array.isArray(images)
    ? images
      .slice(0, CONTEXT_IMAGE_LIMIT)
      .map((img) => (typeof img?.name === 'string' ? img.name.trim() : 'Image'))
      .filter(Boolean)
    : [];
  const imageSummary = imageNames.length ? `Images: ${imageNames.join(', ')}` : '';
  const parts = [];
  if (trimmed) parts.push(trimmed);
  if (imageSummary) parts.push(imageSummary);
  return parts.join('\n');
}

function extractHighlightsFromBody(body) {
  const text = normalizeContextValue(body);
  if (!text) return [];
  const sentences = text.match(/[^.!?]+[.!?]*/g) || [];
  if (!sentences.length) return [];
  const highlights = [];
  for (let i = 0; i < sentences.length && highlights.length < CONTEXT_HIGHLIGHT_LIMIT; i += 1) {
    const sentence = sentences[i].trim();
    if (!sentence) continue;
    highlights.push(sentence.length > CONTEXT_HIGHLIGHT_LENGTH ? `${sentence.slice(0, CONTEXT_HIGHLIGHT_LENGTH).trim()}…` : sentence);
  }
  if (!highlights.length && text) {
    highlights.push(text.length > CONTEXT_HIGHLIGHT_LENGTH ? `${text.slice(0, CONTEXT_HIGHLIGHT_LENGTH).trim()}…` : text);
  }
  return highlights;
}

function sanitizeStoredContextItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const stamp = Date.now();
  const baseId = (typeof raw.id === 'string' && raw.id.trim()) ? raw.id.trim() : `${stamp}-${Math.random().toString(16).slice(2, 8)}`;
  const title = normalizeContextValue(raw.title);
  const body = normalizeContextValue(raw.body);
  const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : stamp;
  const images = Array.isArray(raw.images)
    ? raw.images
      .slice(0, CONTEXT_IMAGE_LIMIT)
      .map((img, imageIndex) => {
        const dataUrl = typeof img?.dataUrl === 'string' ? img.dataUrl : '';
        if (!dataUrl.startsWith('data:image') || dataUrl.length > CONTEXT_IMAGE_DATAURL_MAX_LENGTH) return null;
        const name = normalizeContextValue(typeof img?.name === 'string' ? img.name : '').slice(0, CONTEXT_IMAGE_NAME_LIMIT) || 'Image';
        return {
          id: (typeof img?.id === 'string' && img.id.trim()) ? img.id : `${baseId}-img-${imageIndex}`,
          name,
          dataUrl,
          size: typeof img?.size === 'number' ? img.size : 0,
          lastModified: typeof img?.lastModified === 'number' ? img.lastModified : createdAt,
        };
      })
      .filter(Boolean)
    : [];
  const restored = {
    id: baseId,
    title,
    body,
    preview: typeof raw.preview === 'string' && raw.preview.trim()
      ? raw.preview
      : deriveContextPreview(body, images),
    images,
    createdAt,
  };
  return restored;
}

function persistContextItems() {
  try {
    const payload = contextState.items
      .slice(0, CONTEXT_STORAGE_MAX_ITEMS)
      .map((item) => ({
        id: item.id,
        title: item.title,
        body: item.body,
        preview: item.preview,
        images: Array.isArray(item.images)
          ? item.images
            .slice(0, CONTEXT_IMAGE_LIMIT)
            .map((img) => {
              const dataUrl = typeof img?.dataUrl === 'string' && img.dataUrl.length <= CONTEXT_IMAGE_DATAURL_MAX_LENGTH ? img.dataUrl : '';
              const entry = {
                id: img.id,
                name: img.name,
                size: img.size,
                lastModified: img.lastModified,
              };
              if (dataUrl) entry.dataUrl = dataUrl;
              return entry;
            })
          : [],
        createdAt: item.createdAt,
      }));
    localStorage.setItem(contextStorageKey, JSON.stringify(payload));
  } catch {}
}

function loadContextItems() {
  try {
    const raw = localStorage.getItem(contextStorageKey);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const restored = parsed
      .slice(0, CONTEXT_STORAGE_MAX_ITEMS)
      .map((entry) => sanitizeStoredContextItem(entry))
      .filter(Boolean);
    if (restored.length) {
      contextState.items = restored;
      persistContextItems();
    } else {
      contextState.items = [];
      localStorage.removeItem(contextStorageKey);
    }
  } catch {}
}

function createContextCard(item, { slotIndex = null, backlogIndex = null } = {}) {
  const wrapper = document.createElement('article');
  wrapper.className = 'context-item';
  wrapper.dataset.id = item.id;
  wrapper.setAttribute('role', 'listitem');

  let labelIndex = 0;
  if (typeof slotIndex === 'number') {
    wrapper.dataset.contextType = 'slot';
    wrapper.dataset.slotIndex = String(slotIndex);
    labelIndex = slotIndex;
    if (slotIndex < CONTEXT_SEND_LIMIT) wrapper.classList.add('context-highlight');
  } else {
    const backlogPos = backlogIndex ?? 0;
    wrapper.dataset.contextType = 'backlog';
    wrapper.dataset.backlogIndex = String(backlogPos);
    labelIndex = CONTEXT_SEND_LIMIT + backlogPos;
  }

  const headerEl = document.createElement('div');
  headerEl.className = 'context-item-header';

  const dragBtn = document.createElement('button');
  dragBtn.type = 'button';
  dragBtn.className = 'context-drag-handle';
  dragBtn.setAttribute('aria-label', 'Reorder context entry');
  dragBtn.setAttribute('aria-grabbed', 'false');
  dragBtn.setAttribute('draggable', 'true');
  dragBtn.innerHTML = '<span aria-hidden="true">⋮⋮</span>';

  const titleEl = document.createElement('div');
  titleEl.className = 'context-item-title';
  const baseTitle = item.title ? ` - ${item.title}` : '';
  titleEl.textContent = `Context Snippet #${labelIndex + 1}${baseTitle}`;

  headerEl.appendChild(dragBtn);
  headerEl.appendChild(titleEl);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'context-item-body';
  bodyEl.textContent = item.preview || 'No details provided.';

  let gallery = null;
  if (Array.isArray(item.images) && item.images.length) {
    gallery = document.createElement('div');
    gallery.className = 'context-item-images';
    item.images.slice(0, CONTEXT_IMAGE_LIMIT).forEach((img, index) => {
      if (!img || typeof img.dataUrl !== 'string') return;
      const figure = document.createElement('figure');
      figure.className = 'context-item-image';

      const link = document.createElement('a');
      link.href = img.dataUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = `Open image ${index + 1} in a new tab`;

      const imageEl = document.createElement('img');
      imageEl.src = img.dataUrl;
      imageEl.alt = img.name || `Context image ${index + 1}`;
      imageEl.loading = 'lazy';
      imageEl.decoding = 'async';
      link.appendChild(imageEl);
      figure.appendChild(link);

      if (img.name) {
        const caption = document.createElement('figcaption');
        caption.textContent = img.name;
        figure.appendChild(caption);
      }

      gallery.appendChild(figure);
    });
  }

  const metaEl = document.createElement('div');
  metaEl.className = 'context-item-meta';
  const time = new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const timeEl = document.createElement('span');
  timeEl.textContent = time;

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'context-remove';
  removeBtn.textContent = 'Remove';
  removeBtn.setAttribute('data-id', item.id);
  removeBtn.setAttribute('draggable', 'false');
  removeBtn.addEventListener('dragstart', (event) => event.preventDefault());
  metaEl.appendChild(timeEl);
  metaEl.appendChild(removeBtn);

  wrapper.appendChild(headerEl);
  wrapper.appendChild(bodyEl);
  if (gallery) wrapper.appendChild(gallery);
  wrapper.appendChild(metaEl);
  return wrapper;
}

function createPlaceholder(slotIndex) {
  const placeholder = document.createElement('article');
  placeholder.className = 'context-item context-placeholder';
  placeholder.setAttribute('role', 'listitem');
  placeholder.dataset.contextType = 'slot';
  placeholder.dataset.slotIndex = String(slotIndex);

  const titleEl = document.createElement('div');
  titleEl.className = 'context-item-title';
  titleEl.textContent = `Context Snippet #${slotIndex + 1} - Empty slot`;

  const bodyEl = document.createElement('div');
  bodyEl.className = 'context-placeholder-body';
  bodyEl.textContent = 'Drag a snippet here to include it as instant context.';

  placeholder.appendChild(titleEl);
  placeholder.appendChild(bodyEl);
  return placeholder;
}

function updateContextCount() {
  const countEl = document.getElementById('contextCount');
  if (!countEl) return;
  countEl.textContent = String(contextState.items.length);
}

function updateContextHighlights() {
  const slotWrapper = document.querySelector('.context-slot-wrapper');
  if (!slotWrapper) return;
  const cards = slotWrapper.querySelectorAll('.context-item[data-id]');
  cards.forEach((card, index) => {
    if (index < CONTEXT_SEND_LIMIT) card.classList.add('context-highlight');
    else card.classList.remove('context-highlight');
  });
}

function renderContextItems() {
  const list = document.getElementById('contextList');
  const empty = document.getElementById('contextEmpty');
  if (!list) return;

  list.innerHTML = '';

  const slotWrapper = document.createElement('div');
  slotWrapper.className = 'context-slot-wrapper';
  for (let i = 0; i < CONTEXT_SEND_LIMIT; i += 1) {
    const item = contextState.items[i];
    if (item) slotWrapper.appendChild(createContextCard(item, { slotIndex: i }));
    else slotWrapper.appendChild(createPlaceholder(i));
  }
  list.appendChild(slotWrapper);

  const backlogItems = contextState.items.slice(CONTEXT_SEND_LIMIT);
  const backlogWrapper = document.createElement('div');
  backlogWrapper.className = 'context-backlog-wrapper';
  backlogItems.forEach((item, index) => {
    backlogWrapper.appendChild(createContextCard(item, { backlogIndex: index }));
  });
  list.appendChild(backlogWrapper);

  if (empty) empty.style.display = contextState.items.length ? 'none' : '';
  updateContextCount();
  updateContextHighlights();
}

function syncContextStateToDom() {
  const list = document.getElementById('contextList');
  if (!list) return;
  const slotWrapper = list.querySelector('.context-slot-wrapper');
  const backlogWrapper = list.querySelector('.context-backlog-wrapper');
  const ordered = [];
  const appendIfPresent = (node) => {
    if (!node) return;
    const id = node.dataset.id;
    if (!id) return;
    const found = contextState.items.find((item) => item.id === id);
    if (found && !ordered.includes(found)) ordered.push(found);
  };

  if (slotWrapper) {
    slotWrapper.querySelectorAll('.context-item[data-id]').forEach(appendIfPresent);
  }
  if (backlogWrapper) {
    backlogWrapper.querySelectorAll('.context-item[data-id]').forEach(appendIfPresent);
  }

  const seen = new Set(ordered.map((item) => item.id));
  contextState.items.forEach((item) => {
    if (!seen.has(item.id)) ordered.push(item);
  });

  contextState.items = ordered;
  if (contextState.items.length > CONTEXT_STORAGE_MAX_ITEMS) {
    contextState.items.length = CONTEXT_STORAGE_MAX_ITEMS;
  }
  updateContextHighlights();
  persistContextItems();
}

function getContextDropTarget(container, cursorY) {
  const siblings = Array.from(container.querySelectorAll('.context-item:not(.dragging)'));
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  siblings.forEach((item) => {
    const rect = item.getBoundingClientRect();
    const offset = cursorY - (rect.top + rect.height / 2);
    if (offset < 0 && offset > closest.offset) {
      closest = { offset, element: item };
    }
  });
  return closest.element;
}

function initContextDrag() {
  const list = document.getElementById('contextList');
  if (!list || list.dataset.dndInitialized === 'true') return;
  list.dataset.dndInitialized = 'true';
  const dragState = { item: null, handle: null };

  const cleanup = () => {
    if (!dragState.item) return;
    dragState.item.classList.remove('dragging');
    if (dragState.handle) dragState.handle.setAttribute('aria-grabbed', 'false');
    dragState.item = null;
    dragState.handle = null;
    syncContextStateToDom();
    renderContextItems();
  };

  list.addEventListener('dragstart', (event) => {
    const handle = event.target.closest('.context-drag-handle');
    if (!handle) return;
    const item = handle.closest('.context-item');
    if (!item || !item.dataset.id) return;
    dragState.item = item;
    dragState.handle = handle;
    item.classList.add('dragging');
    handle.setAttribute('aria-grabbed', 'true');
    event.dataTransfer.effectAllowed = 'move';
    try {
      event.dataTransfer.setData('text/plain', item.dataset.id || '');
    } catch {}
  });

  list.addEventListener('dragover', (event) => {
    if (!dragState.item) return;
    event.preventDefault();
    try {
      event.dataTransfer.dropEffect = 'move';
    } catch {}
    const slotWrapper = list.querySelector('.context-slot-wrapper');
    const backlogWrapper = list.querySelector('.context-backlog-wrapper');
    const container = event.target.closest('.context-slot-wrapper, .context-backlog-wrapper') || (slotWrapper ?? backlogWrapper);
    if (!container) return;
    const afterElement = getContextDropTarget(container, event.clientY);
    if (!afterElement) {
      container.appendChild(dragState.item);
    } else if (afterElement !== dragState.item) {
      container.insertBefore(dragState.item, afterElement);
    }
  });

  list.addEventListener('drop', (event) => {
    if (!dragState.item) return;
    event.preventDefault();
    cleanup();
  });

  list.addEventListener('dragend', () => {
    cleanup();
  });
}

function updateContextImagePreview() {
  const preview = document.getElementById('contextImagePreview');
  if (!preview) return;
  preview.innerHTML = '';
  if (!contextFormState.images.length) {
    preview.dataset.empty = 'true';
    preview.textContent = 'No images attached.';
    return;
  }
  preview.dataset.empty = 'false';
  let appended = 0;
  contextFormState.images.forEach((img) => {
    if (!img || typeof img.dataUrl !== 'string') return;
    const figure = document.createElement('figure');
    figure.className = 'context-image-thumb';

    const imageEl = document.createElement('img');
    imageEl.src = img.dataUrl;
    imageEl.alt = img.name || 'Context image';
    imageEl.loading = 'lazy';
    imageEl.decoding = 'async';
    figure.appendChild(imageEl);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.setAttribute('data-remove-image', img.id);
    removeBtn.setAttribute('aria-label', `Remove ${img.name || 'image'}`);
    removeBtn.textContent = 'x';
    figure.appendChild(removeBtn);

    const caption = document.createElement('figcaption');
    caption.textContent = img.name || 'Image';
    figure.appendChild(caption);

    preview.appendChild(figure);
    appended += 1;
  });
  if (!appended) {
    preview.dataset.empty = 'true';
    preview.textContent = 'No images attached.';
  }
}

function resetContextImages() {
  contextFormState.images = [];
  const input = document.getElementById('contextImages');
  if (input) input.value = '';
  updateContextImagePreview();
}

function handleContextImageFile(file) {
  if (!file) return false;
  if (contextFormState.images.length >= CONTEXT_IMAGE_LIMIT) return false;
  if (file.type && !file.type.startsWith('image/')) {
    appendMsg('system', `Only image files can be attached (${file.name || 'file'} skipped).`, Date.now(), 0, 0);
    return false;
  }
  if (file.size > CONTEXT_IMAGE_MAX_BYTES) {
    appendMsg('system', `${file.name || 'Image'} is larger than 512 KB and was skipped.`, Date.now(), 0, 0);
    return false;
  }
  const imageId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const reader = new FileReader();
  reader.onload = (event) => {
    const dataUrl = typeof event.target?.result === 'string' ? event.target.result : '';
    if (!dataUrl.startsWith('data:image')) {
      appendMsg('system', `Could not load ${file.name || 'image'}.`, Date.now(), 0, 0);
      return;
    }
    if (contextFormState.images.length >= CONTEXT_IMAGE_LIMIT) {
      appendMsg('system', `You can attach up to ${CONTEXT_IMAGE_LIMIT} images per snippet.`, Date.now(), 0, 0);
      return;
    }
    const safeName = (file.name || 'Image').trim().slice(0, CONTEXT_IMAGE_NAME_LIMIT) || 'Image';
    contextFormState.images.push({
      id: imageId,
      name: safeName,
      dataUrl,
      size: file.size,
      lastModified: file.lastModified || Date.now(),
    });
    updateContextImagePreview();
  };
  reader.onerror = () => {
    appendMsg('system', `Could not read ${file.name || 'image'}.`, Date.now(), 0, 0);
  };
  reader.readAsDataURL(file);
  return true;
}

function resetContextForm() {
  const title = document.getElementById('contextTitle');
  const body = document.getElementById('contextBody');
  if (title) title.value = '';
  if (body) body.value = '';
  resetContextImages();
}

function addContextItem({ title, body, images }) {
  const finalBody = normalizeContextValue(body);
  const stamp = Date.now();
  const itemId = `${stamp}-${Math.random().toString(16).slice(2, 8)}`;
  const safeImages = Array.isArray(images)
    ? images
      .slice(0, CONTEXT_IMAGE_LIMIT)
      .map((img, index) => {
        const dataUrl = typeof img?.dataUrl === 'string' ? img.dataUrl : '';
        if (!dataUrl.startsWith('data:image') || dataUrl.length > CONTEXT_IMAGE_DATAURL_MAX_LENGTH) return null;
        const name = typeof img?.name === 'string' ? img.name.trim().slice(0, CONTEXT_IMAGE_NAME_LIMIT) : 'Image';
        return {
          id: `${itemId}-img-${index}`,
          name,
          dataUrl,
          size: typeof img?.size === 'number' ? img.size : 0,
          lastModified: typeof img?.lastModified === 'number' ? img.lastModified : stamp,
        };
      })
      .filter(Boolean)
    : [];
  const finalTitle = deriveContextTitle(title, finalBody, safeImages);
  const preview = deriveContextPreview(finalBody, safeImages);
  const item = {
    id: itemId,
    title: finalTitle,
    body: finalBody,
    preview,
    images: safeImages,
    createdAt: stamp,
  };
  contextState.items.unshift(item);
  if (contextState.items.length > CONTEXT_STORAGE_MAX_ITEMS) {
    contextState.items.length = CONTEXT_STORAGE_MAX_ITEMS;
  }
  persistContextItems();
  renderContextItems();
}

function removeContextItem(id) {
  const before = contextState.items.length;
  contextState.items = contextState.items.filter((item) => item.id !== id);
  if (contextState.items.length !== before) {
    persistContextItems();
    renderContextItems();
  }
}

function hideContextPanel({ focusAddButton = true } = {}) {
  const panelShell = document.querySelector('.panel[data-panel="context"]');
  const pane = document.getElementById('contextPane');
  const addBtn = document.getElementById('addContextBtn');
  if (!panelShell || !pane || !addBtn) return;
  pane.setAttribute('hidden', '');
  panelShell.setAttribute('hidden', '');
  contextState.open = false;
  addBtn.textContent = 'Add Context';
  addBtn.setAttribute('aria-expanded', 'false');
  if (focusAddButton) {
    addBtn.focus({ preventScroll: true });
  }
  if (panelsContainer) savePanelOrder(panelsContainer);
}

function showContextPanel() {
  const panelShell = document.querySelector('.panel[data-panel="context"]');
  const pane = document.getElementById('contextPane');
  const addBtn = document.getElementById('addContextBtn');
  if (!panelShell || !pane || !addBtn) return;
  panelShell.removeAttribute('hidden');
  pane.removeAttribute('hidden');
  contextState.open = true;
  addBtn.textContent = 'Hide Context';
  addBtn.setAttribute('aria-expanded', 'true');
  resetContextForm();
  const titleField = document.getElementById('contextTitle');
  (titleField || document.getElementById('contextBody'))?.focus();
  if (panelsContainer) savePanelOrder(panelsContainer);
}

function toggleContextPanel(forceOpen) {
  const panelShell = document.querySelector('.panel[data-panel="context"]');
  if (!panelShell) return;
  const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : panelShell.hasAttribute('hidden');
  if (shouldOpen) {
    showContextPanel();
  } else {
    hideContextPanel({ focusAddButton: false });
  }
}

function ensureContextPanelHidden() {
  const panelShell = document.querySelector('.panel[data-panel="context"]');
  if (!panelShell) return;
  if (!panelShell.hasAttribute('hidden')) hideContextPanel({ focusAddButton: false });
  if (panelsContainer) savePanelOrder(panelsContainer);
}

async function toggleMicForTarget(desiredState) {
  const toggle = document.getElementById('toggleMic');
  const target = currentTargetTab || await getTargetTab();
  if (!target) {
    if (toggle instanceof HTMLInputElement) toggle.checked = !desiredState;
    appendMsg('system', 'No active tab detected. Open a page and try again.', Date.now(), 0, 0);
    return;
  }
  setCurrentTargetTab(target);
  chrome.runtime.sendMessage({ command: 'getMicState', tabId: target.id }, (res) => {
    const error = chrome.runtime.lastError;
    if (error) {
      appendMsg('system', `Unable to read mic state: ${error.message || error}`, Date.now(), 0, 0);
      setMicButtonState(false);
      return;
    }
    const enabled = !!res?.enabled;
    if (enabled === desiredState) {
      setMicButtonState(enabled);
      return;
    }
    const command = desiredState ? 'enableMicForTab' : 'disableMicForTab';
    chrome.runtime.sendMessage({ command, tabId: target.id }, () => {
      const toggleError = chrome.runtime.lastError;
      if (toggleError) {
        appendMsg('system', `Mic toggle failed: ${toggleError.message || toggleError}`, Date.now(), 0, 0);
        setMicButtonState(!desiredState);
      }
    });
  });
}

async function submitComposerMessage() {
  const input = document.getElementById('composerInput');
  const sendBtn = document.getElementById('composerSend');
  if (!input) return;
  const text = (input.value || '').trim();
  if (!text) return;

  const target = currentTargetTab || await getTargetTab();
  if (!target) {
    appendMsg('system', 'No active tab detected. Open a page and try again.', Date.now(), 0, 0);
    return;
  }
  setCurrentTargetTab(target);

  const contextPayload = contextState.items
    .slice(0, CONTEXT_SEND_LIMIT)
    .map((item) => {
      const title = normalizeContextValue(item.title).slice(0, CONTEXT_TITLE_LIMIT);
      const body = normalizeContextValue(item.body).slice(0, CONTEXT_BODY_LIMIT);
      const preview = typeof item.preview === 'string' ? item.preview.trim() : deriveContextPreview(body, item.images);
      const highlights = extractHighlightsFromBody(body);
      const images = Array.isArray(item.images)
        ? item.images
          .slice(0, CONTEXT_IMAGE_LIMIT)
          .map((img) => {
            const name = typeof img?.name === 'string' ? img.name.trim().slice(0, CONTEXT_IMAGE_NAME_LIMIT) : '';
            const dataUrlRaw = typeof img?.dataUrl === 'string' ? img.dataUrl.trim() : '';
            const dataUrl = dataUrlRaw && /^data:image\//i.test(dataUrlRaw) && dataUrlRaw.length <= CONTEXT_IMAGE_DATAURL_MAX_LENGTH
              ? dataUrlRaw
              : '';
            if (!name && !dataUrl) return null;
            const imageEntry = {};
            if (name) imageEntry.name = name;
            if (dataUrl) imageEntry.dataUrl = dataUrl;
            return imageEntry;
          })
          .filter(Boolean)
        : [];
      if (!title && !body && !images.length) return null;
      const entry = { title, body };
      if (images.length) entry.images = images;
      if (preview) entry.preview = preview.slice(0, CONTEXT_BODY_LIMIT);
      if (highlights.length) entry.highlights = highlights;
      const meta = {};
      const createdAt = typeof item.createdAt === 'number' ? item.createdAt : null;
      if (createdAt) meta.createdAt = createdAt;
      if (images.length) meta.imageCount = images.length;
      meta.hasBody = !!body;
      if (Object.keys(meta).length) entry.meta = meta;
      return entry;
    })
    .filter(Boolean);

  if (sendBtn) sendBtn.disabled = true;
  input.disabled = true;

  try {
    const payload = { command: 'typedInput', tabId: target.id, text };
    if (contextPayload.length) payload.context = contextPayload;
    chrome.runtime.sendMessage(payload, (resp) => {
      if (sendBtn) sendBtn.disabled = false;
      input.disabled = false;
      if (resp && resp.ok === false) {
        appendMsg('system', 'Unable to send message. Please try again.', Date.now(), 0, 0);
      } else {
        setMicBadge(true);
      }
      if (resp && resp.ok) setMicBadge(true);
    });
  } catch (e) {
    if (sendBtn) sendBtn.disabled = false;
    input.disabled = false;
    appendMsg('system', 'Unable to send message. Please try again.', Date.now(), 0, 0);
  }

  input.value = '';
  input.focus();
}

document.addEventListener('DOMContentLoaded', async () => {
  panelsContainer = document.getElementById('layoutPanels');
  if (panelsContainer) {
    applyPanelOrder(panelsContainer);
    initPanelDrag(panelsContainer);
  }

  setCurrentTargetTab(await getTargetTab());
  // Load context window limits
  chrome.runtime.sendMessage({ command: 'getContextLimits' }, (resp) => {
    if (resp && typeof resp.windowTokens === 'number') windowTokens = resp.windowTokens;
    updateContextBanner();
  });
  if (currentTargetTab) {
    chrome.runtime.sendMessage({ command: 'getMicState', tabId: currentTargetTab.id }, (res) => setMicButtonState(!!res?.enabled));
    chrome.runtime.sendMessage({ command: 'getConversationLog', tabId: currentTargetTab.id }, (resp) => {
      const log = resp?.log || [];
      hydrateLog(log);
      recalcUsageFromLog(log);
    });
  } else {
    setMicButtonState(false);
  }

  const resetBtn = document.getElementById('resetSessionBtn');
  if (resetBtn) {
    const doLocalReset = () => {
      currentTabSessionId = null;
      applyContextStorageKeyFor(currentTargetTab ? currentTargetTab.id : null, null, { clearPrevious: true });
      contextState.items = [];
      renderContextItems();
      hydrateLog([]);
      recalcUsageFromLog([]);
      resetContextForm();
    };
    resetBtn.addEventListener('click', async () => {
      if (resetBtn.disabled) return;
      resetBtn.disabled = true;
      resetBtn.textContent = 'Resetting...';
      const restoreButton = () => {
        resetBtn.disabled = false;
        resetBtn.textContent = 'New Session';
      };
      const target = currentTargetTab || await getTargetTab();
      if (!target || typeof target.id !== 'number') {
        doLocalReset();
        restoreButton();
        return;
      }
      chrome.runtime.sendMessage({ command: 'resetSession', tabId: target.id }, (resp) => {
        if (!resp || resp.ok === false) {
          doLocalReset();
          appendMsg('system', 'Started a fresh local session. Remote reset may have failed.', Date.now(), 0, 0);
        }
        restoreButton();
      });
    });
  }

  // Toggle handler acts on the current active target tab (same as keyboard)
  const toggleControl = document.getElementById('toggleMic');
  if (toggleControl instanceof HTMLInputElement) {
    toggleControl.addEventListener('change', () => {
      toggleMicForTarget(toggleControl.checked);
    });
  } else {
    toggleControl?.addEventListener('click', async () => {
      const t = currentTargetTab || await getTargetTab();
      if (!t) return;
      setCurrentTargetTab(t);
      chrome.runtime.sendMessage({ command: 'getMicState', tabId: t.id }, (res) => {
        const enabled = !!res?.enabled;
        if (enabled) {
          chrome.runtime.sendMessage({ command: 'disableMicForTab', tabId: t.id }, () => setMicButtonState(false));
        } else {
          chrome.runtime.sendMessage({ command: 'enableMicForTab', tabId: t.id }, () => setMicButtonState(true));
        }
      });
    });
  }

  const sendBtn = document.getElementById('composerSend');
  sendBtn?.addEventListener('click', submitComposerMessage);

  const composerInput = document.getElementById('composerInput');
  composerInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitComposerMessage();
    }
  });

  initContextDrag();
  toggleContextPanel(false);

  const addContextBtn = document.getElementById('addContextBtn');
  addContextBtn?.addEventListener('click', () => {
    const wasOpen = contextState.open;
    toggleContextPanel(true);
    if (!wasOpen) {
      try { chrome.runtime.sendMessage({ event: 'addContextRequested' }); } catch {}
    }
  });

  const contextHideBtn = document.getElementById('contextHideBtn');
  contextHideBtn?.addEventListener('click', () => toggleContextPanel(false));

  const contextCancelBtn = document.getElementById('contextCancelBtn');
  contextCancelBtn?.addEventListener('click', () => {
    resetContextForm();
    toggleContextPanel(false);
  });

  const contextImagesInput = document.getElementById('contextImages');
  const contextImagesTrigger = document.getElementById('contextImagesTrigger');
  const contextImagePreview = document.getElementById('contextImagePreview');
  contextImagesTrigger?.addEventListener('click', () => {
    contextImagesInput?.click();
  });
  contextImagesInput?.addEventListener('change', (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    let limitWarned = false;
    files.forEach((file) => {
      if (contextFormState.images.length >= CONTEXT_IMAGE_LIMIT) {
        if (!limitWarned) {
          appendMsg('system', `You can attach up to ${CONTEXT_IMAGE_LIMIT} images per snippet.`, Date.now(), 0, 0);
          limitWarned = true;
        }
        return;
      }
      handleContextImageFile(file);
    });
    event.target.value = '';
  });
  contextImagePreview?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-remove-image]');
    if (!btn) return;
    event.preventDefault();
    const id = btn.getAttribute('data-remove-image');
    if (!id) return;
    contextFormState.images = contextFormState.images.filter((img) => img.id !== id);
    updateContextImagePreview();
  });
  resetContextImages();

  const contextForm = document.getElementById('contextForm');
  contextForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const titleInput = document.getElementById('contextTitle');
    const bodyInput = document.getElementById('contextBody');
    const rawTitle = titleInput ? titleInput.value : '';
    const rawBody = bodyInput ? bodyInput.value : '';
    const hasTitle = !!normalizeContextValue(rawTitle);
    const hasBody = !!normalizeContextValue(rawBody);
    const hasImages = contextFormState.images.length > 0;
    if (!hasTitle && !hasBody && !hasImages) {
      appendMsg('system', 'Add a title, details, or at least one image before saving context.', Date.now(), 0, 0);
      (bodyInput || document.getElementById('contextImagesTrigger'))?.focus();
      return;
    }
    addContextItem({ title: rawTitle, body: rawBody, images: contextFormState.images });
    resetContextForm();
  });

  const contextListEl = document.getElementById('contextList');
  contextListEl?.addEventListener('click', (event) => {
    const btn = event.target.closest('.context-remove');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    if (id) removeContextItem(id);
  });

  // Live updates: capture STT/LLM from the active target tab, and mic state globally
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.event === 'tabSessionReset') {
      if (!currentTargetTab || msg.tabId !== currentTargetTab.id) return;
      const newSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null;
      currentTabSessionId = newSessionId;
      applyContextStorageKeyFor(currentTargetTab.id, newSessionId, { clearPrevious: true });
      hydrateLog([]);
      recalcUsageFromLog([]);
      resetContextForm();
      return;
    }
    if (msg?.event === 'micStateChanged') {
      // Refresh target and update state if this event pertains to it
      getTargetTab().then((current) => {
        setCurrentTargetTab(current);
        if (!currentTargetTab) return;
        if (msg.tabId === currentTargetTab.id) setMicButtonState(!!msg.enabled);
      });
      return;
    }
    if (!sender?.tab?.id) return;
    if (!currentTargetTab || sender.tab.id !== currentTargetTab.id) {
      if (sender?.tab && typeof sender.tab.id === 'number') setCurrentTargetTab(sender.tab);
    }
    if (!currentTargetTab || sender.tab.id !== currentTargetTab.id) return;
    if (msg?.event === 'stt') {
      appendMsg('you', msg.text, msg.ts, msg.tokens, msg.chars);
      incrementUsage(msg.tokens, msg.chars);
    } else if (msg?.event === 'llm') {
      appendMsg('assistant', msg.text, msg.ts, msg.tokens, msg.chars);
      incrementUsage(msg.tokens, msg.chars);
      setMicBadge(false);
    } else if (msg?.event === 'system' && msg.type === 'mic') {
      if (msg.state === 'disabled') {
        appendMsg('system', 'Mic was stopped', msg.ts || Date.now(), 0, 0);
      } else if (msg.state === 'enabled') {
        appendMsg('system', 'Mic enabled', msg.ts || Date.now(), 0, 0);
      } else if (msg.state === 'error') {
        const detail = typeof msg.detail === 'string' && msg.detail.trim()
          ? msg.detail.trim()
          : 'Microphone error occurred. Check mic permissions and try again.';
        appendMsg('system', detail, msg.ts || Date.now(), 0, 0);
        setMicButtonState(false);
      }
    }
  });
});










