let activeTabId = null;
// Track per-tab mic enablement toggled by the toolbar button
const micEnabledTabs = new Map(); // tabId -> boolean
let lastFocusedNormalWindowId = null;
// Track Admin Panel window id across reloads
let adminWindowId = null;
// Track detached User Popup window id
let userWindowId = null;
// Track per-tab DOM highlight toggle via toolbar context menu
const domHighlightTabs = new Map(); // tabId -> boolean
let domLiftScale = 1.15; // default lift scale
let menusReady = false;

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
    chrome.contextMenus.update('heyMic.domLiftLevel', { title: `Lift Intensity: ${pct}%` }, () => {
      // ignore lastError if the menu item no longer exists
      void chrome.runtime?.lastError;
    });
  } catch {}
}

// Open or focus the detached user popup window
function openOrFocusUserPopup() {
  try {
    const url = chrome.runtime.getURL('user_popup.html');
    if (userWindowId) {
      chrome.windows.get(userWindowId, { populate: false }, (win) => {
        if (chrome.runtime.lastError || !win) {
          chrome.windows.create({ url, type: 'popup', width: 380, height: 560 }, (nw) => {
            if (nw && typeof nw.id === 'number') userWindowId = nw.id;
          });
        } else {
          chrome.windows.update(userWindowId, { focused: true });
        }
      });
      return;
    }
    chrome.windows.create({ url, type: 'popup', width: 380, height: 560 }, (nw) => {
      if (nw && typeof nw.id === 'number') userWindowId = nw.id;
    });
  } catch (e) {}
}

function ensureContextMenus() {
  // Rebuild menus from scratch to avoid duplicate-id errors
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "heyMic.disableAll", title: "Turn off Hey Mic on all tabs", contexts: ["action"] });
    chrome.contextMenus.create({ id: "heyMic.adminPanel", title: "Open Admin Panel", contexts: ["action"] });
    chrome.contextMenus.create({ id: "heyMic.toggleDomHighlight", title: "Highlight DOM/HTML", contexts: ["action"] });
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

// Broadcast Surprise Me HTML toggle state so Admin widget can sync
function broadcastSurpriseHtmlState(tabId, enabled) {
  try {
    chrome.runtime.sendMessage({ event: 'surpriseHtmlSync', tabId, enabled: !!enabled });
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
        ? "Enable 'Allow access to file URLs' for Hey Mic in chrome://extensions."
        : (blocked && (scheme === 'chrome' || scheme === 'edge' || scheme === 'about'))
          ? 'Cannot inject into browser internal pages (chrome://, edge://, about:).' : (blocked ? err : null);
      if (typeof finalResponse === 'function') finalResponse({ ok: true, enabled, tabId, tabUrl, injected: ok, note: hint });
    });
  });
}

