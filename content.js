// Guard against duplicate injection
(function () {
if (window.__heyNanoLoaded) {
  console.log("Hey Nano already loaded.");
  return;
}
window.__heyNanoLoaded = true;

let sttEngine = null;
let recognition = null; // fallback for legacy Web Speech path
let micActive = false;
let session = null;

// Create an LLM session using available browser AI APIs.
// Priority: experimental LanguageModel -> Web AI (window.ai) -> null
async function createLLMSession(systemContent) {
  try {
    // 1) Experimental LanguageModel (as previously used)
    if (typeof window !== 'undefined' && window.LanguageModel && typeof LanguageModel.create === 'function') {
      return await LanguageModel.create({
        outputLanguage: 'en',
        initialPrompts: [
          { role: 'system', content: systemContent }
        ]
      });
    }
  } catch (e) {
    console.warn('LanguageModel.create failed, trying window.ai:', e);
  }

  // 2) Web AI APIs (window.ai). Several shapes exist; normalize to a session with prompt(messages[]).
  try {
    const ai = typeof window !== 'undefined' ? (window.ai || null) : null;
    if (!ai) return null;

    // Helper: wrap a text session that expects a string into a chat-like session
    const wrap = (textSession) => ({
      prompt: async (messages) => {
        const last = Array.isArray(messages) ? messages[messages.length - 1] : { content: String(messages || '') };
        const input = String(last?.content ?? '');
        return await textSession.prompt(input);
      }
    });

    // Newer API shape: ai.languageModel.create({ systemPrompt })
    if (ai.languageModel && typeof ai.languageModel.create === 'function') {
      const textSession = await ai.languageModel.create({ systemPrompt: systemContent, topK: 40 });
      if (textSession && typeof textSession.prompt === 'function') return wrap(textSession);
    }
    // Legacy/alternate: ai.createTextSession({ systemPrompt })
    if (typeof ai.createTextSession === 'function') {
      const textSession = await ai.createTextSession({ systemPrompt: systemContent });
      if (textSession && typeof textSession.prompt === 'function') return wrap(textSession);
    }
  } catch (e) {
    console.warn('window.ai session creation failed:', e);
  }

  return null;
}

// Simple in-page draggable overlay that hosts the user popup via iframe
let overlayEl = null;
let overlayEls = { body: null, assistantMsg: null, assistantMeta: null, youMsg: null, youMeta: null, systemNotice: null };
let dragStart = null;

// HTML/DOM LAYOUT grid overlay
function createDomGridOverlay(opts = {}) {
  try {
    if (document.getElementById('hey-mic-dom-grid')) return;
    const size = Math.max(4, Math.min(100, Number(opts.size) || 16));
    const color = opts.color || 'rgba(0, 136, 255, 0.30)';
    const colorBold = opts.colorBold || 'rgba(0, 136, 255, 0.6)';
    const el = document.createElement('div');
    el.id = 'hey-mic-dom-grid';
    Object.assign(el.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '100vw',
      height: '100vh',
      pointerEvents: 'none',
      zIndex: '2147483642',
      backgroundImage:
        // fine grid
        `repeating-linear-gradient(0deg, ${color} 0, ${color} 1px, transparent 1px, transparent ${size}px),` +
        `repeating-linear-gradient(90deg, ${color} 0, ${color} 1px, transparent 1px, transparent ${size}px),` +
        // bold every 4th line
        `repeating-linear-gradient(0deg, ${colorBold} 0, ${colorBold} 1px, transparent 1px, transparent ${size * 4}px),` +
        `repeating-linear-gradient(90deg, ${colorBold} 0, ${colorBold} 1px, transparent 1px, transparent ${size * 4}px)`,
      backgroundPosition: '0 0, 0 0, 0 0, 0 0',
      backgroundSize: `${size}px ${size}px, ${size}px ${size}px, ${size * 4}px ${size * 4}px, ${size * 4}px ${size * 4}px`,
      backgroundRepeat: 'repeat',
    });
    document.documentElement.appendChild(el);
    try { console.log('Hey Nano: DOM grid enabled', { size, color, colorBold }); } catch {}
  } catch (e) {}
}

function removeDomGridOverlay() {
  try {
    const el = document.getElementById('hey-mic-dom-grid');
    if (el && el.parentNode) el.parentNode.removeChild(el);
    try { console.log('Hey Nano: DOM grid disabled'); } catch {}
  } catch (e) {}
}

// Highlight helpers: add/remove a page-wide style for common elements
function enableDomHighlights() {
  try {
    if (document.getElementById('hey-mic-dom-highlight-style')) return;
    const style = document.createElement('style');
    style.id = 'hey-mic-dom-highlight-style';
    style.type = 'text/css';
    style.textContent = `
      /* Visual highlights for inspection */
      div { outline: 1px solid rgba(0,136,255,0.6) !important; outline-offset: -1px; background-color: rgba(0,136,255,0.08) !important; }
      button, input[type="button"], input[type="submit"], [role="button"], a[role="button"] {
        outline: 2px dashed rgba(0,136,255,0.8) !important;
        background-color: rgba(0,136,255,0.12) !important;
      }
    `;
    document.head.appendChild(style);
    // Log findings similar to a button finder demo
    const divs = document.querySelectorAll('div');
    const buttons = document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"], a[role="button"]');
    console.log('Hey Nano: DOM highlight enabled');
    console.log('Hey Nano: findButtons() ->', Array.from(buttons));
    console.log(`Hey Nano: highlighted ${divs.length} <div> elements and ${buttons.length} button-like elements.`);
  } catch (e) {}
}

function disableDomHighlights() {
  try {
    const style = document.getElementById('hey-mic-dom-highlight-style');
    if (style && style.parentNode) style.parentNode.removeChild(style);
    console.log('Hey Nano: DOM highlight disabled');
  } catch (e) {}
}

// "Lift on hover" virtual spotlight: raise hovered element visually above page
let domLift = {
  enabled: false,
  current: null,
  previewEl: null,
  styleEl: null,
  handler: null,
  scrollHandler: null,
  keyHandler: null,
  bgOn: false,
  panelManualPos: false,
  // Drag state (for element drag interactions)
  dragActive: false,
  dragStart: null,
  // Per-element pinned registry
  pinned: new WeakMap(),
};
let summarizeBtnEl = null; // floating toolbar container
let pinBtnEl = null;
let sumBtnEl = null;
let incBtnEl = null;
let decBtnEl = null;
let scaleLabelEl = null;
let domLiftScaleLocal = 1.15;
let bgBtnEl = null;
let blackPadEl = null;

function ensureDimOverlay() {
  if (document.getElementById('hey-mic-dim')) return;
  const dim = document.createElement('div');
  dim.id = 'hey-mic-dim';
  Object.assign(dim.style, {
    position: 'fixed',
    inset: '0',
    // Uniform dim backdrop (no spotlight hole)
    background: 'rgba(0,0,0,0.55)',
    pointerEvents: 'none',
    zIndex: '2147483644',
    transition: 'opacity 120ms ease',
  });
  document.documentElement.appendChild(dim);
}

function removeDimOverlay() {
  const dim = document.getElementById('hey-mic-dim');
  if (dim && dim.parentNode) dim.parentNode.removeChild(dim);
}

function enableDomLift() {
  if (domLift.enabled) return;
  domLift.enabled = true;
  // Inject CSS for lifted effect
  if (!domLift.styleEl) {
    const st = document.createElement('style');
    st.id = 'hey-mic-dom-lift-style';
    st.type = 'text/css';
    st.textContent = `
      .hey-mic-lifted {
        position: relative !important;
        z-index: 2147483647 !important;
        transform: scale(var(--hey-mic-lift-scale, 1.15)) translateZ(0) !important;
        transform-origin: center center !important;
        box-shadow: 0 28px 84px rgba(0,0,0,0.65), 0 0 0 3px rgba(0,136,255,0.9) !important;
        outline: 3px solid rgba(0,136,255,0.9) !important;
        filter: saturate(1.2) contrast(1.1);
        transition: transform 100ms ease, box-shadow 140ms ease, filter 140ms ease;
      }
      .hey-mic-lifted.hey-mic-fixed {
        position: fixed !important;
      }
      /* When pinned, freeze visual size/position: disable scale to avoid jumps */
      .hey-mic-lifted.hey-mic-pinned {
        transform: none !important;
      }
      .hey-mic-lifted-preview {
        position: relative !important;
        z-index: 2147483645 !important;
        transform: translateZ(0) !important;
        outline: 2px dashed rgba(0,136,255,0.8) !important;
        box-shadow: 0 0 0 2px rgba(0,136,255,0.35) inset !important;
      }
    `;
    document.head.appendChild(st);
    domLift.styleEl = st;
  }
  // Attach hover/move handler
  domLift.handler = (e) => {
    try {
      const t = e.target;
      if (!t || !(t instanceof Element)) return;
      // Keep toolbar aligned and update preview while hovering
      if (domLift.current) updateSummarizeBtn(domLift.current);
      const hoverEl = findLiftTarget(t);
      updatePreview(hoverEl && !isPinned(hoverEl) ? hoverEl : null);
      const el = findLiftTarget(t);
      if (el) applyLiftTo(el);
    } catch {}
  };
  ensureDimOverlay();
  document.addEventListener('mousemove', domLift.handler, true);
  // Track scroll/resize to keep toolbar aligned when a current pinned exists
  domLift.scrollHandler = () => { if (domLift.current && isPinned(domLift.current)) updateSummarizeBtn(domLift.current); };
  const _prev = domLift.scrollHandler;
  domLift.scrollHandler = () => {
    if (domLift.current && isPinned(domLift.current)) {
      try { _prev && _prev(); } catch {}
      try { updateBlackPad(domLift.current); } catch {}
    }
  };
  window.addEventListener('scroll', domLift.scrollHandler, true);
  window.addEventListener('resize', domLift.scrollHandler, true);
  // Keyboard shortcut: Shift+P to toggle Pin/Unpin for the current element
  domLift.keyHandler = (e) => {
    try {
      if (!e) return;
      const key = (e.key || '').toLowerCase();
      if (e.shiftKey && key === 'p') {
        e.preventDefault();
        e.stopPropagation();
        togglePinCurrent();
      }
    } catch {}
  };
  document.addEventListener('keydown', domLift.keyHandler, true);
  try { console.log('Hey Nano: DOM lift enabled (hover to spotlight elements)'); } catch {}
}

function disableDomLift() {
  if (!domLift.enabled) return;
  domLift.enabled = false;
  if (domLift.handler) {
    document.removeEventListener('mousemove', domLift.handler, true);
    domLift.handler = null;
  }
  if (domLift.current && !isPinned(domLift.current)) {
    try { domLift.current.classList.remove('hey-mic-lifted'); } catch {}
  }
  domLift.current = null;
  try { unpinAll(); } catch {}
  // Clear any preview
  try { clearPreview(); } catch {}
  removeDimOverlay();
  if (domLift.scrollHandler) {
    window.removeEventListener('scroll', domLift.scrollHandler, true);
    window.removeEventListener('resize', domLift.scrollHandler, true);
    domLift.scrollHandler = null;
  }
  if (domLift.keyHandler) {
    document.removeEventListener('keydown', domLift.keyHandler, true);
    domLift.keyHandler = null;
  }
  // Keep CSS style to avoid flicker on re-enable; remove only if desired
  try { console.log('Hey Nano: DOM lift disabled'); } catch {}
  hideSummarizeBtn();
  hideBlackPad();
}

function applyLiftTo(el) {
  if (!domLift.enabled) return;
  if (!el || !(el instanceof Element)) return;
  if (domLift.current === el) return;
  // Clear previous
  if (domLift.current && !isPinned(domLift.current)) {
    try { domLift.current.classList.remove('hey-mic-lifted'); } catch {}
  }
  domLift.current = el;
  try { el.classList.add('hey-mic-lifted'); } catch {}
  updateSummarizeBtn(el);
  if (domLift.bgOn) updateBlackPad(el);
}

function findLiftTarget(node) {
  let el = node instanceof Element ? node : null;
  while (el) {
    const id = el.id || '';
    const tag = (el.tagName || '').toLowerCase();
    if (!id.startsWith('hey-mic-') && tag !== 'html' && tag !== 'body') {
      const r = el.getBoundingClientRect();
      const tooBig = r.width >= window.innerWidth * 0.98 && r.height >= window.innerHeight * 0.98;
      if (!tooBig) return el;
    }
    el = el.parentElement;
  }
  return null;
}

// (spotlight positioning removed; using uniform dim instead)

function ensureSummarizeBtn() {
  if (summarizeBtnEl && document.body.contains(summarizeBtnEl)) return summarizeBtnEl;
  const wrap = document.createElement('div');
  wrap.id = 'hey-mic-sum-btn';
  Object.assign(wrap.style, {
    position: 'fixed',
    zIndex: '2147483647',
    pointerEvents: 'auto',
    display: 'flex',
    gap: '6px',
    alignItems: 'center',
    padding: '6px',
    background: '#000',
    color: '#f0f4f8',
    border: '1px solid rgba(0,136,255,0.9)',
    borderRadius: '10px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.45)'
  });
  // Pin/Unpin toggle (per element)
  const pin = document.createElement('button');
  pin.textContent = 'Pin';
  Object.assign(pin.style, {
    cursor: 'pointer', padding: '4px 8px', fontSize: '12px', fontWeight: '700',
    borderRadius: '6px', border: '1px solid #2a8be6', background: '#0e2233', color: '#d6ebff'
  });
  pin.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); togglePinCurrent(); });
  // Summarize button
  const sum = document.createElement('button');
  sum.textContent = 'Summarize this';
  Object.assign(sum.style, {
    cursor: 'pointer', padding: '4px 8px', fontSize: '12px', fontWeight: '700',
    borderRadius: '6px', border: '1px solid #2a8be6', background: '#0e2233', color: '#d6ebff'
  });
  sum.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      const el = domLift.current;
      if (!el) return;
      const text = extractSummarizableText(el);
      if (!text) {
        console.log('Hey Nano: No textual content to summarize for current element.');
        return;
      }
      // Log a user-style event for visibility in the popup
      try {
        chrome.runtime.sendMessage({ event: 'stt', text: 'Summarize selected content', ts: Date.now(), tokens: estimateTokens('Summarize selected content'), chars: 26 });
      } catch {}
      await summarizeTextWithLLM(text);
    } catch (err) {
      console.warn('Hey Nano summarize failed:', err);
    }
  });
  // Decrease / Increase controls (adjust lift scale)
  const dec = document.createElement('button');
  dec.textContent = '−';
  Object.assign(dec.style, {
    cursor: 'pointer', padding: '4px 8px', fontSize: '12px', fontWeight: '700',
    borderRadius: '6px', border: '1px solid #2a8be6', background: '#0e2233', color: '#d6ebff'
  });
  const inc = document.createElement('button');
  inc.textContent = '+';
  Object.assign(inc.style, {
    cursor: 'pointer', padding: '4px 8px', fontSize: '12px', fontWeight: '700',
    borderRadius: '6px', border: '1px solid #2a8be6', background: '#0e2233', color: '#d6ebff'
  });
  const label = document.createElement('span');
  Object.assign(label.style, { color: '#a9d4ff', fontSize: '12px', minWidth: '64px', textAlign: 'center' });
  dec.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); adjustLiftScaleLocal(-0.05); });
  inc.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); adjustLiftScaleLocal(+0.05); });
  const bg = document.createElement('button');
  bg.textContent = 'BG Off';
  Object.assign(bg.style, { cursor: 'pointer', padding: '4px 8px', fontSize: '12px', fontWeight: '700', borderRadius: '6px', border: '1px solid #2a8be6', background: '#0e2233', color: '#d6ebff' });
  bg.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); domLift.bgOn = !domLift.bgOn; bg.textContent = domLift.bgOn ? 'BG On' : 'BG Off'; if (domLift.bgOn && domLift.current) updateBlackPad(domLift.current); else hideBlackPad(); });
  wrap.appendChild(pin);
  wrap.appendChild(sum);
  wrap.appendChild(dec);
  wrap.appendChild(label);
  wrap.appendChild(inc);
  wrap.appendChild(bg);
  document.body.appendChild(wrap);
  summarizeBtnEl = wrap;
  pinBtnEl = pin;
  sumBtnEl = sum;
  incBtnEl = inc;
  decBtnEl = dec;
  scaleLabelEl = label;
  bgBtnEl = bg;
  // Initialize local scale from CSS var if present
  try {
    const val = getComputedStyle(document.documentElement).getPropertyValue('--hey-mic-lift-scale').trim();
    const num = Number(val || '');
    if (!Number.isNaN(num) && num >= 1 && num <= 2.5) domLiftScaleLocal = num;
  } catch {}
  updateScaleLabel();
  // Draggable when current element is pinned: allow dragging the panel to a custom position
  try {
    let dragActive = false;
    let dragStart = { x: 0, y: 0, left: 0, top: 0, parentRect: null };
    const onMouseDown = (e) => {
      // Only draggable when the current element is pinned and not clicking a control
      if (!isPinned(domLift.current)) return;
      if (e.target && e.target.closest('button')) return;
      e.preventDefault();
      const r = wrap.getBoundingClientRect();
      const parent = domLift.current;
      const pr = parent ? parent.getBoundingClientRect() : null;
      dragActive = true;
      if (pr) {
        dragStart = { x: e.clientX, y: e.clientY, left: r.left - pr.left, top: r.top - pr.top, parentRect: pr };
      } else {
        dragStart = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, parentRect: null };
      }
      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('mouseup', onMouseUp, true);
    };
    const onMouseMove = (e) => {
      if (!dragActive) return;
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      const w = wrap.offsetWidth;
      const h = wrap.offsetHeight;
      if (wrap.parentElement === domLift.current && dragStart.parentRect) {
        const pr = dragStart.parentRect;
        const left = Math.max(0, Math.min(pr.width - w, dragStart.left + dx));
        const top = Math.max(0, Math.min(pr.height - h, dragStart.top + dy));
        wrap.style.left = left + 'px';
        wrap.style.top = top + 'px';
        wrap.style.right = 'auto';
        wrap.style.position = 'absolute';
      } else {
        const left = Math.max(0, Math.min(window.innerWidth - w, dragStart.left + dx));
        const top = Math.max(0, Math.min(window.innerHeight - h, dragStart.top + dy));
        wrap.style.left = left + 'px';
        wrap.style.top = top + 'px';
        wrap.style.right = 'auto';
        wrap.style.position = 'fixed';
      }
      domLift.panelManualPos = true;
    };
    const onMouseUp = () => {
      dragActive = false;
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('mouseup', onMouseUp, true);
    };
    wrap.addEventListener('mousedown', onMouseDown);
  } catch {}
  return summarizeBtnEl;
}

