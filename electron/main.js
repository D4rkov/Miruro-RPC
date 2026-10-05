const path = require("path");
const fs = require("fs");
const {
    app,
    Tray,
    Menu,
    nativeImage,
    shell,
    dialog,
    Notification,
    powerMonitor
} = require("electron");
const { autoUpdater } = require("electron-updater");

const bridge = require("../MiruroRPC");

const FALLBACK_USERSCRIPT_URL =
    bridge.GITHUB_USERSCRIPT_URL ||
    "https://github.com/D4rkov/Miruro-RPC/raw/main/miruro.user.js";
const TAMPERMONKEY_URL = "https://www.tampermonkey.net/";
const RELEASES_URL = "https://github.com/D4rkov/Miruro-RPC/releases";
const MIRURO_URL = "https://barelystarted.miruro.tv";

let tray = null;
let quitting = false;
let updateState = "idle"; // idle | checking | available | downloaded | error
let latestVersion = null;

function settingsPath() {
    return path.join(app.getPath("userData"), "settings.json");
}

function readSettings() {
    try {
        return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    } catch {
        return {};
    }
}

function writeSettings(settings) {
    try {
        fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    } catch { /* ignore */ }
}

function userscriptInstallUrl() {
    try {
        const status = bridge.getStatus();
        if (status.listening && typeof status.scriptUrl === "string" && status.scriptUrl)
            return status.scriptUrl;
    } catch { /* ignore */ }
    return FALLBACK_USERSCRIPT_URL;
}

function iconPath() {
    return path.join(__dirname, "..", "assets", "icon.png");
}

function loadTrayIcon() {
    const file = iconPath();
    let image = nativeImage.createFromPath(file);
    if (image.isEmpty())
        image = nativeImage.createEmpty();
    return image.resize({ width: 16, height: 16 });
}

function userscriptPath() {
    if (app.isPackaged)
        return path.join(process.resourcesPath, "miruro.user.js");
    return path.join(__dirname, "..", "miruro.user.js");
}

function isOpenAtLogin() {
    return app.getLoginItemSettings().openAtLogin;
}

function setOpenAtLogin(enabled) {
    app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: true,
        path: process.execPath,
        args: app.isPackaged ? [] : [path.resolve(__dirname, "..")]
    });
}

function statusLabel(status) {
    if (!status.discord)
        return "Waiting for Discord…";
    if (status.watching)
        return "Watching on Miruro";
    if (status.clients > 0)
        return "Connected — browsing";
    return "Running — idle";
}

function updateLabel() {
    switch (updateState) {
        case "checking":
            return "Checking for updates…";
        case "available":
            return latestVersion
                ? `Update available (v${latestVersion})`
                : "Update available";
        case "downloaded":
            return "Update ready — restart to install";
        case "error":
            return "Update check failed";
        default:
            return "Check for updates";
    }
}

function rebuildMenu() {
    if (!tray)
        return;

    const status = bridge.getStatus();
    const openAtLogin = isOpenAtLogin();

    const template = [
        {
            label: `MiruroRPC v${status.version || app.getVersion()}`,
            enabled: false
        },
        {
            label: statusLabel(status),
            enabled: false
        },
        {
            label: status.discord ? "Discord: connected" : "Discord: disconnected",
            enabled: false
        },
        { type: "separator" },
        {
            label: "Open Miruro",
            click: () => shell.openExternal(MIRURO_URL)
        },
        {
            label: "Install / update userscript",
            click: () => installUserscript()
        },
        {
            label: "Copy userscript path",
            click: async () => {
                const { clipboard } = require("electron");
                clipboard.writeText(userscriptPath());
                notify("Userscript path copied", userscriptPath());
            }
        },
        { type: "separator" },
        {
            label: "Start with Windows",
            type: "checkbox",
            checked: openAtLogin,
            click: (item) => setOpenAtLogin(item.checked)
        },
        {
            label: updateLabel(),
            enabled: updateState !== "checking",
            click: () => {
                if (updateState === "downloaded") {
                    autoUpdater.quitAndInstall();
                    return;
                }
                checkForUpdates(true);
            }
        },
        {
            label: "GitHub releases",
            click: () => shell.openExternal(RELEASES_URL)
        },
        { type: "separator" },
        {
            label: "Quit MiruroRPC",
            click: () => {
                quitting = true;
                app.quit();
            }
        }
    ];

    tray.setContextMenu(Menu.buildFromTemplate(template));
    tray.setToolTip(`MiruroRPC — ${statusLabel(status)}`);
}

