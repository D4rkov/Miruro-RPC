const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const RPC = require("discord-rpc");
const crypto = require("crypto");

const PORT = 3847;
const APPLICATION_ID = "1521597072434794527";
const BROWSE_TICK_MS = 2500;
const WS_HEARTBEAT_MS = 30000;
const VERSION = "2.2.0";
const USERSCRIPT_ROUTE = "/miruro.user.js";
const GITHUB_USERSCRIPT_URL =
    "https://github.com/D4rkov/Miruro-RPC/raw/main/miruro.user.js";
const CLIENT_TYPES = new Set(["Miruro", "Embed"]);
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{32}$/i;

const DEBUG = process.argv.includes("--debug");

function isMiruroHostname(hostname) {
    return /(^|\.)miruro\./i.test(String(hostname || ""));
}

function isAllowedWsOrigin(origin) {
    if (!origin || origin === "null")
        return true;
    try {
        const url = new URL(origin);
        if (url.protocol === "chrome-extension:" || url.protocol === "moz-extension:")
            return true;
        return isMiruroHostname(url.hostname);
    } catch {
        return false;
    }
}

function isValidId(id) {
    return typeof id === "string" && ID_RE.test(id);
}

function sanitizeWatchUrl(value) {
    if (typeof value !== "string" || !value)
        return null;
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || !isMiruroHostname(url.hostname))
            return null;
        url.hash = "";
        url.username = "";
        url.password = "";
        return url.toString();
    } catch {
        return null;
    }
}

function sanitizeCover(value) {
    if (typeof value !== "string" || !value)
        return null;
    if (/^[a-z0-9_-]{1,64}$/i.test(value))
        return value;
    try {
        const url = new URL(value);
        if (url.protocol !== "https:")
            return null;
        const host = url.hostname.toLowerCase();
        if (
            host === "anilist.co" ||
            host.endsWith(".anilist.co") ||
            isMiruroHostname(host) ||
            /\/media\/anime\/cover\//i.test(url.pathname) ||
            /\/cover\/(large|medium)\//i.test(url.pathname)
        ) {
            return url.toString();
        }
        return null;
    } catch {
        return null;
    }
}

let httpServer = null;
let wss = null;
let started = false;
let listening = false;
let installToken = null;
let ownerId = null;
let pageMode = null; // "watch" | "browse" | null
let focusClearTimer = null;
let browseStart = null;
let browseTimer = null;
let heartbeatTimer = null;
let dotFrame = 0;
let lastActivityKey = null;
let lastWatchSnapshot = null;
let rpc = null;
let rpcReady = false;
let reconnectTimer = null;
let statusListener = null;

const clients = new Set();
const miruroClients = new Set();
const presences = new Map();
const playbacks = new Map();

function debug(...args) {
    if (DEBUG)
        console.log(...args);
}

function info(...args) {
    console.log(...args);
}

function emitStatus() {
    if (typeof statusListener === "function")
        statusListener(getStatus());
}

function userscriptFilePath() {
    const candidates = [
        path.join(__dirname, "miruro.user.js"),
        path.join(process.resourcesPath || "", "miruro.user.js")
    ];
    for (const file of candidates) {
        try {
            if (file && fs.existsSync(file))
                return file;
        } catch { /* ignore */ }
    }
    return candidates[0];
}

function isBound() {
    return Boolean(listening && httpServer && httpServer.listening && installToken);
}

function scriptInstallUrl() {
    if (!isBound())
        return GITHUB_USERSCRIPT_URL;
    return `http://127.0.0.1:${PORT}${USERSCRIPT_ROUTE}?token=${installToken}`;
}

function getStatus() {
    return {
        version: VERSION,
        listening: isBound(),
        port: PORT,
        scriptUrl: scriptInstallUrl(),
        discord: rpcReady,
        clients: clients.size,
        miruro: miruroClients.size,
        mode: pageMode,
        watching: pageMode === "watch" && Boolean(ownerId && presences.get(ownerId))
    };
}

