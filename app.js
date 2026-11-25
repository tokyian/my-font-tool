let font = null;

// Snapshot of all control values. Effects read from it via getValue(),
// so a render that runs over several frames always uses one consistent set.
let params = {};

const SLIDERS = [
  ['slantAmount', 'slantValue'],
  ['wobbleAmount', 'wobbleValue'],
  ['widthAmount', 'widthValue'],
  ['weightAmount', 'weightValue'],
  ['roundAmount', 'roundValue'],
  ['outlineAmount', 'outlineValue'],
  ['snapStrength', 'snapStrengthValue'],
  ['snapDistance', 'snapDistanceValue'],
  ['snapX', 'snapXValue'],
  ['snapY', 'snapYValue'],
  ['formulaAmount', 'formulaAmountValue'],
  ['lineLength', 'lineLengthValue'],
  ['lineSpacing', 'lineSpacingValue'],
  ['stripeWidth', 'stripeWidthValue'],
  ['stripeSpacing', 'stripeSpacingValue'],
  ['stripeAngle', 'stripeAngleValue'],
];
const LABEL_OF = Object.fromEntries(SLIDERS);

const $ = id => document.getElementById(id);

// Tabs are wired first, so switching screens keeps working
// even if something further down fails.
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => setView(tab.dataset.view));
});

function readParams() {
  const p = {};
  for (const [id] of SLIDERS) p[id] = parseFloat($(id).value);
  p.formulaType = $('formulaType').value;
  return p;
}

function getValue(id) {
  return params[id];
}

function unitScale() {
  return font.unitsPerEm / 1000;
}

function makeRandom(seed) {
  let s = Math.abs(Math.floor(seed)) % 2147483646 + 1;
  return function () {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function subdivide(contours, maxLength) {
  return contours.map(contour => {
    const result = [];
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i];
      const b = contour[(i + 1) % contour.length];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / maxLength));
      for (let s = 0; s < steps; s++) {
        result.push({ x: a.x + (b.x - a.x) * s / steps, y: a.y + (b.y - a.y) * s / steps });
      }
    }
    return result;
  });
}

function center(contours) {
  const all = contours.flat();
  const xs = all.map(p => p.x), ys = all.map(p => p.y);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

function resample(contour, spacing) {
  const result = [];
  let carry = 0;
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i];
    const b = contour[(i + 1) % contour.length];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    let d = carry;
    while (d < length) {
      const t = d / length;
      result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      d += spacing;
    }
    carry = d - length;
  }
  return result;
}

function signedArea(contour) {
  let area = 0;
  for (let i = 0; i < contour.length; i++) {
    const p = contour[i];
    const q = contour[(i + 1) % contour.length];
    area += p.x * q.y - q.x * p.y;
  }
  return area / 2;
}

function glyphToContours(glyph) {
  const contours = [];
  let current = [];
  let last = { x: 0, y: 0 };

  for (const cmd of glyph.path.commands) {
    if (cmd.type === 'M') {
      current = [{ x: cmd.x, y: cmd.y }];
    } else if (cmd.type === 'L') {
      current.push({ x: cmd.x, y: cmd.y });
    } else if (cmd.type === 'Q') {
      for (let i = 1; i <= 10; i++) {
        const t = i / 10, u = 1 - t;
        current.push({
          x: u * u * last.x + 2 * u * t * cmd.x1 + t * t * cmd.x,
          y: u * u * last.y + 2 * u * t * cmd.y1 + t * t * cmd.y,
        });
      }
    } else if (cmd.type === 'C') {
      for (let i = 1; i <= 10; i++) {
        const t = i / 10, u = 1 - t;
        current.push({
          x: u * u * u * last.x + 3 * u * u * t * cmd.x1 + 3 * u * t * t * cmd.x2 + t * t * t * cmd.x,
          y: u * u * u * last.y + 3 * u * u * t * cmd.y1 + 3 * u * t * t * cmd.y2 + t * t * t * cmd.y,
        });
      }
    } else if (cmd.type === 'Z') {
      if (current.length > 2) contours.push(current);
      current = [];
    }
    if (cmd.x !== undefined) last = { x: cmd.x, y: cmd.y };
  }
  return contours;
}

//opentype.js
function contoursToPath(contours) {
  const path = new opentype.Path();
  for (const contour of contours) {
    contour.forEach((p, i) => {
      if (i === 0) path.moveTo(Math.round(p.x), Math.round(p.y));
      else path.lineTo(Math.round(p.x), Math.round(p.y));
    });
    path.close();
  }
  return path;
}

// CLIPPER
function toClipper(contours) {
  return contours.map(contour =>
    contour.map(p => ({ X: Math.round(p.x), Y: Math.round(p.y) }))
  );
}

function fromClipper(paths) {
  return paths.map(path => path.map(q => ({ x: q.X, y: q.Y })));
}

function offset(contours, amount, joinType) {
  const offsetter = new ClipperLib.ClipperOffset();
  offsetter.AddPaths(toClipper(contours), joinType, ClipperLib.EndType.etClosedPolygon);
  const result = new ClipperLib.Paths();
  offsetter.Execute(result, amount);
  return fromClipper(result);
}

function strokeLines(lines, width) {
  const offsetter = new ClipperLib.ClipperOffset();
  offsetter.AddPaths(toClipper(lines), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound);
  const result = new ClipperLib.Paths();
  offsetter.Execute(result, width / 2);
  return fromClipper(result);
}

