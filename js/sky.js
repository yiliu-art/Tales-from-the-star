/*
 * sky.js — naked-eye horizon view.
 *
 * You are standing outside facing a compass direction. The horizon runs along the
 * bottom, stars sit above it, and swinging left or right turns you on the spot.
 *
 * Projection: stereographic, centred on wherever you are looking. A star's angular
 * distance t from the centre of view maps to a radius of 2*tan(t/2), which keeps
 * constellation shapes recognisable right out to the edge of a wide field of view —
 * a plain perspective projection would stretch the corners badly at 110 degrees.
 */
const Sky = (() => {
  'use strict';

  const DEG = Math.PI / 180;
  const RAD = 180 / Math.PI;

  const COMPASS = [
    [0, 'N'], [22.5, 'NNE'], [45, 'NE'], [67.5, 'ENE'],
    [90, 'E'], [112.5, 'ESE'], [135, 'SE'], [157.5, 'SSE'],
    [180, 'S'], [202.5, 'SSW'], [225, 'SW'], [247.5, 'WSW'],
    [270, 'W'], [292.5, 'WNW'], [315, 'NW'], [337.5, 'NNW'],
  ];

  // Sky colour by twilight band: [zenith, horizon]. The horizon is always a little
  // lighter than the zenith — airglow and distant light do that in real skies.
  const SKY_TINT = {
    day:          [[38, 92, 150], [150, 186, 214]],
    civil:        [[16, 33, 62], [92, 104, 132]],
    nautical:     [[10, 19, 40], [44, 56, 84]],
    astronomical: [[6, 12, 27], [24, 33, 55]],
    night:        [[3, 6, 15], [16, 23, 41]],
  };

  const rgb = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  // The camera-recognition glow: a warm orange, independent of the zodiac/
  // circumpolar palette above, so a detected object always reads the same way
  // regardless of which of the seventeen it lands on.
  const DETECT_GLOW = [255, 150, 60];

  /* ---------------------------------------------------------- view frame --- */

  /** Horizon-frame unit vector. x -> north, y -> east, z -> up. */
  function toVec(alt, az) {
    const a = alt * DEG, z = az * DEG, ca = Math.cos(a);
    return { x: ca * Math.cos(z), y: ca * Math.sin(z), z: Math.sin(a) };
  }

  /**
   * Orthonormal basis for a view direction: f forward, r to the viewer's right,
   * u up. Facing north, "right" is east — the way it works when you stand there.
   */
  function viewFrame(facingAz, pitchAlt) {
    const f = toVec(pitchAlt, facingAz);
    const A = facingAz * DEG;
    const r = { x: -Math.sin(A), y: Math.cos(A), z: 0 };
    const u = {                              // u = f x r
      x: f.y * r.z - f.z * r.y,
      y: f.z * r.x - f.x * r.z,
      z: f.x * r.y - f.y * r.x,
    };
    return { f, r, u };
  }

  /**
   * alt/az -> screen. Returns null for anything behind the viewer.
   * `depth` is the cosine of the angle from the centre of view, handy for fading
   * things out towards the edge of vision.
   */
  function project(alt, az, view) {
    const s = toVec(alt, az);
    const { frame, scale, cx, cy } = view;
    const sz = s.x * frame.f.x + s.y * frame.f.y + s.z * frame.f.z;
    if (sz <= -0.2) return null;                    // well behind the viewer
    const denom = 1 + sz;
    if (denom < 1e-6) return null;
    const sx = s.x * frame.r.x + s.y * frame.r.y + s.z * frame.r.z;
    const sy = s.x * frame.u.x + s.y * frame.u.y + s.z * frame.u.z;
    return {
      x: cx + (2 * sx / denom) * scale,
      y: cy - (2 * sy / denom) * scale,
      depth: sz,
    };
  }

  // On a very wide, short window the vertical field can shrink so far that the
  // horizon and compass fall off the bottom and there is no way to orient. This is
  // the vertical half-field defended against that, at the reference zoom — and it
  // scales with the requested field of view, because a fixed floor would override
  // a deliberate zoom instead of merely protecting the wide default.
  const MIN_VERTICAL_HALF_FOV = 34;
  const REFERENCE_FOV = 110;

  /**
   * Per-frame view parameters. `fovDeg` is the requested horizontal field; it is
   * widened automatically when the canvas is too short to show enough sky
   * vertically, so the horizon always stays reachable.
   */
  function makeView(w, h, facingAz, pitchAlt, fovDeg, bottomInset = 0) {
    // Clamp here as well as at the input handlers: a degenerate field of view
    // renders nonsense, and the projection should not depend on every caller
    // having remembered to bound it.
    fovDeg = Math.max(10, Math.min(170, fovDeg || 110));
    pitchAlt = Math.max(-89, Math.min(89, pitchAlt || 0));
    // The time controls sit over the bottom of the canvas, so the usable height is
    // less than the canvas height. Fit the sky to that, and lift the centre of view,
    // so the skyline and its compass labels stay clear of the controls.
    const usableH = Math.max(120, h - bottomInset);
    const vHalf = MIN_VERTICAL_HALF_FOV * (fovDeg / REFERENCE_FOV);
    const rH = 2 * Math.tan((fovDeg / 2) * DEG / 2);
    const rV = 2 * Math.tan(vHalf * DEG / 2);
    // The smaller scale wins, i.e. whichever constraint demands more sky on screen.
    const scale = Math.min((w / 2) / rH, (usableH / 2) / rV);
    return {
      frame: viewFrame(facingAz, pitchAlt),
      scale,
      cx: w / 2,
      cy: usableH / 2,
      w, h, usableH, facingAz, pitchAlt, fovDeg,
      // What is actually on screen, once the constraint above has been applied.
      effectiveHalfFovH: 2 * Math.atan((w / 2) / scale / 2) * RAD,
      effectiveHalfFovV: 2 * Math.atan((usableH / 2) / scale / 2) * RAD,
    };
  }

  /* ------------------------------------------------------- galactic plane --- */

  // J2000 galactic pole and the galactic longitude of the north celestial pole.
  const GAL_POLE_RA = 192.85948, GAL_POLE_DEC = 27.12825, GAL_L_NCP = 122.93192;

  /** Galactic (l, b) in degrees -> J2000 equatorial (RA hours, Dec degrees). */
  function galacticToEquatorial(l, b) {
    const dG = GAL_POLE_DEC * DEG, aG = GAL_POLE_RA * DEG;
    const lb = (GAL_L_NCP - l) * DEG, bb = b * DEG;
    const sinDec = Math.sin(dG) * Math.sin(bb) + Math.cos(dG) * Math.cos(bb) * Math.cos(lb);
    const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
    const y = Math.cos(bb) * Math.sin(lb);
    const x = Math.cos(dG) * Math.sin(bb) - Math.sin(dG) * Math.cos(bb) * Math.cos(lb);
    const ra = aG + Math.atan2(y, x);
    return { ra: (((ra * RAD) % 360 + 360) % 360) / 15, dec: dec * RAD };
  }

  /**
   * The Milky Way, built from soft additive blobs strung along the galactic
   * equator. Blobs rather than one wide stroke because they overlap into an
   * uneven, patchy glow — closer to what the eye actually sees than a clean band.
   * Brightness peaks towards the galactic centre in Sagittarius and thins out
   * near Auriga on the far side, and a slow modulation stands in for the dust
   * lanes of the Great Rift.
   */
  function drawMilkyWay(ctx, view, astroCtx, dim) {
    if (dim < 0.08) return;
    const { jd, lstDeg, lat } = astroCtx;
    // Screen pixels per degree near the centre of view, so the band is sized in
    // degrees of sky rather than in pixels.
    const pxPerDeg = view.scale * DEG;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let l = 0; l <= 360; l += 2) {
      const toCentre = Math.abs(((l + 180) % 360) - 180);
      // Bright and broad towards Sagittarius, thin and faint opposite.
      const bright = 0.30 + 0.70 * Math.pow(Math.cos((toCentre / 2) * DEG), 2.2);
      const rift = 0.78 + 0.22 * Math.sin(l * 3.1 * DEG) * Math.cos(l * 1.7 * DEG);
      const widthDeg = 7 + 9 * bright;

      const eq = galacticToEquatorial(l, 0);
      const pr = Astro.precessFromJ2000(eq.ra, eq.dec, jd);
      const hz = Astro.equatorialToHorizontal(pr.ra, pr.dec, lstDeg, lat);
      if (hz.alt < -3) continue;
      const p = project(hz.alt, hz.az, view);
      if (!p || p.depth < 0.12) continue;

      // Fade into the horizon murk, and out towards the edge of vision.
      const horizonFade = Math.min(1, Math.max(0, (hz.alt + 1) / 14));
      const edgeFade = Math.min(1, (p.depth - 0.12) * 2.2);
      const alpha = 0.020 * bright * rift * horizonFade * edgeFade * dim;
      if (alpha < 0.0012) continue;

      const r = widthDeg * pxPerDeg;
      if (r < 1 || p.x < -r || p.x > view.w + r || p.y < -r || p.y > view.h + r) continue;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      g.addColorStop(0, `rgba(188,203,236,${alpha})`);
      g.addColorStop(0.55, `rgba(170,188,228,${alpha * 0.45})`);
      g.addColorStop(1, 'rgba(150,175,225,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /* -------------------------------------------------------------- ground --- */

  /** The horizon as a screen polyline, sampled in azimuth around the viewer. */
  function horizonCurve(view) {
    const pts = [];
    for (let d = -180; d <= 180; d += 1.5) {
      const p = project(0, view.facingAz + d, view);
      if (p && p.depth > 0.02) pts.push(p);
    }
    return pts.sort((a, b) => a.x - b.x);
  }

  /**
   * The ground, as a translucent veil rather than an opaque fill. You can look
   * below the horizon to hunt for a constellation that has already set, so what is
   * down there has to stay faintly visible — the veil darkens it the way the Earth
   * would, without hiding it. `opacity` 1 gives a solid horizon again.
   */
  function drawGround(ctx, view, pts, sunGlow, opacity = 0.66) {
    if (!pts.length) return;
    const { w, h } = view;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-20, pts[0].y);
    for (const p of pts) ctx.lineTo(p.x, p.y);
    ctx.lineTo(w + 20, pts[pts.length - 1].y);
    ctx.lineTo(w + 20, h + 20);
    ctx.lineTo(-20, h + 20);
    ctx.closePath();

    const top = Math.min(...pts.map((p) => p.y));
    const g = ctx.createLinearGradient(0, top, 0, h);
    g.addColorStop(0, `rgba(10,13,20,${0.86 * opacity})`);
    g.addColorStop(0.25, `rgba(5,7,12,${0.97 * opacity})`);
    g.addColorStop(1, `rgba(2,3,6,${opacity})`);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();

  }

  /**
   * The horizon, as a thin dotted line with the word on it. Once you can look below
   * the horizon, the boundary stops being self-evident from the shading alone, so it
   * gets named rather than merely implied. Drawn whether or not the ground is on.
   */
  function drawHorizonLine(ctx, view, pts, scale, sunGlow) {
    if (!pts.length) return;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts) ctx.lineTo(p.x, p.y);
    ctx.setLineDash([1.5 * scale, 4.5 * scale]);
    ctx.lineWidth = Math.max(1, 1.1 * scale);
    ctx.lineCap = 'round';
    // Warms towards the Sun at dusk, the way a real skyline does.
    ctx.strokeStyle = sunGlow > 0.06
      ? `rgba(214,178,138,${0.34 + 0.34 * sunGlow})`
      : 'rgba(158,180,214,0.42)';
    ctx.stroke();
    ctx.setLineDash([]);

    // Label it, on the stretch of horizon nearest the middle of the view.
    let anchor = pts[0];
    for (const p of pts) {
      if (Math.abs(p.x - view.cx) < Math.abs(anchor.x - view.cx)) anchor = p;
    }
    const label = 'horizon';
    ctx.font = `500 ${9.5 * scale}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(label).width + 10 * scale;
    // Offset to one side of centre so it does not collide with the compass marks,
    // which sit directly on the cardinal points.
    const lx = Math.min(view.w - tw, Math.max(tw, anchor.x - 132 * scale));
    let ly = anchor.y;
    for (const p of pts) if (Math.abs(p.x - lx) < 3) ly = p.y;

    // Break the dotted line so the word sits in a gap rather than on top of it.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.ellipse(lx, ly, tw / 2, 6 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    ctx.fillStyle = sunGlow > 0.06
      ? `rgba(222,192,158,${0.6 + 0.3 * sunGlow})`
      : 'rgba(168,190,222,0.62)';
    ctx.fillText(label, lx, ly);
    ctx.restore();
  }

  function drawCompass(ctx, view, pts, scale) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const [az, name] of COMPASS) {
      const p = project(0, az, view);
      if (!p || p.depth < 0.18) continue;
      if (p.x < -30 || p.x > view.w + 30) continue;
      const major = name.length === 1;
      const minor = name.length === 3;
      if (minor && view.fovDeg > 130) continue;      // too crowded when zoomed out

      ctx.globalAlpha = Math.min(1, (p.depth - 0.25) * 3) * (major ? 0.92 : minor ? 0.4 : 0.62);
      ctx.fillStyle = major ? '#dbe6f4' : '#93a3bd';
      ctx.font = `${major ? 700 : 500} ${(major ? 13 : 10.5) * scale}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillText(name, p.x, p.y + 7 * scale);

      ctx.globalAlpha *= 0.5;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 4 * scale);
      ctx.lineTo(p.x, p.y + 3 * scale);
      ctx.strokeStyle = major ? '#dbe6f4' : '#93a3bd';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ----------------------------------------------------------- the sky bg --- */

  /**
   * @param skyAlpha 1 paints an opaque sky; less than 1 lets the deep-space plate
   *   behind the canvas show through. Daylight is always opaque — a nebula has no
   *   business showing through a blue sky.
   */
  function drawSkyBackground(ctx, view, twilightKey, sunMoon, dim, skyAlpha = 1) {
    const [zen, hor] = SKY_TINT[twilightKey] || SKY_TINT.night;
    const { w, h } = view;

    // Vertical wash: find where the horizon sits so the gradient tracks it.
    const hp = project(0, view.facingAz, view);
    const horizonY = hp ? Math.max(0, Math.min(h, hp.y)) : h * 0.78;
    const g = ctx.createLinearGradient(0, Math.min(0, horizonY - h), 0, horizonY);
    g.addColorStop(0, rgb(zen, skyAlpha));
    g.addColorStop(0.72, rgb(zen.map((v, i) => (v + hor[i]) / 2), skyAlpha));
    // Keep the horizon band close to opaque so the plate does not bleed into the
    // skyline, where it would read as haze sitting in front of the ground.
    g.addColorStop(1, rgb(hor, Math.min(1, skyAlpha + 0.3)));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // Twilight glow in the direction of the Sun, even while it is below the horizon.
    if (!sunMoon) return 0;
    const sun = sunMoon.sun;
    const strength = Math.max(0, Math.min(1, (sun.alt + 17) / 17));
    if (strength <= 0.02) return 0;
    const sp = project(Math.max(sun.alt, -14), sun.az, view);
    if (!sp) return strength;
    const radius = Math.max(w, h) * (0.55 + 0.35 * strength);
    const glow = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, radius);
    const warm = sun.alt > -2 ? [255, 190, 130] : [210, 140, 110];
    glow.addColorStop(0, rgb(warm, 0.42 * strength * dim));
    glow.addColorStop(0.45, rgb([120, 110, 140], 0.16 * strength * dim));
    glow.addColorStop(1, rgb([60, 70, 110], 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    return strength;
  }

  /* --------------------------------------------------------------- stars --- */

  /** Apparent size of a star to the eye: brighter reads as bigger and softer. */
  function starRadius(mag, scale) {
    return Math.max(0.5, (1.35 + (4.6 - mag) * 0.62) * scale);
  }

  function drawStar(ctx, p, mag, scale, alpha, twinkle) {
    const r = starRadius(mag, scale) * twinkle;
    const a = alpha * Math.min(1, 1.18 - mag * 0.055);

    if (mag < 2.6) {
      const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 4.6);
      halo.addColorStop(0, `rgba(255,253,244,${0.34 * a})`);
      halo.addColorStop(0.4, `rgba(214,228,255,${0.11 * a})`);
      halo.addColorStop(1, 'rgba(180,205,255,0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 4.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,252,242,${a})`;
    ctx.fill();
  }

  /* -------------------------------------------------------- star glyphs --- */

  /*
   * Decorative glyphs drawn over the stars of the seventeen told constellations.
   *
   * The system comes from tools/star-glyphs.json: a glyph id per star chosen by
   * brightness rank (rank 0, the brightest, gets g4 — the big one, outer radius
   * 180 against everyone else's 100), and a size from magnitude via
   * clamp(0.42 - (mag - 0.85) * 0.055, 0.16, 0.42).
   *
   * That file carries no artwork, only ids and radii, so the seven shapes are drawn
   * here. Each is defined in a unit space where 1.0 is the file's 100 units, so g4
   * genuinely reaches out to 1.8 and the collision radii in the spec still hold.
   * Swapping in real artwork means replacing these seven cases and nothing else.
   */

  // Pixel length of one unit glyph radius at scale 1.
  const GLYPH_BASE_PX = 22;
  const GLYPH_PX_MIN = 2.2, GLYPH_PX_MAX = 13;

  /*
   * How drawn things scale with the zoom. Applied to both the stars and the glyphs,
   * so that closing in on a figure enlarges the whole picture together rather than
   * growing the decoration while the stars stay put.
   *
   * It follows the zoom only part way. Anchoring to a true angular size swells
   * everything into blobs the moment you zoom in; pinning to a fixed screen size
   * leaves the sky crowded when you pull back, which is the wider, denser view. So
   * the size tracks the zoom with a damped exponent and hard limits at both ends.
   *
   * Stars and glyphs use different floors, because they had different problems.
   * The glyphs were genuinely too big pulled back and are allowed to shrink below
   * their default. The star dots never were, and the wide view is exactly where you
   * want to take in the whole sky — thinning them there would only make it emptier.
   * So stars are floored at their current size and can grow but never shrink.
   */
  const ZOOM_SIZE_DAMPING = 0.6;
  const ZOOM_SIZE_MAX = 1.5;
  const ZOOM_SIZE_MIN_GLYPH = 0.6;
  const ZOOM_SIZE_MIN_STAR = 1.0;

  function zoomSizeFactor(fovDeg, minFactor = ZOOM_SIZE_MIN_GLYPH) {
    const f = Math.pow(REFERENCE_FOV / Math.max(1, fovDeg), ZOOM_SIZE_DAMPING);
    return Math.max(minFactor, Math.min(ZOOM_SIZE_MAX, f));
  }

  /* --- the supplied artwork ------------------------------------------------ *
   * assets/glyphs/ holds the real glyphs: SVG as the source of truth and a 512px
   * white PNG of each for rendering. The PNGs are what get drawn, for two
   * reasons: an SVG loaded through an <img> cannot inherit `currentColor` from the
   * page, so it could not be tinted; and <img> needs no fetch, so the artwork also
   * works when index.html is opened straight from disk, where fetching local files
   * is blocked.
   *
   * Tinting keeps the artwork's alpha and replaces its colour, via a 'source-in'
   * composite into an offscreen canvas — cached per id and colour, so it happens
   * seven times per palette rather than once per star per frame.
   */
  const GLYPH_IDS = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'];
  const GLYPH_RASTER_PX = 256;   // ample: a glyph never draws wider than ~90px

  const glyphArt = { started: false, ready: false, loaded: 0, failed: 0,
                     raw: {}, tinted: new Map(), onReady: null };

  /** Kick off loading. `onReady` fires once, so the sky can redraw with the art. */
  function preloadGlyphs(onReady) {
    if (glyphArt.started) return;
    glyphArt.started = true;
    glyphArt.onReady = onReady;
    for (const id of GLYPH_IDS) {
      const img = new Image();
      img.onload = () => {
        glyphArt.raw[id] = img;
        settleGlyphLoad();
      };
      // A missing or broken file is not fatal: drawGlyph falls back to the shapes
      // drawn in code, so the chart still works.
      img.onerror = () => { glyphArt.failed++; settleGlyphLoad(); };
      img.src = `assets/glyphs/png/${id}.png`;
    }
  }

  function settleGlyphLoad() {
    if (++glyphArt.loaded < GLYPH_IDS.length) return;
    glyphArt.ready = glyphArt.failed === 0;
    if (glyphArt.ready && glyphArt.onReady) glyphArt.onReady();
  }

  function tintedGlyph(id, colour) {
    const key = `${id}|${colour}`;
    const hit = glyphArt.tinted.get(key);
    if (hit) return hit;
    const img = glyphArt.raw[id];
    if (!img) return null;
    const c = document.createElement('canvas');
    c.width = c.height = GLYPH_RASTER_PX;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, GLYPH_RASTER_PX, GLYPH_RASTER_PX);
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = colour;
    x.fillRect(0, 0, GLYPH_RASTER_PX, GLYPH_RASTER_PX);
    glyphArt.tinted.set(key, c);
    return c;
  }

  const glyphScaleFromMag = (mag) =>
    Math.max(0.16, Math.min(0.42, 0.42 - (mag - 0.85) * 0.055));

  /** An n-pointed star, alternating between long and short radii. */
  function starPath(ctx, x, y, n, rLong, rShort, rot = -Math.PI / 2) {
    ctx.beginPath();
    for (let i = 0; i < n * 2; i++) {
      const r = i % 2 === 0 ? rLong : rShort;
      const a = rot + (i * Math.PI) / n;
      const px = x + r * Math.cos(a);
      const py = y + r * Math.sin(a);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  /**
   * Draw one glyph. `r` is the pixel length of one unit radius, so a shape reaching
   * 1.8 in unit space is drawn out to 1.8 * r.
   * @param {string} id one of g1..g7
   * @param {number[]} tint constellation group colour
   */
  function drawGlyph(ctx, id, x, y, r, tint, alpha) {
    // Real artwork if it loaded, otherwise the shapes drawn below.
    const art = glyphArt.ready ? tintedGlyph(id, rgb(tint, 1)) : null;
    if (art) {
      // Every glyph shares a 400-unit canvas, and a glyph's outer radius is its
      // glyphOuterRadius in those units. So if 100 units is r pixels, the canvas is
      // 4r pixels square — the same for all seven, which is exactly how g4 comes
      // out 1.8x the others without any special casing.
      const size = 4 * r;
      ctx.save();
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.drawImage(art, x - size / 2, y - size / 2, size, size);
      ctx.restore();
      return;
    }

    ctx.save();
    const line = rgb(tint, alpha);
    const core = `rgba(255,253,246,${Math.min(1, alpha * 1.15)})`;

    switch (id) {
      case 'g4': {
        // The brightest star of the figure: four long rays and four short ones.
        const halo = ctx.createRadialGradient(x, y, 0, x, y, r * 1.8);
        halo.addColorStop(0, rgb(tint, alpha * 0.30));
        halo.addColorStop(0.3, rgb(tint, alpha * 0.09));
        halo.addColorStop(1, rgb(tint, 0));
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(x, y, r * 1.8, 0, Math.PI * 2);
        ctx.fill();

        starPath(ctx, x, y, 4, r * 1.8, r * 0.28);
        ctx.fillStyle = rgb(tint, alpha * 0.8);
        ctx.fill();
        starPath(ctx, x, y, 4, r * 0.58, r * 0.11, -Math.PI / 4);
        ctx.fillStyle = line;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, r * 0.2, 0, Math.PI * 2);
        ctx.fillStyle = core;
        ctx.fill();
        break;
      }
      case 'g5':
        starPath(ctx, x, y, 8, r, r * 0.21);
        ctx.fillStyle = rgb(tint, alpha * 0.85);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, r * 0.17, 0, Math.PI * 2);
        ctx.fillStyle = core;
        ctx.fill();
        break;

      case 'g3':
        starPath(ctx, x, y, 6, r * 0.98, r * 0.19);
        ctx.fillStyle = rgb(tint, alpha * 0.85);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, r * 0.15, 0, Math.PI * 2);
        ctx.fillStyle = core;
        ctx.fill();
        break;

      case 'g1':
        // A slim four-point sparkle.
        starPath(ctx, x, y, 4, r, r * 0.11);
        ctx.fillStyle = rgb(tint, alpha * 0.9);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, r * 0.13, 0, Math.PI * 2);
        ctx.fillStyle = core;
        ctx.fill();
        break;

      case 'g7':
        starPath(ctx, x, y, 5, r, r * 0.22);
        ctx.fillStyle = rgb(tint, alpha * 0.85);
        ctx.fill();
        break;

      case 'g2':
        // Core inside a thin ring.
        ctx.beginPath();
        ctx.arc(x, y, r * 0.58, 0, Math.PI * 2);
        ctx.strokeStyle = rgb(tint, alpha * 0.7);
        ctx.lineWidth = Math.max(0.5, r * 0.075);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, r * 0.24, 0, Math.PI * 2);
        ctx.fillStyle = core;
        ctx.fill();
        break;

      case 'g6':
      default:
        // The plainest of the seven: a core with four short ticks.
        ctx.strokeStyle = rgb(tint, alpha * 0.8);
        ctx.lineWidth = Math.max(0.6, r * 0.1);
        for (let i = 0; i < 4; i++) {
          const a = (i * Math.PI) / 2;
          ctx.beginPath();
          ctx.moveTo(x + Math.cos(a) * r * 0.42, y + Math.sin(a) * r * 0.42);
          ctx.lineTo(x + Math.cos(a) * r * 0.85, y + Math.sin(a) * r * 0.85);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(x, y, r * 0.2, 0, Math.PI * 2);
        ctx.fillStyle = core;
        ctx.fill();
        break;
    }
    ctx.restore();
  }

  /**
   * Draw the collected glyphs, brightest first, skipping any that would collide.
   * The spec flags Shaula and Lesath in Scorpius as ~0.2 degrees apart, which is a
   * clash once they are wearing glyphs; this generalises that to every pair.
   */
  function drawGlyphs(ctx, candidates, outerRadius) {
    candidates.sort((a, b) => a.mag - b.mag);
    const placed = [];
    for (const c of candidates) {
      const outer = c.r * ((outerRadius[c.id] || 100) / 100);
      let clash = false;
      for (const p of placed) {
        if (Math.hypot(c.x - p.x, c.y - p.y) < 0.68 * (outer + p.outer)) { clash = true; break; }
      }
      if (clash) continue;
      placed.push({ x: c.x, y: c.y, outer });
      drawGlyph(ctx, c.id, c.x, c.y, c.r, c.tint, c.alpha);
    }
    return placed.length;
  }

  /* ------------------------------------------------------------- drawing --- */

  function render(canvas, state, data, computed, anim) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || 500;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const view = makeView(w, h, state.facing, state.pitch, state.fov, state.bottomInset || 0);
    const scale = Math.max(0.8, Math.min(1.5, w / 900));
    const { starAltAz, conVisible, sunMoon, twilightKey, astroCtx } = computed;

    // Daylight washes the stars out, exactly as it does outdoors.
    const dayWash = Math.max(0, Math.min(1, (sunMoon.sun.alt + 6) / 12));
    const starDim = 1 - 0.92 * dayWash;

    // Show the plate through the sky only once it is genuinely dark, and fade it
    // out as the Sun comes up so dusk washes it away the way real light does.
    const skyAlpha = state.showBackdrop
      ? Math.min(1, 0.26 + 0.74 * dayWash + 0.30 * Math.max(0, (sunMoon.sun.alt + 18) / 18))
      : 1;
    const sunGlow = drawSkyBackground(ctx, view, twilightKey, sunMoon, 1, skyAlpha);
    if (state.showMilkyWay) drawMilkyWay(ctx, view, astroCtx, starDim);

    const hit = { constellations: [], stars: [], view };
    const groupShown = (g) => (g === 'circumpolar' ? state.showCircumpolar : state.showZodiac);
    const now = anim ? anim.t : 0;
    // A slow breathing pulse, not a blink — 0.55..1 so the glow never fully dims.
    const detectPulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(now * 2.6));

    /* ---- constellation figures ---- */
    for (const con of data.constellations) {
      if (!groupShown(con.group)) continue;
      const selected = state.selected === con.abbrev;
      const hovered = state.hovered === con.abbrev;
      const muted = state.selected && !selected;
      const detected = state.detected === con.abbrev;
      const segments = [];

      for (const [i, j] of con.lines) {
        const A = starAltAz[i], B = starAltAz[j];
        const pa = project(A.alt, A.az, view);
        const pb = project(B.alt, B.az, view);
        if (!pa || !pb || pa.depth < 0.05 || pb.depth < 0.05) continue;
        segments.push([pa.x, pa.y, pb.x, pb.y]);
      }
      if (!segments.length) continue;

      if (state.showLines || selected || hovered) {
        ctx.save();
        // Gold for the twelve of the zodiac, muted grey-blue for the five extras.
        const base = con.group === 'circumpolar' ? [147, 168, 196] : [227, 199, 127];
        let alpha = state.showLines ? 0.34 : 0;
        if (hovered) alpha = 0.7;
        if (selected) alpha = 0.95;
        if (muted && !hovered) alpha *= 0.32;
        ctx.strokeStyle = rgb(base, alpha * starDim);
        ctx.lineWidth = (selected ? 1.5 : 1) * scale;
        ctx.lineCap = 'round';
        if (selected) {
          ctx.shadowColor = rgb(base, 0.5);
          ctx.shadowBlur = 7 * scale;
        }
        ctx.beginPath();
        for (const [x1, y1, x2, y2] of segments) {
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
        }
        ctx.stroke();
        ctx.restore();
      }

      // Recognition glow: a separate additive pass in warm orange, layered over
      // whatever the browsing state above already drew. Deliberately independent
      // of `selected`/`muted` — being recognized by the camera should read the
      // same whether or not someone is also mid-browse of a different figure.
      if (detected) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = rgb(DETECT_GLOW, (0.55 + 0.4 * detectPulse) * starDim);
        ctx.lineWidth = (2.2 + 1.3 * detectPulse) * scale;
        ctx.lineCap = 'round';
        ctx.shadowColor = rgb(DETECT_GLOW, 0.9);
        ctx.shadowBlur = (16 + 12 * detectPulse) * scale;
        ctx.beginPath();
        for (const [x1, y1, x2, y2] of segments) {
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
        }
        ctx.stroke();
        ctx.restore();
      }

      hit.constellations.push({ abbrev: con.abbrev, con, segments, label: null });
    }

    /* ---- stars ---- */
    const glyphCandidates = [];
    // Glyphs may shrink when pulled back; stars only ever grow.
    const zoomSize = zoomSizeFactor(view.fovDeg);
    const starScale = scale * zoomSizeFactor(view.fovDeg, ZOOM_SIZE_MIN_STAR);
    for (let i = 0; i < data.stars.length; i++) {
      const s = data.stars[i];
      const hz = starAltAz[i];
      // Stars in one of the 17 told constellations follow its toggle; every other
      // star in the catalogue is plain sky and is always drawn.
      const owner = data.conByAbbrev[s.c];
      if (owner && !groupShown(owner.group)) continue;

      // How dark the observer's sky is. Stars do not wink out at a hard limit —
      // the last half magnitude fades towards the threshold of seeing, and
      // everything is harder to catch low down through thicker, murkier air.
      // Below the horizon there is no air to look through, so no extinction; the
      // ground veil drawn over them is what makes them read as "already set".
      const below = hz.alt < 0;
      const extinction = below ? 0 : 0.9 * Math.max(0, 1 - hz.alt / 25);
      const effLimit = state.magLimit - extinction;
      if (s.m > effLimit) continue;
      const limitFade = Math.min(1, (effLimit - s.m) / 0.5 + 0.35);

      const p = project(hz.alt, hz.az, view);
      if (!p || p.depth < 0.04) continue;
      if (p.x < -40 || p.x > w + 40 || p.y < -40 || p.y > h + 40) {
        hit.stars.push({ x: p.x, y: p.y, r: 0, star: s, conAbbrev: s.c });
        continue;
      }

      // Scintillation: real and strongest for stars low down, through more air.
      let tw = 1;
      if (anim && anim.twinkle) {
        const lowness = Math.max(0, 1 - hz.alt / 40);
        const amp = 0.06 + 0.16 * lowness;
        tw = 1 + amp * Math.sin(now * (1.7 + (i % 7) * 0.31) + i * 2.399);
      }
      const edgeFade = Math.min(1, (p.depth - 0.04) * 4);
      const muted = state.selected && (!owner || owner.abbrev !== state.selected);
      drawStar(ctx, p, s.m, starScale,
        starDim * edgeFade * limitFade * (muted ? 0.4 : 1), tw);

      // A soft orange bloom over every figure star of the recognized
      // constellation — the same breathing pulse as its lines, additive so it
      // reads as light rather than a repaint of the star itself. Sized from
      // `starScale` (not the plain zoom-independent `scale`) so the glow stays
      // proportionate to the star it's wrapped around at any zoom level.
      if (owner && owner.abbrev === state.detected) {
        const r = starRadius(s.m, starScale) * (2.4 + 1.4 * detectPulse);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        halo.addColorStop(0, rgb(DETECT_GLOW, 0.55 * starDim * edgeFade));
        halo.addColorStop(1, rgb(DETECT_GLOW, 0));
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // Glyphs mark the zodiac only. The five circumpolar figures keep their lines,
      // names and stories, but their stars are drawn plain — which reserves the
      // decorated look for the twelve the project is actually about, and stops the
      // northern sky from competing with them.
      if (state.showGlyphs && s.g && owner && owner.group === 'zodiac') {
        const px = glyphScaleFromMag(s.m) * GLYPH_BASE_PX * scale * zoomSize * tw;
        const rPx = Math.max(GLYPH_PX_MIN, Math.min(GLYPH_PX_MAX * zoomSize, px));
        glyphCandidates.push({
          id: s.g, x: p.x, y: p.y, r: rPx, mag: s.m,
          tint: [236, 212, 148],
          alpha: starDim * edgeFade * limitFade * (muted ? 0.3 : 0.92),
        });
      }
      // Only stars in a told constellation can open a story; the rest are
      // hoverable for their name but not clickable through to a panel.
      hit.stars.push({ x: p.x, y: p.y, r: starRadius(s.m, starScale), star: s,
                       conAbbrev: owner ? s.c : null });

      const named = /^[A-Z][a-z]/.test(s.n);
      if (state.showStarNames && named && (s.m < 1.9 || state.selected === s.c) && starDim > 0.35) {
        ctx.save();
        ctx.globalAlpha = 0.62 * starDim * edgeFade;
        ctx.fillStyle = '#dce5f2';
        ctx.font = `${10.5 * scale}px "Libre Bodoni", serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(s.n, p.x + 7 * scale, p.y);
        ctx.restore();
      }
    }

    /* ---- glyphs over the stars ---- */
    if (state.showGlyphs && glyphCandidates.length) {
      const spec = (data.meta && data.meta.glyphs) || {};
      hit.glyphsDrawn = drawGlyphs(ctx, glyphCandidates, spec.outer_radius || {});
    }

    /* ---- Sun and Moon ---- */
    if (sunMoon.moon.alt > -1) {
      const p = project(sunMoon.moon.alt, sunMoon.moon.az, view);
      if (p && p.depth > 0.05) drawMoon(ctx, p, scale, sunMoon.moon);
    }
    if (sunMoon.sun.alt > -1) {
      const p = project(sunMoon.sun.alt, sunMoon.sun.az, view);
      if (p && p.depth > 0.05) drawSun(ctx, p, scale);
    }

    /* ---- ground, then names on top ---- */
    const pts = horizonCurve(view);
    if (state.showGround) drawGround(ctx, view, pts, sunGlow, 0.66);
    drawHorizonLine(ctx, view, pts, scale, sunGlow);
    drawCompass(ctx, view, pts, scale);

    if (state.showLabels) {
      for (const entry of hit.constellations) {
        const v = conVisible[entry.abbrev];
        if (!v) continue;
        // Anchor to the whole figure, not just the part that is up, so a
        // constellation that has set is still labelled when you look down at it.
        const p = project(v.anchorAlt, v.anchorAz, view);
        if (!p || p.depth < 0.35) continue;
        if (p.x < 40 || p.x > w - 40 || p.y < 18 || p.y > view.usableH - 18) continue;

        const selected = state.selected === entry.abbrev;
        const hovered = state.hovered === entry.abbrev;
        const muted = state.selected && !selected;
        const detected = state.detected === entry.abbrev;
        ctx.save();
        ctx.font = `${selected || detected ? 600 : 500} ${(selected || detected ? 13.5 : 12) * scale}px "Libre Bodoni", serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(entry.con.name).width;
        ctx.globalAlpha = (detected ? 1 : selected ? 1 : hovered ? 0.95 : muted ? 0.28 : 0.72) * Math.max(0.35, starDim);
        if (selected || hovered || detected) {
          ctx.fillStyle = 'rgba(6,9,17,0.66)';
          ctx.beginPath();
          ctx.roundRect(p.x - tw / 2 - 6 * scale, p.y - 9 * scale,
            tw + 12 * scale, 18 * scale, 4 * scale);
          ctx.fill();
        }
        if (detected) {
          ctx.shadowColor = rgb(DETECT_GLOW, 0.85);
          ctx.shadowBlur = (10 + 6 * detectPulse) * scale;
          ctx.fillStyle = rgb(DETECT_GLOW, 0.95);
        } else {
          ctx.fillStyle = entry.con.group === 'circumpolar' ? '#a8bad2' : '#e8d093';
        }
        ctx.fillText(entry.con.name, p.x, p.y);
        ctx.restore();
        entry.label = { x: p.x, y: p.y, w: tw + 16 * scale, h: 22 * scale };
      }
    }

    return hit;
  }

  function drawSun(ctx, p, scale) {
    const r = 8 * scale;
    ctx.save();
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 8);
    g.addColorStop(0, 'rgba(255,236,190,0.95)');
    g.addColorStop(0.14, 'rgba(255,206,120,0.5)');
    g.addColorStop(1, 'rgba(255,190,110,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#fff6dc';
    ctx.fill();
    ctx.restore();
  }

  /**
   * The Moon at its true size-ish with the terminator drawn, so the phase reads at
   * a glance. In the northern sky a waxing moon is lit on its right-hand limb.
   */
  function drawMoon(ctx, p, scale, moon) {
    const r = 9 * scale;
    const k = Math.max(0, Math.min(1, moon.illum));

    ctx.save();
    const g = ctx.createRadialGradient(p.x, p.y, r, p.x, p.y, r * 6);
    g.addColorStop(0, `rgba(226,232,246,${0.22 + 0.3 * k})`);
    g.addColorStop(1, 'rgba(200,215,245,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 6, 0, Math.PI * 2);
    ctx.fill();

    // Earthshine: the unlit part is not truly black.
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(46,52,68,0.85)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.clip();
    const half = Math.PI / 2;
    const litRight = moon.waxing;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, litRight ? -half : half, litRight ? half : half * 3);
    const bulge = r * (2 * k - 1);
    ctx.ellipse(p.x, p.y, Math.abs(bulge), r, 0,
      litRight ? half : -half, litRight ? -half : half,
      bulge >= 0 ? litRight : !litRight);
    ctx.fillStyle = '#f6f4ea';
    ctx.fill();
    ctx.restore();
  }

  /* ---------------------------------------------------------- hit testing --- */

  function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  /** Labels first, then stars, then figure lines — easiest to aim at wins. */
  function pick(hit, px, py) {
    if (!hit) return null;
    for (const e of hit.constellations) {
      const L = e.label;
      if (L && Math.abs(px - L.x) <= L.w / 2 && Math.abs(py - L.y) <= L.h / 2) {
        return { abbrev: e.abbrev, via: 'label' };
      }
    }
    let best = null, namedOnly = null;
    for (const s of hit.stars) {
      if (!s.r) continue;
      const d = Math.hypot(px - s.x, py - s.y);
      if (d > Math.max(11, s.r + 7)) continue;
      if (s.conAbbrev) {
        if (!best || d < best.d) best = { abbrev: s.conAbbrev, via: 'star', star: s.star, d };
      } else if (!namedOnly || d < namedOnly.d) {
        namedOnly = { abbrev: null, via: 'star', star: s.star, d };
      }
    }
    if (best) return best;
    for (const e of hit.constellations) {
      for (const [x1, y1, x2, y2] of e.segments) {
        const d = distToSegment(px, py, x1, y1, x2, y2);
        if (d <= 9 && (!best || d < best.d)) best = { abbrev: e.abbrev, via: 'line', d };
      }
    }
    // A field star's name is still worth showing if nothing else was hit.
    return best || namedOnly;
  }

  return { render, pick, project, makeView, starRadius, galacticToEquatorial,
           drawGlyph, glyphScaleFromMag, zoomSizeFactor, preloadGlyphs, glyphArt,
           COMPASS };
})();
