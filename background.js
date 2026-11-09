import {
  ACTIVITY,
  API_BASE,
  CLIENT_ID,
  FORCE_RELEASE_UI,
  OAUTH_REDIRECT_URI,
  SCOPES
} from "./config.js";

const STORAGE_KEYS = {
  tokens: "tokens",
  user: "user",
  sessionToken: "sessionToken",
  /** Recent headless tokens — delete-all on clear so orphans aren't lost. */
  sessionTokenHistory: "sessionTokenHistory",
  oauthPending: "oauthPending",
  authPending: "authPending",
  lastAuthError: "lastAuthError",
  lastPushError: "lastPushError",
  presenceState: "presenceState",
  presenceEnabled: "presenceEnabled",
  mutedTitles: "mutedTitles"
};

/** @type {{ access_token: string, refresh_token?: string, expires_at: number } | null} */
let tokens = null;
/** @type {{ id: string, username: string, global_name?: string, avatar?: string } | null} */
let user = null;
let sessionToken = null;
/** Ring of recent headless session tokens (lost primary → still deletable). */
let sessionTokenHistory = [];
let lastAuthError = null;
let lastPushError = null;
let authPending = false;
/** @type {Promise<void> | null} */
let loginInFlight = null;
/** In-tab OAuth waiter — resolved by tabs.onUpdated or oauth-callback content script. */
let oauthWaiter = null;

/** Active Miruro tab driving presence */
let activeTabId = null;
let pageMode = "idle"; // idle | browse | watch
/** Master switch — when false, Discord stays clear. */
let presenceEnabled = true;
/** After Clear stuck RPC — ignore browse/watch posts briefly so tabs don't revive it. */
let presenceSuppressedUntil = 0;
/** Normalized anime titles the user does not want shared. */
let mutedTitles = [];
let presenceData = null;
let playbackData = null;
let browseStart = null;
let dotFrame = 0;
let lastActivityKey = null;
let pushTimer = null;
let pushInFlight = false;
let pushQueued = false;
/** Last playback we actually sent to Discord (for drift-based seek detection). */
let lastSentPlayback = null;
/** Wall clock of last successful Discord upsert — used to skip redundant keepalives. */
let lastPushAt = 0;
/** Don't POST again until this time (Discord 429 backoff). */
let rateLimitUntil = 0;
let rateLimitRetryTimer = null;
/**
 * After a scrub, lock onto that timeline. Miruro often has a second embed
 * still playing the old time — treating those jumps as seeks caused an
 * abort/rate-limit death spiral (3:49 ↔ 7:34 in the logs).
 */
let seekPin = null;
/** Prefer recent trusted media; strmcx is Miruro's primary player now. */
let lastMediaSourceAt = 0;
let lastMediaSource = "";
/** Debounce Discord POSTs so dual embed ticks coalesce. */
let flushDebounceTimer = null;
const FLUSH_DEBOUNCE_MS = 400;
const MIN_POST_GAP_MS = 3500;
const SEEK_PLAY_COALESCE_MS = 700;
const SEEK_PIN_MS = 5000;
const SEEK_PIN_TOLERANCE_S = 2.5;
const EPISODE_SWITCH_DEBOUNCE_MS = 600;
/** After switching anime, ignore weak/ghost ticks so the old iframe can't leak its time. */
let playbackMuteUntil = 0;
/** After watch/switch, wait for first trusted media before POSTing Discord (avoids 00:00 flash). */
let watchAwaitingPlayback = false;
/** First progress flush already queued — don't spam YOU play every second. */
let watchPlaybackFlushQueued = false;
let watchPlaybackKickTimer = null;
let watchNavFallbackTimer = null;
let watchPlaybackKickTries = 0;
/** Set only by the nav fallback timer so title-only POST is intentional. */
let watchNavAllowTitleOnly = false;
let lastNavAction = "";
let lastNavAt = 0;
const MEDIA_SOURCE_RANK = { video: 2, strmcx: 2, player: 1, clock: 0, presence: 0, unknown: 0 };
const TRUSTED_MEDIA_RANK = 2;

/** Ring buffer for the popup debug panel — paste these when something flakes. */
const DEBUG_LOG_MAX = 120;
/** @type {{ t: number, msg: string, data?: object }[]} */
const debugLog = [];
/** Unpacked / temporary installs only — store & AMO builds stay quiet.
 *  FORCE_RELEASE_UI wins immediately so the release popup preview is accurate. */
let isDevBuild = !FORCE_RELEASE_UI;
const installInfoPromise = FORCE_RELEASE_UI
  ? Promise.resolve(false)
  : (chrome.management?.getSelf?.() || Promise.reject())
    .then((info) => {
      isDevBuild = info?.installType === "development";
      if (!isDevBuild)
        debugLog.length = 0;
      return isDevBuild;
    })
    .catch(() => {
      // No management API — treat as release (don't leave logging on forever).
      isDevBuild = false;
      debugLog.length = 0;
      return false;
    });

async function ensureDevBuildFlag() {
  if (FORCE_RELEASE_UI) {
    isDevBuild = false;
    return false;
  }
  await installInfoPromise;
  return isDevBuild;
}

/** @type {{ action: string, at: string, paused: boolean, id: number } | null} */
let pendingUserAction = null;
let actionSeq = 0;

function rpcLog(msg, data) {
  if (!isDevBuild)
    return;
  const entry = { t: Date.now(), msg: String(msg) };
  if (data != null)
    entry.data = data;
  debugLog.push(entry);
  if (debugLog.length > DEBUG_LOG_MAX)
    debugLog.splice(0, debugLog.length - DEBUG_LOG_MAX);
  try {
    console.log(`[MiruroRPC] ${entry.msg}`, data ?? "");
  } catch { /* ignore */ }
}

function formatClock(seconds) {
  const t = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatPlaybackShort(data) {
  if (!data)
    return null;
  return {
    at: formatClock(data.currentTime),
    paused: Boolean(data.paused),
    kind: data.kind || "",
    source: data.source || ""
  };
}

function describeAction(kind, playback) {
  const at = formatClock(playback?.currentTime);
  if (kind === "pause" || kind === "ended" || (playback?.paused && kind !== "play"))
    return `pause @ ${at}`;
  if (kind === "play" || kind === "resume")
    return `play @ ${at}`;
  if (kind === "seek")
    return `seek → ${at}`;
  if (playback?.paused)
    return `pause @ ${at}`;
  return `update @ ${at}`;
}

function fixActionSnapshot(kind, playback) {
  const snap = playbackSnapshot(playback);
  if (!snap)
    return null;
  // Scrubs while watching are playing; pause/ended are paused.
  if (kind === "pause" || kind === "ended")
    snap.paused = true;
  else if (kind === "play" || kind === "resume" || kind === "seek")
    snap.paused = false;
  snap.kind = kind || "";
  return snap;
}

/**
 * Log a user action. Scrubs usually emit seek+play back-to-back — coalesce
 * those into one YOU line / one Discord POST so we don't burn the rate limit.
 * Returns false if this event should not trigger another flush.
 */
function logYou(kind, playback) {
  const now = Date.now();
  const at = formatClock(playback?.currentTime);
  const snapshot = fixActionSnapshot(kind, playback);

  // seek → play within 700ms = one scrub (never coalesce pause away)
  if (
    (kind === "play" || kind === "resume") &&
    pendingUserAction &&
    pendingUserAction.kind === "seek" &&
    now - pendingUserAction.t < SEEK_PLAY_COALESCE_MS &&
    Math.abs((Number(playback?.currentTime) || 0) - (pendingUserAction.seconds || 0)) < 2
  ) {
    pendingUserAction.paused = false;
    pendingUserAction.action = `seek → ${at}`;
    pendingUserAction.t = now;
    if (snapshot) {
      snapshot.paused = false;
      pendingUserAction.snapshot = snapshot;
    }
    return false;
  }

  // duplicate play/pause spam
  if (
    pendingUserAction &&
    pendingUserAction.kind === kind &&
    now - pendingUserAction.t < 400 &&
    pendingUserAction.at === at
  ) {
    return false;
  }

  const id = ++actionSeq;
  const action = describeAction(kind, playback);
  pendingUserAction = {
    id,
    action,
    at,
    seconds: Number(playback?.currentTime) || 0,
    paused: Boolean(snapshot?.paused),
    kind: kind || "",
    t: now,
    snapshot
  };
  rpcLog(`YOU  ${action}`, { id, source: playback?.source || "" });
  return true;
}

/** Navigation / tab context — always pairs with a DISCORD line. */
function logYouNav(action) {
  const now = Date.now();
  // Same anime scrape twice (title then cover) must not double-fire.
  if (action === lastNavAction && now - lastNavAt < 5000)
    return null;
  lastNavAction = action;
  lastNavAt = now;

  const id = ++actionSeq;
  pendingUserAction = {
    id,
    action,
    at: "",
    seconds: 0,
    paused: false,
    kind: "nav",
    t: now,
    snapshot: null
  };
  rpcLog(`YOU  ${action}`, { id });
  return id;
}

/** Log when Discord actually accepted a presence POST. */
function logDiscord(ok, playback, extra = {}) {
  let shown = extra.shown || null;
  if (!shown) {
    const snap = formatPlaybackShort(playback);
    if (snap)
      shown = `${snap.paused ? "paused" : "playing"} @ ${snap.at}`;
    else if (pageMode === "browse")
      shown = "browse";
    else if (pageMode === "watch")
      shown = `watch ${String(presenceData?.title || "").slice(0, 40)}`;
    else
      shown = "cleared";
  }

  const forAction = extra.forAction !== undefined
    ? extra.forAction
    : (pendingUserAction?.action || null);

  if (ok) {
    rpcLog(`DISCORD  ${shown}`, {
      id: pendingUserAction?.id,
      for: forAction,
      ms: extra.ms
    });
    if (extra.clearPending !== false)
      pendingUserAction = null;
  } else {
    rpcLog(`DISCORD  FAILED  ${shown}`, {
      id: pendingUserAction?.id,
      for: forAction,
      error: extra.error || "unknown"
    });
  }
}

const ALARM_TOKEN_REFRESH = "tokenRefresh";
const ALARM_SESSION_KEEPALIVE = "sessionKeepalive";
const ALARM_WATCH_FLUSH = "watchPresenceFlush";
const ALARM_PRESENCE_FLUSH = "presenceFlush";
const ALARM_CLEAR_RETRY = "clearPresenceRetry";
const ALARM_CLEAR_STALE = "clearStaleSession";

/** Serialize hydrates — cold SW often races boot hydrate vs first Miruro message. */
let hydrateInFlight = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_TOKEN_REFRESH, { periodInMinutes: 20 });
  armSessionKeepalive();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_TOKEN_REFRESH) {
    await ensureAccessToken();
    return;
  }
  if (alarm.name === ALARM_CLEAR_RETRY) {
    await clearPresence({ allowRetry: true });
    return;
  }
  if (alarm.name === ALARM_CLEAR_STALE) {
    // Only if nothing claimed Miruro during boot race.
    if (pageMode === "idle")
      await clearStaleSessionIfNoMiruro();
    return;
  }
  if (alarm.name === ALARM_PRESENCE_FLUSH || alarm.name === ALARM_WATCH_FLUSH) {
    // restore:false — restore→flush→alarm was an infinite browse POST storm.
    await hydrate({ force: true, restore: false });
    if (pageMode === "idle" || !isSharingActive())
      return;
    if (pageMode === "watch") {
      if (!presenceData?.title)
        return;
      if (!isTrustedMedia(playbackData))
        watchNavAllowTitleOnly = true;
      watchAwaitingPlayback = false;
      // Don't clear lastActivityKey here — activityKey ignores wall-clock now,
      // so identical playing state won't re-POST and burn the rate limit.
    } else if (pageMode === "browse") {
      // Backup only — if browse already landed, do not POST again.
      if (lastActivityKey && Date.now() - lastPushAt < 15_000)
        return;
    }
    await pushPresence();
    return;
  }
  if (alarm.name === ALARM_SESSION_KEEPALIVE && pageMode !== "idle") {
    await ensureAccessToken();
    if (!(await ensureMiruroTabAlive()))
      return;
    // Don't fight a seek/pause the user just triggered.
    if (pushInFlight || Date.now() - lastPushAt < 45_000)
      return;
    lastActivityKey = null;
    await pushPresence({ keepalive: true });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId)
    onActiveTabGone(tabId, { keepalive: true }).catch((err) =>
      console.warn("onActiveTabGone:", err)
    );
});

function isMiruroWatchUrl(url) {
  try {
    const parsed = new URL(String(url));
    return isMiruroHost(parsed.hostname) && parsed.pathname.startsWith("/watch");
  } catch {
    return false;
  }
}

