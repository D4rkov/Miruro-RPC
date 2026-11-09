const statusText = document.getElementById("statusText");
const userText = document.getElementById("userText");
const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const sharingRow = document.getElementById("sharingRow");
const togglePresenceBtn = document.getElementById("togglePresenceBtn");
const forceClearBtn = document.getElementById("forceClearBtn");
const muteRow = document.getElementById("muteRow");
const muteTitleBtn = document.getElementById("muteTitleBtn");
const sharingHint = document.getElementById("sharingHint");
const testBtn = document.getElementById("testBtn");
const pushError = document.getElementById("pushError");
const redirectUriEl = document.getElementById("redirectUri");
const copyRedirect = document.getElementById("copyRedirect");
const debugPanel = document.getElementById("debugPanel");
const setupPanel = document.getElementById("setupPanel");
const debugLogEl = document.getElementById("debugLog");
const debugMeta = document.getElementById("debugMeta");
const copyDebug = document.getElementById("copyDebug");
const clearDebug = document.getElementById("clearDebug");

let pollTimer = null;
let debugTimer = null;
let lastDebugText = "";
let isDevBuild = false;

function shortTitle(title, max = 28) {
  const t = String(title || "").trim();
  if (t.length <= max)
    return t;
  return `${t.slice(0, max - 1)}…`;
}

function renderSharing(status) {
  const loggedIn = Boolean(status?.loggedIn) && !status?.authPending;
  sharingRow.hidden = !loggedIn;
  if (!loggedIn) {
    muteRow.hidden = true;
    sharingHint.hidden = true;
    return;
  }

  const enabled = status.presenceEnabled !== false;
  const muted = Boolean(status.titleMuted);
  const title = status.currentTitle;

  togglePresenceBtn.textContent = enabled ? "Presence on" : "Presence off";
  togglePresenceBtn.dataset.on = enabled ? "true" : "false";

  if (!enabled) {
    muteRow.hidden = true;
    sharingHint.hidden = false;
    sharingHint.textContent = "Discord won’t show Miruro until you turn presence back on.";
    return;
  }

  // Default hidden — only show while the focused tab is that anime's /watch page.
  muteRow.hidden = true;
  muteTitleBtn.dataset.muted = "false";

  if (status.onWatchPage === true && title) {
    muteRow.hidden = false;
    if (muted) {
      muteTitleBtn.textContent = "Unhide this anime";
      muteTitleBtn.dataset.muted = "true";
      sharingHint.hidden = false;
      sharingHint.textContent = `Hidden on Discord: ${shortTitle(title, 36)}`;
    } else {
      muteTitleBtn.textContent = `Hide “${shortTitle(title)}”`;
      sharingHint.hidden = true;
      sharingHint.textContent = "";
    }
    return;
  }

  if (status.mutedCount > 0) {
    sharingHint.hidden = false;
    sharingHint.textContent = `${status.mutedCount} anime hidden — open one on /watch to unhide.`;
  } else {
    sharingHint.hidden = true;
    sharingHint.textContent = "";
  }
}

function setDevUi(enabled) {
  isDevBuild = enabled === true;
  debugPanel.hidden = !isDevBuild;
  setupPanel.hidden = !isDevBuild;
  // Test presence lives inside #debugPanel — hidden with the whole dev block.
  if (!isDevBuild)
    stopDebugPoll();
}

function formatLogLines(entries) {
  return (entries || [])
    .map((entry) => {
      const time = new Date(entry.t).toLocaleTimeString(undefined, {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 3
      });
      let extra = "";
      if (entry.data && typeof entry.data === "object") {
        const bits = [];
        if (entry.data.ms != null)
          bits.push(`${entry.data.ms}ms`);
        if (entry.data.for)
          bits.push(`for ${entry.data.for}`);
        if (entry.data.error)
          bits.push(String(entry.data.error));
        if (bits.length)
          extra = `  (${bits.join(" · ")})`;
      }
      return `${time}  ${entry.msg}${extra}`;
    })
    .join("\n");
}

