function normalizeUrl(u) {
  let url = (u || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url;
}

async function getTargetTab() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ command: 'getActiveTargetTab' }, (resp) => resolve(resp?.tab || null));
  });
}

function setMicButtonState(btn, enabled) {
  btn.textContent = enabled ? 'Disable Mic' : 'Enable Mic';
  btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  const badge = document.getElementById('micBadge');
  if (badge) {
    badge.textContent = enabled ? 'ON' : 'OFF';
    badge.classList.toggle('on', !!enabled);
    badge.classList.toggle('off', !enabled);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // Register this window id so background can restore after reloads
  try {
    chrome.windows.getCurrent({}, (win) => {
      if (win && typeof win.id === 'number') {
        chrome.runtime.sendMessage({ command: 'registerAdminWindow', windowId: win.id });
      }
    });
  } catch {}
  const toggleBtn = document.getElementById('toggleMic');
  const openForm = document.getElementById('openForm');
  const urlInput = document.getElementById('urlInput');
  const listBtn = document.getElementById('listTabs');
  const out = document.getElementById('tabsOut');
  const disableAll = document.getElementById('disableAll');
  const htmlDomEnable = document.getElementById('htmlDomEnable');
  const htmlDomDisable = document.getElementById('htmlDomDisable');
  const htmlDomBadge = document.getElementById('htmlDomBadge');
  const htmlDomTarget = document.getElementById('htmlDomTarget');
  const htmlDomRefresh = document.getElementById('htmlDomRefresh');
  let htmlDomCurrentTabId = null;

  let target = await getTargetTab();
  if (!target) {
    setMicButtonState(toggleBtn, false);
  } else {
    chrome.runtime.sendMessage({ command: 'getMicState', tabId: target.id }, (res) => {
      setMicButtonState(toggleBtn, !!res?.enabled);
    });
  }

  // Init HTML/DOM Layout state
  function setHtmlDomBadge(enabled) {
    if (!htmlDomBadge) return;
    htmlDomBadge.textContent = enabled ? 'ON' : 'OFF';
    htmlDomBadge.classList.toggle('on', !!enabled);
    htmlDomBadge.classList.toggle('off', !enabled);
  }
  try {
    chrome.runtime.sendMessage({ command: 'getHtmlDomLayoutEnabled' }, (resp) => setHtmlDomBadge(!!resp?.enabled));
  } catch {}

  htmlDomEnable?.addEventListener('click', () => {
    const payload = { command: 'setHtmlDomLayoutEnabled', enabled: true };
    if (typeof htmlDomCurrentTabId === 'number') payload.tabId = htmlDomCurrentTabId;
    try { console.log('[Admin] HTML/DOM LAYOUT: Enable clicked', payload); } catch {}
    try {
      chrome.runtime.sendMessage(payload, (resp) => {
        if (chrome.runtime.lastError) {
          try { console.error('[Admin] HTML/DOM LAYOUT: Enable failed:', chrome.runtime.lastError.message || chrome.runtime.lastError); } catch {}
          return;
        }
        setHtmlDomBadge(true);
        if (resp) {
          const info = {
            ok: resp.ok,
            enabled: resp.enabled,
            tabId: resp.tabId,
            tabUrl: resp.tabUrl,
            injected: resp.injected,
            note: resp.note || null,
          };
          try { console.log('[Admin] HTML/DOM LAYOUT: Enable response', info); } catch {}
          if (resp && htmlDomTarget) {
            const extra = resp.note ? `\nNote: ${resp.note}` : '';
            if (resp.tabUrl) htmlDomTarget.textContent = `tabId=${resp.tabId} - ${resp.tabUrl}${extra}`;
            else if (extra) htmlDomTarget.textContent += extra;
          }
          if (resp.injected === false) {
            try { console.warn('[Admin] HTML/DOM LAYOUT: Content not injected into page. This can happen on chrome://, edge://, about: pages, or when "Allow access to file URLs" is disabled for file:// pages.', resp.note || ''); } catch {}
          }
          if (!resp.tabId && resp.ok === false) {
            try { console.warn('[Admin] HTML/DOM LAYOUT: Background reported an error:', resp.note || '(unknown)'); } catch {}
          } else if (!resp.tabId) {
            try { console.warn('[Admin] HTML/DOM LAYOUT: No target tab resolved. Use Refresh Target to capture the active tab.'); } catch {}
          }
        } else {
          try { console.warn('[Admin] HTML/DOM LAYOUT: No response from background.'); } catch {}
        }
      });
    } catch (e) {
      try { console.error('[Admin] HTML/DOM LAYOUT: Enable exception:', e && (e.message || e)); } catch {}
    }
  });
  htmlDomDisable?.addEventListener('click', () => {
    const payload = { command: 'setHtmlDomLayoutEnabled', enabled: false };
    if (typeof htmlDomCurrentTabId === 'number') payload.tabId = htmlDomCurrentTabId;
    try { console.log('[Admin] HTML/DOM LAYOUT: Disable clicked', payload); } catch {}
    try {
      chrome.runtime.sendMessage(payload, (resp) => {
        if (chrome.runtime.lastError) {
          try { console.error('[Admin] HTML/DOM LAYOUT: Disable failed:', chrome.runtime.lastError.message || chrome.runtime.lastError); } catch {}
          return;
        }
        setHtmlDomBadge(false);
        if (resp) {
          const info = {
            ok: resp.ok,
            enabled: resp.enabled,
            tabId: resp.tabId,
            tabUrl: resp.tabUrl,
            injected: resp.injected,
            note: resp.note || null,
          };
          try { console.log('[Admin] HTML/DOM LAYOUT: Disable response', info); } catch {}
          if (resp && htmlDomTarget) {
            const extra = resp.note ? `\nNote: ${resp.note}` : '';
            if (resp.tabUrl) htmlDomTarget.textContent = `tabId=${resp.tabId} - ${resp.tabUrl}${extra}`;
            else if (extra) htmlDomTarget.textContent += extra;
          }
        } else {
          try { console.warn('[Admin] HTML/DOM LAYOUT: No response from background.'); } catch {}
        }
      });
    } catch (e) {
      try { console.error('[Admin] HTML/DOM LAYOUT: Disable exception:', e && (e.message || e)); } catch {}
    }
  });

  // Refresh and display the current active target tab (independent of mic)
  async function refreshHtmlDomTarget() {
    const write = (tab) => {
      if (!htmlDomTarget) return;
      if (tab && typeof tab.id === 'number') {
        const title = tab.title || '(no title)';
        const url = tab.url || '';
        htmlDomTarget.textContent = `tabId=${tab.id} - ${title} \n${url}`;
        htmlDomCurrentTabId = tab.id;
      } else {
        htmlDomTarget.textContent = 'No active tab resolved. Click Refresh Target while a page is focused.';
        htmlDomCurrentTabId = null;
      }
    };
    try {
      // Prefer active target tab first
      chrome.runtime.sendMessage({ command: 'getActiveTargetTab' }, (r2) => {
        const tab = r2 && r2.tab ? r2.tab : null;
        write(tab);
      });
    } catch { write(null); }
  }
  refreshHtmlDomTarget();
  htmlDomRefresh?.addEventListener('click', refreshHtmlDomTarget);

  toggleBtn.addEventListener('click', async () => {
    // Always resolve current target before toggling (matches keyboard behavior)
    const t = await getTargetTab();
    if (!t) return;
    chrome.runtime.sendMessage({ command: 'getMicState', tabId: t.id }, (res) => {
      const enabled = !!res?.enabled;
      if (enabled) {
        chrome.runtime.sendMessage({ command: 'disableMicForTab', tabId: t.id }, () => {
          setMicButtonState(toggleBtn, false);
        });
      } else {
        // Focus the real browser window + tab first, then open anchored popup, then enable mic.
        // All inside this click handler to preserve user activation.
        chrome.windows.update(t.windowId, { focused: true }, () => {
          chrome.tabs.update(t.id, { active: true }, () => {
            try {
              if (chrome.action && typeof chrome.action.openPopup === 'function') {
                const p = chrome.action.openPopup();
                if (p && typeof p.then === 'function') p.catch(() => {});
              }
            } catch {}
            chrome.runtime.sendMessage({ command: 'enableMicForTab', tabId: t.id }, () => {
              setMicButtonState(toggleBtn, true);
            });
          });
        });
      }
    });
  });

  // Keep Admin Panel UI in sync with external changes (toolbar/shortcut)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.event === 'micStateChanged') {
      // If the target tab changed (user focused another tab), refresh it
      getTargetTab().then((current) => {
        target = current || target;
        if (!target) return;
        if (msg.tabId === target.id) {
          setMicButtonState(toggleBtn, !!msg.enabled);
        }
      });
    }
    if (msg?.event === 'htmlDomLayoutSync') {
      try {
        const enabled = !!msg.enabled;
        const badge = document.getElementById('htmlDomBadge');
        if (badge) {
          badge.textContent = enabled ? 'ON' : 'OFF';
          badge.classList.toggle('on', enabled);
          badge.classList.toggle('off', !enabled);
        }
      } catch {}
    }
  });

  openForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = normalizeUrl(urlInput.value);
    if (!url) return;
    chrome.runtime.sendMessage({ command: 'openTab', url });
    urlInput.value = '';
  });

  listBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ command: 'listTabs' }, (resp) => {
      const tabs = resp?.tabs || [];
      // Clear and render wrapped rows
      out.innerHTML = '';
      tabs.forEach((t, i) => {
        const row = document.createElement('div');
        row.className = 'tab-row';

        const id = document.createElement('div');
        id.className = 'tab-id';
        id.textContent = `#${i + 1} - id=${t.id}`;

        const title = document.createElement('div');
        title.className = 'tab-title';
        title.textContent = t.title || '(no title)';

        const url = document.createElement('div');
        url.className = 'tab-url';
        url.textContent = t.url || '';

        row.appendChild(id);
        row.appendChild(title);
        row.appendChild(url);
        out.appendChild(row);
      });
    });
  });

  disableAll.addEventListener('click', () => {
    chrome.runtime.sendMessage({ command: 'disableAll' });
    setMicButtonState(toggleBtn, false);
  });

  // Load Assistant Behavior info
  chrome.runtime.sendMessage({ command: 'getSystemPrompt' }, (resp) => {
    const pre = document.getElementById('sysPrompt');
    if (pre) pre.textContent = resp?.prompt || '';
  });

  // Render Supported Voice Commands from the active tab's command registry
  const table = document.getElementById('cmdTable');
  if (table) {
    chrome.runtime.sendMessage({ command: 'getSupportedCommands' }, (resp) => {
      const rows = resp?.commands || [];
      const tbody = table.querySelector('tbody');
      if (!tbody) return;
      tbody.innerHTML = '';
      rows.forEach((row) => {
        const tr = document.createElement('tr');
        const tdAction = document.createElement('td');
        const tdTriggers = document.createElement('td');
        const tdDesc = document.createElement('td');
        tdAction.textContent = row.action || row.title || row.id || '';
        const triggers = Array.isArray(row.triggers) ? row.triggers : [];
        if (triggers.length === 0) {
          const empty = document.createElement('span');
          empty.className = 'trigger';
          empty.textContent = '(none)';
          tdTriggers.appendChild(empty);
        } else {
          triggers.forEach((t) => {
            const span = document.createElement('span');
            span.className = 'trigger';
            span.textContent = t;
            tdTriggers.appendChild(span);
          });
        }
        tdDesc.textContent = row.description || '';
        tr.appendChild(tdAction);
        tr.appendChild(tdTriggers);
        tr.appendChild(tdDesc);
        tbody.appendChild(tr);
      });
    });
  }
  // Init draggable grid
  setupGridDnD();
});

