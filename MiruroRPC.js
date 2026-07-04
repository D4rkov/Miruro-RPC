const WebSocket = require("ws");
const RPC = require("discord-rpc");
const crypto = require("crypto");

const PORT = 3847;
const APPLICATION_ID = "1521597072434794527";
const wss = new WebSocket.Server({ port: PORT });
const clients = new Set();
const DEBUG = false;

let presence = null;
let playback = null;
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
        rpcReady = false;
        debug("Discord RPC disconnected.");
        scheduleReconnect();
    });

    rpc.on("error", err => {
        debug("RPC error:", err.message);
    });

    rpc.login({
        clientId: APPLICATION_ID
    }).catch(err => {
        if (err.message !== "Could not connect")
            debug("RPC login failed:", err.message);
        scheduleReconnect();
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
                info(`${ws.client} connected.`);
                return;
            }

            switch (data.type) {

                case "browse":
                    presence = null;
                    playback = null;
                    handleBrowse();
                    break;

                case "presence":
                    presence = data;
                    updateActivity();
                    break;

                case "playback":
                    playback = data;
                    updateActivity();
                    break;

            }

        } catch (err) {
            console.error("Failed to process message:", err);
        }

    });

    ws.on("close", () => {
        clients.delete(ws);
        info(`${ws.client ?? "Unknown"} disconnected.`);
        if (clients.size === 0) {

            presence = null;
            playback = null;

            clearActivity();

        }
    });

    ws.on("error", (err) => {
        console.error("Client error:", err.message);
    });

});

function updateActivity() {

    if (!rpcReady)
        return;

    if (!presence) {
        handleBrowse();
        return;
    }

    let data = { ...presence };

    const hasNativePlayback =
        data.currentTime != null &&
        data.duration != null;

    if (!hasNativePlayback) {

        if (!playback)
            return;

        data.currentTime = playback.currentTime;
        data.duration = playback.duration;
        data.paused = playback.paused;

    } else {

        // Native playback takes priority.
        playback = null;

    }

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

function handlePresence(data) {
    browseStart = null;
    const activity = {

        application_id: APPLICATION_ID,
        name: "Anime on Miruro! ッ",
        details: data.title,
        state: data.episodeTitle
            ? `EP. ${data.episode}: "${data.episodeTitle}"`
            : `EP. ${data.episode}`,
        type: 3,

        buttons: [
            {
                label: "Watch on Miruro! ッ",
                url: data.url
            }
        ]

    };

    activity.assets = {

        large_image: data.cover,
        large_text: data.title,
        small_image: "miruro",
        small_text: "Miruro"

    };

    if (data.paused) {

        activity.state = `❚❚ ${activity.state}`;

        const now = Math.floor(Date.now() / 1000);

        activity.timestamps = {
            start: now,
            end: now
        };

    } else {

        activity.state = `▶ ${activity.state}`;

        const now = Date.now();

        activity.timestamps = {
            start: Math.floor((now - data.currentTime * 1000) / 1000),
            end: Math.floor((now + (data.duration - data.currentTime) * 1000) / 1000)
        };

    }

    setActivity(activity);

}

function setActivity(activity) {

    if (!rpc?.transport)
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