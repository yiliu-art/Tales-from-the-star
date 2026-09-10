/*
 * objectTrainer.js — hold a physical object up to the camera, train it against
 * one of the seventeen told constellations, and let live recognition glow the
 * matching one warm orange (see sky.js's `state.detected` handling).
 *
 * Entirely client-side: MediaPipe Tasks Vision's ImageEmbedder (a MobileNetV3
 * -Small embedder, Google's actively-maintained successor to the older
 * @tensorflow-models/mobilenet package this used to run on) turns each frame
 * into a feature vector, and a small hand-rolled k-nearest-neighbours lookup
 * over those vectors — using the library's own static cosineSimilarity — plays
 * the role the `knn-classifier` package used to. Same idea as Google's
 * Teachable Machine: no bounding boxes, no fixed category list, anything held
 * up can become a class because the model is only ever asked "what does this
 * look most similar to among the examples I've been shown," never "what is
 * this" against some fixed vocabulary.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  // Bumped from v1: the old key stored MobileNetV2 tensor-shaped embeddings,
  // which are a different vector space than the ones below and can't be
  // compared against them. Changing the key rather than migrating means any
  // previously trained set (in this browser, or a downloaded .json) needs to
  // be recaptured against the new model — the old data is simply left inert
  // under its old key instead of being read and silently mismatched.
  const LOCAL_KEY = 'talesFromStars.objectTrainer.v2';
  const DATASET_VERSION = 2;

  const TASKS_VISION_VERSION = '1.0.1';
  const TASKS_VISION_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}`;
  const EMBEDDER_MODEL_URL =
    'https://storage.googleapis.com/mediapipe-models/image_embedder/mobilenet_v3_small/float32/1/mobilenet_v3_small.tflite';

  const video = $('trainerVideo');
  // Scene 3's own camera preview (app.js owns starting/stopping it). Frames are
  // read from here whenever that scene is live, so a physical shape held up
  // during the actual "hold up the card" experience can trigger the reveal —
  // not only through this panel's own camera, which is really an operator/
  // training tool most visitors will never open.
  const cardVideo = $('cardCamVideo');
  const trainerStage = $('trainerStage');
  const placeholder = $('trainerPlaceholder');
  const seeingEl = $('trainerSeeing');
  const statusEl = $('trainerStatus');

  const startCamBtn = $('startCamBtn');
  const stopCamBtn = $('stopCamBtn');

  const newObjectName = $('newObjectName');
  const newObjectAbbrev = $('newObjectAbbrev');
  const addObjectBtn = $('addObjectBtn');
  const addObjectError = $('addObjectError');
  const objectList = $('objectList');
  const noObjectsNote = $('noObjectsNote');

  const liveRecognition = $('liveRecognition');
  const thresholdSlider = $('thresholdSlider');
  const thresholdVal = $('thresholdVal');

  const saveDatasetBtn = $('saveDatasetBtn');
  const loadDatasetBtn = $('loadDatasetBtn');
  const loadDatasetInput = $('loadDatasetInput');
  const resetDatasetBtn = $('resetDatasetBtn');
  const datasetStatus = $('datasetStatus');

  const trainBtn = $('trainBtn');
  const trainerPanel = $('trainer');
  const closeTrainer = $('closeTrainer');

  let sky = null; // window.__sky, once app.js has booted
  let constellations = []; // [{ abbrev, name, group }], in the app's own order

  let FilesetResolver = null;
  let ImageEmbedder = null; // the class itself, for its static cosineSimilarity
  let embedder = null;      // the loaded ImageEmbedder instance
  let knn = null;
  let stream = null;
  let running = false;
  let rafId = null;
  let isPredicting = false;
  let threshold = 0.75;
  let lastEmbedTs = -1; // embedForVideo requires strictly increasing timestamps

  function nextTimestamp() {
    let t = Math.round(performance.now());
    if (t <= lastEmbedTs) t = lastEmbedTs + 1;
    lastEmbedTs = t;
    return t;
  }

  let objects = []; // [{ name, abbrev, count }]
  let currentLabel = null;
  let locked = false; // true once currentLabel is a confirmed match — see predictLoop
  let missStreak = 0;
  // While nothing is locked in, every frame is checked for the fastest possible
  // first catch. Once something is, re-running the embedder+KNN every frame would
  // just spend cycles re-confirming the same held-up object — and re-evaluating
  // that often is also where flicker on borderline confidence comes from — so
  // checks drop to this cadence and only speed back up once the object changes or
  // is taken away.
  const LOCKED_CHECK_INTERVAL_MS = 800;
  const LOCKED_MISS_LIMIT = 1; // consecutive misses (at the slower cadence) before releasing
  const CAPTURE_INTERVAL_MS = 2000; // pause between shots in a burst capture, so there's time to turn the object

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = 'ghint' + (kind ? ' ' + kind : '');
  }
  function setDatasetStatus(msg) {
    datasetStatus.textContent = msg;
  }

  /* ------------------------------------------------- waiting for app.js --- */

  function waitForSky(cb) {
    if (window.__sky && window.__sky.data) { cb(); return; }
    setTimeout(() => waitForSky(cb), 50);
  }

  /* -------------------------------------------------------- panel wiring --- */

  function openTrainer() {
    $('panel').hidden = true;
    $('panelBtn').setAttribute('aria-expanded', 'false');
    $('story').hidden = true;
    if (sky) { sky.state.selected = null; sky.draw(); }
    trainerPanel.hidden = false;
    trainBtn.setAttribute('aria-expanded', 'true');
  }
  function hideTrainer() {
    trainerPanel.hidden = true;
    trainBtn.setAttribute('aria-expanded', 'false');
  }

  trainBtn.addEventListener('click', () => {
    if (trainerPanel.hidden) openTrainer(); else hideTrainer();
  });
  closeTrainer.addEventListener('click', hideTrainer);
  $('panelBtn').addEventListener('click', hideTrainer);

  // The story panel can open from places this file doesn't control — clicking a
  // constellation in the sky or in the browse list, double-click zoom, the
  // keyboard shortcuts in app.js — as well as from our own recognition trigger
  // below. All of those funnel through the same #story element, so watching its
  // `hidden` attribute (rather than wrapping every call site) is what keeps the
  // trainer panel from sitting on top of the story it just triggered.
  new MutationObserver(() => {
    if (!$('story').hidden) hideTrainer();
  }).observe($('story'), { attributes: true, attributeFilter: ['hidden'] });

  /* --------------------------------------------------------- model load --- */

  // A minimal drop-in for the old `knnClassifier.create()` object: same method
  // names as the tfjs-based one this replaced, so everything below this
  // section (capture, prediction, dataset save/load) didn't need to change.
  // Examples are stored as plain embedding objects (each carrying a
  // `floatEmbedding` array) rather than tf.Tensors, since ImageEmbedder's
  // static `cosineSimilarity` takes that same shape and there's no GPU-backed
  // tensor lifecycle to manage this way.
  function createKnn() {
    const store = {}; // label -> embedding[]
    return {
      addExample(embedding, label) { (store[label] ||= []).push(embedding); },
      getNumClasses() { return Object.keys(store).length; },
      getClassExampleCount() {
        const counts = {};
        for (const label in store) counts[label] = store[label].length;
        return counts;
      },
      clearClass(label) { delete store[label]; },
      clearAllClasses() { for (const label in store) delete store[label]; },
      predictClass(embedding, k = 3) {
        const ranked = [];
        for (const label in store) {
          for (const ex of store[label]) {
            ranked.push({ label, sim: ImageEmbedder.cosineSimilarity(embedding, ex) });
          }
        }
        ranked.sort((a, b) => b.sim - a.sim);
        const top = ranked.slice(0, k);
        const tally = {};
        for (const t of top) tally[t.label] = (tally[t.label] || 0) + 1;
        let bestLabel = null, bestCount = -1;
        for (const label in tally) if (tally[label] > bestCount) { bestCount = tally[label]; bestLabel = label; }
        const confidences = {};
        for (const label in store) confidences[label] = top.length ? (tally[label] || 0) / top.length : 0;
        return { label: bestLabel, confidences };
      },
      // Serialized form is plain numeric arrays, JSON-safe as-is.
      getClassifierDataset() {
        const out = {};
        for (const label in store) out[label] = store[label].map((e) => Array.from(e.floatEmbedding));
        return out;
      },
      setClassifierDataset(dataset) {
        for (const label in store) delete store[label];
        for (const label in dataset) store[label] = dataset[label].map((arr) => ({ floatEmbedding: arr }));
      },
    };
  }

  // GPU acceleration is preferred (it's the faster path for real-time video),
  // but not every browser/machine has a WebGL delegate available to the WASM
  // runtime, and this is meant to run reliably on whatever laptop is plugged
  // into the installation — so fall back to CPU rather than failing outright.
  async function createEmbedder(vision) {
    const base = {
      baseOptions: { modelAssetPath: EMBEDDER_MODEL_URL },
      runningMode: 'VIDEO',
      l2Normalize: true,
    };
    try {
      return await ImageEmbedder.createFromOptions(vision, {
        ...base, baseOptions: { ...base.baseOptions, delegate: 'GPU' },
      });
    } catch (err) {
      console.warn('GPU delegate unavailable for the embedder, falling back to CPU', err);
      return await ImageEmbedder.createFromOptions(vision, {
        ...base, baseOptions: { ...base.baseOptions, delegate: 'CPU' },
      });
    }
  }

  async function loadModel() {
    try {
      setStatus('Loading recognition engine…');
      ({ FilesetResolver, ImageEmbedder } = await import(`${TASKS_VISION_BASE}/vision_bundle.mjs`));
      const vision = await FilesetResolver.forVisionTasks(`${TASKS_VISION_BASE}/wasm`);
      embedder = await createEmbedder(vision);
      knn = createKnn();
      loadFromLocalStorage();
      setStatus('Ready. Add an object below, then start the camera to capture examples.', 'ok');
      startCamBtn.disabled = false;
      // Runs continuously from here on, independent of this panel's own camera —
      // see predictLoop, which also watches scene 3's camera whenever this
      // panel's isn't the one active.
      rafId = requestAnimationFrame(predictLoop);
    } catch (err) {
      console.error(err);
      setStatus('Could not load the recognition engine. Check your internet connection and reload the page.', 'bad-text');
    }
  }

  /* ------------------------------------------------------------- camera --- */

  async function startCamera() {
    try {
      setStatus('Requesting camera access…');
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 960 }, height: { ideal: 720 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      placeholder.hidden = true;
      startCamBtn.disabled = true;
      stopCamBtn.disabled = false;
      setStatus(knn.getNumClasses() > 0
        ? 'Camera running.'
        : 'Camera running. Capture examples for at least one object to begin recognition.', 'ok');
      running = true;
    } catch (err) {
      console.error(err);
      setStatus('Could not access the camera. Check browser permissions and that no other app is using it.', 'bad-text');
    }
  }

  function stopCamera() {
    running = false;
    // predictLoop itself keeps running (not cancelled here) — stopping this
    // panel's own camera shouldn't also stop watching scene 3's, which is the
    // one real visitors actually use.
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    video.srcObject = null;
    placeholder.hidden = false;
    startCamBtn.disabled = false;
    stopCamBtn.disabled = true;
    seeingEl.hidden = true;
    releaseCurrentLabel();
    setStatus('Camera stopped.');
  }

  startCamBtn.addEventListener('click', startCamera);
  stopCamBtn.addEventListener('click', stopCamera);

  /* --------------------------------------------------- predict + trigger --- */

  let lastCheckTime = 0;

  // Which video to read this tick: this panel's own camera takes priority
  // when it's running (that's an explicit, deliberate testing action), else
  // scene 3's camera if that scene is live and its stream has actually landed
  // — checking `cameraStream` rather than just `scene === 3` avoids reading a
  // video element that's still mid-permission-prompt with no frames yet.
  function activeVideoSource() {
    if (running) return video;
    if (sky && sky.state.scene === 3 && sky.cameraStream && cardVideo && cardVideo.readyState >= 2) {
      return cardVideo;
    }
    return null;
  }

  function predictLoop(timestamp) {
    const source = activeVideoSource();
    // Fully paused while the reveal card is up (scene 4) — the whole point of
    // the reveal is to hold still on one sign, so scanning shouldn't be able to
    // yank it over to a different one mid-read. Resumes the moment the scene
    // changes away from 4, e.g. exiting back to the ordinary sky. `currentLabel`
    // is left untouched across the pause, so if the same object is still in
    // frame when it resumes, the existing "only act on label !== currentLabel"
    // check already stops it from instantly re-triggering the same reveal —
    // nothing extra is needed to avoid that loop.
    const revealShowing = sky && sky.state.scene === 4;
    const dueForLockedCheck = !locked || (timestamp - lastCheckTime >= LOCKED_CHECK_INTERVAL_MS);
    if (source && !revealShowing && knn && knn.getNumClasses() > 0 && !isPredicting && dueForLockedCheck) {
      lastCheckTime = timestamp;
      isPredicting = true;
      predictFrame(source).finally(() => { isPredicting = false; });
    }
    rafId = requestAnimationFrame(predictLoop);
  }

  async function predictFrame(sourceVideo) {
    const embedResult = await embedder.embedForVideo(sourceVideo, nextTimestamp());
    const prediction = knn.predictClass(embedResult.embeddings[0], 3);
    handlePrediction(prediction);
  }

  function handlePrediction(result) {
    const label = result.label;
    const conf = result.confidences[label] || 0;
    const isMatch = conf >= threshold;

    seeingEl.hidden = false;
    seeingEl.textContent = isMatch
      ? `${label} · ${Math.round(conf * 100)}%`
      : `${label} · ${Math.round(conf * 100)}% (below threshold)`;
    seeingEl.classList.toggle('match', isMatch);

    // Detection and the reveal are always active once something is trained —
    // real visitors going through scene 3 never see this panel or its
    // checkbox, so the actual point of this integration can't depend on
    // someone remembering to tick a box first. `liveRecognition` only gates
    // the optional glow-and-turn preview on the sky canvas below, which is
    // mainly useful while testing from scene 0 with this panel open.
    if (isMatch) {
      missStreak = 0;
      if (label !== currentLabel) {
        // Locking on covers both "found a match from a cold scan" and "the object
        // in frame changed" — predictClass always returns whichever trained class
        // is the overall closest, so even at the slower locked-check cadence a
        // swapped-in object naturally overrides the old label the next time this
        // runs, without needing separate logic for the two cases.
        currentLabel = label;
        locked = true;
        const obj = objects.find((o) => o.name === label);
        if (obj && sky) {
          // A glow cue plus a turn to face it — but still no story panel.
          // `state.detected` stays separate from `state.selected`, which
          // remains under manual control: tapping the now-glowing, now-
          // centered constellation still opens its story through the app's
          // own click handling, untouched by this file.
          if (liveRecognition.checked) {
            sky.state.detected = obj.abbrev;
            if (obj.abbrev) turnToConstellation(obj.abbrev);
            sky.draw();
          }
          // One of the twelve zodiac signs also gets the full reveal scene —
          // the birthday-card animation and narration app.js already built for
          // the typed-birthdate flow — so a recognized physical shape does the
          // same job a birth date does there. The five circumpolar figures have
          // no reveal art/narration recorded (they're not "signs"), so they stay
          // glow-and-center only (and only when the checkbox above is on).
          if (isZodiacAbbrev(obj.abbrev) && sky.revealZodiac) sky.revealZodiac(obj.abbrev);
        }
      }
    } else if (locked) {
      // Misses only matter for releasing an existing lock — while nothing is
      // locked on, there's nothing to release, so there's no reason to track them.
      missStreak++;
      if (missStreak > LOCKED_MISS_LIMIT) releaseCurrentLabel();
    }
  }

  // Same centroid-if-up / anchor-if-not logic as the story panel's own "Turn
  // and look at it" button (see app.js's `select`) — replicated here rather
  // than calling `sky.select()`, since that would also select/open the story,
  // which live recognition deliberately doesn't do on its own.
  function turnToConstellation(abbrev) {
    const v = sky.computed && sky.computed.conVisible[abbrev];
    if (!v) return;
    if (v.visibleStars > 0) sky.lookAt(v.centroidAz, v.centroidAlt);
    else sky.lookAt(v.anchorAz, v.anchorAlt);
  }

  function releaseCurrentLabel() {
    missStreak = 0;
    locked = false; // back to checking every frame until the next match
    if (currentLabel !== null) {
      currentLabel = null;
      if (sky) { sky.state.detected = null; sky.draw(); }
    }
  }

  liveRecognition.addEventListener('change', () => {
    if (!liveRecognition.checked) releaseCurrentLabel();
  });

  thresholdSlider.addEventListener('input', () => {
    threshold = Number(thresholdSlider.value) / 100;
    thresholdVal.textContent = thresholdSlider.value + '%';
  });

  /* ---------------------------------------------------- object management --- */

  function conName(abbrev) {
    if (!abbrev) return 'no constellation — suppresses the glow';
    const c = constellations.find((c) => c.abbrev === abbrev);
    return c ? c.name : abbrev;
  }

  function isZodiacAbbrev(abbrev) {
    const c = constellations.find((c) => c.abbrev === abbrev);
    return !!c && c.group === 'zodiac';
  }

  function renderObjectList() {
    objectList.innerHTML = '';
    noObjectsNote.style.display = objects.length ? 'none' : 'block';
    // Newest first: `objects` itself stays in the order objects were added (so
    // save/load and index-based lookups elsewhere are unaffected) — only the
    // on-screen order is reversed, since the object someone just finished
    // training is the one they usually want to see and keep capturing for.
    [...objects].reverse().forEach((o) => {
      const li = document.createElement('li');
      li.className = 'obj-card';
      li.dataset.name = o.name;
      li.innerHTML = `
        <div class="obj-head">
          <span class="obj-name"></span>
          <span class="obj-con"></span>
        </div>
        <div class="obj-count">${o.count} example${o.count === 1 ? '' : 's'} captured</div>
        <div class="obj-actions">
          <button class="btn capture-one">+1</button>
          <button class="btn capture-burst">Capture x10</button>
          <button class="btn clear-examples">Clear</button>
          <button class="btn remove-object">Remove</button>
          <span class="burst-progress"></span>
        </div>`;
      li.querySelector('.obj-name').textContent = o.name;
      li.querySelector('.obj-con').textContent = '→ ' + conName(o.abbrev);
      li.querySelector('.capture-one').addEventListener('click', () => captureExample(o.name, 1));
      li.querySelector('.capture-burst').addEventListener('click', () => captureExample(o.name, 10));
      li.querySelector('.clear-examples').addEventListener('click', () => clearObjectExamples(o.name));
      li.querySelector('.remove-object').addEventListener('click', () => removeObject(o.name));
      objectList.appendChild(li);
    });
  }

  addObjectBtn.addEventListener('click', () => {
    const name = newObjectName.value.trim();
    const abbrev = newObjectAbbrev.value;
    addObjectError.textContent = '';
    if (!name) { addObjectError.textContent = 'Please enter an object name.'; return; }
    if (objects.some((o) => o.name.toLowerCase() === name.toLowerCase())) {
      addObjectError.textContent = 'An object with that name already exists.';
      return;
    }
    objects.push({ name, abbrev, count: 0 });
    newObjectName.value = '';
    renderObjectList();
    persistToLocalStorage();
  });

  // Looked up fresh each tick rather than captured once at click time: a burst
  // spans several seconds now, and nothing should assume the card handed to it
  // is still the one in the DOM (it always is here, since captures only update
  // text in place, but a future add/remove during a burst shouldn't leave this
  // holding a detached element either).
  function findObjectCard(name) {
    return objectList.querySelector(`li[data-name="${CSS.escape(name)}"]`);
  }

  async function captureExample(name, count) {
    if (!stream) { setStatus('Start the camera before capturing examples.', 'bad-text'); return; }
    if (!embedder || !knn) return;
    const buttons = findObjectCard(name)?.querySelectorAll('.capture-one, .capture-burst');
    buttons?.forEach((b) => { b.disabled = true; });
    for (let i = 0; i < count; i++) {
      const embedResult = await embedder.embedForVideo(video, nextTimestamp());
      knn.addExample(embedResult.embeddings[0], name);
      const obj = objects.find((o) => o.name === name);
      if (obj) obj.count += 1;
      const card = findObjectCard(name);
      if (card && obj) {
        card.querySelector('.obj-count').textContent = `${obj.count} example${obj.count === 1 ? '' : 's'} captured`;
        if (count > 1) card.querySelector('.burst-progress').textContent = `${i + 1}/${count}`;
      }
      // Saved after every single shot, not just once the whole burst finishes —
      // a burst now takes ~20 seconds (10 shots, 2s apart), long enough that a
      // refresh or an accidentally-closed tab partway through used to lose the
      // entire burst even though the on-screen counter had already ticked up.
      persistToLocalStorage();
      if (i < count - 1) await new Promise((r) => setTimeout(r, CAPTURE_INTERVAL_MS));
    }
    const finalCard = findObjectCard(name);
    if (finalCard) {
      finalCard.querySelectorAll('.capture-one, .capture-burst').forEach((b) => { b.disabled = false; });
      const progressEl = finalCard.querySelector('.burst-progress');
      setTimeout(() => { progressEl.textContent = ''; }, 1200);
    }
    if (stream) setStatus('Camera running.', 'ok');
  }

  function clearObjectExamples(name) {
    knn.clearClass(name);
    const obj = objects.find((o) => o.name === name);
    if (obj) obj.count = 0;
    renderObjectList();
    persistToLocalStorage();
  }

  function removeObject(name) {
    knn.clearClass(name);
    objects = objects.filter((o) => o.name !== name);
    if (currentLabel === name) releaseCurrentLabel();
    renderObjectList();
    persistToLocalStorage();
  }

  /* -------------------------------------------------- dataset persistence --- */

  function serializeDataset() {
    return {
      version: DATASET_VERSION,
      objects: objects.map((o) => ({ name: o.name, abbrev: o.abbrev })),
      dataset: knn.getClassifierDataset(), // { label: number[][] } — plain and JSON-safe
    };
  }

  function applyDataset(payload) {
    if (!payload || !payload.dataset || !payload.objects) throw new Error('Invalid file format.');
    // A version-1 file was captured against the old MobileNetV2 embedder and
    // its vectors live in a different feature space than this one's — loading
    // it here wouldn't error, it would just silently produce meaningless
    // similarity scores, so it's rejected outright instead.
    if (payload.version !== DATASET_VERSION) {
      throw new Error(`Trained set is from an older version of this tool (v${payload.version ?? 1}) and needs to be recaptured against the current model.`);
    }
    knn.setClassifierDataset(payload.dataset);
    const counts = knn.getClassExampleCount();
    objects = payload.objects.map((o) => ({
      name: o.name, abbrev: o.abbrev, count: counts[o.name] || 0,
    }));
    renderObjectList();
  }

  function persistToLocalStorage() {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(serializeDataset())); }
    catch (err) { console.warn('Could not save trained objects locally', err); }
  }

  function loadFromLocalStorage() {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      if (!raw) return;
      applyDataset(JSON.parse(raw));
      setDatasetStatus(`Restored ${objects.length} object(s) from this browser.`);
    } catch (err) {
      console.warn('Could not restore locally saved trained objects', err);
    }
  }

  saveDatasetBtn.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(serializeDataset())], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tales-from-stars-objects.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setDatasetStatus('Trained set downloaded.');
  });

  loadDatasetBtn.addEventListener('click', () => loadDatasetInput.click());
  loadDatasetInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        applyDataset(JSON.parse(reader.result));
        persistToLocalStorage();
        setDatasetStatus(`Loaded ${objects.length} object(s) from file.`);
      } catch (err) {
        console.error(err);
        setDatasetStatus('Could not read that file — is it a trained set exported from this tool?');
      }
      loadDatasetInput.value = '';
    };
    reader.readAsText(file);
  });

  resetDatasetBtn.addEventListener('click', () => {
    knn.clearAllClasses();
    objects = [];
    releaseCurrentLabel();
    renderObjectList();
    persistToLocalStorage();
    setDatasetStatus('All objects and examples cleared.');
  });

  /* ------------------------------------------------------------------ boot --- */

  waitForSky(() => {
    sky = window.__sky;
    constellations = sky.data.constellations.map((c) => ({ abbrev: c.abbrev, name: c.name, group: c.group }));
    // A KNN classifier always names its closest trained class, even for a frame
    // that matches none of them well — so without an explicit negative class,
    // an empty scene (or just a face) gets pinned on whichever object's
    // training happened to look most similar. Mapping an object to "no
    // constellation" gives recognition a legitimate place to land instead.
    newObjectAbbrev.add(new Option('No constellation (background / ignore)', ''));
    constellations.forEach((c) => newObjectAbbrev.add(new Option(`${c.name} (${c.group === 'zodiac' ? 'zodiac' : 'circumpolar'})`, c.abbrev)));
    renderObjectList();
    loadModel();
  });

  window.addEventListener('beforeunload', () => {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (embedder) embedder.close();
  });
})();
