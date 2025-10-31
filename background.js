let activeTabId = null;
// Track per-tab mic enablement toggled by the toolbar button
const micEnabledTabs = new Map(); // tabId -> boolean
let lastFocusedNormalWindowId = null;
// Track Admin Panel window id across reloads
let adminWindowId = null;
// Track user popup companion tabs per anchor tab id
const userPopupTabs = new Map(); // anchorTabId -> { popupTabId, windowId }
const popupAnchorByTabId = new Map(); // popupTabId -> anchorTabId
// Track per-tab DOM highlight toggle via toolbar context menu
const domHighlightTabs = new Map(); // tabId -> boolean
let domLiftScale = 1.15; // default lift scale
let menusReady = false;
const POPUP_HTML_PATH = 'user_popup.html';
const sidePanelAvailable = !!(chrome.sidePanel && typeof chrome.sidePanel.setOptions === 'function' && typeof chrome.sidePanel.open === 'function');
const sidePanelOpenTabs = new Set(); // tabIds with side panel currently open
const tabSessions = new Map(); // tabId -> { sessionId, url }
const TYPED_CONTEXT_LIMIT = 5;
const TYPED_CONTEXT_TITLE_LIMIT = 80;
const TYPED_CONTEXT_BODY_LIMIT = 1200;
const TYPED_CONTEXT_IMAGE_LIMIT = 3;
const TYPED_CONTEXT_IMAGE_NAME_LIMIT = 80;
const TYPED_CONTEXT_IMAGE_DATAURL_LIMIT = 2 * 1024 * 1024; // base64 char cap per image payload
const TYPED_CONTEXT_PREVIEW_LIMIT = 600;
const TYPED_CONTEXT_HIGHLIGHT_LIMIT = 3;
const TYPED_CONTEXT_HIGHLIGHT_LENGTH = 220;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const INTERNAL_PROTOCOLS = new Set(['chrome:', 'edge:', 'about:', 'chrome-untrusted:', 'devtools:', 'chrome-search:', 'chrome-native:']);

function parseUrlSafe(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function isRestrictedInternalUrl(raw) {
  if (!raw || typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  const parsed = parseUrlSafe(trimmed);
  if (parsed) {
    if (INTERNAL_PROTOCOLS.has(parsed.protocol)) {
      return true;
    }
    // Some Chrome variants expose the New Tab page as chrome://new-tab-page/
    if ((parsed.protocol === 'chrome:' || parsed.protocol === 'edge:') && parsed.hostname) {
      const host = parsed.hostname.toLowerCase();
      if (host === 'newtab' || host === 'new-tab-page') return true;
    }
  } else {
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('chrome://') || lower.startsWith('edge://') || lower.startsWith('about:') || lower.startsWith('devtools://')) {
      return true;
    }
  }
  return false;
}

function isRestrictedTab(tab) {
  if (!tab) return false;
  const primary = typeof tab.url === 'string' ? tab.url.trim() : '';
  const pending = typeof tab.pendingUrl === 'string' ? tab.pendingUrl.trim() : '';
  const primaryRestricted = primary ? isRestrictedInternalUrl(primary) : false;
  if (primary && !primaryRestricted) {
    return false;
  }
  if (pending) {
    const pendingRestricted = isRestrictedInternalUrl(pending);
    if (!pendingRestricted) return false;
    return primaryRestricted || pendingRestricted;
  }
  return primaryRestricted;
}

function warnRestricted(tab) {
  const url = (tab && (tab.url || tab.pendingUrl)) || '(unknown)';
  try {
    console.warn(`Hey Nano: blocked UI on restricted page: ${url}`);
  } catch {}
}

function getTabById(tabId) {
  return new Promise((resolve) => {
    if (typeof tabId !== 'number') {
      resolve(null);
      return;
    }
    try {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime?.lastError) {
          resolve(null);
          return;
        }
        resolve(tab || null);
      });
    } catch {
      resolve(null);
    }
  });
}

function disableSidePanelForTab(tabId) {
  prepareSidePanelForTab(tabId, { enabled: false });
}

function prepareSidePanelForTab(tabId, { enabled } = {}) {
  if (!sidePanelAvailable || typeof tabId !== 'number') return;
  const shouldEnable = enabled ?? sidePanelOpenTabs.has(tabId);
  try {
    chrome.sidePanel.setOptions({ tabId, path: POPUP_HTML_PATH, enabled: shouldEnable }, () => {
      void chrome.runtime?.lastError;
    });
  } catch {}
}

function generateSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

function initializeTabSession(tabId, url) {
  if (typeof tabId !== 'number') return null;
  if (tabSessions.has(tabId)) return tabSessions.get(tabId);
  const record = { sessionId: generateSessionId(), url: url || null };
  tabSessions.set(tabId, record);
  return record;
}

function resetTabSession(tabId, url) {
  if (typeof tabId !== 'number') return null;
  const previous = tabSessions.get(tabId);
  const record = { sessionId: generateSessionId(), url: url || null };
  tabSessions.set(tabId, record);
  convoLogs.delete(tabId);
  try {
    chrome.runtime.sendMessage({
      event: 'tabSessionReset',
      tabId,
      sessionId: record.sessionId,
      url: record.url || '',
      previousSessionId: previous?.sessionId || null,
    });
  } catch {}
  return record;
}

async function getOrCreateTabSession(tabId) {
  if (tabSessions.has(tabId)) return tabSessions.get(tabId);
  const tab = await getTabById(tabId);
  const url = tab?.url || tab?.pendingUrl || null;
  return initializeTabSession(tabId, url);
}

function updateTabSessionUrl(tabId, url) {
  if (!tabSessions.has(tabId)) return;
  const record = tabSessions.get(tabId);
  record.url = url || record.url || null;
}

function classifySidePanelError(err) {
  const message = err && (err.message || String(err)) || '';
  if (!message) return { severity: 'none', message: '' };
  const lower = message.toLowerCase();
  const fatalFragments = [
    'not available',
    'not supported',
    'no tab with id',
    'invalid tab',
    'missing tab',
    'window not found',
    'cannot open side panel',
  ];
  if (fatalFragments.some((fragment) => lower.includes(fragment))) {
    return { severity: 'fatal', message };
  }
  const ignoreFragments = [
    'already open',
    'already opened',
    'already has an open side panel',
  ];
  if (ignoreFragments.some((fragment) => lower.includes(fragment))) {
    return { severity: 'ignore', message };
  }
  const recoverableFragments = [
    'user activation',
    'user gesture',
    'must be active',
    'requires an active tab',
  ];
  if (recoverableFragments.some((fragment) => lower.includes(fragment))) {
    return { severity: 'recoverable', message };
  }
  return { severity: 'recoverable', message };
}