/** Ask the tab to re-claim — first content messages often die on a cold event page. */
function nudgeMiruroTab(tabId) {
  if (tabId == null)
    return;
  try {
    chrome.tabs.sendMessage(tabId, { type: "resync" }).catch(() => {});
  } catch { /* ignore */ }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = tab?.url || changeInfo.url || "";
  const miruro = url && isMiruroUrl(url);
  // Warm auth + ask content script to retry claim/presence/browse.
  if (miruro && (changeInfo.status === "complete" || changeInfo.url)) {
    hydrate({ restore: false })
      .then(() => {
        if (!tokens?.access_token)
          return;
        nudgeMiruroTab(tabId);
        // Full load on a non-watch page while idle — don't wait for content script.
        if (
          changeInfo.status === "complete" &&
          pageMode === "idle" &&
          !isMiruroWatchUrl(url)
        ) {
          onBrowse(tabId, false);
        }
      })
      .catch((err) => console.warn("miruro tab nudge:", err));
  }
  if (tabId !== activeTabId || !changeInfo.url)
    return;
  if (!isMiruroUrl(changeInfo.url))
    onActiveTabGone(tabId).catch((err) => console.warn("onActiveTabGone:", err));
});

/** Tighter keepalive while watching — cold sessions make the next seek pay setup cost. */
function armSessionKeepalive() {
  if (pageMode === "watch")
    chrome.alarms.create(ALARM_SESSION_KEEPALIVE, { periodInMinutes: 2 });
  else if (pageMode === "browse")
    chrome.alarms.create(ALARM_SESSION_KEEPALIVE, { periodInMinutes: 5 });
  else
    chrome.alarms.clear(ALARM_SESSION_KEEPALIVE);
}

/** Firefox Android kills event-page timers — alarms still wake us. */
function armWatchFlushAlarm(delayMs = 2500) {
  try {
    chrome.alarms.create(ALARM_WATCH_FLUSH, {
      when: Date.now() + Math.max(500, Number(delayMs) || 2500)
    });
  } catch {
    chrome.alarms.create(ALARM_WATCH_FLUSH, {
      delayInMinutes: Math.max(0.05, (Number(delayMs) || 2500) / 60_000)
    });
  }
}

function clearWatchFlushAlarm() {
  try {
    chrome.alarms.clear(ALARM_WATCH_FLUSH);
  } catch { /* ignore */ }
}

/** Event pages drop setTimeout — alarm is the reliable Discord POST kick. */
function armPresenceFlushAlarm(delayMs = 500) {
  try {
    chrome.alarms.create(ALARM_PRESENCE_FLUSH, {
      when: Date.now() + Math.max(250, Number(delayMs) || 500)
    });
  } catch {
    chrome.alarms.create(ALARM_PRESENCE_FLUSH, {
      delayInMinutes: Math.max(0.05, (Number(delayMs) || 500) / 60_000)
    });
  }
}

function warmAuth() {
  ensureAccessToken().catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

function senderIsMiruroTab(sender) {
  // Extension pages (popup) are never Miruro content drivers.
  const url = sender?.tab?.url || sender?.url || "";
  if (String(url).startsWith("chrome-extension:") || String(url).startsWith("moz-extension:"))
    return false;
  // Content scripts are match-gated to Miruro. Firefox sometimes omits tab.url
  // on the first message after a cold start — still trust the tab id.
  if (!url)
    return sender?.tab?.id != null;
  return isMiruroUrl(url);
}

async function handleMessage(message, sender) {
  // Never await storage on the playback hot path — that made rapid seeks feel
  // randomly slow. Token hydrate happens inside push only if memory is cold.
  const fromPage = ["claim", "presence", "playback", "browse", "clear", "leave"].includes(message?.type);
  if (fromPage && !senderIsMiruroTab(sender))
    return { ok: false, error: "ignored non-miruro sender" };

  // Cold SW: load auth before first browse/claim so Discord isn't "no token".
  if (
    fromPage &&
    message?.type !== "playback" &&
    !tokens?.access_token
  ) {
    await hydrate();
  }

  switch (message?.type) {
    case "getStatus": {
      // restore:false — popup must not deadlock on restore→clear→hydrate.
      // Presence fields come from live memory (content scripts drive those).
      await Promise.all([hydrate({ force: true, restore: false }), ensureDevBuildFlag()]);
      const android = await isAndroidRuntime();
      const redirectUri =
        !android && typeof chrome.identity?.getRedirectURL === "function"
          ? chrome.identity.getRedirectURL()
          : OAUTH_REDIRECT_URI;
      return {
        ok: true,
        isDevBuild,
        isAndroid: android,
        loggedIn: Boolean(tokens?.access_token),
        user,
        redirectUri,
        clientId: CLIENT_ID,
        pageMode,
        activeTabId,
        authPending,
        lastAuthError,
        lastPushError,
        debugLog: isDevBuild ? debugLog.slice(-80) : [],
        playback: formatPlaybackShort(playbackData),
        lastSent: formatPlaybackShort(lastSentPlayback),
        ...(await sharingStatusPayload())
      };
    }
    case "getDebugLog":
      await ensureDevBuildFlag();
      if (!isDevBuild)
        return { ok: true, isDevBuild: false, debugLog: [] };
      return {
        ok: true,
        isDevBuild: true,
        debugLog: debugLog.slice(),
        pageMode,
        activeTabId,
        playback: formatPlaybackShort(playbackData),
        lastSent: formatPlaybackShort(lastSentPlayback),
        pushInFlight,
        pushQueued,
        seekPin: seekPin
          ? { ...seekPin, remainingMs: Math.max(0, seekPin.until - Date.now()) }
          : null
      };
    case "clearDebugLog":
      await ensureDevBuildFlag();
      if (!isDevBuild)
        return { ok: true };
      debugLog.length = 0;
      rpcLog("debug cleared");
      return { ok: true };
    case "oauthCallback": {
      const url = String(message?.url || "");
      const senderUrl = String(sender?.tab?.url || sender?.url || "");
      if (
        !url.startsWith(OAUTH_REDIRECT_URI) &&
        !senderUrl.startsWith(OAUTH_REDIRECT_URI)
      )
        return { ok: false, error: "ignored oauth callback" };
      return acceptOAuthRedirect(url || senderUrl);
    }
    case "login": {
      const android = await isAndroidRuntime();
      const tabAuth =
        android || typeof chrome.identity?.launchWebAuthFlow !== "function";

      // Android (and any no-identity browser): don't block the UI on the tab
      // OAuth — user must leave this page to see Discord. Desktop keeps awaiting
      // launchWebAuthFlow like before.
      if (tabAuth) {
        startLogin().catch(() => {});
        return { ok: true, authPending: true, authViaTab: true };
      }

      try {
        await startLogin();
        return {
          ok: true,
          loggedIn: Boolean(tokens?.access_token),
          lastAuthError
        };
      } catch (err) {
        return {
          ok: false,
          error: String(err?.message || err),
          lastAuthError: lastAuthError || String(err?.message || err)
        };
      }
    }
    case "logout":
      await logout();
      return { ok: true };
    case "forceClearPresence": {
      await hydrate({ restore: false });
      const access = await ensureAccessToken();
      if (!access)
        return { ok: false, error: "not logged in" };
      if (browseFlushTimer) {
        clearTimeout(browseFlushTimer);
        browseFlushTimer = null;
      }
      if (flushDebounceTimer) {
        clearTimeout(flushDebounceTimer);
        flushDebounceTimer = null;
      }
      pushQueued = false;
      pageMode = "idle";
      presenceData = null;
      playbackData = null;
      activeTabId = null;
      lastActivityKey = null;
      presenceSuppressedUntil = Date.now() + 8000;
      logYouNav("clear stuck RPC");
      const result = await forceClearHeadlessPresence(access, { requireToken: true });
      const ok = Boolean(result?.ok);
      if (ok)
        setPushError(null);
      else
        setPushError(result?.error || "Couldn't clear Discord presence");
      logDiscord(ok, null, {
        shown: ok ? "cleared" : (result?.orphan ? "orphan (no token)" : "clear failed"),
        forAction: "clear stuck RPC",
        error: result?.error || null
      });
      persistPresenceState();
      setBadge(tokens?.access_token ? (presenceEnabled ? "on" : "paused") : "off");
      return {
        ok,
        orphan: Boolean(result?.orphan),
        error: result?.error || null,
        deleted: result?.deleted || 0,
        lastPushError
      };
    }
    case "testPresence":
      await ensureDevBuildFlag();
      if (!isDevBuild)
        return { ok: false, error: "dev only" };
      await pushTestPresence();
      return { ok: true, lastPushError };
    case "setPresenceEnabled": {
      await hydrate({ force: true });
      presenceEnabled = Boolean(message.enabled);
      return applySharingGate({
        clear: !presenceEnabled,
        resume: presenceEnabled
      });
    }
    case "muteCurrentTitle": {
      if (!(await isActiveWatchTab()))
        return { ok: false, error: "open a watch page first", ...(await sharingStatusPayload()) };
      const key = normalizeTitleKey(presenceData?.title);
      if (!key)
        return { ok: false, error: "no anime to hide", ...(await sharingStatusPayload()) };
      if (!mutedTitles.includes(key))
        mutedTitles.push(key);
      return applySharingGate({ clear: true });
    }
    case "unmuteCurrentTitle": {
      if (!(await isActiveWatchTab()))
        return { ok: false, error: "open a watch page first", ...(await sharingStatusPayload()) };
      const key = normalizeTitleKey(presenceData?.title);
      mutedTitles = mutedTitles.filter((t) => t !== key);
      return applySharingGate({ resume: true });
    }
    case "claim":
      return onClaim(sender.tab?.id, message.mode);
    case "presence":
      return onPresence(sender.tab?.id, message.data);
    case "playback":
      return onPlayback(sender.tab?.id, message.data);
    case "browse":
      return onBrowse(sender.tab?.id, Boolean(message.tick));
    case "clear":
      return onClear(sender.tab?.id);
    case "leave":
      return onLeave(sender.tab?.id, message.reason);
    default:
      return { ok: false, error: "unknown message" };
  }
}

function normalizeTitleKey(title) {
  return String(title || "").trim().toLowerCase();
}

function isTitleMuted(title) {
  const key = normalizeTitleKey(title);
  return Boolean(key) && mutedTitles.includes(key);
}

function isCurrentTitleMuted() {
  return pageMode === "watch" && isTitleMuted(presenceData?.title);
}

/** False when master switch is off or this anime is muted. */
function isSharingActive() {
  return presenceEnabled && !isCurrentTitleMuted();
}

function persistSharingPrefs() {
  chrome.storage.local.set({
    [STORAGE_KEYS.presenceEnabled]: presenceEnabled,
    [STORAGE_KEYS.mutedTitles]: mutedTitles.slice()
  }).catch(() => {});
}

function isWatchUrl(url) {
  try {
    const u = new URL(String(url || ""));
    return isMiruroHost(u.hostname) && u.pathname.startsWith("/watch");
  } catch {
    return false;
  }
}

async function isActiveWatchTab() {
  if (pageMode !== "watch" || !presenceData?.title)
    return false;
  try {
    // Use the tab the user is actually looking at (not our stored Miruro
    // driver tab, which stays /watch in the background after they leave).
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs?.[0];
    if (!tab?.id || tab.discarded || !isWatchUrl(tab.url || ""))
      return false;
    // Presence must belong to this same tab.
    return activeTabId == null || tab.id === activeTabId;
  } catch {
    return false;
  }
}

async function sharingStatusPayload() {
  const title = String(presenceData?.title || "").trim();
  const onWatchPage = Boolean(title) && await isActiveWatchTab();
  return {
    presenceEnabled,
    titleMuted: isCurrentTitleMuted(),
    onWatchPage,
    currentTitle: onWatchPage ? title : null,
    mutedCount: mutedTitles.length
  };
}

async function applySharingGate({ clear = false, resume = false } = {}) {
  persistSharingPrefs();
  if (clear || !isSharingActive()) {
    lastActivityKey = null;
    await clearPresence();
    setBadge(tokens?.access_token ? (presenceEnabled ? "muted" : "paused") : "off");
    return { ok: true, ...(await sharingStatusPayload()) };
  }
  if (resume && pageMode !== "idle") {
    lastActivityKey = null;
    flushPresence({ urgent: true });
  }
  setBadge(
    pageMode === "watch" ? "watch" : pageMode === "browse" ? "browse" : tokens?.access_token ? "on" : "off"
  );
  return { ok: true, ...(await sharingStatusPayload()) };
}

async function hydrate(opts = {}) {
  // Wait for an in-flight load (first Miruro message often races boot hydrate).
  // Do NOT no-op concurrent callers — that skipped auth and Discord never POSTed
  // until the popup woke the worker again.
  if (hydrateInFlight) {
    await hydrateInFlight;
    if (!opts.force && tokens?.access_token)
      return;
  }

  const done = hydrateNow(opts).finally(() => {
    if (hydrateInFlight === done)
      hydrateInFlight = null;
  });
  hydrateInFlight = done;
  return done;
}

async function hydrateNow({ force = false, restore = true } = {}) {
  // Always re-read sessionToken — Android wakeups often have auth in memory
  // but a newer token only in storage (or the reverse).
  if (!force && tokens && user) {
    const bit = await chrome.storage.local.get([
      STORAGE_KEYS.sessionToken,
      STORAGE_KEYS.sessionTokenHistory,
      STORAGE_KEYS.presenceEnabled,
      STORAGE_KEYS.mutedTitles
    ]);
    sessionToken = bit[STORAGE_KEYS.sessionToken] || null;
    sessionTokenHistory = normalizeTokenHistory(bit[STORAGE_KEYS.sessionTokenHistory], sessionToken);
    if (bit[STORAGE_KEYS.presenceEnabled] !== undefined)
      presenceEnabled = bit[STORAGE_KEYS.presenceEnabled] !== false;
    if (Array.isArray(bit[STORAGE_KEYS.mutedTitles]))
      mutedTitles = bit[STORAGE_KEYS.mutedTitles].map(normalizeTitleKey).filter(Boolean);
    return;
  }
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.tokens,
    STORAGE_KEYS.user,
    STORAGE_KEYS.sessionToken,
    STORAGE_KEYS.sessionTokenHistory,
    STORAGE_KEYS.authPending,
    STORAGE_KEYS.lastAuthError,
    STORAGE_KEYS.lastPushError,
    STORAGE_KEYS.presenceEnabled,
    STORAGE_KEYS.mutedTitles
  ]);
  tokens = stored[STORAGE_KEYS.tokens] || null;
  user = stored[STORAGE_KEYS.user] || null;
  sessionToken = stored[STORAGE_KEYS.sessionToken] || null;
  sessionTokenHistory = normalizeTokenHistory(stored[STORAGE_KEYS.sessionTokenHistory], sessionToken);
  authPending = Boolean(stored[STORAGE_KEYS.authPending]);
  lastAuthError = stored[STORAGE_KEYS.lastAuthError] || null;
  lastPushError = stored[STORAGE_KEYS.lastPushError] || null;
  presenceEnabled = stored[STORAGE_KEYS.presenceEnabled] !== false;
  mutedTitles = Array.isArray(stored[STORAGE_KEYS.mutedTitles])
    ? stored[STORAGE_KEYS.mutedTitles].map(normalizeTitleKey).filter(Boolean)
    : [];
  // Skip during clear — restoring the just-left snapshot re-posts stale RPC.
  if (restore)
    await restorePresenceState();
}

