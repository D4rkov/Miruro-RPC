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

Download the latest **`MiruroRPC-Setup-*.exe`** from:

**[GitHub Releases](https://github.com/D4rkov/Miruro-RPC/releases)**

Run the installer. MiruroRPC starts in the system tray (near the clock).  
It starts with Windows by default and checks for updates automatically.

### 2. Install the userscript (once)

1. Install [Tampermonkey](https://www.tampermonkey.net/)
2. Right-click the MiruroRPC tray icon → **Install / update userscript**  
   (or open [`miruro.user.js`](https://github.com/D4rkov/Miruro-RPC/raw/main/miruro.user.js))
3. Click **Install** in Tampermonkey

The userscript auto-updates from GitHub. The tray app auto-updates from Releases.

### 3. Watch anime

Open [Miruro](https://www.miruro.tv), play an episode, check Discord.

---

## Tray menu

| Item | What it does |
|------|----------------|
| Open Miruro | Opens the site |
| Install / update userscript | Opens the Tampermonkey install link |
| Start with Windows | Login item toggle |
| Check for updates | Downloads tray-app updates (installed builds) |
| Quit | Stops the bridge |

---

## Requirements

- Windows 10/11
- Discord Desktop
- Tampermonkey (or another userscript manager)

---

## Developer flow

```bash
npm run app     # test locally
npm run ship    # commit + bump version + push + tag → CI builds the .exe
```

That’s it. `npm run ship` handles version numbers for you (patch by default).

Rarely, for a bigger bump: `npm run ship -- minor` or `npm run ship -- major`.

---

## FAQ

### Why does the userscript use `@match *://*/*`?

Miruro uses third-party embeds. The script must also run on the embed host to read playback. On non-Miruro pages it does nothing unless it’s an embed that received a Miruro tab id.

Maintaining a whitelist of every provider isn’t practical — providers change. The broad match is provider-agnostic; the script only connects on Miruro pages or Miruro video embeds.

### Does the tray app update the userscript too?

No — Tampermonkey updates the script via `@updateURL`. The tray app updates itself via GitHub Releases.

---

## License

GNU General Public License v3.0 (GPL-3.0). See `LICENSE`.
