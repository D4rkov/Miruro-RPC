# MiruroRPC

Discord Rich Presence for Miruro.

Displays what you're watching on Discord, including:

- 📺 Anime title
- 🎬 Episode number & title
- ▶️ Play / ⏸ Pause status
- ⏱️ Live playback progress & timestamps
- 🖼️ Anime cover artwork
- 🔍 Browsing status when searching
- 🔗 "Watch on Miruro" button
- 🧹 Clears Rich Presence when all Miruro tabs are closed

---

## Requirements

- Node.js 18+
- Discord Desktop
- Tampermonkey (or another userscript manager)

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/D4rkov/MiruroRPC.git
cd MiruroRPC
```

### 2. Install dependencies

Run this inside the project folder:

```bash
npm install
```

This installs the required packages (`discord-rpc` and `ws`).

### 3. Start MiruroRPC

Start the application:

```bash
node MiruroRPC.js
```

You should see:

```
MiruroRPC listening on ws://127.0.0.1:3847
Discord RPC connected.
```

Leave this terminal window open while using Miruro.

---

## Userscript

1. Install Tampermonkey.
2. Create a new userscript.
3. Paste the contents of `MiruroRPC.user.js`.
4. Save.

The userscript will automatically connect to the local MiruroRPC application.

---

## Updating

After pulling new changes:

```bash
git pull
npm install
```

---

## License

MIT