function normalizeTokenHistory(list, primary = null) {
  const out = [];
  for (const token of [...(Array.isArray(list) ? list : []), primary]) {
    if (token && !out.includes(token))
      out.push(token);
  }
  return out.slice(-8);
}

async function rememberSessionToken(token) {
  if (!token)
    return;
  sessionToken = token;
  sessionTokenHistory = normalizeTokenHistory(sessionTokenHistory, token);
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.sessionToken]: sessionToken,
      [STORAGE_KEYS.sessionTokenHistory]: sessionTokenHistory
    });
  } catch { /* ignore */ }
}

async function clearStoredSessionTokens() {
  sessionToken = null;
  sessionTokenHistory = [];
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.sessionToken]: null,
      [STORAGE_KEYS.sessionTokenHistory]: []
    });
  } catch { /* ignore */ }
}

function startLogin() {
  if (loginInFlight)
    return loginInFlight;

  loginInFlight = (async () => {
    authPending = true;
    lastAuthError = null;
    await chrome.storage.local.set({
      [STORAGE_KEYS.authPending]: true,
      [STORAGE_KEYS.lastAuthError]: null
    });
    try {
      await login();
      lastAuthError = null;
    } catch (err) {
      lastAuthError = String(err?.message || err);
      console.error("Discord login failed:", err);
      await chrome.storage.local.set({ [STORAGE_KEYS.lastAuthError]: lastAuthError });
      throw err;
    } finally {
      authPending = false;
      loginInFlight = null;
      await chrome.storage.local.set({ [STORAGE_KEYS.authPending]: false });
    }
  })();

  return loginInFlight;
}

async function persistAuth() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.tokens]: tokens,
    [STORAGE_KEYS.user]: user,
    [STORAGE_KEYS.sessionToken]: sessionToken,
    [STORAGE_KEYS.sessionTokenHistory]: sessionTokenHistory
  });
}

// ── PKCE OAuth ─────────────────────────────────────────────────────────

function randomString(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return base64Url(bytes);
}

function base64Url(bytes) {
  let binary = "";
  for (const b of bytes)
    binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Base64Url(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64Url(new Uint8Array(digest));
}

async function isAndroidRuntime() {
  try {
    const info = await chrome.runtime.getPlatformInfo();
    return info?.os === "android";
  } catch {
    return /android/i.test(navigator.userAgent || "");
  }
}

function isOAuthCallbackUrl(url) {
  return Boolean(url) && String(url).startsWith(OAUTH_REDIRECT_URI);
}

/**
 * Resolve in-flight tab login, or finish OAuth from storage if the background
 * was killed after Connect (common on Firefox Android).
 */
async function acceptOAuthRedirect(url) {
  const responseUrl = String(url || "");
  if (!isOAuthCallbackUrl(responseUrl))
    return { ok: false, error: "not oauth callback" };

  if (oauthWaiter) {
    oauthWaiter.resolve(responseUrl);
    return { ok: true, via: "waiter" };
  }

  // login() is mid-flight but waiter not armed yet — ignore duplicate ping.
  if (loginInFlight && tokens?.access_token)
    return { ok: true, via: "done" };

  const pending = (await chrome.storage.local.get(STORAGE_KEYS.oauthPending))[
    STORAGE_KEYS.oauthPending
  ];
  if (!pending?.codeVerifier) {
    if (tokens?.access_token)
      return { ok: true, via: "done" };
    return { ok: false, error: "no pending login" };
  }

  try {
    authPending = true;
    await completeOAuthFromResponseUrl(responseUrl);
    lastAuthError = null;
    authPending = false;
    loginInFlight = null;
    await chrome.storage.local.set({
      [STORAGE_KEYS.authPending]: false,
      [STORAGE_KEYS.lastAuthError]: null
    });
    return { ok: true, via: "direct" };
  } catch (err) {
    lastAuthError = String(err?.message || err);
    authPending = false;
    loginInFlight = null;
    await chrome.storage.local.set({
      [STORAGE_KEYS.authPending]: false,
      [STORAGE_KEYS.lastAuthError]: lastAuthError
    });
    console.error("Discord oauth callback failed:", err);
    return { ok: false, error: lastAuthError };
  }
}

/** Catch OAuth redirect in a normal tab (Firefox Android has no identity helper). */
function waitForOAuthRedirect(redirectUri, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Login timed out — finish Discord authorize, or try again."));
    }, timeoutMs);

    const poll = setInterval(() => {
      chrome.tabs.query({}).then((tabs) => {
        for (const tab of tabs) {
          if (tab?.url && String(tab.url).startsWith(redirectUri))
            maybeFinish(tab.url);
        }
      }).catch(() => {});
    }, 1000);

    function cleanup() {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (oauthWaiter?.reject === reject)
        oauthWaiter = null;
    }

    function maybeFinish(url) {
      if (settled)
        return;
      if (!url || !String(url).startsWith(redirectUri))
        return;
      cleanup();
      resolve(String(url));
    }

    function onUpdated(_tabId, changeInfo, tab) {
      maybeFinish(changeInfo.url || tab?.url);
    }

    oauthWaiter = {
      redirectUri,
      resolve: (url) => maybeFinish(url),
      reject
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function launchOAuthAuthorize(authUrl, redirectUri, { preferTab = false } = {}) {
  const canIdentity = typeof chrome.identity?.launchWebAuthFlow === "function";

  // Desktop identity window (unless caller forced tab flow).
  if (!preferTab && canIdentity) {
    try {
      const responseUrl = await chrome.identity.launchWebAuthFlow({
        url: authUrl,
        interactive: true
      });
      if (responseUrl)
        return responseUrl;
      throw new Error("Discord auth closed before completing.");
    } catch (err) {
      throw new Error(
        err?.message ||
          "Auth window closed or blocked. Try again and leave the Discord window open until it finishes."
      );
    }
  }

  // Tab flow — used on Firefox Android (no identity API).
  const tab = await chrome.tabs.create({ url: authUrl, active: true });
  try {
    const responseUrl = await waitForOAuthRedirect(redirectUri);
    try {
      if (tab?.id != null)
        await chrome.tabs.remove(tab.id);
    } catch { /* already closed */ }
    return responseUrl;
  } catch (err) {
    try {
      if (tab?.id != null)
        await chrome.tabs.remove(tab.id);
    } catch { /* ignore */ }
    throw err;
  }
}

async function completeOAuthFromResponseUrl(responseUrl) {
  if (tokens?.access_token)
    return;
  if (!responseUrl)
    throw new Error("Discord returned an empty redirect");

  const redirected = new URL(responseUrl);
  const error = redirected.searchParams.get("error");
  if (error)
    throw new Error(redirected.searchParams.get("error_description") || error);

  const code = redirected.searchParams.get("code");
  const returnedState = redirected.searchParams.get("state");
  const pending = (await chrome.storage.local.get(STORAGE_KEYS.oauthPending))[
    STORAGE_KEYS.oauthPending
  ];

  if (!code)
    throw new Error("No authorization code returned from Discord");
  if (!pending?.codeVerifier) {
    if (tokens?.access_token)
      return;
    throw new Error("Missing PKCE verifier — try Connect again");
  }
  if (returnedState !== pending.oauthState)
    throw new Error("OAuth state mismatch — try Connect again");

  // Prevent double exchange if callback + tabs listener both fire.
  await chrome.storage.local.remove(STORAGE_KEYS.oauthPending);

  try {
    const tokenJson = await exchangeCode(
      code,
      pending.codeVerifier,
      pending.redirectUri || OAUTH_REDIRECT_URI
    );
    tokens = normalizeTokens(tokenJson);
    user = await fetchUser(tokens.access_token);
    sessionToken = null;
    await persistAuth();
    setBadge("on");
  } catch (err) {
    // Restore pending so a retry / second path can still finish if exchange failed.
    await chrome.storage.local.set({ [STORAGE_KEYS.oauthPending]: pending });
    throw err;
  }
}

async function login() {
  const android = await isAndroidRuntime();
  const canIdentityRedirect = typeof chrome.identity?.getRedirectURL === "function";

  // Desktop: chromiumapp / extensions.allizom redirect via identity.
  // Android: hosted HTTPS callback (identity API does not exist).
  const redirectUri =
    !android && canIdentityRedirect
      ? chrome.identity.getRedirectURL()
      : OAUTH_REDIRECT_URI;

  if (!redirectUri)
    throw new Error("OAuth redirect URI is not configured.");

  const codeVerifier = randomString(32);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const state = randomString(16);

  // Use local storage — popup closing / event-page restarts can drop session storage.
  await chrome.storage.local.set({
    [STORAGE_KEYS.oauthPending]: { codeVerifier, oauthState: state, redirectUri }
  });

  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "consent");

  let responseUrl;
  try {
    responseUrl = await launchOAuthAuthorize(url.toString(), redirectUri, {
      preferTab: android || !canIdentityRedirect
    });
  } catch (err) {
    throw new Error(
      err?.message ||
        "Auth window closed or blocked. Try again and leave the Discord window open until it finishes."
    );
  }

  await completeOAuthFromResponseUrl(responseUrl);
}

async function exchangeCode(code, codeVerifier, redirectUri) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier
  });

  const res = await fetch(`${API_BASE}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(json.error_description || json.error || `Token exchange failed (${res.status})`);
  return json;
}

async function refreshTokens() {
  await hydrate();
  if (!tokens?.refresh_token)
    throw new Error("Not logged in");

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token
  });

  const res = await fetch(`${API_BASE}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(json.error_description || json.error || `Refresh failed (${res.status})`);

  tokens = normalizeTokens(json, tokens.refresh_token);
  await persistAuth();
  return tokens.access_token;
}

function normalizeTokens(json, previousRefresh) {
  const expiresIn = Number(json.expires_in) || 3600;
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token || previousRefresh || null,
    expires_at: Date.now() + expiresIn * 1000 - 60_000
  };
}

async function ensureAccessToken() {
  // Avoid re-entering hydrate from restore→flush→push (deadlock with self-wait).
  if (!tokens?.access_token || Date.now() >= (tokens.expires_at || 0))
    await hydrate({ restore: false });
  if (!tokens?.access_token)
    return null;
  if (Date.now() < (tokens.expires_at || 0))
    return tokens.access_token;
  try {
    return await refreshTokens();
  } catch (err) {
    console.warn("Token refresh failed:", err);
    return null;
  }
}

