# Hey Nano

Hey Nano is a Chrome extension that brings **precision to AI assistance**.  
It keeps a single microphone session in sync across tabs and adds a responsive sidebar where you can interact with an LLM — by voice or text — without leaving your current page.

## Highlights
- One-tab-at-a-time mic with a clear ON/OFF badge  
- Responsive sidebar that shows live transcripts and LLM replies  
- Optional manual composer with inline mic toggle  
- Admin panel shortcuts for opening URLs, listing tabs, and killing the mic everywhere  
- DOM layout highlighter to inspect and capture context for the assistant  

---

## 🚀 How to Install and Run in Chrome Canary

### 📦 Download the Extension
1. Go to the latest build in the repository’s **`dist`** folder:  
   👉 [https://github.com/Daedu86/hey-nano/tree/main/dist](https://github.com/Daedu86/hey-nano/tree/main/dist)
2. Click **`hey-nano-extension.zip`**.  
3. Use the **Download** button (top right) or **Raw → Save as…** to save it locally.  
   > Example path: `C:\Users\<your-name>\Downloads\hey-nano-extension.zip`
4. **Extract** the ZIP to get a folder named `hey-nano-extension`.

---

### 🧭 Load It in Chrome Canary
1. Make sure you’re using **Google Chrome Canary**, version **144.0.7504.0 (Official Build) (64-bit)** or newer.  
   - Check under `chrome://settings/help` → *About Chrome* → ensure it’s updated.  
2. In the address bar, go to:  chrome://extensions/
3. Enable **Developer mode** (toggle in the top-right corner).  
4. Click **Load unpacked**.  
5. Select the extracted folder `hey-nano-extension` and click **Open**.  

Hey Nano will now appear in your extensions list and in the Chrome toolbar.

---

### 🎛️ Using Hey Nano
- Open any webpage.  
- Click the **Hey Nano icon** in the toolbar (or press **Alt + Shift + M**).  
- The sidebar opens — here you can:
- **Type or speak** to the assistant.  
- **Highlight elements** to give context to your queries.  
- Review **past prompts** in the sidebar history.  

> 💡 For the best layout, enable **Split View** in Canary:  
> Go to `chrome://flags/#side-panel-split-view` and set it to **Enabled**.

---

## Sidebar Basics
- **Type or speak**: typed messages are sent immediately; mic toggle controls speech input.  
- **Status badge**: shows whether the active tab is listening.  
- **History**: keeps your recent transcripts for review.  

---

## Admin Panel Cheatsheet
- **Enable/Disable Mic**: force the active tab into the desired state.  
- **List Tabs**: inspect IDs, titles, and URLs for the current window.  
- **Highlight DOM/HTML**: overlay a grid and element outlines for visual inspection.  

---

## Developer Notes
- Voice commands live in `voice_commands.js` — extend the registry to add new intents.  
- Background logic resides in `background.js` — don’t bypass `enableMicForTab` / `disableMicForTab` to maintain state consistency.  
- The sidebar UI is written in plain HTML/CSS/JS (`user_popup.*`), fully responsive inside Chrome’s side panel.  

---

### 🧩 Optional Flags & Tips
- Enable **Split View** to keep Hey Nano docked beside webpages.  
- For context debugging, use Chrome’s DevTools → *Elements* to inspect captured nodes.  
- The extension runs locally; no data is sent to external servers.  

---

## 🛠️ Troubleshooting

**Extension doesn’t appear after loading**  
- Make sure Developer Mode is **enabled** at `chrome://extensions/`.  
- Restart Chrome Canary and reload the extension.

**Sidebar doesn’t open**  
- Check that the extension is **enabled** in the toolbar.  
- Try the shortcut **Alt + Shift + M**.  
- If you changed the side-panel layout, re-enable Split View in `chrome://flags/#side-panel-split-view`.

**Mic not responding**  
- Verify that Chrome has microphone permissions under `chrome://settings/content/microphone`.  
- If using an external mic, reconnect it and refresh the tab.

---

Enjoy hands-free, context-aware browsing with **Hey Nano — the difference between noise and attention.**
