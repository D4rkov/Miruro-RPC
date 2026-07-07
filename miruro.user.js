// ==UserScript==
// @name         Miruro RPC
// @namespace    https://github.com/D4rkov
// @version      1.4.0
// @description  Sends Miruro data to the bridge.
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
    "use strict";

    const PORT = 3847;
    const BRIDGE_URL = `ws://127.0.0.1:${PORT}`;
    const IS_MIRURO = location.hostname.includes("miruro");
    const PRESENCE_INTERVAL = 5000;
    const VIDEO_WAIT_INTERVAL = 100;

    const VIDEO_EVENTS = [
        "play",
        "pause",
        "seeked",
        "loadedmetadata"
    ];

    const IS_MIRURO_EMBED =
        !IS_MIRURO &&
        document.referrer &&
        new URL(document.referrer).hostname.includes("miruro");

    let TAB_ID = crypto.randomUUID();
    let socket;
    let initialized = false;
    let attachedVideo = null;

    function initTabId() {
        window.addEventListener("message", e => {
            if (e.data === "miruro-rpc-id-request") {
                e.source?.postMessage({
                    type: "miruro-rpc-id",
                    id: TAB_ID
                }, "*");
            }
        });

        if (!IS_MIRURO_EMBED)
            return;

        window.parent.postMessage("miruro-rpc-id-request", "*");

        window.addEventListener("message", e => {
            if (e.data?.type === "miruro-rpc-id") {
                TAB_ID = e.data.id;
            }
        });
    }

    function getTitle() {
        return document.querySelector("h1")?.textContent.trim() ?? null;
    }

    function getCover() {
        return [...document.querySelectorAll("img")]
            .find(img => img.src.includes("/media/anime/cover/"))
            ?.src ?? null;
    }

    function getEpisodeTitle() {
        const text = document.querySelector('[class*="_dataWrapper_"]')?.textContent;

        if (!text)
            return null;

        return text
            .split("AUDIO")[0]
            .replace(/^\d+\.\s*(?:EP|Episode)\.?\s*\d+\s*[:.\-–—·]?\s*/i, "")
            .replace(/^\d+\.\s*/, "")
            .trim();
    }

    function sendPresence() {

        const title = getTitle();
        const cover = getCover();
        const video = document.querySelector("video");
        const isWatchPage = location.pathname.startsWith("/watch/");

        if (!isWatchPage) {
            send("browse");
            return;
        }

        if (!title || !cover)
            return;

        const url = new URL(location.href);
        const episode = Number(url.searchParams.get("ep")) || 1;
        url.search = "";

        // Button always opens the anime page
        send("presence", {
            title,
            episode,
            totalEpisodes: document.querySelectorAll('[class*="_episodeNumber_"]').length,
            episodeTitle: getEpisodeTitle(),
            cover,
            url: url.toString(),
            currentTime: video?.currentTime,
            duration: video?.duration,
            paused: video?.paused
        });
    }

    function attachVideoListeners() {
        const video = document.querySelector("video");

        if (!video || video === attachedVideo)
            return;

        attachedVideo = video;

        VIDEO_EVENTS.forEach(event =>
            video.addEventListener(event, sendPresence)
        );

        sendPresence();
    }

    function onNavigation() {

        attachedVideo = null;

        const previousTitle = getTitle();

        const wait = setInterval(() => {
            const currentTitle = getTitle();

            if (!currentTitle || currentTitle === previousTitle)
                return;

            clearInterval(wait);

            attachVideoListeners();

            if (!document.hidden)
                claim();
        }, 50);
    }

    function connect(client, reconnect, onOpen) {
        socket = new WebSocket(BRIDGE_URL);

        socket.addEventListener("open", () => {
            send("hello", { client });
            onOpen();
        });

        setupReconnect(socket, reconnect);
    }

    function send(type, data = {}) {
        if (socket?.readyState !== WebSocket.OPEN)
            return false;

        socket.send(JSON.stringify({
            type,
            id: TAB_ID,
            ...data
        }));

        return true;
    }

    function claim() {
        if (send("claim"))
            sendPresence();
    }

    if (IS_MIRURO) {
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden)
                claim();
        });
    }

    function setupReconnect(socket, reconnect) {
        socket.addEventListener("close", () => {
            setTimeout(reconnect, 2000);
        });

        socket.addEventListener("error", () => {
            socket.close();
        });
    }

    function connectMiruro() {

        connect("Miruro", connectMiruro, () => {

            attachVideoListeners();

            if (!document.hidden)
                claim();

            if (initialized)
                return;

            initialized = true;

            setInterval(sendPresence, PRESENCE_INTERVAL);

            const originalPushState = history.pushState;
            history.pushState = function (...args) {
                originalPushState.apply(this, args);
                onNavigation();
            };

            const originalReplaceState = history.replaceState;
            history.replaceState = function (...args) {
                originalReplaceState.apply(this, args);
                onNavigation();
            };

            window.addEventListener("popstate", onNavigation);

        });

    }

    function connectPlayback() {

        connect("Embed", connectPlayback, () => {

            const wait = setInterval(() => {
                const video = document.querySelector("video");

                if (!video)
                    return;

                clearInterval(wait);

                function sendPlayback() {
                    send("playback", {
                        currentTime: video.currentTime,
                        duration: video.duration,
                        paused: video.paused
                    });
                }

                let timer = null;

                video.addEventListener("play", () => {
                    sendPlayback();
                    clearInterval(timer);
                    timer = setInterval(sendPlayback, PRESENCE_INTERVAL);
                });

                video.addEventListener("pause", () => {
                    clearInterval(timer);
                    sendPlayback();
                });

                video.addEventListener("seeked", sendPlayback);
                video.addEventListener("loadedmetadata", sendPlayback);

                sendPlayback();
            }, VIDEO_WAIT_INTERVAL);

        });

    }

    initTabId();

    if (IS_MIRURO) {
        connectMiruro();
    }
    else if (IS_MIRURO_EMBED) {
        connectPlayback();
    }
})();