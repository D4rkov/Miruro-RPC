(() => {
  "use strict";

  if (window !== window.top)
    return;
  if (!/(^|\.)miruro\.cx$/i.test(location.hostname))
    return;

  const PRESENCE_MS = 5000;
  const PLAYBACK_MS = 250;
  const BROWSE_MS = 60000;
  const HITCH_MS = 8000;
  /** strmcx often skips pause events — treat frozen time as pause. */
  const STALL_PAUSE_MS = 900;
  /** Once we know we're paused, ignore strmcx "playing" ticks until a real play. */
  let stickyPaused = false;

  let presenceTimer = null;
  let playbackTimer = null;
  let browseTimer = null;
  let presenceWaitTimer = null;
  let lastHiddenAt = 0;
  let activeWatchKey = null;

  function isWatchPage() {
    return location.pathname.startsWith("/watch");
  }

  function isFocused() {
    return document.visibilityState === "visible";
  }

  /** Cold event pages often miss the first message — retry briefly. */
  function sendBg(message) {
    const attempt = (left) =>
      chrome.runtime.sendMessage(message).catch((err) => {
        if (left <= 0)
          throw err;
        return new Promise((resolve) => setTimeout(resolve, 250)).then(() =>
          attempt(left - 1)
        );
      });
    return attempt(4).catch(() => {});
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isJunkTitle(text) {
    if (!text || text.length < 2)
      return true;
    return (
      /^miruro\b/i.test(text) ||
      /watch anime online/i.test(text) ||
      /^free anime streaming/i.test(text) ||
      /^watching\b/i.test(text) ||
      /^episode\s+\d+\b/i.test(text) ||
      /^ep\s*\d+\b/i.test(text) ||
      /^(details|home|trending|schedule|history|profile|search|discover)$/i.test(text)
    );
  }

  function isEpisodeHeading(text) {
    return (
      /^\d+\.\s+\S+/.test(text) ||
      /^Episode\s+\d+\b/i.test(text) ||
      /^Ep\s*\d+\b/i.test(text)
    );
  }

  function metaContents(property) {
    return [...document.querySelectorAll(`meta[property="${property}"]`)]
      .map((node) => cleanText(node.getAttribute("content")))
      .filter(Boolean);
  }

  const EPISODE_CHROME_RE =
    /\b(AUDIO|SERVER|SUB|DUB|HD|FHD|AUTO|QUALITY|SOURCE|CC|SUBTITLES?)\b/i;

  function ownText(node) {
    if (!node)
      return "";
    let text = "";
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE)
        text += child.textContent;
    }
    return cleanText(text);
  }

  function scrubEpisodeTitle(text) {
    let value = cleanText(text);
    if (!value)
      return null;
    value = value.replace(
      /(?:AUDIO|SERVER|SUB|DUB|HD|FHD|AUTO|QUALITY|SOURCE|CC|SUBTITLES?).*$/i,
      ""
    );
    value = value.replace(/[\s·|/\-–—]+$/g, "").replace(/\(\d+\)\s*$/g, "").trim();
    value = value.replace(/\.+$/g, "").trim();
    if (!value || value.length < 2 || EPISODE_CHROME_RE.test(value))
      return null;
    return value;
  }

  function collectTitleCandidates() {
    const candidates = [];

    for (const sel of [
      "h1.anime-title",
      ".anime-title",
      '[class*="_romajiTitle_"]',
      '[class*="_englishTitle_"]',
      '[class*="_nativeTitle_"]',
      '[class*="infoDesktopTitle"]',
      '[class*="infoMobileTitle"]'
    ]) {
      for (const node of document.querySelectorAll(sel)) {
        const text = cleanText(node.textContent);
        if (text && !isJunkTitle(text) && !isEpisodeHeading(text))
          candidates.push({ text, score: 120 });
      }
    }

    for (const node of document.querySelectorAll(".watch-controls h2")) {
      const text = cleanText(node.textContent);
      if (text && !isJunkTitle(text) && !isEpisodeHeading(text) && text.length < 120)
        candidates.push({ text, score: 110 });
    }

    const cover = document.querySelector(
      'img[class*="_coverImg_"], img[class*="coverImg"], img[class*="_cover"]'
    );
    if (cover) {
      const card = cover.closest("div, article, section, aside") || cover.parentElement;
      const heading = card?.querySelector("a[href*='/info/'], h1.anime-title, .anime-title, h2");
      const text = cleanText(heading?.textContent);
      if (text && !isJunkTitle(text) && !isEpisodeHeading(text))
        candidates.push({ text, score: 100 });
    }

    // Only watch-panel / cover-card info links — never sidebar recommendations
    // (those were poisoning presence with One Piece / Naruto / etc.).
    for (const link of document.querySelectorAll(
      ".watch-controls a[href*='/info/'], [class*='_cover'] a[href*='/info/'], a[href*='/info/'][class*='title']"
    )) {
      if (link.closest('[class*="sideList"], [class*="SideList"], aside, [class*="recommend"], [class*="trending"]'))
        continue;
      const aria = cleanText(link.getAttribute("aria-label") || "").replace(/^About\s+/i, "");
      const text = cleanText(link.textContent) || aria;
      if (text && !isJunkTitle(text) && !isEpisodeHeading(text) && text.length < 120)
        candidates.push({ text, score: 40 });
    }

    for (const og of metaContents("og:title")) {
      const fromOg = cleanText(
        og.replace(/^Watch\s+/i, "").replace(/\s*[|\-–—]\s*Miruro.*$/i, "")
      );
      if (fromOg && !isJunkTitle(fromOg) && !isEpisodeHeading(fromOg))
        candidates.push({ text: fromOg, score: 30 });
    }

    const tab = cleanText(document.title)
      .replace(/^Watch\s+/i, "")
      .replace(/\s*[|\-–—]\s*Miruro.*$/i, "")
      .replace(/\s+Episode\s+\d+.*$/i, "")
      .trim();
    if (tab && !isJunkTitle(tab) && !isEpisodeHeading(tab))
      candidates.push({ text: tab, score: 5 });

    candidates.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
    return candidates;
  }

  function getTitle() {
    return collectTitleCandidates()[0]?.text || null;
  }

  function getTitleAlts() {
    const seen = new Set();
    const out = [];
    for (const { text } of collectTitleCandidates()) {
      const key = text.toLowerCase();
      if (seen.has(key))
        continue;
      seen.add(key);
      out.push(text);
      if (out.length >= 8)
        break;
    }
    return out;
  }

  function parseAnilistIdFromUrl(value) {
    const url = String(value || "");
    let m = url.match(
      /\/media\/anime\/cover\/(?:extraLarge|large|medium)\/(?:[a-z]{1,3})?(\d{2,7})-/i
    );
    if (m)
      return Number(m[1]);
    m = url.match(/img\.anili\.st\/media\/(\d{2,7})/i);
    if (m)
      return Number(m[1]);
    m = url.match(/anilist\.co\/(?:anime|manga)\/(\d{2,7})/i);
    return m ? Number(m[1]) : null;
  }

  function getAnilistId() {
    // Only trust the resolved show cover / og:image — never scan the whole
    // page (sidebars are full of One Piece / Naruto / etc. covers).
    const cover = getCover();
    const fromCover = parseAnilistIdFromUrl(cover);
    if (fromCover)
      return fromCover;

    for (const src of metaContents("og:image")) {
      const id = parseAnilistIdFromUrl(src);
      if (id)
        return id;
    }

    return null;
  }

  function getCover() {
    const preferred = document.querySelector(
      'img[class*="_coverImg_"], img[class*="coverImg"]'
    );
    if (preferred?.currentSrc || preferred?.src)
      return preferred.currentSrc || preferred.src;

    const infoCover = document.querySelector(
      ".watch-controls a[href*='/info/'] img, a[href*='/info/'] img[class*='object-cover']"
    );
    if (infoCover?.currentSrc || infoCover?.src)
      return infoCover.currentSrc || infoCover.src;

    // Prefer og:image over "first anilist img on page" — the latter hits sidebars.
    return metaContents("og:image").find((src) => /anilist\.co|\/cover|anili\.st/i.test(src))
      || metaContents("og:image")[0]
      || null;
  }

  function parseEpisodeNumber(text) {
    const value = cleanText(text);
    if (!value)
      return null;
    const m =
      value.match(/^Episode\s+(\d+)\b/i) ||
      value.match(/^Ep\s*(\d+)\b/i) ||
      value.match(/^(\d+)\.\s+\S/);
    if (!m)
      return null;
    const ep = Number(m[1]);
    return Number.isFinite(ep) && ep > 0 ? ep : null;
  }

  function getEpisode() {
    const ep = Number(new URL(location.href).searchParams.get("ep"));
    if (Number.isFinite(ep) && ep > 0)
      return ep;

    for (const node of document.querySelectorAll("h1, .watch-controls span")) {
      const n = parseEpisodeNumber(ownText(node) || node.textContent);
      if (n)
        return n;
    }

    const heading = getEpisodeHeadingText();
    return parseEpisodeNumber(heading) || 1;
  }

  function getEpisodeHeadingText() {
    const nodes = document.querySelectorAll(
      "h1, h2, h3, h4, .watch-controls span, [class*='title']"
    );
    for (const node of nodes) {
      const direct = ownText(node);
      const text = isEpisodeHeading(direct) ? direct : cleanText(node.textContent);
      if (!isEpisodeHeading(text) || text.length >= 160)
        continue;

      const dotted = text.match(/^(\d+)\.\s*(.+)$/);
      if (dotted) {
        const title = scrubEpisodeTitle(dotted[2] || "");
        if (!title)
          continue;
        return `${dotted[1]}. ${title}`;
      }

      const plain = text.match(/^Episode\s+(\d+)\b/i) || text.match(/^Ep\s*(\d+)\b/i);
      if (plain)
        return `Episode ${plain[1]}`;
    }
    return null;
  }

  function getEpisodeTitle(episode) {
    const epTitle = scrubEpisodeTitle(
      document.querySelector(".ep-title, [class*='ep-title'], [class*='epTitle']")?.textContent
    );
    if (epTitle && !isJunkTitle(epTitle))
      return epTitle;

    const heading = getEpisodeHeadingText();
    if (heading) {
      const dotted = heading.match(/^(\d+)\.\s*(.+)$/);
      if (dotted && Number(dotted[1]) === episode)
        return scrubEpisodeTitle(dotted[2]);
    }

    const h1 = document.querySelector(".watch-controls h1, h1");
    const h1Text = scrubEpisodeTitle(ownText(h1) || h1?.textContent || "");
    if (
      h1Text &&
      !isJunkTitle(h1Text) &&
      !isEpisodeHeading(h1Text) &&
      h1Text.toLowerCase() !== getTitle()?.toLowerCase()
    ) {
      return h1Text;
    }

    return null;
  }

  function watchUrl() {
    const url = new URL(location.href);
    url.hash = "";
    return url.toString();
  }

  function getWatchKey() {
    const match = location.pathname.match(/^\/watch\/([^/]+)/);
    const animeId = match?.[1] || location.pathname;
    return `${animeId}|${getEpisode()}`;
  }

  function findVideoDeep(root = document, depth = 0) {
    if (!root || depth > 6)
      return null;
    if (root.querySelector) {
      const direct = root.querySelector("video");
      if (direct)
        return direct;
    }
    const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const el of all) {
      if (el.shadowRoot) {
        const found = findVideoDeep(el.shadowRoot, depth + 1);
        if (found)
          return found;
      }
    }
    return null;
  }

  function readMedia(media) {
    if (!media)
      return null;
    try {
      const currentTime = Number(media.currentTime);
      const duration = Number(media.duration);
      return {
        currentTime: Number.isFinite(currentTime) ? currentTime : null,
        duration: Number.isFinite(duration) && duration > 0 ? duration : null,
        paused: Boolean(media.paused)
      };
    } catch {
      return null;
    }
  }

  function parseClock(value) {
    const parts = String(value).split(":").map(Number);
    if (!parts.length || parts.some((n) => !Number.isFinite(n)))
      return null;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }

  function readPlayerClock() {
    const scopes = [
      document.querySelector("strmcx-embed"),
      document.querySelector(".plyr"),
      document.querySelector('[class*="player"]'),
      document.querySelector('[class*="Player"]')
    ].filter(Boolean);

    const texts = [];
    for (const scope of scopes.length ? scopes : [document]) {
      for (const el of scope.querySelectorAll("span, div, time")) {
        const t = cleanText(el.textContent);
        if (t && t.length <= 20 && /\d+:\d+/.test(t))
          texts.push({ text: t, scope });
      }
    }

    for (const { text, scope } of texts) {
      const m = text.match(/(\d+:\d{2}(?::\d{2})?)\s*\/\s*(\d+:\d{2}(?::\d{2})?)/);
      if (!m)
        continue;
      const currentTime = parseClock(m[1]);
      const duration = parseClock(m[2]);
      if (currentTime == null || duration == null || duration <= 0)
        continue;
      const root = scope || document;
      const paused =
        Boolean(root.querySelector('.plyr--paused, [aria-label="Play"], button[aria-label="Play"]')) &&
        !root.querySelector('.plyr--playing, button[aria-label="Pause"]');
      return { currentTime, duration, paused };
    }
    return null;
  }

  function sendPresence(playback = null) {
    if (!isFocused() || !isWatchPage())
      return;

    const title = getTitle();
    if (!title || isJunkTitle(title))
      return;

    const episode = getEpisode();
    const titles = getTitleAlts();
    const anilistId = getAnilistId();
    const payload = {
      title,
      titles,
      episode,
      episodeTitle: getEpisodeTitle(episode),
      cover: getCover(),
      url: watchUrl()
    };
    if (anilistId)
      payload.anilistId = anilistId;

    const local = playback || readMedia(findVideoDeep(document)) || readPlayerClock();
    if (local?.duration) {
      payload.currentTime = local.currentTime;
      payload.duration = local.duration;
      payload.paused = local.paused;
    }

    activeWatchKey = getWatchKey();
    sendBg({ type: "presence", data: payload }).catch(() => {});
  }

  function cancelPresenceWait() {
    if (presenceWaitTimer) {
      clearTimeout(presenceWaitTimer);
      presenceWaitTimer = null;
    }
  }

  function schedulePresenceWhenReady(previousTitle, previousCover, opts = {}) {
    cancelPresenceWait();
    const expectedKey = getWatchKey();
    const startedAt = Date.now();
    const sameShow = Boolean(opts.sameShow);

    const attempt = () => {
      presenceWaitTimer = null;
      if (!isFocused() || !isWatchPage())
        return;
      if (getWatchKey() !== expectedKey)
        return;

      const title = getTitle();
      const cover = getCover();
      const timedOut = Date.now() - startedAt >= 2500;
      const titleReady = title && !isJunkTitle(title) && title !== previousTitle;
      const coverReady = cover && cover !== previousCover;
      const firstPaint = !previousTitle && title && !isJunkTitle(title);
      const episodeOnlyReady = sameShow && title && !isJunkTitle(title);

      if (firstPaint || titleReady || coverReady || episodeOnlyReady || (timedOut && title && !isJunkTitle(title))) {
        sendPresence();
        return;
      }
      presenceWaitTimer = setTimeout(attempt, 150);
    };

    presenceWaitTimer = setTimeout(attempt, sameShow ? 50 : 100);
  }

  function stopBrowseTicker() {
    if (!browseTimer)
      return;
    clearInterval(browseTimer);
    browseTimer = null;
  }

  function startBrowseTicker() {
    if (browseTimer)
      return;
    // Rare keepalive only — does not POST to Discord.
    browseTimer = setInterval(() => {
      if (!isFocused() || isWatchPage())
        return;
      sendBg({ type: "browse", tick: true }).catch(() => {});
    }, BROWSE_MS);
  }

  /** Immediate play/pause pulse — background embeds are throttled and often
   *  never fire HTML "play" when you return to an already-playing tab. */
  function pulsePlayback() {
    if (!isFocused() || !isWatchPage())
      return;
    const local =
      readMedia(boundVideo) ||
      readMedia(findVideoDeep(document)) ||
      readPlayerClock();
    if (!local?.duration)
      return;
    notePlayback(local);
    publishLocalPlayback(local, local.source || "video", local.paused ? "pause" : "play");
  }

  function claim() {
    if (!isFocused())
      return;

    if (!isWatchPage()) {
      cancelPresenceWait();
      activeWatchKey = null;
      startBrowseTicker();
      sendBg({ type: "browse" });
      return;
    }

    stopBrowseTicker();
    sendBg({ type: "claim", mode: "watch" });
    schedulePresenceWhenReady(null, null);
    // Don't wait on the iframe poll — tab focus must refresh RPC immediately.
    pulsePlayback();
    setTimeout(pulsePlayback, 200);
    setTimeout(pulsePlayback, 700);
  }

  // Background nudges us after cold start / SPA URL changes (popup was a fake fix).
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "resync")
      return;
    claim();
    if (isFocused() && isWatchPage()) {
      sendPresence();
      pulsePlayback();
    }
  });

  function isAndroidUa() {
    return /android/i.test(navigator.userAgent || "");
  }

  function onVisibility() {
    if (document.visibilityState === "hidden") {
      lastHiddenAt = Date.now();
      // Keep the stall timer alive while the user checks Discord — background
      // tabs often stop receiving strmcx ticks even when still "playing".
      if (isWatchPage() && knownDuration && havePlaybackTime && lastPaused !== true)
        armStrmcxWatchdog();
      // Desktop: keep RPC while flipping tabs. Phone: minimize / app-switch
      // must clear — beforeunload often never runs on Android.
      if (isAndroidUa()) {
        stopBrowseTicker();
        sendBg({ type: "leave", reason: "hidden" }).catch(() => {});
      }
      return;
    }
    // Short tab flicker — don't thrash presence
    if (Date.now() - lastHiddenAt < 250)
      return;
    claim();
  }

  function onPageHide() {
    if (!isAndroidUa())
      return;
    stopBrowseTicker();
    sendBg({ type: "leave", reason: "pagehide" }).catch(() => {});
  }

  let boundVideo = null;
  let strmcxEl = null;
  let lastPlaybackTime = 0;
  let lastPaused = null;
  let lastAdvanceAt = 0;
  let hitchActive = false;
  let havePlaybackTime = false;
  let playbackSeq = 0;
  // Must be well above a normal 1s poll advance or every tick becomes "seek".
  const SEEK_DRIFT_S = 2.5;

  let lastPublishAt = 0;

  function publishLocalPlayback(playback, source, kind = "") {
    if (!playback?.duration)
      return;
    const force = Boolean(kind);
    const now = Date.now();
    // Forced events always; quiet ticks rare (Discord animates between POSTs).
    if (!force && now - lastPublishAt < 1000)
      return;
    lastPublishAt = now;
    playbackSeq += 1;
    sendBg({
      type: "playback",
      data: {
        currentTime: playback.currentTime || 0,
        duration: playback.duration,
        paused: Boolean(playback.paused),
        source,
        kind: kind || "",
        force,
        at: now,
        seq: playbackSeq
      }
    }).catch(() => {});
  }

  function kindFromEvent(type) {
    if (type === "seeked" || type === "seeking")
      return "seek";
    if (type === "play" || type === "playing")
      return "play";
    if (type === "pause" || type === "ended")
      return "pause";
    return "";
  }

  function notePlayback(playback) {
    lastPlaybackTime = playback.currentTime || 0;
    lastPaused = Boolean(playback.paused);
    // Only bump advance clock while actually playing — freeze stall timer on pause.
    if (!playback.paused)
      lastAdvanceAt = Date.now();
    havePlaybackTime = true;
    hitchActive = false;
  }

  function markStickyPaused() {
    stickyPaused = true;
  }

  function clearStickyPaused() {
    stickyPaused = false;
  }

  function readDomPausedHint() {
    const video = findVideoDeep(document);
    if (video && typeof video.paused === "boolean" && video.paused)
      return true;
    // Miruro often has no reachable <video> (cross-origin iframe / closed shadow).
    // Fall back to player chrome: Play visible ⇒ paused, Pause visible ⇒ playing.
    const playBtn = document.querySelector(
      '[aria-label="Play"], button[aria-label="Play"], button[title="Play"], .plyr__control[data-plyr="play"]'
    );
    const pauseBtn = document.querySelector(
      '[aria-label="Pause"], button[aria-label="Pause"], button[title="Pause"], .plyr__control[data-plyr="pause"]'
    );
    if (document.querySelector(".plyr--paused"))
      return true;
    if (document.querySelector(".plyr--playing"))
      return false;
    if (playBtn && !pauseBtn)
      return true;
    if (pauseBtn && !playBtn)
      return false;
    return false;
  }

  function forcePauseFromUi(reason = "ui") {
    if (!knownDuration && !havePlaybackTime)
      return;
    const duration = knownDuration || lastPlaybackTime || 1;
    markStickyPaused();
    ingestPlayback(
      {
        currentTime: havePlaybackTime ? lastPlaybackTime : 0,
        duration,
        paused: true
      },
      "strmcx",
      "pause"
    );
  }

  function forcePlayFromUi(reason = "ui") {
    if (!knownDuration && !havePlaybackTime)
      return;
    const duration = knownDuration || lastPlaybackTime || 1;
    clearStickyPaused();
    ingestPlayback(
      {
        currentTime: havePlaybackTime ? lastPlaybackTime : 0,
        duration,
        paused: false
      },
      "strmcx",
      "play"
    );
  }

  // Capture pause/play when <video> is unreachable — click the control chrome
  // or the player surface (many Miruro builds use icon-only controls).
  document.addEventListener("click", (event) => {
    if (!isWatchPage())
      return;
    const control = event.target?.closest?.(
      "button, [role='button'], .plyr__control, [aria-label], [title]"
    );
    if (control) {
      const label = `${control.getAttribute("aria-label") || ""} ${control.getAttribute("title") || ""} ${control.className || ""}`.toLowerCase();
      if (/\bpause\b/.test(label) || control.getAttribute("data-plyr") === "pause") {
        setTimeout(() => forcePauseFromUi("click-pause"), 30);
        return;
      }
      if (
        (/\bplay\b/.test(label) && !/\bpause\b/.test(label)) ||
        control.getAttribute("data-plyr") === "play"
      ) {
        setTimeout(() => forcePlayFromUi("click-play"), 30);
        return;
      }
    }
    const onPlayer = event.target?.closest?.(
      "strmcx-embed, video, .plyr, .plyr__video-wrapper, [class*='player'], [class*='Player']"
    );
    if (!onPlayer)
      return;
    // Generic player click — re-read DOM after the player toggles.
    setTimeout(() => {
      if (readDomPausedHint())
        forcePauseFromUi("click-player");
      else if (document.querySelector(".plyr--playing") || document.querySelector(
        '[aria-label="Pause"], button[aria-label="Pause"], button[title="Pause"], .plyr__control[data-plyr="pause"]'
      ))
        forcePlayFromUi("click-player");
    }, 80);
  }, true);

  document.addEventListener("keydown", (event) => {
    if (!isWatchPage() || !isFocused())
      return;
    if (event.code !== "Space" && event.key !== "k" && event.key !== "K")
      return;
    const tag = (event.target && event.target.tagName) || "";
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || event.target?.isContentEditable)
      return;
    // Toggle from sticky/DOM hint after the player handles the key.
    setTimeout(() => {
      if (readDomPausedHint() || stickyPaused)
        forcePauseFromUi("key");
      else
        forcePlayFromUi("key");
    }, 40);
  }, true);

  function ingestPlayback(playback, source, kindHint = "") {
    if (!playback?.duration)
      return;
    if (!isWatchPage())
      return;
    // Forced play/pause/seek must still ship if focus flickered during tab spam.
    if (!isFocused() && !kindHint)
      return;

    const t = playback.currentTime || 0;
    let paused = Boolean(playback.paused);
    let kind = kindHint;

    // Explicit play clears sticky pause; everything else can latch pause.
    if (kind === "play" || kind === "resume")
      clearStickyPaused();
    else if (kind === "pause" || kind === "ended" || kind === "hitch")
      markStickyPaused();

    // Prefer real DOM/video pause over lying strmcx "playing" ticks.
    if (!kind && readDomPausedHint()) {
      paused = true;
      kind = lastPaused === true ? "" : "pause";
      markStickyPaused();
    }
    if (stickyPaused && kind !== "play" && kind !== "resume" && kind !== "seek") {
      paused = true;
      if (lastPaused !== true)
        kind = kind || "pause";
    }

    playback = { ...playback, paused: Boolean(paused) };

    if (!havePlaybackTime) {
      notePlayback(playback);
      publishLocalPlayback(playback, source, paused ? "pause" : "play");
      return;
    }

    if (!kind) {
      if (lastPaused !== null && paused !== lastPaused)
        kind = paused ? "pause" : "play";
      else if (
        !paused &&
        lastPaused !== true &&
        Math.abs(t - lastPlaybackTime) < 0.12 &&
        Date.now() - lastAdvanceAt >= STALL_PAUSE_MS
      ) {
        // strmcx/video often omit pause events; frozen clock = user paused.
        paused = true;
        playback = { ...playback, paused: true };
        kind = "pause";
        markStickyPaused();
      } else {
        // Compare to wall-clock expectation — a ~1s advance while playing is
        // NOT a seek (that bug labeled every tick "seek" in the debug logs).
        const elapsed = (Date.now() - lastAdvanceAt) / 1000;
        const expected = lastPaused
          ? lastPlaybackTime
          : lastPlaybackTime + Math.max(0, elapsed);
        const drift = Math.abs(t - expected);
        if (drift > SEEK_DRIFT_S)
          kind = "seek";
      }
    }

    if (!kind) {
      if (!paused && Math.abs(t - lastPlaybackTime) >= 0.12) {
        lastPlaybackTime = t;
        lastPaused = false;
        lastAdvanceAt = Date.now();
        clearStickyPaused();
        if (hitchActive) {
          hitchActive = false;
          kind = "resume";
        }
      } else if (paused) {
        hitchActive = false;
        // Don't follow ghost time advances while paused.
        lastPaused = true;
        markStickyPaused();
      } else if (!hitchActive && source !== "clock" && Date.now() - lastAdvanceAt >= HITCH_MS) {
        hitchActive = true;
        markStickyPaused();
        publishLocalPlayback({ ...playback, paused: true }, source, "pause");
        return;
      }
    }

    if (kind === "pause" || kind === "ended" || kind === "hitch")
      markStickyPaused();
    if (kind === "play" || kind === "resume")
      clearStickyPaused();

    if (kind)
      notePlayback(playback);
    else if (paused) {
      lastPaused = true;
      havePlaybackTime = true;
    }
    // Always tick — background decides whether Discord needs a POST
    // (pause flip or position drift), same as the tray bridge.
    publishLocalPlayback(playback, source, kind);
  }

  function onLocalVideoEvent(event) {
    if (!isWatchPage())
      return;
    const kind = kindFromEvent(event?.type || "");
    if (!kind)
      return;

    if (kind === "seek") {
      const publish = () => {
        const playback = readMedia(boundVideo);
        if (playback)
          ingestPlayback(playback, "video", "seek");
      };
      if (event.type === "seeking") {
        publish();
        return;
      }
      requestAnimationFrame(publish);
      return;
    }

    const playback = readMedia(boundVideo);
    if (playback)
      ingestPlayback(playback, "video", kind);
  }

  function bindLocalVideo(video) {
    if (!video || video === boundVideo)
      return;
    if (boundVideo) {
      for (const ev of ["play", "playing", "pause", "seeking", "seeked", "ended"])
        boundVideo.removeEventListener(ev, onLocalVideoEvent);
    }
    boundVideo = video;
    for (const ev of ["play", "playing", "pause", "seeking", "seeked", "ended"])
      video.addEventListener(ev, onLocalVideoEvent);
  }

  // Miruro's strmcx player: time-update ~1Hz while playing; updates STOP on
  // pause (no strmcx-pause, no <video>). Gap must be >> 1s or we false-pause
  // between heartbeats (play/pause spam → Discord 429).
  let knownDuration = 0;
  let strmcxWatchdogTimer = null;
  let strmcxResumeBeats = 0;
  const STRMCX_PAUSE_GAP_MS = 2800;
  const STRMCX_RESUME_BEATS = 2;

  function clearStrmcxWatchdog() {
    if (strmcxWatchdogTimer) {
      clearTimeout(strmcxWatchdogTimer);
      strmcxWatchdogTimer = null;
    }
  }

  function publishWatchdogPause(reason = "watchdog") {
    if (!isWatchPage())
      return;
    if (stickyPaused && lastPaused === true)
      return;
    if (!havePlaybackTime || !knownDuration)
      return;
    // Heartbeat stopped ⇒ paused. Do NOT require tab focus — users often
    // alt-tab to Discord to check RPC, which used to cancel this path.
    strmcxResumeBeats = 0;
    markStickyPaused();
    ingestPlayback(
      {
        currentTime: lastPlaybackTime,
        duration: knownDuration,
        paused: true
      },
      "strmcx",
      "pause"
    );
  }

  function armStrmcxWatchdog() {
    clearStrmcxWatchdog();
    if (!isWatchPage() || !knownDuration)
      return;
    strmcxWatchdogTimer = setTimeout(() => {
      strmcxWatchdogTimer = null;
      publishWatchdogPause("strmcx-gap");
    }, STRMCX_PAUSE_GAP_MS);
  }

  const strmcxHandlers = {
    "strmcx-time-update": (event) => {
      const detail = event.detail || {};
      const currentTime = Number(detail.currentTime);
      const duration = Number(detail.duration);

      if (Number.isFinite(duration) && duration > 0)
        knownDuration = duration;
      if (!knownDuration)
        return;

      const t = Number.isFinite(currentTime) ? currentTime : lastPlaybackTime;
      armStrmcxWatchdog();

      // After a watchdog pause, require a couple beats before "play" so a
      // single late tick doesn't flap.
      if (stickyPaused || lastPaused === true) {
        strmcxResumeBeats += 1;
        if (strmcxResumeBeats < STRMCX_RESUME_BEATS) {
          ingestPlayback(
            {
              currentTime: lastPlaybackTime || t,
              duration: knownDuration,
              paused: true
            },
            "strmcx",
            ""
          );
          return;
        }
        clearStickyPaused();
        strmcxResumeBeats = 0;
        ingestPlayback(
          {
            currentTime: t,
            duration: knownDuration,
            paused: false
          },
          "strmcx",
          "play"
        );
        return;
      }

      strmcxResumeBeats = 0;
      let kindHint = "";
      if (
        havePlaybackTime &&
        Math.abs(t - lastPlaybackTime) > SEEK_DRIFT_S
      ) {
        kindHint = "seek";
      }

      ingestPlayback(
        {
          currentTime: t,
          duration: knownDuration,
          paused: false
        },
        "strmcx",
        kindHint
      );
    },
    "strmcx-pause": () => {
      if (!knownDuration)
        return;
      clearStrmcxWatchdog();
      markStickyPaused();
      ingestPlayback(
        {
          currentTime: havePlaybackTime ? lastPlaybackTime : 0,
          duration: knownDuration,
          paused: true
        },
        "strmcx",
        "pause"
      );
    },
    "strmcx-play": () => {
      if (!knownDuration)
        return;
      clearStickyPaused();
      strmcxResumeBeats = 0;
      armStrmcxWatchdog();
      ingestPlayback(
        {
          currentTime: havePlaybackTime ? lastPlaybackTime : 0,
          duration: knownDuration,
          paused: false
        },
        "strmcx",
        "play"
      );
    },
    "strmcx-ready": () => {
      if (!knownDuration)
        return;
      clearStickyPaused();
      strmcxResumeBeats = 0;
      armStrmcxWatchdog();
      ingestPlayback(
        {
          currentTime: havePlaybackTime ? lastPlaybackTime : 0,
          duration: knownDuration,
          paused: false
        },
        "strmcx",
        "play"
      );
    },
    "strmcx-ended": () => {
      if (!knownDuration)
        return;
      clearStrmcxWatchdog();
      strmcxResumeBeats = 0;
      markStickyPaused();
      ingestPlayback(
        {
          currentTime: havePlaybackTime ? lastPlaybackTime : 0,
          duration: knownDuration,
          paused: true
        },
        "strmcx",
        "pause"
      );
    }
  };

  function attachStrmcx(el) {
    if (el === strmcxEl)
      return;
    if (strmcxEl) {
      for (const [name, handler] of Object.entries(strmcxHandlers))
        strmcxEl.removeEventListener(name, handler, true);
    }
    strmcxEl = el;
    if (!el)
      return;
    for (const [name, handler] of Object.entries(strmcxHandlers))
      el.addEventListener(name, handler, true);
  }

  for (const [name, handler] of Object.entries(strmcxHandlers))
    document.addEventListener(name, handler, true);

  function pickLocalPlayback() {
    const el = findVideoDeep(document);
    bindLocalVideo(el);
    const video = readMedia(el);
    const clock = readPlayerClock();

    if (video?.duration)
      knownDuration = video.duration;
    else if (clock?.duration)
      knownDuration = clock.duration;

    // Progress-bar scrubs often update the visible clock before <video>.currentTime.
    if (video && clock && havePlaybackTime) {
      const vJump = Math.abs((video.currentTime || 0) - lastPlaybackTime);
      const cJump = Math.abs((clock.currentTime || 0) - lastPlaybackTime);
      if (cJump > SEEK_DRIFT_S && cJump > vJump + 0.4) {
        return {
          currentTime: clock.currentTime,
          duration: clock.duration || video.duration,
          paused: Boolean(video.paused),
          source: "player"
        };
      }
    }

    if (video)
      return { ...video, source: "video" };
    if (clock)
      return { ...clock, source: "player" };
    return null;
  }

  function pollPlayback() {
    if (!isWatchPage())
      return;

    // Hidden tab: still detect pause from a stalled clock (strmcx stops ticking).
    if (!isFocused()) {
      if (
        knownDuration &&
        havePlaybackTime &&
        lastPaused !== true &&
        Date.now() - lastAdvanceAt >= STRMCX_PAUSE_GAP_MS
      ) {
        publishWatchdogPause("hidden-stall");
      }
      return;
    }

    attachStrmcx(document.querySelector("strmcx-embed"));

    const local = pickLocalPlayback();
    if (!local?.duration)
      return;

    knownDuration = local.duration;
    const domPaused = readDomPausedHint() || Boolean(local.paused);
    const kindHint = domPaused && lastPaused !== true
      ? "pause"
      : (!domPaused && stickyPaused && lastPaused === true ? "" : "");
    if (domPaused)
      markStickyPaused();
    ingestPlayback(
      { ...local, paused: domPaused || stickyPaused },
      local.source || "video",
      kindHint
    );
  }

  // SPA navigations
  let lastHref = location.href;
  const navObserver = new MutationObserver(() => {
    if (location.href === lastHref)
      return;
    const prevKey = activeWatchKey;
    const previousTitle = getTitle();
    const previousCover = getCover();
    lastHref = location.href;

    if (!isWatchPage()) {
      cancelPresenceWait();
      activeWatchKey = null;
      if (isFocused()) {
        startBrowseTicker();
        sendBg({ type: "browse" }).catch(() => {});
      }
      return;
    }

    stopBrowseTicker();
    clearStrmcxWatchdog();
    stickyPaused = false;
    strmcxResumeBeats = 0;
    lastPaused = null;
    havePlaybackTime = false;
    const nextKey = getWatchKey();
    const sameShow = Boolean(prevKey && prevKey.split("|")[0] === nextKey.split("|")[0]);
    // Don't clear Discord here — wiping the headless session leaves a blank gap
    // until the watch title scrapes. Keep browse (or previous watch) until presence.
    sendBg({ type: "claim", mode: "watch" }).catch(() => {});
    schedulePresenceWhenReady(previousTitle, previousCover, { sameShow });
  });
  navObserver.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("freeze", onPageHide);
  window.addEventListener("beforeunload", () => {
    stopBrowseTicker();
    // Always pagehide-style — keepalive delete must outlive this tab dying.
    sendBg({ type: "leave", reason: "pagehide" }).catch(() => {});
  });

  presenceTimer = setInterval(() => {
    if (isFocused() && isWatchPage())
      sendPresence();
  }, PRESENCE_MS);

  playbackTimer = setInterval(pollPlayback, PLAYBACK_MS);

  claim();
})();