function union(contours) {
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(toClipper(contours), ClipperLib.PolyType.ptSubject, true);
  const result = new ClipperLib.Paths();
  clipper.Execute(ClipperLib.ClipType.ctUnion, result,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return fromClipper(result);
}

function intersect(a, b) {
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(toClipper(a), ClipperLib.PolyType.ptSubject, true);
  clipper.AddPaths(toClipper(b), ClipperLib.PolyType.ptClip, true);
  const result = new ClipperLib.Paths();
  clipper.Execute(ClipperLib.ClipType.ctIntersection, result,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return fromClipper(result);
}

//EFFECTS

// WOBBLE
function wobble(contours) {
  const amount = getValue('wobbleAmount') * unitScale();
  if (amount === 0 || contours.length === 0) return contours;

  const first = contours[0][0];
  const random = makeRandom(first.x * 31 + first.y * 17);

  return contours.map(contour =>
    contour.map(p => ({
      x: p.x + (random() - 0.5) * amount,
      y: p.y + (random() - 0.5) * amount,
    }))
  );
}

// WIDTH
function stretch(contours) {
  const k = 1 + getValue('widthAmount') / 100;
  return contours.map(contour =>
    contour.map(p => ({ x: p.x * k, y: p.y }))
  );
}

// WEIGHT
function weight(contours) {
  const amount = getValue('weightAmount') * unitScale();
  if (amount === 0) return contours;
  return offset(contours, amount, ClipperLib.JoinType.jtMiter);
}

// ROUNDNESS
function rounded(contours) {
  const r = getValue('roundAmount') * unitScale();
  if (r === 0) return contours;

  const round = ClipperLib.JoinType.jtRound;
  const thinner = offset(contours, -r, round);
  return offset(thinner, r, round);
}

// SNAP TO GRID
function snapToGrid(contours) {
  const strength = getValue('snapStrength') / 100; // 0…100 -> 0…1
  if (strength === 0) return contours;

  const u = unitScale();
  const step = getValue('snapDistance') * u;
  const shiftX = getValue('snapX') * u;
  const shiftY = getValue('snapY') * u;

  const snap = (v, shift) => {
    const moved = v + shift;
    const target = Math.round(moved / step) * step;
    return v + (target - moved) * strength;
  };

  return contours.map(contour =>
    contour.map(p => ({
      x: snap(p.x, shiftX),
      y: snap(p.y, shiftY),
    }))
  );
}

// FORMULAS
const FORMULAS = {

  wave: (x, y, cx, cy) => [x + Math.sin(y * 20) * 0.03, y],

  fabric: (x, y, cx, cy) => [x + Math.sin(y * 30) * 0.02, y + Math.sin(x * 30) * 0.02],

  diagonal: (x, y, cx, cy) => [x + Math.sin((x + y) * 25) * 0.02, y],

  damped: (x, y, cx, cy) => [x + Math.sin(y * 40) * Math.exp(-y * 4) * 0.03, y],

  beat: (x, y, cx, cy) => [x + Math.sin(y * 60) * Math.sin(y * 5) * 0.03, y],

  square: (x, y, cx, cy) => [x + Math.sign(Math.sin(y * 20)) * 0.015, y],

  flag: (x, y, cx, cy) => [x, y + Math.sin(x * 15) * x * 0.08],

  perspective: (x, y, cx, cy) => [cx + (x - cx) / (1 + y), y],

  waist: (x, y, cx, cy) => [cx + (x - cx) * (1 - 0.4 * Math.exp(-((y - cy) ** 2) / 0.01)), y],

  barrel: (x, y, cx, cy) => {
    const dx = x - cx, dy = y - cy;
    const f = 1 - 1.5 * (dx * dx + dy * dy);
    return [cx + dx * f, cy + dy * f];
  },

  pillow: (x, y, cx, cy) => {
    const dx = x - cx, dy = y - cy;
    const f = 1 + 1.5 * (dx * dx + dy * dy);
    return [cx + dx * f, cy + dy * f];
  },

  lens: (x, y, cx, cy) => {
    const d = Math.hypot(x - cx, y - cy);
    const f = 1 + 0.6 * Math.exp(-d * d / 0.05);
    return [cx + (x - cx) * f, cy + (y - cy) * f];
  },

  sphere: (x, y, cx, cy) => {
    const h = 0.45;
    const u = Math.max(-1, Math.min(1, (x - cx) / h));
    const v = Math.max(-1, Math.min(1, (y - cy) / h));
    return [cx + u * Math.sqrt(1 - v * v / 2) * h, cy + v * Math.sqrt(1 - u * u / 2) * h];
  },

  swirl: (x, y, cx, cy) => {
    const d = Math.hypot(x - cx, y - cy);
    const a = 1.5 * Math.exp(-d * d / 0.08);
    return [
      cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a),
      cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a),
    ];
  },

  arch: (x, y, cx, cy) => {
    const R = 1.2;
    const angle = (x - cx) / R;
    const r = R + y;
    return [cx + r * Math.sin(angle), r * Math.cos(angle) - R];
  },

  twist: (x, y, cx, cy) => [cx + (x - cx) * Math.cos((y - cy) * 3), y],

  glitch: (x, y, cx, cy) => {
    const band = Math.floor(y * 25);
    const rnd = (Math.sin(band * 12.9898) * 43758.5453) % 1;
    return [x + rnd * 0.04, y];
  },
};