function callSidePanelMethod(methodName, args) {
  return new Promise((resolve) => {
    try {
      const method = chrome?.sidePanel?.[methodName];
      if (typeof method !== 'function') {
        resolve({ ok: false, fatal: true, message: 'method-unavailable' });
        return;
      }
      method.call(chrome.sidePanel, args, () => {
        const err = chrome.runtime?.lastError;
        if (!err) {
          resolve({ ok: true, fatal: false, recoverable: false, message: '' });
          return;
        }
        const { severity, message } = classifySidePanelError(err);
        if (severity === 'fatal') {
          resolve({ ok: false, fatal: true, recoverable: false, message });
          return;
        }
        if (severity === 'ignore') {
          resolve({ ok: true, fatal: false, recoverable: false, message });
          return;
        }
        resolve({ ok: false, fatal: false, recoverable: true, message });
      });
    } catch (e) {
      resolve({ ok: false, fatal: true, recoverable: false, message: (e && e.message) ? e.message : String(e || '') });
    }
  });
}

async function openSidePanelForTab(tabOrId, attempt = 0) {
  if (!sidePanelAvailable) return { ok: false, fatal: true, recoverable: false, message: 'unsupported' };
  const tabId = typeof tabOrId === 'number' ? tabOrId : (tabOrId && tabOrId.id);
  if (typeof tabId !== 'number') return { ok: false, fatal: true, recoverable: false, message: 'invalid-tab-id' };

  const wasTracked = sidePanelOpenTabs.has(tabId);
  let tab = (tabOrId && typeof tabOrId === 'object') ? tabOrId : null;
  if (!tab || typeof tab.id !== 'number') {
    tab = await getTabById(tabId);
    if (!tab) {
      sidePanelOpenTabs.delete(tabId);
      disableSidePanelForTab(tabId);
      return { ok: false, fatal: true, recoverable: false, message: 'tab-missing' };
    }
  }
  if (isRestrictedTab(tab)) {
    sidePanelOpenTabs.delete(tabId);
    disableSidePanelForTab(tabId);
    warnRestricted(tab);
    return { ok: false, fatal: false, recoverable: false, message: 'restricted-page' };
  }

  await getOrCreateTabSession(tabId);
  if (!wasTracked) sidePanelOpenTabs.add(tabId);

  const optionsResult = await callSidePanelMethod('setOptions', { tabId, path: POPUP_HTML_PATH, enabled: true });
  if (!optionsResult.ok) {
    if (optionsResult.recoverable && attempt === 0) {
      await sleep(75);
      return openSidePanelForTab(tabId, attempt + 1);
    }
    sidePanelOpenTabs.delete(tabId);
    disableSidePanelForTab(tabId);
    return optionsResult;
  }

  const openResult = await callSidePanelMethod('open', { tabId });
  if (!openResult.ok) {
    if (openResult.recoverable && attempt === 0) {
      await sleep(75);
      return openSidePanelForTab(tabId, attempt + 1);
    }
    sidePanelOpenTabs.delete(tabId);
    disableSidePanelForTab(tabId);
    return openResult;
  }

  return { ok: true, fatal: false, recoverable: false, message: '' };
}

// Suppress noisy unhandled promise rejections from Chrome APIs when a target
// page cannot receive messages (e.g., chrome:// pages, PDFs, closed tabs).
// This prevents the Extensions UI from showing "Uncaught (in promise) Could not establish connection".
try {
  self.addEventListener('unhandledrejection', (e) => {
    try { console.warn('Background unhandledrejection suppressed:', e && (e.reason?.message || e.reason || '')); } catch {}
    e.preventDefault();
  });
  self.addEventListener('error', (e) => {
    // Keep normal errors visible in the console but avoid crashing the worker
    try { console.warn('Background error:', e && (e.message || '')); } catch {}
  });
} catch {}

function loadDomLiftScale(cb) {
  try {
    chrome.storage.local.get(['domLiftScale'], (d) => {
      const v = Number(d && d.domLiftScale);
      if (!Number.isNaN(v) && v >= 1 && v <= 2.5) domLiftScale = v;
      if (typeof cb === 'function') cb(domLiftScale);
    });
  } catch { if (typeof cb === 'function') cb(domLiftScale); }
}

function saveDomLiftScale(v) {
  domLiftScale = Math.max(1.0, Math.min(2.5, Number(v) || 1.15));
  try { chrome.storage.local.set({ domLiftScale }); } catch {}
  updateDomLiftMenuTitle();
}

function updateDomLiftMenuTitle() {
  const pct = Math.round((domLiftScale - 1) * 100);
  if (!menusReady) return;
  // The level item was removed; keep a safe no-op update to avoid promise rejections
  try {
    chrome.contextMenus.update('heyNano.domLiftLevel', { title: `Lift Intensity: ${pct}%` }, () => {
      // ignore lastError if the menu item no longer exists
      void chrome.runtime?.lastError;
    });
  } catch {}
}

async function configureSidePanelBehavior() {
  if (!sidePanelAvailable || typeof chrome.sidePanel.setPanelBehavior !== 'function') return;
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    chrome.tabs.query({}, (tabs) => {
      (tabs || []).forEach((t) => {
        if (!t || typeof t.id !== 'number') return;
        initializeTabSession(t.id, t.url || t.pendingUrl || null);
        prepareSidePanelForTab(t.id);
      });
    });
  } catch {}
}

configureSidePanelBehavior().catch(() => {});

if (chrome.tabs && typeof chrome.tabs.onCreated?.addListener === 'function') {
  chrome.tabs.onCreated.addListener((tab) => {
    if (!tab || typeof tab.id !== 'number') return;
    if (isRestrictedTab(tab)) {
      sidePanelOpenTabs.delete(tab.id);
      tabSessions.delete(tab.id);
      convoLogs.delete(tab.id);
      disableSidePanelForTab(tab.id);
      warnRestricted(tab);
      return;
    }
    initializeTabSession(tab.id, tab.url || tab.pendingUrl || null);
    if (sidePanelAvailable && sidePanelOpenTabs.has(tab.id)) {
      prepareSidePanelForTab(tab.id);
    }
  });
}

if (chrome.tabs && typeof chrome.tabs.onUpdated?.addListener === 'function') {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo) return;
    const candidateUrl = changeInfo.url || changeInfo.pendingUrl || (tab && (tab.url || tab.pendingUrl)) || '';
    const candidateRestricted = candidateUrl ? isRestrictedInternalUrl(candidateUrl) : false;
    const tabRestricted = tab ? isRestrictedTab(tab) : false;

    if (candidateRestricted || tabRestricted) {
      if (sidePanelOpenTabs.has(tabId)) sidePanelOpenTabs.delete(tabId);
      disableSidePanelForTab(tabId);
      tabSessions.delete(tabId);
      convoLogs.delete(tabId);
      if (tabRestricted && tab) warnRestricted(tab);
      return;
    }

    if (changeInfo.status === 'loading') {
      const navUrl = candidateUrl || tab?.pendingUrl || tab?.url || null;
      resetTabSession(tabId, navUrl);
    } else if (candidateUrl && !tabSessions.has(tabId)) {
      initializeTabSession(tabId, candidateUrl);
    }

    if (changeInfo.status === 'complete') {
      updateTabSessionUrl(tabId, tab?.url || candidateUrl || null);
    }

    if (!sidePanelAvailable || !sidePanelOpenTabs.has(tabId)) return;
    if (changeInfo.status === 'loading') {
      prepareSidePanelForTab(tabId);
      return;
    }
    if (changeInfo.status === 'complete') {
      prepareSidePanelForTab(tabId);
      void openSidePanelForTab(tab || tabId);
    }
  });
}