// --- Draggable Grid (8x8) -------------------------------------------------
function setupGridDnD() {
  const grid = document.getElementById('grid');
  if (!grid) return;
  const orderKey = 'heyNano.admin.gridOrder';

  // Apply saved order
  try {
    const saved = JSON.parse(localStorage.getItem(orderKey) || '[]');
    const byId = new Map([...grid.children].map((el) => [el.id, el]));
    saved.forEach((id) => {
      const el = byId.get(id);
      if (el) grid.appendChild(el);
    });
  } catch {}
  updateWidgetTitles();

  let dragEl = null;
  let dragId = null;
  grid.addEventListener('dragstart', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile) return;
    dragEl = tile;
    dragId = tile.id;
    tile.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragId); } catch {}
  });
  grid.addEventListener('dragend', () => {
    if (dragEl) dragEl.classList.remove('dragging');
    dragEl = null; dragId = null;
    // Save order
    const ids = [...grid.children].map((el) => el.id);
    try { localStorage.setItem(orderKey, JSON.stringify(ids)); } catch {}
    updateWidgetTitles();
  });
  grid.addEventListener('dragover', (e) => {
    e.preventDefault();
    const dragging = grid.querySelector('.tile.dragging');
    if (!dragging) return;
    const before = getDropBeforeElement(grid, e.clientX, e.clientY);
    if (before) {
      grid.insertBefore(dragging, before);
    } else {
      grid.appendChild(dragging);
    }
  });
  grid.addEventListener('drop', (e) => { e.preventDefault(); });
}

// Number tiles in visual order: "WIDGET #N"
function updateWidgetTitles() {
  const grid = document.getElementById('grid');
  if (!grid) return;
  const tiles = [...grid.querySelectorAll('.tile')];
  tiles.forEach((tile, index) => {
    const numberEl = tile.querySelector('.tile-number');
    if (numberEl) numberEl.textContent = `Widget #${index + 1}`;
  });
}

// Determine drop position in grid
function getDropBeforeElement(container, x, y) {
  const els = [...container.querySelectorAll('.tile:not(.dragging)')];
  if (!els.length) return null;
  // Sort elements in visual reading order (top, then left)
  const sorted = els.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    if (Math.abs(ra.top - rb.top) > 8) return ra.top - rb.top;
    return ra.left - rb.left;
  });
  // Find the first element whose center is after the pointer in reading order
  for (const el of sorted) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (y < cy - 4 || (Math.abs(y - cy) <= 12 && x < cx)) {
      return el;
    }
  }
  return null;
}



