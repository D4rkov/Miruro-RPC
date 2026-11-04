import { ACTIVITY, API_BASE, CLIENT_ID, FORCE_RELEASE_UI, SCOPES } from "./config.js";

const STORAGE_KEYS = {
  tokens: "tokens",
  user: "user",
  sessionToken: "sessionToken",
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
let lastAuthError = null;
let lastPushError = null;
let authPending = false;
/** @type {Promise<void> | null} */
let loginInFlight = null;

/** Active Miruro tab driving presence */
let activeTabId = null;
let pageMode = "idle"; // idle | browse | watch
/** Master switch — when false, Discord stays clear. */
let presenceEnabled = true;
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
/** embed/video beat strmcx — strmcx lags and fake-seeks after iframe scrubs. */
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
/** Set only by the nav fallback timer so title-only POST is intentional. */
let watchNavAllowTitleOnly = false;
let lastNavAction = "";
let lastNavAt = 0;
const MEDIA_SOURCE_RANK = { embed: 3, video: 2, strmcx: 1, player: 1, clock: 0, presence: 0, unknown: 0 };

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
    shown = snap
      ? `${snap.paused ? "paused" : "playing"} @ ${snap.at}`
      : "cleared";
  }

  const forAction = extra.forAction || pendingUserAction?.action || null;

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

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("tokenRefresh", { periodInMinutes: 20 });
  armSessionKeepalive();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "tokenRefresh") {
    await ensureAccessToken();
    return;
  }
  if (alarm.name === "sessionKeepalive" && pageMode !== "idle") {
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
    onActiveTabGone(tabId).catch((err) => console.warn("onActiveTabGone:", err));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== activeTabId || !changeInfo.url)
    return;
  if (!isMiruroUrl(changeInfo.url))
    onActiveTabGone(tabId).catch((err) => console.warn("onActiveTabGone:", err));
});

/** Tighter keepalive while watching — cold sessions make the next seek pay setup cost. */
function armSessionKeepalive() {
  if (pageMode === "watch")
    chrome.alarms.create("sessionKeepalive", { periodInMinutes: 2 });
  else if (pageMode === "browse")
    chrome.alarms.create("sessionKeepalive", { periodInMinutes: 5 });
  else
    chrome.alarms.clear("sessionKeepalive");
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
  const url = sender?.tab?.url || sender?.url || "";
  if (!url)
    return false;
  // Extension pages (popup) are never Miruro content drivers.
  if (String(url).startsWith("chrome-extension:") || String(url).startsWith("moz-extension:"))
    return false;
  return isMiruroUrl(url);
}