if (chrome.tabs && typeof chrome.tabs.onReplaced?.addListener === 'function') {
  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    const wasOpen = typeof removedTabId === 'number' ? sidePanelOpenTabs.delete(removedTabId) : false;
    if (typeof removedTabId === 'number') {
      tabSessions.delete(removedTabId);
      convoLogs.delete(removedTabId);
    }
    if (typeof addedTabId === 'number') {
      resetTabSession(addedTabId, null);
      if (sidePanelAvailable && wasOpen) {
        sidePanelOpenTabs.add(addedTabId);
        void openSidePanelForTab(addedTabId);
      }
    }
  });
}

if (chrome.tabs && typeof chrome.tabs.onRemoved?.addListener === 'function') {
  chrome.tabs.onRemoved.addListener((tabId) => {
    sidePanelOpenTabs.delete(tabId);
    tabSessions.delete(tabId);
    convoLogs.delete(tabId);
  });
}

function tryActivateSplitView(windowId, primaryTabId, secondaryTabId) {
  if (!windowId || !primaryTabId || !secondaryTabId) return false;
  const tabsApi = chrome && chrome.tabs;
  if (!tabsApi) return false;
  let invoked = false;
  const candidates = [
    ['openSplitView', { windowId, primaryTabId, secondaryTabId }],
    ['createSplitView', { windowId, primaryTabId, secondaryTabId }],
    ['setSplitViewState', { windowId, primaryTabId, secondaryTabId }],
    ['attachToSplitView', { windowId, primaryTabId, secondaryTabId }],
  ];
  for (const [fn, payload] of candidates) {
    const maybeFn = tabsApi[fn];
    if (typeof maybeFn !== 'function') continue;
    try {
      const result = maybeFn.call(tabsApi, payload);
      invoked = true;
      if (result && typeof result.catch === 'function') {
        result.catch(() => {});
      }
      return true;
    } catch (err) {
      // Ignore invalid invocation signatures and try the next candidate
    }
  }
  const fallback = tabsApi && (tabsApi.invokeSplitView || tabsApi.toggleSplitView);
  if (typeof fallback === 'function') {
    try {
      const result = fallback.call(tabsApi, { windowId, primaryTabId, secondaryTabId });
      invoked = true;
      if (result && typeof result.catch === 'function') result.catch(() => {});
      return true;
    } catch (err) {
      // Swallow; split view APIs are still experimental and may not be present.
    }
  }
  return invoked;
}

// Open or focus the user popup UI, preferring the Chrome side panel when available
async function openOrFocusUserPopup(anchorTab) {
  if (sidePanelAvailable) {
    if (anchorTab && typeof anchorTab.id === 'number') {
      if (isRestrictedTab(anchorTab)) {
        sidePanelOpenTabs.delete(anchorTab.id);
        disableSidePanelForTab(anchorTab.id);
        warnRestricted(anchorTab);
        return;
      }
      const result = await openSidePanelForTab(anchorTab);
      if (!result.ok && result.fatal) await openOrFocusUserPopupLegacy(anchorTab);
      return;
    }

    await new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const active = (tabs || [])[0] || null;
        if (active) {
          if (isRestrictedTab(active)) {
            sidePanelOpenTabs.delete(active.id);
            disableSidePanelForTab(active.id);
            warnRestricted(active);
            resolve();
            return;
          }
          const result = await openSidePanelForTab(active);
          if (!result.ok && result.fatal) await openOrFocusUserPopupLegacy(active);
          resolve();
          return;
        }
        chrome.windows.getAll({ windowTypes: ["normal"], populate: true }, async (wins) => {
          const focused = (wins || []).find(w => w.focused) || (wins || [])[0] || null;
          const tab = (focused && Array.isArray(focused.tabs)) ? focused.tabs.find(t => t.active) : null;
          if (tab) {
            if (isRestrictedTab(tab)) {
              sidePanelOpenTabs.delete(tab.id);
              disableSidePanelForTab(tab.id);
              warnRestricted(tab);
              resolve();
              return;
            }
            const result = await openSidePanelForTab(tab);
            if (!result.ok && result.fatal) await openOrFocusUserPopupLegacy(tab);
          }
          resolve();
        });
      });
    });
    return;
  }

  await openOrFocusUserPopupLegacy(anchorTab);
}

function openOrFocusUserPopupLegacy(anchorTab) {
  const popupUrl = chrome.runtime.getURL(POPUP_HTML_PATH);

  const focusPair = (anchor, popup) => {
    if (!anchor || !popup) return;
    const winId = anchor.windowId || popup.windowId;
    if (typeof winId !== 'number') return;
    chrome.windows.update(winId, { focused: true }, () => {
      const bridged = tryActivateSplitView(winId, anchor.id, popup.id);
      const targetTabId = bridged ? anchor.id : popup.id;
      chrome.tabs.update(targetTabId, { active: true }, () => {});
    });
  };

  const registerPair = (anchorId, popupTab) => {
    if (!popupTab || typeof popupTab.id !== 'number') return;
    userPopupTabs.set(anchorId, { popupTabId: popupTab.id, windowId: popupTab.windowId });
    popupAnchorByTabId.set(popupTab.id, anchorId);
  };

  const createPopupForAnchor = (anchor) => {
    if (!anchor || typeof anchor.id !== 'number') return;
    const index = typeof anchor.index === 'number' ? anchor.index + 1 : undefined;
    const winId = anchor.windowId;
    chrome.tabs.create({
      windowId: winId && typeof winId === 'number' ? winId : undefined,
      url: popupUrl,
      active: true,
      index,
    }, (popup) => {
      if (!popup || typeof popup.id !== 'number') return;
      registerPair(anchor.id, popup);
      const targetWindowId = winId || popup.windowId;
      const activated = tryActivateSplitView(targetWindowId, anchor.id, popup.id);
      if (activated) {
        chrome.tabs.update(anchor.id, { active: true }, () => {});
      }
    });
  };

  const ensureForAnchor = (anchor) => {
    if (!anchor || typeof anchor.id !== 'number') return;
    const anchorId = anchor.id;
    const existing = userPopupTabs.get(anchorId);
    if (existing && typeof existing.popupTabId === 'number') {
      chrome.tabs.get(existing.popupTabId, (popup) => {
        if (chrome.runtime.lastError || !popup) {
          userPopupTabs.delete(anchorId);
          popupAnchorByTabId.delete(existing.popupTabId);
          createPopupForAnchor(anchor);
          return;
        }
        if (!popup.url || !popup.url.startsWith(popupUrl)) {
          chrome.tabs.update(popup.id, { url: popupUrl }, () => focusPair(anchor, popup));
        } else {
          focusPair(anchor, popup);
        }
      });
      return;
    }
    createPopupForAnchor(anchor);
  };

  try {
    if (anchorTab && typeof anchorTab.id === 'number') {
      ensureForAnchor(anchorTab);
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const active = (tabs || [])[0] || null;
      if (active) {
        ensureForAnchor(active);
        return;
      }
      chrome.windows.getAll({ windowTypes: ["normal"], populate: true }, (wins) => {
        const focused = (wins || []).find(w => w.focused) || (wins || [])[0] || null;
        const anchor = (focused && Array.isArray(focused.tabs)) ? focused.tabs.find(t => t.active) : null;
        if (anchor) ensureForAnchor(anchor);
      });
    });
  } catch (e) {}
}