async function refreshDebug() {
  if (!isDevBuild)
    return;
  try {
    const status = await chrome.runtime.sendMessage({ type: "getDebugLog" });
    if (!status?.ok)
      return;

    const live = status.playback
      ? `live ${status.playback.at}${status.playback.paused ? " paused" : ""} ${status.playback.kind || ""}`.trim()
      : "live —";
    const sent = status.lastSent
      ? `sent ${status.lastSent.at}${status.lastSent.paused ? " paused" : ""}`
      : "sent —";
    debugMeta.textContent = `${status.pageMode || "idle"} · tab ${status.activeTabId ?? "—"} · ${live} · ${sent}${
      status.pushInFlight ? " · POSTing" : ""
    }${status.pushQueued ? " · queued" : ""}`;

    const text = formatLogLines(status.debugLog) || "(empty — seek/pause on Miruro)";
    if (text !== lastDebugText) {
      const stickBottom =
        debugLogEl.scrollTop + debugLogEl.clientHeight >= debugLogEl.scrollHeight - 24;
      debugLogEl.textContent = text;
      lastDebugText = text;
      if (stickBottom)
        debugLogEl.scrollTop = debugLogEl.scrollHeight;
    }
  } catch {
    /* popup closing */
  }
}

function stopDebugPoll() {
  if (!debugTimer)
    return;
  clearInterval(debugTimer);
  debugTimer = null;
}

function startDebugPoll() {
  if (!isDevBuild || debugTimer)
    return;
  refreshDebug();
  debugTimer = setInterval(refreshDebug, 400);
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label || `Timed out (${ms}ms)`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

async function refresh() {
  const status = await withTimeout(
    chrome.runtime.sendMessage({ type: "getStatus" }),
    8000,
    "Extension background stuck — reload the extension"
  );
  if (!status?.ok && status?.error)
    throw new Error(status.error);
  setDevUi(status.isDevBuild === true);
  if (isDevBuild)
    redirectUriEl.textContent = status.redirectUri || "…";

  if (status.lastPushError) {
    pushError.hidden = false;
    pushError.textContent = `Presence error: ${status.lastPushError}`;
  } else {
    pushError.hidden = true;
    pushError.textContent = "";
  }

  if (status.authPending) {
    statusText.textContent = status.isAndroid
      ? "Waiting for Discord… switch to that tab, approve, then come back here"
      : "Waiting for Discord… (re-open this popup after authorizing)";
    statusText.dataset.state = "";
    userText.hidden = true;
    loginBtn.hidden = true;
    logoutBtn.hidden = true;
    renderSharing(status);
    return status;
  }

  if (!status.loggedIn) {
    statusText.textContent = status.lastAuthError
      ? `Not connected — ${status.lastAuthError}`
      : "Not connected to Discord";
    statusText.dataset.state = "";
    userText.hidden = true;
    loginBtn.hidden = false;
    logoutBtn.hidden = true;
    renderSharing(status);
    return status;
  }

  const name = status.user?.global_name || status.user?.username || "Discord user";
  userText.hidden = false;
  userText.textContent = `Signed in as ${name}`;
  loginBtn.hidden = true;
  logoutBtn.hidden = false;
  renderSharing(status);

  if (status.presenceEnabled === false) {
    statusText.textContent = "Presence paused";
    statusText.dataset.state = "paused";
  } else if (status.onWatchPage && status.titleMuted) {
    statusText.textContent = "This anime is hidden from Discord";
    statusText.dataset.state = "muted";
  } else if (status.pageMode === "watch" && status.onWatchPage) {
    statusText.textContent = "Watching on Miruro";
    statusText.dataset.state = "watch";
  } else if (status.pageMode === "browse") {
    statusText.textContent = "Browsing Miruro";
    statusText.dataset.state = "browse";
  } else {
    statusText.textContent = "Connected — open a Miruro tab";
    statusText.dataset.state = "ok";
  }
  return status;
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(async () => {
    try {
      const status = await refresh();
      if (!status.authPending)
        stopPoll();
    } catch {
      /* popup may be closing */
    }
  }, 500);
}

loginBtn.addEventListener("click", async () => {
  loginBtn.disabled = true;
  statusText.textContent = "Opening Discord…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "login" });
    if (!result?.ok) {
      statusText.textContent = result?.error || result?.lastAuthError || "Login failed";
      statusText.dataset.state = "";
      pushError.hidden = false;
      pushError.textContent = statusText.textContent;
      loginBtn.disabled = false;
      await refresh();
      return;
    }
    // Tab OAuth (Android): Discord is behind this page — tell them to switch.
    // Don't refresh immediately (authPending may still be writing); keep this copy.
    if (result.authViaTab) {
      statusText.textContent =
        "Discord opened in another tab — switch to it, approve, then come back here";
      loginBtn.hidden = true;
      loginBtn.disabled = false;
      startPoll();
      return;
    }
    // Desktop identity window — same as before.
    startPoll();
    await refresh();
  } catch (err) {
    statusText.textContent = String(err.message || err);
    statusText.dataset.state = "";
    await refresh();
  } finally {
    loginBtn.disabled = false;
  }
});