function hideSummarizeBtn() {
  if (summarizeBtnEl && summarizeBtnEl.parentNode) {
    summarizeBtnEl.parentNode.removeChild(summarizeBtnEl);
  }
  summarizeBtnEl = null;
}

function updateSummarizeBtn(el) {
  const btn = ensureSummarizeBtn();
  try {
    if (isPinned(el)) {
      // Ensure the panel is rendered inside the pinned element
      attachPanelToPinned(el);
      if (!domLift.panelManualPos) {
        btn.style.position = 'absolute';
        btn.style.right = '8px';
        btn.style.top = '8px';
        btn.style.left = 'auto';
      }
    } else {
      // Ensure the panel is in the body and positioned against the element in viewport coords
      if (btn.parentElement !== document.body) {
        document.body.appendChild(btn);
        btn.style.position = 'fixed';
      }
      if (!domLift.panelManualPos) {
        const r = el.getBoundingClientRect();
        const x = Math.min(window.innerWidth - 200, Math.max(0, r.right - 160));
        const y = Math.max(0, r.top - 44);
        btn.style.left = `${x}px`;
        btn.style.top = `${y}px`;
        btn.style.right = 'auto';
      }
    }
    if (pinBtnEl) pinBtnEl.textContent = isPinned(el) ? 'Unpin' : 'Pin';
    if (bgBtnEl) bgBtnEl.textContent = domLift.bgOn ? 'BG On' : 'BG Off';
  } catch {}
}