function openOrFocusUserPopupForTabId(tabId) {
  if (typeof tabId !== 'number') return Promise.resolve(false);
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, async (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve(false);
        return;
      }
      await openOrFocusUserPopup(tab);
      resolve(true);
    });
  });
}

function ensureContextMenus() {
  // Rebuild menus from scratch to avoid duplicate-id errors
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "heyNano.disableAll", title: "Turn off Hey Nano on all tabs", contexts: ["action"] });
    chrome.contextMenus.create({ id: "heyNano.adminPanel", title: "Open Admin Panel", contexts: ["action"] });
    menusReady = true;
  });
}

// Safely send a message to a tab's content script; ignore if none injected
function safeSend(tabId, payload) {
  try {
    chrome.tabs.sendMessage(tabId, payload, () => {
      // Swallow no-receiver errors to avoid noisy logs
      void chrome.runtime.lastError;
    });
  } catch (e) {
    // Ignore
  }
}
const convoLogs = new Map(); // tabId -> [{role:'you'|'assistant', text, ts, tokens, chars}]
const CONTEXT_WINDOW_TOKENS = 4096; // display-only assumed context window size

function estimateTokens(s) {
  const text = (s || "").toString();
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function recordLog(tabId, role, text, tokens, chars) {
  if (typeof tabId !== 'number') return;
  if (!convoLogs.has(tabId)) convoLogs.set(tabId, []);
  const arr = convoLogs.get(tabId);
  const ts = Date.now();
  const tChars = typeof chars === 'number' ? chars : (text ? String(text).length : 0);
  const tTokens = typeof tokens === 'number' ? tokens : estimateTokens(text);
  arr.push({ role, text, ts, tokens: tTokens, chars: tChars });
  if (arr.length > 200) arr.splice(0, arr.length - 200);
}

// Display-only copy of the system prompt to show in Admin Panel
const SYSTEM_PROMPT = (
  "You are an intelligent assistant embedded in a browser extension that helps users interact with AI models through focused, user-defined context. " +
  "Your primary function is to process, summarize, and generate responses based only on the content the user selects or highlights within the webpage. This ensures precision, relevance, and token efficiency. " +
  "Respond in English by default. " +
  "When describing your capabilities, mention that you can summarize, explain, generate text, and answer questions about the selected context. " +
  "The extension may also support voice commands as a secondary interaction mode. When users use voice input, you can respond naturally, and if the speech contains an actionable command (e.g., 'open', 'go to', 'navigate to'), follow the navigation policy below. " +
  "Navigation Policy: Only ask 'Which site should I open?' when a navigation verb (open/go to/navigate to/visit) is detected without a clear target. Confirm before opening a website only when the user includes a specific URL or a well-known site name. Never claim inability to open external sites; the extension handles supported browser actions. Do not invent or simulate actions. " +
  "Your goal is to keep the AI focused on what the user highlights — no guessing, no noise, just attention where it matters."
);

// Display-only list of supported voice commands (kept in sync with content.js behavior)
const SUPPORTED_COMMANDS = [
  "open <domain|URL|alias>  e.g., 'open youtube.com', 'open YouTube'",
  "list tabs  — prints all open tabs in console",
  "switch to tab N  — switches to the Nth tab from the last list",
  "stop / stop listening / stop recording  — disables the mic",
];

function broadcastMicState(tabId, enabled) {
  try {
    chrome.runtime.sendMessage({ event: 'micStateChanged', tabId, enabled });
  } catch (e) {
    // ignore
  }
}

// Broadcast HTML/DOM layout toggle state so Admin widget can sync
function broadcastHtmlDomLayoutState(tabId, enabled) {
  try {
    chrome.runtime.sendMessage({ event: 'htmlDomLayoutSync', tabId, enabled: !!enabled });
  } catch (e) {
    // ignore
  }
}

function setBadge(tabId, enabled) {
  chrome.action.setBadgeBackgroundColor({ color: enabled ? '#1e9e3f' : '#777777' });
  chrome.action.setBadgeText({ tabId, text: enabled ? 'On' : '' });
}

function disableAllMics() {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((t) => {
      micEnabledTabs.set(t.id, false);
      setBadge(t.id, false);
      safeSend(t.id, { command: "stop" });
      broadcastMicState(t.id, false);
    });
  });
}

async function enableMicForTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.query({}, async (tabs) => {
      // Stop everywhere, clear state
      for (const t of tabs) {
        micEnabledTabs.set(t.id, false);
        setBadge(t.id, false);
        safeSend(t.id, { command: "stop" });
        broadcastMicState(t.id, false);
      }
      // Enable on target tab
      micEnabledTabs.set(tabId, true);
      setBadge(tabId, true);
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["speech_adapter.js", "voice_commands.js", "content.js"] });
      } catch (e) {
        // ignore if already injected; content.js has guard
      }
      safeSend(tabId, { command: "activate" });
      broadcastMicState(tabId, true);
      resolve();
    });
  });
}

function disableMicForTab(tabId) {
  micEnabledTabs.set(tabId, false);
  setBadge(tabId, false);
  safeSend(tabId, { command: "stop" });
  broadcastMicState(tabId, false);
}

function getMicEnabledTabId() {
  for (const [id, enabled] of micEnabledTabs.entries()) {
    if (enabled) return id;
  }
  return null;
}

// Best-effort: make sure our content listener exists in the tab so it can receive layout events
function ensureContentListener(tabId, cb) {
  try {
    chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }, () => {
      const err = chrome.runtime.lastError ? String(chrome.runtime.lastError.message || 'inject error') : null;
      if (typeof cb === 'function') cb(!err, err);
    });
  } catch (e) {
    if (typeof cb === 'function') cb(false, String(e?.message || e) );
  }
}

