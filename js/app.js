/*
 * app.js — state, interaction and the plain-language layer.
 *
 * The astronomy underneath is exact (see astro.js), but nothing on screen is
 * expressed in degrees or hour angles. Positions become "high in the south-east",
 * sky quality becomes "a village garden", and the sky itself does the explaining.
 *
 * A view can be injected through the URL, which is also how to test it:
 *   ?t=2026-09-10T22:30   wall clock in the active zone (append Z for UTC)
 *   ?lat=45.695&lon=9.670 observer position
 *   ?tz=Europe/Rome       IANA time zone
 *   ?facing=180           compass direction to look towards
 */
(() => {
  'use strict';

  const BERGAMO = { lat: 45.695, lon: 9.670, tz: 'Europe/Rome', name: 'Bergamo, Italy' };
  const $ = (id) => document.getElementById(id);

  /*
   * The scene sequence. Nothing here is built yet: this is the running order and the
   * brief for each step, so the switcher below has something to switch between and
   * each scene has one obvious place to be implemented. Every scene currently draws
   * the ordinary sky; `intent` is the note to design against.
   */
  const SCENES = [
    { id: 0, label: 'Sky',       title: 'Open sky',
      intent: 'Backdrop video with the star overlay on top, and a slight motion. Where it already is.' },
    { id: 1, label: 'Zodiacs',   title: 'About the zodiacs',
      intent: 'Information about the zodiacs appears over the visuals, which keep playing underneath.' },
    { id: 2, label: 'Birthdate', title: 'Ask the birthdate',
      intent: 'Slow transition to "ready to know your zodiac?" then "let\u2019s hear your birthdate".' },
    { id: 3, label: 'Card',      title: 'Lift the card',
      intent: '"The universe now has your zodiac." Then "pull up the card \u20182\u2019 from the plate and lift it towards the universe."' },
    { id: 4, label: 'Reveal',    title: 'You are a Gemini',
      intent: 'The video zooms in on the detected zodiac and holds it highlighted on screen: "you are a Gemini", plus two traits.' },
    { id: 5, label: 'Gestures',  title: 'Three directions',
      intent: 'Slow transition to three directions with gesture visuals: "interested to explore what stars have to tell about your interests? make the gestures to explore more."' },
    { id: 6, label: 'Creature',  title: 'The figure moves',
      intent: 'Zoom back in on the constellation while text speaks about it. The figure may take the shape of its animal or creature and move in very slow motion.' },
  ];

  /*
   * Narration. Each scene has a list of clips played one after another, so a scene
   * that says two things says them in order rather than over itself.
   *
   * Scene 4 is not listed because it depends on the sign, and the topic readings
   * (topic_<sign>_<love|work|friendship>.mp3) are not listed because nothing yet
   * chooses a topic — see the note in assets/sounds about what is still unwired.
   */
  const SOUND_DIR = 'assets/sounds/';
  const NARRATION = {
    // Scene 1 welcomes them and then asks whether they are ready. The gate appears
    // when it has finished speaking, and answering is what moves them on.
    1: ['scene-1-welcome.mp3', 'scene-2-ready-ornot.mp3'],
    2: ['scene-2-ask forbday.mp3'],
    5: ['seq_04_topic_offer.mp3', 'seq_05_explore_intro.mp3'],
    6: ['seq_06_outro.mp3'],
  };

  // What counts as saying yes. Kept loose because people answer a question like
  // this with whatever comes out, and a gate that only accepts one word is a gate
  // that strands them.
  const AFFIRMATIVES = [
    'hell yeah', 'hell yes', 'yes', 'yeah', 'yep', 'yup', 'sure',
    'go on', 'go ahead', 'absolutely', 'of course', 'please', 'ok', 'okay',
  ];

  // Scene 4's reveal, per sign. Only five signs have been recorded so far; the
  // rest fall through to silence rather than to the wrong sign's voice.
  const REVEAL_CLIPS = {
    Ari: 'reveal_aries.mp3', Tau: 'reveal_taurus.mp3', Gem: 'reveal_gemini.mp3',
    Cnc: 'reveal_cancer.mp3', Lib: 'reveal_libra.mp3',
  };

  /*
   * Scene 3's shape-pick line, per sign. The recorded set is the same five as the
   * reveals, and the file numbers confirm the mapping: 01-04 are Aries to Cancer
   * and 07 is Libra, i.e. the shape number from the cue table. Listed rather than
   * derived from the number so an unrecorded sign is silent instead of a 404.
   */
  const SHAPE_PICK_CLIPS = {
    Ari: 'shape_pick_01.mp3', Tau: 'shape_pick_02.mp3', Gem: 'shape_pick_03.mp3',
    Cnc: 'shape_pick_04.mp3', Lib: 'shape_pick_07.mp3',
  };

  /**
   * The shape number a sign maps to, from the cue table: Aries is 1 through Pisces
   * is 12. That is exactly the order the Sun travels through them, which is the
   * order ZODIAC_ORDER already holds, so the number is its position rather than a
   * second table to keep in step with the first.
   */
  const shapeNumberFor = (abbrev) => ZODIAC_ORDER.indexOf(abbrev) + 1;

  // Zodiac in the order the Sun travels through them, which is how the signs are
  // always taught — not by brightness or by what happens to be up.
  const ZODIAC_ORDER = ['Ari', 'Tau', 'Gem', 'Cnc', 'Leo', 'Vir',
                        'Lib', 'Sco', 'Sgr', 'Cap', 'Aqr', 'Psc'];
  const CIRCUMPOLAR_ORDER = ['UMa', 'UMi', 'Cas', 'Cep', 'Dra'];

  // Artwork for the scene-1 slideshow, numbered in the same Sun-order as above.
  const ZODIAC_FILES = {
    Ari: '01-aries', Tau: '02-taurus', Gem: '03-gemini', Cnc: '04-cancer',
    Leo: '05-leo', Vir: '06-virgo', Lib: '07-libra', Sco: '08-scorpius',
    Sgr: '09-sagittarius', Cap: '10-capricornus', Aqr: '11-aquarius', Psc: '12-pisces',
  };
  // How long each zodiac holds before the slideshow moves on.
  const ZODIAC_SLIDE_MS = 5000;

  // Tropical zodiac boundaries — western convention, sign holds from the first
  // date to the day before the next sign's first date.
  const ZODIAC_RANGES = [
    ['Cap', [12, 22], [1, 19]], ['Aqr', [1, 20], [2, 18]], ['Psc', [2, 19], [3, 20]],
    ['Ari', [3, 21], [4, 19]], ['Tau', [4, 20], [5, 20]], ['Gem', [5, 21], [6, 20]],
    ['Cnc', [6, 21], [7, 22]], ['Leo', [7, 23], [8, 22]], ['Vir', [8, 23], [9, 22]],
    ['Lib', [9, 23], [10, 22]], ['Sco', [10, 23], [11, 21]], ['Sgr', [11, 22], [12, 21]],
  ];
  function zodiacFromMonthDay(month, day) {
    for (const [abbrev, [m1, d1], [m2, d2]] of ZODIAC_RANGES) {
      if ((month === m1 && day >= d1) || (month === m2 && day <= d2)) return abbrev;
    }
    return null;
  }

  // The three characteristics shown (and spoken) at the scene-4 reveal.
  const ZODIAC_TRAITS = {
    Ari: ['Bold starter', 'Independent', 'A little impatient'],
    Tau: ['Steady', 'Loyal', 'Takes its time deciding'],
    Gem: ['Curious', 'Quick-witted', 'Craves variety'],
    Cnc: ['Nurturing', 'Protective', 'Deeply sentimental'],
    Leo: ['Warm', 'Magnetic', 'Loves the spotlight'],
    Vir: ['Thoughtful', 'Attentive', 'Always a step ahead'],
    Lib: ['Charming', 'Fair-minded', 'Forever weighing options'],
    Sco: ['Intense', 'Loyal', 'Hard to read'],
    Sgr: ['Adventurous', 'Honest', 'Free-spirited'],
    Cap: ['Ambitious', 'Grounded', 'Quietly determined'],
    Aqr: ['Independent', 'Original', 'A little apart'],
    Psc: ['Dreamy', 'Empathetic', 'A little elsewhere'],
  };

  // How dark your sky is, in words. The number is the faintest star the eye catches.
  const SKY_CONDITIONS = [
    { id: 'city',      label: 'City centre',      limit: 2.6, note: 'only the brightest stars push through' },
    { id: 'town',      label: 'Town edge',        limit: 3.4, note: 'the main shapes come out' },
    { id: 'village',   label: 'Village garden',   limit: 4.2, note: 'most naked-eye stars visible' },
    { id: 'dark',      label: 'Dark countryside', limit: 5.2, note: 'the full naked-eye sky' },
  ];

  const state = {
    lat: BERGAMO.lat, lon: BERGAMO.lon, tz: BERGAMO.tz, placeName: BERGAMO.name,
    date: new Date(),
    live: true,
    playing: false,
    playSpeed: 3600,
    facing: 180, pitch: 28, fov: 110,
    targetFacing: 180, targetPitch: 28,
    conditions: 'village',
    magLimit: 4.2,
    showLines: true,
    showLabels: true,
    showStarNames: true,
    showMilkyWay: true,
    showBackdrop: true,
    showGround: true,
    showGlyphs: true,
    showZodiac: true,
    showCircumpolar: true,
    twinkle: true,
    selected: null,
    hovered: null,
    scene: 0,
    showSceneBar: true,
    zodiacIndex: 0,
    birthdateStep: 'ask',
    birthDate: null,
    detectedZodiac: null,
    narration: true,
    // Set from outside (objectTrainer.js) when the camera recognizes a trained
    // object — purely a glow cue, independent of `selected`, so it never forces
    // a turn or opens the story panel the way clicking a constellation does.
    // Distinct from `detectedZodiac` above, which the birthdate-driven scene
    // sequence sets from a typed-in birth date, not the camera.
    detected: null,
  };

  let data = null, frame = null, computed = null;
  let dragging = null;
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) state.twinkle = false;

  // The backdrop footage plays at half speed. Slowing it costs nothing, makes the
  // drift calm enough to sit behind a star chart without pulling the eye, and
  // doubles how long the loop takes to come round — a 72-second clip becomes a
  // two-and-a-half-minute cycle, which is what stops it reading as a short cut.
  const BACKDROP_RATE = 0.5;

  /* --------------------------------------------------------- data loading --- */

  async function loadData() {
    let starsDoc = window.STAR_DATA, consDoc = window.CONSTELLATION_DATA;
    if (!starsDoc || !consDoc) {
      const [a, b] = await Promise.all([
        fetch('data/stars.json').then((r) => r.json()),
        fetch('data/constellations.json').then((r) => r.json()),
      ]);
      starsDoc = a; consDoc = b;
    }
    const conByAbbrev = {};
    for (const c of consDoc.constellations) conByAbbrev[c.abbrev] = c;
    // meta carries the glyph spec (glyphOrder, outer radii, the scale curve).
    return {
      stars: starsDoc.stars,
      constellations: consDoc.constellations,
      conByAbbrev,
      meta: starsDoc.meta || {},
    };
  }

  /* ------------------------------------------------------ sky computation --- */

  function computeSky(date) {
    const jd = Astro.julianDay(date);
    const lstDeg = Astro.lst(jd, state.lon);
    const starAltAz = data.stars.map((s) => Astro.starAltAz(s.ra, s.dec, jd, lstDeg, state.lat));

    const conVisible = {};
    for (const con of data.constellations) {
      const idx = new Set();
      for (const [i, j] of con.lines) { idx.add(i); idx.add(j); }
      let visible = 0, sumAlt = 0, ax = 0, ay = 0, brightest = null;
      // A second centroid over every member star, above the horizon or not, so the
      // view can be pointed at a constellation that has already set.
      let allAlt = 0, allX = 0, allY = 0;
      for (const i of idx) {
        const h = starAltAz[i];
        allAlt += h.alt;
        allX += Math.cos(h.az * Astro.DEG);
        allY += Math.sin(h.az * Astro.DEG);
        if (h.alt >= 0) {
          visible++;
          sumAlt += h.alt;
          ax += Math.cos(h.az * Astro.DEG);
          ay += Math.sin(h.az * Astro.DEG);
        }
        const s = data.stars[i];
        if (h.alt >= 0 && (!brightest || s.m < brightest.m)) brightest = s;
      }
      const n = idx.size || 1;
      conVisible[con.abbrev] = {
        total: idx.size,
        visibleStars: visible,
        fraction: idx.size ? visible / idx.size : 0,
        centroidAlt: visible ? sumAlt / visible : -90,
        centroidAz: visible ? Astro.norm360(Math.atan2(ay, ax) * Astro.RAD) : 0,
        anchorAlt: allAlt / n,
        anchorAz: Astro.norm360(Math.atan2(allY, allX) * Astro.RAD),
        brightestVisible: brightest,
      };
    }

    const sunMoon = Astro.sunMoon(date, jd, lstDeg, state.lat, state.lon);
    const tw = Astro.twilight(sunMoon.sun.alt);
    return {
      jd, lstDeg, starAltAz, conVisible, sunMoon,
      twilight: tw, twilightKey: tw.key,
      astroCtx: { jd, lstDeg, lat: state.lat, lon: state.lon },
    };
  }

  /* -------------------------------------------------- words, not numbers --- */

  const DIR_WORDS = {
    N: 'north', NNE: 'north-north-east', NE: 'north-east', ENE: 'east-north-east',
    E: 'east', ESE: 'east-south-east', SE: 'south-east', SSE: 'south-south-east',
    S: 'south', SSW: 'south-south-west', SW: 'south-west', WSW: 'west-south-west',
    W: 'west', WNW: 'west-north-west', NW: 'north-west', NNW: 'north-north-west',
  };
  const dirWord = (az) => DIR_WORDS[Astro.compassPoint(az)];

  /** Where a constellation sits, said the way you'd say it to someone outside. */
  function placeInSky(v) {
    if (v.visibleStars === 0) {
      return { short: 'below you', long: 'below the horizon right now — look down to find it' };
    }
    const alt = v.centroidAlt, dir = dirWord(v.centroidAz);
    if (alt >= 72) return { short: 'overhead', long: 'almost straight overhead' };
    if (alt >= 52) return { short: `high, ${dir}`, long: `high up towards the ${dir}` };
    if (alt >= 32) return { short: `mid, ${dir}`, long: `about halfway up the ${dir} sky` };
    if (alt >= 14) return { short: `low, ${dir}`, long: `low in the ${dir}` };
    return { short: `rim, ${dir}`, long: `just clearing the horizon in the ${dir}` };
  }

  /** The time of night in ordinary words, from where the Sun actually is. */
  function nightPhrase() {
    const sun = computed.sunMoon.sun;
    const rising = sun.az < 180;      // sun in the eastern half means the day is coming
    if (sun.alt > 6) return 'broad daylight — the stars are there, but washed out';
    if (sun.alt > -0.833) return rising ? 'sunrise' : 'sunset';
    if (sun.alt > -6) return rising ? 'first light' : 'dusk, brightest stars appearing';
    if (sun.alt > -12) return rising ? 'dawn is breaking' : 'the sky is going dark';
    if (sun.alt > -18) return rising ? 'last of the darkness' : 'nearly full darkness';
    return 'full darkness — the best of the night';
  }

  function moonPhrase() {
    const m = computed.sunMoon.moon;
    const pct = Math.round(m.illum * 100);
    const lit = pct < 3 ? 'barely lit' : pct > 97 ? 'full' : `${pct}% lit`;
    if (m.alt < 0) return `${m.phaseName.toLowerCase()} (${lit}), below the horizon — dark skies`;
    const bright = m.illum > 0.55 ? ' — its glare will hide fainter stars' : '';
    return `${m.phaseName.toLowerCase()} (${lit}), ${placeInSky({ visibleStars: 1, centroidAlt: m.alt, centroidAz: m.az }).long}${bright}`;
  }

  /* ------------------------------------------------------------ rendering --- */

  let animClock = 0;
  function draw(dtSeconds = 0) {
    animClock += dtSeconds;
    // The time controls used to overlay the bottom of the sky; now that they live in
    // the panel, the sky is edge to edge and there is nothing to reserve room for.
    state.bottomInset = 0;
    computed = computeSky(state.date);
    if (state.scene < 1 || state.scene > 4) {
      frame = Sky.render($('sky'), state, data, computed,
        { t: animClock, twinkle: state.twinkle });
    }
    renderOverlay();
    renderLists();
    renderSceneBar();
  }

  function fmtClock(date) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: state.tz, hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(date).replace(/\s?([ap])m/i, (_, p) => ` ${p.toLowerCase()}m`);
  }
  const fmtDay = (date) => new Intl.DateTimeFormat('en-GB', {
    timeZone: state.tz, weekday: 'long', day: 'numeric', month: 'long',
  }).format(date);

  function renderOverlay() {
    $('placeName').textContent = state.placeName;
    $('clockText').textContent = fmtClock(state.date);
    $('dayText').textContent = fmtDay(state.date);
    $('nightPhrase').textContent = nightPhrase();
    $('moonPhrase').textContent = moonPhrase();
    $('facingText').textContent = `looking ${dirWord(state.facing)}`;
    const dot = $('liveDot');
    dot.classList.toggle('on', state.live);
    dot.title = state.live
      ? 'Following the real clock'
      : 'Showing a chosen moment — press N, or Now in Explore, for the live sky';
    for (const b of document.querySelectorAll('.cbtn')) {
      const az = Number(b.dataset.az);
      let d = Math.abs(Astro.norm360(state.facing - az));
      if (d > 180) d = 360 - d;
      b.classList.toggle('active', d < 22.5);
    }
  }

  /**
   * The scene switcher. An authoring control rather than part of the experience —
   * it exists so the seven scenes can be stepped through and discussed. Hidden via
   * the toggle under *What you can see* when the sky needs to be clean.
   */
  function renderSceneBar() {
    const bar = $('sceneBar');
    bar.hidden = !state.showSceneBar;
    // Tells the layout whether to leave room along the top, so hiding the switcher
    // closes the gap instead of leaving the readouts pushed down.
    document.body.classList.toggle('has-scene-bar', !!state.showSceneBar);
    if (!state.showSceneBar) return;

    for (const b of bar.querySelectorAll('.scene-pill')) {
      b.classList.toggle('active', Number(b.dataset.scene) === state.scene);
    }
  }

  function setScene(n) {
    const next = Math.max(0, Math.min(SCENES.length - 1, n));
    if (next === state.scene) return;
    state.scene = next;
    renderSceneBar();
    updateSceneVisibility();
    draw();
  }

  /**
   * Entry point for anything outside this file that identifies a zodiac sign
   * on its own — currently js/objectTrainer.js, when the camera recognizes a
   * trained physical shape mapped to one of the twelve. Skips the welcome/
   * birthdate/card scenes entirely and jumps straight to the reveal for that
   * sign, the same as scene 3's own confirmation does once it also reads the
   * camera. `setScene(4)` alone would not be enough here: it no-ops when
   * already on scene 4, so swapping to a different shape while one reveal is
   * already showing would otherwise leave the previous sign's card on screen.
   */
  function revealZodiac(abbrev) {
    if (!ZODIAC_FILES[abbrev]) return;
    // Already showing this sign's reveal — a no-op, not a restart. The camera
    // recognition driving this can flicker near its confidence threshold for a
    // real held object (a little hand movement is enough), which releases and
    // re-locks onto the *same* object; each re-lock used to call this again and
    // restart narration from zero every time, so the clip could never get past
    // its first instant — heard as the audio "clipping" at the start, on
    // repeat. Restarting is still correct when it's a genuinely different sign.
    if (state.scene === 4 && state.detectedZodiac === abbrev) return;
    state.detectedZodiac = abbrev;
    if (state.scene === 4) { renderRevealScene(); startSceneNarration(); draw(); }
    else setScene(4);
  }

  /* ------------------------------------------------------------ narration --- */

  /*
   * A fresh Audio element per clip, played only once it is ready.
   *
   * This used to reuse one element, which caused both of the faults it was meant
   * to avoid. Assigning a new `src` to an element that is still playing runs the
   * media load algorithm, which aborts the previous load and fires an `error` for
   * it — asynchronously, so the *new* clip's error handler received the *old*
   * clip's failure and skipped straight past it. That is why later scenes fell
   * silent: the element had been used, so every clip after the first was liable to
   * be thrown away before it played.
   *
   * Calling play() immediately after setting src caused the other fault. Playback
   * begins as soon as a little data has arrived, which can clip the opening word.
   * Waiting for `canplay` and explicitly seeking to zero fixes that.
   *
   * A separate element per clip also means an aborted or failed clip cannot reach
   * into the one that replaced it: its handlers belong to an object nobody is
   * listening to any more.
   */
  let narrator = null;            // the element currently playing, for stopNarration
  let narrationToken = 0;         // invalidates a scene we have already left
  let narrationArmed = false;

  // Upper bound when a clip never reports its own duration.
  const NARRATION_MAX_CLIP_MS = 20000;
  // Grace beyond a clip's real duration before the watchdog steps in.
  const NARRATION_SLACK_MS = 2500;
  // If neither `canplay` nor `error` arrives, try playing anyway rather than wait.
  const NARRATION_READY_GRACE_MS = 2500;
  // Beat of silence after arriving on a scene before its voice starts, so the
  // visual has a moment to land first rather than talking over its own entrance.
  const NARRATION_START_DELAY_MS = 2000;

  function stopNarration() {
    narrationToken++;
    if (narrator) {
      try { narrator.pause(); } catch { /* already gone */ }
      narrator.onended = null;
      narrator.onerror = null;
      narrator.oncanplaythrough = null;
      narrator.onloadedmetadata = null;
      narrator.src = '';          // release the decoder
      narrator = null;
    }
  }

  /**
   * Play one clip through. Resolves with why it finished — 'ended', 'error',
   * 'blocked' (autoplay refused) or 'timeout' — rather than throwing, so the
   * sequence can decide what to do about each.
   */
  function playClip(clip, token) {
    return new Promise((resolve) => {
      const audio = new Audio();
      audio.preload = 'auto';
      narrator = audio;

      let settled = false;
      let watchdog = null;
      const done = (why) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        audio.onended = audio.onerror = audio.oncanplaythrough = audio.onloadedmetadata = null;
        resolve(why);
      };
      const arm = (ms) => { clearTimeout(watchdog); watchdog = setTimeout(() => done('timeout'), ms); };

      const start = () => {
        if (settled || token !== narrationToken) return;
        // Detached immediately: this event is allowed to fire again later in a
        // normal playback session — after any real stall-and-recover — and
        // leaving this handler attached turned that into an infinite loop.
        // Rewinding to zero invalidates the buffer position it was just about
        // to play from, which fires `waiting`; that resolves instantly for an
        // already-downloaded local file, which fires this event again, which
        // rewound and replayed again — thousands of times a second, with the
        // clip never actually advancing past its first instant. That is the
        // "delay" this caused: not slow, just permanently stuck restarting.
        audio.oncanplaythrough = null;
        // Explicitly from the top: a fresh element should already be at zero, but
        // saying so costs nothing and guarantees the first word is there.
        try { audio.currentTime = 0; } catch { /* not seekable yet, fine */ }
        audio.play().catch(() => done('blocked'));
      };

      audio.onended = () => done('ended');
      audio.onerror = () => done('error');
      // `canplay` — a couple of decoded frames — turned out not to be a strong
      // enough guarantee: playing on it could still start a beat into the clip,
      // clipping the first word. `canplaythrough` (enough buffered to expect no
      // stall before the end) means more of the clip is actually decoded before
      // playback starts, which is what a clean beginning needs. Costs nothing
      // extra here — for a local file both fire within a millisecond of each
      // other — so there's no real tradeoff to switching.
      audio.oncanplaythrough = start;
      audio.onloadedmetadata = () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          arm(audio.duration * 1000 + NARRATION_SLACK_MS);
        }
      };

      arm(NARRATION_MAX_CLIP_MS);
      // encodeURI, because one of the filenames contains a space.
      audio.src = SOUND_DIR + encodeURI(clip);
      audio.load();
      // Belt and braces: if readiness never reports, start it regardless.
      setTimeout(() => { if (!settled && audio.paused) start(); }, NARRATION_READY_GRACE_MS);
    });
  }

  /**
   * Play a list of clips strictly in order, then call `onDone`.
   *
   * Each clip waits for the one before it to finish, so a scene that says two
   * things says them one after the other. `onDone` fires however the sequence
   * ends — including with nothing to play — because whatever waits on the voice
   * (the gate on scene 1, the mic on scene 2) has to happen either way or the
   * visitor is stranded in front of a scene that will not move.
   */
  function playNarration(clips, onDone) {
    stopNarration();
    const finish = () => { if (typeof onDone === 'function') onDone(); };
    if (!state.narration || !clips || !clips.length) { finish(); return; }

    const token = narrationToken;
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, NARRATION_START_DELAY_MS));
      if (token !== narrationToken) return;      // left again during the pause
      for (const clip of clips) {
        if (token !== narrationToken) return;    // scene changed under us
        const why = await playClip(clip, token);
        if (token !== narrationToken) return;
        if (why === 'blocked') { armNarrationOnGesture(clips); break; }
      }
      if (token === narrationToken) finish();
    })();
  }

  /** Retry the scene's narration once the visitor gives us a gesture to work with. */
  function armNarrationOnGesture(clips) {
    if (narrationArmed) return;
    narrationArmed = true;
    const go = () => {
      narrationArmed = false;
      window.removeEventListener('pointerdown', go);
      window.removeEventListener('keydown', go);
      // Only resume if we are still on the scene that asked for these clips.
      const current = narrationClipsFor(state.scene);
      // Compare by contents: narrationClipsFor() returns a fresh array each call,
      // so a reference check here never matched and the retry never happened.
      if (state.narration && current.join('|') === clips.join('|')) playNarration(clips);
    };
    window.addEventListener('pointerdown', go, { once: true });
    window.addEventListener('keydown', go, { once: true });
  }

  /** The clips a scene should speak, resolving scene 4 against the detected sign. */
  let lastNarrationClips = null;
  function narrationClipsFor(scene) {
    // Scenes 3 and 4 depend on the sign, so they are resolved here rather than
    // being listed in NARRATION.
    if (scene === 3 || scene === 4) {
      const abbrev = state.detectedZodiac || ZODIAC_ORDER[0];
      const clip = (scene === 3 ? SHAPE_PICK_CLIPS : REVEAL_CLIPS)[abbrev];
      return clip ? [clip] : [];
    }
    return NARRATION[scene] || [];
  }

  function startSceneNarration() {
    const clips = narrationClipsFor(state.scene);
    lastNarrationClips = clips;
    const scene = state.scene;
    playNarration(clips, () => {
      if (state.scene !== scene) return;         // they moved on while it spoke
      if (scene === 1) revealZodiacGate();
      if (scene === 2) autoListenForBirthdate();
    });
  }

  function revealZodiacGate() {
    $('zodiacGate').hidden = false;
    // Marks the scene so the fact text gets out of the gate's way.
    $('zodiacScene').classList.add('gated');
    startGateListening();
  }
  function hideZodiacGate() {
    $('zodiacGate').hidden = true;
    $('zodiacScene').classList.remove('gated');
    stopGateListening();
  }

  /* ------------------------------------------------- listening at the gate --- */

  /*
   * The mic opens by itself once the question has been asked aloud, so answering
   * out loud works without touching anything. The buttons stay regardless: the
   * browser may refuse the microphone, the visitor may decline it, and a noisy
   * room can defeat recognition entirely — none of which should be a dead end.
   *
   * Structured like startListening() for the birth date: browsers end a session
   * on their own after a pause, so a session counter tells a session we stopped
   * apart from one that ought to reopen the mic.
   */
  let gateRecognizer = null;
  let gateListenSession = 0;

  function setGateHint(text, live) {
    const el = $('zodiacGateHint');
    el.textContent = text || '';
    el.classList.toggle('live', !!live);
    // The pill carries the state; the line underneath carries anything extra
    // worth saying, like a blocked microphone or what was heard.
    const mic = $('zodiacGateMic');
    mic.hidden = !live && !text;
    mic.classList.toggle('listening', !!live);
    $('zodiacGateMicLabel').textContent = live ? 'Listening…' : (text || 'Listening…');
  }

  function startGateListening() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setGateHint('', false); return; }   // no voice here; buttons only

    const session = ++gateListenSession;
    let answered = false;

    const listenOnce = () => {
      gateRecognizer = new SR();
      gateRecognizer.lang = 'en-US';
      gateRecognizer.continuous = true;
      gateRecognizer.interimResults = false;
      gateRecognizer.maxAlternatives = 3;

      gateRecognizer.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const alts = [...e.results[i]].map((r) => r.transcript);
          if (alts.some(isAffirmative)) {
            answered = true;
            setGateHint(`Heard “${alts[0].trim()}”`, false);
            try { gateRecognizer.stop(); } catch { /* already stopping */ }
            acceptReady();
            return;
          }
        }
      };

      gateRecognizer.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          answered = true;   // reopening the mic will not change their mind
          setGateHint('Microphone blocked — choose an answer above', false);
        }
        // no-speech and network hiccups fall through to onend, which reopens.
      };

      gateRecognizer.onend = () => {
        // Stop if answered, superseded, or the gate is no longer the thing on screen.
        if (answered || session !== gateListenSession) return;
        if (state.scene !== 1 || $('zodiacGate').hidden) return;
        listenOnce();
      };

      try { gateRecognizer.start(); }
      catch { setGateHint('', false); }   // already started, or blocked outright
    };

    setGateHint('', true);   // the pill says "Listening…" on its own
    listenOnce();
  }

  function stopGateListening() {
    gateListenSession++;
    if (gateRecognizer) {
      try { gateRecognizer.abort(); } catch { /* already done */ }
      gateRecognizer = null;
    }
    setGateHint('', false);
  }

  /**
   * Scenes 1-4 take over from the ordinary sky: the star canvas and its HUD
   * hide (the backdrop video keeps playing underneath, untouched) and that
   * scene's own overlay starts. Every other scene restores the ordinary sky.
   */
  function updateSceneVisibility() {
    const zodiacScene = state.scene === 1;
    const birthdateScene = state.scene === 2;
    const cardScene = state.scene === 3;
    const revealScene = state.scene === 4;
    const takeover = zodiacScene || birthdateScene || cardScene || revealScene;
    $('sky').hidden = takeover;
    document.querySelector('.hud-tl').hidden = takeover;
    document.querySelector('.hud-tr').hidden = takeover;
    $('zodiacScene').hidden = !zodiacScene;
    $('birthdateScene').hidden = !birthdateScene;
    $('cardScene').hidden = !cardScene;
    $('revealScene').hidden = !revealScene;
    if (zodiacScene) startZodiacSlideshow(); else stopZodiacSlideshow();
    // Always enter scene 1 ungated: the gate is earned by the narration finishing.
    hideZodiacGate();
    if (birthdateScene) startBirthdateScene(); else stopBirthdateScene();
    if (cardScene) renderCardScene();
    if (cardScene) startCamera(); else stopCamera();
    if (revealScene) renderRevealScene();
    startSceneNarration();
  }

  /* ------------------------------------------------------- zodiac scene --- */

  function buildZodiacTrack() {
    $('zodiacTrack').innerHTML = ZODIAC_ORDER.map((abbrev) => {
      const con = data.conByAbbrev[abbrev];
      return `<div class="zodiac-slide" data-abbrev="${abbrev}">
        <p class="zodiac-card">${con.name}</p>
        <img class="zodiac-art" src="assets/constellations/${ZODIAC_FILES[abbrev]}.svg"
             alt="${con.name}" draggable="false">
        <p class="zodiac-fact">${con.ancient_use || ''}</p>
      </div>`;
    }).join('');
  }

  // Slides sit in one long flex row; centring the current one is a matter of
  // measuring its own box and sliding the row so that box lands mid-screen —
  // no hard-coded widths to keep in sync with the responsive CSS.
  function centerZodiacTrack(animate) {
    const scene = $('zodiacScene');
    const track = $('zodiacTrack');
    const slide = track.children[state.zodiacIndex];
    if (!slide) return;
    track.style.transition = animate ? '' : 'none';
    const shift = scene.clientWidth / 2 - (slide.offsetLeft + slide.offsetWidth / 2);
    track.style.transform = `translateX(${shift}px)`;
    if (!animate) void track.offsetWidth; // flush, so the next change re-enables the transition
  }

  function renderZodiacSlide(animate = true) {
    const track = $('zodiacTrack');
    for (const [i, el] of [...track.children].entries()) {
      el.classList.toggle('active', i === state.zodiacIndex);
    }
    centerZodiacTrack(animate);
  }

  let zodiacTimer = null;
  function startZodiacSlideshow() {
    stopZodiacSlideshow();
    renderZodiacSlide(false);
    zodiacTimer = setInterval(() => {
      state.zodiacIndex = (state.zodiacIndex + 1) % ZODIAC_ORDER.length;
      renderZodiacSlide(true);
    }, ZODIAC_SLIDE_MS);
  }
  function stopZodiacSlideshow() {
    if (zodiacTimer) { clearInterval(zodiacTimer); zodiacTimer = null; }
  }

  /* ---------------------------------------------------- birthdate scene --- */

  // Two constellations standing in as ambient decoration while "analysing"
  // holds — any pair works, since nothing about them is meant to be read yet.
  const BD_GLYPHS = ['Gem', 'Sco'];
  const BD_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
                      'july', 'august', 'september', 'october', 'november', 'december'];
  // The detection hold is deliberately slow — never under 5s — so it reads as
  // work being done, not an instant lookup.
  const BD_DETECT_MIN_MS = 5000, BD_DETECT_MAX_MS = 7000;

  function buildBirthdateGlyphs() {
    BD_GLYPHS.forEach((abbrev, i) => {
      const img = $(`bdGlyph${i}`);
      if (img) img.src = `assets/constellations/${ZODIAC_FILES[abbrev]}.svg`;
    });
  }

  function setBirthdateStep(step) {
    state.birthdateStep = step;
    for (const el of $('birthdateScene').querySelectorAll('.bd-slide')) {
      el.classList.toggle('active', el.dataset.step === step);
    }
  }

  // Speech gives back numerals for spoken numbers ("march 5th 1998"), so a
  // month name plus a 1-2 digit day plus an optional 4-digit year covers the
  // ordinary ways someone says a birthday.
  function parseSpokenDate(text) {
    const t = text.toLowerCase();
    const monthIdx = BD_MONTHS.findIndex((m) => t.includes(m));
    if (monthIdx === -1) return null;
    const dayMatch = t.match(/\b([12]?\d|3[01])(st|nd|rd|th)?\b/);
    if (!dayMatch) return null;
    const day = Number(dayMatch[1]);
    if (day < 1 || day > 31) return null;
    const yearMatch = t.match(/\b(1[89]\d{2}|20\d{2})\b/);
    return { month: monthIdx + 1, day, year: yearMatch ? Number(yearMatch[0]) : null };
  }

  function bdSetHeard(text) { $('bdHeard').textContent = text; }
  function bdSetMicState(mode) { // 'idle' | 'listening'
    $('bdMicBtn').classList.toggle('listening', mode === 'listening');
    $('bdMicBtn').querySelector('.bd-mic-label').textContent =
      mode === 'listening' ? 'Listening…' : 'Not listening';
  }

  /**
   * Open the mic on scene 2 as soon as the birth-date question has finished being
   * asked, so answering out loud needs no tap — the same shape as the gate on
   * scene 1. The mic button stays as a retry, and typing stays available.
   *
   * Held back if they have already moved on, already answered, or chosen to type
   * instead; in those cases opening the mic would be talking over their decision.
   */
  function autoListenForBirthdate() {
    if (state.scene !== 2 || state.birthdateStep !== 'ask') return;
    if ($('bdMicBtn').hidden) return;            // they switched to typing
    if (!$('birthdateForm').hidden) return;      // the form is open and in use
    startListening();
  }

  let bdRecognizer = null;
  // Browsers end a recognition session on their own well before someone has
  // finished speaking a date — after one pause, or a fixed silence timeout
  // even with `continuous`. bdListenSession lets a stale session's onend
  // (from one we deliberately stopped) tell itself apart from one that
  // should reopen the mic, so "keep listening" can mean it in practice.
  let bdListenSession = 0;

  function startListening() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { bdSetHeard("This browser can't listen — type it instead."); return; }
    const session = ++bdListenSession;
    let found = false;

    const listenOnce = () => {
      bdRecognizer = new SR();
      bdRecognizer.lang = 'en-US';
      bdRecognizer.continuous = true; // keep listening across pauses within one utterance
      bdRecognizer.interimResults = false;
      bdRecognizer.maxAlternatives = 3;

      bdRecognizer.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const alts = [...e.results[i]].map((r) => r.transcript);
          const parsed = alts.map(parseSpokenDate).find(Boolean);
          if (parsed) {
            found = true;
            bdSetHeard(`Heard: “${alts[0]}”`);
            bdRecognizer.stop();
            handleBirthdateFound(parsed);
            return;
          }
          bdSetHeard(`Heard "${alts[0]}" — still listening for a date…`);
        }
      };
      bdRecognizer.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          found = true; // permission denied — reopening the mic won't help
          bdSetHeard('Microphone access was blocked — type it instead.');
          bdSetMicState('idle');
        }
        // Anything else (no-speech, network hiccups) is left to onend below,
        // which reopens the mic rather than giving up on one bad chunk.
      };
      bdRecognizer.onend = () => {
        if (found || session !== bdListenSession || state.birthdateStep !== 'ask') return;
        listenOnce();
      };
      bdRecognizer.start();
    };

    bdSetMicState('listening');
    bdSetHeard('Listening — take your time…');
    listenOnce();
  }

  function handleBirthdateFound({ month, day, year }) {
    state.birthDate = { month, day, year };
    state.detectedZodiac = zodiacFromMonthDay(month, day);
    setBirthdateStep('analyzing');
    const delay = BD_DETECT_MIN_MS + Math.random() * (BD_DETECT_MAX_MS - BD_DETECT_MIN_MS);
    clearTimeout(bdAdvanceTimer);
    bdAdvanceTimer = setTimeout(() => setScene(3), delay);
  }

  let bdAdvanceTimer = null;
  // Every time scene 2 is entered fresh, start back at the question — a
  // previously entered date does not carry over into a new pass through it.
  function startBirthdateScene() {
    clearTimeout(bdAdvanceTimer);
    bdListenSession++; // invalidate any in-flight recognition session's auto-restart
    if (bdRecognizer) { bdRecognizer.abort(); bdRecognizer = null; }
    $('birthdateForm').hidden = true;
    $('birthdateInput').value = '';
    $('bdMicBtn').hidden = false;
    $('bdTypeInstead').hidden = false;
    bdSetMicState('idle');
    bdSetHeard('');
    setBirthdateStep('ask');
  }

  /**
   * They said yes on the zodiacs screen. Move to the birth-date scene, which asks
   * for the date aloud as it opens. Guarded on the gate being up, so a double tap
   * only advances once.
   */
  function acceptReady() {
    if (state.scene !== 1 || $('zodiacGate').hidden) return;
    hideZodiacGate();      // also releases the microphone
    setScene(2);
  }

  const isAffirmative = (text) => {
    const t = (text || '').toLowerCase().trim();
    return AFFIRMATIVES.some((w) => t === w || t.includes(w));
  };
  function stopBirthdateScene() {
    clearTimeout(bdAdvanceTimer);
    bdListenSession++;
    if (bdRecognizer) { bdRecognizer.abort(); bdRecognizer = null; }
  }

  /* ------------------------------------------------------------- camera --- */

  /*
   * The camera opens with scene 3, because that is the scene where a card is held
   * up to be recognised, and closes again the moment the scene ends. Nothing here
   * records or uploads anything: the stream feeds a preview element so the visitor
   * can see the card is being looked at, and is exposed on window.__sky for the
   * card-detection model to read frames from.
   *
   * Releasing it matters. A getUserMedia stream keeps the camera light on and the
   * device claimed until every track is stopped, so leaving the scene stops them
   * rather than relying on the page being closed.
   */
  let cameraStream = null;
  let cameraSession = 0;

  function setCameraState(scene, state_, label) {
    scene.dataset.camera = state_;
    if (label !== undefined) $('cardCamLabel').textContent = label;
  }

  async function startCamera() {
    const scene = $('cardScene');
    const session = ++cameraSession;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraState(scene, 'unsupported', 'no camera here');
      $('cardCam').hidden = true;
      return;
    }

    $('cardCam').hidden = false;
    setCameraState(scene, 'starting', 'looking…');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,   // the microphone belongs to the gate, not to this
      });
      // They may have left the scene during the permission prompt, which can sit
      // there indefinitely — in that case hand the camera straight back.
      if (session !== cameraSession || state.scene !== 3) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      cameraStream = stream;
      const video = $('cardCamVideo');
      video.srcObject = stream;
      try { await video.play(); } catch { /* autoplay of a muted stream, fine */ }
      setCameraState(scene, 'live', 'looking…');
    } catch (err) {
      if (session !== cameraSession) return;
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      setCameraState(scene, 'blocked', denied ? 'camera blocked' : 'no camera found');
    }
  }

  function stopCamera() {
    cameraSession++;
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      cameraStream = null;
    }
    const video = $('cardCamVideo');
    if (video) video.srcObject = null;
    $('cardCam').hidden = true;
    delete $('cardScene').dataset.camera;
  }

  /* --------------------------------------------------------- card scene --- */

  // The sign is already known by scene 3 (scene 2 detected it) — it just
  // isn't announced yet, so the art sits dim in the background. Falls back to
  // the first sign if scene 3 is opened directly, e.g. via the scene switcher.
  //
  // The SVG is fetched and injected inline, rather than used as an <img>, so
  // its individual stars and lines can be picked out and given their own
  // glow (see .card-star / .card-lines in styles.css) — an <img> renders the
  // file opaquely and can't be reached from CSS or JS.
  async function renderCardScene() {
    const abbrev = state.detectedZodiac || ZODIAC_ORDER[0];
    // Set before the early return below, so the number is right even when the art
    // is already the sign being shown.
    $('cardTitle').textContent = `Pick the shape ${shapeNumberFor(abbrev)}`;
    const art = $('cardArt');
    if (art.dataset.abbrev === abbrev) return; // already showing this sign
    art.dataset.abbrev = abbrev;
    try {
      const res = await fetch(`assets/constellations/${ZODIAC_FILES[abbrev]}.svg`);
      const text = await res.text();
      const svgStart = text.indexOf('<svg');
      art.innerHTML = text.slice(svgStart).replace(/<metadata>[\s\S]*?<\/metadata>/, '');
      animateCardArt(art.querySelector('svg'));
    } catch {
      art.innerHTML = '';
    }
  }

  // Each star glyph is a top-level <use> in the file; the join-the-dots lines
  // are the one <g> with a dash pattern. Random delay/duration per star is
  // what makes them twinkle out of sync with each other.
  function animateCardArt(svg) {
    if (!svg) return;
    for (const el of svg.children) {
      if (el.tagName === 'use') {
        el.classList.add('card-star');
        el.style.animationDelay = `${(Math.random() * 6).toFixed(2)}s`;
        el.style.animationDuration = `${(4 + Math.random() * 3).toFixed(2)}s`;
      }
    }
    const lines = svg.querySelector('g[stroke-dasharray]');
    if (lines) lines.classList.add('card-lines');
  }

  /* ------------------------------------------------------- reveal scene --- */

  // Same sign as scene 3, now announced: full brightness, name on the card,
  // and its three traits set beside three of its own stars.
  async function renderRevealScene() {
    const abbrev = state.detectedZodiac || ZODIAC_ORDER[0];
    const con = data.conByAbbrev[abbrev];
    $('revealCard').textContent = con ? con.name : '';
    const art = $('revealArt');
    if (art.dataset.abbrev === abbrev) return;
    art.dataset.abbrev = abbrev;
    try {
      const res = await fetch(`assets/constellations/${ZODIAC_FILES[abbrev]}.svg`);
      const text = await res.text();
      const svgStart = text.indexOf('<svg');
      art.innerHTML = text.slice(svgStart).replace(/<metadata>[\s\S]*?<\/metadata>/, '');
      placeRevealTraits(art.querySelector('svg'), ZODIAC_TRAITS[abbrev] || []);
    } catch {
      art.innerHTML = '';
      $('revealTraits').innerHTML = '';
    }
  }

  // Spreads the three traits across three of the constellation's own stars —
  // first, middle and last in the file's drawing order, which in practice
  // gives a scattered, not-clustered, set of anchor points — rather than
  // hard-coding a pixel position per sign.
  function placeRevealTraits(svg, traits) {
    const container = $('revealTraits');
    container.innerHTML = '';
    if (!svg || !traits.length) return;
    const vb = svg.viewBox.baseVal;
    const uses = [...svg.children].filter((el) => el.tagName === 'use');
    if (!uses.length) return;
    const picks = uses.length === 1 ? [0, 0, 0]
      : [0, Math.floor((uses.length - 1) / 2), uses.length - 1];
    picks.forEach((idx, i) => {
      const label = traits[i];
      const m = /translate\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/.exec(
        uses[idx].getAttribute('transform') || '');
      if (!label || !m) return;
      const px = ((Number(m[1]) - vb.x) / vb.width) * 100;
      const py = ((Number(m[2]) - vb.y) / vb.height) * 100;
      const span = document.createElement('span');
      span.className = 'reveal-trait';
      span.textContent = label;
      span.style.left = `${px}%`;
      span.style.top = `${py}%`;
      span.style.transform = px < 50
        ? 'translate(30px, -50%)' : 'translate(calc(-100% - 30px), -50%)';
      container.appendChild(span);
    });
  }

  function conRow(abbrev) {
    const con = data.conByAbbrev[abbrev];
    const v = computed.conVisible[abbrev];
    const where = placeInSky(v);
    const up = v.visibleStars > 0;
    return `<li class="crow ${up ? '' : 'down'} ${state.selected === abbrev ? 'sel' : ''}"
                data-abbrev="${abbrev}" tabindex="0" role="button"
                aria-label="${con.name}, ${where.long}">
      <span class="cdot ${con.group}"></span>
      <span class="cname">${con.name}</span>
      <span class="cwhere">${where.short}</span>
    </li>`;
  }

  /**
   * The sidebar only changes when a constellation's description or selection
   * changes, but draw() runs many times a second so the stars can twinkle.
   * Rewriting innerHTML on every frame would thrash the DOM and throw away
   * hover and keyboard focus mid-interaction, so compare a signature first.
   */
  let listSignature = '';
  function renderLists() {
    const sig = [...ZODIAC_ORDER, ...CIRCUMPOLAR_ORDER].map((a) => {
      const v = computed.conVisible[a];
      return `${a}${placeInSky(v).short}${state.selected === a ? '*' : ''}`;
    }).join('|') + `#${state.showZodiac}${state.showCircumpolar}`;
    if (sig === listSignature) return;
    listSignature = sig;
    $('zodiacList').innerHTML = ZODIAC_ORDER.map(conRow).join('');
    $('polarList').innerHTML = CIRCUMPOLAR_ORDER.map(conRow).join('');
  }

  /* ---------------------------------------------------------- story panel --- */

  function openStory(abbrev) {
    const con = data.conByAbbrev[abbrev];
    if (!con) { $('story').hidden = true; return; }
    const v = computed.conVisible[abbrev];
    const where = placeInSky(v);
    const up = v.visibleStars > 0;

    $('story').innerHTML = `
      <button id="closeStory" class="close" aria-label="Close">×</button>
      <p class="skind"><span class="cdot ${con.group}"></span>${
        con.group === 'circumpolar' ? 'Never sets from here' : 'Zodiac — the Sun passes through it'
      }</p>
      <h2>${con.name}</h2>
      <p class="swhere ${up ? '' : 'is-down'}">${
        up ? `Right now: <strong>${where.long}</strong>${v.fraction < 0.9 ? ', partly below the horizon' : ''}`
           : `Right now: <strong>below the horizon</strong> — try another time of night, or a different month`
      }</p>
      ${con.brightest ? `<p class="sbright">Brightest star: <strong>${con.brightest.replace(/\s*\([^)]*\)/, '')}</strong></p>` : ''}
      <button id="turnTo" class="turn">${up ? 'Turn and look at it' : 'Turn towards it anyway'}</button>
      <section><h3>Mythology</h3><p>${con.myth_fact}</p></section>
      <section><h3>How it was used</h3><p>${con.ancient_use}</p></section>
      <section><h3>The story</h3><p>${con.story}</p></section>`;

    $('story').hidden = false;
    $('story').scrollTop = 0;
    $('closeStory').addEventListener('click', () => select(null));
    const turn = $('turnTo');
    if (turn) {
      turn.addEventListener('click', () => {
        // Point at the visible part if there is one, otherwise at the whole figure
        // wherever it is — including below the horizon.
        if (up) lookAt(v.centroidAz, v.centroidAlt);
        else lookAt(v.anchorAz, v.anchorAlt);
      });
    }
  }

  function select(abbrev, alsoTurn = false) {
    // Guard against a star from one of the other 71 constellations, which has a
    // name to show on hover but no story behind it.
    if (abbrev && !data.conByAbbrev[abbrev]) abbrev = null;
    state.selected = abbrev;
    if (!abbrev) {
      $('story').hidden = true;
    } else {
      $('panel').hidden = true;
      $('panelBtn').setAttribute('aria-expanded', 'false');
      const v = computed.conVisible[abbrev];
      if (alsoTurn) {
        if (v.visibleStars > 0) lookAt(v.centroidAz, v.centroidAlt);
        else lookAt(v.anchorAz, v.anchorAlt);
      }
      openStory(abbrev);
    }
    draw();
  }

  /* ---------------------------------------------- looking around the sky --- */

  /** Point the view at an alt/az, taking the short way round the compass. */
  function lookAt(az, alt) {
    let delta = Astro.norm360(az - state.facing);
    if (delta > 180) delta -= 360;
    state.targetFacing = state.facing + delta;
    state.targetPitch = clampPitch(alt);
    if (prefersReducedMotion) {
      state.facing = Astro.norm360(state.targetFacing);
      state.targetFacing = state.facing;
      state.pitch = state.targetPitch;
      draw();
    }
  }

  function turnBy(deg) {
    state.targetFacing += deg;
  }

  // You can look almost straight up and well below the horizon; the last few
  // degrees at each pole are held back because the view frame degenerates there.
  const clampPitch = (a) => Math.max(-82, Math.min(85, a));
  const clampFov = (f) => Math.max(25, Math.min(160, f));

  /** Ease the view towards its target; returns true while still moving. */
  function stepView(dt) {
    const k = 1 - Math.exp(-dt * 7);
    let moved = false;
    const dF = state.targetFacing - state.facing;
    if (Math.abs(dF) > 0.02) { state.facing += dF * k; moved = true; }
    else state.facing = state.targetFacing;
    const dP = state.targetPitch - state.pitch;
    if (Math.abs(dP) > 0.02) { state.pitch += dP * k; moved = true; }
    else state.pitch = state.targetPitch;
    if (!moved && Math.abs(state.facing) > 720) {
      state.facing = Astro.norm360(state.facing);
      state.targetFacing = state.facing;
    }
    return moved;
  }

  /* -------------------------------------------------------- time controls --- */

  let syncing = false;
  function syncTimeInputs() {
    syncing = true;
    const p = Astro.zonedParts(state.date, state.tz);
    $('hourSlider').value = String(p.hour * 60 + p.minute);
    $('daySlider').value = String(dayOfYear(p.year, p.month, p.day));
    // The sliders carry no visible readout: the clock and date in the corner are
    // the single source of truth, and repeating them under the sliders was noise.
    $('hourSlider').title = `Time of night — ${fmtClock(state.date)}`;
    $('daySlider').title = `Time of year — ${new Intl.DateTimeFormat('en-GB',
      { timeZone: state.tz, day: 'numeric', month: 'long' }).format(state.date)}`;
    syncing = false;
  }

  const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const MONTHS = (y) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  function dayOfYear(y, m, d) {
    const L = MONTHS(y); let n = d;
    for (let i = 0; i < m - 1; i++) n += L[i];
    return n;
  }
  function fromDayOfYear(y, doy) {
    const L = MONTHS(y); let m = 1, d = Math.max(1, Math.min(doy, isLeap(y) ? 366 : 365));
    while (d > L[m - 1]) { d -= L[m - 1]; m++; }
    return { month: m, day: d };
  }

  function setZoned(fields) {
    const p = Astro.zonedParts(state.date, state.tz);
    state.date = Astro.instantFromZoned({ ...p, ...fields }, state.tz);
    state.live = false;
    syncTimeInputs();
    draw();
  }

  function goLive() {
    state.live = true;
    state.playing = false;
    $('playBtn').classList.remove('on');
    $('playBtn').textContent = 'Play';
    state.date = new Date();
    syncTimeInputs();
    draw();
  }

  /* ------------------------------------------------------------ main loop --- */

  let last = performance.now();
  let idleAccum = 0;

  // The browser suspends requestAnimationFrame while the page is hidden, so on
  // coming back the first timestamp is stale. Reset the clock instead of feeding
  // a huge delta into the easing.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { last = performance.now(); idleAccum = 0; }
  });

  function loop(now) {
    // Whatever happens in a frame, schedule the next one first: an exception
    // escaping here would otherwise stop the clock and the view for good.
    requestAnimationFrame(loop);
    try { frameBody(now); }
    catch (err) { console.error('sky frame failed', err); }
  }

  function frameBody(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    let needsDraw = false;
    if (state.live) { state.date = new Date(); syncTimeInputs(); needsDraw = true; }
    else if (state.playing) {
      state.date = new Date(state.date.getTime() + dt * state.playSpeed * 1000);
      syncTimeInputs();
      needsDraw = true;
    }
    if (stepView(dt)) needsDraw = true;

    // Twinkling keeps the sky alive while nothing else is moving, but there is no
    // reason to burn a full 60fps on it.
    if (!needsDraw && state.twinkle) {
      idleAccum += dt;
      if (idleAccum > 1 / 24) needsDraw = true;
    }
    if (needsDraw) { draw(dt); idleAccum = 0; }
  }

  /* --------------------------------------------------------------- wiring --- */

  function wire() {
    const canvas = $('sky');

    /* --- dragging to look around, pinching to zoom --- */
    // Active pointers are tracked by id so one finger pans and two pinch, which is
    // what people expect on a touchscreen. A mouse just uses the single-pointer path.
    const pointers = new Map();
    let pinch = null;

    const pointerPos = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const pinchSpan = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, pointerPos(e));
      if (pointers.size === 2) {
        // Second finger down: switch from panning to pinching.
        dragging = null;
        pinch = { span: pinchSpan(), fov: state.fov };
      } else if (pointers.size === 1) {
        const p = pointerPos(e);
        dragging = { startX: p.x, startY: p.y, moved: false,
                     facing: state.targetFacing, pitch: state.targetPitch };
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      const p = pointerPos(e);
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);

      if (pinch && pointers.size >= 2) {
        const span = pinchSpan();
        if (pinch.span > 8 && span > 8) {
          // Spreading the fingers narrows the field of view, i.e. zooms in.
          state.fov = clampFov(pinch.fov * (pinch.span / span));
          draw();
        }
        return;
      }

      if (dragging) {
        const dx = p.x - dragging.startX, dy = p.y - dragging.startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragging.moved = true;
        // One canvas width of drag turns you through one field of view.
        const perPx = state.fov / canvas.clientWidth;
        state.targetFacing = dragging.facing - dx * perPx;
        state.targetPitch = clampPitch(dragging.pitch + dy * perPx);
        state.facing = state.targetFacing;
        state.pitch = state.targetPitch;
        canvas.style.cursor = 'grabbing';
        draw();
        return;
      }

      const h = Sky.pick(frame, p.x, p.y);
      const nextHover = h ? h.abbrev : null;
      if (nextHover !== state.hovered) { state.hovered = nextHover; draw(); }
      canvas.style.cursor = h && h.abbrev ? 'pointer' : 'grab';

      const tip = $('tooltip');
      if (h && h.via === 'star' && h.star) {
        const con = data.conByAbbrev[h.star.c];
        tip.textContent = con ? `${h.star.n} · in ${con.name}` : h.star.n;
        tip.classList.toggle('plain', !con);
        tip.style.left = `${p.x + 14}px`;
        tip.style.top = `${p.y + 14}px`;
        tip.hidden = false;
      } else tip.hidden = true;
    });

    const releasePointer = (e, wasCancelled) => {
      const had = pointers.has(e.pointerId);
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!had) return;

      if (dragging && !wasCancelled) {
        const wasClick = !dragging.moved;
        const p = pointerPos(e);
        dragging = null;
        canvas.style.cursor = 'grab';
        if (wasClick) {
          const h = Sky.pick(frame, p.x, p.y);
          select(h ? h.abbrev : null);
        }
      } else {
        dragging = null;
        canvas.style.cursor = 'grab';
      }
    };
    canvas.addEventListener('pointerup', (e) => releasePointer(e, false));
    canvas.addEventListener('pointercancel', (e) => releasePointer(e, true));
    canvas.addEventListener('pointerleave', () => {
      $('tooltip').hidden = true;
      if (state.hovered) { state.hovered = null; draw(); }
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      // Trackpad pinch arrives as a ctrl-modified wheel event.
      const step = e.ctrlKey ? e.deltaY * 0.6 : Math.sign(e.deltaY) * 5;
      state.fov = clampFov(state.fov + step);
      draw();
    }, { passive: false });

    canvas.addEventListener('dblclick', (e) => {
      // Double-click to zoom in on whatever is under the cursor.
      const p = pointerPos(e);
      const h = Sky.pick(frame, p.x, p.y);
      if (h && h.abbrev) select(h.abbrev, true);
      state.fov = clampFov(state.fov * 0.7);
      draw();
    });

    /* --- compass buttons --- */
    for (const b of document.querySelectorAll('.cbtn')) {
      b.addEventListener('click', () => lookAt(Number(b.dataset.az), state.targetPitch));
    }
    $('turnLeft').addEventListener('click', () => turnBy(-45));
    $('turnRight').addEventListener('click', () => turnBy(45));

    /* --- the scene switcher --- */
    const bar = $('sceneBar');
    bar.innerHTML = `
      <div class="scene-pills">
        ${SCENES.map((sc) => `<button class="scene-pill" data-scene="${sc.id}"
            title="Scene ${sc.id}: ${sc.title}"><b>${sc.id}</b>${sc.label}</button>`).join('')}
      </div>`;
    bar.addEventListener('click', (e) => {
      const pill = e.target.closest('.scene-pill');
      if (pill) setScene(Number(pill.dataset.scene));
    });

    /* --- the ready gate (scene 2) --- */
    for (const btn of document.querySelectorAll('.bd-choice')) {
      btn.addEventListener('click', acceptReady);
    }

    /* --- the zodiac slideshow (scene 1) --- */
    buildZodiacTrack();
    $('zodiacTrack').addEventListener('click', (e) => {
      const slide = e.target.closest('.zodiac-slide');
      if (!slide) return;
      const idx = [...$('zodiacTrack').children].indexOf(slide);
      if (idx === -1 || idx === state.zodiacIndex) return;
      state.zodiacIndex = idx;
      startZodiacSlideshow(); // jump there now, then give it a full dwell before moving on
    });

    /* --- the birthdate ask (scene 2) --- */
    buildBirthdateGlyphs();
    // No click handler on the mic status: it is a read-out now, and the mic opens
    // itself once the birth-date question has been asked.

    $('bdTypeInstead').addEventListener('click', () => {
      bdListenSession++;
      if (bdRecognizer) { bdRecognizer.abort(); bdRecognizer = null; }
      $('bdMicBtn').hidden = true;
      $('bdTypeInstead').hidden = true;
      bdSetHeard('');
      $('birthdateForm').hidden = false;
      $('birthdateInput').focus();
    });
    $('birthdateForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const value = $('birthdateInput').value; // yyyy-mm-dd
      if (!value) return;
      const [year, month, day] = value.split('-').map(Number);
      handleBirthdateFound({ month, day, year });
    });

    /* --- the card prompt (scene 3) --- */
    // Stands in for the card-detection model until it's wired up: a tap here
    // is "the card was read", so it advances straight to the reveal.
    $('cardScene').addEventListener('click', () => setScene(4));

    updateSceneVisibility();

    /* --- the browse and settings overlay --- */
    const setPanel = (open) => {
      $('panel').hidden = !open;
      $('panelBtn').setAttribute('aria-expanded', String(open));
      if (open) { $('story').hidden = true; state.selected = null; draw(); }
    };
    $('panelBtn').addEventListener('click', () => setPanel($('panel').hidden));
    $('closePanel').addEventListener('click', () => setPanel(false));

    /* --- constellation lists --- */
    for (const listId of ['zodiacList', 'polarList']) {
      const el = $(listId);
      el.addEventListener('click', (e) => {
        const row = e.target.closest('[data-abbrev]');
        if (!row) return;
        $('panel').hidden = true;
        $('panelBtn').setAttribute('aria-expanded', 'false');
        select(row.dataset.abbrev, true);
      });
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const row = e.target.closest('[data-abbrev]');
        if (row) { e.preventDefault(); select(row.dataset.abbrev, true); }
      });
      el.addEventListener('pointerover', (e) => {
        const row = e.target.closest('[data-abbrev]');
        const next = row ? row.dataset.abbrev : null;
        if (next !== state.hovered) { state.hovered = next; draw(); }
      });
      el.addEventListener('pointerleave', () => {
        if (state.hovered) { state.hovered = null; draw(); }
      });
    }

    /* --- time --- */
    $('hourSlider').addEventListener('input', (e) => {
      if (syncing) return;
      const m = Number(e.target.value);
      setZoned({ hour: Math.floor(m / 60), minute: m % 60, second: 0 });
    });
    $('daySlider').addEventListener('input', (e) => {
      if (syncing) return;
      const p = Astro.zonedParts(state.date, state.tz);
      const { month, day } = fromDayOfYear(p.year, Number(e.target.value));
      setZoned({ month, day });
    });
    $('nowBtn').addEventListener('click', goLive);
    $('playBtn').addEventListener('click', () => {
      state.playing = !state.playing;
      if (state.playing) state.live = false;
      $('playBtn').classList.toggle('on', state.playing);
      $('playBtn').textContent = state.playing ? 'Pause' : 'Play';
    });
    $('speedSelect').addEventListener('change', (e) => {
      state.playSpeed = Number(e.target.value);
    });

    /* --- what you can see --- */
    const conditions = $('conditions');
    for (const c of SKY_CONDITIONS) conditions.add(new Option(c.label, c.id));
    conditions.value = state.conditions;
    const applyConditions = () => {
      const c = SKY_CONDITIONS.find((x) => x.id === conditions.value);
      state.conditions = c.id;
      state.magLimit = c.limit;
      $('conditionsNote').textContent = c.note;
      draw();
    };
    conditions.addEventListener('change', applyConditions);
    applyConditions();

    const toggles = {
      showZodiac: 'tZodiac', showCircumpolar: 'tCircumpolar', showLines: 'tLines',
      showLabels: 'tLabels', showStarNames: 'tStarNames', showMilkyWay: 'tMilkyWay',
      showBackdrop: 'tBackdrop', showGround: 'tGround',
      showGlyphs: 'tGlyphs', twinkle: 'tTwinkle', showSceneBar: 'tSceneBar',
      narration: 'tNarration',
    };
    for (const [key, id] of Object.entries(toggles)) {
      const el = $(id);
      el.checked = state[key];
      el.addEventListener('change', () => {
        state[key] = el.checked;
        if (key === 'showBackdrop') syncBackdrop();
        if (key === 'narration') {
          if (state.narration) startSceneNarration(); else stopNarration();
        }
        draw();
      });
    }
    syncBackdrop();

    /* --- location --- */
    $('applyLocation').addEventListener('click', () => {
      const lat = Number($('latInput').value), lon = Number($('lonInput').value);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) return flash('latInput');
      if (!Number.isFinite(lon) || lon < -180 || lon > 180) return flash('lonInput');
      state.lat = lat; state.lon = lon;
      state.tz = $('tzSelect').value;
      state.placeName = $('placeInput').value.trim() || 'Somewhere on Earth';
      syncTimeInputs();
      draw();
    });
    $('resetLocation').addEventListener('click', () => {
      Object.assign(state, { lat: BERGAMO.lat, lon: BERGAMO.lon, tz: BERGAMO.tz, placeName: BERGAMO.name });
      fillLocationInputs(); syncTimeInputs(); draw();
    });
    $('geoBtn').addEventListener('click', () => {
      if (!navigator.geolocation) return;
      $('geoBtn').textContent = 'Locating…';
      navigator.geolocation.getCurrentPosition((pos) => {
        state.lat = +pos.coords.latitude.toFixed(4);
        state.lon = +pos.coords.longitude.toFixed(4);
        state.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        state.placeName = 'Where you are';
        fillLocationInputs(); syncTimeInputs(); draw();
        $('geoBtn').textContent = 'Use my location';
      }, () => { $('geoBtn').textContent = 'Location unavailable'; }, { timeout: 10000 });
    });

    window.addEventListener('resize', () => {
      draw();
      if (state.scene === 1) centerZodiacTrack(false);
    });
    window.addEventListener('keydown', (e) => {
      if (e.target.matches('input, select, textarea')) return;
      switch (e.key) {
        case 'Escape':
          if (!$('panel').hidden) { $('panel').hidden = true; $('panelBtn').setAttribute('aria-expanded', 'false'); }
          else select(null);
          break;
        case 'ArrowLeft': turnBy(-15); break;
        case 'ArrowRight': turnBy(15); break;
        case 'ArrowUp': state.targetPitch = clampPitch(state.targetPitch + 8); break;
        case 'ArrowDown': state.targetPitch = clampPitch(state.targetPitch - 8); break;
        case '+': case '=': state.fov = clampFov(state.fov - 8); draw(); break;
        case '-': case '_': state.fov = clampFov(state.fov + 8); draw(); break;
        case ' ': e.preventDefault(); $('playBtn').click(); break;
        case 'n': case 'N': goLive(); break;
        case 'Enter': case 'y': case 'Y':
          acceptReady();     // no-ops unless the gate is up on scene 1
          break;
        case '[': setScene(state.scene - 1); break;
        case ']': setScene(state.scene + 1); break;
        default:
          if (/^[0-6]$/.test(e.key)) setScene(Number(e.key));
          break;
      }
    });
  }

  /** The plate is a DOM layer, so it is shown or hidden outside the canvas draw. */
  function syncBackdrop() {
    $('backdrop').hidden = !state.showBackdrop;
    const media = $('backdropMedia');
    if (media && typeof media.play === 'function') {
      // Re-applied here as well as on load: some browsers reset the rate when a
      // media element is paused and resumed.
      media.playbackRate = BACKDROP_RATE;
      media.defaultPlaybackRate = BACKDROP_RATE;
      // Hold the footage still for anyone who has asked for reduced motion, and
      // stop it decoding at all while the layer is hidden.
      if (!state.showBackdrop || prefersReducedMotion) media.pause();
      else media.play().catch(armBackdropOnInteraction);
    }
  }

  /** Hold the slow rate from the moment the element is ready. */
  function initBackdropRate() {
    const media = $('backdropMedia');
    if (!media || typeof media.play !== 'function') return;
    media.defaultPlaybackRate = BACKDROP_RATE;
    media.playbackRate = BACKDROP_RATE;
    media.addEventListener('loadedmetadata', () => {
      media.playbackRate = BACKDROP_RATE;
    });
    // A loop restart is another moment browsers can drop back to 1x.
    media.addEventListener('seeked', () => { media.playbackRate = BACKDROP_RATE; });
  }

  /**
   * If a browser refuses muted autoplay, the poster still shows, but the footage
   * should start as soon as the person touches anything. One shot, then removed.
   */
  let backdropArmed = false;
  function armBackdropOnInteraction() {
    if (backdropArmed || prefersReducedMotion) return;
    backdropArmed = true;
    const start = () => {
      const media = $('backdropMedia');
      if (media && state.showBackdrop && typeof media.play === 'function') {
        media.play().catch(() => { /* still refused; the poster is a fine fallback */ });
      }
      window.removeEventListener('pointerdown', start);
      window.removeEventListener('keydown', start);
    };
    window.addEventListener('pointerdown', start, { once: true });
    window.addEventListener('keydown', start, { once: true });
  }

  function flash(id) {
    const el = $(id);
    el.classList.add('bad');
    setTimeout(() => el.classList.remove('bad'), 900);
  }

  function fillLocationInputs() {
    $('latInput').value = state.lat;
    $('lonInput').value = state.lon;
    $('placeInput').value = state.placeName;
    const sel = $('tzSelect');
    if (![...sel.options].some((o) => o.value === state.tz)) sel.add(new Option(state.tz, state.tz));
    sel.value = state.tz;
  }

  /* ------------------------------------------------------ opening on night --- */

  // Below this Sun altitude the sky is dark enough for the constellations to read.
  const DARK_ENOUGH = -15;

  /**
   * The instant to open on. This is a stargazing view, so it should open on a dark
   * sky rather than on whatever the clock happens to say — arriving at three in the
   * afternoon and being shown a washed-out blue sky is a poor introduction to the
   * constellations.
   *
   * If it is already properly dark, the real moment is the best possible view and
   * live mode stays on. Otherwise the view jumps to the coming night, settling about
   * ninety minutes after darkness falls so the sky has risen clear of the horizon
   * murk. The date moves no further than it must, so what you see is genuinely
   * tonight's sky and the seasonal picture stays honest.
   *
   * @returns {{date: Date, live: boolean}}
   */
  function openingMoment(now) {
    if (Astro.sunAltitude(now, state.lat, state.lon) <= DARK_ENOUGH) {
      return { date: now, live: true };     // already dark: nothing beats the real sky
    }

    const STEP_MIN = 10;
    const SETTLE_MIN = 90;
    let firstDark = null;
    let darkest = { time: now, alt: Infinity };

    // A full day of samples, which also covers the awkward cases: a summer
    // afternoon, and high-latitude white nights where it never gets properly dark.
    for (let m = 0; m <= 24 * 60; m += STEP_MIN) {
      const t = new Date(now.getTime() + m * 60000);
      const alt = Astro.sunAltitude(t, state.lat, state.lon);
      if (alt < darkest.alt) darkest = { time: t, alt };
      if (firstDark === null && alt <= DARK_ENOUGH) firstDark = t;
    }

    // Never gets properly dark here tonight — a polar summer. Show the darkest it
    // will get, which the readout will describe honestly as twilight.
    if (firstDark === null) return { date: darkest.time, live: false };

    // Don't settle so late that dawn is already washing the sky out again.
    const settled = new Date(firstDark.getTime() + SETTLE_MIN * 60000);
    const stillDark = Astro.sunAltitude(settled, state.lat, state.lon) <= DARK_ENOUGH;
    return { date: stillDark ? settled : darkest.time, live: false };
  }

  /* -------------------------------------------------------- URL injection --- */

  function applyUrlParams() {
    const q = new URLSearchParams(location.search);
    const lat = parseFloat(q.get('lat')), lon = parseFloat(q.get('lon'));
    if (Number.isFinite(lat) && lat >= -90 && lat <= 90) { state.lat = lat; state.placeName = 'Custom location'; }
    if (Number.isFinite(lon) && lon >= -180 && lon <= 180) { state.lon = lon; }
    const tz = q.get('tz');
    if (tz) {
      try { Astro.zoneOffsetMinutes(new Date(), tz); state.tz = tz; }
      catch { console.warn('Unknown time zone in URL; keeping', state.tz); }
    }
    const facing = parseFloat(q.get('facing'));
    if (Number.isFinite(facing)) {
      state.facing = state.targetFacing = Astro.norm360(facing);
    }
    const pitch = parseFloat(q.get('pitch'));
    if (Number.isFinite(pitch)) state.pitch = state.targetPitch = clampPitch(pitch);
    const fov = parseFloat(q.get('fov'));
    if (Number.isFinite(fov)) state.fov = clampFov(fov);
    const scene = parseInt(q.get('scene'), 10);
    if (Number.isInteger(scene)) state.scene = Math.max(0, Math.min(SCENES.length - 1, scene));
    const t = q.get('t');
    if (t) {
      if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(t)) {
        const d = new Date(t);
        if (!Number.isNaN(+d)) { state.date = d; state.live = false; }
      } else {
        const m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
        if (m) {
          state.date = Astro.instantFromZoned({
            year: +m[1], month: +m[2], day: +m[3],
            hour: +(m[4] || 0), minute: +(m[5] || 0), second: 0,
          }, state.tz);
          state.live = false;
        }
      }
    }
  }

  /* ----------------------------------------------------------------- boot --- */

  async function boot() {
    try {
      data = await loadData();
    } catch (err) {
      $('loadError').hidden = false;
      $('loadError').textContent =
        'Could not load the star catalogue. Serve this folder over HTTP ' +
        '(python3 -m http.server) or rebuild data/catalog.js. ' + err;
      return;
    }
    const timeWasInjected = new URLSearchParams(location.search).has('t');
    applyUrlParams();
    // Open on a dark sky, unless the URL asked for a specific moment.
    if (!timeWasInjected) {
      const opening = openingMoment(new Date());
      state.date = opening.date;
      state.live = opening.live;
    }
    fillLocationInputs();
    syncTimeInputs();
    initBackdropRate();
    wire();
    // Redraw once the glyph artwork lands; until then the code-drawn shapes stand in.
    Sky.preloadGlyphs(() => draw());
    draw();
    requestAnimationFrame(loop);

    // astronomy-engine arrives from the CDN after first paint; redraw when it does
    // so the Sun and Moon step up from the built-in series to the precise ones.
    let waited = 0;
    const poll = setInterval(() => {
      waited += 250;
      if (Astro.usableEngine() || waited > 6000) {
        clearInterval(poll);
        if (Astro.usableEngine()) draw();
      }
    }, 250);
  }

  window.__sky = { state, get data() { return data; }, get frame() { return frame; },
                   get computed() { return computed; }, computeSky, draw, lookAt, select,
                   openingMoment, DARK_ENOUGH, SCENES, setScene, revealZodiac,
                   NARRATION, REVEAL_CLIPS, narrationClipsFor, playNarration, stopNarration,
                   acceptReady, isAffirmative, AFFIRMATIVES,
                   startGateListening, stopGateListening,
                   SHAPE_PICK_CLIPS, shapeNumberFor,
                   get cameraStream() { return cameraStream; }, startCamera, stopCamera,
                   autoListenForBirthdate };

  document.addEventListener('DOMContentLoaded', boot);
})();
