const WebSocket = require("ws");
const RPC = require("discord-rpc");
const crypto = require("crypto");

const PORT = 3847;
const APPLICATION_ID = "1521597072434794527";
const wss = new WebSocket.Server({ port: PORT });
const clients = new Set();
const DEBUG = process.argv.includes("--debug");
const presences = new Map();
const playbacks = new Map();

let ownerId = null;
let browseStart = null;
let dotFrame = 0;
let lastActivity = null;
let rpc;
let reconnectTimer = null;
let rpcReady = false;

info("MiruroRPC v2.0.0");
info(`Listening on ws://127.0.0.1:${PORT}`);

RPC.register(APPLICATION_ID);
connectRPC();

function debug(...args) {
    if (DEBUG)
        console.log(...args);
}

function info(...args) {
    console.log(...args);
}

function getPresence() {
    return presences.get(ownerId);
}

function getPlayback() {
    return playbacks.get(ownerId);
}

function setPresence(data) {
    presences.set(data.id, data);
}

function setPlayback(data) {
    playbacks.set(data.id, data);
}

function clearTab(id) {
    presences.delete(id);
    playbacks.delete(id);
}

function clearAllTabs() {
    presences.clear();
    playbacks.clear();
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

    if (message)
        debug(message);

    scheduleReconnect();

}

function connectRPC() {

    if (rpc?.transport) {
        try {
            rpc.transport.removeAllListeners();
        } catch { }
    }

    if (rpc) {
        rpc.removeAllListeners();
    }

    rpc = new RPC.Client({
        transport: "ipc"
    });

    rpc.on("ready", () => {
        rpcReady = true;
        info("Discord RPC connected.");
    });

    rpc.on("disconnected", () => {
        disconnectRPC("Discord RPC disconnected.");
    });

    rpc.on("error", err => {
        debug(`RPC error: ${err.message}`);
    });

    rpc.login({
        clientId: APPLICATION_ID
    }).catch(err => {
        disconnectRPC(`RPC login failed: ${err.message}`);
    });

}

wss.on("connection", (ws) => {

    clients.add(ws);

    ws.on("message", (message) => {

        try {

            const data = JSON.parse(message.toString());

            debug("[RX]", data.type, data);

            if (data.type === "hello") {
                ws.client = data.client;
                ws.id = data.id;
                info(`${ws.client} connected.`);
                return;
            }

            switch (data.type) {

                case "claim":
                    handleClaimMessage(data);
                    break;

                case "browse":
                    handleBrowseMessage(data);
                    break;

                case "presence":
                    handlePresenceMessage(data);
                    break;

                case "playback":
                    handlePlaybackMessage(data);
                    break;

            }
        } catch (err) {
            console.error("Failed to process message:", err);
        }

    });

    ws.on("close", () => {
        clients.delete(ws);

        info(`${ws.client ?? "Unknown"} disconnected.`);

        if (ws.id) {
            clearTab(ws.id);

            if (ownerId === ws.id) {
                ownerId = null;
                updateActivity();
            }
        }

        if (clients.size === 0) {
            clearAllTabs();
            ownerId = null;
            clearActivity();
        }
    });

});

function handleClaimMessage(data) {
    ownerId = data.id;
    updateActivity();
}

function handleBrowseMessage(data) {
    if (data.id !== ownerId)
        return;

    clearTab(data.id);
    updateActivity();
}

function handlePresenceMessage(data) {
    setPresence(data);
    updateActivity();
}

function handlePlaybackMessage(data) {
    setPlayback(data);
    updateActivity();
}

function mergePlayback(data, playback) {

    const hasNativePlayback =
        data.currentTime != null &&
        data.duration != null;

    if (hasNativePlayback)
        return true;

    if (!playback)
        return false;

    data.currentTime = playback.currentTime;
    data.duration = playback.duration;
    data.paused = playback.paused;

    return true;

}

function updateActivity() {

    if (!rpcReady)
        return;

    const presence = getPresence();
    const playback = getPlayback();

    if (!presence) {
        handleBrowse();
        return;
    }

    const data = { ...presence };

    if (!mergePlayback(data, playback))
        return;

    handlePresence(data);

}

function handleBrowse() {

    browseStart ??= Date.now();

    const dots = ".".repeat(dotFrame + 1);
    dotFrame = (dotFrame + 1) % 3;

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

function createActivity(data) {

    return {

        application_id: APPLICATION_ID,
        name: "Anime on Miruro! ッ",
        details: data.title,
        state: data.episodeTitle
            ? `EP. ${data.episode}: "${data.episodeTitle}"`
            : `EP. ${data.episode}`,
        type: 3,

        buttons: [{
            label: "Watch on Miruro! ッ",
            url: data.url
        }]

    };

}

function applyAssets(activity, data) {

    activity.assets = {

        large_image: data.cover,
        large_text: data.title,
        small_image: "miruro",
        small_text: "Miruro"

    };

}

function applyTimestamps(activity, data) {

    if (data.paused) {

        activity.state = `❚❚ ${activity.state}`;

        const now = Math.floor(Date.now() / 1000);

        activity.timestamps = {
            start: now,
            end: now
        };

        return;
    }

    activity.state = `▶ ${activity.state}`;

    const now = Date.now();

    activity.timestamps = {
        start: Math.floor((now - data.currentTime * 1000) / 1000),
        end: Math.floor((now + (data.duration - data.currentTime) * 1000) / 1000)
    };

}

function handlePresence(data) {
    browseStart = null;

    const activity = createActivity(data);

    applyAssets(activity, data);
    applyTimestamps(activity, data);

    setActivity(activity);
}

function setActivity(activity) {

    if (!rpcReady || !rpc?.transport?.socket)
        return;

    const key = JSON.stringify({
        details: activity.details,
        state: activity.state,
        type: activity.type,
        image: activity.assets?.large_image,
        buttons: activity.buttons,
        urls: activity.buttons?.map(b => b.url),
        start: activity.timestamps?.start ?? null,
        end: activity.timestamps?.end ?? null
    });

    if (key === lastActivity) {
        debug("Skipped duplicate activity.");
        return;
    }

    lastActivity = key;

    try {
        debug(
            `Updating: ${activity.details} (${activity.state})`
        );
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
    }

}

function clearActivity() {
    debug("Clearing Rich Presence.");

    if (!rpc)
        return;

    lastActivity = null;

    rpc.clearActivity().catch(err => {
        console.error("Failed to clear activity:", err.message);
    });

}