// FORMULA
function formula(contours) {
  const k = getValue('formulaAmount') / 100;
  if (k === 0 || contours.length === 0) return contours;

  const em = font.unitsPerEm;
  const c = center(contours);
  const cx = c.x / em, cy = c.y / em;
  const type = params.formulaType;

  return subdivide(contours, 10 * unitScale()).map(contour =>
    contour.map(p => {
      const x = p.x / em, y = p.y / em;
      const [nx, ny] = FORMULAS[type](x, y, cx, cy);
      return {
        x: (x + (nx - x) * k) * em,
        y: (y + (ny - y) * k) * em,
      };
    })
  );
}

// OUTLINE
function outline(contours) {
  const width = getValue('outlineAmount') * unitScale();
  if (width === 0) return contours;

  const offsetter = new ClipperLib.ClipperOffset();
  offsetter.AddPaths(toClipper(contours), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedLine);
  const result = new ClipperLib.Paths();
  offsetter.Execute(result, width);
  return fromClipper(result);
}

// SLANT
function slant(contours) {
  const amount = getValue('slantAmount');
  return contours.map(contour =>
    contour.map(p => ({ x: p.x + p.y * amount, y: p.y }))
  );
}

// LINES
function outerLines(contours) {
  const u = unitScale();
  const length = getValue('lineLength') * u;
  if (length === 0 || contours.length === 0) return contours;
  const spacing = getValue('lineSpacing') * u;
  const width = 8 * u;

  let biggest = contours[0];
  for (const c of contours) {
    if (Math.abs(signedArea(c)) > Math.abs(signedArea(biggest))) biggest = c;
  }
  const sign = Math.sign(signedArea(biggest));

  const segments = [];
  for (const contour of contours) {
    const pts = resample(contour, spacing);
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[(i - 1 + pts.length) % pts.length];
      const next = pts[(i + 1) % pts.length];
      const dx = next.x - prev.x, dy = next.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;

      const dirX = (dy * sign) / len;
      const dirY = (-dx * sign) / len;

      const p = pts[i];
      segments.push([p, { x: p.x + dirX * length, y: p.y + dirY * length }]);
    }
  }

  const body = union(contours);
  const strokes = strokeLines(segments, width);
  return union(body.concat(strokes));
}

// STRIPES
function stripes(contours) {
  const u = unitScale();
  const thickness = getValue('stripeWidth') * u;
  if (thickness === 0 || contours.length === 0) return contours;
  const spacing = getValue('stripeSpacing') * u;
  const angle = getValue('stripeAngle') * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const size = font.unitsPerEm * 2;

  const bars = [];
  for (let y = -size; y < size; y += spacing) {
    const rect = [
      { x: -size, y: y },
      { x: size, y: y },
      { x: size, y: y + thickness },
      { x: -size, y: y + thickness },
    ];
    bars.push(rect.map(p => ({
      x: p.x * cos - p.y * sin,
      y: p.x * sin + p.y * cos,
    })));
  }

  return intersect(contours, bars);
}

// ALL EFFECTS
function applyEffect(contours, p) {
  params = p;
  let result = contours;
  result = wobble(result);
  result = stretch(result);
  result = weight(result);
  result = rounded(result);
  result = snapToGrid(result);
  result = formula(result);
  result = outerLines(result);
  result = outline(result);
  result = slant(result);
  result = stripes(result);
  return result;
}

function newAdvanceWidth(glyph, p) {
  return (glyph.advanceWidth || 0) * (1 + p.widthAmount / 100);
}

// ============================================================
// CACHES
// ============================================================

// Original outlines per glyph: they never change for a loaded font.
const baseCache = new Map();

function baseContours(glyph) {
  let c = baseCache.get(glyph.index);
  if (!c) {
    c = glyphToContours(glyph);
    baseCache.set(glyph.index, c);
  }
  return c;
}

// Processed outlines per glyph + settings (small LRU). Moving a slider
// back to a value you've already seen redraws instantly.
const EFFECT_CACHE_LIMIT = 800;
const effectCache = new Map();

function effectContours(glyph, p, key, store = true) {
  const k = glyph.index + '|' + key;
  let c = effectCache.get(k);
  if (c) {
    effectCache.delete(k);
    effectCache.set(k, c);
    return c;
  }
  try {
    c = applyEffect(baseContours(glyph), p);
  } catch (error) {
    console.warn('Effect failed for glyph', glyph.name, error);
    c = [];
  }
  if (store) {
    effectCache.set(k, c);
    if (effectCache.size > EFFECT_CACHE_LIMIT) {
      effectCache.delete(effectCache.keys().next().value);
    }
  }
  return c;
}

const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

// ============================================================
// PREVIEW — progressive rendering
// ============================================================
//
// Each change starts a new "render job". The job lays out the text
// (cheap), then computes glyph effects a few at a time, using at most
// FRAME_BUDGET ms per frame, and repaints after each chunk. Glyphs that
// aren't recomputed yet keep their previous shape, drawn faded.
// A newer change cancels the old job right away.

const FRAME_BUDGET = 10; // ms of effect work per frame

const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const wrap = $('canvasWrap');

let slots = [];                // { glyph, x, y, contours, fresh }
let view = { w: 0, h: 0, dpr: 1, scale: 1 };
let renderId = 0;
let frameRequested = false;

function requestDraw() {
  if (!font) return;
  renderId++;                  // cancel any job in progress immediately
  if (activeView !== 'editor') return; // redrawn when the tab is opened
  if (frameRequested) return;  // at most one restart per frame
  frameRequested = true;
  requestAnimationFrame(() => {
    frameRequested = false;
    startRender();
  });
}