function sendJson(ws, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN)
        return;
    try {
        ws.send(JSON.stringify(payload));
    } catch { /* ignore */ }
}

function isLocalScriptHost(hostHeader) {
    if (!hostHeader || typeof hostHeader !== "string")
        return false;
    const host = hostHeader.toLowerCase();
    return host === `127.0.0.1:${PORT}` || host === "127.0.0.1";
}

function tokensMatch(provided, expected) {
    if (!TOKEN_RE.test(provided) || !TOKEN_RE.test(expected))
        return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function serveUserscript(req, res) {
    if (!isBound() || !isLocalScriptHost(req.headers.host)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
    }

    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    const token = url.searchParams.get("token") || "";
    if (url.pathname !== USERSCRIPT_ROUTE || !tokensMatch(token, installToken)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
    }

    const file = userscriptFilePath();
    fs.readFile(file, (err, body) => {
        if (err) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(req.method === "HEAD" ? undefined : "Userscript not found");
            return;
        }

        res.writeHead(200, {
            "Content-Type": "text/javascript; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Length": Buffer.byteLength(body)
        });
        res.end(req.method === "HEAD" ? undefined : body);
    });
}

function teardownServer() {
    if (wss) {
        try {
            wss.close();
        } catch { /* ignore */ }
        wss = null;
    }
    if (httpServer) {
        try {
            httpServer.close();
        } catch { /* ignore */ }
        httpServer = null;
    }
    listening = false;
    installToken = null;
}

function onStatus(listener) {
    statusListener = listener;
}

function start() {
    if (started)
        return Promise.resolve(getStatus());

    started = true;
    listening = false;
    installToken = null;
    info(`MiruroRPC v${VERSION}`);

    httpServer = http.createServer((req, res) => {
        if (req.method === "GET" || req.method === "HEAD") {
            serveUserscript(req, res);
            return;
        }
        res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Method not allowed");
    });

    wss = new WebSocket.Server({
        server: httpServer,
        verifyClient: (req) => isAllowedWsOrigin(req.origin)
    });
    wireSocketServer(wss);

    RPC.register(APPLICATION_ID);
    connectRPC();

    return new Promise((resolve) => {
        const onListening = () => {
            cleanupListenWait();
            listening = true;
            installToken = crypto.randomBytes(16).toString("hex");
            httpServer.on("error", (err) => {
                console.error("HTTP server error:", err.message);
                listening = false;
                installToken = null;
                emitStatus();
            });
            info(`Listening on ws://127.0.0.1:${PORT}`);
            info(`Userscript: ${scriptInstallUrl()}`);
            emitStatus();
            resolve(getStatus());
        };

        const onError = (err) => {
            cleanupListenWait();
            console.error(`Failed to bind 127.0.0.1:${PORT}:`, err.message);
            teardownServer();
            info(`Userscript fallback: ${GITHUB_USERSCRIPT_URL}`);
            emitStatus();
            resolve(getStatus());
        };

        const cleanupListenWait = () => {
            httpServer.off("listening", onListening);
            httpServer.off("error", onError);
        };

        httpServer.once("listening", onListening);
        httpServer.once("error", onError);
        httpServer.listen(PORT, "127.0.0.1");
    });
}

function stop() {
    stopBrowseTicker();
    stopHeartbeat();
    clearActivity();

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    for (const ws of clients) {
        try {
            ws.close();
        } catch { /* ignore */ }
    }
    clients.clear();
    miruroClients.clear();
    clearAllTabs();
    ownerId = null;
    pageMode = null;

    teardownServer();
    destroyRPC();
    rpcReady = false;
    started = false;
    emitStatus();
}

function stopHeartbeat() {
    if (!heartbeatTimer)
        return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
}

