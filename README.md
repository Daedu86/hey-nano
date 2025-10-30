# Hey Nano

Hey Nano is a Chrome extension that keeps a single microphone session in sync across tabs and pairs it with a sidebar chat UI. Speak or type to the LLM, manage the mic, and control tabs without leaving the current page.

## Highlights
- One-tab-at-a-time mic with a clear ON/OFF badge
- Responsive sidebar that shows live transcripts and LLM replies
- Optional manual composer with inline mic toggle
- Admin panel shortcuts for opening URLs, listing tabs, and killing the mic everywhere
- DOM layout highlighter to inspect and capture context for the assistant

## Getting Started
1. Enable Developer Mode at `chrome://extensions`.
2. Load the project folder with **Load unpacked**.
3. (Optional) Turn on Split View at `chrome://flags` so the popup docks beside each tab.
4. Click the Hey Nano icon (or press **Alt+Shift+M**) to toggle listening.

## Sidebar Basics
- **Type or speak**: typed messages are sent immediately; mic toggle controls speech input.
- **Status badge**: shows whether the active tab is listening.
- **History**: the sidebar keeps the recent transcript so you can review past prompts.

## Admin Panel Cheatsheet
- **Enable/Disable Mic**: forces the active tab into the desired state.
- **Open Tab**: launch a new tab from a URL or domain.
- **List Tabs**: inspect IDs, titles, and urls for the current window.
- **Highlight DOM/HTML**: overlay a grid and element outlines for quick inspection.

## Developer Notes
- Voice commands live in `voice_commands.js`; extend the registry to add new intents.
- Background plumbing is in `background.js`; avoid bypassing `enableMicForTab` / `disableMicForTab` to keep state consistent.
- The sidebar UI is plain HTML/CSS/JS in `user_popup.*`, designed to be responsive inside Chrome’s side panel.

Enjoy hands-free browsing!