function layout(p) {
  const W = Math.max(240, wrap.clientWidth);
  const size = Math.round(Math.max(48, Math.min(120, W / 7)));
  const scale = size / font.unitsPerEm;
  const pad = Math.round(size * 0.3) + 12;
  const lineH = size * 1.5;
  const maxX = W - pad;

  const placed = [];
  let x = pad, line = 0;

  const tokens = $('previewText').value.split(/(\s+)/).filter(Boolean);
  for (const token of tokens) {
    const glyphs = font.stringToGlyphs(token);
    const advs = glyphs.map(g => newAdvanceWidth(g, p) * scale);
    const width = advs.reduce((a, b) => a + b, 0);

    if (/^\s+$/.test(token)) {
      if (x > pad) x += width;
      continue;
    }
    // Word wrap; very long words also break between letters.
    if (x + width > maxX && x > pad) { line++; x = pad; }
    glyphs.forEach((g, i) => {
      if (x + advs[i] > maxX && x > pad) { line++; x = pad; }
      placed.push({ glyph: g, x, line });
      x += advs[i];
    });
  }

  const H = Math.round(pad * 2 + size * 1.4 + line * lineH);
  const dpr = window.devicePixelRatio || 1;
  if (view.w !== W || view.h !== H || view.dpr !== dpr) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
  }
  view = { w: W, h: H, dpr, scale };

  // Keep previous shapes where the same glyph sits in the same slot,
  // so there's something to show while the new shape is computed.
  const old = slots;
  slots = placed.map((s, i) => ({
    glyph: s.glyph,
    x: s.x,
    y: pad + size + s.line * lineH,
    contours: old[i] && old[i].glyph.index === s.glyph.index ? old[i].contours : null,
    fresh: false,
  }));
}

function paint() {
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, view.w, view.h);
  ctx.fillStyle = '#111';
  for (const s of slots) {
    if (!s.contours) continue;
    ctx.globalAlpha = s.fresh ? 1 : 0.2;
    drawContours(ctx, s.contours, s.x, s.y, view.scale);
  }
  ctx.globalAlpha = 1;
}