function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
        for (const ws of [...clients]) {
            if (ws.isAlive === false) {
                debug("Terminating unresponsive WebSocket client.");
                try {
                    ws.terminate();
                } catch { /* ignore */ }
                continue;
            }

            ws.isAlive = false;
            try {
                ws.ping();
            } catch {
                try {
                    ws.terminate();
                } catch { /* ignore */ }
            }
        }
    }, WS_HEARTBEAT_MS);
}

function destroyRPC() {
    if (!rpc)
        return;

    try {
        rpc.transport?.removeAllListeners();
    } catch { /* ignore */ }

    try {
        rpc.removeAllListeners();
    } catch { /* ignore */ }

    try {
        rpc.destroy();
    } catch { /* ignore */ }

    rpc = null;
}

function scheduleReconnect() {
    if (reconnectTimer)
        return;

    debug("Waiting for Discord...");
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        debug("Reconnecting to Discord...");
        connectRPC();
    }, 2000);
}

function disconnectRPC(message) {
    rpcReady = false;
    // Discord may have wiped presence while we still hold the last key —
    // invalidate so the next SET_ACTIVITY is not skipped as a duplicate.
    lastActivityKey = null;
    lastWatchSnapshot = null;
    emitStatus();
    if (message)
        debug(message);
    scheduleReconnect();
}

function connectRPC() {
    destroyRPC();
    rpcReady = false;

    rpc = new RPC.Client({ transport: "ipc" });

    rpc.on("ready", () => {
        rpcReady = true;
        // Force re-push after IPC reconnect (sleep/wake often clears Discord's side).
        lastActivityKey = null;
        lastWatchSnapshot = null;
        info("Discord RPC connected.");
        emitStatus();
        updateActivity();
    });

    rpc.on("disconnected", () => {
        disconnectRPC("Discord RPC disconnected.");
    });

    rpc.on("error", (err) => {
        debug(`RPC error: ${err.message}`);
    });

    rpc.login({ clientId: APPLICATION_ID }).catch((err) => {
        disconnectRPC(`RPC login failed: ${err.message}`);
    });
}

/** Call after OS sleep/wake so Discord IPC and presence dedupe recover. */
function handleResume() {
    debug("System resume — refreshing Discord RPC and probing WebSocket clients.");
    lastActivityKey = null;
    lastWatchSnapshot = null;

    for (const ws of [...clients]) {
        try {
            ws.ping();
        } catch {
            try {
                ws.terminate();
            } catch { /* ignore */ }
        }
    }

    disconnectRPC("System resumed.");
}

