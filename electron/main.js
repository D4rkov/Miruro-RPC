const path = require("path");
const fs = require("fs");
const {
    app,
    Tray,
    Menu,
    nativeImage,
    shell,
    dialog,
    Notification
} = require("electron");
const { autoUpdater } = require("electron-updater");

const bridge = require("../MiruroRPC");

const USERSCRIPT_INSTALL_URL =
    "https://github.com/D4rkov/Miruro-RPC/raw/main/miruro.user.js";
const TAMPERMONKEY_URL = "https://www.tampermonkey.net/";
const RELEASES_URL = "https://github.com/D4rkov/Miruro-RPC/releases";
const MIRURO_URL = "https://www.miruro.tv";

let tray = null;
let quitting = false;
let updateState = "idle"; // idle | checking | available | downloaded | error
let latestVersion = null;

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
            label: `MiruroRPC v${app.getVersion()}`,
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
    const { response } = await dialog.showMessageBox({
        type: "question",
        title: "Install userscript",
        message: "Install the MiruroRPC userscript?",
        detail:
            "Needs Tampermonkey in your browser.\n" +
            "If you already have it, choose Install script.",
        buttons: ["Install script", "Get Tampermonkey", "Cancel"],
        defaultId: 0,
        cancelId: 2,
        noLink: true
    });

    if (response === 0)
        await shell.openExternal(USERSCRIPT_INSTALL_URL);
    else if (response === 1)
        await shell.openExternal(TAMPERMONKEY_URL);
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

app.whenReady().then(() => {
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
    bridge.start();

    createTray();
    setupAutoUpdater();

    // Default to start with Windows on first packaged run
    if (app.isPackaged && !app.getLoginItemSettings().wasOpenedAtLogin) {
        const storePath = path.join(app.getPath("userData"), "settings.json");
        let settings = {};
        try {
            settings = JSON.parse(fs.readFileSync(storePath, "utf8"));
        } catch { /* first run */ }

        if (settings.openAtLogin == null) {
            setOpenAtLogin(true);
            settings.openAtLogin = true;
            try {
                fs.writeFileSync(storePath, JSON.stringify(settings, null, 2));
            } catch { /* ignore */ }
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
