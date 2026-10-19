# MiruroRPC

Discord Rich Presence for Miruro — runs in the **system tray** and auto-updates.

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

**macOS:** open the DMG and drag MiruroRPC to Applications. On first launch, right-click the app → **Open** if Gatekeeper warns about an unidentified developer. The app lives in the menu bar (top right).

It starts at login by default and checks for updates automatically.

### 2. Install the userscript (once)

1. Install [Tampermonkey](https://www.tampermonkey.net/)
2. Right-click / click the MiruroRPC tray / menu bar icon → **Install / update userscript**  
   (or open [`miruro.user.js`](https://github.com/D4rkov/Miruro-RPC/raw/main/miruro.user.js))
3. Click **Install** in Tampermonkey


### 3. Watch anime

Open [Miruro 2.0](https://barelystarted.miruro.tv) (or [miruro.tv](https://www.miruro.tv)), play an episode, check Discord.

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
- Tampermonkey (or another userscript manager)

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

### Why does the userscript use `@match *://*/*`?

Miruro uses third-party embeds. The script must also run on the embed host to read playback. On non-Miruro pages it does nothing unless it’s an embed that received a Miruro tab id.

Maintaining a whitelist of every provider isn’t practical — providers change. The broad match is provider-agnostic; the script only connects on Miruro pages or Miruro video embeds.

### Does the tray app update the userscript too?

Not by itself — Tampermonkey is separate from the tray auto-updater. After a tray update you’ll get a one-time prompt to open the matching userscript. When the bridge owns its local port, that link is a tokenized localhost URL; if the port is unavailable it falls back to GitHub. On Miruro, an older script also shows an update banner when the bridge version is newer. Tampermonkey’s own `@updateURL` checks still work in the background.

### macOS says the app is from an unidentified developer

Releases are currently unsigned (no Apple Developer ID). Right-click the app → **Open**, or allow it under **System Settings → Privacy & Security**.

---

## License

GNU General Public License v3.0 (GPL-3.0). See `LICENSE`.