async function fetchUser(accessToken) {
  const res = await fetch(`${API_BASE}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (res.ok)
    return res.json();

  // openid alone may not allow /users/@me — fall back to id_token if present later
  return { id: "unknown", username: "Discord user" };
}

async function logout() {
  await hydrate({ restore: false });
  try {
    const access = tokens?.access_token || (await ensureAccessToken().catch(() => null));
    if (access)
      await forceClearHeadlessPresence(access);
  } catch { /* ignore */ }
  tokens = null;
  user = null;
  sessionToken = null;
  sessionTokenHistory = [];
  activeTabId = null;
  pageMode = "idle";
  presenceData = null;
  playbackData = null;
  lastActivityKey = null;
  await chrome.storage.local.remove([
    STORAGE_KEYS.tokens,
    STORAGE_KEYS.user,
    STORAGE_KEYS.sessionToken,
    STORAGE_KEYS.sessionTokenHistory
  ]);
  setBadge("off");
}

// ── Presence from content scripts ──────────────────────────────────────

function onClaim(tabId, mode) {
  if (tabId == null)
    return { ok: false };
  activeTabId = tabId;
  if (mode === "browse")
    return onBrowse(tabId);
  // Cancel deferred catalog browse — next watch will replace Discord instead.
  if (browseFlushTimer) {
    clearTimeout(browseFlushTimer);
    browseFlushTimer = null;
  }
  // Watch claim: stay on current presence (usually previous watch) until presence arrives.
  // Alarm backup — if the follow-up presence message is lost on a cold SW, still kick.
  armWatchFlushAlarm(1500);
  persistPresenceState();
  return { ok: true };
}

function presenceMetaKey(data) {
  if (!data)
    return "";
  // Title + episode only. Cover/ep-title load later and must not look like a
  // show switch (that wiped playback and froze Discord at 00:00).
  return JSON.stringify({
    title: String(data.title || "").trim().toLowerCase(),
    episode: Number(data.episode) || 0
  });
}

function presenceEnrichKey(data) {
  if (!data)
    return "";
  return JSON.stringify({
    episodeTitle: String(data.episodeTitle || "").trim().toLowerCase(),
    cover: String(data.cover || "").trim(),
    anilistId: Number(data.anilistId) || 0,
    titles: Array.isArray(data.titles) ? data.titles.map((t) => String(t).trim().toLowerCase()) : [],
    anilistTitles: Array.isArray(data.anilistTitles)
      ? data.anilistTitles.map((t) => String(t).trim().toLowerCase())
      : []
  });
}

let episodeSwitchTimer = null;

function seedPlaybackFromPresence(data) {
  const duration = Number(data?.duration);
  const currentTime = Number(data?.currentTime);
  if (!Number.isFinite(duration) || duration <= 1 || !Number.isFinite(currentTime))
    return null;
  return {
    currentTime: Math.max(0, currentTime),
    duration,
    paused: Boolean(data.paused),
    source: "video",
    kind: data.paused ? "pause" : "play"
  };
}

function onPresence(tabId, data) {
  if (tabId == null)
    return { ok: false };
  const prevTab = activeTabId;
  activeTabId = tabId;
  const tabChanged = prevTab != null && prevTab !== tabId;
  const metaChanged = presenceMetaKey(data) !== presenceMetaKey(presenceData);
  const enrichChanged = presenceEnrichKey(data) !== presenceEnrichKey(presenceData);
  const becameWatch = pageMode !== "watch";
  pageMode = "watch";
  // Keep AniList shorts across cover/title-alt enrichments of the same show.
  if (
    data &&
    presenceData &&
    !metaChanged &&
    Array.isArray(presenceData.anilistTitles) &&
    presenceData.anilistTitles.length &&
    !Array.isArray(data.anilistTitles)
  ) {
    data.anilistTitles = presenceData.anilistTitles;
  }
  presenceData = data || null;
  browseStart = null;

  // Metadata only — never let a 5s scrape overwrite live pause/seek state.
  // Switching shows must drop the previous anime's timestamp or Discord gets
  // "100 Girlfriends" with Apothecary's 8:10 progress (see last debug paste).
  if (metaChanged || becameWatch || tabChanged) {
    playbackData = null;
    lastSentPlayback = null;
    seekPin = null;
    lastMediaSource = "";
    lastMediaSourceAt = 0;
    // Cross-tab: other-tab filter already blocks ghosts — short mute.
    // Same-tab episode switch: longer mute for the dying iframe.
    playbackMuteUntil = Date.now() + (tabChanged || becameWatch ? 450 : 1800);
    watchAwaitingPlayback = true;
    watchPlaybackFlushQueued = false;
    watchPlaybackKickTries = 0;
    // Presence scrape often has the focused tab's time already (iframe may be
    // throttled after backgrounding and won't emit a fresh "play").
    const seed = seedPlaybackFromPresence(data);
    if (seed) {
      playbackData = seed;
      lastMediaSource = "video";
      lastMediaSourceAt = Date.now();
    }
    scheduleWatchPlaybackKick(Math.max(0, playbackMuteUntil - Date.now()) + 60);
  } else if (enrichChanged) {
    // Cover / ep-title / AniList alts — only POST if Discord text/art would change.
    const before = buildWatchActivity(presenceData, playbackData);
    const after = buildWatchActivity(data, playbackData);
    const beforeKey = before ? activityKey(before, playbackData) : "";
    const afterKey = after ? activityKey(after, playbackData) : "";
    if (beforeKey !== afterKey) {
      lastActivityKey = null;
      flushPresence({ urgent: true, bypassGap: true });
    }
    persistPresenceState();
    return { ok: true };
  }

  armSessionKeepalive();
  warmAuth();

  // Only title/episode/tab changes — not "playback became available".
  if (!(becameWatch || metaChanged || tabChanged)) {
    persistPresenceState();
    return { ok: true };
  }

  const title = String(data?.title || "anime").slice(0, 40);
  const ep = data?.episode ? ` · EP. ${data.episode}` : "";

  // Rapid tab flipping was spamming switch episode + POSTs into 429.
  if (episodeSwitchTimer)
    clearTimeout(episodeSwitchTimer);
  const navDelay = becameWatch || tabChanged ? 60 : EPISODE_SWITCH_DEBOUNCE_MS;
  episodeSwitchTimer = setTimeout(() => {
    episodeSwitchTimer = null;
    const latest = presenceData;
    const t = String(latest?.title || title).slice(0, 40);
    const e = latest?.episode ? ` · EP. ${latest.episode}` : ep;
    const navLabel = becameWatch ? `watch ${t}${e}` : `switch episode ${t}${e}`;
    logYouNav(navLabel);
    watchAwaitingPlayback = true;
    watchPlaybackFlushQueued = false;
    lastActivityKey = null;
    // Even if YOU nav coalesced, still arm media flush — returning to an
    // already-playing tab must not stall until a manual pause/seek.
    const kickIn = Math.max(0, playbackMuteUntil - Date.now()) + 60;
    const fallbackIn = Math.max(0, playbackMuteUntil - Date.now()) + 1800;
    scheduleWatchPlaybackKick(kickIn);
    scheduleWatchNavFallback(fallbackIn);
    // Survive Firefox Android background kills (setTimeout is lost).
    armWatchFlushAlarm(fallbackIn);
  }, navDelay);

  // Cancel a pending browse POST if we bounced watch→browse→watch.
  if (browseFlushTimer) {
    clearTimeout(browseFlushTimer);
    browseFlushTimer = null;
  }

  // Leave browse ASAP — but if the title would hard-truncate, wait briefly for
  // AniList (TenSura) so Discord doesn't flash "That Time I Got on Miruro".
  scheduleWatchTitleFlush(presenceData);

  persistPresenceState();
  return { ok: true };
}

function titleNeedsAnilistShort(fullTitle, extraTitles = []) {
  const full = sanitizePresenceText(fullTitle, 128);
  if (!full)
    return false;
  const max = nameTitleMax();
  const pool = [full, ...(extraTitles || [])];
  for (const raw of pool) {
    for (const variant of heuristicTitleVariants(raw)) {
      const clean = sanitizePresenceText(variant, 128);
      // Natural short only — truncation ("That Time I Got") still waits for AniList.
      if (
        clean &&
        clean.length <= max &&
        !isWeakShortTitle(clean, full) &&
        latinRatio(clean) >= 0.55 &&
        !isAwkwardEnglishTrunc(clean)
      ) {
        return false;
      }
    }
  }
  return true;
}

function flushWatchTitlePresence() {
  if (pageMode !== "watch" || !presenceData?.title)
    return;
  pendingUserAction = null;
  watchNavAllowTitleOnly = true;
  lastActivityKey = null;
  armWatchFlushAlarm(800);
  // bypassGap: browse→watch shouldn't sit behind the 3.5s anti-429 spacing.
  flushPresence({ urgent: true, bypassGap: true });
}

function scheduleWatchTitleFlush(presence) {
  const data = presence || presenceData;
  if (!data?.title) {
    flushWatchTitlePresence();
    return;
  }
  if (
    (Array.isArray(data.anilistTitles) && data.anilistTitles.length) ||
    !titleNeedsAnilistShort(data.title, data.titles)
  ) {
    enrichWatchTitlesFromAnilist(data, { flush: false }).catch(() => {});
    flushWatchTitlePresence();
    return;
  }

  let settled = false;
  const finish = () => {
    if (settled)
      return;
    settled = true;
    flushWatchTitlePresence();
  };

  // Wait for TenSura-style AniList shorts before the first watch POST so we
  // don't flash a hard-truncated English name, then upgrade a beat later.
  enrichWatchTitlesFromAnilist(data, { flush: false })
    .then((changed) => {
      if (!settled) {
        finish();
        return;
      }
      if (changed) {
        lastActivityKey = null;
        flushPresence({ urgent: true, bypassGap: true });
      }
    })
    .catch(() => {
      if (!settled)
        finish();
    });
  setTimeout(finish, 1600);
}

function onPlayback(tabId, data) {
  return applyPlayback(tabId, data);
}

function clearWatchPlaybackTimers() {
  if (watchPlaybackKickTimer) {
    clearTimeout(watchPlaybackKickTimer);
    watchPlaybackKickTimer = null;
  }
  if (watchNavFallbackTimer) {
    clearTimeout(watchNavFallbackTimer);
    watchNavFallbackTimer = null;
  }
  clearWatchFlushAlarm();
}

function isTrustedMedia(data) {
  return hasValidPlayback(data) &&
    (MEDIA_SOURCE_RANK[String(data?.source || "")] ?? 0) >= TRUSTED_MEDIA_RANK;
}

/** After mute, force one progress POST with title + time (no 00:00 intermediate). */
function scheduleWatchPlaybackKick(delayMs) {
  if (watchPlaybackKickTimer)
    clearTimeout(watchPlaybackKickTimer);
  watchPlaybackKickTimer = setTimeout(() => {
    watchPlaybackKickTimer = null;
    if (!watchAwaitingPlayback || watchPlaybackFlushQueued)
      return;
    if (pageMode !== "watch" || !presenceData?.title)
      return;
    if (Date.now() < playbackMuteUntil) {
      scheduleWatchPlaybackKick(playbackMuteUntil - Date.now() + 40);
      return;
    }
    const data = playbackData;
    if (!isTrustedMedia(data)) {
      // Player still waking — retry a few times, then let nav fallback title-post.
      watchPlaybackKickTries += 1;
      if (watchPlaybackKickTries <= 12) {
        scheduleWatchPlaybackKick(400);
        return;
      }
      return;
    }
    watchPlaybackKickTries = 0;
    applyPlayback(activeTabId, {
      ...data,
      kind: data.paused ? "pause" : "play",
      force: true
    });
  }, Math.max(40, delayMs || 0));
}

/** If media never arrives, POST title-only so Discord at least shows the show. */
function scheduleWatchNavFallback(delayMs) {
  if (watchNavFallbackTimer)
    clearTimeout(watchNavFallbackTimer);
  watchNavFallbackTimer = setTimeout(() => {
    watchNavFallbackTimer = null;
    if (!watchAwaitingPlayback || watchPlaybackFlushQueued)
      return;
    if (pageMode !== "watch" || !presenceData?.title)
      return;
    if (isTrustedMedia(playbackData)) {
      scheduleWatchPlaybackKick(50);
      return;
    }
    watchNavAllowTitleOnly = true;
    lastActivityKey = null;
    flushPresence({ urgent: true });
  }, Math.max(40, delayMs || 0));
}

function playbackSnapshot(data) {
  if (!data)
    return null;
  return {
    currentTime: Number(data.currentTime) || 0,
    duration: Number(data.duration) || 0,
    paused: Boolean(data.paused),
    source: data.source || "",
    kind: data.kind || ""
  };
}

function playbackDirty(a, b) {
  if (!a && !b)
    return false;
  if (!a || !b)
    return true;
  if (Boolean(a.paused) !== Boolean(b.paused))
    return true;
  if (Math.abs((a.currentTime || 0) - (b.currentTime || 0)) > 0.6)
    return true;
  return false;
}

/**
 * Same idea as the tray MiruroRPC bridge: accept every tick, only POST to
 * Discord when pause flips or position drifts from what Discord was told.
 */
function shouldPushPlayback(data, { force = false } = {}) {
  if (force)
    return true;

  const kind = String(data?.kind || "");
  if (["play", "pause", "seek", "ended", "resume", "hitch"].includes(kind))
    return true;

  const prev = lastSentPlayback;
  if (!prev || !hasValidPlayback(prev))
    return true;

  if (Boolean(prev.paused) !== Boolean(data.paused))
    return true;

  if (Math.abs((prev.duration || 0) - (Number(data.duration) || 0)) > 1)
    return true;

  const currentTime = Number(data.currentTime) || 0;
  const expected = prev.paused
    ? prev.currentTime
    : prev.currentTime + (Date.now() - (prev.at || Date.now())) / 1000;

  // Tight drift so click-scrubs land on the next tick, not a second later.
  if (Math.abs(expected - currentTime) > 0.75)
    return true;

  if (!data.paused && Date.now() - (prev.at || 0) > 30000)
    return true;

  return false;
}

function applyPlayback(tabId, data) {
  // Iframe messages sometimes omit tab — use the claimed Miruro tab.
  if (tabId == null)
    tabId = activeTabId;
  if (tabId == null)
    return { ok: true, ignored: true };

  // Presence/browse owns the active tab. Background Miruro tabs keep playing —
  // their embeds must not overwrite the focused anime's time (see tab-switch logs).
  if (activeTabId != null && tabId !== activeTabId)
    return { ok: true, ignored: "other-tab" };

  const next = data ? { ...data } : null;
  if (!next || !Number.isFinite(Number(next.duration)) || Number(next.duration) <= 0)
    return { ok: true, ignored: true };

  next.currentTime = Number(next.currentTime) || 0;
  next.duration = Number(next.duration);
  next.paused = Boolean(next.paused);

  const source = String(next.source || "unknown");
  const rank = MEDIA_SOURCE_RANK[source] ?? 0;
  const trustedRank = MEDIA_SOURCE_RANK[lastMediaSource] ?? -1;
  const kind = String(next.kind || "");
  const isPausePlay =
    kind === "play" ||
    kind === "pause" ||
    kind === "ended" ||
    kind === "resume" ||
    kind === "hitch";
  let explicitSeek = kind === "seek";
  // Hitch / stall pause must land as paused on Discord.
  if ((kind === "hitch" || kind === "pause" || kind === "ended") && !next.paused)
    next.paused = true;

  // During show-switch mute: buffer trusted media from this tab, don't POST.
  // Old iframe play events used to punch through and stamp the wrong time.
  // User scrub is the only early unmute.
  if (Date.now() < playbackMuteUntil) {
    if (rank >= TRUSTED_MEDIA_RANK && explicitSeek) {
      playbackMuteUntil = 0;
    } else if (rank >= TRUSTED_MEDIA_RANK && next.duration > 1) {
      playbackData = next;
      lastMediaSource = source;
      lastMediaSourceAt = Date.now();
      return { ok: true, ignored: "show-switch-mute" };
    } else {
      return { ok: true, ignored: "show-switch-mute" };
    }
  }

  // Ignore weaker clock/player ticks while a trusted source is live —
  // but never drop explicit pause/play (UI click when <video> is unreachable).
  if (
    !isPausePlay &&
    rank < TRUSTED_MEDIA_RANK &&
    trustedRank >= TRUSTED_MEDIA_RANK &&
    Date.now() - lastMediaSourceAt < 8000
  ) {
    return { ok: true, ignored: "weaker-source" };
  }

  // Demote bogus seeks that barely move — real scrubs jump much more.
  if (
    explicitSeek &&
    playbackData &&
    Math.abs((playbackData.currentTime || 0) - next.currentTime) < SEEK_PIN_TOLERANCE_S
  ) {
    explicitSeek = false;
    next.kind = "";
  }

  const jumpFromLast = playbackData
    ? Math.abs((playbackData.currentTime || 0) - next.currentTime)
    : 0;

  if (seekPin && Date.now() < seekPin.until) {
    const delta = Math.abs(next.currentTime - seekPin.currentTime);
    if (delta > SEEK_PIN_TOLERANCE_S) {
      // Only a strong media source may steal the pin with an explicit scrub.
      if (explicitSeek && rank >= 2) {
        seekPin = {
          currentTime: next.currentTime,
          paused: next.paused,
          until: Date.now() + SEEK_PIN_MS
        };
      } else if (isPausePlay) {
        next.currentTime = seekPin.currentTime;
        seekPin.paused = next.paused;
      } else {
        return { ok: true, ignored: "seek-pin" };
      }
    } else {
      seekPin.currentTime = next.currentTime;
      seekPin.paused = next.paused;
      if (!next.paused)
        seekPin.until = Math.max(seekPin.until, Date.now() + 1500);
    }
  } else if (explicitSeek || jumpFromLast > SEEK_PIN_TOLERANCE_S) {
    seekPin = {
      currentTime: next.currentTime,
      paused: next.paused,
      until: Date.now() + SEEK_PIN_MS
    };
  }

  if (rank >= TRUSTED_MEDIA_RANK) {
    lastMediaSource = source;
    lastMediaSourceAt = Date.now();
  }

  playbackData = next;
  warmAuth();

  // Buffer ticks during browse→watch gap; push once presence exists.
  if (pageMode !== "watch" || !presenceData?.title)
    return { ok: true, buffered: true };

  // First media after browse→watch / anime switch: one progress POST with the
  // new title (nav alone used to flash frozen 00:00).
  const firstPlayback =
    watchAwaitingPlayback &&
    !watchPlaybackFlushQueued &&
    rank >= TRUSTED_MEDIA_RANK &&
    Number.isFinite(next.duration) &&
    next.duration > 1;

  const forcePush = isPausePlay || explicitSeek || firstPlayback || Boolean(next.force);
  if (!forcePush)
    return { ok: true, skipped: true };

  const actionKind = explicitSeek
    ? "seek"
    : kind === "hitch" || kind === "ended"
      ? "pause"
      : (isPausePlay || firstPlayback || next.force)
        ? (kind || (next.paused ? "pause" : "play"))
        : next.paused
          ? "pause"
          : "play";

  const shouldFlush = logYou(actionKind, next);

  if (Date.now() < rateLimitUntil) {
    if (firstPlayback)
      watchPlaybackFlushQueued = true;
    pushQueued = true;
    scheduleRateLimitRetry();
    return { ok: true, rateLimited: true };
  }

  if (!shouldFlush)
    return { ok: true, coalesced: true };

  if (firstPlayback)
    watchPlaybackFlushQueued = true;

  lastActivityKey = null;
  flushPresence({ urgent: true });
  return { ok: true };
}

let browseFlushTimer = null;
/** After watch→browse, wait this long before Discord browse — rapid anime
 *  hops cancel this and go straight to the next watch (avoids 429). */
const BROWSE_AFTER_WATCH_MS = 1000;

function onBrowse(tabId, tick = false) {
  if (tabId == null)
    return { ok: false };
  activeTabId = tabId;
  const fromIdle = pageMode === "idle";
  const fromWatch = pageMode === "watch";
  const becameBrowse = pageMode !== "browse";
  pageMode = "browse";
  presenceData = null;
  playbackData = null;
  lastSentPlayback = null;
  seekPin = null;
  lastMediaSource = "";
  lastMediaSourceAt = 0;
  watchAwaitingPlayback = false;
  watchPlaybackFlushQueued = false;
  watchNavAllowTitleOnly = false;
  playbackMuteUntil = 0;
  clearWatchPlaybackTimers();
  browseStart ??= Date.now();
  armSessionKeepalive();
  warmAuth();
  // Tick = keepalive ping only (no Discord POST).
  // Already browsing with a Discord browse up — don't queue another POST.
  if (!tick && becameBrowse) {
    if (browseFlushTimer) {
      clearTimeout(browseFlushTimer);
      browseFlushTimer = null;
    }
    if (fromWatch) {
      // Keep the previous watch on Discord while hopping shows. Only POST
      // browse if they actually linger on the catalog.
      browseFlushTimer = setTimeout(() => {
        browseFlushTimer = null;
        if (pageMode !== "browse")
          return;
        logYouNav("browse Miruro");
        lastActivityKey = null;
        flushPresence({ urgent: true });
      }, BROWSE_AFTER_WATCH_MS);
    } else {
      logYouNav("browse Miruro");
      lastActivityKey = null;
      flushPresence({ urgent: true, bypassGap: fromIdle });
    }
  }
  persistPresenceState();
  return { ok: true };
}

function persistPresenceState() {
  chrome.storage.local.set({
    [STORAGE_KEYS.presenceState]: {
      activeTabId,
      pageMode,
      presenceData,
      playbackData,
      browseStart,
      dotFrame,
      lastActivityKey,
      sessionToken
    }
  }).catch(() => {});
}

async function restorePresenceState() {
  // Content script already claimed this worker — don't clobber live browse/watch
  // with a disk snapshot (boot hydrate was wiping RPC ~3s after browse).
  if (pageMode !== "idle")
    return;

  const stored = await chrome.storage.local.get(STORAGE_KEYS.presenceState);
  const snap = stored[STORAGE_KEYS.presenceState];
  if (!snap)
    return;
  activeTabId = snap.activeTabId ?? null;
  pageMode = snap.pageMode || "idle";
  presenceData = snap.presenceData || null;
  playbackData = snap.playbackData || null;
  browseStart = snap.browseStart || null;
  dotFrame = Number(snap.dotFrame) || 0;
  // Don't restore lastActivityKey — it skips Discord upserts after SW reload.
  lastActivityKey = null;
  if (snap.sessionToken)
    sessionToken = snap.sessionToken;

  // Don't resurrect RPC after a restart/suspend if the Miruro tab is gone.
  if (pageMode !== "idle" && !(await isLiveMiruroTab(activeTabId))) {
    const next = await findMiruroTab();
    if (next != null) {
      activeTabId = next;
      persistPresenceState();
    } else {
      activeTabId = null;
      pageMode = "idle";
      presenceData = null;
      playbackData = null;
      browseStart = null;
      lastActivityKey = null;
      lastSentPlayback = null;
      armSessionKeepalive();
      persistPresenceState();
      // Don't await inside hydrate — clearPresence→hydrate deadlocked the popup.
      clearPresence().catch((err) => console.warn("restore clearPresence:", err));
      return;
    }
  }

  if (pageMode !== "idle" && isSharingActive()) {
    if (pageMode === "watch")
      watchNavAllowTitleOnly = true;
    armSessionKeepalive();
    // One shot — do not bypassGap here (that arms backup alarms and storms).
    flushPresence({ urgent: true });
  }
}

function isMiruroUrl(url) {
  try {
    return isMiruroHost(new URL(String(url)).hostname);
  } catch {
    return false;
  }
}

async function isLiveMiruroTab(tabId) {
  if (tabId == null)
    return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    return Boolean(tab && !tab.discarded && isMiruroUrl(tab.url || ""));
  } catch {
    return false;
  }
}

async function findMiruroTab() {
  try {
    const tabs = await chrome.tabs.query({
      url: ["*://miruro.cx/*", "*://www.miruro.cx/*", "*://*.miruro.cx/*"]
    });
    const live = (tabs || []).find((tab) => tab.id != null && isMiruroUrl(tab.url || ""));
    return live?.id ?? null;
  } catch {
    return null;
  }
}

/** Clear Discord if the driving tab died and no other Miruro tab remains. */
async function ensureMiruroTabAlive() {
  if (pageMode === "idle")
    return false;
  if (await isLiveMiruroTab(activeTabId))
    return true;
  const next = await findMiruroTab();
  if (next != null) {
    activeTabId = next;
    persistPresenceState();
    return true;
  }
  await clearPresenceState();
  return false;
}

async function onActiveTabGone(tabId, { keepalive = false } = {}) {
  if (activeTabId != null && tabId !== activeTabId)
    return;
  const next = await findMiruroTab();
  if (next != null && next !== tabId) {
    activeTabId = next;
    logYouNav(`switch Miruro tab → ${next}`);
    persistPresenceState();
    // Other tab's content script will claim/browse/watch shortly.
    return;
  }
  await clearPresenceState({ keepalive });
}

async function clearPresenceState({ keepalive = false } = {}) {
  const wasActive = pageMode !== "idle";
  if (wasActive)
    logYouNav("leave Miruro");
  activeTabId = null;
  pageMode = "idle";
  presenceData = null;
  playbackData = null;
  browseStart = null;
  lastActivityKey = null;
  lastSentPlayback = null;
  seekPin = null;
  lastMediaSource = "";
  lastMediaSourceAt = 0;
  dotFrame = 0;
  armSessionKeepalive();
  persistPresenceState();
  if (keepalive)
    await clearPresenceKeepalive();
  else
    await clearPresence();
  if (wasActive)
    logDiscord(true, null, { shown: "cleared", ms: 0 });
}

async function onClear(tabId) {
  // Only ignore clears from non-active tabs while we still have an owner.
  if (tabId != null && activeTabId != null && tabId !== activeTabId)
    return { ok: true };
  await clearPresenceState();
  return { ok: true };
}

async function onLeave(tabId, reason = "") {
  if (tabId != null && activeTabId != null && tabId !== activeTabId)
    return { ok: true };
  // Tab close / navigate away — keepalive so the delete can finish after the
  // content script dies (SW would otherwise drop a normal fetch).
  if (reason === "hidden" || reason === "pagehide" || reason === "freeze") {
    await clearPresenceState({ keepalive: true });
    return { ok: true };
  }
  if (tabId == null || activeTabId == null || tabId === activeTabId) {
    await onActiveTabGone(tabId ?? activeTabId, { keepalive: true });
  }
  return { ok: true };
}

function schedulePush(immediate = false) {
  if (pushTimer)
    clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushPresence().catch((err) => console.warn("pushPresence:", err));
  }, immediate ? 0 : 40);
}

function scheduleRateLimitRetry() {
  if (rateLimitRetryTimer)
    return;
  const delay = Math.max(250, rateLimitUntil - Date.now());
  rateLimitRetryTimer = setTimeout(() => {
    rateLimitRetryTimer = null;
    if (Date.now() < rateLimitUntil) {
      scheduleRateLimitRetry();
      return;
    }
    if (pushQueued || pageMode === "watch") {
      pushQueued = false;
      lastActivityKey = null;
      flushPresence({ urgent: true });
    }
  }, delay);
}

function flushPresence({ urgent = false, bypassGap = false } = {}) {
  if (Date.now() < rateLimitUntil) {
    pushQueued = true;
    scheduleRateLimitRetry();
    return;
  }

  // Idle→browse / mode change: POST now. One delayed alarm is backup only
  // (cold SW may drop the in-flight promise) — never re-arm on every urgent.
  if (urgent && bypassGap) {
    if (flushDebounceTimer) {
      clearTimeout(flushDebounceTimer);
      flushDebounceTimer = null;
    }
    armPresenceFlushAlarm(2000);
    if (pushInFlight) {
      pushQueued = true;
      return;
    }
    pushPresence().catch((err) => console.warn("pushPresence:", err));
    return;
  }

  // Trailing coalesce — do not reset an already-scheduled flush.
  if (flushDebounceTimer) {
    if (urgent) {
      // Pause/seek: fire ASAP once, still without resetting into a loop.
      clearTimeout(flushDebounceTimer);
      flushDebounceTimer = null;
    } else {
      return;
    }
  }

  const wait = urgent ? 80 : FLUSH_DEBOUNCE_MS;
  flushDebounceTimer = setTimeout(() => {
    flushDebounceTimer = null;
    if (pushInFlight) {
      pushQueued = true;
      return;
    }
    // Space POSTs out — Discord 429s hard if we burst.
    // Mode changes (browse→watch) may bypass the long gap with a tiny floor.
    const gap = Date.now() - lastPushAt;
    const minGap = bypassGap ? 900 : MIN_POST_GAP_MS;
    if (lastPushAt && gap < minGap) {
      pushQueued = true;
      flushDebounceTimer = setTimeout(() => {
        flushDebounceTimer = null;
        flushPresence({ urgent: true, bypassGap });
      }, minGap - gap);
      return;
    }
    pushPresence().catch((err) => console.warn("pushPresence:", err));
  }, wait);
}

function setPushError(message) {
  lastPushError = message || null;
  chrome.storage.local.set({ [STORAGE_KEYS.lastPushError]: lastPushError }).catch(() => {});
}

async function pushPresence({ keepalive = false } = {}) {
  if (keepalive && (pushInFlight || Date.now() - lastPushAt < 45_000))
    return;
  // Don't let keepalive stamp frozen 00:00 while a tab/anime switch is settling.
  if (keepalive && watchAwaitingPlayback)
    return;
  // After Clear stuck RPC — don't let a live Miruro tab instantly rebuild browse.
  if (Date.now() < presenceSuppressedUntil)
    return;

  // Master off / muted anime — keep Discord clear and skip POSTs.
  if (!isSharingActive()) {
    if (sessionToken)
      await clearPresence();
    setBadge(tokens?.access_token ? (presenceEnabled ? "muted" : "paused") : "off");
    return;
  }

  if (Date.now() < rateLimitUntil) {
    pushQueued = true;
    scheduleRateLimitRetry();
    return;
  }

  if (pushInFlight) {
    pushQueued = true;
    return;
  }

  pushInFlight = true;
  pushQueued = false;

  try {
    // Always refresh session token from disk before POST (Android wakeups).
    try {
      const bit = await chrome.storage.local.get(STORAGE_KEYS.sessionToken);
      if (bit[STORAGE_KEYS.sessionToken])
        sessionToken = bit[STORAGE_KEYS.sessionToken];
    } catch { /* ignore */ }

    // Single POST per entry — if state moves, queue ONE follow-up (no burst).
    let accessToken = null;
    if (tokens?.access_token && Date.now() < (tokens.expires_at || 0))
      accessToken = tokens.access_token;
    else
      accessToken = await ensureAccessToken();

    if (!accessToken) {
      logDiscord(false, playbackData, { error: "no token" });
      setBadge("auth");
      // Auth was still loading — retry once the worker stays awake.
      if (pageMode === "watch")
        armWatchFlushAlarm(1200);
      else if (pageMode === "browse")
        armPresenceFlushAlarm(1200);
      return;
    }

    const android = await isAndroidRuntime();
    let snapMode = pageMode;
    const snapPresence = presenceData;
    if (snapMode === "browse" && snapPresence?.title)
      snapMode = "watch";
    // Use the YOU-action snapshot so a delayed POST can't turn "pause" into
    // "playing" because the player moved on while we waited for rate/gap.
    // Nav fallback is title-only. Prefer live media when the first watch flush
    // still has a nav pending (deferred POST after mute).
    let snapPlayback = null;
    if (pendingUserAction?.kind === "nav") {
      if (
        snapMode === "watch" &&
        hasValidPlayback(playbackData) &&
        isTrustedMedia(playbackData) &&
        Date.now() >= playbackMuteUntil
      ) {
        snapPlayback = playbackSnapshot(playbackData);
      } else if (watchNavAllowTitleOnly || android || snapMode === "watch") {
        if (hasValidPlayback(playbackData))
          snapPlayback = playbackSnapshot(playbackData);
        else
          snapPlayback = seedPlaybackFromPresence(snapPresence);
      } else if (watchAwaitingPlayback) {
        // Accidental flush during switch — wait for kick/fallback.
        return;
      } else {
        snapPlayback = null;
      }
    } else if (pendingUserAction?.snapshot) {
      snapPlayback = pendingUserAction.snapshot;
    } else {
      snapPlayback = playbackSnapshot(playbackData) || seedPlaybackFromPresence(snapPresence);
    }

    watchNavAllowTitleOnly = false;

    if (snapMode === "idle") {
      // Stale queued flush after browse/watch already left — don't attribute
      // this to the old YOU nav line.
      pendingUserAction = null;
      if (!sessionToken && !sessionTokenHistory.length)
        return;
      const cleared = await clearPresence({ keepalive: android });
      logDiscord(cleared, null, {
        shown: cleared ? "cleared" : "clear failed",
        ms: 0,
        forAction: null
      });
      return;
    }

    // Browse prep lost the race to watch — send watch on the follow-up instead.
    if (snapMode === "browse" && pageMode === "watch") {
      pushQueued = true;
      lastActivityKey = null;
      return;
    }

    let activity;
    if (snapMode === "browse") {
      browseStart ??= Date.now();
      activity = {
        type: 5,
        name: ACTIVITY.browseName,
        details: ACTIVITY.browseDetails,
        state: "One more episode...",
        application_id: CLIENT_ID,
        platform: "desktop",
        supported_platforms: ["desktop", "android", "ios"],
        assets: {
          large_image: ACTIVITY.assetUrl || ACTIVITY.assetId
        },
        timestamps: { start: String(browseStart) }
      };
    } else {
      // Full payload first (ep title, cover, progress). Minimal is 400-fallback only.
      activity = buildWatchActivity(snapPresence, snapPlayback);
      if (!activity)
        return;
    }

    const key = activityKey(activity, snapPlayback);
    if (key === lastActivityKey)
      return;

    const startedAt = Date.now();
    const actionIdAtStart = pendingUserAction?.id ?? null;
    const actionAtStart = pendingUserAction?.action || null;
    const modeAtStart = snapMode;

    try {
      let result;
      try {
        result = await upsertHeadlessSession(accessToken, activity, sessionToken);
      } catch (err) {
        // Watch payloads with cover/buttons sometimes 400 — retry minimal, same token.
        if (modeAtStart === "watch" && sessionToken) {
          const minimal = buildMinimalWatchActivity(snapPresence, snapPlayback);
          if (!minimal)
            throw err;
          activity = minimal;
          result = await upsertHeadlessSession(accessToken, activity, sessionToken);
        } else {
          throw err;
        }
      }
      if (result?.token)
        await rememberSessionToken(result.token);
      else if (sessionToken)
        await rememberSessionToken(sessionToken);

      // Left Miruro while this POST was in flight — delete what we just upserted.
      if (pageMode === "idle") {
        await forceClearHeadlessPresence(accessToken, { keepalive: android });
        return;
      }
      // Browse finished after watch started — queue a watch follow-up.
      if (modeAtStart === "browse" && pageMode === "watch") {
        pushQueued = true;
        lastActivityKey = null;
        return;
      }

      if (modeAtStart === "watch")
        clearWatchFlushAlarm();

      lastActivityKey = key;
      lastPushAt = Date.now();
      try {
        chrome.alarms.clear(ALARM_PRESENCE_FLUSH);
      } catch { /* ignore */ }
      if (modeAtStart === "watch" && snapPlayback && snapPlayback.duration > 0) {
        lastSentPlayback = {
          currentTime: snapPlayback.currentTime,
          duration: snapPlayback.duration,
          paused: snapPlayback.paused,
          at: Date.now()
        };
        watchAwaitingPlayback = false;
        watchPlaybackFlushQueued = false;
        clearWatchPlaybackTimers();
      } else if (modeAtStart === "watch" && pendingUserAction?.kind === "nav") {
        // Title-only fallback — stop waiting so later ticks can update normally.
        watchAwaitingPlayback = false;
        watchPlaybackFlushQueued = false;
      }
      setPushError(null);
      persistPresenceState();
      setBadge(modeAtStart === "watch" ? "watch" : "browse");

      // If pause→play (or another YOU) landed mid-POST, keep pending and requeue.
      const newerAction =
        pendingUserAction && pendingUserAction.id !== actionIdAtStart;

      if (keepalive && !pendingUserAction) {
        // silent session keepalive
      } else if (modeAtStart === "browse") {
        logDiscord(true, null, {
          shown: "browse",
          ms: Date.now() - startedAt,
          forAction: actionAtStart,
          clearPending: !newerAction
        });
      } else {
        const snap = formatPlaybackShort(snapPlayback);
        const shown = snap
          ? `${snap.paused ? "paused" : "playing"} @ ${snap.at}`
          : `watch ${String(activity?.name || snapPresence?.title || "").slice(0, 40)}`;
        logDiscord(true, snapPlayback, {
          shown,
          ms: Date.now() - startedAt,
          forAction: actionAtStart,
          clearPending: !newerAction
        });
      }

      if (newerAction) {
        pushQueued = true;
        lastActivityKey = null;
      }
    } catch (err) {
      const msg = String(err?.message || err);
      console.warn("pushPresence:", err);
      logDiscord(false, snapPlayback, { error: msg, ms: Date.now() - startedAt });
      lastActivityKey = null;
      if (/rate limit/i.test(msg)) {
        rateLimitUntil = Date.now() + 15000;
        pushQueued = true;
        // Keep pause/seek pending across the backoff — dropping them left Discord
        // stuck on "playing" after the user already paused.
        setPushError(msg);
        scheduleRateLimitRetry();
        return;
      }
      setPushError(msg);
      setBadge("auth");
    }
  } finally {
    pushInFlight = false;
    if (pushQueued && Date.now() >= rateLimitUntil) {
      pushQueued = false;
      // Keep lastActivityKey — duplicate playing ticks must not force another POST.
      setTimeout(() => flushPresence({ urgent: true }), MIN_POST_GAP_MS);
    }
  }
}

async function pushTestPresence() {
  pageMode = "browse";
  presenceData = null;
  playbackData = null;
  browseStart = Date.now();
  lastActivityKey = null;
  await pushPresence();
}

function nameTitleMax() {
  return Number(ACTIVITY.nameTitleMax) > 0 ? Number(ACTIVITY.nameTitleMax) : 16;
}

function heuristicTitleVariants(title) {
  const full = sanitizePresenceText(title, 128);
  if (!full)
    return [];
  const out = [full];
  const noSeason = full
    .replace(/\s*[:\-–—]?\s*(?:season|part|cour|arc|series)\s*\d+\b.*$/i, "")
    .replace(/\s+\d+(?:st|nd|rd|th)?\s+season\b.*$/i, "")
    .trim();
  if (noSeason && noSeason !== full)
    out.push(noSeason);
  for (const base of [...out]) {
    const colon = base.indexOf(":");
    if (colon > 2) {
      const left = base.slice(0, colon).trim();
      if (left.length >= 3)
        out.push(left);
    }
    // TSUKIMICHI -Moonlit Fantasy- → TSUKIMICHI
    const dash = base.split(/\s[-–—]\s+|\s[-–—]|[-–—]\s+/)[0].trim()
      .replace(/^[-–—]+|[-–—]+$/g, "")
      .trim();
    if (dash.length >= 3 && dash.length < base.length)
      out.push(dash);
  }
  return out;
}

function latinRatio(text) {
  const chars = String(text || "").replace(/\s+/g, "");
  if (!chars)
    return 0;
  let latin = 0;
  for (const ch of chars) {
    if (/[A-Za-z0-9]/.test(ch))
      latin += 1;
  }
  return latin / chars.length;
}

function isWeakShortTitle(text, fullTitle) {
  const value = sanitizePresenceText(text, 128);
  if (!value || value.length < 2)
    return true;
  if (/^(season|part|cour|arc|movie|ova|ona|special)s?\b/i.test(value))
    return true;
  if (value.length > 24 && /[,!]/.test(value) && value.length >= String(fullTitle || "").length)
    return true;
  return false;
}

function scoreShortTitleCandidate(text, fullTitle, max) {
  const value = sanitizePresenceText(text, 128);
  if (isWeakShortTitle(value, fullTitle))
    return Number.POSITIVE_INFINITY;
  const over = Math.max(0, value.length - max);
  const latin = latinRatio(value);
  return (
    over * 1000 +
    value.length * 10 +
    // Discord name should stay Latin when possible (native JP is short but unreadable in the ladder).
    (latin < 0.55 ? 5000 : 0) +
    // "That Time I Got" must lose to TenSura.
    (isAwkwardEnglishTrunc(value) ? 8000 : 0) +
    (value.includes(",") ? 40 : 0) +
    (value.split(/\s+/).length > 4 ? 25 : 0)
  );
}

function isLatinShortTitle(text) {
  return latinRatio(text) >= 0.55;
}

function truncateLatinTitle(text, max) {
  const value = sanitizePresenceText(text, 128);
  if (!value || !isLatinShortTitle(value))
    return "";
  if (value.length <= max)
    return value;
  return value.slice(0, max).replace(/\s+\S*$/, "").trim()
    || value.slice(0, max).trim();
}

/** "That Time I Got" is a bad cut; "My Gift Lvl 9999" is fine. */
function isAwkwardEnglishTrunc(trunc) {
  const value = sanitizePresenceText(trunc, 128);
  if (!value || value.length < 6)
    return true;
  return /\b(i|a|an|the|as|of|and|or|to|got|my|for|in|on|at)$/i.test(value);
}

/** Short label for Discord `name` only — full title stays in `details`. */
function shortTitleForWatchName(fullTitle, extraTitles = []) {
  const full = sanitizePresenceText(fullTitle, 128);
  if (!full)
    return "";
  const max = nameTitleMax();
  const localVariants = heuristicTitleVariants(full)
    .map((t) => sanitizePresenceText(t, 128))
    .filter((t) => t && !isWeakShortTitle(t, full));
  const localLatinFit = localVariants
    .filter((t) => t.length <= max && isLatinShortTitle(t) && !isAwkwardEnglishTrunc(t))
    .sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
  if (localLatinFit)
    return localLatinFit;

  const pool = [];
  const seen = new Set();
  const push = (value) => {
    for (const variant of heuristicTitleVariants(value)) {
      const clean = sanitizePresenceText(variant, 128);
      const key = normalizeTitleKey(clean);
      if (!clean || !key || seen.has(key))
        continue;
      seen.add(key);
      pool.push(clean);
    }
  };
  push(full);
  for (const alt of extraTitles || [])
    push(alt);
  if (!pool.length)
    return truncateLatinTitle(full, max) || "";

  const latinPool = pool.filter(isLatinShortTitle);
  const usePool = latinPool.length ? latinPool : pool;
  usePool.sort(
    (a, b) =>
      scoreShortTitleCandidate(a, full, max) - scoreShortTitleCandidate(b, full, max)
  );
  // Prefer real shorts (TenSura, Mugen Gacha) over awkward English cuts.
  const nonAwkwardFit = usePool.find(
    (t) => t.length <= max && !isAwkwardEnglishTrunc(t)
  );
  if (nonAwkwardFit)
    return nonAwkwardFit;

  // AniList not in yet — last resort truncation.
  const scrapedTrunc = truncateLatinTitle(
    localVariants.filter(isLatinShortTitle).sort((a, b) => a.length - b.length)[0] || full,
    max
  );
  if (scrapedTrunc)
    return scrapedTrunc;
  const truncSource = usePool[0];
  if (!truncSource)
    return "";
  return truncSource.slice(0, max).replace(/\s+\S*$/, "").trim()
    || truncSource.slice(0, max).trim();
}

function collectPresenceTitleAlts(presence) {
  const out = [];
  if (Array.isArray(presence?.titles))
    out.push(...presence.titles);
  if (Array.isArray(presence?.anilistTitles))
    out.push(...presence.anilistTitles);
  return out;
}

function buildWatchActivityName(fullTitle, presence = null) {
  const short = shortTitleForWatchName(fullTitle, collectPresenceTitleAlts(presence));
  const suffix = ACTIVITY.watchNameSuffix || " on Miruro! ッ";
  if (!short)
    return ACTIVITY.watchName || `Anime${suffix}`;
  return sanitizePresenceText(`${short}${suffix}`, 128);
}

const anilistTitleCache = new Map();
const anilistInflight = new Map();

function parseAnilistIdFromCover(url) {
  const value = String(url || "");
  let m = value.match(
    /\/media\/anime\/cover\/(?:extraLarge|large|medium)\/(?:[a-z]{1,3})?(\d{2,7})-/i
  );
  if (m)
    return Number(m[1]);
  m = value.match(/img\.anili\.st\/media\/(\d{2,7})/i);
  if (m)
    return Number(m[1]);
  m = value.match(/anilist\.co\/(?:anime|manga)\/(\d{2,7})/i);
  return m ? Number(m[1]) : null;
}

async function fetchAnilistTitles({ id = null, search = "" } = {}) {
  const cacheKey = id ? `id:${id}` : `q:${normalizeTitleKey(search)}`;
  if (!id && !String(search || "").trim())
    return [];
  if (anilistTitleCache.has(cacheKey))
    return anilistTitleCache.get(cacheKey) || [];
  if (anilistInflight.has(cacheKey))
    return anilistInflight.get(cacheKey);

  const request = (async () => {
    const query = id
      ? `query ($id: Int) {
          Media(id: $id, type: ANIME) {
            title { romaji english native }
            synonyms
          }
        }`
      : `query ($q: String) {
          Media(search: $q, type: ANIME) {
            title { romaji english native }
            synonyms
          }
        }`;
    try {
      const res = await fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          query,
          variables: id ? { id: Number(id) } : { q: String(search).slice(0, 100) }
        })
      });
      if (!res.ok)
        throw new Error(`AniList ${res.status}`);
      const json = await res.json();
      const media = json?.data?.Media;
      if (!media) {
        anilistTitleCache.set(cacheKey, []);
        return [];
      }
      const titles = [
        media.title?.english,
        media.title?.romaji,
        media.title?.native,
        ...(Array.isArray(media.synonyms) ? media.synonyms : [])
      ]
        .map((t) => sanitizePresenceText(t, 128))
        .filter(Boolean);
      anilistTitleCache.set(cacheKey, titles);
      return titles;
    } catch {
      return [];
    } finally {
      anilistInflight.delete(cacheKey);
    }
  })();

  anilistInflight.set(cacheKey, request);
  return request;
}

function anilistTitlesMatchScraped(scrapedTitle, anilistTitles) {
  const scraped = normalizeTitleKey(scrapedTitle);
  if (!scraped || !Array.isArray(anilistTitles) || !anilistTitles.length)
    return false;
  const scrapedWords = scraped.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  for (const raw of anilistTitles) {
    const key = normalizeTitleKey(raw);
    if (!key)
      continue;
    if (key === scraped || key.includes(scraped) || scraped.includes(key))
      return true;
    if (!scrapedWords.length)
      continue;
    const other = new Set(key.split(/[^a-z0-9]+/).filter((w) => w.length > 2));
    const hits = scrapedWords.filter((w) => other.has(w)).length;
    if (hits / scrapedWords.length >= 0.5)
      return true;
  }
  return false;
}

async function resolveAnilistTitles(presence) {
  const scraped = String(presence?.title || "").trim();
  if (!scraped)
    return [];
  const searched = await fetchAnilistTitles({ search: scraped });
  if (searched.length && anilistTitlesMatchScraped(scraped, searched))
    return searched;
  const id = Number(presence.anilistId) || parseAnilistIdFromCover(presence.cover) || null;
  if (!id)
    return searched;
  const byId = await fetchAnilistTitles({ id });
  if (byId.length && anilistTitlesMatchScraped(scraped, byId))
    return byId;
  return searched;
}

async function enrichWatchTitlesFromAnilist(presence, { flush = true } = {}) {
  if (!presence?.title)
    return false;
  if (Array.isArray(presence.anilistTitles) && presence.anilistTitles.length)
    return false;
  const titles = await resolveAnilistTitles(presence);
  if (!titles.length || !anilistTitlesMatchScraped(presence.title, titles))
    return false;
  if (presenceData !== presence && presenceMetaKey(presenceData) !== presenceMetaKey(presence))
    return false;
  const before = buildWatchActivityName(presence.title, presence);
  presence.anilistTitles = titles;
  if (presenceData === presence || presenceMetaKey(presenceData) === presenceMetaKey(presence)) {
    if (presenceData && presenceData !== presence)
      presenceData.anilistTitles = titles;
    else if (!presenceData)
      presenceData = presence;
  }
  const after = buildWatchActivityName(presence.title, presence);
  if (before === after)
    return false;
  persistPresenceState();
  if (flush) {
    lastActivityKey = null;
    flushPresence({ urgent: true });
  }
  return true;
}

function buildWatchActivity(presence, playback) {
  if (!presence?.title)
    return null;

  const details = sanitizePresenceText(presence.title, 128);
  if (!details)
    return null;
  const episode = presence.episode || 1;
  let state = `EP. ${episode}`;

  if (presence.episodeTitle) {
    const prefix = `${state}: "`;
    const suffix = `"`;
    const max = 128 - prefix.length - suffix.length;
    const epTitle = sanitizePresenceText(presence.episodeTitle, Math.max(0, max));
    if (epTitle)
      state = `${prefix}${epTitle}${suffix}`;
  }

  const url = sanitizeWatchUrl(presence.url);
  const brandImage = ACTIVITY.assetUrl || ACTIVITY.assetId;
  const largeImage = sanitizeCover(presence.cover) || brandImage;
  const paused = !hasValidPlayback(playback) || Boolean(playback.paused);
  const playImage = ACTIVITY.playUrl || brandImage;
  const pauseImage = ACTIVITY.pauseUrl || brandImage;

  // Shape matches working Social Layer / Neurobox headless payloads
  // (timestamps are millisecond strings, not IPC-style seconds).
  const activity = {
    type: 3,
    name: buildWatchActivityName(details, presence),
    details,
    state,
    application_id: CLIENT_ID,
    platform: "desktop",
    supported_platforms: ["desktop", "android", "ios"],
    assets: {
      large_image: largeImage,
      large_text: details.slice(0, 128),
      large_url: url || undefined,
      small_image: paused ? pauseImage : playImage,
      small_text: paused ? "Paused" : "Playing"
    }
  };

  if (url) {
    activity.buttons = [{ label: ACTIVITY.buttonLabel, url }];
    activity.metadata = { button_urls: [url] };
  }

  if (hasValidPlayback(playback)) {
    const currentTime = Math.max(0, Math.min(Number(playback.currentTime) || 0, playback.duration));
    const now = Date.now();
    if (playback.paused) {
      // start === end → Discord shows a frozen 00:00 / 00:00 bar
      activity.timestamps = {
        start: String(now),
        end: String(now)
      };
    } else {
      activity.timestamps = {
        start: String(Math.floor(now - currentTime * 1000)),
        end: String(Math.floor(now + (playback.duration - currentTime) * 1000))
      };
    }
  } else {
    const now = Date.now();
    activity.timestamps = {
      start: String(now),
      end: String(now)
    };
  }

  return activity;
}