async function handleMessage(message, sender) {
  // Never await storage on the playback hot path — that made rapid seeks feel
  // randomly slow. Token hydrate happens inside push only if memory is cold.
  const fromPage = ["claim", "presence", "playback", "browse", "clear", "leave"].includes(message?.type);
  if (fromPage && !senderIsMiruroTab(sender))
    return { ok: false, error: "ignored non-miruro sender" };

  switch (message?.type) {
    case "getStatus":
      await Promise.all([hydrate({ force: true }), ensureDevBuildFlag()]);
      return {
        ok: true,
        isDevBuild,
        loggedIn: Boolean(tokens?.access_token),
        user,
        redirectUri: chrome.identity.getRedirectURL(),
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
    case "login":
      // Popup closes when the Discord window opens — don't require the
      // message port to stay alive. Popup polls getStatus instead.
      startLogin();
      return { ok: true, pending: true };
    case "logout":
      await logout();
      return { ok: true };
    case "testPresence":
      await ensureDevBuildFlag();
      if (!isDevBuild)
        return { ok: false, error: "dev only" };
      await pushTestPresence();
      return { ok: true, lastPushError };
    case "setPresenceEnabled": {
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
      return onLeave(sender.tab?.id);
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

async function hydrate({ force = false } = {}) {
  if (!force && tokens && user)
    return;
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.tokens,
    STORAGE_KEYS.user,
    STORAGE_KEYS.sessionToken,
    STORAGE_KEYS.authPending,
    STORAGE_KEYS.lastAuthError,
    STORAGE_KEYS.lastPushError,
    STORAGE_KEYS.presenceEnabled,
    STORAGE_KEYS.mutedTitles
  ]);
  tokens = stored[STORAGE_KEYS.tokens] || null;
  user = stored[STORAGE_KEYS.user] || null;
  sessionToken = stored[STORAGE_KEYS.sessionToken] || null;
  authPending = Boolean(stored[STORAGE_KEYS.authPending]);
  lastAuthError = stored[STORAGE_KEYS.lastAuthError] || null;
  lastPushError = stored[STORAGE_KEYS.lastPushError] || null;
  presenceEnabled = stored[STORAGE_KEYS.presenceEnabled] !== false;
  mutedTitles = Array.isArray(stored[STORAGE_KEYS.mutedTitles])
    ? stored[STORAGE_KEYS.mutedTitles].map(normalizeTitleKey).filter(Boolean)
    : [];
  await restorePresenceState();
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

  // Swallow here — popup reads lastAuthError via getStatus
  loginInFlight.catch(() => {});
  return loginInFlight;
}

async function persistAuth() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.tokens]: tokens,
    [STORAGE_KEYS.user]: user,
    [STORAGE_KEYS.sessionToken]: sessionToken
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

async function login() {
  const redirectUri = chrome.identity.getRedirectURL();
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
    responseUrl = await chrome.identity.launchWebAuthFlow({
      url: url.toString(),
      interactive: true
    });
  } catch (err) {
    throw new Error(
      err?.message ||
        "Auth window closed or blocked. Try again and leave the Discord window open until it finishes."
    );
  }

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
  if (!pending?.codeVerifier)
    throw new Error("Missing PKCE verifier — try Connect again");
  if (returnedState !== pending.oauthState)
    throw new Error("OAuth state mismatch — try Connect again");

  const tokenJson = await exchangeCode(
    code,
    pending.codeVerifier,
    pending.redirectUri || redirectUri
  );
  tokens = normalizeTokens(tokenJson);
  user = await fetchUser(tokens.access_token);
  sessionToken = null;
  await persistAuth();
  await chrome.storage.local.remove(STORAGE_KEYS.oauthPending);
  setBadge("on");
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
  await hydrate();
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
  await hydrate();
  if (sessionToken && tokens?.access_token) {
    try {
      await deleteHeadlessSession(tokens.access_token, sessionToken);
    } catch { /* ignore */ }
  }
  tokens = null;
  user = null;
  sessionToken = null;
  activeTabId = null;
  pageMode = "idle";
  presenceData = null;
  playbackData = null;
  lastActivityKey = null;
  await chrome.storage.local.remove([
    STORAGE_KEYS.tokens,
    STORAGE_KEYS.user,
    STORAGE_KEYS.sessionToken
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
  // Watch claim: stay on current presence (usually browse) until presence arrives.
  persistPresenceState();
  return { ok: true };
}

function presenceMetaKey(data) {
  if (!data)
    return "";
  // Title + episode only. Cover/url load a moment later and were wrongly
  // treated as "switch episode", re-POSTing with the previous show's time.
  return JSON.stringify({
    title: String(data.title || "").trim().toLowerCase(),
    episode: Number(data.episode) || 0
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
  const becameWatch = pageMode !== "watch";
  pageMode = "watch";
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
    // Presence scrape often has the focused tab's time already (iframe may be
    // throttled after backgrounding and won't emit a fresh "play").
    const seed = seedPlaybackFromPresence(data);
    if (seed) {
      playbackData = seed;
      lastMediaSource = "video";
      lastMediaSourceAt = Date.now();
    }
    scheduleWatchPlaybackKick(Math.max(0, playbackMuteUntil - Date.now()) + 60);
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
    scheduleWatchPlaybackKick(Math.max(0, playbackMuteUntil - Date.now()) + 60);
    scheduleWatchNavFallback(Math.max(0, playbackMuteUntil - Date.now()) + 1800);
  }, navDelay);

  persistPresenceState();
  return { ok: true };
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
    if (!hasValidPlayback(data) || (MEDIA_SOURCE_RANK[String(data.source || "")] ?? 0) < 2) {
      // Iframe still waking from background throttle — retry, don't give up.
      scheduleWatchPlaybackKick(400);
      return;
    }
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
    if (hasValidPlayback(playbackData) && (MEDIA_SOURCE_RANK[String(playbackData.source || "")] ?? 0) >= 2) {
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
  const isPausePlay = kind === "play" || kind === "pause" || kind === "ended" || kind === "resume";
  let explicitSeek = kind === "seek";

  // During show-switch mute: buffer trusted media from this tab, don't POST.
  // Old iframe play events used to punch through and stamp the wrong time.
  // User scrub is the only early unmute.
  if (Date.now() < playbackMuteUntil) {
    if (rank >= 2 && explicitSeek) {
      playbackMuteUntil = 0;
    } else if (rank >= 2 && next.duration > 1) {
      playbackData = next;
      lastMediaSource = source;
      lastMediaSourceAt = Date.now();
      return { ok: true, ignored: "show-switch-mute" };
    } else {
      return { ok: true, ignored: "show-switch-mute" };
    }
  }

  // While the iframe player is active, ignore strmcx/clock — they keep a stale
  // timeline and emit fake "seek" every time embed jumps (rate-limit death).
  if (
    rank < 2 &&
    trustedRank >= 2 &&
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

  if (rank >= 2) {
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
    rank >= 2 &&
    Number.isFinite(next.duration) &&
    next.duration > 1;

  const forcePush = isPausePlay || explicitSeek || firstPlayback || Boolean(next.force);
  if (!forcePush)
    return { ok: true, skipped: true };

  const actionKind = explicitSeek
    ? "seek"
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

function onBrowse(tabId, tick = false) {
  if (tabId == null)
    return { ok: false };
  activeTabId = tabId;
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
  // Tick = keepalive ping only (no Discord POST). Push once when entering browse.
  if (!tick && (becameBrowse || !lastActivityKey)) {
    logYouNav(becameBrowse ? "browse Miruro" : "browse Miruro (refresh)");
    lastActivityKey = null;
    flushPresence({ urgent: true });
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
  lastActivityKey = snap.lastActivityKey ?? null;
  if (snap.sessionToken)
    sessionToken = snap.sessionToken;

  // Don't resurrect RPC after a restart/suspend if the Miruro tab is gone.
  if (pageMode !== "idle" && !(await isLiveMiruroTab(activeTabId))) {
    activeTabId = null;
    pageMode = "idle";
    presenceData = null;
    playbackData = null;
    browseStart = null;
    lastActivityKey = null;
    lastSentPlayback = null;
    armSessionKeepalive();
    await clearPresence();
    persistPresenceState();
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

async function onActiveTabGone(tabId) {
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
  await clearPresenceState();
}

async function clearPresenceState() {
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

async function onLeave(tabId) {
  if (tabId == null || activeTabId == null || tabId === activeTabId)
    await onActiveTabGone(tabId ?? activeTabId);
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

function flushPresence({ urgent = false } = {}) {
  if (Date.now() < rateLimitUntil) {
    pushQueued = true;
    scheduleRateLimitRetry();
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
    const gap = Date.now() - lastPushAt;
    if (lastPushAt && gap < MIN_POST_GAP_MS) {
      pushQueued = true;
      flushDebounceTimer = setTimeout(() => {
        flushDebounceTimer = null;
        flushPresence({ urgent: true });
      }, MIN_POST_GAP_MS - gap);
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
    // Single POST per entry — if state moves, queue ONE follow-up (no burst).
    let accessToken = null;
    if (tokens?.access_token && Date.now() < (tokens.expires_at || 0))
      accessToken = tokens.access_token;
    else
      accessToken = await ensureAccessToken();

    if (!accessToken) {
      logDiscord(false, playbackData, { error: "no token" });
      setBadge("auth");
      return;
    }

    const snapMode = pageMode;
    const snapPresence = presenceData;
    // Use the YOU-action snapshot so a delayed POST can't turn "pause" into
    // "playing" because the player moved on while we waited for rate/gap.
    // Nav fallback is title-only. Prefer live media when the first watch flush
    // still has a nav pending (deferred POST after mute).
    let snapPlayback = null;
    if (pendingUserAction?.kind === "nav") {
      if (
        snapMode === "watch" &&
        hasValidPlayback(playbackData) &&
        (MEDIA_SOURCE_RANK[String(playbackData.source || "")] ?? 0) >= 2 &&
        Date.now() >= playbackMuteUntil
      ) {
        snapPlayback = playbackSnapshot(playbackData);
      } else if (watchNavAllowTitleOnly) {
        snapPlayback = null;
      } else if (watchAwaitingPlayback) {
        // Accidental flush during switch — wait for kick/fallback.
        return;
      } else {
        snapPlayback = null;
      }
    } else if (pendingUserAction?.snapshot) {
      snapPlayback = pendingUserAction.snapshot;
    } else {
      snapPlayback = playbackSnapshot(playbackData);
    }

    watchNavAllowTitleOnly = false;

    if (snapMode === "idle") {
      await clearPresence();
      logDiscord(true, null, { shown: "cleared", ms: 0 });
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
        supported_platforms: ["desktop"],
        assets: {
          large_image: ACTIVITY.assetUrl || ACTIVITY.assetId,
          large_text: ACTIVITY.browseName
        },
        timestamps: { start: String(browseStart) }
      };
    } else {
      activity = buildWatchActivity(snapPresence, snapPlayback);
      if (!activity)
        return;
    }

    const key = activityKey(activity);
    if (key === lastActivityKey)
      return;

    const startedAt = Date.now();
    const actionIdAtStart = pendingUserAction?.id ?? null;
    const actionAtStart = pendingUserAction?.action || null;

    try {
      const result = await upsertHeadlessSession(accessToken, activity, sessionToken);
      if (result?.token)
        sessionToken = result.token;
      chrome.storage.local.set({ [STORAGE_KEYS.sessionToken]: sessionToken }).catch(() => {});

      lastActivityKey = key;
      lastPushAt = Date.now();
      if (snapMode === "watch" && snapPlayback && snapPlayback.duration > 0) {
        lastSentPlayback = {
          currentTime: snapPlayback.currentTime,
          duration: snapPlayback.duration,
          paused: snapPlayback.paused,
          at: Date.now()
        };
        watchAwaitingPlayback = false;
        watchPlaybackFlushQueued = false;
        clearWatchPlaybackTimers();
      } else if (snapMode === "watch" && pendingUserAction?.kind === "nav") {
        // Title-only fallback — stop waiting so later ticks can update normally.
        watchAwaitingPlayback = false;
        watchPlaybackFlushQueued = false;
      }
      setPushError(null);
      persistPresenceState();
      setBadge(snapMode === "watch" ? "watch" : "browse");

      // If pause→play (or another YOU) landed mid-POST, keep pending and requeue.
      const newerAction =
        pendingUserAction && pendingUserAction.id !== actionIdAtStart;

      if (keepalive && !pendingUserAction) {
        // silent session keepalive
      } else if (snapMode === "browse") {
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
          : `watch ${String(snapPresence?.title || "").slice(0, 32)}`;
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
        // Don't keep a stale "for pause @ 3:45" across the wait — next POST
        // will describe whatever state is current then.
        if (pendingUserAction && Date.now() - pendingUserAction.t > 500)
          pendingUserAction = null;
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
      lastActivityKey = null;
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
    name: ACTIVITY.watchName,
    details,
    state,
    application_id: CLIENT_ID,
    platform: "desktop",
    supported_platforms: ["desktop"],
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
  /(^|\.)(miruro\.cx|anilist\.co|anilistcdn\.com|myanimelist\.net|cdn\.myanimelist\.net|kitsu\.io|media\.kitsu\.io|discordapp\.com|discordapp\.net|discord\.com|imgur\.com|i\.imgur\.com|image\.tmdb\.org|themoviedb\.org|wp\.com|cloudfront\.net|bunnycdn\.com|b-cdn\.net)$/i;

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

function activityKey(activity) {
  return JSON.stringify({
    details: activity.details,
    state: activity.state,
    type: activity.type,
    image: activity.assets?.large_image,
    small: activity.assets?.small_image,
    start: activity.timestamps?.start ?? null,
    end: activity.timestamps?.end ?? null
  });
}

async function upsertHeadlessSession(accessToken, activity, token) {
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
    // Token may be stale — drop and retry once without it
    if (token && (res.status === 400 || res.status === 404)) {
      sessionToken = null;
      return upsertHeadlessSession(accessToken, activity, null);
    }
    throw new Error(msg);
  }

  return json;
}

async function deleteHeadlessSession(accessToken, token, { keepalive = false } = {}) {
  await fetch(`${API_BASE}/users/@me/headless-sessions/delete`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ token }),
    keepalive
  });
}

/** Best-effort clear during browser quit — keepalive so the request can outlive the SW. */
async function clearPresenceKeepalive() {
  const accessToken = tokens?.access_token || null;
  const token = sessionToken;
  if (!accessToken || !token)
    return;
  sessionToken = null;
  lastActivityKey = null;
  pageMode = "idle";
  presenceData = null;
  playbackData = null;
  activeTabId = null;
  try {
    chrome.storage.local.set({
      [STORAGE_KEYS.sessionToken]: null,
      [STORAGE_KEYS.presenceState]: null
    });
  } catch { /* ignore */ }
  try {
    await deleteHeadlessSession(accessToken, token, { keepalive: true });
  } catch (err) {
    console.warn("clearPresenceKeepalive:", err);
  }
}

async function clearPresence() {
  const accessToken = await ensureAccessToken();
  if (accessToken && sessionToken) {
    try {
      await deleteHeadlessSession(accessToken, sessionToken);
    } catch (err) {
      console.warn("clearPresence:", err);
    }
  }
  sessionToken = null;
  lastActivityKey = null;
  await chrome.storage.local.set({ [STORAGE_KEYS.sessionToken]: null });
  if (!tokens?.access_token)
    setBadge("off");
  else if (!presenceEnabled)
    setBadge("paused");
  else if (isCurrentTitleMuted())
    setBadge("muted");
  else
    setBadge("on");
}

async function clearStaleSessionIfNoMiruro() {
  if (!sessionToken)
    return;
  if (await findMiruroTab())
    return;
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
  // Browser kill / crash often skips leave — drop leftover headless RPC on boot.
  await clearStaleSessionIfNoMiruro();
}).catch(() => {});
