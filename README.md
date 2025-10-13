# Hey Mic

Hey Mic is a Chrome extension that enables hands-free voice interaction with your browser tabs using speech recognition and a local language model (LLM) if available.

## Features

- Voice Activation: Activate the microphone in the current tab and transcribe your speech.
- Toolbar Toggle: Click the Hey Mic toolbar icon to enable/disable the mic on the current tab. A badge shows "On" when enabled.
- Single Mic Guarantee: Only one tab can have the mic active at a time. Activating the mic on a tab turns it off everywhere else automatically.
- User Popup: A detached window shows your live speech transcription and assistant replies. It opens or focuses automatically when you enable the mic via toolbar, hotkey, or Admin.
- Admin Panel: Open it from the right-click menu for power controls:
  - Open Tab: type a URL or domain and open it in a new tab.
  - List Tabs: show tab IDs, titles, and URLs.
  - Mic Toggle: enable/disable mic for the current tab.
  - Shortcut: Alt+Shift+M toggles the mic for the active tab. You can change it at `chrome://extensions/shortcuts`.
- Tab Management by Voice:
  - List all open tabs by saying "list tabs".
  - Switch to any tab by saying "switch to tab N" (where N is the tab number from the list).
- AI Assistant: Your speech is sent to a local LLM (if available) for intelligent responses, using the current page's context.
- Open Websites by Voice: Say a specific URL or a well-known site (e.g., "open youtube.com" or "open YouTube"). Saying just "open" or "open it" will not open anything; the assistant asks you to clarify.
- Automatic Mic Control: Only the active tab listens; switching tabs or activating the extension stops the mic in other tabs.
- Global Off (Context Menu): Right-click the Hey Mic toolbar icon and choose "Turn off Hey Mic on all tabs" to instantly stop and disable the mic everywhere.
- Speech-to-Text Error Correction: Common misrecognitions like "tap" instead of "tab" are automatically corrected in tab commands.

## How to Use

1. Install the Extension:
   - Load the extension in Chrome via `chrome://extensions` (enable Developer Mode, then "Load unpacked" and select this folder).

2. Activate the Extension:
   - Click the Hey Mic icon to open the User Popup; it shows your speech and the assistant's replies in real time.
   - To manage tabs or mic globally, use the Admin Panel (right-click menu).
   - To disable everywhere, right-click the Hey Mic icon and choose "Turn off Hey Mic on all tabs".
   - Or use the keyboard: press Alt+Shift+M to toggle the mic for the active tab (configurable at `chrome://extensions/shortcuts`).

3. Give Voice Commands:
   - Say "list tabs" to see all open tabs in the console.
   - Say "switch to tab 2" to switch to the second tab.
   - Ask questions or give commands; the assistant will respond in the console.
   - Ask to open a website (e.g., "Open github.com") and it will open in a new tab.

4. Stop Listening:
   - Say "stop" or "stop listening" to disable the microphone.

### Right-click Menu

- Turn off Hey Mic on all tabs
- Open Admin Panel (opens controls in a separate popup window)
- Highlight DOM/HTML (toggles visual grid, element outlines, and DOM lift on the current page)

## Requirements

- Chrome Browser with support for Manifest V3 and the Web Speech API.
- Microphone Access must be granted.
- For LLM features, your browser must support either the experimental `window.LanguageModel` API or Chrome’s Web AI APIs exposed as `window.ai` (Prompt API / Language Model). The extension will use `LanguageModel` first when present, and fall back to `window.ai` when available.

## Speech Adapter (STT/TTS)

- File: `speech_adapter.js`
- Purpose: Central adapter for Speech-to-Text (STT) and Text-to-Speech (TTS) providers.
- Default STT: Web Speech API (browser built-in). Falls back to legacy path if the adapter is unavailable.
- Default TTS: Web Speech API `speechSynthesis`.

How it is used
- The content script (`content.js`) now prefers the adapter path. If `window.HeyMicSpeech` is available, it creates an STT engine via `HeyMicSpeech.createSTT({ provider: 'web-speech', lang: 'en-US' })` and streams transcripts into the existing command pipeline and LLM.
- The background script injects the adapter before `content.js`: see `background.js` where `speech_adapter.js` is injected ahead of other scripts.

Extending to other providers
- The adapter is designed to support pluggable providers. Today it ships with the `web-speech` STT/TTS implementation and placeholder hooks for others.
- Potential providers you can add next:
  - `openai-whisper` (cloud STT, batches or streaming). Recommended to run fetches in `background.js` to avoid CORS and to keep API keys off the page. Add a new provider branch inside `createSTT()` that proxies audio or chunks to a background endpoint.
  - `gpt-plus` (OpenAI TTS like `tts-1`). Add a `tts` provider that sends text to the background script, which calls the API and streams audio to the page.
  - `claude` (Anthropic), `gemini` (Google) for TTS/STT as available. Same pattern: implement in adapter, proxy requests via `background.js` using stored keys (e.g., `chrome.storage`), and return transcripts/audio.