function isPinned(el) { return !!(el && domLift.pinned && domLift.pinned.has(el)); }

function togglePinCurrent() {
  const el = domLift.current;
  if (!el) return;
  if (isPinned(el)) {
    unpinElement(el);
  } else {
    pinElement(el);
  }
  if (pinBtnEl) pinBtnEl.textContent = isPinned(el) ? 'Unpin' : 'Pin';
  updateSummarizeBtn(el);
  try { console.log('Hey Nano: DOM lift', isPinned(el) ? 'pinned' : 'unpinned'); } catch {}
}

function pinElement(el) {
  try {
    if (!el) return;
    if (!domLift.pinned) domLift.pinned = new WeakMap();
    if (domLift.pinned.has(el)) return; // already pinned
    const savedStyle = snapshotInlineStyle(el);
    // Keep element in-flow; ensure it can host an absolute child panel.
    try {
      const cs = getComputedStyle(el);
      if (cs && cs.position === 'static') {
        el.dataset._heyNanoPrevPos = el.style.position || '';
        el.style.position = 'relative';
      }
    } catch {}
    try { el.classList.add('hey-mic-lifted'); } catch {}
    try { el.classList.add('hey-mic-pinned'); } catch {}
    domLift.pinned.set(el, { savedStyle });
    // Place the control panel inside the pinned element
    try { attachPanelToPinned(el); domLift.panelManualPos = false; } catch {}
  } catch {}
}

function unpinElement(el) {
  try {
    if (!el) return;
    const meta = domLift.pinned ? domLift.pinned.get(el) : null;
    // Restore element inline position if changed
    try {
      if (el.dataset && Object.prototype.hasOwnProperty.call(el.dataset, '_heyNanoPrevPos')) {
        el.style.position = el.dataset._heyNanoPrevPos || '';
        delete el.dataset._heyNanoPrevPos;
      }
    } catch {}
    restoreElementPositioning(el, meta && meta.savedStyle);
    try { el.classList.remove('hey-mic-pinned'); } catch {}
    if (domLift.current !== el) {
      try { el.classList.remove('hey-mic-lifted'); } catch {}
    }
    if (domLift.pinned) domLift.pinned.delete(el);
    // Detach the panel back to body and reset manual position state
    try { detachPanelFromPinned(el); } catch {}
  } catch {}
}

