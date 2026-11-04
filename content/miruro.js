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

  function getTitle() {
    const candidates = [];

    for (const sel of [
      "h1.anime-title",
      ".anime-title",
      '[class*="_romajiTitle_"]',
      '[class*="infoDesktopTitle"]',
      '[class*="infoMobileTitle"]'
    ]) {
      const text = cleanText(document.querySelector(sel)?.textContent);
      if (text && !isJunkTitle(text) && !isEpisodeHeading(text))
        candidates.push({ text, score: 120 });
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

    for (const link of document.querySelectorAll('a[href*="/info/"]')) {
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

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.text || null;
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

    const images = [...document.querySelectorAll("img")];
    const match = images.find((img) => {
      const src = img.currentSrc || img.src || "";
      const cls = String(img.className || "");
      if (/sideList|banner|avatar/i.test(cls))
        return false;
      return /anilist\.co\/.*\/cover/i.test(src) || /media\/anime\/cover/i.test(src);
    });
    if (match)
      return match.currentSrc || match.src;

    return metaContents("og:image").find((src) => /anilist\.co|\/cover/i.test(src)) || null;
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
    const payload = {
      title,
      episode,
      episodeTitle: getEpisodeTitle(episode),
      cover: getCover(),
      url: watchUrl()
    };

    const local = playback || readMedia(findVideoDeep(document)) || readPlayerClock();
    if (local?.duration) {
      payload.currentTime = local.currentTime;
      payload.duration = local.duration;
      payload.paused = local.paused;
    }

    activeWatchKey = getWatchKey();
    chrome.runtime.sendMessage({ type: "presence", data: payload }).catch(() => {});
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
      chrome.runtime.sendMessage({ type: "browse", tick: true }).catch(() => {});
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
      chrome.runtime.sendMessage({ type: "browse" }).catch(() => {});
      return;
    }

    stopBrowseTicker();
    chrome.runtime.sendMessage({ type: "claim", mode: "watch" }).catch(() => {});
    schedulePresenceWhenReady(null, null);
    // Don't wait on the iframe poll — tab focus must refresh RPC immediately.
    pulsePlayback();
    setTimeout(pulsePlayback, 200);
    setTimeout(pulsePlayback, 700);
  }

  function onVisibility() {
    if (document.visibilityState === "hidden") {
      lastHiddenAt = Date.now();
      return;
    }
    // Short tab flicker — don't thrash presence
    if (Date.now() - lastHiddenAt < 250)
      return;
    claim();
  }

  let boundVideo = null;
  let strmcxEl = null;
  let lastPlaybackTime = 0;
  let lastPaused = null;
  let lastAdvanceAt = 0;
  let hitchActive = false;
  let havePlaybackTime = false;
  let playbackSeq = 0;
  let lastEmbedSeq = 0;
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
    chrome.runtime.sendMessage({
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
    lastAdvanceAt = Date.now();
    havePlaybackTime = true;
    hitchActive = false;
  }

  function ingestPlayback(playback, source, kindHint = "") {
    if (!playback?.duration)
      return;
    if (!isWatchPage())
      return;
    // Forced play/pause/seek must still ship if focus flickered during tab spam.
    if (!isFocused() && !kindHint)
      return;

    const t = playback.currentTime || 0;
    const paused = Boolean(playback.paused);

    if (!havePlaybackTime) {
      notePlayback(playback);
      publishLocalPlayback(playback, source, paused ? "pause" : "play");
      return;
    }

    let kind = kindHint;
    if (!kind) {
      if (lastPaused !== null && paused !== lastPaused)
        kind = paused ? "pause" : "play";
      else {
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
        if (hitchActive) {
          hitchActive = false;
          kind = "resume";
        }
      } else if (paused) {
        hitchActive = false;
        lastPlaybackTime = t;
        lastPaused = true;
      } else if (!hitchActive && source !== "clock" && Date.now() - lastAdvanceAt >= HITCH_MS) {
        hitchActive = true;
        publishLocalPlayback({ ...playback, paused: true }, source, "hitch");
        return;
      }
    }

    if (kind)
      notePlayback(playback);
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

  // Miruro's strmcx player fires these on scrub — HTML seeked often never comes.
  let knownDuration = 0;
  const strmcxHandlers = {
    "strmcx-time-update": (event) => {
      const detail = event.detail || {};
      const currentTime = Number(detail.currentTime);
      const duration = Number(detail.duration);
      let paused;
      if (typeof detail.paused === "boolean")
        paused = detail.paused;
      else if (typeof detail.playing === "boolean")
        paused = !detail.playing;
      else
        paused = lastPaused === true;

      if (Number.isFinite(duration) && duration > 0)
        knownDuration = duration;
      if (!knownDuration)
        return;

      ingestPlayback(
        {
          currentTime: Number.isFinite(currentTime) ? currentTime : lastPlaybackTime,
          duration: knownDuration,
          paused: Boolean(paused)
        },
        "strmcx"
      );
    },
    "strmcx-pause": () => {
      if (!havePlaybackTime || !knownDuration)
        return;
      ingestPlayback(
        { currentTime: lastPlaybackTime, duration: knownDuration, paused: true },
        "strmcx",
        "pause"
      );
    },
    "strmcx-play": () => {
      if (!havePlaybackTime || !knownDuration)
        return;
      ingestPlayback(
        { currentTime: lastPlaybackTime, duration: knownDuration, paused: false },
        "strmcx",
        "play"
      );
    },
    "strmcx-ready": () => {
      if (!knownDuration)
        return;
      ingestPlayback(
        { currentTime: lastPlaybackTime, duration: knownDuration, paused: false },
        "strmcx",
        "play"
      );
    },
    "strmcx-ended": () => {
      if (!havePlaybackTime || !knownDuration)
        return;
      ingestPlayback(
        { currentTime: lastPlaybackTime, duration: knownDuration, paused: true },
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
    if (!isFocused() || !isWatchPage())
      return;

    attachStrmcx(document.querySelector("strmcx-embed"));

    const local = pickLocalPlayback();
    if (!local?.duration)
      return;

    knownDuration = local.duration;
    ingestPlayback(local, local.source || "video");
  }

  // Embed iframe relay (same path the tray userscript used).
  window.addEventListener("message", (event) => {
    if (event.data?.type !== "miruro-rpc-playback")
      return;
    if (!isWatchPage())
      return;
    const currentTime = Number(event.data.currentTime);
    const duration = Number(event.data.duration);
    if (!Number.isFinite(duration) || duration <= 0)
      return;

    const seq = Number(event.data.seq) || 0;
    if (seq && seq <= lastEmbedSeq)
      return;
    if (seq)
      lastEmbedSeq = seq;

    const kind = String(event.data.kind || "");
    ingestPlayback(
      {
        currentTime: Number.isFinite(currentTime) ? currentTime : 0,
        duration,
        paused: Boolean(event.data.paused)
      },
      "embed",
      kind
    );
  });

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
        chrome.runtime.sendMessage({ type: "browse" }).catch(() => {});
      }
      return;
    }

    stopBrowseTicker();
    const nextKey = getWatchKey();
    const sameShow = Boolean(prevKey && prevKey.split("|")[0] === nextKey.split("|")[0]);
    // Don't clear Discord here — wiping the headless session leaves a blank gap
    // until the watch title scrapes. Keep browse (or previous watch) until presence.
    chrome.runtime.sendMessage({ type: "claim", mode: "watch" }).catch(() => {});
    schedulePresenceWhenReady(previousTitle, previousCover, { sameShow });
  });
  navObserver.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("beforeunload", () => {
    stopBrowseTicker();
    chrome.runtime.sendMessage({ type: "leave" }).catch(() => {});
  });

  presenceTimer = setInterval(() => {
    if (isFocused() && isWatchPage())
      sendPresence();
  }, PRESENCE_MS);

  playbackTimer = setInterval(pollPlayback, PLAYBACK_MS);

  claim();
})();