Implementation notes
- MV3 best practice: Do network/API calls from `background.js` and message results to the content script. The adapter can expose a provider that internally uses `chrome.runtime.sendMessage` to the background for API requests.
- Keys and settings: Store provider selection and API keys in `chrome.storage` (e.g., via the Admin Panel), and have the adapter read them or request them on start.
- Streaming vs. non-streaming: The current adapter restarts Web Speech on `onend` automatically. For external STT, decide between full-utterance or partials and unify via the `onResult` callback.

Simple usage (already wired up)
- STT: `window.HeyMicSpeech.createSTT({ provider: 'web-speech', lang: 'en-US' }).start({ onResult })`
- TTS: `window.HeyMicSpeech.tts.speak('Hello!', { provider: 'web-speech', lang: 'en-US' })`

File changes in this update
- Added `speech_adapter.js` with `HeyMicSpeech` global (STT/TTS adapter).
- Updated `content.js` to prefer adapter-based STT; legacy Web Speech path remains as fallback.
- Updated `background.js` to inject `speech_adapter.js` before `content.js` and `voice_commands.js`.

## Limitations

- The assistant's responses and tab management are logged to the browser console.
- LLM features require browser AI support (LanguageModel or Web AI via `window.ai`), which may be experimental and not available in all browsers.
- The Admin Panel focuses on quick controls; voice interactions still log to the page console.

### About DevTools AI

- Chrome’s DevTools AI (the assistant inside DevTools) is not exposed as a public extension API. This extension cannot call DevTools AI directly.
- Instead, this project integrates with Chrome’s on‑device/web AI surfaces (LanguageModel or Web AI `window.ai`) when available. Enable related experimental features in Chrome if needed.

## Security

- Only minimal tab information (title, URL, id) is used for tab management.
- No data is sent to external servers unless required by the browser's LLM implementation.

---

Enjoy hands-free browsing with Hey Mic!

## How to Add Voice Commands

- Edit `voice_commands.js` only. Add a new entry to the array returned by `getCommandRegistry(ctx)` with:
  - `id`: short unique id (e.g., `close-tab`).
  - `match(transcript)`: pure parser; return truthy (or data) when it matches, otherwise `null`.
  - `execute({ match, transcript })`: perform the action using `ctx.sendMessage({ command: '...' })` or `ctx.stopMic()`.
- If your command needs a new browser action, add a handler for it in `background.js` (e.g., `closeActiveTab`).
- No changes are needed in `content.js`; it already dispatches commands from the registry.

Example next command (outline)
- Close current tab:
  - `voice_commands.js` — add `isCloseTab()` and a registry entry with `match/execute`.
  - `background.js` — add `closeActiveTab` that finds and closes the active tab.
  - `content.js` — no changes.

## Roadmap

- Completed
  - 2025-10-09: Detached User Popup window opens/focuses when mic is enabled via toolbar, hotkey, or Admin; toolbar popup removed from manifest for cleaner behavior.
  - 2025-10-09: Admin widget “Highlight HTML/DOM Layout” now mirrors toolbar behavior, works without mic, targets the active tab, and logs success/errors in the Admin console.
  - 2025-10-09: DOM tools upgraded: per‑element Pin/Unpin (multi‑pin supported), pinned elements stay in place until dragged, pinned elements are draggable, panel uses black styling and is draggable when pinned, and hover‑preview remains active while items are pinned.
  - 2025-10-09: Toolbar context menu simplified: removed Lift Intensity, Increase/Decrease, and Reset entries; kept Highlight DOM/HTML, Admin Panel, and Global Off.
  - 2025-10-08: Speech Adapter (STT/TTS) added (`speech_adapter.js`) and `content.js` refactored to use adapter-based STT with Web Speech fallback.
  - 2025-10-08: Admin Panel “Supported Voice Commands” converted to a table and auto-generated from the registry, including descriptions.
  - 2025-10-08: New voice command “Close Tab N” with robust synonyms (e.g., “close tab #3”, “close the second tab”).
  - 2025-10-08: Expanded stop-intent parsing (accepts “turn off mic”, “disable microphone”, etc.).
  - 2025-10-08: LLM invocation gated to avoid “LLM not available” logs when API/session is absent.
  - Prior: User Popup for live speech and assistant replies
  - Prior: Admin Panel with Global Off, List Tabs, Open URL, Mic Toggle
  - Prior: Single-mic guarantee with toolbar badge + keyboard shortcut sync
  - Prior: Direct site opening from speech; no default on ambiguous 'open'
  - Prior: Popups reflect mic state; voice 'stop recording' syncs UI
  - Prior: Voice command registry in `voice_commands.js` (extensible)
  - Prior: Token/character counters and context window usage in User Popup
  - Prior: Improved tab list rendering in Admin Panel (wrapped, scrollable)

- Next Ideas
  - Provider plug‑ins in adapter: OpenAI Whisper STT, GPT+ TTS (proxied via `background.js` with secure key storage).
  - Settings UI in Admin Panel for provider selection, API keys, language, and TTS voice preferences.
  - Streaming partial transcripts and incremental command matching.
  - Customer‑configurable voice commands (storage‑backed override/extend the registry).