function sendHtmlDomLayoutToTab(tabId, enabled, finalResponse) {
  // Keep in sync with context menu toggle state
  try { domHighlightTabs.set(tabId, !!enabled); } catch {}
  const state = enabled ? 'enabled' : 'disabled';
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      const note = chrome.runtime.lastError && chrome.runtime.lastError.message
        ? String(chrome.runtime.lastError.message)
        : 'Tab not found';
      try { broadcastHtmlDomLayoutState(tabId, enabled); } catch {}
      if (typeof finalResponse === 'function') return finalResponse({ ok: false, enabled, tabId: null, tabUrl: '', injected: false, note });
      return;
    }
    const tabUrl = tab && tab.url ? tab.url : '';
    // Skip injection on restricted schemes to avoid noisy errors
    const scheme = (() => { try { return new URL(tabUrl).protocol.replace(':',''); } catch { return ''; } })();
    if (scheme === 'chrome' || scheme === 'edge' || scheme === 'about') {
      broadcastHtmlDomLayoutState(tabId, enabled);
      if (typeof finalResponse === 'function') return finalResponse({ ok: true, enabled, tabId, tabUrl, injected: false, note: 'Cannot inject into browser internal pages (chrome://, edge://, about:).' });
      return;
    }
    ensureContentListener(tabId, (ok, err) => {
      if (ok) {
        safeSend(tabId, { event: 'htmlDomLayout', state });
        if (enabled) {
          // also push current lift scale to page
          safeSend(tabId, { event: 'domLiftAdjust', scale: domLiftScale });
        }
      }
      // Notify UI listeners regardless of injection result
      broadcastHtmlDomLayoutState(tabId, enabled);
      const scheme = (() => { try { return new URL(tabUrl).protocol.replace(':',''); } catch { return ''; } })();
      const blocked = Boolean(err);
      const hint = blocked && scheme === 'file'
        ? "Enable 'Allow access to file URLs' for Hey Nano in chrome://extensions."
        : (blocked && (scheme === 'chrome' || scheme === 'edge' || scheme === 'about'))
          ? 'Cannot inject into browser internal pages (chrome://, edge://, about:).' : (blocked ? err : null);
      if (typeof finalResponse === 'function') finalResponse({ ok: true, enabled, tabId, tabUrl, injected: ok, note: hint });
    });
  });
}

// Attempt to open the anchored action popup (requires user gesture in some contexts)
function tryOpenActionPopup() {
  try {
    const fn = chrome.action && chrome.action.openPopup;
    if (typeof fn === 'function') {
      const maybePromise = fn();
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.catch(() => {});
      }
    }
  } catch (e) {
    // Ignore if not supported or blocked by gesture requirements
  }
}

// Activate mic on tab switch/reload
chrome.tabs.onActivated.addListener(({ tabId }) => {
  activeTabId = tabId;
  const enabled = !!micEnabledTabs.get(tabId);
  setBadge(tabId, enabled);
  if (enabled) safeSend(tabId, { command: "activate" });
  if (sidePanelAvailable && sidePanelOpenTabs.has(tabId)) {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime?.lastError || !tab) {
        sidePanelOpenTabs.delete(tabId);
        disableSidePanelForTab(tabId);
        return;
      }
      if (isRestrictedTab(tab)) {
        sidePanelOpenTabs.delete(tabId);
        disableSidePanelForTab(tabId);
        warnRestricted(tab);
        return;
      }
      initializeTabSession(tabId, tab.url || tab.pendingUrl || null);
      prepareSidePanelForTab(tabId);
      void openSidePanelForTab(tab);
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete" && tabId === activeTabId) {
    if (micEnabledTabs.get(tabId)) safeSend(tabId, { command: "activate" });
  }
});

// Toolbar click: just open the companion UI without changing mic state
chrome.action.onClicked.addListener(async (tab) => {
  if (!sidePanelAvailable) {
    await openOrFocusUserPopupLegacy(tab);
    return;
  }
  if (!tab || typeof tab.id !== 'number') return;
  if (isRestrictedTab(tab)) {
    sidePanelOpenTabs.delete(tab.id);
    disableSidePanelForTab(tab.id);
    warnRestricted(tab);
    return;
  }

  const tabId = tab.id;
  initializeTabSession(tabId, tab.url || tab.pendingUrl || null);
  sidePanelOpenTabs.add(tabId);
  prepareSidePanelForTab(tabId);
  try {
    chrome.sidePanel.open({ tabId }, async () => {
      const err = chrome.runtime?.lastError;
      if (!err) return;
      sidePanelOpenTabs.delete(tabId);
      const message = err.message ? String(err.message) : '';
      const lower = message.toLowerCase();
      const requiresGesture = lower.includes('user activation') || lower.includes('user gesture');
      if (!requiresGesture) {
        disableSidePanelForTab(tabId);
      }
      await openOrFocusUserPopupLegacy(tab);
    });
  } catch {
    sidePanelOpenTabs.delete(tabId);
    await openOrFocusUserPopupLegacy(tab);
  }
});

