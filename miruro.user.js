// ==UserScript==
// @name         Miruro RPC
// @namespace    https://github.com/D4rkov
// @version      2.2.0
// @description  Sends Miruro watch metadata + playback to the local MiruroRPC bridge.
// @author       Darkov
// @match        *://*/*
// @run-at       document-start
// @grant        none
// @sandbox      DOM
// @inject-into  auto
// @updateURL    https://raw.githubusercontent.com/D4rkov/Miruro-RPC/main/miruro.user.js
// @downloadURL  https://raw.githubusercontent.com/D4rkov/Miruro-RPC/main/miruro.user.js
// @supportURL   https://github.com/D4rkov/Miruro-RPC/issues
// ==/UserScript==

(() => {
    "use strict";

    const SCRIPT_VERSION = "2.2.0";
    const PORT = 3847;
    const BRIDGE_URL = `ws://127.0.0.1:${PORT}`;
    const FALLBACK_SCRIPT_URL =
        "https://github.com/D4rkov/Miruro-RPC/raw/main/miruro.user.js";
    const IS_MIRURO = /(^|\.)miruro\./i.test(location.hostname);
    const IS_FRAME = window !== window.top;
    const PRESENCE_MS = 4000;
    const PLAYBACK_MS = 1000;
    const OPEN_TIMEOUT_MS = 5000;
    const RECONNECT_MS = 500;
    const UPDATE_NUDGE_KEY = "mirurorpc:update-nudge";

    // Top-level non-Miruro pages never talk to the bridge.
    if (!IS_MIRURO && !IS_FRAME)
        return;

    let tabId = crypto.randomUUID();
    let socket = null;
    let reconnectTimer = null;
    let openTimer = null;
    let miruroReady = false;
    let embedReady = false;
    let embedIdReady = false;
    let connectClient = null;
    let connectOnOpen = null;

    // ── messaging / tab identity (Miruro ↔ embed iframes) ───────────────

    const pendingChildren = new Set();

    function isEmbeddedFrameSource(source) {
        if (!source || source === window)
            return false;
        try {
            return source.top === window;
        } catch {
            return false;
        }
    }

    function announceTabIdToFrames() {
        if (!IS_MIRURO)
            return;

        for (const frame of document.querySelectorAll("iframe")) {
            try {
                frame.contentWindow?.postMessage({ type: "miruro-rpc-id", id: tabId }, "*");
            } catch { /* cross-origin access can throw on some browsers */ }
        }
    }

    function requestTabId() {
        if (IS_MIRURO || embedReady || embedIdReady)
            return;
        try {
            window.parent.postMessage("miruro-rpc-id-request", "*");
        } catch { /* ignore */ }
    }

    window.addEventListener("message", (event) => {
        if (event.data === "miruro-rpc-id-request") {
            if (IS_MIRURO) {
                if (!isEmbeddedFrameSource(event.source))
                    return;
                event.source?.postMessage({ type: "miruro-rpc-id", id: tabId }, "*");
                return;
            }

            // Intermediate iframe — ask parent, then relay down.
            pendingChildren.add(event.source);
            requestTabId();
            return;
        }

        // Embed iframes relay playback here so they don't need ws://127.0.0.1
        // (third-party hosts often block private-network WebSockets).
        if (IS_MIRURO && event.data?.type === "miruro-rpc-playback") {
            if (!isEmbeddedFrameSource(event.source))
                return;
            if (!isFocusedMiruroTab() || !isWatchPage())
                return;

            const currentTime = Number(event.data.currentTime);
            const duration = Number(event.data.duration);
            if (!Number.isFinite(duration) || duration <= 0)
                return;

            send("playback", {
                currentTime: Number.isFinite(currentTime) ? currentTime : 0,
                duration,
                paused: Boolean(event.data.paused)
            });
            return;
        }

        if (event.data?.type !== "miruro-rpc-id")
            return;

        if (IS_FRAME && event.source !== window.parent)
            return;

        tabId = event.data.id;
        embedIdReady = true;

        for (const child of pendingChildren) {
            child?.postMessage({ type: "miruro-rpc-id", id: tabId }, "*");
        }
        pendingChildren.clear();

        if (!IS_MIRURO && IS_FRAME && !embedReady)
            startEmbedClient();
    });

    // Embed frames: keep asking until Miruro answers (first ping is easy to miss
    // at document-start while the parent script is still booting).
    if (!IS_MIRURO && IS_FRAME) {
        requestTabId();
        const idRetry = setInterval(() => {
            if (embedReady || embedIdReady) {
                clearInterval(idRetry);
                return;
            }
            requestTabId();
        }, 500);
        setTimeout(() => clearInterval(idRetry), 30000);
    }

    // ── bridge ─────────────────────────────────────────────────────────

    function parseSemver(version) {
        const parts = String(version || "")
            .replace(/^v/i, "")
            .split(".")
            .map((n) => Number(n));
        if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n)))
            return null;
        return parts;
    }

    function cmpSemver(a, b) {
        const pa = parseSemver(a);
        const pb = parseSemver(b);
        if (!pa || !pb)
            return 0;
        for (let i = 0; i < 3; i++) {
            if (pa[i] !== pb[i])
                return pa[i] - pb[i];
        }
        return 0;
    }

    function isSafeScriptUrl(value) {
        if (typeof value !== "string" || !value)
            return false;
        try {
            const url = new URL(value);
            if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port === String(PORT)) {
                const token = url.searchParams.get("token") || "";
                return url.pathname === "/miruro.user.js" && /^[0-9a-f]{32}$/i.test(token);
            }
            if (url.protocol === "https:" && url.hostname === "github.com")
                return url.pathname === "/D4rkov/Miruro-RPC/raw/main/miruro.user.js";
            if (url.protocol === "https:" && url.hostname === "raw.githubusercontent.com")
                return url.pathname === "/D4rkov/Miruro-RPC/main/miruro.user.js";
            return false;
        } catch {
            return false;
        }
    }

    function showUpdateNudge(bridgeVersion, scriptUrl) {
        if (!IS_MIRURO || IS_FRAME)
            return;

        const url = isSafeScriptUrl(scriptUrl) ? scriptUrl : FALLBACK_SCRIPT_URL;
        const seenKey = `${UPDATE_NUDGE_KEY}:${bridgeVersion}`;
        try {
            if (sessionStorage.getItem(seenKey) === "1")
                return;
            sessionStorage.setItem(seenKey, "1");
        } catch { /* private mode */ }

        if (document.getElementById("mirurorpc-update-nudge"))
            return;

        const mount = () => {
            if (document.getElementById("mirurorpc-update-nudge"))
                return;

            const bar = document.createElement("div");
            bar.id = "mirurorpc-update-nudge";
            bar.setAttribute("role", "status");
            Object.assign(bar.style, {
                position: "fixed",
                left: "16px",
                right: "16px",
                bottom: "16px",
                zIndex: "2147483647",
                display: "flex",
                gap: "12px",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 14px",
                borderRadius: "10px",
                background: "rgba(12, 14, 18, 0.92)",
                color: "#f4f6f8",
                font: "500 13px/1.35 Segoe UI, system-ui, sans-serif",
                boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
                backdropFilter: "blur(8px)"
            });

            const text = document.createElement("div");
            text.textContent =
                `MiruroRPC userscript is behind the bridge (v${SCRIPT_VERSION} → v${bridgeVersion}). Update in Tampermonkey.`;

            const actions = document.createElement("div");
            Object.assign(actions.style, {
                display: "flex",
                gap: "8px",
                flexShrink: "0"
            });

            const updateBtn = document.createElement("button");
            updateBtn.type = "button";
            updateBtn.textContent = "Update script";
            Object.assign(updateBtn.style, {
                cursor: "pointer",
                border: "0",
                borderRadius: "8px",
                padding: "8px 12px",
                background: "#5b8cff",
                color: "#fff",
                font: "600 12px/1 Segoe UI, system-ui, sans-serif"
            });
            updateBtn.addEventListener("click", () => {
                window.open(url, "_blank", "noopener,noreferrer");
            });

            const dismissBtn = document.createElement("button");
            dismissBtn.type = "button";
            dismissBtn.textContent = "Later";
            Object.assign(dismissBtn.style, {
                cursor: "pointer",
                border: "1px solid rgba(255,255,255,0.2)",
                borderRadius: "8px",
                padding: "8px 12px",
                background: "transparent",
                color: "#f4f6f8",
                font: "600 12px/1 Segoe UI, system-ui, sans-serif"
            });
            dismissBtn.addEventListener("click", () => bar.remove());

            actions.append(updateBtn, dismissBtn);
            bar.append(text, actions);
            (document.body || document.documentElement).appendChild(bar);
        };

        if (document.body)
            mount();
        else
            document.addEventListener("DOMContentLoaded", mount, { once: true });
    }

    function onBridgeMessage(raw) {
        let data;
        try {
            data = JSON.parse(raw.data);
        } catch {
            return;
        }
        if (!data || data.type !== "hello" || typeof data.version !== "string")
            return;
        if (cmpSemver(data.version, SCRIPT_VERSION) > 0)
            showUpdateNudge(data.version, data.scriptUrl);
    }

    function send(type, data = {}) {
        if (socket?.readyState !== WebSocket.OPEN)
            return false;

        socket.send(JSON.stringify({ type, id: tabId, ...data }));
        return true;
    }

    function clearOpenTimer() {
        if (!openTimer)
            return;
        clearTimeout(openTimer);
        openTimer = null;
    }

    function scheduleReconnect() {
        if (reconnectTimer)
            return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (connectClient && connectOnOpen)
                connect(connectClient, connectOnOpen);
        }, RECONNECT_MS);
    }

    function connect(client, onOpen) {
        connectClient = client;
        connectOnOpen = onOpen;

        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        clearOpenTimer();

        const prev = socket;
        socket = null;
        if (prev) {
            try {
                prev.close();
            } catch { /* ignore */ }
        }

        const s = new WebSocket(BRIDGE_URL);
        socket = s;

        openTimer = setTimeout(() => {
            openTimer = null;
            if (socket !== s || s.readyState === WebSocket.OPEN)
                return;
            try {
                s.close();
            } catch { /* ignore */ }
        }, OPEN_TIMEOUT_MS);

        s.addEventListener("open", () => {
            if (socket !== s)
                return;
            clearOpenTimer();
            send("hello", { client });
            onOpen();
        });

        s.addEventListener("message", (event) => {
            if (socket !== s)
                return;
            onBridgeMessage(event);
        });

        s.addEventListener("close", () => {
            if (socket !== s)
                return;
            clearOpenTimer();
            scheduleReconnect();
        });

        s.addEventListener("error", () => {
            if (socket !== s)
                return;
            try {
                s.close();
            } catch { /* ignore */ }
        });
    }

    /** After sleep, browser WS can look open while the bridge already dropped it. */
    function ensureConnected() {
        if (!connectClient || !connectOnOpen)
            return;

        if (socket?.readyState === WebSocket.OPEN) {
            if (IS_MIRURO && isFocusedMiruroTab())
                claim();
            return;
        }

        if (socket?.readyState === WebSocket.CONNECTING)
            return;

        connect(connectClient, connectOnOpen);
    }

    // ── Miruro DOM helpers ─────────────────────────────────────────────

    function isWatchPage() {
        return location.pathname.startsWith("/watch");
    }

    function cleanText(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
    }

    function isJunkTitle(text) {
        if (!text || text.length < 2)
            return true;
        return (
            /^miruro\b/i.test(text) ||
            /watch anime online/i.test(text) ||
            /^free anime streaming/i.test(text) ||
            /^watching\b/i.test(text) ||
            /^episode\s+\d+\b/i.test(text) ||
            /^ep\s*\d+\b/i.test(text) ||
            /^(details|home|trending|schedule|history|profile|search|discover)$/i.test(text)
        );
    }

    function isEpisodeHeading(text) {
        // v1: "6. Episode Title" — v2: "Episode 1" / "Ep 1"
        return (
            /^\d+\.\s+\S+/.test(text) ||
            /^Episode\s+\d+\b/i.test(text) ||
            /^Ep\s*\d+\b/i.test(text)
        );
    }

    function metaContents(property) {
        return [...document.querySelectorAll(`meta[property="${property}"]`)]
            .map((node) => cleanText(node.getAttribute("content")))
            .filter(Boolean);
    }

    /** Player chrome often sits in the same wrapper as "6. Episode Title". */
    const EPISODE_CHROME_RE =
        /\b(AUDIO|SERVER|SUB|DUB|HD|FHD|AUTO|QUALITY|SOURCE|CC|SUBTITLES?)\b/i;

    function ownText(node) {
        if (!node)
            return "";
        let text = "";
        for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE)
                text += child.textContent;
        }
        return cleanText(text);
    }

    function scrubEpisodeTitle(text) {
        let value = cleanText(text);
        if (!value)
            return null;

        // Stop at player chrome even when glued: "TitleAUDIOSERVER(9)"
        value = value.replace(
            /(?:AUDIO|SERVER|SUB|DUB|HD|FHD|AUTO|QUALITY|SOURCE|CC|SUBTITLES?).*$/i,
            ""
        );
        value = value.replace(/[\s·|/\-–—]+$/g, "").replace(/\(\d+\)\s*$/g, "").trim();
        value = value.replace(/\.+$/g, "").trim();

        if (!value || value.length < 2 || EPISODE_CHROME_RE.test(value))
            return null;

        return value;
    }

    function getTitle() {
        const candidates = [];

        // v1: dedicated anime title heading
        for (const sel of [
            "h1.anime-title",
            ".anime-title",
            '[class*="_romajiTitle_"]',
            '[class*="infoDesktopTitle"]',
            '[class*="infoMobileTitle"]'
        ]) {
            const text = cleanText(document.querySelector(sel)?.textContent);
            if (text && !isJunkTitle(text) && !isEpisodeHeading(text))
                candidates.push({ text, score: 120 });
        }

        // v2 watch page: series title is the h2 in player controls (h1 is episode name)
        for (const node of document.querySelectorAll(".watch-controls h2")) {
            const text = cleanText(node.textContent);
            if (text && !isJunkTitle(text) && !isEpisodeHeading(text) && text.length < 120)
                candidates.push({ text, score: 110 });
        }

        // Prefer title next to cover image (v1 CSS modules)
        const cover = document.querySelector(
            'img[class*="_coverImg_"], img[class*="coverImg"], img[class*="_cover"]'
        );
        if (cover) {
            const card = cover.closest("div, article, section, aside") || cover.parentElement;
            const heading = card?.querySelector("a[href*='/info/'], h1.anime-title, .anime-title, h2");
            const text = cleanText(heading?.textContent);
            if (text && !isJunkTitle(text) && !isEpisodeHeading(text))
                candidates.push({ text, score: 100 });
        }

        // Series title beside the poster (link to /info/...)
        for (const link of document.querySelectorAll('a[href*="/info/"]')) {
            const aria = cleanText(link.getAttribute("aria-label") || "").replace(/^About\s+/i, "");
            const text = cleanText(link.textContent) || aria;
            if (text && !isJunkTitle(text) && !isEpisodeHeading(text) && text.length < 120)
                candidates.push({
                    text,
                    score: link.querySelector("img") || link.closest('[class*="cover"], [class*="Cover"]')
                        ? 60
                        : 40
                });
        }

        // og:title — v2 often has a generic "Miruro" tag plus "Watch Anime Name - Miruro"
        for (const og of metaContents("og:title")) {
            const fromOg = cleanText(
                og.replace(/^Watch\s+/i, "").replace(/\s*[|\-–—]\s*Miruro.*$/i, "")
            );
            if (fromOg && !isJunkTitle(fromOg) && !isEpisodeHeading(fromOg))
                candidates.push({ text: fromOg, score: 30 });
        }

        // document.title sometimes: "Anime Name Episode 3 | Miruro"
        const tab = cleanText(document.title)
            .replace(/^Watch\s+/i, "")
            .replace(/\s*[|\-–—]\s*Miruro.*$/i, "")
            .replace(/\s+Episode\s+\d+.*$/i, "")
            .trim();
        if (tab && !isJunkTitle(tab) && !isEpisodeHeading(tab))
            candidates.push({ text: tab, score: 5 });

        candidates.sort((a, b) => b.score - a.score);
        return candidates[0]?.text || null;
    }

    function getCover() {
        // v1 poster class wins over random /info/ thumbs in side lists
        const preferred = document.querySelector(
            'img[class*="_coverImg_"], img[class*="coverImg"]'
        );
        if (preferred?.currentSrc || preferred?.src)
            return preferred.currentSrc || preferred.src;

        // v2: poster is the /info/ link image beside the player controls
        const infoCover = document.querySelector(
            ".watch-controls a[href*='/info/'] img, a[href*='/info/'] img[class*='object-cover']"
        );
        if (infoCover?.currentSrc || infoCover?.src)
            return infoCover.currentSrc || infoCover.src;

        const images = [...document.querySelectorAll("img")];
        const match = images.find((img) => {
            const src = img.currentSrc || img.src || "";
            const cls = String(img.className || "");
            if (/sideList|banner|avatar/i.test(cls))
                return false;
            return (
                /anilist\.co\/.*\/cover/i.test(src) ||
                /media\/anime\/cover/i.test(src)
            );
        });
        if (match)
            return match.currentSrc || match.src;

        const ogImage = metaContents("og:image").find((src) =>
            /anilist\.co|\/cover/i.test(src)
        );
        return ogImage || null;
    }

    function parseEpisodeNumber(text) {
        const value = cleanText(text);
        if (!value)
            return null;

        const m =
            value.match(/^Episode\s+(\d+)\b/i) ||
            value.match(/^Ep\s*(\d+)\b/i) ||
            value.match(/^(\d+)\.\s+\S/);

        if (!m)
            return null;

        const ep = Number(m[1]);
        return Number.isFinite(ep) && ep > 0 ? ep : null;
    }

    function getEpisode() {
        const ep = Number(new URL(location.href).searchParams.get("ep"));
        if (Number.isFinite(ep) && ep > 0)
            return ep;

        // v2: primary heading is "Episode N"
        for (const node of document.querySelectorAll("h1, .watch-controls span")) {
            const n = parseEpisodeNumber(ownText(node) || node.textContent);
            if (n)
                return n;
        }

        const heading = getEpisodeHeadingText();
        const fromHeading = parseEpisodeNumber(heading);
        if (fromHeading)
            return fromHeading;

        return 1;
    }

    function getEpisodeHeadingText() {
        const nodes = document.querySelectorAll(
            "h1, h2, h3, h4, .watch-controls span, [class*='title']"
        );
        for (const node of nodes) {
            // Prefer direct text so AUDIO / SERVER sibling controls are ignored.
            const direct = ownText(node);
            const text = isEpisodeHeading(direct) ? direct : cleanText(node.textContent);
            if (!isEpisodeHeading(text) || text.length >= 160)
                continue;

            // v1: "6. Title"
            const dotted = text.match(/^(\d+)\.\s*(.+)$/);
            if (dotted) {
                const title = scrubEpisodeTitle(dotted[2] || "");
                if (!title)
                    continue;
                return `${dotted[1]}. ${title}`;
            }

            // v2: "Episode 1" (optional named title may sit nearby)
            const plain = text.match(/^Episode\s+(\d+)\b/i) || text.match(/^Ep\s*(\d+)\b/i);
            if (plain)
                return `Episode ${plain[1]}`;
        }
        return null;
    }

    function getEpisodeTitle(episode) {
        // v1: dedicated episode title node
        const epTitle = scrubEpisodeTitle(
            document.querySelector(".ep-title, [class*='ep-title'], [class*='epTitle']")?.textContent
        );
        if (epTitle && !isJunkTitle(epTitle))
            return epTitle;

        const heading = getEpisodeHeadingText();
        if (heading) {
            const dotted = heading.match(/^(\d+)\.\s*(.+)$/);
            if (dotted && Number(dotted[1]) === episode)
                return scrubEpisodeTitle(dotted[2]);
        }

        // v2: h1 is the episode name ("Locusts") while ep number lives in ?ep=
        const h1 = document.querySelector(".watch-controls h1, h1");
        const h1Text = scrubEpisodeTitle(ownText(h1) || h1?.textContent || "");
        if (
            h1Text &&
            !isJunkTitle(h1Text) &&
            !isEpisodeHeading(h1Text) &&
            h1Text.toLowerCase() !== getTitle()?.toLowerCase()
        ) {
            return h1Text;
        }

        const list = document.querySelector("[data-episode-list]");
        if (list) {
            const nodes = [...list.querySelectorAll("button, a, li, [role='button'], div")];
            for (const node of nodes) {
                const text = scrubEpisodeTitle(ownText(node)) || scrubEpisodeTitle(node.textContent);
                if (!text)
                    continue;

                const raw = cleanText(node.textContent);
                const numMatch = raw.match(/(?:ep(?:isode)?\.?\s*)(\d+)/i) || raw.match(/^(\d+)\b/);
                if (!numMatch || Number(numMatch[1]) !== episode)
                    continue;

                const titled =
                    raw.match(/["“](.+?)["”]/) ||
                    raw.match(/^\d+\.\s*(.+)$/) ||
                    raw.match(/:\s*(.+)$/) ||
                    raw.match(/^\d+\s+(.+)$/);

                const cleaned = scrubEpisodeTitle(titled?.[1] || text);
                if (cleaned && !/^episode\s+\d+\b/i.test(cleaned))
                    return cleaned;
            }
        }

        return null;
    }

    function watchUrl() {
        const url = new URL(location.href);
        url.hash = "";
        return url.toString();
    }

    function parseClock(value) {
        const parts = String(value).split(":").map(Number);
        if (!parts.length || parts.some((n) => !Number.isFinite(n)))
            return null;
        return parts.reduce((total, part) => total * 60 + part, 0);
    }

    /** Fallback when strmcx/video APIs are unavailable — read "3:24 / 23:40" from player UI. */
    function readPlayerClock() {
        const scopes = [
            document.querySelector("strmcx-embed"),
            document.querySelector(".plyr"),
            document.querySelector('[class*="player"]'),
            document.querySelector('[class*="Player"]')
        ].filter(Boolean);

        const texts = [];
        for (const scope of scopes.length ? scopes : [document]) {
            for (const el of scope.querySelectorAll("span, div, time")) {
                const t = cleanText(el.textContent);
                if (t && t.length <= 20 && /\d+:\d+/.test(t))
                    texts.push({ text: t, scope });
            }
            texts.push({ text: cleanText(scope.textContent).slice(0, 400), scope });
        }

        for (const { text, scope } of texts) {
            const m = text.match(/(\d+:\d{2}(?::\d{2})?)\s*\/\s*(\d+:\d{2}(?::\d{2})?)/);
            if (!m)
                continue;
            const currentTime = parseClock(m[1]);
            const duration = parseClock(m[2]);
            if (currentTime == null || duration == null || duration <= 0)
                continue;

            // Only look for pause UI inside the player — page-wide "Play" buttons
            // (episode list, etc.) falsely freeze the Discord progress bar.
            const root = scope || document;
            const paused = Boolean(
                root.querySelector('.plyr--paused, [aria-label="Play"], button[aria-label="Play"]')
            ) && !root.querySelector('.plyr--playing, button[aria-label="Pause"]');

            return { currentTime, duration, paused };
        }

        return null;
    }

    // ── playback (native video, strmcx, ok.ru, player clock) ───────────

    function findVideoDeep(root = document, depth = 0) {
        if (!root || depth > 6)
            return null;

        if (root.querySelector) {
            const direct = root.querySelector("video");
            if (direct)
                return direct;
        }

        const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
        for (const el of all) {
            if (el.shadowRoot) {
                const found = findVideoDeep(el.shadowRoot, depth + 1);
                if (found)
                    return found;
            }
        }

        return null;
    }

    function readMedia(media) {
        if (!media)
            return null;

        try {
            const currentTime = Number(media.currentTime);
            const duration = Number(media.duration);
            return {
                currentTime: Number.isFinite(currentTime) ? currentTime : null,
                duration: Number.isFinite(duration) && duration > 0 ? duration : null,
                paused: Boolean(media.paused)
            };
        } catch {
            return null;
        }
    }

    function createPlaybackTracker(onPlayback) {
        let strmcxEl = null;
        let okPlayer = null;
        let last = {
            currentTime: 0,
            duration: null,
            paused: true,
            updatedAt: 0,
            // Wall-clock of the last time currentTime actually advanced while playing.
            movingAt: 0
        };

        const strmcxHandlers = {
            "strmcx-time-update": (event) => {
                const detail = event.detail || {};
                const currentTime = Number(detail.currentTime);
                const duration = Number(detail.duration);

                let paused;
                if (typeof detail.paused === "boolean")
                    paused = detail.paused;
                else if (typeof detail.playing === "boolean")
                    paused = !detail.playing;
                else
                    paused = false;

                applyPlayback({
                    currentTime: Number.isFinite(currentTime) ? currentTime : last.currentTime,
                    duration: Number.isFinite(duration) && duration > 0 ? duration : last.duration,
                    paused
                });
            },
            "strmcx-duration-change": (event) => {
                const duration = Number(event.detail?.duration);
                if (Number.isFinite(duration) && duration > 0) {
                    last.duration = duration;
                    last.updatedAt = Date.now();
                    flush();
                }
            },
            "strmcx-pause": () => {
                applyPlayback({
                    currentTime: last.currentTime,
                    duration: last.duration,
                    paused: true
                });
            },
            "strmcx-play": () => {
                last.movingAt = Date.now();
                applyPlayback({
                    currentTime: last.currentTime,
                    duration: last.duration,
                    paused: false
                });
            },
            "strmcx-ready": () => {
                last.movingAt = Date.now();
                applyPlayback({
                    currentTime: last.currentTime,
                    duration: last.duration,
                    paused: false
                });
            },
            "strmcx-ended": () => {
                applyPlayback({
                    currentTime: last.currentTime,
                    duration: last.duration,
                    paused: true
                });
            }
        };

        function flush() {
            if (!Number.isFinite(last.duration) || last.duration <= 0)
                return;

            // Time not advancing ⇒ paused (don't use updatedAt — stagnant clock refreshes it).
            if (!last.paused && last.movingAt && Date.now() - last.movingAt > 1500)
                last.paused = true;

            onPlayback({
                currentTime: Math.max(0, last.currentTime || 0),
                duration: last.duration,
                paused: last.paused
            });
        }

        function detachStrmcx() {
            if (!strmcxEl)
                return;

            for (const [name, handler] of Object.entries(strmcxHandlers))
                strmcxEl.removeEventListener(name, handler, true);

            strmcxEl = null;
        }

        function attachStrmcx(el) {
            if (el === strmcxEl)
                return;

            detachStrmcx();
            strmcxEl = el;

            for (const [name, handler] of Object.entries(strmcxHandlers))
                el.addEventListener(name, handler, true);
        }

        function getOkPlayer() {
            if (!location.hostname.endsWith("ok.ru") || !window.OneVideoPlayer?.getPlayers)
                return null;

            try {
                return window.OneVideoPlayer.getPlayers()[0] ?? null;
            } catch {
                return null;
            }
        }

        function isPausedMedia(playback) {
            return Boolean(
                playback?.duration &&
                playback.paused &&
                (playback.currentTime || 0) >= 0.5
            );
        }

        function applyPlayback(playback) {
            if (!playback?.duration)
                return false;

            const nextTime = Math.max(0, playback.currentTime ?? 0);
            let paused = Boolean(playback.paused);

            if (!paused) {
                if (Math.abs(nextTime - (last.currentTime || 0)) >= 0.5)
                    last.movingAt = Date.now();
                else if (last.movingAt && Date.now() - last.movingAt > 1500)
                    paused = true;
            }

            // While already paused, keep the frozen position (±1s clock jitter).
            const currentTime =
                paused && last.paused && Math.abs(nextTime - last.currentTime) < 1.5
                    ? last.currentTime
                    : nextTime;

            last = {
                currentTime,
                duration: playback.duration,
                paused,
                updatedAt: Date.now(),
                movingAt: paused ? last.movingAt : (last.movingAt || Date.now())
            };

            flush();
            return true;
        }

        function resetPlayback() {
            detachStrmcx();
            okPlayer = null;
            last = {
                currentTime: 0,
                duration: null,
                paused: true,
                updatedAt: 0,
                movingAt: 0
            };
        }

        function poll() {
            const strmcx = document.querySelector("strmcx-embed");
            if (strmcx)
                attachStrmcx(strmcx);
            else if (strmcxEl)
                detachStrmcx();

            const videoPlayback = readMedia(findVideoDeep(document));

            const ok = getOkPlayer();
            if (ok)
                okPlayer = ok;
            const okPlayback = readMedia(okPlayer);

            // Real media pause wins immediately — never let the clock un-pause us.
            if (isPausedMedia(videoPlayback)) {
                applyPlayback(videoPlayback);
                return;
            }
            if (isPausedMedia(okPlayback)) {
                applyPlayback(okPlayback);
                return;
            }

            if (videoPlayback && !videoPlayback.paused && applyPlayback(videoPlayback))
                return;

            if (okPlayback && !okPlayback.paused && applyPlayback(okPlayback))
                return;

            const clock = readPlayerClock();
            if (clock) {
                const delta = Math.abs((clock.currentTime || 0) - (last.currentTime || 0));
                // Stagnant clock, or we were already paused and time didn't jump ⇒ stay paused.
                const stalled =
                    Boolean(last.duration) &&
                    delta < 0.75 &&
                    last.movingAt &&
                    Date.now() - last.movingAt > 1500;
                const holdPause = last.paused && delta < 1.25;
                applyPlayback({
                    currentTime: holdPause || stalled ? last.currentTime : clock.currentTime,
                    duration: clock.duration,
                    paused: Boolean(clock.paused || stalled || holdPause)
                });
                return;
            }

            // Embed iframes own playback on a separate WS client. If the local
            // player disappeared (e.g. switched to bunembeds), drop stale state
            // so we don't keep overwriting Embed ticks with a frozen pause.
            if (!strmcx && !videoPlayback && !okPlayback) {
                if (last.duration)
                    resetPlayback();
                return;
            }

            if (last.duration)
                flush();
        }

        for (const [name, handler] of Object.entries(strmcxHandlers))
            document.addEventListener(name, handler, true);

        const timer = setInterval(poll, PLAYBACK_MS);
        const observer = new MutationObserver(poll);
        observer.observe(document.documentElement, { childList: true, subtree: true });
        poll();

        return () => {
            clearInterval(timer);
            observer.disconnect();
            detachStrmcx();
            for (const [name, handler] of Object.entries(strmcxHandlers))
                document.removeEventListener(name, handler, true);
        };
    }

    // ── Miruro client ──────────────────────────────────────────────────

    function isFocusedMiruroTab() {
        return IS_MIRURO && document.visibilityState === "visible";
    }

    let activeWatchKey = null;
    let presenceWaitTimer = null;
    let lastHiddenAt = 0;

    function getWatchKey() {
        const match = location.pathname.match(/^\/watch\/([^/]+)/);
        const animeId = match?.[1] || location.pathname;
        return `${animeId}|${getEpisode()}`;
    }

    function cancelPresenceWait() {
        if (presenceWaitTimer) {
            clearTimeout(presenceWaitTimer);
            presenceWaitTimer = null;
        }
    }

    function sendPresence(playback = null) {
        if (!isFocusedMiruroTab() || !isWatchPage())
            return;

        const title = getTitle();
        if (!title || isJunkTitle(title))
            return;

        const episode = getEpisode();
        const cover = getCover();
        const payload = {
            title,
            episode,
            episodeTitle: getEpisodeTitle(episode),
            cover,
            url: watchUrl()
        };

        if (playback && Number.isFinite(playback.duration) && playback.duration > 0) {
            payload.currentTime = playback.currentTime;
            payload.duration = playback.duration;
            payload.paused = playback.paused;
        } else {
            const local = readMedia(findVideoDeep(document));
            if (local?.duration) {
                payload.currentTime = local.currentTime;
                payload.duration = local.duration;
                payload.paused = local.paused;
            }
        }

        activeWatchKey = getWatchKey();
        send("presence", payload);
    }

    /**
     * After SPA navigation the old anime DOM often lingers briefly.
     * Clear Discord immediately, then wait until title/cover change (or timeout).
     */
    function schedulePresenceWhenReady(previousTitle, previousCover, opts = {}) {
        cancelPresenceWait();
        const expectedKey = getWatchKey();
        const startedAt = Date.now();
        const sameShow = Boolean(opts.sameShow);

        const attempt = () => {
            presenceWaitTimer = null;

            if (!isFocusedMiruroTab() || !isWatchPage())
                return;
            if (getWatchKey() !== expectedKey)
                return;

            const title = getTitle();
            const cover = getCover();
            const timedOut = Date.now() - startedAt >= 2500;
            const titleReady = title && !isJunkTitle(title) && title !== previousTitle;
            const coverReady = cover && cover !== previousCover;
            const firstPaint = !previousTitle && title && !isJunkTitle(title);
            // Episode-only navigations keep the same title/cover — publish as soon as we have one.
            const episodeOnlyReady = sameShow && title && !isJunkTitle(title);

            if (
                firstPaint ||
                titleReady ||
                coverReady ||
                episodeOnlyReady ||
                (timedOut && title && !isJunkTitle(title))
            ) {
                sendPresence();
                return;
            }

            presenceWaitTimer = setTimeout(attempt, 150);
        };

        presenceWaitTimer = setTimeout(attempt, sameShow ? 50 : 100);
    }

    function claim() {
        if (!isFocusedMiruroTab())
            return;
        if (!send("claim"))
            return;

        if (!isWatchPage()) {
            cancelPresenceWait();
            activeWatchKey = null;
            send("browse");
            return;
        }

        const key = getWatchKey();
        if (key !== activeWatchKey) {
            const previousTitle = getTitle();
            const previousCover = getCover();
            const previousKey = activeWatchKey;
            const hadPrevious = Boolean(previousKey);
            const sameShow =
                hadPrevious &&
                previousKey.split("|")[0] === key.split("|")[0] &&
                previousTitle &&
                !isJunkTitle(previousTitle);

            send("clear");
            activeWatchKey = null;

            // Same anime, new episode (or embed server still on this show): title/cover won't change.
            if (sameShow) {
                sendPresence();
                return;
            }

            // Userscript update / first claim: DOM is already painted — don't wait 2.5s.
            if (!hadPrevious && previousTitle && !isJunkTitle(previousTitle)) {
                sendPresence();
                return;
            }

            schedulePresenceWhenReady(previousTitle, previousCover, { sameShow });
            return;
        }

        sendPresence();
    }

    function onNavigation() {
        if (!isFocusedMiruroTab())
            return;
        claim();
    }

    function onFocusChange() {
        if (isFocusedMiruroTab()) {
            // Long hidden periods (sleep) often leave a half-open WS that never fires close.
            if (lastHiddenAt && Date.now() - lastHiddenAt > 60000 && connectClient && connectOnOpen) {
                lastHiddenAt = 0;
                connect(connectClient, connectOnOpen);
                return;
            }
            lastHiddenAt = 0;
            ensureConnected();
            return;
        }

        if (IS_MIRURO) {
            lastHiddenAt = Date.now();
            send("hidden");
        }
    }

    function hookHistory(fn) {
        const original = history[fn];
        history[fn] = function (...args) {
            const result = original.apply(this, args);
            onNavigation();
            return result;
        };
    }

    function startMiruroClient() {
        connect("Miruro", () => {
            if (isFocusedMiruroTab())
                claim();

            if (miruroReady)
                return;

            miruroReady = true;

            createPlaybackTracker((playback) => {
                if (!isFocusedMiruroTab() || !isWatchPage())
                    return;
                // Don't push playback while waiting for the new anime DOM.
                if (activeWatchKey !== getWatchKey())
                    return;

                send("playback", playback);
                sendPresence(playback);
            });

            setInterval(() => {
                if (!isFocusedMiruroTab() || !isWatchPage())
                    return;
                if (activeWatchKey !== getWatchKey() && presenceWaitTimer)
                    return;
                sendPresence();
            }, PRESENCE_MS);

            // Push our tab id into player iframes (bunembeds/megaplay/etc.) so they
            // can connect even if their document-start ping was missed.
            announceTabIdToFrames();
            setInterval(announceTabIdToFrames, 2000);
            new MutationObserver(announceTabIdToFrames).observe(document.documentElement, {
                childList: true,
                subtree: true
            });

            hookHistory("pushState");
            hookHistory("replaceState");
            window.addEventListener("popstate", onNavigation);

            document.addEventListener("visibilitychange", onFocusChange);
            window.addEventListener("focus", onFocusChange);
            window.addEventListener("pageshow", () => ensureConnected());

            window.addEventListener("pagehide", () => {
                cancelPresenceWait();
                send("leave");
            });
        });
    }

    // ── Embed client (cross-origin iframes) ────────────────────────────

    function relayPlaybackToParent(playback) {
        try {
            window.parent.postMessage({
                type: "miruro-rpc-playback",
                currentTime: playback.currentTime,
                duration: playback.duration,
                paused: Boolean(playback.paused)
            }, "*");
        } catch { /* ignore */ }
    }

    function startEmbedClient() {
        if (embedReady || IS_MIRURO || !IS_FRAME)
            return;

        embedReady = true;

        // Track immediately and relay via postMessage. Do NOT wait for a
        // localhost WebSocket — megaplay/etc. often can't open ws://127.0.0.1.
        createPlaybackTracker((playback) => {
            relayPlaybackToParent(playback);
            send("playback", playback);
        });

        // Optional direct bridge connection (works when the host allows it).
        connect("Embed", () => {});
    }

    // ── boot ───────────────────────────────────────────────────────────

    // Embed iframes only connect after a Miruro parent hands them a tab id.
    if (IS_MIRURO)
        startMiruroClient();
})();
