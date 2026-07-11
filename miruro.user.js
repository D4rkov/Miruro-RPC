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

    const IS_FRAME = window !== window.top;

    let TAB_ID = crypto.randomUUID();
    let socket;
    let initialized = false;
    let attachedVideo = null;

    function initTabId() {

        const pendingChildren = new Set();

        window.addEventListener("message", e => {

            if (e.data === "miruro-rpc-id-request") {

                if (IS_MIRURO) {

                    e.source?.postMessage({
                        type: "miruro-rpc-id",
                        id: TAB_ID
                    }, "*");

                    return;
                }

                pendingChildren.add(e.source);

                window.parent.postMessage(
                    "miruro-rpc-id-request",
                    "*"
                );

                return;
            }

            if (e.data?.type === "miruro-rpc-id") {

                TAB_ID = e.data.id;

                for (const child of pendingChildren) {
                    child?.postMessage({
                        type: "miruro-rpc-id",
                        id: TAB_ID
                    }, "*");
                }

                pendingChildren.clear();

                if (!IS_MIRURO && !initialized) {
                    initialized = true;
                    connectPlayback();
                }
            }

        });

        if (!IS_MIRURO) {
            window.parent.postMessage(
                "miruro-rpc-id-request",
                "*"
            );
        }
    }

    function getOKPlayer() {

        if (
            !location.hostname.endsWith("ok.ru") ||
            !window.OneVideoPlayer?.getPlayers
        ) {
            return null;
        }

        try {
            return window.OneVideoPlayer.getPlayers()[0] ?? null;
        } catch {
            return null;
        }
    }

    function getTitle() {
        return document.querySelector("h1")?.textContent.trim() ?? null;
    }

    function getCover() {
        return [...document.querySelectorAll("img")]
            .find(img => img.src.includes("/media/anime/cover/"))
            ?.src ?? null;
    }

    function getEpisodeTitle(episode) {

        const titles = document.querySelectorAll(
            '[class*="_episodeNumber_"]'
        );

        const title = titles[episode - 1]
            ?.textContent
            ?.trim();

        return title || null;
    }

    function sendPresence() {

        if (!location.pathname.startsWith("/watch/"))
            return;

        const title = getTitle();
        const cover = getCover();
        const video = document.querySelector("video");

        if (!title || !cover)
            return;

        const url = new URL(location.href);
        const episode = Number(url.searchParams.get("ep")) || 1;
        url.search = "";

        send("presence", {
            title,
            episode,
            totalEpisodes: document.querySelectorAll('[class*="_episodeNumber_"]').length,
            episodeTitle: getEpisodeTitle(episode),
            cover,
            url: url.toString(),
            currentTime: video?.currentTime,
            duration: video?.duration,
            paused: video?.paused
        });
    }

    function updatePageState() {
        if (location.pathname.startsWith("/watch/")) {
            sendPresence();
        } else {
            send("browse");
        }
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

        updatePageState();

        if (!location.pathname.startsWith("/watch/")) {
            if (!document.hidden)
                claim();

            return;
        }

        const wait = setInterval(() => {
            const title = getTitle();
            const cover = getCover();

            if (!title || !cover)
                return;

            clearInterval(wait);

            attachVideoListeners();
            sendPresence();

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

    function debugEmbed(...args) {
        console.debug("[MiruroRPC]", ...args);
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

            updatePageState();
            attachVideoListeners();

            if (!document.hidden)
                claim();

            if (initialized)
                return;

            initialized = true;

            setInterval(() => {
                if (location.pathname.startsWith("/watch/"))
                    sendPresence();
            }, PRESENCE_INTERVAL);

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

            let currentMedia = null;
            let currentType = null;

            function getNativeVideo() {
                return document.querySelector("video");
            }

            function getOKPlayer() {

                if (
                    !location.hostname.endsWith("ok.ru") ||
                    !window.OneVideoPlayer?.getPlayers
                ) {
                    return null;
                }

                try {
                    return window.OneVideoPlayer.getPlayers()[0] ?? null;
                } catch {
                    return null;
                }
            }

            function getPlayback() {

                if (!currentMedia)
                    return null;

                try {

                    return {
                        currentTime: Number(currentMedia.currentTime),
                        duration: Number(currentMedia.duration),
                        paused: Boolean(currentMedia.paused)
                    };

                } catch {
                    return null;
                }
            }

            function sendPlayback() {

                const playback = getPlayback();

                if (!playback)
                    return;

                send("playback", {
                    currentTime: Number.isFinite(playback.currentTime)
                        ? playback.currentTime
                        : 0,
                    duration: Number.isFinite(playback.duration)
                        ? playback.duration
                        : null,
                    paused: playback.paused
                });
            }

            function attachNativeVideo(video) {

                currentMedia = video;
                currentType = "native";

                VIDEO_EVENTS.forEach(event =>
                    video.addEventListener(
                        event,
                        sendPlayback
                    )
                );

                sendPlayback();
            }

            function attachOKPlayer(player) {

                currentMedia = player;
                currentType = "ok";

                sendPlayback();
            }

            function findPlayer() {

                const video = getNativeVideo();

                if (video) {

                    if (
                        currentMedia !== video ||
                        currentType !== "native"
                    ) {
                        attachNativeVideo(video);
                    }

                    return;
                }

                const okPlayer = getOKPlayer();

                if (okPlayer) {

                    if (
                        currentMedia !== okPlayer ||
                        currentType !== "ok"
                    ) {
                        attachOKPlayer(okPlayer);
                    }

                    return;
                }

                currentMedia = null;
                currentType = null;
            }

            findPlayer();

            const playbackTimer = setInterval(() => {
                findPlayer();
                sendPlayback();
            }, 1000);

            const observer = new MutationObserver(findPlayer);

            observer.observe(document.documentElement, {
                childList: true,
                subtree: true
            });

            socket.addEventListener("close", () => {
                clearInterval(playbackTimer);
                observer.disconnect();
            });

        });

    }

    initTabId();

    if (IS_MIRURO) {
        connectMiruro();
    }
})();