function unpinAll() {
  try {
    // WeakMap is not iterable; track via query for elements with our marker class
    document.querySelectorAll('.hey-mic-lifted.hey-mic-fixed').forEach((el) => {
      try { unpinElement(el); } catch {}
    });
  } catch {}
}

function updatePreview(el) {
  try {
    if (el === domLift.current) {
      // Do not show preview for the pinned element
      if (domLift.previewEl && domLift.previewEl !== domLift.current) {
        try { domLift.previewEl.classList.remove('hey-mic-lifted-preview'); } catch {}
      }
      domLift.previewEl = null;
      return;
    }
    if (domLift.previewEl === el) return;
    if (domLift.previewEl) {
      try { domLift.previewEl.classList.remove('hey-mic-lifted-preview'); } catch {}
    }
    domLift.previewEl = el || null;
    if (domLift.previewEl) {
      try { domLift.previewEl.classList.add('hey-mic-lifted-preview'); } catch {}
    }
  } catch {}
}

function clearPreview() {
  if (domLift.previewEl) {
    try { domLift.previewEl.classList.remove('hey-mic-lifted-preview'); } catch {}
  }
  domLift.previewEl = null;
}

function snapshotInlineStyle(el) {
  return {
    position: el.style.position || '',
    left: el.style.left || '',
    top: el.style.top || '',
    width: el.style.width || '',
    height: el.style.height || '',
    right: el.style.right || '',
    bottom: el.style.bottom || '',
    maxWidth: el.style.maxWidth || '',
    maxHeight: el.style.maxHeight || '',
  };
}

function attachPanelToPinned(el) {
  const btn = ensureSummarizeBtn();
  if (btn.parentElement !== el) {
    el.appendChild(btn);
  }
  btn.style.position = 'absolute';
  btn.style.zIndex = '2147483648';
}

function detachPanelFromPinned(el) {
  if (!summarizeBtnEl) return;
  if (summarizeBtnEl.parentElement === el) {
    document.body.appendChild(summarizeBtnEl);
    summarizeBtnEl.style.position = 'fixed';
    domLift.panelManualPos = false;
  }
}

function applyFixedPositioning(el) {
  try {
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.classList.add('hey-mic-fixed');
    el.style.left = Math.max(0, r.left) + 'px';
    el.style.top = Math.max(0, r.top) + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.width = Math.max(20, Math.min(window.innerWidth, r.width)) + 'px';
    el.style.height = Math.max(20, Math.min(window.innerHeight, r.height)) + 'px';
  } catch {}
}

function restoreElementPositioning(el, saved) {
  try {
    if (!el) return;
    el.classList.remove('hey-mic-fixed');
    const s = saved || {};
    el.style.position = s.position || '';
    el.style.left = s.left || '';
    el.style.top = s.top || '';
    el.style.right = s.right || '';
    el.style.bottom = s.bottom || '';
    el.style.width = s.width || '';
    el.style.height = s.height || '';
    el.style.maxWidth = s.maxWidth || '';
    el.style.maxHeight = s.maxHeight || '';
  } catch {}
}

function enableElementDrag(el) {
  if (!el) return;
  const onDown = (e) => {
    if (!isPinned(el)) return;
    // Avoid starting drag from interactive controls inside the element
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    if (['input','textarea','button','select','a','label'].includes(tag)) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const r = el.getBoundingClientRect();
      domLift.dragActive = true;
      domLift.dragStart = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    } catch {}
  };
  const onMove = (e) => {
    if (!domLift.dragActive) return;
    try {
      const dx = e.clientX - domLift.dragStart.x;
      const dy = e.clientY - domLift.dragStart.y;
      const left = Math.max(0, Math.min(window.innerWidth - 10, domLift.dragStart.left + dx));
      const top = Math.max(0, Math.min(window.innerHeight - 10, domLift.dragStart.top + dy));
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      // keep panel aligned if not manually moved
      if (!domLift.panelManualPos) {
        try { updateSummarizeBtn(el); } catch {}
      }
    } catch {}
  };
  const onUp = () => {
    domLift.dragActive = false;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
  };
  try {
    // Ensure fixed positioning is applied
    applyFixedPositioning(el);
    el.addEventListener('mousedown', onDown, true);
    // Store handlers for cleanup
    el.__heyNanoDragHandlers = { onDown, onMove, onUp };
  } catch {}
}

function disableElementDrag(el) {
  if (!el) return;
  try {
    domLift.dragActive = false;
    const h = el.__heyNanoDragHandlers || {};
    if (h.onDown) el.removeEventListener('mousedown', h.onDown, true);
    document.removeEventListener('mousemove', h.onMove, true);
    document.removeEventListener('mouseup', h.onUp, true);
    delete el.__heyNanoDragHandlers;
  } catch {}
}

function updateScaleLabel() {
  if (!scaleLabelEl) return;
  const pct = Math.round((domLiftScaleLocal - 1) * 100);
  scaleLabelEl.textContent = `Lift: ${pct}%`;
}

function setLiftScaleLocal(v) {
  domLiftScaleLocal = Math.max(1.0, Math.min(2.5, Number(v) || 1.15));
  try {
    document.documentElement.style.setProperty('--hey-mic-lift-scale', String(domLiftScaleLocal));
    console.log('Hey Nano: DOM lift scale set (local)', domLiftScaleLocal);
  } catch {}
  updateScaleLabel();
}

function adjustLiftScaleLocal(delta) {
  setLiftScaleLocal(domLiftScaleLocal + delta);
}

function ensureBlackPad() {
  if (blackPadEl && document.body.contains(blackPadEl)) return blackPadEl;
  const pad = document.createElement('div');
  pad.id = 'hey-mic-blackpad';
  Object.assign(pad.style, { position: 'fixed', zIndex: '2147483646', background: 'rgba(0,0,0,0.95)', borderRadius: '10px', pointerEvents: 'none' });
  document.body.appendChild(pad);
  blackPadEl = pad;
  return blackPadEl;
}

function updateBlackPad(el) {
  if (!domLift.bgOn) return;
  const pad = ensureBlackPad();
  try {
    const r = el.getBoundingClientRect();
    const padPx = 8;
    pad.style.left = `${Math.max(0, r.left - padPx)}px`;
    pad.style.top = `${Math.max(0, r.top - padPx)}px`;
    pad.style.width = `${Math.min(window.innerWidth, r.width + padPx * 2)}px`;
    pad.style.height = `${Math.min(window.innerHeight, r.height + padPx * 2)}px`;
  } catch {}
}

function hideBlackPad() {
  if (blackPadEl && blackPadEl.parentNode) blackPadEl.parentNode.removeChild(blackPadEl);
  blackPadEl = null;
}

const layoutPlayground = {
  enabled: false,
  // text scrambling
  nodes: new Set(),
  originals: new WeakMap(),
  // DOM shuffling
  domOrder: new WeakMap(), // Element -> original children array snapshot
  domContainers: new Set(),
};

function isEligibleTextNode(node) {
  try {
    if (!node || node.nodeType !== Node.TEXT_NODE) return false;
    const s = String(node.nodeValue || '');
    if (!s.trim()) return false;
    const p = node.parentElement;
    if (!p) return false;
    const tag = (p.tagName || '').toLowerCase();
    if (['script','style','noscript','title','meta','link','iframe','canvas','svg','path'].includes(tag)) return false;
    return true;
  } catch { return false; }
}

function scrambleWord(w) {
  const arr = w.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join('');
}

function scrambleText(s) {
  // Scramble alphanum tokens, preserve whitespace/punct
  return String(s).replace(/[A-Za-z0-9]{3,}/g, (m) => scrambleWord(m));
}