// Consolidated message handling
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.command) {
    case "switchTab":
      if (typeof msg.tabId === "number") chrome.tabs.update(msg.tabId, { active: true });
      break;
    case "closeTab":
      if (typeof msg.tabId === "number") {
        try { chrome.tabs.remove(msg.tabId); } catch (e) {}
      }
      break;
    case "openTab":
      if (msg.url) {
        chrome.tabs.create({ url: msg.url }, (tab) => sendResponse({ tabId: tab.id }));
        return true; // async
      }
      break;
    case "listTabs": {
      const respond = (tabs) => sendResponse({ tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url })) });

      // If a specific window was requested use it
      if (typeof msg.windowId === 'number') {
        chrome.tabs.query({ windowId: msg.windowId }, (tabs) => respond(tabs || []));
        return true;
      }

      // Prefer the last focused normal window
      if (typeof lastFocusedNormalWindowId === 'number') {
        chrome.tabs.query({ windowId: lastFocusedNormalWindowId }, (tabs) => respond(tabs || []));
        return true;
      }

      // Fallback: find any focused normal window or the first normal window
      chrome.windows.getAll({ windowTypes: ["normal"], populate: true }, (wins) => {
        const focused = (wins || []).find(w => w.focused) || (wins || [])[0];
        const tabs = focused?.tabs || [];
        respond(tabs);
      });
      return true; // async
    }
    case "getActiveTargetTab": {
      const respond = (tab) => {
        if (!tab) return sendResponse({ tab: null });
        sendResponse({ tab: { id: tab.id, title: tab.title, url: tab.url, windowId: tab.windowId } });
      };

      if (sender && sender.tab && typeof sender.tab.id === 'number') {
        const anchorId = popupAnchorByTabId.get(sender.tab.id);
        if (typeof anchorId === 'number') {
          chrome.tabs.get(anchorId, (anchorTab) => {
            if (chrome.runtime.lastError || !anchorTab) {
              respond(null);
            } else {
              respond(anchorTab);
            }
          });
          return true;
        }
      }

      // If a windowId is provided, use its active tab
      if (typeof msg.windowId === 'number') {
        chrome.tabs.query({ windowId: msg.windowId, active: true }, (tabs) => respond((tabs || [])[0] || null));
        return true;
      }

      if (typeof lastFocusedNormalWindowId === 'number') {
        chrome.tabs.query({ windowId: lastFocusedNormalWindowId, active: true }, (tabs) => respond((tabs || [])[0] || null));
        return true;
      }

      // Fallback to currently focused normal window
      chrome.windows.getAll({ windowTypes: ["normal"], populate: false }, (wins) => {
        const focused = (wins || []).find(w => w.focused) || (wins || [])[0];
        if (!focused) return respond(null);
        chrome.tabs.query({ windowId: focused.id, active: true }, (tabs) => respond((tabs || [])[0] || null));
      });
      return true; // async
    }
    case "getMicState": {
      if (typeof msg.tabId === "number") {
        sendResponse({ enabled: !!micEnabledTabs.get(msg.tabId) });
      }
      return false;
    }
    case "getConversationLog": {
      const tabId = typeof msg.tabId === 'number' ? msg.tabId : (sender?.tab?.id ?? null);
      const log = (tabId && convoLogs.get(tabId)) || [];
      sendResponse({ log });
      return false;
    }
    case "getContextLimits": {
      sendResponse({ windowTokens: CONTEXT_WINDOW_TOKENS });
      return false;
    }
    case "resetSession": {
      const tabId = typeof msg.tabId === 'number' ? msg.tabId : null;
      if (!tabId) {
        if (sendResponse) sendResponse({ ok: false, error: 'invalid-tab' });
        return false;
      }
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          const err = chrome.runtime.lastError ? String(chrome.runtime.lastError.message || chrome.runtime.lastError) : 'tab-missing';
          if (sendResponse) sendResponse({ ok: false, error: err });
          return;
        }
        const url = tab.url || tab.pendingUrl || null;
        resetTabSession(tabId, url);
        if (sendResponse) sendResponse({ ok: true });
      });
      return true; // async
    }
    case "getTabSession": {
      const tabId = typeof msg.tabId === 'number' ? msg.tabId : (sender?.tab?.id ?? null);
      if (typeof tabId !== 'number') {
        sendResponse({ tabId: null, sessionId: null, url: null });
        return false;
      }
      getOrCreateTabSession(tabId).then((session) => {
        sendResponse({
          tabId,
          sessionId: session?.sessionId || null,
          url: session?.url || null,
        });
      }).catch(() => {
        sendResponse({ tabId, sessionId: null, url: null });
      });
      return true; // async
    }
    case "getSystemPrompt": {
      sendResponse({ prompt: SYSTEM_PROMPT });
      return false;
    }
    case "getSupportedCommands": {
      // Try to fetch commands from the active tab's registry.
      const respond = (commands) => sendResponse({ commands });

      const buildFallback = () => ([
        { action: 'Open URL', triggers: ['open <domain|URL|alias>', 'open youtube.com', 'open YouTube'], description: 'Open a website by URL/domain/alias' },
        { action: 'List Tabs', triggers: ['list tabs', 'list all tabs'], description: 'List all open tabs in the current window' },
        { action: 'Switch To Tab N', triggers: ['switch to tab N', 'go to tab N', 'move to tab N'], description: 'Switch to tab by its position' },
        { action: 'Close Tab N', triggers: ['close tab N', 'close tab number N', 'close tab no. N', 'close tab #N', 'close the Nth tab', 'close the <ordinal> tab'], description: 'Close tab by its position' },
        { action: 'Stop Plugin', triggers: ['stop', 'stop listening', 'stop recording', 'stop recognition', 'turn off mic', 'disable microphone'], description: 'Disable the microphone' },
      ]);

      const withActiveTab = (tab) => {
        if (!tab || typeof tab.id !== 'number') {
          respond(buildFallback());
          return;
        }
        try {
          const execProbe = (cb) => chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              try {
                const api = window.HeyNanoCommands;
                if (api && typeof api.getSupportedCommandsTable === 'function') {
                  return api.getSupportedCommandsTable();
                }
                if (api && typeof api.getCommandRegistry === 'function') {
                  const reg = api.getCommandRegistry();
                  return (reg || []).map((c) => ({ action: c.title || c.id, triggers: c.triggers || [], description: c.description || '' }));
                }
              } catch (e) {}
              return null;
            },
          }, (results) => cb(results));

          // First probe: if missing, try injecting voice_commands.js then probe again
          execProbe((results) => {
            const val1 = Array.isArray(results) && results[0] ? results[0].result : null;
            if (val1 && Array.isArray(val1)) return respond(val1);
            try {
              chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["voice_commands.js"] }, () => {
                execProbe((results2) => {
                  const val2 = Array.isArray(results2) && results2[0] ? results2[0].result : null;
                  respond(val2 && Array.isArray(val2) ? val2 : buildFallback());
                });
              });
            } catch (e) {
              respond(buildFallback());
            }
          });
        } catch (e) {
          respond(buildFallback());
        }
      };

      // Prefer the active tab in the last focused normal window
      if (typeof lastFocusedNormalWindowId === 'number') {
        chrome.tabs.query({ windowId: lastFocusedNormalWindowId, active: true }, (tabs) => withActiveTab((tabs || [])[0] || null));
        return true; // async
      }
      chrome.windows.getAll({ windowTypes: ["normal"], populate: true }, (wins) => {
        const focused = (wins || []).find(w => w.focused) || (wins || [])[0];
        const tab = (focused && Array.isArray(focused.tabs)) ? focused.tabs.find(t => t.active) : null;
        withActiveTab(tab || null);
      });
      return true; // async
    }
    case "enableMicForTab": {
      if (typeof msg.tabId === "number") {
        enableMicForTab(msg.tabId).then(async () => {
          // Open/focus detached user popup when enabling via Admin panel
          await openOrFocusUserPopupForTabId(msg.tabId);
          sendResponse({ ok: true });
        });
        return true; // async
      }
      break;
    }
    case "disableMicForTab": {
      if (typeof msg.tabId === "number") {
        disableMicForTab(msg.tabId);
        sendResponse({ ok: true });
        return false;
      }
      break;
    }
    case "typedInput": {
      const tabId = typeof msg.tabId === 'number' ? msg.tabId : null;
      const text = typeof msg.text === 'string' ? msg.text : '';
      const cleaned = text.trim();
      if (!tabId || !cleaned) {
        if (sendResponse) sendResponse({ ok: false, error: 'invalid-input' });
        return false;
      }
      const rawContext = Array.isArray(msg.context) ? msg.context : [];
      const context = rawContext
        .slice(0, TYPED_CONTEXT_LIMIT)
        .map((entry) => {
          const title = typeof entry?.title === 'string' ? entry.title.trim().slice(0, TYPED_CONTEXT_TITLE_LIMIT) : '';
          const body = typeof entry?.body === 'string' ? entry.body.trim().slice(0, TYPED_CONTEXT_BODY_LIMIT) : '';
          const preview = typeof entry?.preview === 'string' ? entry.preview.trim().slice(0, TYPED_CONTEXT_PREVIEW_LIMIT) : '';
          const highlights = Array.isArray(entry?.highlights)
            ? entry.highlights
              .map((line) => (typeof line === 'string' ? line.trim().slice(0, TYPED_CONTEXT_HIGHLIGHT_LENGTH) : ''))
              .filter(Boolean)
              .slice(0, TYPED_CONTEXT_HIGHLIGHT_LIMIT)
            : [];
          const metaRaw = entry && typeof entry.meta === 'object' && entry.meta !== null ? entry.meta : null;
          const images = Array.isArray(entry?.images)
            ? entry.images
              .slice(0, TYPED_CONTEXT_IMAGE_LIMIT)
              .map((img) => {
                const name = typeof img?.name === 'string' ? img.name.trim().slice(0, TYPED_CONTEXT_IMAGE_NAME_LIMIT) : '';
                const dataUrlRaw = typeof img?.dataUrl === 'string' ? img.dataUrl.trim() : '';
                const dataUrl = dataUrlRaw && /^data:image\//i.test(dataUrlRaw) && dataUrlRaw.length <= TYPED_CONTEXT_IMAGE_DATAURL_LIMIT
                  ? dataUrlRaw
                  : '';
                if (!name && !dataUrl) return null;
                const sanitized = {};
                if (name) sanitized.name = name;
                if (dataUrl) sanitized.dataUrl = dataUrl;
                return sanitized;
              })
              .filter(Boolean)
            : [];
          if (!title && !body && !images.length) return null;
          const payloadEntry = { title, body };
          if (images.length) payloadEntry.images = images;
          if (preview) payloadEntry.preview = preview;
          if (highlights.length) payloadEntry.highlights = highlights;
          if (metaRaw) {
            const meta = {};
            if (typeof metaRaw.createdAt === 'number' && Number.isFinite(metaRaw.createdAt)) meta.createdAt = metaRaw.createdAt;
            if (typeof metaRaw.imageCount === 'number' && Number.isFinite(metaRaw.imageCount)) meta.imageCount = metaRaw.imageCount;
            if (typeof metaRaw.hasBody === 'boolean') meta.hasBody = metaRaw.hasBody;
            if (Object.keys(meta).length) payloadEntry.meta = meta;
          }
          return payloadEntry;
        })
        .filter(Boolean);
      ensureContentListener(tabId, (ok, err) => {
        if (!ok) {
          if (sendResponse) sendResponse({ ok: false, error: err || 'inject-failed' });
          return;
        }
        try {
          const payload = { command: "userTypedInput", text: cleaned };
          if (context.length) payload.context = context;
          chrome.tabs.sendMessage(tabId, payload, () => {
            const sendErr = chrome.runtime.lastError;
            if (sendResponse) {
              if (sendErr) {
                const msg = String(sendErr.message || sendErr);
                if (/message port closed before a response was received/i.test(msg)) {
                  sendResponse({ ok: true });
                } else {
                  sendResponse({ ok: false, error: msg });
                }
              } else {
                sendResponse({ ok: true });
              }
            }
          });
        } catch (e) {
          if (sendResponse) sendResponse({ ok: false, error: e?.message || String(e) });
        }
      });
      return true; // async
    }
    case "forceDomHighlightCleanup": {
      const tabId = typeof msg.tabId === 'number' ? msg.tabId : null;
      if (!tabId) {
        if (sendResponse) sendResponse({ ok: false, error: 'invalid-tab' });
        return false;
      }
      ensureContentListener(tabId, (ok) => {
        if (ok) safeSend(tabId, { event: 'domHighlightForceCleanup' });
        if (sendResponse) sendResponse({ ok });
      });
      return true; // async
    }
    case "captureDomHighlight": {
      const tabId = typeof msg.tabId === 'number' ? msg.tabId : null;
      if (!tabId) {
        if (sendResponse) sendResponse({ ok: false, error: 'invalid-tab' });
        return false;
      }
      ensureContentListener(tabId, (ok, err) => {
        if (!ok) {
          if (sendResponse) sendResponse({ ok: false, error: err || 'inject-failed' });
          return;
        }
        try {
          chrome.tabs.sendMessage(tabId, { command: "getDomHighlightSnippet" }, (resp) => {
            const sendErr = chrome.runtime.lastError;
            if (sendResponse) {
              if (sendErr) {
                sendResponse({ ok: false, error: String(sendErr.message || sendErr) });
              } else if (!resp) {
                sendResponse({ ok: false, error: 'no-response' });
              } else {
                sendResponse(resp);
              }
            }
          });
        } catch (e) {
          if (sendResponse) sendResponse({ ok: false, error: e?.message || String(e) });
        }
      });
      return true; // async
    }
    case "stopAllMics": {
      const currentId = sender && sender.tab ? sender.tab.id : null;
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach((t) => {
          // Stop mic everywhere
          safeSend(t.id, { command: "stop" });
          const isCurrent = currentId !== null && t.id === currentId;
          // Enforce single active tab state: only the sender remains enabled
          micEnabledTabs.set(t.id, !!isCurrent);
          setBadge(t.id, !!isCurrent);
          broadcastMicState(t.id, !!isCurrent);
        });
        sendResponse();
      });
      return true; // async
    }
    case "disableAll":
      disableAllMics();
      sendResponse();
      return true;
    case "getHtmlDomLayoutEnabled": {
      try {
        chrome.storage.local.get(['htmlDomLayoutEnabled'], (d) => {
          sendResponse({ enabled: !!(d && d.htmlDomLayoutEnabled) });
        });
      } catch (e) {
        sendResponse({ enabled: false });
      }
      return true;
    }
    case "setHtmlDomLayoutEnabled": {
      const enabled = !!msg.enabled;
      // Best-effort persist; do not fail if storage permission missing
      try { chrome.storage?.local?.set && chrome.storage.local.set({ htmlDomLayoutEnabled: enabled }, () => {}); } catch {}
      // Prefer explicit tabId from Admin request
      if (typeof msg.tabId === 'number') {
        sendHtmlDomLayoutToTab(msg.tabId, enabled, sendResponse);
        return true; // async
      }
      const targetId = getMicEnabledTabId();
      if (targetId != null) {
        sendHtmlDomLayoutToTab(targetId, enabled, sendResponse);
        return true; // async
      }
      // Fallback to the active tab in last focused normal window
      const dispatch = (tab) => {
        if (tab && typeof tab.id === 'number') {
          sendHtmlDomLayoutToTab(tab.id, enabled, sendResponse);
        } else {
          sendResponse({ ok: true, enabled, tabId: null });
        }
      };
      if (typeof lastFocusedNormalWindowId === 'number') {
        chrome.tabs.query({ windowId: lastFocusedNormalWindowId, active: true }, (tabs) => dispatch((tabs || [])[0] || null));
        return true; // async
      }
      chrome.windows.getAll({ windowTypes: ["normal"], populate: true }, (wins) => {
        const focused = (wins || []).find(w => w.focused) || (wins || [])[0];
        const tab = (focused && Array.isArray(focused.tabs)) ? focused.tabs.find(t => t.active) : null;
        dispatch(tab || null);
      });
      return true;
    }
    case "getMicEnabledTab": {
      const id = getMicEnabledTabId();
      if (id == null) { sendResponse({ tab: null }); return false; }
      chrome.tabs.get(id, (tab) => {
        if (chrome.runtime.lastError || !tab) { sendResponse({ tab: null }); return; }
        sendResponse({ tab: { id: tab.id, title: tab.title, url: tab.url, windowId: tab.windowId } });
      });
      return true; // async
    }
    default:
      break;
  }
  // Also capture content-script events for logging and state sync
  if (msg && msg.event && sender && sender.tab && typeof sender.tab.id === 'number') {
    if (msg.event === 'stt') recordLog(sender.tab.id, 'you', msg.text || '', msg.tokens, msg.chars);
    if (msg.event === 'llm') recordLog(sender.tab.id, 'assistant', msg.text || '', msg.tokens, msg.chars);
    if (msg.event === 'system' && msg.type === 'mic') {
      const enabled = msg.state === 'enabled';
      const tabId = sender.tab.id;
      micEnabledTabs.set(tabId, enabled);
      setBadge(tabId, enabled);
      broadcastMicState(tabId, enabled);
      // Persist a system message so it appears in the user popup log
      if (!enabled) recordLog(tabId, 'system', 'Mic was stopped', 0, 0);
      else recordLog(tabId, 'system', 'Mic enabled', 0, 0);
    }
  }
});