async function installUserscript() {
    const url = userscriptInstallUrl();
    const local = url.startsWith("http://127.0.0.1:");
    const { response } = await dialog.showMessageBox({
        type: "question",
        title: "Install userscript",
        message: "Install the MiruroRPC userscript?",
        detail:
            "Needs Tampermonkey in your browser.\n" +
            (local
                ? "Opens the script from this app so it matches the bridge version."
                : "Bridge port unavailable — opens the GitHub userscript instead."),
        buttons: ["Install script", "Get Tampermonkey", "Cancel"],
        defaultId: 0,
        cancelId: 2,
        noLink: true
    });

    if (response === 0)
        await shell.openExternal(url);
    else if (response === 1)
        await shell.openExternal(TAMPERMONKEY_URL);
}

async function nudgeUserscriptAfterAppUpdate(version) {
    const { response } = await dialog.showMessageBox({
        type: "info",
        title: "Update userscript too",
        message: `MiruroRPC v${version} is ready.`,
        detail:
            "Tampermonkey does not update automatically with the tray app.\n" +
            "Open the matching userscript so Tampermonkey can install/update it.",
        buttons: ["Update userscript", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true
    });

    if (response === 0)
        await shell.openExternal(userscriptInstallUrl());
}

function notify(title, body) {
    if (!Notification.isSupported())
        return;
    new Notification({ title, body }).show();
}

function setupAutoUpdater() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("checking-for-update", () => {
        updateState = "checking";
        rebuildMenu();
    });

    autoUpdater.on("update-available", (info) => {
        updateState = "available";
        latestVersion = info.version;
        rebuildMenu();
        notify("Update available", `Downloading MiruroRPC v${info.version}…`);
    });

    autoUpdater.on("update-not-available", () => {
        updateState = "idle";
        rebuildMenu();
    });

    autoUpdater.on("error", (err) => {
        updateState = "error";
        rebuildMenu();
        debugUpdater("update error", err?.message || err);
    });

    autoUpdater.on("update-downloaded", (info) => {
        updateState = "downloaded";
        latestVersion = info.version;
        rebuildMenu();
        notify(
            "Update ready",
            `MiruroRPC v${info.version} will install on restart (or click the tray item).`
        );
    });
}

function checkForUpdates(manual = false) {
    if (!app.isPackaged) {
        if (manual)
            notify("Dev mode", "Auto-update only runs in the installed app.");
        return;
    }

    autoUpdater.checkForUpdates().catch((err) => {
        updateState = "error";
        rebuildMenu();
        if (manual)
            notify("Update check failed", String(err.message || err));
    });
}

function debugUpdater(...args) {
    if (process.argv.includes("--debug"))
        console.log("[updater]", ...args);
}

function createTray() {
    tray = new Tray(loadTrayIcon());
    tray.setToolTip("MiruroRPC");
    tray.on("click", () => tray.popUpContextMenu());
    tray.on("right-click", () => tray.popUpContextMenu());
    rebuildMenu();
}

app.whenReady().then(async () => {
    if (process.platform === "win32")
        app.setAppUserModelId("com.darkov.mirurorpc");

    // Single instance — second launch just focuses tray UX
    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
        app.quit();
        return;
    }

    app.on("second-instance", () => {
        notify("MiruroRPC", "Already running in the system tray.");
        rebuildMenu();
    });

    bridge.onStatus(() => rebuildMenu());
    await bridge.start();

    powerMonitor.on("resume", () => {
        try {
            bridge.handleResume();
        } catch { /* ignore */ }
    });

    createTray();
    setupAutoUpdater();

    // Default to start with Windows on first packaged run
    if (app.isPackaged && !app.getLoginItemSettings().wasOpenedAtLogin) {
        const settings = readSettings();
        if (settings.openAtLogin == null) {
            setOpenAtLogin(true);
            settings.openAtLogin = true;
            writeSettings(settings);
        }
    }

    // After an installed update, remind once that Tampermonkey is separate.
    if (app.isPackaged) {
        const version = app.getVersion();
        const settings = readSettings();
        const previous = settings.lastRunningVersion;
        if (previous !== version) {
            settings.lastRunningVersion = version;
            writeSettings(settings);
            if (previous)
                nudgeUserscriptAfterAppUpdate(version);
        }
    }

    checkForUpdates(false);
    setInterval(() => checkForUpdates(false), 6 * 60 * 60 * 1000);
});

app.on("before-quit", () => {
    quitting = true;
    try {
        bridge.stop();
    } catch { /* ignore */ }
});

app.on("window-all-closed", () => {
    // Tray-only app — keep running with no windows.
});
