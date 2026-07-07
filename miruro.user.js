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

    const IS_MIRURO = location.hostname.includes("miruro");

    const IS_MIRURO_EMBED =
        !IS_MIRURO &&
        document.referrer &&
        new URL(document.referrer).hostname.includes("miruro");

    let socket;
    let started = false;
    let attachedVideo = null;

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
        if (!socket || socket.readyState !== WebSocket.OPEN)
            return;

        const title = getTitle();
        const cover = getCover();
        const video = document.querySelector("video");
        const isWatchPage = location.pathname.startsWith("/watch/");

        if (!isWatchPage) {
            socket.send(JSON.stringify({
                type: "browse"
            }));
            return;
        }

        if (!title || !cover)
            return;

        const url = new URL(location.href);
        const episode = Number(url.searchParams.get("ep")) || 1;
        url.search = "";

        // Button always opens the anime page
        socket.send(JSON.stringify({
            type: "presence",
            title,
            episode,
            totalEpisodes: document.querySelectorAll('[class*="_episodeNumber_"]').length,
            episodeTitle: getEpisodeTitle(),
            cover,
            url: url.toString(),

            currentTime: video?.currentTime,
            duration: video?.duration,
            paused: video?.paused
        }));
    }

    function attachVideoListeners() {
        const video = document.querySelector("video");

        if (!video || video === attachedVideo)
            return;

        attachedVideo = video;

        video.addEventListener("play", sendPresence);
        video.addEventListener("pause", sendPresence);
        video.addEventListener("seeked", sendPresence);
        video.addEventListener("loadedmetadata", sendPresence);

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
            sendPresence();
        }, 50);
    }

    function connectMiruro() {

        socket = new WebSocket("ws://127.0.0.1:3847");

        socket.addEventListener("open", () => {

            socket.send(JSON.stringify({
                type: "hello",
                client: "Miruro"
            }));

            attachVideoListeners();
            sendPresence();

            if (!started) {
                started = true;

                setInterval(sendPresence, 5000);

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
            }
        });

        socket.addEventListener("close", () => {
            setTimeout(connectMiruro, 2000);
        });

        socket.addEventListener("error", () => {
            socket.close();
        });
    }

    function connectPlayback() {

        socket = new WebSocket("ws://127.0.0.1:3847");

        socket.addEventListener("open", () => {

            socket.send(JSON.stringify({
                type: "hello",
                client: "Embed"
            }));

            const wait = setInterval(() => {
                const video = document.querySelector("video");

                if (!video)
                    return;

                clearInterval(wait);

                function sendPlayback() {

                    if (socket.readyState !== WebSocket.OPEN) {
                        return;
                    }


                    socket.send(JSON.stringify({
                        type: "playback",
                        currentTime: video.currentTime,
                        duration: video.duration,
                        paused: video.paused
                    }));
                }

                let timer = null;

                video.addEventListener("play", () => {
                    sendPlayback();

                    clearInterval(timer);
                    timer = setInterval(sendPlayback, 5000);
                });

                video.addEventListener("pause", () => {
                    clearInterval(timer);
                    sendPlayback();
                });

                video.addEventListener("seeked", () => {
                    sendPlayback();
                });
                video.addEventListener("loadedmetadata", () => {
                    sendPlayback();
                });

                sendPlayback();
            }, 100);
        });

        socket.addEventListener("close", () => {
            setTimeout(connectPlayback, 2000);
        });

        socket.addEventListener("error", () => {
            socket.close();
        });
    }

    if (IS_MIRURO) {
        connectMiruro();
    }
    else if (IS_MIRURO_EMBED) {
        connectPlayback();
    }
})();