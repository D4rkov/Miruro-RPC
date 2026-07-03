# MiruroRPC

Discord Rich Presence for **Miruro** with support for all playback providers.

## ✨ Features

- 🎬 Displays the anime you're watching in Discord
- 📺 Episode number and title
- ⏱️ Live playback progress
- 🖼️ Anime cover artwork
- 🔗 "Watch on Miruro" button
- 🔄 Automatic reconnecting

## 📦 Requirements

- BetterDiscord
- Tampermonkey
- Node.js

# 🚀 Installation

## 1. Download the repository

Download or clone this repository to a folder on your computer.

---

## 2. Install the BetterDiscord plugin

Copy:

```
MiruroRPC.plugin.js
```

into your BetterDiscord plugins folder.

Enable the plugin from **Discord → Settings → BetterDiscord → Plugins**.

---

## 3. Install the userscript

Open:

```
Miruro-RPC.user.js
```

with Tampermonkey

---

## 4. Install the bridge dependency

Open a terminal (PowerShell, Command Prompt or Terminal) **inside the folder containing `bridge.js`**.

Run:

```bash
npm install ws
```

This only needs to be done once.

---

## 5. Start the bridge

From the same terminal, run:

```bash
node bridge.js
```

You should see:

```
Bridge listening on ws://127.0.0.1:3847
```

Keep this terminal window open while using MiruroRPC.

---

## 6. Watch anime

Open Miruro, start watching an anime, and your Discord Rich Presence will update automatically.

> **Note:** The bridge must be running for Rich Presence to work.

## ❓ Troubleshooting

### `node` is not recognized

Install Node.js and restart your terminal.

### `Cannot find module 'ws'`

Run:

```bash
npm install ws
```

in the folder containing `bridge.js`.

### Rich Presence isn't updating

- Make sure the BetterDiscord plugin is enabled.
- Make sure the userscript is installed and enabled.
- Verify `bridge.js` is running.
- Refresh the Miruro page.

## 📁 Files

| File | Purpose |
|------|---------|
| `MiruroRPC.plugin.js` | BetterDiscord plugin |
| `Miruro-RPC.user.js` | Collects playback information from Miruro |
| `bridge.js` | Local WebSocket bridge between the userscript and Discord |

## ❤️ Credits

Created by **Darkov**.