function hasValidPlayback(playback) {
  return Boolean(
    playback &&
    Number.isFinite(playback.duration) &&
    playback.duration > 0 &&
    Number.isFinite(playback.currentTime)
  );
}

const COVER_HOST_ALLOW =
  /(^|\.)(miruro\.cx|anilist\.co|anilistcdn\.com|myanimelist\.net|cdn\.myanimelist\.net|kitsu\.io|media\.kitsu\.io|discordapp\.com|discordapp\.net|discord\.com|imgur\.com|i\.imgur\.com|image\.tmdb\.org|themoviedb\.org|wp\.com|wordpress\.com|cloudfront\.net|bunnycdn\.com|b-cdn\.net|googleusercontent\.com|ggpht\.com)$/i;

function sanitizePresenceText(value, max = 128) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function sanitizeCover(cover) {
  if (!cover || typeof cover !== "string")
    return null;
  try {
    const u = new URL(cover.trim());
    if (u.protocol !== "https:")
      return null;
    if (!COVER_HOST_ALLOW.test(u.hostname))
      return null;
    return u.toString().slice(0, 256);
  } catch {
    return null;
  }
}

function isMiruroHost(hostname) {
  return /(^|\.)miruro\.cx$/i.test(String(hostname || ""));
}

function sanitizeWatchUrl(url) {
  try {
    const u = new URL(String(url));
    if (!isMiruroHost(u.hostname))
      return null;
    u.hash = "";
    return u.toString().slice(0, 512);
  } catch {
    return null;
  }
}