function scrambleAllText(root) {
  try {
    const walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      if (!isEligibleTextNode(node)) continue;
      const original = node.nodeValue || '';
      if (!layoutPlayground.originals.has(node)) {
        layoutPlayground.originals.set(node, original);
        layoutPlayground.nodes.add(node);
      }
      node.nodeValue = scrambleText(original);
    }
  } catch {}
}

function restoreAllText() {
  try {
    layoutPlayground.nodes.forEach((node) => {
      const original = layoutPlayground.originals.get(node);
      if (typeof original === 'string') node.nodeValue = original;
    });
  } catch {}
  layoutPlayground.nodes.clear();
  layoutPlayground.originals = new WeakMap();
}

function enableLayoutShuffle({ scrambleText: includeText = false } = {}) {
  layoutPlayground.enabled = true;
  try {
    if (includeText) scrambleAllText(document.body);
    // Allow repeated shuffles while enabled; each call snapshots fresh order.
    shuffleDom(document.body);
  } catch (e) {
    console.warn('Hey Nano: layout shuffle enable failed:', e);
  }
}

function disableLayoutShuffle({ restoreText: restoreTextContent = true } = {}) {
  try {
    // Only restore layout; text was not scrambled unless requested
    restoreDom();
    if (restoreTextContent) restoreAllText();
  } catch (e) {
    console.warn('Hey Nano: layout shuffle disable failed:', e);
  } finally {
    layoutPlayground.enabled = false;
  }
}

// ---- DOM shuffle/restore (design mode) ----
const SHUFFLE_CONTAINER_TAGS = ['div','section','article','main','aside','nav','header','footer','ul','ol','menu','form'];

function isShufflableContainerEl(el) {
  try {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'link' || tag === 'meta' || tag === 'head' || tag === 'title') return false;
    return tag === 'body' || SHUFFLE_CONTAINER_TAGS.includes(tag);
  } catch { return false; }
}

function getShuffleContainers(root) {
  const list = [];
  try {
    const body = (root || document.body);
    if (!body) return list;
    if (isShufflableContainerEl(body)) list.push(body);
    const q = SHUFFLE_CONTAINER_TAGS.join(',');
    body.querySelectorAll(q).forEach(el => { if (isShufflableContainerEl(el)) list.push(el); });
  } catch {}
  return list;
}

function shuffleArrayCopy(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function shuffleDom(root) {
  try {
    const containers = getShuffleContainers(root);
    containers.forEach((el) => {
      const kids = Array.from(el.children);
      if (kids.length < 2) return;
      if (!layoutPlayground.domOrder.has(el)) {
        layoutPlayground.domOrder.set(el, kids.slice());
        layoutPlayground.domContainers.add(el);
      }
      const shuffled = shuffleArrayCopy(kids);
      shuffled.forEach((child) => el.appendChild(child));
    });
  } catch {}
}

function restoreDom() {
  try {
    layoutPlayground.domContainers.forEach((el) => {
      const original = layoutPlayground.domOrder.get(el);
      if (!original || !original.length) return;
      original.forEach((child) => {
        if (!child) return;
        try { el.appendChild(child); } catch {}
      });
    });
  } catch {}
  layoutPlayground.domContainers.clear();
  layoutPlayground.domOrder = new WeakMap();
}

function extractSummarizableText(el, maxLen = 4000) {
  try {
    let text = '';
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'img') {
      const alt = el.getAttribute('alt') || '';
      const title = el.getAttribute('title') || '';
      const src = el.getAttribute('src') || '';
      text = `Image: alt="${alt}" title="${title}" src="${src}"`;
    } else {
      text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    }
    if (text.length > maxLen) text = text.slice(0, maxLen) + ' ...';
    return text;
  } catch { return ''; }
}

async function summarizeTextWithLLM(text) {
  try {
    if (!session) await initLLM();
    if (!session) {
      console.warn('LLM not available to summarize.');
      return;
    }
    const prompt = `Summarize the following content succinctly in English. Use short bullet points when helpful.\n\nContent:\n"""\n${text}\n"""`;
    const result = await session.prompt([{ role: 'user', content: prompt }]);
    const summary = String(result || '').trim();
    console.log('Hey Nano: Summary ->', summary);
    try {
      chrome.runtime.sendMessage({ event: 'llm', text: summary, ts: Date.now(), tokens: estimateTokens(summary), chars: summary.length });
    } catch {}
  } catch (e) {
    console.warn('Summarize prompt failed:', e);
  }
}

function collectLayoutSnapshot(maxChildren = 40) {
  const info = [];
  try {
    const body = document.body;
    if (!body) return 'No body';

    // Viewport + scroll
    const vw = Math.round(window.innerWidth);
    const vh = Math.round(window.innerHeight);
    const sy = Math.round(window.scrollY || 0);
    info.push(`Viewport: ${vw}x${vh} scrollY=${sy}`);

    // Landmarks presence
    const landmarks = ['header','nav','main','aside','footer']
      .map(sel => ({ sel, present: !!document.querySelector(sel) }))
      .filter(x => x.present)
      .map(x => x.sel)
      .join(', ');
    if (landmarks) info.push(`Landmarks: ${landmarks}`);

    // Body children order (tags) and columns estimation
    const children = Array.from(body.children).slice(0, maxChildren);
    const order = children.map(el => (el.tagName || '').toLowerCase());
    info.push(`Body children (first ${Math.min(maxChildren, order.length)}): ${order.join(' > ')}`);

    // Estimate columns by grouping by left position bins
    const rects = children.map(el => ({ el, r: el.getBoundingClientRect() })).filter(x => x.r && x.r.width > 8 && x.r.height > 8);
    rects.sort((a,b) => a.r.left - b.r.left);
    const cols = [];
    const threshold = Math.max(24, vw * 0.04); // ~4% viewport or 24px
    rects.forEach(item => {
      const left = item.r.left;
      const found = cols.find(c => Math.abs(c.left - left) < threshold);
      if (found) {
        found.items.push(item);
        found.left = (found.left * (found.items.length - 1) + left) / found.items.length;
      } else {
        cols.push({ left, items: [item] });
      }
    });
    if (cols.length) info.push(`Estimated columns: ${cols.length} [counts: ${cols.map(c => c.items.length).join(', ')}]`);

    // Display mode hints for top container(s)
    const displays = [];
    children.slice(0, 6).forEach(el => {
      try {
        const d = getComputedStyle(el).display;
        if (d && (d.includes('grid') || d.includes('flex') || d === 'block')) {
          displays.push(`${(el.tagName || '').toLowerCase()}:${d}`);
        }
      } catch {}
    });
    if (displays.length) info.push(`Top displays: ${displays.join(', ')}`);

    // Tag counts (top N)
    const counts = new Map();
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT, null);
    let node;
    while ((node = walker.nextNode())) {
      const tag = (node.tagName || '').toLowerCase();
      if (!tag) continue;
      if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    const topCounts = Array.from(counts.entries())
      .sort((a,b)=>b[1]-a[1])
      .slice(0, 15)
      .map(([t,c])=>`${t}:${c}`)
      .join(', ');
    if (topCounts) info.push(`Tag counts (top): ${topCounts}`);

    // Headings snapshot
    const headings = Array.from(document.querySelectorAll('h1,h2,h3')).map(h=>h.textContent.trim()).filter(Boolean).slice(0,8);
    if (headings.length) info.push(`Headings: ${headings.join(' | ')}`);

    // Top blocks snapshot (position/size/text density)
    const blocks = rects.slice(0, 10).map(({ el, r }) => {
      const tag = (el.tagName || '').toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const cls = (el.className && typeof el.className === 'string') ? ('.' + el.className.trim().split(/\s+/).slice(0,2).join('.')) : '';
      const w = Math.round(r.width), h = Math.round(r.height);
      const x = Math.round(r.left), y = Math.round(r.top);
      let textLen = 0; try { textLen = (el.innerText || '').replace(/\s+/g,' ').trim().length; } catch {}
      const area = Math.max(1, w * h);
      const density = (textLen / area).toFixed(4);
      return `${tag}${id}${cls} @(${x},${y}) ${w}x${h} text=${textLen} density=${density}`;
    });
    if (blocks.length) info.push('Top blocks:\n- ' + blocks.join('\n- '));
  } catch (e) { info.push('Snapshot error'); }
  return info.join('\n');
}

