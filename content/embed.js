(() => {
  "use strict";

  if (window === window.top)
    return;

  const POLL_MS = 500;
  const SEEK_DRIFT_S = 2.5;
  const HITCH_MS = 8000;
  let boundVideo = null;
  let lastTime = 0;
  let lastPaused = null;
  let lastAdvanceAt = 0;
  let hitchActive = false;
  let haveTime = false;
  let seq = 0;
  let lastPublishAt = 0;

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
      if (!Number.isFinite(duration) || duration <= 0)
        return null;
      return {
        currentTime: Number.isFinite(currentTime) ? currentTime : 0,
        duration,
        paused: Boolean(media.paused),
        source: "embed"
      };
    } catch {
      return null;
    }
  }

  function publish(playback, kind = "") {
    if (!playback)
      return;
    const force = Boolean(kind);
    const now = Date.now();
    if (!force && now - lastPublishAt < 1000)
      return;
    lastPublishAt = now;
    seq += 1;
    const data = {
      ...playback,
      kind: kind || "",
      force,
      at: now,
      seq
    };

    // Single path only — dual runtime+postMessage doubled every tick.
    try {
      chrome.runtime.sendMessage({ type: "playback", data });
    } catch { /* ignore */ }
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
    lastTime = playback.currentTime;
    lastPaused = Boolean(playback.paused);
    lastAdvanceAt = Date.now();
    hitchActive = false;
    haveTime = true;
  }

  function onVideoEvent(event) {
    const kind = kindFromEvent(event?.type || "");
    if (!kind)
      return;

    const send = () => {
      const playback = readMedia(boundVideo);
      if (!playback)
        return;
      notePlayback(playback);
      publish(playback, kind);
    };

    if (kind === "seek" && event.type === "seeked") {
      requestAnimationFrame(send);
      return;
    }
    send();
  }

  function bindVideo(video) {
    if (!video || video === boundVideo)
      return;
    if (boundVideo) {
      for (const ev of ["play", "playing", "pause", "seeking", "seeked", "ended"])
        boundVideo.removeEventListener(ev, onVideoEvent);
    }
    boundVideo = video;
    for (const ev of ["play", "playing", "pause", "seeking", "seeked", "ended"])
      video.addEventListener(ev, onVideoEvent);
    const playback = readMedia(video);
    if (playback) {
      notePlayback(playback);
      publish(playback, playback.paused ? "pause" : "play");
    }
  }

  function pulse() {
    bindVideo(findVideoDeep(document));
    const playback = readMedia(boundVideo);
    if (!playback)
      return;
    notePlayback(playback);
    publish(playback, playback.paused ? "pause" : "play");
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      pulse();
      setTimeout(pulse, 250);
    }
  });

  setInterval(() => {
    bindVideo(findVideoDeep(document));
    const playback = readMedia(boundVideo);
    if (!playback)
      return;

    const t = playback.currentTime;
    if (!haveTime) {
      notePlayback(playback);
      publish(playback, playback.paused ? "pause" : "play");
      return;
    }

    let kind = "";
    if (lastPaused !== null && Boolean(playback.paused) !== lastPaused)
      kind = playback.paused ? "pause" : "play";
    else {
      const elapsed = (Date.now() - lastAdvanceAt) / 1000;
      const expected = playback.paused ? lastTime : lastTime + Math.max(0, elapsed);
      const drift = Math.abs(t - expected);
      if (drift > SEEK_DRIFT_S)
        kind = "seek";
    }

    if (kind) {
      notePlayback(playback);
      publish(playback, kind);
      return;
    }

    if (playback.paused) {
      hitchActive = false;
      lastTime = t;
      lastPaused = true;
      publish(playback);
      return;
    }

    if (Math.abs(t - lastTime) >= 0.12) {
      lastTime = t;
      lastPaused = false;
      lastAdvanceAt = Date.now();
      if (hitchActive) {
        hitchActive = false;
        publish(playback, "resume");
        return;
      }
    } else if (!hitchActive && Date.now() - lastAdvanceAt >= HITCH_MS) {
      hitchActive = true;
      publish({ ...playback, paused: true }, "hitch");
      return;
    }

    publish(playback);
  }, POLL_MS);
})();
