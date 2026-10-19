# MiruroRPC

Discord Rich Presence for Miruro — runs in the **system tray** / **menu bar** and auto-updates.

Shows on Discord:

- Anime title, episode, play/pause
- Live progress bar timestamps
- Cover art + Miruro icon
- Browsing status while searching
- “Watch on Miruro” button

---

## Easy install (recommended)

### 1. Install the tray app

Download the latest release from:

**[GitHub Releases](https://github.com/D4rkov/Miruro-RPC/releases)**

| Platform | File |
|----------|------|
| **Windows** | `MiruroRPC-Setup-*.exe` |
| **macOS (Apple Silicon)** | `MiruroRPC-*-arm64.dmg` |
| **macOS (Intel)** | `MiruroRPC-*-x64.dmg` |

**Windows:** run the installer. MiruroRPC starts in the system tray (near the clock).

**macOS:**

1. Open the DMG and drag **MiruroRPC** into **Applications**
2. Clear Gatekeeper’s quarantine flag (unsigned build — macOS otherwise says the app is “damaged”):

```bash
xattr -cr /Applications/MiruroRPC.app && open /Applications/MiruroRPC.app
```

3. The app lives in the **menu bar** (top right), not the Dock

It starts at login by default and checks for updates automatically.

### 2. Install Tampermonkey + allow user scripts

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser  
   (Chrome, Edge, Vivaldi, Brave, Firefox — Safari is unreliable)
2. **Chromium browsers** (Chrome / Edge / Vivaldi / Brave): open the extensions page → **Tampermonkey** → **Details** → enable **Allow User Scripts**  
   - Chrome/Edge/Brave: `chrome://extensions`  
   - Vivaldi: `vivaldi://extensions`  
   Without this, Tampermonkey shows the script as installed but **“hasn’t run yet”** on Miruro.

### 3. Install the userscript (once)

1. Click the MiruroRPC tray / menu bar icon → **Install / update userscript**  
   (or open [`miruro.user.js`](https://github.com/D4rkov/Miruro-RPC/raw/main/miruro.user.js))
2. Click **Install** in Tampermonkey
3. Hard-refresh Miruro (`Ctrl+Shift+R` / `Cmd+Shift+R`)

### 4. Watch anime

Open [Miruro 2.0](https://barelystarted.miruro.tv) (or [miruro.tv](https://www.miruro.tv) / [miruro.com](https://www.miruro.com)), play an episode, check Discord.

Tray / menu bar should show **Connected — browsing** or **Watching on Miruro** when the script is talking to the bridge.

---

## Tray menu

| Item | What it does |
|------|----------------|
| Open Miruro | Opens the site |
| Install / update userscript | Opens the Tampermonkey install link |
| Start with Windows / Start at login | Login item toggle |
| Check for updates | Downloads tray-app updates (installed builds) |
| Quit | Stops the bridge |

---

## Requirements

- Windows 10/11 **or** macOS 11+
- Discord Desktop
- Tampermonkey (Chrome / Edge / Vivaldi / Brave / Firefox)
- Chromium: **Allow User Scripts** enabled for Tampermonkey

---

## Developer flow

```bash
npm run app        # test locally
npm run dist       # Windows installer (on Windows)
npm run dist:mac   # macOS DMGs (on macOS; Intel + Apple Silicon)
npm run ship       # commit + bump version + push + tag → CI builds Windows + macOS
```

---

## FAQ

### Tampermonkey says the script “hasn’t run yet” on Miruro

Almost always missing **Allow User Scripts** on Chromium (Chrome, Edge, Vivaldi, Brave). Enable it under Tampermonkey → Details, then hard-refresh Miruro. Also confirm the script is enabled in the Tampermonkey popup on that tab.

### macOS says MiruroRPC is “damaged” and should be moved to the Trash

That is Gatekeeper on an **unsigned** download — the app is not actually corrupted. After installing to Applications:

```bash
xattr -cr /Applications/MiruroRPC.app && open /Applications/MiruroRPC.app
```

### Why does the userscript use `@match *://*/*`?

Miruro uses third-party embeds. The script must also run on the embed host to read playback. On non-Miruro pages it does nothing unless it’s an embed that received a Miruro tab id.

Maintaining a whitelist of every provider isn’t practical — providers change. The broad match is provider-agnostic; the script only connects on Miruro pages or Miruro video embeds.

### Does the tray app update the userscript too?

Not by itself — Tampermonkey is separate from the tray auto-updater. After a tray update you’ll get a one-time prompt to open the matching userscript. When the bridge owns its local port, that link is a tokenized localhost URL; if the port is unavailable it falls back to GitHub. On Miruro, an older script also shows an update banner when the bridge version is newer. Tampermonkey’s own `@updateURL` checks still work in the background.

---

## License

GNU General Public License v3.0 (GPL-3.0). See `LICENSE`.