function wireSocketServer(server) {
    startHeartbeat();

    server.on("connection", (ws) => {
        ws.isAlive = true;
        clients.add(ws);
        emitStatus();

        ws.on("pong", () => {
            ws.isAlive = true;
        });

        ws.on("message", (raw) => {
            try {
                const data = JSON.parse(raw.toString());
                if (!data || typeof data !== "object")
                    return;
                debug("[RX]", data.type, data);

                if (data.type !== "hello" && !ws.authed)
                    return;

                switch (data.type) {
                    case "hello":
                        if (!CLIENT_TYPES.has(data.client) || !isValidId(data.id))
                            break;
                        ws.client = data.client;
                        ws.id = data.id;
                        ws.authed = true;
                        if (ws.client === "Miruro")
                            miruroClients.add(ws.id);
                        sendJson(ws, {
                            type: "hello",
                            version: VERSION,
                            scriptUrl: scriptInstallUrl()
                        });
                        info(`${ws.client} connected.`);
                        emitStatus();
                        break;
                    case "claim":
                        if (ws.client !== "Miruro" || !isValidId(data.id))
                            break;
                        // Focused Miruro tab takes ownership. Wait for browse/presence next.
                        cancelFocusClear();
                        ownerId = data.id;
                        // Reclaim after sleep/reload must be allowed to re-SET_ACTIVITY
                        // (including timestamps — don't leave shouldPushWatchUpdate blocking).
                        lastActivityKey = null;
                        lastWatchSnapshot = null;
                        emitStatus();
                        break;
                    case "browse":
                        if (ws.client !== "Miruro" || data.id !== ownerId)
                            break;
                        cancelFocusClear();
                        clearTab(data.id);
                        pageMode = "browse";
                        updateActivity();
                        emitStatus();
                        break;
                    case "presence":
                        if (ws.client !== "Miruro" || data.id !== ownerId)
                            break;
                        cancelFocusClear();
                        setPresence(data);
                        pageMode = "watch";
                        updateActivity();
                        emitStatus();
                        break;
                    case "playback":
                        // Only the focused Miruro tab (same id) may update playback.
                        // Accept ticks even during the brief clear→presence gap so
                        // embed iframes don't lose progress while metadata catches up.
                        if (data.id === ownerId) {
                            setPlayback(data);
                            if (pageMode === "watch")
                                updateActivity();
                            else
                                debug("Playback buffered (waiting for presence).", data);
                        }
                        break;
                    case "clear":
                        // SPA transition — drop stale anime immediately.
                        if (ws.client !== "Miruro" || data.id !== ownerId)
                            break;
                        cancelFocusClear();
                        clearTab(data.id);
                        pageMode = null;
                        lastWatchSnapshot = null;
                        lastActivityKey = null;
                        clearActivity();
                        emitStatus();
                        break;
                    case "hidden":
                        // Focused tab lost focus — clear shortly unless another Miruro tab claims.
                        if (ws.client === "Miruro" && data.id === ownerId)
                            scheduleFocusClear();
                        break;
                    case "leave":
                        if (ws.client === "Miruro" && ws.id)
                            releaseMiruroTab(ws.id);
                        break;
                }
            } catch (err) {
                console.error("Failed to process message:", err.message);
            }
        });

        ws.on("close", () => {
            clients.delete(ws);
            info(`${ws.client ?? "Unknown"} disconnected.`);

            if (ws.client === "Miruro" && ws.id)
                releaseMiruroTab(ws.id);
            else if (ws.client === "Embed" && ws.id) {
                playbacks.delete(ws.id);
                updateActivity();
            }

            if (clients.size === 0) {
                clearAllTabs();
                miruroClients.clear();
                ownerId = null;
                pageMode = null;
                clearActivity();
            }

            emitStatus();
        });
    });

    server.on("error", (err) => {
        console.error("WebSocket server error:", err.message);
    });
}

function cancelFocusClear() {
    if (!focusClearTimer)
        return;
    clearTimeout(focusClearTimer);
    focusClearTimer = null;
}

function scheduleFocusClear() {
    cancelFocusClear();
    // Allow a moment for the newly focused Miruro tab to claim.
    focusClearTimer = setTimeout(() => {
        focusClearTimer = null;
        pageMode = null;
        ownerId = null;
        clearActivity();
        emitStatus();
    }, 400);
}

function releaseMiruroTab(id) {
    miruroClients.delete(id);
    clearTab(id);

    if (ownerId === id) {
        ownerId = null;
        cancelFocusClear();
    }

    if (miruroClients.size === 0) {
        ownerId = null;
        pageMode = null;
        clearAllTabs();
        clearActivity();
        emitStatus();
        return;
    }

    // Another Miruro tab may still be active — wait for it to claim.
    if (!ownerId)
        pageMode = null;

    updateActivity();
    emitStatus();
}

function setPresence(data) {
    presences.set(data.id, data);
}

function setPlayback(data) {
    playbacks.set(data.id, {
        currentTime: data.currentTime,
        duration: data.duration,
        paused: Boolean(data.paused),
        updatedAt: Date.now()
    });
}

function clearTab(id) {
    presences.delete(id);
    playbacks.delete(id);
}

function clearAllTabs() {
    presences.clear();
    playbacks.clear();
}

function getPresence() {
    return ownerId ? presences.get(ownerId) : null;
}

function getPlayback() {
    return ownerId ? playbacks.get(ownerId) : null;
}