async function askLayoutOpinion() {
  try {
    if (!session) await initLLM();
    if (!session) {
      console.warn('LLM not available to assess layout.');
      return;
    }
    const snapshot = collectLayoutSnapshot();
    const prompt = [
      'You are a UI/UX design assistant. The page layout has been shuffled to explore alternatives.',
      'Given this DOM snapshot, provide concise design feedback and 3 improvement ideas.',
      'Focus on structure, hierarchy, grouping, and readability. Be specific but brief.',
      '',
      snapshot
    ].join('\n');
    const result = await session.prompt([{ role: 'user', content: prompt }]);
    const opinion = String(result || '').trim();
    console.log('Hey Nano: Layout opinion ->', opinion);
    try {
      chrome.runtime.sendMessage({ event: 'llm', text: opinion, ts: Date.now(), tokens: estimateTokens(opinion), chars: opinion.length });
    } catch {}
  } catch (e) {
    console.warn('Layout opinion failed:', e);
  }
}

function extractJsonFromText(text) {
  try {
    // Try direct JSON first
    return JSON.parse(text);
  } catch {}
  try {
    // Extract the first JSON object block
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  } catch {}
  return null;
}

function applyCssImprovements(cssText) {
  try {
    let style = document.getElementById('hey-mic-improve-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'hey-mic-improve-style';
      style.type = 'text/css';
      document.head.appendChild(style);
    }
    style.textContent = String(cssText || '');
  } catch (e) { console.warn('Apply CSS failed:', e); }
}

async function applyLayoutImprovements() {
  try {
    if (!session) await initLLM();
    if (!session) {
      console.warn('LLM not available to improve layout.');
      return;
    }
    const snapshot = collectLayoutSnapshot();
    const instruction = [
      'You are a UI/UX design assistant. Propose CSS-only improvements for the current page layout.',
      'Return STRICT JSON with the following shape only:',
      '{"css": "/* plain CSS rules here that improve spacing, hierarchy, readability. Avoid resets. */"}',
      'Do not include markdown fences. Keep CSS small (<= 60 lines). Prefer non-destructive rules (margins, gaps, line-height, font-size for headings, display:flex/grid with simple gaps).',
      'Avoid hard selectors that break functionality. Prefer broad selectors like main, section, article, nav, header, footer, h1/h2/h3, p, ul, li.',
      'Do NOT change colors. Focus on spacing and layout only.',
      '',
      snapshot
    ].join('\n');
    const result = await session.prompt([{ role: 'user', content: instruction }]);
    const text = String(result || '').trim();
    const json = extractJsonFromText(text) || { css: '' };
    const css = String(json.css || '').trim();
    if (css) {
      applyCssImprovements(css);
      const msg = 'Applied AI CSS improvements (' + css.length + ' chars).';
      console.log('Hey Nano:', msg); 
      try { chrome.runtime.sendMessage({ event: 'llm', text: msg, ts: Date.now(), tokens: estimateTokens(msg), chars: msg.length }); } catch {}
    } else {
      console.warn('No CSS provided by LLM.');
      try { chrome.runtime.sendMessage({ event: 'llm', text: 'No CSS improvements were returned by the AI.', ts: Date.now(), tokens: 0, chars: 0 }); } catch {}
    }
  } catch (e) {
    console.warn('applyLayoutImprovements failed:', e);
  }
}

function revertLayoutImprovements() {
  try {
    const style = document.getElementById('hey-mic-improve-style');
    if (style && style.parentNode) style.parentNode.removeChild(style);
    const msg = 'Reverted AI CSS improvements.';
    console.log('Hey Nano:', msg);
    try { chrome.runtime.sendMessage({ event: 'llm', text: msg, ts: Date.now(), tokens: estimateTokens(msg), chars: msg.length }); } catch {}
  } catch (e) {
    console.warn('revertLayoutImprovements failed:', e);
  }
}

function getActiveTargetTab() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ command: 'getActiveTargetTab' }, (resp) => resolve(resp?.tab || null));
    } catch {
      resolve(null);
    }
  });
}

function overlayUpdateAssistant(text, tokens, chars) { /* overlay disabled */ }
function overlayUpdateYou(text, tokens, chars) { /* overlay disabled */ }
function overlayNotifySystem(text) { /* overlay disabled */ }

async function hydrateOverlayFromLog() { /* overlay disabled */ }

