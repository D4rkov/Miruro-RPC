# Miruro RPC (extension)

Discord Rich Presence for Miruro — **browser extension only**. No tray app, no Tampermonkey.

Uses Discord OAuth **PKCE** with:

- `openid`
- `sdk.social_layer_presence`

Presence is published through Discord **headless sessions** (same idea as Social Layer / Neurobox-style web presence).

---

## Setup (Discord Developer Portal)

1. Open your app: [Discord Developer Portal](https://discord.com/developers/applications)  
   Default client id in `config.js` is `1521597072434794527` (change if needed).
2. **OAuth2** → enable **Public Client** (required so PKCE works without a client secret).
3. Load this extension once (steps below), open the popup, **Copy redirect URL**.
4. Paste that URL into **OAuth2 → Redirects** (looks like `https://<extension-id>.chromiumapp.org/`).
5. Save changes.

Scopes are requested at login — you do not pick them in the portal redirect list.

---

## Install (Chrome / Edge / Brave / Vivaldi)

1. Open `chrome://extensions` (or `edge://extensions`, etc.)
2. Enable **Developer mode**
3. **Load unpacked** → select this `Miruro-RPC-NEW` folder
4. Pin **Miruro RPC** → **Connect Discord** → approve
5. Open [Miruro](https://www.miruro.cx) and play an episode

Badge: `✓` connected · `…` browsing · `▶` watching · `!` needs login

---

## Firefox (temporary install)

Requires Firefox **121+**. Manifest declares both `background.scripts` (Firefox) and `service_worker` (Chrome).

1. Go to `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…**
3. Select `manifest.json` inside this folder
4. Open the extension popup → copy the redirect URL → add it in Discord OAuth2 Redirects  
   (copy whatever the popup shows — usually `*.extensions.allizom.org`)
5. Enable **Public Client** on the Discord app
6. **Connect Discord** → open Miruro

Temporary add-ons disappear when Firefox restarts — load again from the same page. Permanent install comes later via AMO / signing.

If the background fails to load, open `about:debugging` → this extension → **Inspect** (background) for errors.

---

## Config

Edit `config.js`:

```js
export const CLIENT_ID = "your-application-id";
```

Watch: large = anime cover; small = play/pause icon. Browse: Miruro brand art.  
Headless needs asset **IDs/CDN URLs** (not IPC name keys). See `config.js`.  
Optional: upload play/pause art in the Discord portal, then set `ACTIVITY.playUrl` / `pauseUrl` in `config.js` to those `cdn.discordapp.com/app-assets/...` URLs (third-party image proxies are not used).  
Top-frame scripts match **miruro.cx** only. Playback comes from `strmcx-embed` / in-page video — no site-wide iframe content script.

---

## Notes

- Discord Desktop is **not** required (cloud headless session).
- Headless sessions expire after ~20 minutes idle; the extension keepalives while active.
- `activities.write` alone is locked for most apps; this build uses Social Layer scopes instead (PreMiD’s partner path is different).
- If login fails with `invalid_client`, Public Client is not enabled on the Discord app.
