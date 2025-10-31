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
  const listBtn = document.getElementById('listTabs');
  const out = document.getElementById('tabsOut');
  const disableAll = document.getElementById('disableAll');

  let target = await getTargetTab();
  if (!target) {
    setMicButtonState(toggleBtn, false);
  } else {
    chrome.runtime.sendMessage({ command: 'getMicState', tabId: target.id }, (res) => {
      setMicButtonState(toggleBtn, !!res?.enabled);
    });
  }


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