function ensureOverlay() {
  if (overlayEl && document.body.contains(overlayEl)) return overlayEl;
  const root = document.createElement('div');
  root.id = 'hey-mic-overlay';
  Object.assign(root.style, {
    position: 'fixed',
    top: '50px',
    right: '50px',
    width: '300px',
    backgroundColor: '#fff',
    border: '1px solid #ccc',
    borderRadius: '12px',
    boxShadow: '0 5px 15px rgba(0,0,0,0.3)',
    zIndex: '2147483647',
    overflow: 'hidden',
    color: '#111',
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
  });

  const header = document.createElement('div');
  header.id = 'hey-mic-overlay-drag';
  Object.assign(header.style, {
    backgroundColor: '#f5f5f5',
    padding: '10px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    cursor: 'move',
    userSelect: 'none'
  });
  const leftIcon = document.createElement('span');
  leftIcon.className = 'icon';
  leftIcon.textContent = '\u2630'; // ☰
  Object.assign(leftIcon.style, { fontSize: '18px', padding: '0 6px' });
  const rightCtrls = document.createElement('div');
  const btnMax = document.createElement('span');
  btnMax.id = 'maximize';
  btnMax.title = 'Maximize';
  btnMax.textContent = '\u25FB'; // ▫/▢ like
  Object.assign(btnMax.style, { fontSize: '18px', padding: '0 6px', cursor: 'pointer', userSelect: 'none' });
  const btnClose = document.createElement('span');
  btnClose.id = 'close';
  btnClose.title = 'Close';
  btnClose.textContent = '\u00D7'; // ×
  Object.assign(btnClose.style, { fontSize: '18px', padding: '0 6px', cursor: 'pointer', userSelect: 'none' });
  rightCtrls.appendChild(btnMax);
  rightCtrls.appendChild(btnClose);
  header.appendChild(leftIcon);
  header.appendChild(rightCtrls);

  const panel = document.createElement('div');
  Object.assign(panel.style, { padding: '12px' });
  // System notice
  const sys = document.createElement('div');
  sys.id = 'system-notice';
  Object.assign(sys.style, { display: 'none', marginBottom: '8px', fontSize: '12px', color: '#444' });
  panel.appendChild(sys);
  // Assistant section
  const secA = document.createElement('div');
  secA.className = 'section';
  const secATitle = document.createElement('div'); secATitle.textContent = 'Assistant:'; secATitle.style.fontWeight = 'bold'; secATitle.style.marginBottom = '4px';
  const secAMeta = document.createElement('div'); Object.assign(secAMeta.style, { fontSize: '11px', color: '#666', marginBottom: '4px' });
  const secAMsg = document.createElement('div'); secAMsg.id = 'assistant-msg';
  secA.appendChild(secATitle); secA.appendChild(secAMeta); secA.appendChild(secAMsg);
  // You section
  const secY = document.createElement('div');
  secY.className = 'section';
  const secYTitle = document.createElement('div'); secYTitle.textContent = 'You:'; secYTitle.style.fontWeight = 'bold'; secYTitle.style.marginBottom = '4px';
  const secYMeta = document.createElement('div'); Object.assign(secYMeta.style, { fontSize: '11px', color: '#666', marginBottom: '4px' });
  const secYMsg = document.createElement('div'); secYMsg.id = 'user-msg';
  secY.appendChild(secYTitle); secY.appendChild(secYMeta); secY.appendChild(secYMsg);
  panel.appendChild(secA);
  panel.appendChild(secY);
  overlayEls = { body: panel, assistantMsg: secAMsg, assistantMeta: secAMeta, youMsg: secYMsg, youMeta: secYMeta, systemNotice: sys };

  // Drag logic
  header.addEventListener('mousedown', (e) => {
    // Only start drag if not clicking right controls
    if (e.target === btnClose || e.target === btnMax) return;
    e.preventDefault();
    const rect = root.getBoundingClientRect();
    dragStart = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
    const onMove = (ev) => {
      if (!dragStart) return;
      const dx = ev.clientX - dragStart.x;
      const dy = ev.clientY - dragStart.y;
      const w = root.offsetWidth; const h = root.offsetHeight;
      const left = Math.max(0, Math.min(window.innerWidth - w, dragStart.left + dx));
      const top = Math.max(0, Math.min(window.innerHeight - h, dragStart.top + dy));
      root.style.left = left + 'px';
      root.style.top = top + 'px';
      root.style.right = 'auto';
    };
    const onUp = () => {
      dragStart = null;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
  });

  // Close button
  btnClose.addEventListener('click', () => {
    root.style.display = 'none';
  });

  // Maximize toggle
  let maximized = false;
  btnMax.addEventListener('click', () => {
    if (!maximized) {
      root.style.width = '100vw';
      root.style.height = '100vh';
      root.style.top = '0';
      root.style.right = '0';
      root.style.left = 'auto';
      root.style.borderRadius = '0';
      maximized = true;
    } else {
      root.style.width = '300px';
      root.style.height = 'auto';
      root.style.top = '50px';
      root.style.right = '50px';
      root.style.left = 'auto';
      root.style.borderRadius = '12px';
      maximized = false;
    }
  });

  root.appendChild(header);
  root.appendChild(panel);
  document.body.appendChild(root);
  overlayEl = root;
  hydrateOverlayFromLog();
  return overlayEl;
}

function estimateTokens(s) {
  const text = (s || "").toString();
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

// Initialize the local LLM session if available (compact)
async function initLLM() {
  if (session) return;
  try {
    // Build a snapshot of supported voice commands (title + description) once per session
    let cmdList = "";
    try {
      const reg = (window.HeyNanoCommands && window.HeyNanoCommands.getCommandRegistry)
        ? window.HeyNanoCommands.getCommandRegistry()
        : [];
      cmdList = (reg || [])
        .map((c) => `- ${c.title}: ${c.description}`)
        .join("\n");
    } catch {}

    const systemContent = [
      "You are a helpful assistant embedded in a browser extension that supports voice commands.",
      "Respond in English by default.",
      "When asked about your capabilities, mention both your language abilities (summarize, generate text, explain) and that the extension can execute certain browser actions via supported voice commands.",
      "Supported voice commands (executed by the extension when the user's speech matches):",
      cmdList || "- List tabs\n- Switch to tab N\n- Open a specific URL or well-known site\n- Stop listening",
      "Navigation policy: Only ask 'Which site should I open?' when the user utterance includes a navigation verb (open/go to/navigate to/visit) but lacks a specific target.",
      "Only confirm opening a website when the user includes a specific URL or a well-known site name.",
      "Never claim you cannot open external websites; the extension performs actions when voice commands match.",
      "Do not fabricate actions."
    ].join("\n");

    session = await createLLMSession(systemContent);
    if (session) console.log('LLM ready.');
    else console.warn('LLM unavailable: no supported browser AI API found.');
  } catch (e) {
    console.warn("LLM initialization failed:", e);
  }
}

// Send voice input to the LLM and log the response
async function sendToLLM(userInput) {
  if (!session) {
    console.warn("LLM not available.");
    return;
  }
  // Provide page context (the system prompt already describes voice commands once per session)
  const contextPrompt = `You are on the webpage titled "${document.title}" at URL: ${location.href}.\nPage content: ${getPageText()}\nUser says: ${userInput}`;
  try {
    const result = await session.prompt([{ role: "user", content: contextPrompt }]);
    let text = (result || "").trim();
    const askedNav = /\b(open|go to|navigate to|visit)\b/i.test(userInput);
    if (!askedNav) {
      text = text
        .replace(/\bwhich (?:site|website|url) should i open\??/gi, "")
        .replace(/\bwhat (?:site|website|url) should i open\??/gi, "")
        .trim();
    }
    console.log("Assistant:", text);
    try {
      chrome.runtime.sendMessage({
        event: 'llm',
        text,
        ts: Date.now(),
        tokens: estimateTokens(text),
        chars: text.length
      });
    } catch (e) {}
    // Note: Opening tabs is driven ONLY by explicit user speech parsing.
  } catch (e) {
    console.error("LLM prompt failed:", e);
  }
}

// Get visible text from the page (compact)
function getPageText(maxLength = 5000) {
  const t = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
  return t.length > maxLength ? t.slice(0, maxLength) + " ..." : t;
}

// Get reference to command helpers
function Commands() { return window.HeyNanoCommands || {}; }

function startMic() {
  if (micActive) return;
  // Prefer adapter-based STT if available
  try {
    if (window.HeyNanoSpeech && typeof window.HeyNanoSpeech.createSTT === 'function') {
      sttEngine = window.HeyNanoSpeech.createSTT({ provider: 'web-speech', lang: 'en-US', continuous: true, interimResults: false });
      if (sttEngine) {
        micActive = true;
        console.log("Mic enabled. Speak...");
        try { chrome.runtime.sendMessage({ event: 'system', type: 'mic', state: 'enabled', ts: Date.now() }); } catch (e) {}
        sttEngine.start({
          onResult: async (rawTranscript) => {
            let transcript = String(rawTranscript || '').trim();
            console.log("You said:", transcript);
        try {
          chrome.runtime.sendMessage({
            event: 'stt',
            text: transcript,
            ts: Date.now(),
            tokens: estimateTokens(transcript),
            chars: transcript.length
          });
        } catch (e) {}
        const C = Commands();
            transcript = C.normalizeTabCommand ? C.normalizeTabCommand(transcript) : transcript;

            // Registry-based command dispatch (early exit if handled)
            try {
              const ctx = {
                stopMic,
                sendMessage: (payload, cb) => chrome.runtime.sendMessage(payload, cb),
              };
              const registry = C.getCommandRegistry ? C.getCommandRegistry(ctx) : [];
              for (const cmd of registry) {
                const m = cmd.match ? cmd.match(transcript) : null;
                if (m) {
                  await (cmd.execute ? cmd.execute({ match: m, transcript }) : null);
                  return; // handled
                }
              }
            } catch (err) {
              console.warn('Registry dispatch error:', err);
            }

      // Stop intent (robust fallback if helper missing)
      if (C.isStopCommand ? C.isStopCommand(transcript)
        : (/^stop$/i.test(transcript) || /\b(stop|turn off|disable)\b.*\b(mic|microphone|listening|recording|recognition)\b/i.test(transcript))) {
        stopMic();
        return;
      }

            // List tabs on demand
            if (C.isListTabs ? C.isListTabs(transcript) : /list (all )?tabs/i.test(transcript)) {
              chrome.runtime.sendMessage({ command: "listTabs" }, (response) => {
                const tabs = response?.tabs || [];
                console.log("Open tabs:");
                tabs.forEach((tab, idx) =>
                  console.log(`#${idx + 1}: ${tab.title} (${tab.url}) [tabId: ${tab.id}]`)
                );
              });
              return;
            }

            // Switch to Nth tab (1-based) using on-demand list
            const index = C.getSwitchTabIndex ? C.getSwitchTabIndex(transcript) : -1;
            if (index >= 0) {
              chrome.runtime.sendMessage({ command: "listTabs" }, (response) => {
                const tabs = response?.tabs || [];
                const t = tabs[index];
                if (t && typeof t.id === "number") chrome.runtime.sendMessage({ command: "switchTab", tabId: t.id });
                else console.warn("No tab at that index.");
              });
              return;
            }

            // Direct open-website intent (don’t rely on LLM echo)
            const directUrl = C.extractUrlFromSpeech ? C.extractUrlFromSpeech(transcript) : null;
            if (directUrl) {
              chrome.runtime.sendMessage({ command: "openTab", url: directUrl });
              console.log("Assistant:", `Opening ${directUrl} now.`);
              return;
            }

            if (session || (typeof window !== 'undefined' && (window.LanguageModel || window.ai))) {
              await sendToLLM(transcript);
            }
          }
        });
        return; // adapter path engaged
      }
    }
  } catch (e) {
    console.warn('Adapter STT path failed, falling back:', e);
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return console.warn("Web Speech API not supported.");
  const rec = new SR();
  rec.lang = "en-US";
  rec.continuous = true;
  rec.interimResults = false;
  recognition = rec;
  micActive = true;
  console.log("Mic enabled. Speak...");
  try { chrome.runtime.sendMessage({ event: 'system', type: 'mic', state: 'enabled', ts: Date.now(), source: 'startMic' }); } catch (e) {}

  rec.onresult = async (e) => {
    let transcript = e.results[e.resultIndex][0].transcript.trim();
    console.log("You said:", transcript);
    try {
      chrome.runtime.sendMessage({
        event: 'stt',
        text: transcript,
        ts: Date.now(),
        tokens: estimateTokens(transcript),
        chars: transcript.length
      });
    } catch (e) {}
    const C = Commands();
    transcript = C.normalizeTabCommand ? C.normalizeTabCommand(transcript) : transcript;

    // Registry-based command dispatch (early exit if handled)
    try {
      const ctx = {
        stopMic,
        sendMessage: (payload, cb) => chrome.runtime.sendMessage(payload, cb),
      };
      const registry = C.getCommandRegistry ? C.getCommandRegistry(ctx) : [];
      for (const cmd of registry) {
        const m = cmd.match ? cmd.match(transcript) : null;
        if (m) {
          await (cmd.execute ? cmd.execute({ match: m, transcript }) : null);
          return; // handled
        }
      }
    } catch (err) {
      console.warn('Registry dispatch error:', err);
    }

    // Stop intent (robust fallback if helper missing)
    if (C.isStopCommand ? C.isStopCommand(transcript)
      : (/^stop$/i.test(transcript) || /\b(stop|turn off|disable)\b.*\b(mic|microphone|listening|recording|recognition)\b/i.test(transcript))) {
      stopMic();
      return;
    }

    // List tabs on demand
    if (C.isListTabs ? C.isListTabs(transcript) : /list (all )?tabs/i.test(transcript)) {
      chrome.runtime.sendMessage({ command: "listTabs" }, (response) => {
        const tabs = response?.tabs || [];
        console.log("Open tabs:");
        tabs.forEach((tab, idx) =>
          console.log(`#${idx + 1}: ${tab.title} (${tab.url}) [tabId: ${tab.id}]`)
        );
      });
      return;
    }

    // Switch to Nth tab (1-based) using on-demand list
    const index = C.getSwitchTabIndex ? C.getSwitchTabIndex(transcript) : -1;
    if (index >= 0) {
      chrome.runtime.sendMessage({ command: "listTabs" }, (response) => {
        const tabs = response?.tabs || [];
        const t = tabs[index];
        if (t && typeof t.id === "number") chrome.runtime.sendMessage({ command: "switchTab", tabId: t.id });
        else console.warn("No tab at that index.");
      });
      return;
    }

    // Direct open-website intent (don’t rely on LLM echo)
    const directUrl = C.extractUrlFromSpeech ? C.extractUrlFromSpeech(transcript) : null;
    if (directUrl) {
      chrome.runtime.sendMessage({ command: "openTab", url: directUrl });
      console.log("Assistant:", `Opening ${directUrl} now.`);
      return;
    }

    if (session || (typeof window !== 'undefined' && (window.LanguageModel || window.ai))) {
      await sendToLLM(transcript);
    }
  };

  rec.onend = () => { if (micActive) rec.start(); };
  rec.start();
}

function stopMic() {
  micActive = false;
  // Prefer stopping adapter engine if present
  if (sttEngine) {
    try { if (typeof sttEngine.stop === 'function') sttEngine.stop(); } catch {}
    sttEngine = null;
  }
  if (recognition) {
    recognition.onend = null;
    recognition.stop();
    recognition = null;
  }
  console.log("Mic stopped.");
  try { chrome.runtime.sendMessage({ event: 'system', type: 'mic', state: 'disabled', ts: Date.now(), source: 'stopMic' }); } catch (e) {}
  try { /* overlay disabled */ } catch {}
}

// Listen to extension activation
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.command === "activate" && document.visibilityState === "visible") {
    chrome.runtime.sendMessage({ command: "stopAllMics" }, () => {
      setTimeout(() => { initLLM().then(() => startMic()); }, 200);
    });
  }
  if (msg.command === "stop") stopMic();
  if (msg.command === "userTypedInput") {
    const manualText = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (manualText) {
      try {
        chrome.runtime.sendMessage({
          event: 'stt',
          text: manualText,
          ts: Date.now(),
          tokens: estimateTokens(manualText),
          chars: manualText.length
        });
      } catch (e) {}
      initLLM().catch(() => {}).then(() => sendToLLM(manualText));
    }
  }
  // HTML/DOM LAYOUT grid toggle
  if (msg && msg.event === 'htmlDomLayout') {
    try { console.log('Hey Nano: htmlDomLayout event', msg.state, msg.options || {}); } catch {}
    if (msg.state === 'enabled') {
      createDomGridOverlay(msg.options || {});
      enableDomHighlights();
      enableDomLift();
    } else if (msg.state === 'disabled') {
      removeDomGridOverlay();
      disableDomHighlights();
      disableDomLift();
    }
  }
  if (msg && msg.event === 'layoutOpinion') {
    try { askLayoutOpinion(); } catch {}
  }
  if (msg && msg.event === 'layoutAction') {
    try {
      if (msg.action === 'apply') {
        applyLayoutImprovements();
      } else if (msg.action === 'revert') {
        revertLayoutImprovements();
      }
    } catch {}
  }
  if (msg && msg.event === 'domLiftAdjust') {
    const scale = Math.max(1.0, Math.min(2.5, Number(msg.scale) || 1.15));
    try {
      document.documentElement.style.setProperty('--hey-mic-lift-scale', String(scale));
      console.log('Hey Nano: DOM lift scale set to', scale);
    } catch {}
  }
});


})();