function sendSurpriseHtmlToTab(tabId, enabled, finalResponse) {
  const state = enabled ? 'enabled' : 'disabled';
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      const note = chrome.runtime.lastError && chrome.runtime.lastError.message ? String(chrome.runtime.lastError.message) : 'Tab not found';
      try { broadcastSurpriseHtmlState(tabId, enabled); } catch {}
      if (typeof finalResponse === 'function') return finalResponse({ ok: false, enabled, tabId: null, injected: false, note });
      return;
    }
    const tabUrl = tab && tab.url ? tab.url : '';
    const scheme = (() => { try { return new URL(tabUrl).protocol.replace(':',''); } catch { return ''; } })();
    if (scheme === 'chrome' || scheme === 'edge' || scheme === 'about') {
      broadcastSurpriseHtmlState(tabId, enabled);
      if (typeof finalResponse === 'function') return finalResponse({ ok: true, enabled, tabId, injected: false, note: 'Cannot inject into browser internal pages (chrome://, edge://, about:).' });
      return;
    }
    ensureContentListener(tabId, (ok) => {
      if (ok) {
        safeSend(tabId, { event: 'surpriseHtml', state });
      }
      broadcastSurpriseHtmlState(tabId, enabled);
      if (typeof finalResponse === 'function') finalResponse({ ok: true, enabled, tabId, injected: ok });
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
    openOrFocusUserPopup();
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
                const api = window.HeyMicCommands;
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
          openOrFocusUserPopup();
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
    case "getSurpriseHtmlEnabled": {
      try {
        chrome.storage.local.get(['surpriseHtmlEnabled'], (d) => {
          sendResponse({ enabled: !!(d && d.surpriseHtmlEnabled) });
        });
      } catch (e) {
        sendResponse({ enabled: false });
      }
      return true;
    }
    case "setSurpriseHtmlEnabled": {
      const enabled = !!msg.enabled;
      // Persist preference (global)
      try { chrome.storage?.local?.set && chrome.storage.local.set({ surpriseHtmlEnabled: enabled }, () => {}); } catch {}
      const dispatch = (tab) => {
        if (tab && typeof tab.id === 'number') {
          sendSurpriseHtmlToTab(tab.id, enabled, sendResponse);
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
      return true; // async
    }
    case "askSurpriseOpinion": {
      const dispatch = (tab) => {
        if (tab && typeof tab.id === 'number') {
          ensureContentListener(tab.id, (ok) => {
            if (ok) safeSend(tab.id, { event: 'surpriseOpinion' });
            // Open/focus the detached user popup so the answer is visible immediately
            try { openOrFocusUserPopup(); } catch {}
            sendResponse({ ok });
          });
          return true;
        }
        sendResponse({ ok: false });
        return false;
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
      return true; // async
    }
    case "applyLayoutImprovements": {
      const dispatch = (tab) => {
        if (tab && typeof tab.id === 'number') {
          ensureContentListener(tab.id, (ok) => {
            if (ok) safeSend(tab.id, { event: 'surpriseImprove', action: 'apply' });
            try { openOrFocusUserPopup(); } catch {}
            sendResponse({ ok });
          });
          return true;
        }
        sendResponse({ ok: false });
        return false;
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
      return true; // async
    }
    case "revertLayoutImprovements": {
      const dispatch = (tab) => {
        if (tab && typeof tab.id === 'number') {
          ensureContentListener(tab.id, (ok) => {
            if (ok) safeSend(tab.id, { event: 'surpriseImprove', action: 'revert' });
            sendResponse({ ok });
          });
          return true;
        }
        sendResponse({ ok: false });
        return false;
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
      return true; // async
    }
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
});

// Context menu on the toolbar icon: global off
chrome.runtime.onInstalled.addListener(() => {
  loadDomLiftScale(() => ensureContextMenus());
});

chrome.runtime.onStartup && chrome.runtime.onStartup.addListener(() => {
  loadDomLiftScale(() => ensureContextMenus());
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "heyMic.disableAll") {
    disableAllMics();
  }
  if (info.menuItemId === "heyMic.adminPanel") {
    const url = chrome.runtime.getURL('admin_popup.html');
    chrome.windows.create({ url, type: 'popup', width: 820, height: 680 }, (win) => {
      if (win && typeof win.id === 'number') {
        adminWindowId = win.id;
        try { chrome.storage.local.set({ heyMicAdminWindowId: adminWindowId }); } catch {}
      }
    });
  }
  if (info.menuItemId === "heyMic.toggleDomHighlight") {
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

// removed separate user popup window; overlay is rendered in content.js

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
      openOrFocusUserPopup();
    }
  });
});

// Restore Admin Panel after reloads if it was open previously
async function restoreAdminPanelIfNeeded() {
  try {
    chrome.storage.local.get(['heyMicAdminWindowId'], (data) => {
      const storedId = data && typeof data.heyMicAdminWindowId === 'number' ? data.heyMicAdminWindowId : null;
      if (!storedId) return;
      adminWindowId = storedId;
      chrome.windows.get(storedId, { populate: true }, (win) => {
        if (chrome.runtime.lastError || !win) {
          // Re-open if window missing
          const url = chrome.runtime.getURL('admin_popup.html');
          chrome.windows.create({ url, type: 'popup', width: 820, height: 680 }, (nw) => {
            if (nw && typeof nw.id === 'number') {
              adminWindowId = nw.id;
              try { chrome.storage.local.set({ heyMicAdminWindowId: adminWindowId }); } catch {}
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
  restoreAdminPanelIfNeeded();
});

// Clear stored id when the admin window truly closes (not on reload)
chrome.windows.onRemoved.addListener((winId) => {
  if (adminWindowId && winId === adminWindowId) {
    adminWindowId = null;
    try { chrome.storage.local.remove('heyMicAdminWindowId'); } catch {}
  }
  if (userWindowId && winId === userWindowId) {
    userWindowId = null;
  }
});

// Handle registration from admin_popup.js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.command === 'registerAdminWindow' && typeof msg.windowId === 'number') {
    adminWindowId = msg.windowId;
    try { chrome.storage.local.set({ heyMicAdminWindowId: adminWindowId }); } catch {}
    sendResponse && sendResponse({ ok: true });
    return true;
  }
});