function hasValidPlayback(data) {
    return (
        Number.isFinite(data?.currentTime) &&
        Number.isFinite(data?.duration) &&
        data.duration > 0 &&
        data.currentTime >= 0
    );
}

function mergePresenceWithPlayback(presence, playback) {
    const data = { ...presence };

    // Playback channel is authoritative for the progress bar. Presence often
    // arrives without times (claim / 4s metadata tick) or with a stale local
    // scrape — never let that override a live playback update.
    if (hasValidPlayback(playback)) {
        data.currentTime = playback.currentTime;
        data.duration = playback.duration;
        data.paused = playback.paused;
    }

    return data;
}

function updateActivity() {
    if (!rpcReady)
        return;

    // Never show Discord presence unless a Miruro tab is connected.
    if (miruroClients.size === 0) {
        pageMode = null;
        clearActivity();
        return;
    }

    if (pageMode === "watch") {
        const presence = getPresence();
        if (!presence) {
            clearActivity();
            return;
        }
        stopBrowseTicker();
        browseStart = null;
        handleWatch(mergePresenceWithPlayback(presence, getPlayback()));
        return;
    }

    if (pageMode === "browse") {
        handleBrowse();
        return;
    }

    clearActivity();
}

function handleBrowse() {
    browseStart ??= Date.now();
    lastWatchSnapshot = null;
    startBrowseTicker();

    const dots = ".".repeat(dotFrame + 1);
    setActivity({
        application_id: APPLICATION_ID,
        name: "Searching for Anime! ッ",
        details: "Looking for peak",
        state: `One more episode${dots}`,
        type: 5,
        assets: {
            large_image: "miruro"
        },
        timestamps: {
            start: Math.floor(browseStart / 1000)
        }
    });
}

function startBrowseTicker() {
    if (browseTimer)
        return;

    browseTimer = setInterval(() => {
        if (pageMode !== "browse" || miruroClients.size === 0) {
            stopBrowseTicker();
            return;
        }
        dotFrame = (dotFrame + 1) % 3;
        updateActivity();
    }, BROWSE_TICK_MS);
}

function stopBrowseTicker() {
    if (!browseTimer)
        return;
    clearInterval(browseTimer);
    browseTimer = null;
    dotFrame = 0;
}

function createWatchActivity(data) {
    const details = String(data.title ?? "Unknown Anime")
        .trim()
        .slice(0, 128);

    const baseState = `EP. ${data.episode}`;
    let state = baseState;

    if (data.episodeTitle) {
        const prefix = `${baseState}: "`;
        const suffix = `"`;
        const maxLength = 128 - prefix.length - suffix.length;
        const episodeTitle = String(data.episodeTitle)
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, Math.max(0, maxLength));

        if (episodeTitle)
            state = `${prefix}${episodeTitle}${suffix}`;
    }

    const activity = {
        application_id: APPLICATION_ID,
        name: "Anime on Miruro! ッ",
        details,
        state,
        type: 3
    };

    const watchUrl = sanitizeWatchUrl(data.url);
    if (watchUrl) {
        activity.buttons = [
            {
                label: "Watch on Miruro! ッ",
                url: watchUrl
            }
        ];
    }

    return activity;
}

function applyAssets(activity, data) {
    activity.assets = {
        large_image: sanitizeCover(data.cover) || "miruro",
        large_text: data.title || "Miruro",
        small_image: "miruro",
        small_text: "Miruro"
    };
}

function applyTimestamps(activity, data) {
    const currentTime = Math.max(0, Math.min(data.currentTime, data.duration));

    if (data.paused) {
        // start === end → Discord shows a frozen 00:00 / 00:00 bar
        activity.state = `❚❚ ${activity.state}`;
        const now = Math.floor(Date.now() / 1000);
        activity.timestamps = { start: now, end: now };
        return;
    }

    activity.state = `▶ ${activity.state}`;
    const now = Date.now();
    activity.timestamps = {
        start: Math.floor((now - currentTime * 1000) / 1000),
        end: Math.floor((now + (data.duration - currentTime) * 1000) / 1000)
    };
}