function drawContours(ctx, contours, offsetX, baseline, scale) {
  ctx.beginPath();
  for (const contour of contours) {
    contour.forEach((p, i) => {
      const x = offsetX + p.x * scale;
      const y = baseline - p.y * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
  }
  ctx.fill();
}

function startRender() {
  if (!font) return;
  const id = ++renderId;
  const p = readParams();
  const key = JSON.stringify(p);

  layout(p);

  // Anything already in the cache shows up instantly.
  const pending = [];
  for (const s of slots) {
    const cached = effectCache.get(s.glyph.index + '|' + key);
    if (cached) { s.contours = cached; s.fresh = true; }
    else pending.push(s);
  }
  paint();
  if (pending.length === 0) return setProgress(1, 1);

  let i = 0;
  const step = () => {
    if (id !== renderId) return; // superseded by a newer change
    const t0 = performance.now();
    do {
      const s = pending[i++];
      s.contours = effectContours(s.glyph, p, key);
      s.fresh = true;
    } while (i < pending.length && performance.now() - t0 < FRAME_BUDGET);
    paint();
    setProgress(i, pending.length);
    if (i < pending.length) requestAnimationFrame(step);
  };
  step();
}

function setProgress(done, total) {
  const bar = $('progress');
  const status = $('status');
  if (done >= total) {
    bar.style.width = '100%';
    bar.classList.remove('active');
    status.textContent = '';
  } else {
    bar.classList.add('active');
    bar.style.width = (done / total * 100) + '%';
    status.textContent = `Rendering ${done} / ${total}`;
  }
}

// ============================================================
// FONT LOADING — also applies the font to the whole UI
// ============================================================

let uiFace = null;
let uiFaceCount = 0;

async function applyUIFont(buffer) {
  if (!('FontFace' in window)) return;
  const family = 'UploadedFont' + (++uiFaceCount);
  try {
    const face = new FontFace(family, buffer);
    await face.load();
    document.fonts.add(face);
    if (uiFace) document.fonts.delete(uiFace);
    uiFace = face;
    document.documentElement.style.setProperty(
      '--ui-font', `"${family}", system-ui, -apple-system, "Segoe UI", sans-serif`
    );
  } catch (error) {
    console.warn('The browser could not use this font for the UI:', error);
  }
}

async function loadFont(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const buffer = await file.arrayBuffer();
    font = opentype.parse(buffer.slice(0));
    baseCache.clear();
    effectCache.clear();
    slots = [];
    $('info').textContent =
      `${file.name} · Glyphs: ${font.glyphs.length}, units per em: ${font.unitsPerEm}`;
    $('empty').hidden = true;
    requestDraw();
    await applyUIFont(buffer);
    buildSpecimen();
  } catch (error) {
    font = null;
    $('info').textContent =
      'Could not read the font: ' + error.message + ' (use .ttf, .otf, .woff)';
  }
}

// ============================================================
// SAVE — processes glyphs in chunks so the page stays responsive
// ============================================================

let saving = false;

async function saveFont() {
  if (!font) return alert('Import a font first');
  if (saving) return;
  saving = true;

  const button = $('save');
  const label = button.textContent;
  button.disabled = true;

  try {
    const p = readParams();
    const key = JSON.stringify(p);
    const total = font.glyphs.length;

    const glyphs = [
      new opentype.Glyph({ name: '.notdef', advanceWidth: font.unitsPerEm / 2, path: new opentype.Path() }),
    ];

    let t0 = performance.now();
    for (let i = 0; i < total; i++) {
      const g = font.glyphs.get(i);
      if (g.unicode !== undefined) {
        // Read from the preview cache, but don't flood it with every glyph.
        const contours = effectContours(g, p, key, false);
        glyphs.push(new opentype.Glyph({
          name: g.name || 'glyph' + i,
          unicode: g.unicode,
          unicodes: g.unicodes,
          advanceWidth: Math.round(newAdvanceWidth(g, p)),
          path: contoursToPath(contours),
        }));
      }
      if (performance.now() - t0 > 30) {
        button.textContent = `Building… ${Math.round(i / total * 100)}%`;
        await nextFrame();
        t0 = performance.now();
      }
    }

    button.textContent = 'Saving…';
    await nextFrame();

    const newFont = new opentype.Font({
      familyName: 'My Experiment',
      styleName: 'Regular',
      unitsPerEm: font.unitsPerEm,
      ascender: font.ascender,
      descender: font.descender,
      glyphs: glyphs,
    });

    newFont.download('my-experiment.otf');
  } catch (error) {
    alert('Could not build the font: ' + error.message);
  } finally {
    saving = false;
    button.disabled = false;
    button.textContent = label;
  }
}

// ============================================================
// FILTER GROUPS — collapse/expand, modified-count badge, reset
// ============================================================

const GROUP_STORAGE_KEY = 'fonttool.groups';
const groups = [...document.querySelectorAll('details.group')];

function loadGroupState() {
  try { return JSON.parse(localStorage.getItem(GROUP_STORAGE_KEY)) || {}; }
  catch { return {}; }
}

function saveGroupState() {
  const state = {};
  for (const g of groups) state[g.dataset.group] = g.open;
  try { localStorage.setItem(GROUP_STORAGE_KEY, JSON.stringify(state)); } catch {}
}

function defaultOf(el) {
  if (el.tagName === 'SELECT') {
    const opt = [...el.options].find(o => o.defaultSelected) || el.options[0];
    return opt.value;
  }
  return el.defaultValue;
}

function isModified(el) {
  if (el.tagName === 'SELECT') return el.value !== defaultOf(el);
  return parseFloat(el.value) !== parseFloat(el.defaultValue);
}

function controlsOf(group) {
  return [...group.querySelectorAll('input[type=range], select')];
}

function updateLabel(sliderId) {
  const labelId = LABEL_OF[sliderId];
  if (labelId) $(labelId).textContent = parseFloat($(sliderId).value);
}

function updateBadges() {
  for (const g of groups) {
    const count = controlsOf(g).filter(isModified).length;
    const badge = g.querySelector('.badge');
    badge.textContent = count;
    badge.hidden = count === 0;
    g.querySelector('.reset').disabled = count === 0;
  }
}

function resetGroup(group) {
  for (const el of controlsOf(group)) {
    el.value = defaultOf(el);
    updateLabel(el.id);
  }
  onFiltersChanged();
}

function updateToggleAll() {
  const anyOpen = groups.some(g => g.open);
  $('toggleAll').textContent = anyOpen ? 'Collapse all' : 'Expand all';
}

function initGroups() {
  const state = loadGroupState();
  for (const g of groups) {
    const name = g.dataset.group;
    if (name in state) g.open = state[name];
    g.addEventListener('toggle', () => { saveGroupState(); updateToggleAll(); });
    g.querySelector('.reset').addEventListener('click', () => resetGroup(g));
  }
  $('toggleAll').addEventListener('click', () => {
    const open = !groups.some(g => g.open);
    for (const g of groups) g.open = open;
  });
  updateBadges();
  updateToggleAll();
}

// ============================================================
// SCRIPTS — detection and sample texts
// ============================================================

const SCRIPTS = [
  {
    id: 'latin', name: 'Latin',
    ranges: [[0x41, 0x5A], [0x61, 0x7A], [0xC0, 0x24F], [0x1E00, 0x1EFF]],
    sample: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.',
  },
  {
    id: 'cyrillic', name: 'Cyrillic',
    ranges: [[0x400, 0x52F]],
    sample: 'Лорем ипсум долор сит амет, консектетур адиписцинг элит, сед до эиусмод темпор инцидидунт ут лаборе эт долоре магна аликуа. Ут эним ад миним вениам, квис ноструд экзерцитатион улламко лаборис ниси ут аликуип экс эа коммодо консекват. Съешь же ещё этих мягких французских булок, да выпей чаю.',
  },
  {
    id: 'greek', name: 'Greek',
    ranges: [[0x370, 0x3FF], [0x1F00, 0x1FFF]],
    sample: 'Λορεμ ιψουμ δολορ σιτ αμετ, κονσεκτετουρ αδιπισκινγ ελιτ, σεδ δο ειουσμοδ τεμπορ ινκιδιδουντ ουτ λαβορε ετ δολορε μαγνα αλικουα. Ξεσκεπάζω την ψυχοφθόρα βδελυγμία.',
  },
  {
    id: 'armenian', name: 'Armenian',
    ranges: [[0x530, 0x58F]],
    sample: 'Լոռեմ իպսում դոլոր սիտ ամետ, կոնսեկտետուր ադիպիսցինգ էլիտ, սեդ դո էյուսմոդ տեմպոր ինցիդիդունտ ուտ լաբորե էտ դոլորե մագնա ալիքուա։',
  },
  {
    id: 'georgian', name: 'Georgian',
    ranges: [[0x10A0, 0x10FF]],
    sample: 'ლორემ იფსუმ დოლორ სით ამეთ, კონსექტეტურ ადიპისცინგ ელით, სედ დო ეიუსმოდ ტემპორ ინციდიდუნტ უთ ლაბორე ეთ დოლორე მაგნა ალიქუა.',
  },
  {
    id: 'hebrew', name: 'Hebrew', dir: 'rtl',
    ranges: [[0x590, 0x5FF]],
    sample: 'לורם איפסום דולור סיט אמט, קונסקטורר אדיפיסינג אלית, סד דו איוסמוד טמפור אינסידידונט אוט לבורה את דולורה מגנה אליקואה.',
  },
  {
    id: 'arabic', name: 'Arabic', dir: 'rtl', complex: true,
    ranges: [[0x600, 0x6FF], [0x750, 0x77F]],
    sample: 'لوريم ايبسوم دولار سيت أميت، كونسيكتيتور أدايبا يسكينج أليايت، سيت دو أيوسمود تيمبور أنكايديديونتيوت لابوري ات دولار ماجنا أليكيوا.',
  },
  {
    id: 'devanagari', name: 'Devanagari', complex: true,
    ranges: [[0x900, 0x97F]],
    sample: 'लोरेम इप्सम डोलर सिट अमेट, कंसेक्टेटुर एडिपिसिंग एलिट, सेड डो ईयूस्मोड टेम्पोर इन्सिडिडंट उट लाबोरे एट डोलोरे मैग्ना अलिक्वा।',
  },
  {
    id: 'thai', name: 'Thai', complex: true,
    ranges: [[0xE00, 0xE7F]],
    sample: 'ลอเรม อิปซัม โดลอร์ ซิท อาเมท คอนเซคเตทัวร์ อดิพิสซิง อีลิท เซด ดู อีอุสมอด เทมพอร์ อินซิดิดันท์ อุท ลาบอเร เอท โดลอเร แมกนา อาลีควา',
  },
  {
    id: 'hangul', name: 'Hangul',
    ranges: [[0x1100, 0x11FF], [0x3130, 0x318F], [0xAC00, 0xD7AF]],
    sample: '로렘 입숨 돌로르 싯 아멧, 콘섹테투르 아디피싱 엘리트, 세드 도 에이우스모드 템포르 인시디둔트 우트 라보레 에트 돌로레 마그나 알리쿠아.',
  },
  {
    id: 'kana', name: 'Japanese Kana',
    ranges: [[0x3040, 0x30FF]],
    sample: 'ロレム・イプサム・ドロル・シット・アメット、コンセクテトゥル・アディピシング・エリット。いろはにほへと ちりぬるを わかよたれそ つねならむ うゐのおくやま けふこえて あさきゆめみし ゑひもせす',
  },
  {
    id: 'han', name: 'CJK Ideographs',
    ranges: [[0x4E00, 0x9FFF], [0x3400, 0x4DBF]],
    sample: '文字是思想的形状。设计一款字体，就是在笔画、结构与留白之间寻找平衡。每一个字都要在小字号下清晰易读，在大字号下依然优雅。',
  },
  {
    id: 'common', name: 'Figures & symbols',
    ranges: [[0x21, 0x40], [0x5B, 0x60], [0x7B, 0x7E], [0xA1, 0xBF], [0x2010, 0x205E], [0x20A0, 0x20CF], [0x2100, 0x215F]],
    sample: '0123456789 — 1 234,56 € · $78.90 · £12 · ¥345 · 50% · №7 · (a+b)×c=d÷e · “Quoted” «Quoted» ‘single’ · [brackets] {braces} · @ # & * / \\ | ? ! … ©®™',
  },
];

const CHARSET_LIMIT = 240; // characters shown per script in the charset row
const MIN_SCRIPT_CHARS = 20;
const MIN_SAMPLE_COVERAGE = 0.5;

function fontCodepoints(f) {
  const map = f.tables.cmap && f.tables.cmap.glyphIndexMap;
  let cps;
  if (map) {
    cps = Object.keys(map).map(Number).filter(cp => map[cp] > 0);
  } else {
    cps = [];
    for (let i = 0; i < f.glyphs.length; i++) {
      const g = f.glyphs.get(i);
      if (g.unicodes) cps.push(...g.unicodes);
    }
  }
  return [...new Set(cps)].sort((a, b) => a - b);
}

function detectScripts(f) {
  const cps = fontCodepoints(f);
  const cpSet = new Set(cps);
  const scripts = [];
  let assigned = 0;

  for (const s of SCRIPTS) {
    const chars = cps.filter(cp => s.ranges.some(([a, b]) => cp >= a && cp <= b));
    if (chars.length === 0) continue;

    const sampleChars = new Set(Array.from(s.sample.replace(/\s/gu, '')));
    const covered = [...sampleChars].filter(c => cpSet.has(c.codePointAt(0))).length;
    const coverage = covered / sampleChars.size;

    // A handful of stray letters (Ω, π in a Latin font) isn't a supported script.
    if (chars.length < MIN_SCRIPT_CHARS && coverage < MIN_SAMPLE_COVERAGE) continue;

    assigned += chars.length;
    scripts.push({ ...s, chars, coverage });
  }

  return { cps, scripts, other: cps.length - assigned };
}

// ============================================================
// SPECIMEN — lazy, per-section rendering
// ============================================================
//
// Every script gets its own section. A section is only processed once it
// scrolls into view (IntersectionObserver). With "Apply effects" on, the
// glyphs the section needs are run through the effects a few per frame,
// packed into a small temporary font and swapped in. Until then the
// original font is shown faded. Sections are built one at a time.

let activeView = 'editor';

const spec = {
  sections: [],
  queue: [],
  gen: 0,
  working: false,
  faceCount: 0,
  timer: null,
  observer: null,
};

const FALLBACK = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const effectsOn = () => $('specEffects').checked;

function escapeHTML(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function clearSpecimen() {
  if (spec.observer) spec.observer.disconnect();
  for (const sec of spec.sections) if (sec.face) document.fonts.delete(sec.face);
  spec.sections = [];
  spec.queue = [];
  spec.gen++;
  $('specSections').innerHTML = '';
  $('scriptChips').innerHTML = '';
}

function buildSpecimen() {
  clearSpecimen();
  if (!font) return;

  const { cps, scripts, other } = detectScripts(font);
  const names = font.names || {};
  const family = (names.fontFamily && (names.fontFamily.en || Object.values(names.fontFamily)[0])) || 'Untitled';
  const style = (names.fontSubfamily && (names.fontSubfamily.en || Object.values(names.fontSubfamily)[0])) || '';

  $('specName').textContent = `${family} ${style}`.trim();
  $('statGlyphs').textContent = font.glyphs.length.toLocaleString('en');
  $('statChars').textContent = cps.length.toLocaleString('en');
  $('statScripts').textContent = scripts.filter(s => s.id !== 'common').length;
  $('statUpm').textContent = font.unitsPerEm;

  const chips = $('scriptChips');
  const container = $('specSections');

  spec.observer = new IntersectionObserver(onSectionVisibility, { rootMargin: '300px 0px' });

  for (const s of scripts) {
    // Chip — toggles the section
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.setAttribute('aria-pressed', 'true');
    chip.textContent = `${s.name} · ${s.chars.length}`;
    chips.appendChild(chip);

    // Section
    const shown = s.chars.slice(0, CHARSET_LIMIT).map(cp => String.fromCodePoint(cp));
    const charsetText = shown.join(' ') + (s.chars.length > CHARSET_LIMIT ? ' …' : '');
    const coverage = Math.round(s.coverage * 100);

    const el = document.createElement('section');
    el.className = 'spec-section';
    el.innerHTML = `
      <div class="spec-head">
        <h2>${escapeHTML(s.name)}</h2>
        <span class="spec-meta">${s.chars.length} characters${coverage < 100 ? ` · sample ${coverage}% covered` : ''}</span>
        <span class="spec-state"></span>
      </div>
      <div class="spec-body">
        <p class="spec-text" dir="${s.dir || 'ltr'}" contenteditable="plaintext-only" spellcheck="false">${escapeHTML(s.sample)}</p>
        <p class="charset" dir="ltr">${escapeHTML(charsetText)}</p>
      </div>
      ${s.complex ? '<p class="spec-note">With effects on, letters are shown without contextual shaping (joining, ligatures, mark positioning). The exported font has the same limitation.</p>' : ''}
    `;
    container.appendChild(el);

    const sec = {
      script: s,
      el,
      body: el.querySelector('.spec-body'),
      text: el.querySelector('.spec-text'),
      state: el.querySelector('.spec-state'),
      note: el.querySelector('.spec-note'),
      charsetText,
      visible: false,
      builtKey: null,
      face: null,
      editTimer: null,
    };
    spec.sections.push(sec);
    useOriginal(sec);

    chip.addEventListener('click', () => {
      const on = chip.getAttribute('aria-pressed') !== 'true';
      chip.setAttribute('aria-pressed', String(on));
      el.hidden = !on;
    });

    sec.text.addEventListener('input', () => {
      clearTimeout(sec.editTimer);
      sec.editTimer = setTimeout(() => {
        if (!effectsOn()) return;
        enqueue(sec, true);
        pumpQueue();
      }, 400);
    });

    spec.observer.observe(el);
  }

  if (other > 0) {
    const note = document.createElement('span');
    note.className = 'chip-note';
    note.textContent = `+ ${other} other characters`;
    chips.appendChild(note);
  }

  $('specEmpty').hidden = true;
  $('specContent').hidden = false;
  refreshSpecimen();
}

function useOriginal(sec) {
  sec.body.style.fontFamily = 'var(--ui-font)';
  sec.el.classList.toggle('stale', effectsOn());
  sec.state.textContent = '';
  if (sec.note) sec.note.hidden = !effectsOn();
}

function sectionKey(sec, key) {
  return key + '|' + sec.text.textContent;
}

function enqueue(sec, front = false) {
  if (spec.queue.includes(sec)) return;
  if (front) spec.queue.unshift(sec);
  else spec.queue.push(sec);
}

function onSectionVisibility(entries) {
  for (const entry of entries) {
    const sec = spec.sections.find(s => s.el === entry.target);
    if (!sec) continue;
    sec.visible = entry.isIntersecting;
    if (sec.visible && effectsOn() && activeView === 'specimen') enqueue(sec);
  }
  pumpQueue();
}

// Called on any filter change or the effects toggle. Debounced so dragging
// a slider doesn't rebuild fonts on every pixel.
function requestSpecimen() {
  clearTimeout(spec.timer);
  spec.timer = setTimeout(refreshSpecimen, 200);
}

function refreshSpecimen() {
  if (!font || activeView !== 'specimen') return;
  spec.gen++; // abort any build in progress

  if (!effectsOn()) {
    spec.queue = [];
    spec.sections.forEach(useOriginal);
    return;
  }

  const key = JSON.stringify(readParams());
  spec.queue = [];
  for (const sec of spec.sections) {
    if (sec.note) sec.note.hidden = false;
    if (sec.builtKey === sectionKey(sec, key)) {
      sec.body.style.fontFamily = `"${sec.face.family}", ${FALLBACK}`;
      sec.el.classList.remove('stale');
      continue;
    }
    sec.el.classList.add('stale');
    if (sec.visible) enqueue(sec);
  }
  pumpQueue();
}

async function pumpQueue() {
  if (spec.working) return;
  spec.working = true;
  try {
    while (spec.queue.length) {
      const sec = spec.queue.shift();
      if (sec.el.hidden || !sec.el.isConnected) continue;
      await buildSection(sec);
    }
  } finally {
    spec.working = false;
  }
}

async function buildSection(sec) {
  if (!effectsOn()) return useOriginal(sec);

  const gen = spec.gen;
  const p = readParams();
  const key = JSON.stringify(p);
  const want = sectionKey(sec, key);
  if (sec.builtKey === want) { sec.el.classList.remove('stale'); return; }

  sec.el.classList.add('stale');

  // Collect the glyphs this section actually uses.
  const byGlyph = new Map();
  for (const ch of new Set(Array.from(sec.text.textContent + sec.charsetText + ' '))) {
    const g = font.charToGlyph(ch);
    if (!g || g.index === 0) continue;
    let entry = byGlyph.get(g.index);
    if (!entry) byGlyph.set(g.index, entry = { glyph: g, unicodes: [] });
    entry.unicodes.push(ch.codePointAt(0));
  }

  const glyphs = [
    new opentype.Glyph({ name: '.notdef', advanceWidth: font.unitsPerEm / 2, path: new opentype.Path() }),
  ];
  const total = byGlyph.size;
  let done = 0;
  let t0 = performance.now();

  for (const { glyph, unicodes } of byGlyph.values()) {
    if (gen !== spec.gen) return; // settings changed — a fresh build is queued
    const contours = effectContours(glyph, p, key, false);
    glyphs.push(new opentype.Glyph({
      name: 'g' + glyph.index,
      unicode: unicodes[0],
      unicodes,
      advanceWidth: Math.round(newAdvanceWidth(glyph, p)),
      path: contoursToPath(contours),
    }));
    done++;
    if (performance.now() - t0 > FRAME_BUDGET) {
      sec.state.textContent = `Applying effects ${Math.round(done / total * 100)}%`;
      await nextFrame();
      t0 = performance.now();
    }
  }
  if (gen !== spec.gen) return;

  const family = 'SpecimenFont' + (++spec.faceCount);
  try {
    const buffer = new opentype.Font({
      familyName: family,
      styleName: 'Regular',
      unitsPerEm: font.unitsPerEm,
      ascender: font.ascender,
      descender: font.descender,
      glyphs,
    }).toArrayBuffer();

    const face = new FontFace(family, buffer);
    await face.load();
    if (gen !== spec.gen) return;

    document.fonts.add(face);
    if (sec.face) document.fonts.delete(sec.face);
    sec.face = face;
    sec.builtKey = want;
    sec.body.style.fontFamily = `"${family}", ${FALLBACK}`;
    sec.el.classList.remove('stale');
    sec.state.textContent = '';
  } catch (error) {
    console.warn('Could not build preview font for', sec.script.name, error);
    sec.state.textContent = 'Could not apply effects';
  }
  await nextFrame(); // let the page breathe between sections
}

function updateSpecTypography() {
  const size = parseFloat($('specSize').value);
  const leading = parseFloat($('specLeading').value);
  $('specSizeValue').textContent = size + ' px';
  $('specLeadingValue').textContent = leading.toFixed(2).replace(/0$/, '');
  const box = $('specSections');
  box.style.setProperty('--spec-size', size + 'px');
  box.style.setProperty('--spec-leading', leading);
}

// ============================================================
// TABS
// ============================================================

function setView(view) {
  activeView = view;
  for (const tab of document.querySelectorAll('.tab')) {
    const on = tab.dataset.view === view;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
  }
  $('editorView').hidden = view !== 'editor';
  $('specimenView').hidden = view !== 'specimen';

  try {
    if (view === 'editor') requestDraw();
    else refreshSpecimen();
  } catch (error) {
    console.error(error);
  }
}

// ============================================================
// WIRING
// ============================================================

function onFiltersChanged() {
  updateBadges();
  requestDraw();
  requestSpecimen();
}

$('file').addEventListener('change', loadFont);
$('save').addEventListener('click', saveFont);
$('previewText').addEventListener('input', requestDraw);
$('formulaType').addEventListener('change', onFiltersChanged);

for (const [sliderId] of SLIDERS) {
  $(sliderId).addEventListener('input', () => {
    updateLabel(sliderId);
    onFiltersChanged();
  });
}

$('specSize').addEventListener('input', updateSpecTypography);
$('specLeading').addEventListener('input', updateSpecTypography);
$('specEffects').addEventListener('change', refreshSpecimen);
updateSpecTypography();

// Re-layout when the preview area changes width.
let lastWidth = 0;
new ResizeObserver(() => {
  const w = wrap.clientWidth;
  if (w !== lastWidth) { lastWidth = w; requestDraw(); }
}).observe(wrap);

// Every visit starts from the values written in index.html (all neutral),
// so a freshly loaded font is shown untouched. Without this, some browsers
// (Firefox, Safari) bring back the slider positions from before a reload
// while the numbers next to them still show the HTML defaults.
for (const [sliderId] of SLIDERS) {
  const el = $(sliderId);
  el.value = el.defaultValue;
  updateLabel(sliderId);
}
$('formulaType').value = defaultOf($('formulaType'));

initGroups();