// Cleanup state when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
  micEnabledTabs.delete(tabId);
  domHighlightTabs.delete(tabId);
  if (userPopupTabs.has(tabId)) {
    const entry = userPopupTabs.get(tabId);
    userPopupTabs.delete(tabId);
    if (entry && typeof entry.popupTabId === 'number') {
      popupAnchorByTabId.delete(entry.popupTabId);
      try { chrome.tabs.remove(entry.popupTabId); } catch {}
    }
  }
  if (popupAnchorByTabId.has(tabId)) {
    const anchorId = popupAnchorByTabId.get(tabId);
    popupAnchorByTabId.delete(tabId);
    if (typeof anchorId === 'number') {
      userPopupTabs.delete(anchorId);
    }
  }
});

// Context menu on the toolbar icon: global off
chrome.runtime.onInstalled.addListener(() => {
  loadDomLiftScale(() => ensureContextMenus());
  configureSidePanelBehavior().catch(() => {});
});

chrome.runtime.onStartup && chrome.runtime.onStartup.addListener(() => {
  loadDomLiftScale(() => ensureContextMenus());
  configureSidePanelBehavior().catch(() => {});
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "heyNano.disableAll") {
    disableAllMics();
  }
  if (info.menuItemId === "heyNano.adminPanel") {
    const url = chrome.runtime.getURL('admin_popup.html');
    chrome.windows.create({ url, type: 'popup', width: 820, height: 680 }, (win) => {
      if (win && typeof win.id === 'number') {
        adminWindowId = win.id;
        try { chrome.storage.local.set({ heyNanoAdminWindowId: adminWindowId }); } catch {}
      }
    });
  }

  // Removed dom lift reset menu option
});

