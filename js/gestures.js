/*
 * gestures.js — hand-gesture control of the sky, layered on top of app.js
 * without touching it. Everything here talks to the sky purely through the
 * public surface app.js already exposes: `window.__sky` (state/draw), mirroring
 * what the pointer handlers in app.js do for drag-to-look / pinch-to-zoom.
 *
 * Gesture vocabulary, one hand only:
 *   - hand offset from center (deadzone joystick) -> look around (facing/pitch)
 *   - fold four fingers (loose fist)                -> pause
 *   - thumb-index pinch, opened or closed fast      -> zoom in / out
 *
 * Look-around and fold are ported from GestureImageControl/index.html, a
 * standalone MediaPipe Hands prototype, unchanged. There used to be a third
 * gesture — a thumb-middle "snap" to select whatever's under a center
 * reticle — but selection isn't needed, so it's been removed entirely along
 * with the reticle and the `Sky.pick`/`select` calls it made.
 *
 * Zoom went through two designs before this one: a continuous pinch-distance-
 * vs-hand-size ratio drifted as the hand neared the camera (webcam lens
 * distortion breaks that normalization at close range), and a five-fingertip
 * "gather to a point" shape turned out to read as a loose fist too often,
 * fighting with the pause gesture. Edge-triggering a plain thumb-index pinch
 * (closed -> open fast, or the reverse) avoids both: it only cares about a
 * fast transition, not absolute distance, and leaves the other three fingers
 * out of it entirely, so it doesn't overlap with a four-finger fold.
 *
 * Off by default. The camera only ever starts when the "Hand control" button
 * is pressed, and is fully torn down when pressed again.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const button = $('gestureBtn');
  const panel = $('gesturePanel');
  const video = $('gestureVideo');
  const overlay = $('gestureOverlay');
  const overlayCtx = overlay.getContext('2d');
  const statusEl = $('gestureStatus');

  // --- tuning -------------------------------------------------------------
  // Mirrors app.js's own clamp ranges (js/app.js: clampPitch/clampFov) — kept
  // here rather than exported so app.js stays untouched; keep in sync if
  // those ranges ever change.
  const PITCH_MIN = -82, PITCH_MAX = 85;
  const FOV_MIN = 25, FOV_MAX = 160;

  const PAN_DEADZONE = 0.12;   // fraction of half-frame-width around center with no effect
  const PAN_RATE = 76.5;       // deg/sec of facing change at full hand deflection (15% slower than the original 90)
  const TILT_RATE = 59.5;      // deg/sec of pitch change at full hand deflection (15% slower than the original 70)

  // Pause: fold the four non-thumb fingers (a loose fist) to freeze the view.
  const FOLD_HOLD_MS = 150;

  // Zoom: thumb-to-index distance, normalized by hand size — small when
  // pinched shut, large when spread open. "Pinched then opened, fast" zooms
  // in; "open then pinched, fast" zooms out. Watch the status line while
  // testing and retune here if it doesn't fire reliably or fires by accident.
  const PINCH_CLOSED_THRESHOLD = 0.35;
  const PINCH_OPEN_THRESHOLD = 1.0;
  const ZOOM_MAX_WINDOW_MS = 500;
  const ZOOM_COOLDOWN_MS = 500;
  const ZOOM_STEP_IN = 0.7;    // fov *= this per zoom-in trigger (matches app.js's own dblclick-to-zoom factor)
  const ZOOM_STEP_OUT = 1 / ZOOM_STEP_IN;

  // If the tracker stalls silently for this long (a known failure mode of the
  // underlying MediaPipe WASM engine after running a while — hands.send()
  // never resolves, so our loop just stops advancing, even though the <video>
  // keeps playing on its own), tear it down and start a fresh one.
  const WATCHDOG_TIMEOUT_MS = 2500;

  let running = false;
  let stream = null;
  let hands = null;
  let rafId = null;
  let watchdogId = null;
  let loopGen = 0;    // bumped on every (re)start so a stuck send() from a
                      // previous generation can't resurrect an orphaned loop
  let lastFrameTime = performance.now();
  let lastResultsAt = performance.now();

  let foldedSince = null;
  let unfoldedSince = performance.now();
  let paused = false;

  let pinchClosedAt = -Infinity;
  let pinchOpenAt = -Infinity;
  let lastZoomAt = -Infinity;

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function clampPitchLocal(a) { return clamp(a, PITCH_MIN, PITCH_MAX); }
  function clampFovLocal(f) { return clamp(f, FOV_MIN, FOV_MAX); }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function applyDeadzone(v) {
    const s = Math.sign(v), a = Math.abs(v);
    if (a < PAN_DEADZONE) return 0;
    return s * (a - PAN_DEADZONE) / (0.5 - PAN_DEADZONE);
  }

  // A finger counts as curled when its tip sits closer to the wrist than its
  // own pip joint does.
  function fingerCurled(lm, tipIdx, pipIdx) {
    return dist(lm[0], lm[tipIdx]) < dist(lm[0], lm[pipIdx]);
  }
  function fourFingersFolded(lm) {
    return fingerCurled(lm, 8, 6) && fingerCurled(lm, 12, 10)
        && fingerCurled(lm, 16, 14) && fingerCurled(lm, 20, 18);
  }

  function zoomStep(sky, factor) {
    sky.state.fov = clampFovLocal(sky.state.fov * factor);
  }

  function onResults(results) {
    lastResultsAt = performance.now(); // tracker is alive, whether or not a hand is visible
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

    const sky = window.__sky;
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
      statusEl.textContent = 'Show one hand to the camera';
      return;
    }

    const lm = results.multiHandLandmarks[0];
    drawConnectors(overlayCtx, lm, HAND_CONNECTIONS, { color: '#4ade80', lineWidth: 2 });
    drawLandmarks(overlayCtx, lm, { color: '#f87171', radius: 2 });

    if (!sky) return; // app.js hasn't booted yet

    // debounced fold detection so one noisy frame doesn't toggle pause
    const folded = fourFingersFolded(lm);
    if (folded) { if (foldedSince === null) foldedSince = now; unfoldedSince = null; }
    else { if (unfoldedSince === null) unfoldedSince = now; foldedSince = null; }
    if (!paused && foldedSince !== null && now - foldedSince > FOLD_HOLD_MS) paused = true;
    if (paused && unfoldedSince !== null && now - unfoldedSince > FOLD_HOLD_MS) paused = false;

    if (paused) {
      statusEl.textContent = '✊ Paused — open your hand to resume';
      return;
    }

    const state = sky.state;
    const handSize = dist(lm[0], lm[9]) || 0.001;

    // look around: hand offset from frame center steers facing/pitch, like a
    // self-centering joystick rather than an absolute cursor position.
    const nx = 1 - lm[9].x; // mirrored to match the mirrored preview
    const ny = lm[9].y;
    const dx = applyDeadzone(nx - 0.5);
    const dy = applyDeadzone(ny - 0.5);
    state.facing = state.targetFacing = state.facing + dx * PAN_RATE * dt;
    state.pitch = state.targetPitch = clampPitchLocal(state.pitch - dy * TILT_RATE * dt);

    // zoom: thumb-index pinch closed then flicked open fast (or the reverse) —
    // a shape transition rather than a continuous distance, so it isn't thrown
    // off by the hand simply being nearer to or further from the camera, and
    // it leaves the other three fingers alone so it can't be mistaken for a fold.
    const pinch = dist(lm[4], lm[8]) / handSize;
    const wasClosedRecently = now - pinchClosedAt < ZOOM_MAX_WINDOW_MS;
    const wasOpenRecently = now - pinchOpenAt < ZOOM_MAX_WINDOW_MS;
    let zoomedThisFrame = false;
    if (pinch < PINCH_CLOSED_THRESHOLD) {
      pinchClosedAt = now;
      if (wasOpenRecently && now - lastZoomAt > ZOOM_COOLDOWN_MS) {
        lastZoomAt = now;
        zoomStep(sky, ZOOM_STEP_OUT);
        zoomedThisFrame = true;
      }
    } else if (pinch > PINCH_OPEN_THRESHOLD) {
      pinchOpenAt = now;
      if (wasClosedRecently && now - lastZoomAt > ZOOM_COOLDOWN_MS) {
        lastZoomAt = now;
        zoomStep(sky, ZOOM_STEP_IN);
        zoomedThisFrame = true;
      }
    }

    sky.draw();

    statusEl.textContent = zoomedThisFrame
      ? `Zoom · ${state.fov.toFixed(0)}° fov`
      : `Looking around · ${state.fov.toFixed(0)}° fov`;
  }

  function createHandTracker() {
    const h = new Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });
    h.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.6,
    });
    h.onResults(onResults);
    return h;
  }

  async function rafLoop(gen) {
    if (!running || gen !== loopGen) return;
    try {
      await hands.send({ image: video });
    } catch (err) {
      // A frame glitch shouldn't kill the whole session — keep looping.
    }
    if (running && gen === loopGen) rafId = requestAnimationFrame(() => rafLoop(gen));
  }

  function armWatchdog() {
    clearInterval(watchdogId);
    watchdogId = setInterval(() => {
      if (running && performance.now() - lastResultsAt > WATCHDOG_TIMEOUT_MS) restartTracker();
    }, 1000);
  }

  // The tracker has gone silent (see WATCHDOG_TIMEOUT_MS above) — replace it
  // with a fresh instance without touching the camera stream or the toggle
  // state, so the visitor doesn't have to notice or do anything.
  function restartTracker() {
    statusEl.textContent = 'Hand tracker stalled — restarting…';
    loopGen += 1; // orphans the stuck send() so it can't resurrect a second loop
    const stale = hands;
    try { stale && stale.close && stale.close(); } catch (err) { /* best effort */ }
    hands = createHandTracker();
    lastResultsAt = performance.now();
    rafLoop(loopGen);
  }

  async function startGestures() {
    if (running) return;
    running = true;
    button.classList.add('on');
    button.setAttribute('aria-pressed', 'true');
    panel.hidden = false;
    statusEl.textContent = 'Loading hand tracker…';
    paused = false;
    foldedSince = null;
    unfoldedSince = performance.now();

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 }, audio: false,
      });
    } catch (err) {
      statusEl.textContent = 'Camera permission needed for hand control.';
      stopGestures();
      return;
    }

    video.srcObject = stream;
    await video.play();

    if (!hands) hands = createHandTracker();

    statusEl.textContent = 'Show one hand to the camera';
    lastFrameTime = performance.now();
    lastResultsAt = performance.now();
    loopGen += 1;
    rafLoop(loopGen);
    armWatchdog();
  }

  function stopGestures() {
    running = false;
    loopGen += 1; // orphans any in-flight send() from this session
    clearInterval(watchdogId);
    watchdogId = null;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    video.pause();
    video.srcObject = null;
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    button.classList.remove('on');
    button.setAttribute('aria-pressed', 'false');
    panel.hidden = true;
  }

  button.addEventListener('click', () => {
    if (running) stopGestures(); else startGestures();
  });
})();
