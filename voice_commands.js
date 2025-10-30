// Voice command microservice: parsing + helpers
// Exposes window.HeyNanoCommands with pure functions used by content.js

(function () {
  if (window.HeyNanoCommands) return;

  /**
   * normalizeTabCommand
   * Description: Cleans up common STT (speech-to-text) misrecognitions for tab-related commands.
   * - "tap" -> "tab"
   * - "dot" -> "." (useful for domains like "youtube dot com")
   * - Normalizes phrases like "switch to tap 3" -> "switch to tab 3"
   * Input: raw transcript string
   * Output: normalized transcript string
   */
  function normalizeTabCommand(s) {
    return (s || "")
      .replace(/\b dot \b/gi, ".")
      .replace(/(switch|go|move) to tap (\d+)/gi, "$1 to tab $2")
      .replace(/list (all )?taps/gi, "list tabs")
      .replace(/\btap (\d+)/gi, "tab $1");
  }

  /**
   * isStopCommand
   * Description: Detects requests to stop the microphone.
   * Triggers on: "stop", "stop listening", "stop recording", "stop recognition" (case-insensitive)
   * Returns: boolean
   */
  function isStopCommand(input) {
    const s = String(input || "").toLowerCase().trim();
    if (!s) return false;
    // Remove common filler words
    const normalized = s
      .replace(/\b(please|now|the|hey|ok|okay|so)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (normalized === "stop") return true;
    // Accept broader phrasings: "stop/turn off/disable" + target word anywhere
    return /\b(stop|turn off|disable)\b.*\b(mic|microphone|listening|recording|recognition)\b/i.test(normalized)
      || /\b(stop (listening|recording|recognition))\b/i.test(normalized);
  }

  /**
   * isListTabs
   * Description: Detects requests to list all open tabs.
   * Triggers on: "list tabs" / "list all tabs" (case-insensitive)
   * Returns: boolean
   */
  function isListTabs(s) {
    return /list (all )?tabs/i.test(s || "");
  }

  /**
   * getSwitchTabIndex
   * Description: Extracts the intended tab index from commands like "switch to tab 3".
   * Notes: Returns a zero-based index; -1 means no valid index was found.
   * Examples: "switch to tab 2" -> 1; "go to tab 10" -> 9
   */
  function getSwitchTabIndex(s) {
    const m = (s || "").match(/(?:switch|go|move) to tab (\d+)/i);
    if (!m) return -1;
    const idx = parseInt(m[1], 10) - 1;
    return Number.isFinite(idx) && idx >= 0 ? idx : -1;
  }

  /**
   * getCloseTabIndex
   * Description: Extracts the intended tab index from phrases like:
   *   - "close tab 3"
   *   - "close tab number 3" / "close tab no. 3" / "close tab #3"
   *   - "close the 2nd tab" / "close the 3rd tab"
   *   - "close the second tab" (ordinal words)
   *   - "close tab two" (cardinal words)
   * Notes: Returns a zero-based index; -1 means no valid index was found.
   */
  function getCloseTabIndex(s) {
    const text = String(s || '').trim();
    if (!text) return -1;
    const low = text.toLowerCase();

    const ordWords = {
      first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
      sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
      eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15,
      sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20,
    };
    const cardWords = {
      one: 1, two: 2, three: 3, four: 4, five: 5,
      six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
      eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
      sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
    };

    const toIndex = (n) => (Number.isFinite(n) && n > 0 ? n - 1 : -1);

    // Pattern A: close tab [number|no.|#] N or close tab N
    let m = low.match(/\bclose\s+tab\s+(?:(?:number|no\.?|#)\s*)?(\d+)\b/i);
    if (m) return toIndex(parseInt(m[1], 10));

    // Pattern B: close the Nth tab (with 1st/2nd/3rd/4th...)
    m = low.match(/\bclose\s+(?:the\s+)?(\d+)(?:st|nd|rd|th)\s+tab\b/i);
    if (m) return toIndex(parseInt(m[1], 10));

    // Pattern C: close the <ordinal-word> tab
    m = low.match(/\bclose\s+(?:the\s+)?([a-z]+)\s+tab\b/i);
    if (m && ordWords[m[1]]) return toIndex(ordWords[m[1]]);

    // Pattern D: close tab <cardinal-word>
    m = low.match(/\bclose\s+tab\s+([a-z]+)\b/i);
    if (m && cardWords[m[1]]) return toIndex(cardWords[m[1]]);

    return -1;
  }

  /**
   * extractUrlFromSpeech
   * Description: Resolves a navigation target (URL/domain) from speech commands.
   * Behavior:
   * - If a full URL is present (http/https), returns it.
   * - If the user says a known alias after a navigation verb (e.g., "open YouTube"), returns its URL.
   * - If the user says a domain after a navigation verb (e.g., "open github.com" or "open github dot com"), returns it as https://domain.
   * - If no navigation verb is present, or target is missing/ambiguous, returns null.
   * Returns: string URL or null
   * Aliases: youtube, google, gmail, github, reddit, wikipedia, twitter, x, linkedin
   */
  function extractUrlFromSpeech(input) {
    const s = (input || "").trim();
    const low = s.toLowerCase();

    // Explicit URL present
    const urlMatch = s.match(/https?:\/\/[^\s]+/i);
    if (urlMatch) return urlMatch[0];

    // Known site aliases
    const aliases = {
      youtube: "https://www.youtube.com",
      google: "https://www.google.com",
      gmail: "https://mail.google.com",
      github: "https://github.com",
      reddit: "https://www.reddit.com",
      wikipedia: "https://en.wikipedia.org",
      twitter: "https://twitter.com",
      x: "https://x.com",
      linkedin: "https://www.linkedin.com",
    };

    // Require an explicit navigation verb to consider opening
    const verb = /\b(open|go to|navigate to|visit)\b/i.test(low);
    if (!verb) return null;

    // Alias after verb (e.g., "open youtube")
    for (const key of Object.keys(aliases)) {
      const re = new RegExp(`\\b(open|go to|navigate to|visit)\\s+(${key})\\b`, "i");
      if (re.test(low)) return aliases[key];
    }

    // Domain after verb (handles "youtube.com" and "youtube dot com")
    const normalized = low.replace(/\b dot \b/g, ".");
    const domMatch = normalized.match(/\b(?:open|go to|navigate to|visit)\s+([a-z0-9.-]+\.[a-z]{2,})(?:\b|\/|\s|$)/i);
    if (domMatch) {
      const d = domMatch[1];
      return /^https?:\/\//i.test(d) ? d : `https://${d}`;
    }
    return null;
  }

  // Public API
  // Title: HeyNanoCommands — Voice command helpers used across the extension
  // Description: Pure functions for parsing and normalizing voice commands
  function getCommandRegistry(ctx) {
    return [
      {
        id: 'stop-mic',
        title: 'Stop Mic',
        description: 'Stop recording/listening/recognition',
        triggers: [
          'stop',
          'stop listening',
          'stop recording',
          'stop recognition',
          'turn off mic',
          'disable microphone',
        ],
        match: (s) => (isStopCommand(s) ? true : null),
        execute: async () => { if (ctx && typeof ctx.stopMic === 'function') ctx.stopMic(); },
      },
      {
        id: 'close-tab',
        title: 'Close Tab',
        description: 'Close tab by position (e.g., "close tab 2")',
        triggers: [
          'close tab N',
        ],
        match: (s) => {
          const idx = getCloseTabIndex(s);
          return idx >= 0 ? { index: idx } : null;
        },
        execute: async ({ match }) => {
          if (!ctx || !ctx.sendMessage) return;
          const index = match.index;
          ctx.sendMessage({ command: 'listTabs' }, (response) => {
            const tabs = response?.tabs || [];
            const t = tabs[index];
            if (t && typeof t.id === 'number') ctx.sendMessage({ command: 'closeTab', tabId: t.id });
            else try { console.warn('No tab at that index.'); } catch {}
          });
        },
      },
      {
        id: 'list-tabs',
        title: 'List Tabs',
        description: 'List all open tabs in the current window',
        triggers: [
          'list tabs',
          'list all tabs',
        ],
        match: (s) => (isListTabs(s) ? true : null),
        execute: async () => {
          if (!ctx || !ctx.sendMessage) return;
          ctx.sendMessage({ command: 'listTabs' }, (response) => {
            const tabs = response?.tabs || [];
            try {
              console.log('Open tabs:');
              tabs.forEach((tab, idx) =>
                console.log(`#${idx + 1}: ${tab.title} (${tab.url}) [tabId: ${tab.id}]`)
              );
            } catch {}
          });
        },
      },
      {
        id: 'switch-tab',
        title: 'Switch Tab',
        description: 'Switch to tab by position (e.g., "switch to tab 2")',
        triggers: [
          'switch to tab N',
          'go to tab N',
          'move to tab N',
        ],
        match: (s) => {
          const idx = getSwitchTabIndex(s);
          return idx >= 0 ? { index: idx } : null;
        },
        execute: async ({ match }) => {
          if (!ctx || !ctx.sendMessage) return;
          const index = match.index;
          ctx.sendMessage({ command: 'listTabs' }, (response) => {
            const tabs = response?.tabs || [];
            const t = tabs[index];
            if (t && typeof t.id === 'number') ctx.sendMessage({ command: 'switchTab', tabId: t.id });
            else try { console.warn('No tab at that index.'); } catch {}
          });
        },
      },
      {
        id: 'open-url',
        title: 'Open URL',
        description: 'Open a website by URL/domain/alias (e.g., "open youtube.com")',
        triggers: [
          'open <domain|URL|alias>',
          'open youtube.com',
          'open YouTube',
        ],
        match: (s) => {
          const url = extractUrlFromSpeech(s);
          return url ? { url } : null;
        },
        execute: async ({ match }) => {
          if (!ctx || !ctx.sendMessage) return;
          const url = match.url;
          ctx.sendMessage({ command: 'openTab', url });
          try { console.log('Assistant:', `Opening ${url} now.`); } catch {}
        },
      },
      {
        id: 'close-tab',
        title: 'Close Tab',
        description: 'Close tab by position (e.g., "close tab 2")',
        triggers: [
          'close tab N',
          'close tab number N',
          'close tab no. N',
          'close tab #N',
          'close the Nth tab',
          'close the <ordinal> tab',
        ],
        match: (s) => {
          const idx = getCloseTabIndex(s);
          return idx >= 0 ? { index: idx } : null;
        },
        execute: async ({ match }) => {
          if (!ctx || !ctx.sendMessage) return;
          const index = match.index;
          ctx.sendMessage({ command: 'listTabs' }, (response) => {
            const tabs = response?.tabs || [];
            const t = tabs[index];
            if (t && typeof t.id === 'number') ctx.sendMessage({ command: 'closeTab', tabId: t.id });
            else try { console.warn('No tab at that index.'); } catch {}
          });
        },
      },
    ];
  }

  function getSupportedCommandsTable() {
    try {
      const reg = getCommandRegistry();
      return (reg || []).map((c) => ({
        action: c.title || c.id,
        triggers: Array.isArray(c.triggers) ? c.triggers : [],
        description: c.description || '',
      }));
    } catch (e) {
      return [];
    }
  }

  window.HeyNanoCommands = {
    normalizeTabCommand,
    isStopCommand,
    isListTabs,
    getSwitchTabIndex,
    getCloseTabIndex,
    extractUrlFromSpeech,
    getCommandRegistry,
    getSupportedCommandsTable,
  };
})();
