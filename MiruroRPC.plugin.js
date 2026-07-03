/**
 * @name MiruroRPC
 * @author Darkov
 * @version 2.0.0
 * @description Discord Rich Presence for Miruro
 */

const BRIDGE_URL = "ws://127.0.0.1:3847";
const RECONNECT_DELAY = 2000;

const APPLICATION_ID = "1521597072434794527";

module.exports = class MiruroRPC {

    start() {

        this.api = new BdApi("MiruroRPC");

        this.dispatcher =
            this.api.Webpack.getStore("UserStore")?._dispatcher;

        this.lastActivity = null;
        this.presence = null;
        this.playback = null;
        this.lastMessage = Date.now();
        this.activityCleared = false;

        this.dotFrame = 0;
        this.browseStart = null;

        this.largeImage = null;
        this.browseImage = "miruro";

        this.shouldReconnect = true;

        this.resolveAssets();

        this.watchdog = setInterval(() => {
            if (
                !this.activityCleared &&
                Date.now() - this.lastMessage > 10000
            ) {

                this.setActivity({});

                this.activityCleared = true;
            }
        }, 1000);

        this.connect();
    }

    async resolveAssets() {

        const filter = this.api.Webpack.Filters.byStrings(
            "getAssetImage: size must === [number, number] for Twitch"
        );

        const assetManager = this.api.Webpack.getModule(
            m =>
                typeof m === "object" &&
                Object.values(m).some(filter)
        );

        for (const key in assetManager) {
            const fn = assetManager[key];

            if (
                typeof fn === "function" &&
                fn.toString().includes("APPLICATION_ASSETS_FETCH")
            ) {
                this.getAsset = fn;
                break;
            }
        }

        if (!this.getAsset)
            return;

        try {

            [this.browseImage] = await this.getAsset(
                APPLICATION_ID,
                ["miruro"]
            );

        } catch (err) {
            console.error("[MiruroRPC] Failed to resolve assets:", err);
        }
    }

    connect() {

        console.log("[MiruroRPC] Connecting...");

        this.socket = new WebSocket(BRIDGE_URL);

        this.socket.onopen = () => {

            console.log("[MiruroRPC] Connected.");

            this.socket.send(JSON.stringify({
                type: "hello",
                client: "Discord"
            }));

        };

        this.socket.onmessage =
            event => this.handleMessage(event);

        this.socket.onclose = () => {

            console.log("[MiruroRPC] Disconnected.");

            if (!this.shouldReconnect)
                return;

            this.reconnectTimer = setTimeout(
                () => this.connect(),
                RECONNECT_DELAY
            );

        };

        this.socket.onerror = console.error;

    } async handleMessage(event) {

        try {

            let data = JSON.parse(event.data);

            this.lastMessage = Date.now();
            this.activityCleared = false;

            switch (data.type) {

                case "browse":
                    this.presence = null;
                    this.playback = null;
                    this.handleBrowse();
                    return;

                case "playback":
                    this.playback = data;

                    if (!this.presence)
                        return;

                    await this.handlePresence({
                        ...this.presence,
                        currentTime: data.currentTime,
                        duration: data.duration,
                        paused: data.paused
                    });
                    return;

                case "presence": {
                    this.presence = data;

                    const hasNativePlayback =
                        data.currentTime != null &&
                        data.duration != null;

                    if (!hasNativePlayback && this.playback) {
                        data = {
                            ...data,
                            currentTime: this.playback.currentTime,
                            duration: this.playback.duration,
                            paused: this.playback.paused
                        };
                    } else if (hasNativePlayback) {
                        // Native playback takes priority.
                        this.playback = null;
                    }

                    await this.handlePresence(data);
                    return;
                }
                default:
                    return;
            }

        } catch (err) {

            console.error("[MiruroRPC]", err);

        }

    }

    handleBrowse() {

        this.largeImage = null;
        this.browseStart ??= Date.now();

        if (!this.browseStart)
            this.browseStart = Date.now();

        const dots = ".".repeat(this.dotFrame + 1);
        this.dotFrame = (this.dotFrame + 1) % 3;

        this.setActivity({

            application_id: APPLICATION_ID,

            name: "Searching for Anime! ッ",
            details: "Looking for peak",
            state: `One more episode${dots}`,
            timestamps: {
                start: this.browseStart
            },
            assets: {
                large_image: this.browseImage
            },
            flags: 1,
            type: 5

        });

    }

    async handlePresence(data) {

        let largeImage = this.largeImage ?? this.browseImage;

        if (this.getAsset && data.cover) {

            try {

                [largeImage] = await this.getAsset(
                    APPLICATION_ID,
                    [data.cover]
                );

                this.largeImage = largeImage;

            } catch (err) {
                console.error("Asset fetch failed:", err);
            }

        }

        const activity = {

            application_id: APPLICATION_ID,

            name: "Anime on Miruro! ッ",
            details: data.title,
            state: data.episodeTitle
                ? `EP. ${data.episode}: "${data.episodeTitle}"`
                : `EP. ${data.episode}`,
            buttons: [
                "Watch on Miruro! ッ"
            ],
            metadata: {
                button_urls: [
                    data.url
                ]
            },
            flags: 1,
            type: 3

        };

        activity.assets = {

            large_image: largeImage,
            large_text: data.title,
            small_image: this.browseImage,
            small_text: "Miruro"

        };

        if (data.paused) {

            activity.state = `❚❚ ${activity.state}`;

            const now = Date.now();

            activity.timestamps = {
                start: now,
                end: now
            };

        } else {

            activity.state = `▶ ${activity.state}`;

            const now = Date.now();

            activity.timestamps = {
                start: now - (data.currentTime * 1000),
                end: now + ((data.duration - data.currentTime) * 1000)

            };

        }
        this.setActivity(activity);

    }

    setActivity(activity) {

        if (!this.dispatcher) {
            console.error("[MiruroRPC] Dispatcher not found.");
            return;
        }

        const key = JSON.stringify({
            details: activity.details,
            state: activity.state,
            type: activity.type,
            image: activity.assets?.large_image,
            largeText: activity.assets?.large_text,
            buttons: activity.buttons,
            urls: activity.metadata?.button_urls,
            start: activity.timestamps
                ? Math.floor(activity.timestamps.start / 1000)
                : null,

            end: activity.timestamps
                ? Math.floor(activity.timestamps.end / 1000)
                : null,
        });
        if (key === this.lastActivity) {
            return;
        }

        this.lastActivity = key;

        this.dispatcher.dispatch({
            type: "LOCAL_ACTIVITY_UPDATE",
            activity,
            socketId: "MiruroRPC"
        });

    }

    clearActivity() {

        this.lastActivity = null;

        this.dispatcher.dispatch({
            type: "LOCAL_ACTIVITY_UPDATE",
            activity: {},
            socketId: "MiruroRPC"
        });

    }

    stop() {

        this.shouldReconnect = false;

        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);

        if (this.watchdog)
            clearInterval(this.watchdog);

        this.clearActivity();

        if (this.socket)
            this.socket.close();

        console.log("[MiruroRPC] Stopped.");

    }

};