function activityKey(activity, playback = null) {
  // Do NOT key on wall-clock timestamp strings — those change every Date.now()
  // and were re-POSTing identical "playing @ 0:01" every few seconds → 429 →
  // pause never landed.
  let progress = "none";
  if (hasValidPlayback(playback)) {
    const t = Math.floor(Number(playback.currentTime) || 0);
    progress = playback.paused ? `paused:${t}` : `play:${t}`;
  } else {
    const start = Number(activity?.timestamps?.start);
    const end = Number(activity?.timestamps?.end);
    if (Number.isFinite(start) && Number.isFinite(end))
      progress = end <= start ? "paused" : "play";
  }
  return JSON.stringify({
    name: activity?.name,
    details: activity?.details,
    state: activity?.state,
    type: activity?.type,
    image: activity?.assets?.large_image,
    small: activity?.assets?.small_image,
    progress
  });
}

function isInvalidAuthMessage(msg, status) {
  if (status === 401)
    return true;
  return /invalid (oauth2 )?access token|invalid authentication token|unauthorized/i.test(
    String(msg || "")
  );
}

async function upsertHeadlessSession(accessToken, activity, token, { retriedAuth = false } = {}) {
  const body = { activities: [activity] };
  if (token)
    body.token = token;

  const res = await fetch(`${API_BASE}/users/@me/headless-sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.message || json.error || `Headless session failed (${res.status})`;
    if (res.status === 429) {
      const retry = Number(res.headers.get("Retry-After")) || 10;
      rateLimitUntil = Date.now() + Math.max(10, retry) * 1000;
      throw new Error("You are being rate limited.");
    }
    // Stale headless session id — try delete first (may still be live), then create.
    // Creating without deleting stacks a second session; Discord shows the newest
    // until you delete it, then the orphan comes back.
    if (
      token &&
      (res.status === 404 ||
        /invalid.*session|unknown.*session|invalid authentication token/i.test(msg))
    ) {
      sessionTokenHistory = normalizeTokenHistory(sessionTokenHistory, token);
      try {
        await deleteHeadlessSession(accessToken, token);
      } catch (err) {
        console.warn("upsert stale-token delete:", err);
      }
      sessionToken = null;
      try {
        await chrome.storage.local.set({
          [STORAGE_KEYS.sessionToken]: null,
          [STORAGE_KEYS.sessionTokenHistory]: sessionTokenHistory
        });
      } catch { /* ignore */ }
      return upsertHeadlessSession(accessToken, activity, null, { retriedAuth });
    }
    if (!retriedAuth && isInvalidAuthMessage(msg, res.status)) {
      try {
        const fresh = await refreshTokens();
        return upsertHeadlessSession(fresh, activity, null, { retriedAuth: true });
      } catch {
        throw new Error("Discord login expired — Disconnect and Connect Discord again.");
      }
    }
    if (isInvalidAuthMessage(msg, res.status))
      throw new Error("Discord login expired — Disconnect and Connect Discord again.");
    throw new Error(msg);
  }

  // Created a brand-new session — delete any older tokens we still know about
  // so they can't resurface after this one is cleared.
  if (!token && json?.token) {
    const stale = normalizeTokenHistory(sessionTokenHistory).filter((t) => t !== json.token);
    if (stale.length) {
      Promise.allSettled(
        stale.map((t) => deleteHeadlessSession(accessToken, t).catch(() => {}))
      ).then(() => {
        sessionTokenHistory = normalizeTokenHistory([json.token]);
        chrome.storage.local.set({
          [STORAGE_KEYS.sessionTokenHistory]: sessionTokenHistory
        }).catch(() => {});
      });
    }
  }

  return json;
}

/** Strip optional fields Discord sometimes rejects on mobile. */
function buildMinimalWatchActivity(presence, playback = null) {
  const details = sanitizePresenceText(presence?.title, 128);
  if (!details)
    return null;
  const episode = presence?.episode || 1;
  let state = `EP. ${episode}`;
  if (presence?.episodeTitle) {
    const prefix = `${state}: "`;
    const suffix = `"`;
    const max = 128 - prefix.length - suffix.length;
    const epTitle = sanitizePresenceText(presence.episodeTitle, Math.max(0, max));
    if (epTitle)
      state = `${prefix}${epTitle}${suffix}`;
  }
  const cover = sanitizeCover(presence?.cover);
  const media = hasValidPlayback(playback) ? playback : seedPlaybackFromPresence(presence);
  const now = Date.now();
  let timestamps = { start: String(now), end: String(now) };
  if (hasValidPlayback(media) && !media.paused) {
    const currentTime = Math.max(0, Math.min(Number(media.currentTime) || 0, media.duration));
    timestamps = {
      start: String(Math.floor(now - currentTime * 1000)),
      end: String(Math.floor(now + (media.duration - currentTime) * 1000))
    };
  }
  return {
    type: 3,
    name: buildWatchActivityName(details, presence),
    details,
    state,
    application_id: CLIENT_ID,
    platform: "desktop",
    supported_platforms: ["desktop", "android", "ios"],
    assets: {
      large_image: cover || ACTIVITY.assetUrl || ACTIVITY.assetId,
      large_text: details.slice(0, 128)
    },
    timestamps
  };
}