function handleWatch(data) {
    const activity = createWatchActivity(data);
    applyAssets(activity, data);

    if (hasValidPlayback(data))
        applyTimestamps(activity, data);

    // Always push when Discord may have lost the activity (dedupe key cleared).
    if (
        lastActivityKey != null &&
        hasValidPlayback(data) &&
        !shouldPushWatchUpdate(data)
    ) {
        debug("Skipped playback tick.");
        return;
    }

    lastWatchSnapshot = snapshotWatch(data);
    setActivity(activity);
}

function snapshotWatch(data) {
    return {
        title: data.title ?? null,
        episode: data.episode ?? null,
        episodeTitle: data.episodeTitle ?? null,
        cover: data.cover ?? null,
        url: data.url ?? null,
        paused: Boolean(data.paused),
        currentTime: hasValidPlayback(data) ? data.currentTime : null,
        duration: hasValidPlayback(data) ? data.duration : null,
        at: Date.now()
    };
}

function shouldPushWatchUpdate(data) {
    const prev = lastWatchSnapshot;
    if (!prev)
        return true;

    if (
        prev.title !== (data.title ?? null) ||
        prev.episode !== (data.episode ?? null) ||
        prev.episodeTitle !== (data.episodeTitle ?? null) ||
        prev.cover !== (data.cover ?? null) ||
        prev.url !== (data.url ?? null) ||
        prev.paused !== Boolean(data.paused)
    ) {
        return true;
    }

    if (!hasValidPlayback(data) || prev.currentTime == null || prev.duration == null)
        return true;

    if (Math.abs(prev.duration - data.duration) > 1)
        return true;

    const expected = prev.paused
        ? prev.currentTime
        : prev.currentTime + (Date.now() - prev.at) / 1000;

    if (Math.abs(expected - data.currentTime) > 2)
        return true;

    if (!data.paused && Date.now() - prev.at > 30000)
        return true;

    return false;
}

function activityKey(activity) {
    return JSON.stringify({
        details: activity.details,
        state: activity.state,
        type: activity.type,
        image: activity.assets?.large_image,
        buttons: activity.buttons,
        urls: activity.buttons?.map((b) => b.url),
        start: activity.timestamps?.start ?? null,
        end: activity.timestamps?.end ?? null,
        paused: activity.state?.startsWith("❚❚") || false
    });
}

function setActivity(activity) {
    if (!rpcReady)
        return;

    if (!rpc?.transport?.socket) {
        disconnectRPC("Discord IPC socket missing.");
        return;
    }

    const key = activityKey(activity);
    if (key === lastActivityKey) {
        debug("Skipped duplicate activity.");
        return;
    }

    lastActivityKey = key;

    try {
        debug(`Updating: ${activity.details} (${activity.state})`);
        rpc.transport.send({
            cmd: "SET_ACTIVITY",
            args: {
                pid: process.pid,
                activity
            },
            nonce: crypto.randomUUID()
        });
    } catch (err) {
        console.error("SET_ACTIVITY failed:", err.message);
        lastActivityKey = null;
        disconnectRPC(`SET_ACTIVITY failed: ${err.message}`);
    }
}

function clearActivity() {
    debug("Clearing Rich Presence.");
    stopBrowseTicker();
    browseStart = null;
    lastActivityKey = null;
    lastWatchSnapshot = null;

    if (!rpc || !rpcReady)
        return;

    try {
        rpc.clearActivity().catch((err) => {
            debug("Failed to clear activity:", err.message);
        });
    } catch (err) {
        debug("Failed to clear activity:", err.message);
    }
}

module.exports = {
    PORT,
    VERSION,
    USERSCRIPT_ROUTE,
    GITHUB_USERSCRIPT_URL,
    start,
    stop,
    getStatus,
    onStatus,
    handleResume,
    scriptInstallUrl
};

if (require.main === module)
    start();
