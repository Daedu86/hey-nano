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
  const meta = document.createElement('div');
  meta.className = 'meta';
  const when = ts ? new Date(ts).toLocaleTimeString() : '';
  const parts = [role === 'you' ? 'You' : (role === 'assistant' ? 'Assistant' : 'System')];
  if (when) parts.push(when);
  if (typeof tokens === 'number') parts.push(`${tokens} tok`);
  if (typeof chars === 'number') parts.push(`${chars} chars`);
  meta.textContent = parts.join(' • ');
  const body = document.createElement('div');
  body.className = 'text';
  body.textContent = text || '';
  el.appendChild(meta);
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
  el.textContent = parts.join(' • ');
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

async function toggleMicForTarget(desiredState) {
  const toggle = document.getElementById('toggleMic');
  const target = await getTargetTab();
  if (!target) {
    if (toggle instanceof HTMLInputElement) toggle.checked = !desiredState;
    appendMsg('system', 'No active tab detected. Open a page and try again.', Date.now(), 0, 0);
    return;
  }
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

  const target = await getTargetTab();
  if (!target) {
    appendMsg('system', 'No active tab detected. Open a page and try again.', Date.now(), 0, 0);
    return;
  }

  if (sendBtn) sendBtn.disabled = true;
  input.disabled = true;

  try {
    chrome.runtime.sendMessage({ command: 'typedInput', tabId: target.id, text }, (resp) => {
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
  let target = await getTargetTab();
  // Load context window limits
  chrome.runtime.sendMessage({ command: 'getContextLimits' }, (resp) => {
    if (resp && typeof resp.windowTokens === 'number') windowTokens = resp.windowTokens;
    updateContextBanner();
  });
  if (target) {
    chrome.runtime.sendMessage({ command: 'getMicState', tabId: target.id }, (res) => setMicButtonState(!!res?.enabled));
    chrome.runtime.sendMessage({ command: 'getConversationLog', tabId: target.id }, (resp) => {
      const log = resp?.log || [];
      hydrateLog(log);
      recalcUsageFromLog(log);
    });
  } else {
    setMicButtonState(false);
  }

  // Toggle handler acts on the current active target tab (same as keyboard)
  const toggleControl = document.getElementById('toggleMic');
  if (toggleControl instanceof HTMLInputElement) {
    toggleControl.addEventListener('change', () => {
      toggleMicForTarget(toggleControl.checked);
    });
  } else {
    toggleControl?.addEventListener('click', async () => {
      const t = await getTargetTab();
      if (!t) return;
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

  const addContextBtn = document.getElementById('addContextBtn');
  addContextBtn?.addEventListener('click', () => {
    try {
      chrome.runtime.sendMessage({ event: 'addContextRequested' });
    } catch {}
  });

  // Live updates: capture STT/LLM from the active target tab, and mic state globally
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.event === 'micStateChanged') {
      // Refresh target and update state if this event pertains to it
      getTargetTab().then((current) => {
        target = current || target;
        if (!target) return;
        if (msg.tabId === target.id) setMicButtonState(!!msg.enabled);
      });
      return;
    }
    if (!sender?.tab?.id) return;
    if (!target || sender.tab.id !== target.id) return;
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
      }
    }
  });
});