async function deleteHeadlessSession(accessToken, token, { keepalive = false } = {}) {
  const res = await fetch(`${API_BASE}/users/@me/headless-sessions/delete`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ token }),
    keepalive
  });
  // 204 success; 404 already gone — both fine. Anything else must retry.
  if (res.ok || res.status === 404)
    return true;
  if (res.status === 429) {
    const retry = Number(res.headers.get("Retry-After")) || 10;
    rateLimitUntil = Math.max(rateLimitUntil, Date.now() + Math.max(10, retry) * 1000);
    throw new Error("You are being rate limited.");
  }
  const json = await res.json().catch(() => ({}));
  throw new Error(json.message || json.error || `Clear presence failed (${res.status})`);
}

/** Delete every remembered headless token. No reclaim — that only stacks cover sessions. */
async function forceClearHeadlessPresence(
  accessToken,
  { keepalive = false, requireToken = false } = {}
) {
  if (!accessToken)
    return { ok: false, deleted: 0, error: "not logged in" };

  try {
    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.sessionToken,
      STORAGE_KEYS.sessionTokenHistory
    ]);
    if (!sessionToken && stored[STORAGE_KEYS.sessionToken])
      sessionToken = stored[STORAGE_KEYS.sessionToken];
    sessionTokenHistory = normalizeTokenHistory(
      [
        ...(Array.isArray(stored[STORAGE_KEYS.sessionTokenHistory])
          ? stored[STORAGE_KEYS.sessionTokenHistory]
          : []),
        ...sessionTokenHistory
      ],
      sessionToken
    );
  } catch { /* ignore */ }

  const tokensToDelete = normalizeTokenHistory(sessionTokenHistory, sessionToken);
  lastActivityKey = null;

  if (!tokensToDelete.length) {
    if (!requireToken)
      return { ok: true, deleted: 0, error: null };
    return {
      ok: false,
      deleted: 0,
      orphan: true,
      error: "Token lost — Discord drops the orphan in ~20 min."
    };
  }

  const survivors = [];
  let deleted = 0;
  for (const token of tokensToDelete) {
    try {
      await deleteHeadlessSession(accessToken, token, { keepalive });
      deleted += 1;
    } catch (err) {
      console.warn("forceClear delete:", err);
      survivors.push(token);
    }
  }

  if (survivors.length) {
    sessionToken = survivors[survivors.length - 1] || null;
    sessionTokenHistory = survivors;
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.sessionToken]: sessionToken,
        [STORAGE_KEYS.sessionTokenHistory]: sessionTokenHistory
      });
    } catch { /* ignore */ }
    return { ok: false, deleted, error: "Couldn't delete all Discord sessions" };
  }

  await clearStoredSessionTokens();
  return { ok: true, deleted, error: null };
}