// Track the last focused normal window to scope listTabs correctly
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.windows.get(windowId, { populate: false }, (win) => {
    if (chrome.runtime.lastError) return;
    if (win && win.type === 'normal') {
      lastFocusedNormalWindowId = win.id;
    }
  });
});

// User popup now lives in a companion tab (split beside the active tab when available)

// Keyboard shortcut: toggle mic for active tab
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-mic') return;
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const tab = tabs[0];
    if (!tab) return;
    const tabId = tab.id;
    const enabled = !!micEnabledTabs.get(tabId);
    if (enabled) {
      disableMicForTab(tabId);
    } else {
      await enableMicForTab(tabId);
      // Open/focus detached user popup on hotkey enable
      await openOrFocusUserPopup(tab);
    }
  });
});

// Restore Admin Panel after reloads if it was open previously
async function restoreAdminPanelIfNeeded() {
  try {
    chrome.storage.local.get(['heyNanoAdminWindowId'], (data) => {
      const storedId = data && typeof data.heyNanoAdminWindowId === 'number' ? data.heyNanoAdminWindowId : null;
      if (!storedId) return;
      adminWindowId = storedId;
      chrome.windows.get(storedId, { populate: true }, (win) => {
        if (chrome.runtime.lastError || !win) {
          // Re-open if window missing
          const url = chrome.runtime.getURL('admin_popup.html');
          chrome.windows.create({ url, type: 'popup', width: 820, height: 680 }, (nw) => {
            if (nw && typeof nw.id === 'number') {
              adminWindowId = nw.id;
              try { chrome.storage.local.set({ heyNanoAdminWindowId: adminWindowId }); } catch {}
            }
          });
          return;
        }
        // Window exists (likely navigated to New Tab after reload). Ensure a tab points to admin_popup.html
        const url = chrome.runtime.getURL('admin_popup.html');
        const tab = (win.tabs && win.tabs[0]) ? win.tabs[0] : null;
        if (tab && typeof tab.id === 'number') {
          chrome.tabs.update(tab.id, { url }, () => {
            chrome.windows.update(win.id, { focused: true });
          });
        }
      });
    });
  } catch {}
}

chrome.runtime.onInstalled.addListener(() => {
  configureSidePanelBehavior();
  restoreAdminPanelIfNeeded();
});

// Clear stored id when the admin window truly closes (not on reload)
chrome.windows.onRemoved.addListener((winId) => {
  if (adminWindowId && winId === adminWindowId) {
    adminWindowId = null;
    try { chrome.storage.local.remove('heyNanoAdminWindowId'); } catch {}
  }
});

// Handle registration from admin_popup.js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.command === 'registerAdminWindow' && typeof msg.windowId === 'number') {
    adminWindowId = msg.windowId;
    try { chrome.storage.local.set({ heyNanoAdminWindowId: adminWindowId }); } catch {}
    sendResponse && sendResponse({ ok: true });
    return true;
  }
});
