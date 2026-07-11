# MiruroRPC

Discord Rich Presence for Miruro using a local bridge between a userscript and Discord RPC.

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

## FAQ

### Why does the userscript use `@match *://*/*`?

Miruro supports third-party embed providers. Depending on the anime (or even the episode), the selected server (e.g. Bun) may use a different provider behind the scenes.

Because of the browser's **Same-Origin Policy**, a userscript running only on `miruro.tv` cannot access or control a video hosted inside a cross-origin iframe. To read playback information (play/pause state, timestamps, progress, etc.), the userscript must also be able to run on the domain that's actually hosting the video.

Maintaining a whitelist of every possible provider isn't practical, as providers can be added, removed, or changed at any time. 

Using:
```js
// @match *://*/*
```

makes the userscript provider-agnostic and future-proof.

**This does not mean the script runs on every website in practice.** Although it is injected on every page, it immediately exits unless the page is either:
- A Miruro page, or
- A video embed loaded by Miruro.

On all other websites, no WebSocket connection is opened, no data is collected, and no actions are performed.

---

## Updating

Pull the new changes (if u used git, if not just download the repo)

```bash
git pull
npm install
```
also don't forget to copy the updated userscript code and add it to ur userscript manager.

---

## License

This project is licensed under the GNU General Public License v3.0 (GPL-3.0). See the LICENSE file for details.