logoutBtn.addEventListener("click", async () => {
  stopPoll();
  await chrome.runtime.sendMessage({ type: "logout" });
  await refresh();
});

forceClearBtn.addEventListener("click", async () => {
  forceClearBtn.disabled = true;
  statusText.textContent = "Clearing Discord presence…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "forceClearPresence" });
    if (result?.ok) {
      statusText.textContent = result.deleted
        ? `Discord presence cleared (${result.deleted} session${result.deleted === 1 ? "" : "s"})`
        : "Discord presence cleared";
      statusText.dataset.state = "ok";
    } else {
      statusText.textContent =
        result?.error || result?.lastPushError || "Clear failed";
      statusText.dataset.state = "";
    }
  } catch (err) {
    statusText.textContent = String(err?.message || err);
    statusText.dataset.state = "";
  } finally {
    forceClearBtn.disabled = false;
    await refresh();
  }
});

togglePresenceBtn.addEventListener("click", async () => {
  togglePresenceBtn.disabled = true;
  try {
    const turningOn = togglePresenceBtn.dataset.on !== "true";
    await chrome.runtime.sendMessage({
      type: "setPresenceEnabled",
      enabled: turningOn
    });
    await refresh();
  } finally {
    togglePresenceBtn.disabled = false;
  }
});

muteTitleBtn.addEventListener("click", async () => {
  muteTitleBtn.disabled = true;
  try {
    const muted = muteTitleBtn.dataset.muted === "true";
    await chrome.runtime.sendMessage({
      type: muted ? "unmuteCurrentTitle" : "muteCurrentTitle"
    });
    await refresh();
  } finally {
    muteTitleBtn.disabled = false;
  }
});

testBtn.addEventListener("click", async () => {
  if (!isDevBuild)
    return;
  testBtn.disabled = true;
  statusText.textContent = "Sending test presence…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "testPresence" });
    if (result?.lastPushError)
      throw new Error(result.lastPushError);
  } catch (err) {
    pushError.hidden = false;
    pushError.textContent = `Presence error: ${err.message || err}`;
  } finally {
    testBtn.disabled = false;
    await refresh();
    await refreshDebug();
  }
});

copyRedirect.addEventListener("click", async () => {
  const value = redirectUriEl.textContent.trim();
  await navigator.clipboard.writeText(value);
  copyRedirect.textContent = "Copied";
  setTimeout(() => {
    copyRedirect.textContent = "Copy redirect URL";
  }, 1200);
});

copyDebug.addEventListener("click", async () => {
  if (!isDevBuild)
    return;
  const payload = await chrome.runtime.sendMessage({ type: "getDebugLog" });
  const header = [
    `pageMode=${payload.pageMode}`,
    `tab=${payload.activeTabId}`,
    `playback=${JSON.stringify(payload.playback)}`,
    `lastSent=${JSON.stringify(payload.lastSent)}`,
    `pushInFlight=${payload.pushInFlight}`,
    `pushQueued=${payload.pushQueued}`,
    `seekPin=${JSON.stringify(payload.seekPin)}`,
    "---"
  ].join("\n");
  const body = formatLogLines(payload.debugLog) || "(empty)";
  await navigator.clipboard.writeText(`${header}\n${body}`);
  copyDebug.textContent = "Copied";
  setTimeout(() => {
    copyDebug.textContent = "Copy logs";
  }, 1200);
});

clearDebug.addEventListener("click", async () => {
  if (!isDevBuild)
    return;
  await chrome.runtime.sendMessage({ type: "clearDebugLog" });
  lastDebugText = "";
  await refreshDebug();
});

refresh()
  .then((status) => {
    if (status?.authPending)
      startPoll();
    if (isDevBuild)
      startDebugPoll();
  })
  .catch((err) => {
    statusText.textContent = String(err?.message || err);
    statusText.dataset.state = "";
    loginBtn.hidden = false;
    loginBtn.disabled = false;
  });
