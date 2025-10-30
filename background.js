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

function prepareSidePanelForTab(tabId) {
  if (!sidePanelAvailable || typeof tabId !== 'number') return;
  try {
    chrome.sidePanel.setOptions({ tabId, path: POPUP_HTML_PATH, enabled: true }, () => {
      void chrome.runtime?.lastError;
    });
  } catch {}
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
      (tabs || []).forEach((t) => prepareSidePanelForTab(t.id));
    });
  } catch {}
}

configureSidePanelBehavior().catch(() => {});

if (sidePanelAvailable) {
  if (chrome.tabs && typeof chrome.tabs.onCreated?.addListener === 'function') {
    chrome.tabs.onCreated.addListener((tab) => {
      if (tab && typeof tab.id === 'number') prepareSidePanelForTab(tab.id);
    });
  }
  if (chrome.tabs && typeof chrome.tabs.onUpdated?.addListener === 'function') {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo && changeInfo.status === 'complete') prepareSidePanelForTab(tabId);
    });
  }
  if (chrome.tabs && typeof chrome.tabs.onReplaced?.addListener === 'function') {
    chrome.tabs.onReplaced.addListener((addedTabId) => {
      prepareSidePanelForTab(addedTabId);
    });
  }
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
function openOrFocusUserPopup(anchorTab) {
  if (sidePanelAvailable) {
    const openSidePanelForTab = async (tab) => {
      if (!tab || typeof tab.id !== 'number') return false;
      try {
        await chrome.sidePanel.setOptions({ tabId: tab.id, path: POPUP_HTML_PATH, enabled: true });
        await chrome.sidePanel.open({ tabId: tab.id });
        return true;
      } catch {
        return false;
      }
    };

    const dispatch = (tab) => {
      if (!tab || typeof tab.id !== 'number') return;
      openSidePanelForTab(tab);
    };

    if (anchorTab && typeof anchorTab.id === 'number') {
      dispatch(anchorTab);
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const active = (tabs || [])[0] || null;
      if (active) {
        dispatch(active);
        return;
      }
      chrome.windows.getAll({ windowTypes: ["normal"], populate: true }, (wins) => {
        const focused = (wins || []).find(w => w.focused) || (wins || [])[0] || null;
        const tab = (focused && Array.isArray(focused.tabs)) ? focused.tabs.find(t => t.active) : null;
        if (tab) dispatch(tab);
      });
    });
    return;
  }

  openOrFocusUserPopupLegacy(anchorTab);
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
  if (typeof tabId !== 'number') return;
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    openOrFocusUserPopup(tab);
  });
}

function ensureContextMenus() {
  // Rebuild menus from scratch to avoid duplicate-id errors
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "heyNano.disableAll", title: "Turn off Hey Nano on all tabs", contexts: ["action"] });
    chrome.contextMenus.create({ id: "heyNano.adminPanel", title: "Open Admin Panel", contexts: ["action"] });
    chrome.contextMenus.create({ id: "heyNano.toggleDomHighlight", title: "Highlight DOM/HTML", contexts: ["action"] });
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
  "You are a helpful assistant embedded in a browser extension that supports voice commands. " +
  "Respond in English by default. " +
  "When asked about your capabilities, mention both your language abilities (summarize, generate text, explain) and that the extension can execute certain browser actions via supported voice commands. " +
  "Navigation policy: Only ask 'Which site should I open?' when the user utterance includes a navigation verb (open/go to/navigate to/visit) but lacks a specific target. " +
  "Only confirm opening a website when the user includes a specific URL or a well-known site name. " +
  "Never claim you cannot open external websites; the extension performs actions when the user's speech matches a supported voice command. " +
  "Do not fabricate actions."
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
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete" && tabId === activeTabId) {
    if (micEnabledTabs.get(tabId)) safeSend(tabId, { command: "activate" });
  }
});

// Toolbar click: inject content and activate
chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab.id;
  const currentlyEnabled = !!micEnabledTabs.get(tabId);
  if (currentlyEnabled) {
    disableMicForTab(tabId);
  } else {
    await enableMicForTab(tabId);
    // Open/focus user popup when enabling via toolbar
    openOrFocusUserPopup(tab);
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
        enableMicForTab(msg.tabId).then(() => {
          // Open/focus detached user popup when enabling via Admin panel
          openOrFocusUserPopupForTabId(msg.tabId);
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
      ensureContentListener(tabId, (ok, err) => {
        if (!ok) {
          if (sendResponse) sendResponse({ ok: false, error: err || 'inject-failed' });
          return;
        }
        try {
          chrome.tabs.sendMessage(tabId, { command: "userTypedInput", text: cleaned }, () => {
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
  if (info.menuItemId === "heyNano.toggleDomHighlight") {
    const toggleForTab = (tab) => {
      if (!tab || typeof tab.id !== 'number') return;
      const current = !!domHighlightTabs.get(tab.id);
      const next = !current;
      domHighlightTabs.set(tab.id, next);
      try { chrome.storage.local.set({ htmlDomLayoutEnabled: next }); } catch {}
      // Broadcast immediately so Admin badge updates
      broadcastHtmlDomLayoutState(tab.id, next);
      sendHtmlDomLayoutToTab(tab.id, next, () => {});
    };
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = (tabs || [])[0] || null;
      if (tab) { toggleForTab(tab); return; }
      if (typeof lastFocusedNormalWindowId === 'number') {
        chrome.tabs.query({ windowId: lastFocusedNormalWindowId, active: true }, (t2) => toggleForTab((t2 || [])[0] || null));
        return;
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
      openOrFocusUserPopup(tab);
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