/** Best-effort clear during browser quit — keepalive so the request can outlive the SW. */
async function clearPresenceKeepalive() {
  let accessToken = tokens?.access_token || null;
  try {
    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.sessionToken,
      STORAGE_KEYS.sessionTokenHistory,
      STORAGE_KEYS.tokens
    ]);
    if (!sessionToken)
      sessionToken = stored[STORAGE_KEYS.sessionToken] || null;
    sessionTokenHistory = normalizeTokenHistory(
      stored[STORAGE_KEYS.sessionTokenHistory],
      sessionToken
    );
    if (!accessToken)
      accessToken = stored[STORAGE_KEYS.tokens]?.access_token || null;
  } catch { /* ignore */ }
  if (!accessToken)
    return;

  await forceClearHeadlessPresence(accessToken, { keepalive: true });
  pageMode = "idle";
  presenceData = null;
  playbackData = null;
  activeTabId = null;
  try {
    chrome.storage.local.set({
      [STORAGE_KEYS.presenceState]: null
    });
  } catch { /* ignore */ }
}

async function clearPresence({ allowRetry = true, keepalive = false } = {}) {
  // Only hydrate when auth isn't already in memory (nested during restore).
  if (!tokens?.access_token)
    await hydrate({ restore: false });
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.sessionToken,
    STORAGE_KEYS.sessionTokenHistory
  ]);
  if (!sessionToken && stored[STORAGE_KEYS.sessionToken])
    sessionToken = stored[STORAGE_KEYS.sessionToken];
  sessionTokenHistory = normalizeTokenHistory(
    stored[STORAGE_KEYS.sessionTokenHistory],
    sessionToken
  );

  const accessToken = tokens?.access_token || (await ensureAccessToken());
  if (!accessToken) {
    setPushError("Couldn't clear Discord presence (not authorized)");
    if (allowRetry) {
      try {
        chrome.alarms.create(ALARM_CLEAR_RETRY, { when: Date.now() + 8000 });
      } catch {
        chrome.alarms.create(ALARM_CLEAR_RETRY, { delayInMinutes: 0.15 });
      }
    }
    return false;
  }

  const result = await forceClearHeadlessPresence(accessToken, { keepalive });
  const ok = Boolean(result?.ok);
  if (!ok) {
    setPushError(result?.error || "Couldn't clear Discord presence");
    if (allowRetry) {
      try {
        chrome.alarms.create(ALARM_CLEAR_RETRY, { when: Date.now() + 5000 });
      } catch {
        chrome.alarms.create(ALARM_CLEAR_RETRY, { delayInMinutes: 0.1 });
      }
    }
    return false;
  }

  try {
    chrome.alarms.clear(ALARM_CLEAR_RETRY);
  } catch { /* ignore */ }
  setPushError(null);
  if (!tokens?.access_token)
    setBadge("off");
  else if (!presenceEnabled)
    setBadge("paused");
  else if (isCurrentTitleMuted())
    setBadge("muted");
  else
    setBadge("on");
  return true;
}

async function clearStaleSessionIfNoMiruro() {
  if (await findMiruroTab())
    return;
  // Don't burn Discord rate limit when we already have nothing to delete.
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.sessionToken,
    STORAGE_KEYS.sessionTokenHistory
  ]);
  const known = normalizeTokenHistory(
    stored[STORAGE_KEYS.sessionTokenHistory],
    stored[STORAGE_KEYS.sessionToken] || sessionToken
  );
  if (!known.length) {
    pageMode = "idle";
    presenceData = null;
    playbackData = null;
    activeTabId = null;
    persistPresenceState();
    return;
  }
  rpcLog("clearing stale Discord session (no Miruro tabs)");
  await clearPresence();
  pageMode = "idle";
  presenceData = null;
  playbackData = null;
  activeTabId = null;
  persistPresenceState();
}

function setBadge(mode) {
  const map = {
    off: { text: "", color: "#666666" },
    auth: { text: "!", color: "#ED4245" },
    on: { text: "✓", color: "#57F287" },
    paused: { text: "–", color: "#99AAB5" },
    muted: { text: "✕", color: "#99AAB5" },
    browse: { text: "…", color: "#FEE75C" },
    watch: { text: "▶", color: "#5865F2" }
  };
  const cfg = map[mode] || map.off;
  chrome.action.setBadgeText({ text: cfg.text });
  chrome.action.setBadgeBackgroundColor({ color: cfg.color });
}

// Last browser window closed — beforeunload often never reaches us.
chrome.windows.onRemoved.addListener(() => {
  chrome.windows.getAll()
    .then((wins) => {
      if (!wins.length)
        return clearPresenceKeepalive();
    })
    .catch(() => {});
});

// Service worker / event page going away.
if (chrome.runtime.onSuspend) {
  chrome.runtime.onSuspend.addListener(() => {
    clearPresenceKeepalive().catch(() => {});
  });
}

hydrate().then(async () => {
  setBadge(tokens?.access_token ? (presenceEnabled ? "on" : "paused") : "off");
  armSessionKeepalive();
  warmAuth();
  // Defer stale clear — first Miruro claim often races this boot path.
  try {
    chrome.alarms.create(ALARM_CLEAR_STALE, { when: Date.now() + 2500 });
  } catch {
    chrome.alarms.create(ALARM_CLEAR_STALE, { delayInMinutes: 0.05 });
  }

  // Android: background often dies during Discord authorize — finish if callback tab is open.
  try {
    const pending = (await chrome.storage.local.get(STORAGE_KEYS.oauthPending))[
      STORAGE_KEYS.oauthPending
    ];
    if (pending?.codeVerifier && !tokens?.access_token) {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (isOAuthCallbackUrl(tab?.url)) {
          await acceptOAuthRedirect(tab.url);
          break;
        }
      }
    }
  } catch {
    /* ignore */
  }
}).catch(() => {});
