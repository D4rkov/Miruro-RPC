// ==UserScript==
// @name         Miruro RPC
// @namespace    https://github.com/D4rkov
// @version      2.1.3
// @description  Sends Miruro watch metadata + playback to the local MiruroRPC bridge.
// @author       Darkov
// @match        *://*/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/D4rkov/Miruro-RPC/main/miruro.user.js
// @downloadURL  https://raw.githubusercontent.com/D4rkov/Miruro-RPC/main/miruro.user.js
// @supportURL   https://github.com/D4rkov/Miruro-RPC/issues
// ==/UserScript==

(() => {
    "use strict";

    const PORT = 3847;
    const BRIDGE_URL = `ws://127.0.0.1:${PORT}`;
    const IS_MIRURO = /(^|\.)miruro\./i.test(location.hostname);
    const IS_FRAME = window !== window.top;
    const PRESENCE_MS = 4000;
    const PLAYBACK_MS = 1000;

    let tabId = crypto.randomUUID();
    let socket = null;
    let reconnectTimer = null;
    let miruroReady = false;
    let embedReady = false;

    // ── messaging / tab identity (Miruro ↔ embed iframes) ───────────────

    const pendingChildren = new Set();

    window.addEventListener("message", (event) => {
        if (event.data === "miruro-rpc-id-request") {
            if (IS_MIRURO) {
                event.source?.postMessage({ type: "miruro-rpc-id", id: tabId }, "*");
                return;
            }

            pendingChildren.add(event.source);
            window.parent.postMessage("miruro-rpc-id-request", "*");
            return;
        }

        if (event.data?.type !== "miruro-rpc-id")
            return;

        tabId = event.data.id;

        for (const child of pendingChildren) {
            child?.postMessage({ type: "miruro-rpc-id", id: tabId }, "*");
        }
        pendingChildren.clear();

        if (!IS_MIRURO && !embedReady)
            startEmbedClient();
    });

    if (!IS_MIRURO)
        window.parent.postMessage("miruro-rpc-id-request", "*");

    // ── bridge ─────────────────────────────────────────────────────────

    function send(type, data = {}) {
        if (socket?.readyState !== WebSocket.OPEN)
            return false;

        socket.send(JSON.stringify({ type, id: tabId, ...data }));
        return true;
    }

    function connect(client, onOpen) {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        try {
            socket?.close();
        } catch { /* ignore */ }

        socket = new WebSocket(BRIDGE_URL);

        socket.addEventListener("open", () => {
            send("hello", { client });
            onOpen();
        });

        socket.addEventListener("close", () => {
            reconnectTimer = setTimeout(() => connect(client, onOpen), 2000);
        });

        socket.addEventListener("error", () => {
            try {
                socket.close();
            } catch { /* ignore */ }
        });
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
            /^watching\b/i.test(text)
        );
    }

    function isEpisodeHeading(text) {
        return /^\d+\.\s+\S+/.test(text);
    }

    function getTitle() {
        const candidates = [];

        // Series title beside the poster (link to /info/...)
        for (const link of document.querySelectorAll('a[href*="/info/"]')) {
            const text = cleanText(link.textContent);
            if (text && !isJunkTitle(text) && !isEpisodeHeading(text) && text.length < 120)
                candidates.push({
                    text,
                    score: link.querySelector("img") || link.closest('[class*="cover"], [class*="Cover"]')
                        ? 20
                        : 40
                });
        }

        // Prefer title next to cover image
        const cover = document.querySelector(
            'img[class*="_coverImg_"], img[class*="coverImg"], img[class*="_cover"]'
        );
        if (cover) {
            const card = cover.closest("div, article, section, aside") || cover.parentElement;
            const heading = card?.querySelector("a[href*='/info/'], h1, h2, h3, .anime-title");
            const text = cleanText(heading?.textContent);
            if (text && !isJunkTitle(text) && !isEpisodeHeading(text))
                candidates.push({ text, score: 100 });
        }

        for (const sel of [
            "h1.anime-title",
            ".anime-title",
            '[class*="_romajiTitle_"]',
            '[class*="infoDesktopTitle"]',
            '[class*="infoMobileTitle"]'
        ]) {
            const text = cleanText(document.querySelector(sel)?.textContent);
            if (text && !isJunkTitle(text) && !isEpisodeHeading(text))
                candidates.push({ text, score: 50 });
        }

        // document.title sometimes: "Anime Name Episode 3 | Miruro"
        const tab = cleanText(document.title)
            .replace(/\s*[|\-–—]\s*Miruro.*$/i, "")
            .replace(/\s+Episode\s+\d+.*$/i, "")
            .trim();
        if (tab && !isJunkTitle(tab) && !isEpisodeHeading(tab))
            candidates.push({ text: tab, score: 5 });

        candidates.sort((a, b) => b.score - a.score);
        return candidates[0]?.text || null;
    }

    function getCover() {
        const preferred = document.querySelector(
            'img[class*="_coverImg_"], img[class*="coverImg"], img[class*="_cover"]'
        );
        if (preferred?.currentSrc || preferred?.src)
            return preferred.currentSrc || preferred.src;

        const images = [...document.querySelectorAll("img")];
        const match = images.find((img) => {
            const src = img.currentSrc || img.src || "";
            return (
                /anilist\.co/i.test(src) ||
                /media\/anime\/cover/i.test(src) ||
                /\/cover[s]?\//i.test(src)
            );
        });

        return match ? (match.currentSrc || match.src) : null;
    }

    function getEpisode() {
        const ep = Number(new URL(location.href).searchParams.get("ep"));
        if (Number.isFinite(ep) && ep > 0)
            return ep;

        const heading = getEpisodeHeadingText();
        const m = heading?.match(/^(\d+)\./);
        return m ? Number(m[1]) : 1;
    }

    function getEpisodeHeadingText() {
        const nodes = document.querySelectorAll("h1, h2, h3, h4, [class*='title']");
        for (const node of nodes) {
            const text = cleanText(node.textContent);
            if (isEpisodeHeading(text) && text.length < 160)
                return text;
        }
        return null;
    }

    function getEpisodeTitle(episode) {
        const heading = getEpisodeHeadingText();
        if (heading) {
            const m = heading.match(/^(\d+)\.\s*(.+)$/);
            if (m && Number(m[1]) === episode)
                return cleanText(m[2]);
        }

        const list = document.querySelector("[data-episode-list]");
        if (list) {
            const nodes = [...list.querySelectorAll("button, a, li, [role='button'], div")];
            for (const node of nodes) {
                const text = cleanText(node.textContent);
                if (!text)
                    continue;

                const numMatch = text.match(/(?:ep(?:isode)?\.?\s*)(\d+)/i) || text.match(/^(\d+)\b/);
                if (!numMatch || Number(numMatch[1]) !== episode)
                    continue;

                const titled =
                    text.match(/["“](.+?)["”]/) ||
                    text.match(/^\d+\.\s*(.+)$/) ||
                    text.match(/:\s*(.+)$/) ||
                    text.match(/^\d+\s+(.+)$/);

                if (titled?.[1])
                    return cleanText(titled[1]);
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
                    texts.push(t);
            }
            texts.push(cleanText(scope.textContent).slice(0, 400));
        }

        for (const text of texts) {
            const m = text.match(/(\d+:\d{2}(?::\d{2})?)\s*\/\s*(\d+:\d{2}(?::\d{2})?)/);
            if (!m)
                continue;
            const currentTime = parseClock(m[1]);
            const duration = parseClock(m[2]);
            if (currentTime == null || duration == null || duration <= 0)
                continue;

            const paused = Boolean(
                document.querySelector(
                    '.plyr--paused, [aria-label="Play"], button[aria-label="Play"]'
                )
            ) && !document.querySelector('.plyr--playing, button[aria-label="Pause"]');

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
            updatedAt: 0
        };

        const strmcxHandlers = {
            "strmcx-time-update": (event) => {
                const detail = event.detail || {};
                const currentTime = Number(detail.currentTime);
                const duration = Number(detail.duration);

                if (Number.isFinite(currentTime))
                    last.currentTime = currentTime;

                if (Number.isFinite(duration) && duration > 0)
                    last.duration = duration;

                if (typeof detail.paused === "boolean")
                    last.paused = detail.paused;
                else if (typeof detail.playing === "boolean")
                    last.paused = !detail.playing;
                else
                    last.paused = false;

                last.updatedAt = Date.now();
                flush();
            },
            "strmcx-duration-change": (event) => {
                const duration = Number(event.detail?.duration);
                if (Number.isFinite(duration) && duration > 0) {
                    last.duration = duration;
                    last.updatedAt = Date.now();
                    flush();
                }
            },
            "strmcx-ready": () => {
                last.paused = false;
                last.updatedAt = Date.now();
                flush();
            },
            "strmcx-ended": () => {
                last.paused = true;
                last.updatedAt = Date.now();
                flush();
            }
        };

        function flush() {
            if (!Number.isFinite(last.duration) || last.duration <= 0)
                return;

            // If time updates stop while we previously looked "playing", treat as paused.
            if (!last.paused && Date.now() - last.updatedAt > 1600)
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

        function applyPlayback(playback) {
            if (!playback?.duration)
                return false;

            last = {
                currentTime: playback.currentTime ?? 0,
                duration: playback.duration,
                paused: Boolean(playback.paused),
                updatedAt: Date.now()
            };
            flush();
            return true;
        }

        function poll() {
            const strmcx = document.querySelector("strmcx-embed");
            if (strmcx)
                attachStrmcx(strmcx);

            const video = findVideoDeep(document);
            if (video && applyPlayback(readMedia(video)))
                return;

            const ok = getOkPlayer();
            if (ok)
                okPlayer = ok;

            if (okPlayer && applyPlayback(readMedia(okPlayer)))
                return;

            const clock = readPlayerClock();
            if (clock && applyPlayback(clock))
                return;

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
    function schedulePresenceWhenReady(previousTitle, previousCover) {
        cancelPresenceWait();
        const expectedKey = getWatchKey();
        const startedAt = Date.now();

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

            if (firstPaint || titleReady || coverReady || (timedOut && title && !isJunkTitle(title))) {
                sendPresence();
                return;
            }

            presenceWaitTimer = setTimeout(attempt, 150);
        };

        presenceWaitTimer = setTimeout(attempt, 100);
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
            send("clear");
            activeWatchKey = null;
            schedulePresenceWhenReady(previousTitle, previousCover);
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
        if (isFocusedMiruroTab())
            claim();
        else if (IS_MIRURO)
            send("hidden");
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

            hookHistory("pushState");
            hookHistory("replaceState");
            window.addEventListener("popstate", onNavigation);

            document.addEventListener("visibilitychange", onFocusChange);
            window.addEventListener("focus", onFocusChange);

            window.addEventListener("pagehide", () => {
                cancelPresenceWait();
                send("leave");
            });
        });
    }

    // ── Embed client (cross-origin iframes) ────────────────────────────

    function startEmbedClient() {
        if (embedReady || IS_MIRURO)
            return;

        embedReady = true;

        connect("Embed", () => {
            createPlaybackTracker((playback) => {
                send("playback", playback);
            });
        });
    }

    // ── boot ───────────────────────────────────────────────────────────

    // Embed iframes only connect after a Miruro parent hands them a tab id.
    if (IS_MIRURO)
        startMiruroClient();
})();
