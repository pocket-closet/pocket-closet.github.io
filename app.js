'use strict';

// Everything is stored in this browser's IndexedDB, on this device only. Nothing is uploaded.
const DB_NAME = 'pocket-closet';
const DB_VERSION = 1;
const QR_CORNER = 0.45;          // read the bottom-right 45% first (fast), then the whole picture
const KEEP_AS_IS_BYTES = 250 * 1024; // game QR screenshots under this are kept untouched
const FULL_MAX_SIDE = 1600;      // bigger pictures are shrunk to this
const THUMB_W = 360;
const THUMB_H = 480;
const THUMB_VERSION = 2;         // bump when the crop changes; older thumbnails are remade on start
const BACKUP_MAGIC = 'POCKET-CLOSET-BACKUP 1';

// ---------- storage ----------

let conn;
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('outfits', { keyPath: 'id' });
      d.createObjectStore('images'); // `${id}:thumb` and `${id}:full` -> Blob
      d.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Runs fn(stores...) in one transaction and resolves when it has been written.
function tx(names, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = conn.transaction(names, mode);
    const req = fn(...[].concat(names).map((n) => t.objectStore(n)));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = t.onabort = () => reject(t.error);
  });
}

const getAllOutfits = () => tx('outfits', 'readonly', (s) => s.getAll());
const getImage = (key) => tx('images', 'readonly', (s) => s.get(key));

async function saveOutfit(o, quiet) {
  o.updatedAt = Date.now(); // lets a restore tell which copy of an outfit is newer
  try {
    await tx('outfits', 'readwrite', (s) => s.put(o));
    if (!quiet) toast('Saved');
  } catch (err) {
    console.error(err);
    toast("Couldn't save!");
  }
}

function saveOutfitWithImages(o, full, thumb) {
  o.updatedAt = Date.now();
  return tx(['outfits', 'images'], 'readwrite', (outfits, images) => {
    images.put(full, `${o.id}:full`);
    images.put(thumb, `${o.id}:thumb`);
    return outfits.put(o);
  });
}

function deleteOutfit(id) {
  return tx(['outfits', 'images'], 'readwrite', (outfits, images) => {
    images.delete(`${id}:full`);
    images.delete(`${id}:thumb`);
    return outfits.delete(id);
  });
}

const getMeta = (key) => tx('meta', 'readonly', (s) => s.get(key));
const setMeta = (key, value) => tx('meta', 'readwrite', (s) => s.put(value, key));

let outfits = [];
let gameLabels = { style: [], official: [] }; // from labels.json, updated with the game
let customLabels = [];                        // the user's own, in meta 'customLabels'
let prefs = { foldGame: false, foldMine: false }; // remembered in meta 'prefs'
let accounts = [];  // the game accounts you play on, in meta 'accounts'. Only shown with 2 or more.
let collections = []; // your own groups of outfits, in meta 'collections': { id, name, cover }
const thumbUrls = new Map();
const state = {
  view: 'closet', openId: null, q: '', sort: 'newest',
  shelf: 'all',                     // 'all', 'fav', or a collection id
  selecting: false, selected: new Set(),
  showFilters: false, filter: { styles: [], labels: [], colors: [], account: null },
  pickingLabels: false, closetScroll: 0,
};

// Switch views. The closet remembers how far down it was scrolled, so coming back
// from an outfit (or Settings) lands in the same place.
function go(view, openId) {
  if (state.view === 'closet') { state.closetScroll = window.scrollY; state.closetShown = state.gridShown; }
  if (view !== 'closet') { state.selecting = false; state.selected.clear(); }
  state.view = view;
  if (openId) { state.openId = openId; state.pickingLabels = false; }
  render(view === 'closet' ? state.closetShown : 0); // draw as many cards as before, so the old spot exists
  window.scrollTo(0, view === 'closet' ? state.closetScroll : 0);
}

// ---------- helpers ----------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && !k.includes('-')) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  return put(el, ...kids);
}

// Adds children to an element, skipping null/false (plain append() would print "null").
function put(el, ...kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

let toastTimer;
function toast(msg, ms = 900) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// Our own "Are you sure?" box. The browser's confirm() can be blocked (it is in some app panes).
function ask(message, yes = 'Yes', no = 'Cancel', danger = false) {
  return new Promise((resolve) => {
    const done = (answer) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(answer); };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    const yesBtn = h('button', { type: 'button', class: danger ? 'danger' : 'primary', onclick: () => done(true) }, yes);
    const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) done(false); } },
      h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true' },
        h('p', null, message),
        h('div', { class: 'dialogbtns' }, h('button', { type: 'button', class: 'ghost', onclick: () => done(false) }, no), yesBtn)
      )
    );
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    yesBtn.focus();
  });
}

function newId() {
  return `o-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
function fmtDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function byId(id) { return outfits.find((o) => o.id === id); }
function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

// A thumbnail <img>. Thumbnails are read from storage the first time they're shown, not all
// at start, so even a closet of thousands opens quickly.
const thumbLoading = new Map();
function thumbImg(id) {
  const img = h('img', { alt: '', decoding: 'async' });
  if (thumbUrls.has(id)) { img.src = thumbUrls.get(id); return img; }
  if (!thumbLoading.has(id)) {
    thumbLoading.set(id, getImage(`${id}:thumb`).then((blob) => {
      thumbLoading.delete(id);
      if (blob && !thumbUrls.has(id)) thumbUrls.set(id, URL.createObjectURL(blob));
      return thumbUrls.get(id);
    }));
  }
  thumbLoading.get(id).then((url) => { if (url) img.src = url; });
  return img;
}

function starSvg(size = 28) {
  const pts = '256,120 297.1,213.4 398.7,223.6 322.6,291.6 344.2,391.4 256,340 167.8,391.4 189.4,291.6 113.3,223.6 214.9,213.4';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '90 95 332 320');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `<polygon points="${pts}" fill="#D8AE6A" stroke="#D8AE6A" stroke-width="46" stroke-linejoin="round"/>` +
    `<polygon points="${pts}" fill="#F4C6D0" stroke="#F4C6D0" stroke-width="32" stroke-linejoin="round"/>`;
  return svg;
}

// ---------- codes ----------

// The QR holds {"Content":{"Content":"7Ixxxxxxxxx#"}}. Keep the # - the game uses it.
function codeFromQr(text) {
  try {
    const c = JSON.parse(text)?.Content?.Content;
    if (typeof c === 'string' && c.trim()) return c.trim();
  } catch (err) { /* not JSON, maybe a bare code */ }
  return /^[A-Za-z0-9]{6,24}#?$/.test(text.trim()) ? text.trim() : null;
}

function codeHint(code, selfId) {
  if (!code) return null;
  if (!code.endsWith('#')) return 'Looks like the # at the end is missing. Game codes always end with #.';
  const twin = outfits.find((o) => o.code === code && o.id !== selfId);
  if (twin) return `You already saved this code${twin.name ? ` as "${twin.name}"` : ''}.`;
  return null;
}

async function copyCode(code, btn) {
  try {
    await navigator.clipboard.writeText(code);
  } catch (err) {
    const ta = h('textarea', { value: code, style: 'position:fixed;opacity:0' });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  if (btn) {
    const was = btn.textContent;
    btn.textContent = 'Copied! ✨';
    btn.classList.add('done');
    setTimeout(() => { btn.textContent = was; btn.classList.remove('done'); }, 1400);
  } else {
    toast('Copied! ✨');
  }
}

// ---------- pictures ----------

// The date the game took the screenshot, from its filename:
//   PC:     2026_09_28_18_56_25_589418.jpeg  (local time)
//   Mobile: nn_share_1791514871846.jpg       (milliseconds since 1970, UTC)
function dateFromName(name, fallback) {
  let m = name.match(/^(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})/);
  if (m) return new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  m = name.match(/nn_share_(\d{13})/);
  if (m) return Number(m[1]);
  return fallback || Date.now();
}

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

// Returns { code, box } where box is the QR's white square, or null.
function readQr(bmp) {
  const W = bmp.width, H = bmp.height;
  const ctx = canvasOf(W, H).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const tryArea = (x, y, w, hh) => {
    const hit = jsQR(ctx.getImageData(x, y, w, hh).data, w, hh);
    if (!hit) return null;
    const code = codeFromQr(hit.data);
    if (!code) return null;
    const l = hit.location;
    const xs = [l.topLeftCorner.x, l.topRightCorner.x, l.bottomLeftCorner.x, l.bottomRightCorner.x];
    const ys = [l.topLeftCorner.y, l.topRightCorner.y, l.bottomLeftCorner.y, l.bottomRightCorner.y];
    const pad = (Math.max(...xs) - Math.min(...xs)) * 0.25; // the white border around the code
    return { code, box: { x: x + Math.min(...xs) - pad, y: y + Math.min(...ys) - pad } };
  };
  const cw = Math.round(W * QR_CORNER), ch = Math.round(H * QR_CORNER);
  return tryArea(W - cw, H - ch, cw, ch) || tryArea(0, 0, W, H);
}

// A tidy 3:4 thumbnail around Nikki, keeping clear of the QR corner.
// On wide game screenshots the game stands her left of the middle (about 38% across).
function thumbCrop(W, H, box) {
  let cw = Math.min(W, H * 0.75);
  let chh = cw / 0.75;
  const cx = box && W / H >= 1.4 ? W * 0.385 : W / 2;
  let x = Math.min(Math.max(cx - cw / 2, 0), W - cw);
  let y = (H - chh) * 0.3;
  if (box && x + cw > box.x && y + chh > box.y) {
    const shift = x + cw - box.x;
    if (shift <= W * 0.12 && x - shift >= 0) {
      x -= shift; // nudge left past the QR
    } else {
      chh = Math.max(box.y - y, H * 0.5); // stop above the QR
      cw = chh * 0.75;
      x = Math.min(Math.max(cx - cw / 2, 0), W - cw);
    }
  }
  return { x, y, w: cw, h: chh };
}

// crop: a frame the user picked by hand ({ x, y, w, h } in picture pixels), else automatic.
async function makeThumb(bmp, box, crop) {
  const r = crop || thumbCrop(bmp.width, bmp.height, box);
  const c = canvasOf(THUMB_W, THUMB_H);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, THUMB_W, THUMB_H);
  return toBlob(c, 0.82);
}

// Game QR screenshots are already compressed, so keep them exactly as they are.
// Anything big (phone QR shots, photo mode, normal screenshots) gets shrunk.
async function makeFull(file, bmp, isQr) {
  if (isQr && file.size <= KEEP_AS_IS_BYTES) return file;
  const scale = Math.min(1, FULL_MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = canvasOf(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return toBlob(c, 0.86);
}

// ---------- colors ----------

const COLORS = [
  { id: 'red', name: 'Red', hex: '#D9534F' },
  { id: 'pink', name: 'Pink', hex: '#F2A0B8' },
  { id: 'orange', name: 'Orange', hex: '#EE9A4D' },
  { id: 'gold', name: 'Gold / yellow', hex: '#E8C766' },
  { id: 'green', name: 'Green', hex: '#8CC084' },
  { id: 'blue', name: 'Blue', hex: '#7FA8DE' },
  { id: 'purple', name: 'Purple', hex: '#A98BD4' },
  { id: 'white', name: 'White', hex: '#FFFFFF' },
  { id: 'black', name: 'Black', hex: '#3A3333' },
  { id: 'brown', name: 'Brown', hex: '#9A6B4F' },
];

// Nikki's 4 skin tones (pale to dark) all have red clearly strongest and green ≈ blue,
// only the brightness differs. Measured from test screenshots, 2026-10-09.
function isSkin(r, g, b) {
  const rg = r - g, gb = g - b;
  return r >= 95 && r <= 245 && rg >= 15 && rg <= 65 && gb >= -10 && gb <= 25;
}

function colorOf(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let hue = 0;
  if (d) hue = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  if (hue < 0) hue += 360;
  if (l < 0.15) return 'black';
  if (s < 0.18) return l > 0.62 ? 'white' : l < 0.3 ? 'black' : null; // mid gray: not counted
  if (hue < 12 || hue >= 345) return l > 0.68 ? 'pink' : 'red';
  if (hue < 40) return l < 0.38 ? 'brown' : 'orange';
  if (hue < 62) return hue >= 50 && s < 0.45 ? 'green' : 'gold'; // muted yellow-green (olive, sage) looks green
  if (hue < 170) return 'green';
  if (hue < 255) return 'blue';
  if (hue < 290) return 'purple';
  return l < 0.3 ? 'purple' : 'pink';
}

// A guess at the outfit's main 1-2 colors, for game QR screenshots only.
// Learns the background from the picture's sides, then counts what's left around Nikki.
function guessColors(bmp) {
  const W = 160, H = Math.round(bmp.height * W / bmp.width);
  const ctx = canvasOf(W, H).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;
  const bin = (i) => (px[i] >> 5) * 64 + (px[i + 1] >> 5) * 8 + (px[i + 2] >> 5);
  const wide = bmp.width / bmp.height >= 1.4;
  const cx = wide ? 0.385 : 0.5;         // where Nikki stands
  const half = wide ? 0.13 : 0.16;        // how wide a strip to look at around her
  const bg = new Map();
  let bgN = 0;
  const learn = (x0, x1, y0, y1) => {
    for (let y = Math.round(H * y0); y < Math.round(H * y1); y++) {
      for (let x = Math.round(W * x0); x < Math.round(W * x1); x++) {
        const k = bin((y * W + x) * 4);
        bg.set(k, (bg.get(k) || 0) + 1);
        bgN++;
      }
    }
  };
  learn(0, 0.1, 0.18, 0.75);                     // left edge (below the logo)
  learn(0.9, 1, 0.1, 0.75);                      // right edge (above the QR)
  learn(Math.max(cx - half - 0.14, 0.02), cx - half - 0.04, 0.12, 0.6); // sky left of Nikki
  learn(cx + half + 0.06, Math.min(cx + half + 0.18, 0.88), 0.12, 0.6); // sky right of Nikki
  const counts = {};
  let n = 0;
  for (let y = Math.round(H * 0.06); y < Math.round(H * 0.95); y++) {
    for (let x = Math.round(W * (cx - half)); x < Math.round(W * (cx + half)); x++) {
      const i = (y * W + x) * 4;
      if ((bg.get(bin(i)) || 0) / bgN > 0.004) continue;
      if (isSkin(px[i], px[i + 1], px[i + 2])) continue;
      const c = colorOf(px[i], px[i + 1], px[i + 2]);
      if (!c) continue;
      counts[c] = (counts[c] || 0) + 1;
      n++;
    }
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!n) return { colors: [], shares: [] };
  const picked = ranked.filter(([, v], i) => i === 0 || (i < 2 && v / n >= 0.2)).map(([k]) => k);
  return { colors: picked, shares: ranked.slice(0, 4).map(([k, v]) => `${k} ${Math.round(100 * v / n)}%`) };
}

async function processPicture(file) {
  const bmp = await createImageBitmap(file);
  try {
    const qr = readQr(bmp);
    return {
      code: qr ? qr.code : '',
      fromQr: !!qr,
      full: await makeFull(file, bmp, !!qr),
      thumb: await makeThumb(bmp, qr && qr.box),
      thumbV: THUMB_VERSION,
      colors: qr ? guessColors(bmp).colors : [], // only game QR screenshots get a guess
      takenAt: dateFromName(file.name || '', file.lastModified),
      w: bmp.width,
      h: bmp.height,
    };
  } finally {
    bmp.close();
  }
}

// Remakes thumbnails made with an older crop (and guesses colors for outfits saved before the
// color guess existed), from the saved full picture.
async function refreshOldThumbs() {
  const old = outfits.filter((o) => o.hasPicture && (o.thumbV !== THUMB_VERSION || (o.fromQr && !o.colorsGuessed)));
  for (const o of old) {
    try {
      const full = await getImage(`${o.id}:full`);
      if (!full) continue;
      const bmp = await createImageBitmap(full);
      const qr = o.fromQr && !o.crop ? readQr(bmp) : null;
      const thumb = await makeThumb(bmp, qr && qr.box, o.crop);
      if (o.fromQr && !o.colorsGuessed) {
        if (!o.colors.length) o.colors = guessColors(bmp).colors;
        o.colorsGuessed = true;
      }
      bmp.close();
      o.thumbV = THUMB_VERSION;
      await tx(['outfits', 'images'], 'readwrite', (outfits, images) => {
        images.put(thumb, `${o.id}:thumb`);
        return outfits.put(o);
      });
      if (thumbUrls.has(o.id)) URL.revokeObjectURL(thumbUrls.get(o.id));
      thumbUrls.set(o.id, URL.createObjectURL(thumb));
    } catch (err) {
      console.error(err);
    }
  }
  if (old.length && state.view === 'closet') fillGrid();
}

function blankOutfit() {
  return {
    id: newId(), code: '', name: '', inspired: '', description: '', notes: '',
    account: accounts[0] ? accounts[0].id : null, favorite: false, styles: [], labels: [], colors: [], collections: [],
    takenAt: Date.now(), addedAt: Date.now(), fromQr: false, hasPicture: false, w: 0, h: 0,
  };
}

let importing = false;
async function addFiles(files) {
  const pics = [...files].filter((f) => f.type.startsWith('image/'));
  if (!pics.length || importing) return;
  importing = true;
  let added = 0, dupes = 0, noQr = 0, failed = 0, lastId = null;
  try {
    for (let i = 0; i < pics.length; i++) {
      if (pics.length > 1) toast(`Reading ${i + 1} of ${pics.length}…`, 60000);
      try {
        const p = await processPicture(pics[i]);
        if (p.code && outfits.some((o) => o.code === p.code)) { dupes++; continue; }
        const o = {
          ...blankOutfit(), code: p.code, fromQr: p.fromQr, hasPicture: true, takenAt: p.takenAt,
          w: p.w, h: p.h, thumbV: p.thumbV, colors: p.colors, colorsGuessed: true,
        };
        await saveOutfitWithImages(o, p.full, p.thumb);
        outfits.push(o);
        thumbUrls.set(o.id, URL.createObjectURL(p.thumb));
        added++;
        if (!p.fromQr) noQr++;
        lastId = o.id;
      } catch (err) {
        console.error(err);
        failed++;
      }
    }
  } finally {
    importing = false;
  }
  const bits = [];
  if (added) bits.push(`Added ${plural(added, 'outfit')} ✨`);
  if (dupes) bits.push(dupes === 1 && !added ? 'You already saved this one!' : `${dupes} already saved`);
  if (noQr) bits.push(`${noQr} without a QR code (add the code by hand)`);
  if (failed) bits.push(`${failed} couldn't be read`);
  toast(bits.join(' · ') || 'Nothing added', 3000);
  // One new outfit: open it so it can be named straight away.
  if (added === 1 && pics.length === 1) go('outfit', lastId);
  else render();
}

async function replacePicture(o, file) {
  try {
    const p = await processPicture(file);
    if (p.code && outfits.some((x) => x.code === p.code && x.id !== o.id)) {
      toast('That screenshot is already saved as another outfit.', 2500);
      return;
    }
    // A new picture gets the automatic thumbnail again (a hand-picked frame was for the old one).
    Object.assign(o, { hasPicture: true, fromQr: p.fromQr, takenAt: p.takenAt, w: p.w, h: p.h, thumbV: p.thumbV, crop: null });
    if (p.code) o.code = p.code;
    if (!o.colors.length) o.colors = p.colors; // colors already picked are kept
    await saveOutfitWithImages(o, p.full, p.thumb);
    if (thumbUrls.has(o.id)) URL.revokeObjectURL(thumbUrls.get(o.id));
    thumbUrls.set(o.id, URL.createObjectURL(p.thumb));
    toast(p.code ? 'Picture and code replaced ✨' : 'Picture replaced (no QR code found, code kept)', 2500);
  } catch (err) {
    console.error(err);
    toast("Couldn't read that picture.", 2000);
  }
  render();
}

// Saves a new thumbnail: from the hand-picked frame, or automatic when crop is null.
async function saveThumb(o, bmp, crop) {
  const box = !crop && o.fromQr ? (readQr(bmp) || {}).box : null;
  const thumb = await makeThumb(bmp, box, crop);
  o.crop = crop;
  o.thumbV = THUMB_VERSION;
  o.updatedAt = Date.now();
  await tx(['outfits', 'images'], 'readwrite', (outfits, images) => {
    images.put(thumb, `${o.id}:thumb`);
    return outfits.put(o);
  });
  if (thumbUrls.has(o.id)) URL.revokeObjectURL(thumbUrls.get(o.id));
  thumbUrls.set(o.id, URL.createObjectURL(thumb));
}

// ✂️ Adjust thumbnail: drag a 3:4 frame over the full picture, slider for size.
async function adjustThumbnail(o) {
  const full = await getImage(`${o.id}:full`);
  if (!full) return;
  const bmp = await createImageBitmap(full);
  const W = bmp.width, H = bmp.height;
  const maxW = Math.min(W, H * 0.75), minW = maxW * 0.25;
  let r = { ...(o.crop || thumbCrop(W, H, o.fromQr ? (readQr(bmp) || {}).box : null)) };
  const clamp = () => {
    r.w = Math.min(Math.max(r.w, minW), maxW);
    r.h = r.w / 0.75;
    r.x = Math.min(Math.max(r.x, 0), W - r.w);
    r.y = Math.min(Math.max(r.y, 0), H - r.h);
  };
  clamp();

  const url = URL.createObjectURL(full);
  const frame = h('div', { class: 'cropframe', 'aria-label': 'Thumbnail frame, drag to move' });
  const stage = h('div', { class: 'cropstage' }, h('img', { src: url, alt: '', draggable: false }), frame);
  const place = () => {
    Object.assign(frame.style, {
      left: `${(r.x / W) * 100}%`, top: `${(r.y / H) * 100}%`, width: `${(r.w / W) * 100}%`, height: `${(r.h / H) * 100}%`,
    });
  };
  place();

  // Drag the frame (mouse, finger or pen).
  let drag = null;
  frame.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    frame.setPointerCapture(e.pointerId);
    drag = { px: e.clientX, py: e.clientY, x: r.x, y: r.y, scale: W / stage.clientWidth };
  });
  frame.addEventListener('pointermove', (e) => {
    if (!drag) return;
    r.x = drag.x + (e.clientX - drag.px) * drag.scale;
    r.y = drag.y + (e.clientY - drag.py) * drag.scale;
    clamp();
    place();
  });
  const stop = () => { drag = null; };
  frame.addEventListener('pointerup', stop);
  frame.addEventListener('pointercancel', stop);

  // The slider changes the size around the frame's middle.
  const size = h('input', {
    type: 'range', min: Math.round(minW), max: Math.round(maxW), step: 1, value: Math.round(r.w), 'aria-label': 'Frame size',
    oninput: (e) => {
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      r.w = Number(e.target.value);
      r.h = r.w / 0.75;
      r.x = cx - r.w / 2;
      r.y = cy - r.h / 2;
      clamp();
      place();
    },
  });

  const close = () => { overlay.remove(); URL.revokeObjectURL(url); bmp.close(); render(); };
  const finish = async (crop, msg) => {
    try {
      await saveThumb(o, bmp, crop);
      toast(msg);
    } catch (err) {
      console.error(err);
      toast("Couldn't save the thumbnail.", 2000);
    }
    close();
  };
  const overlay = h('div', { class: 'overlay' },
    h('div', { class: 'dialog cropdialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Adjust thumbnail' },
      h('p', null, h('b', null, 'Adjust thumbnail'), h('br'), h('span', { class: 'muted small' }, 'Drag the frame to move it. The slider makes it bigger or smaller.')),
      h('div', { class: 'cropwrap' }, stage),
      h('label', { class: 'cropsize' }, h('span', null, 'Size'), size),
      h('div', { class: 'dialogbtns' },
        o.crop ? h('button', { type: 'button', class: 'ghost small', onclick: () => finish(null, 'Back to automatic ✨') }, 'Back to automatic') : null,
        h('button', { type: 'button', class: 'ghost', onclick: close }, 'Cancel'),
        h('button', {
          type: 'button', class: 'primary',
          onclick: () => finish({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }, 'Thumbnail saved ✨'),
        }, 'Save'))
    ));
  document.body.append(overlay);
}

function pickFiles(multiple, onFiles, accept = 'image/*') {
  const input = document.getElementById('filePick');
  input.multiple = multiple;
  input.accept = accept;
  input.value = '';
  input.onchange = () => { if (input.files.length) onFiles(input.files); };
  input.click();
}

// ---------- labels ----------

// Three kinds: Style (5, permanent), official game labels (grow with updates), and your own.
const CUSTOM_COLORS = ['#C98BA8', '#D08A7A', '#C9A25E', '#8FA889', '#6FA3A0', '#7FA0C4', '#9A86B8', '#8C7B70'];

async function loadLabels() {
  try {
    const res = await fetch('labels.json');
    gameLabels = await res.json();
  } catch (err) {
    console.error(err);
  }
  customLabels = (await getMeta('customLabels')) || [];
  prefs = { ...prefs, ...((await getMeta('prefs')) || {}) };
}

const saveCustomLabels = () => setMeta('customLabels', customLabels);
const styleById = (id) => gameLabels.style.find((s) => s.id === id);
const labelById = (id) => gameLabels.official.find((l) => l.id === id) || customLabels.find((l) => l.id === id);
const isCustom = (id) => id.startsWith('c-');

// Game labels first (in the game's order), then your own labels A-Z.
function sortedLabels(ids) {
  const rank = (l) => (isCustom(l.id) ? 1000 : gameLabels.official.indexOf(l));
  return ids.map(labelById).filter(Boolean)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function styleChip(s, on, onclick) {
  return h(onclick ? 'button' : 'span', {
    type: onclick ? 'button' : null, class: `style ${on ? 'on' : ''}`, style: `--c:${s.color}`, onclick,
    'aria-pressed': onclick ? String(on) : null,
  }, s.name);
}

function labelChip(l, on, onclick) {
  return h(onclick ? 'button' : 'span', {
    type: onclick ? 'button' : null, class: `label ${isCustom(l.id) ? 'mine' : ''} ${on ? 'on' : ''}`,
    style: `--c:${l.color}`, onclick, 'aria-pressed': onclick ? String(on) : null,
  }, isCustom(l.id) ? `🎀 ${l.name}` : l.name);
}

function colorDot(c, on, onclick, size = '') {
  return h(onclick ? 'button' : 'span', {
    type: onclick ? 'button' : null, class: `dot ${size} ${on ? 'on' : ''}`, style: `--c:${c.hex}`,
    title: c.name, 'aria-label': c.name, 'aria-pressed': onclick ? String(on) : null, onclick,
  });
}

function toggle(list, id) {
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
  else list.push(id);
}

async function addCustomLabel(name, color) {
  name = name.trim();
  if (!name) return null;
  const official = gameLabels.official.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (official) { toast(`"${official.name}" is already an official label`, 2000); return official; }
  const mine = customLabels.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (mine) return mine;
  const label = { id: `c-${Date.now().toString(36)}`, name, color };
  customLabels.push(label);
  await saveCustomLabels();
  return label;
}

// A small form: name + color, used on the outfit page and in Settings.
function newLabelForm(onAdded) {
  let color = CUSTOM_COLORS[customLabels.length % CUSTOM_COLORS.length];
  const input = h('input', { type: 'text', placeholder: 'New label, e.g. cozy days', maxLength: 30, 'aria-label': 'New label name' });
  const swatches = h('div', { class: 'swatches' }, CUSTOM_COLORS.map((c) => h('button', {
    type: 'button', class: `swatch ${c === color ? 'on' : ''}`, style: `--c:${c}`, 'aria-label': `Color ${c}`,
    onclick: (e) => {
      color = c;
      [...swatches.children].forEach((b) => b.classList.toggle('on', b === e.currentTarget));
    },
  })));
  const add = async () => {
    const label = await addCustomLabel(input.value, color);
    if (label) onAdded(label);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  return h('div', { class: 'newlabel' },
    h('div', { class: 'coderow' }, input, h('button', { type: 'button', class: 'copy', onclick: add }, '＋ Add')),
    swatches);
}

// If a game update adds an official label with the same name as one of yours, offer to merge them.
async function offerMerges() {
  for (const mine of [...customLabels]) {
    const official = gameLabels.official.find((l) => l.name.toLowerCase() === mine.name.toLowerCase());
    if (!official) continue;
    const users = outfits.filter((o) => o.labels.includes(mine.id));
    const ok = await ask(`The game now has an official "${official.name}" label. ` +
      `Move ${plural(users.length, 'outfit')} from your own "${mine.name}" label to the official one?`, 'Move them', 'Not now');
    if (!ok) continue;
    for (const o of users) {
      o.labels = o.labels.filter((id) => id !== mine.id);
      if (!o.labels.includes(official.id)) o.labels.push(official.id);
      await saveOutfit(o, true);
    }
    customLabels = customLabels.filter((l) => l !== mine);
    await saveCustomLabels();
  }
}

// ---------- accounts ----------

// Only for people who play on more than one game account. With fewer than 2, it's never shown.
async function loadAccounts() {
  accounts = (await getMeta('accounts')) || [];
  // Outfits saved before accounts could be named had 'main'/'alt'; those don't point anywhere now.
  for (const o of outfits) {
    if (o.account && !accounts.some((a) => a.id === o.account)) {
      o.account = null;
      await saveOutfit(o, true);
    }
  }
}
const saveAccounts = () => setMeta('accounts', accounts);

// One account at a time; tapping the chosen one again clears it.
function accountPicker(current, onPick) {
  return h('div', { class: 'chips', role: 'group', 'aria-label': 'Account' }, accounts.map((a) => h('button', {
    type: 'button', class: `chip ${current === a.id ? 'on' : ''}`, 'aria-pressed': String(current === a.id),
    onclick: () => onPick(current === a.id ? null : a.id),
  }, a.name)));
}

function accountsPanel() {
  const panel = h('section', { class: 'panel' });
  const redraw = () => panel.replaceWith(accountsPanel());
  const input = h('input', { type: 'text', placeholder: 'Account name, e.g. Main', maxLength: 24, 'aria-label': 'New account name' });
  const add = async () => {
    const name = input.value.trim();
    if (!name) return;
    accounts.push({ id: `a-${Date.now().toString(36)}`, name });
    await saveAccounts();
    // The first account becomes home for everything already saved.
    if (accounts.length === 1) {
      for (const o of outfits) { o.account = accounts[0].id; await saveOutfit(o, true); }
    }
    redraw();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  put(panel,
    h('h2', null, 'Your accounts'),
    h('p', { class: 'muted small' }, accounts.length > 1
      ? 'New outfits go to your first account. Change it on any outfit, or filter the closet by account.'
      : 'Only needed if you play on more than one game account. Add them all here (at least 2), and each outfit gets an account you can filter by.'),
    ...accounts.map((a, i) => {
      const uses = outfits.filter((o) => o.account === a.id).length;
      return h('div', { class: 'labelrow' },
        h('input', {
          type: 'text', value: a.name, maxLength: 24, 'aria-label': `Rename ${a.name}`,
          onchange: async (e) => {
            const name = e.target.value.trim();
            if (!name) { e.target.value = a.name; return; }
            a.name = name;
            await saveAccounts();
            toast('Saved');
          },
        }),
        i === 0 ? h('span', { class: 'muted small' }, 'first · new outfits go here') : null,
        h('span', { class: 'muted small' }, plural(uses, 'outfit')),
        h('button', {
          type: 'button', class: 'ghost small',
          onclick: async () => {
            if (!await ask(`Remove the account "${a.name}"?${uses ? ` Its ${plural(uses, 'outfit')} will stay in your closet, just without an account.` : ''}`, 'Remove', 'Keep it', true)) return;
            for (const o of outfits.filter((x) => x.account === a.id)) { o.account = null; await saveOutfit(o, true); }
            accounts = accounts.filter((x) => x !== a);
            if (state.filter.account === a.id) state.filter.account = null;
            await saveAccounts();
            redraw();
          },
        }, 'Remove')
      );
    }),
    h('div', { class: 'newlabel' }, h('div', { class: 'coderow' }, input, h('button', { type: 'button', class: 'copy', onclick: add }, '＋ Add')))
  );
  return panel;
}

// ---------- collections ----------

const saveCollections = () => setMeta('collections', collections);
const collectionById = (id) => collections.find((c) => c.id === id);
const inCollection = (c) => outfits.filter((o) => o.collections.includes(c.id));

// The cover is the outfit picked for it, or else the newest outfit in it.
function coverOf(c) {
  const members = inCollection(c);
  const picked = members.find((o) => o.id === c.cover);
  return picked || members.sort((a, b) => b.takenAt - a.takenAt)[0] || null;
}

async function newCollection(name) {
  name = (name || '').trim();
  if (!name) return null;
  const same = collections.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (same) return same;
  const c = { id: `k-${Date.now().toString(36)}`, name, cover: null };
  collections.push(c);
  await saveCollections();
  return c;
}

// A small box asking for a name. Resolves to the name, or null if cancelled.
function askName(title, value = '', okText = 'Save') {
  return new Promise((resolve) => {
    const done = (v) => { overlay.remove(); resolve(v); };
    const input = h('input', { type: 'text', value, maxLength: 40, placeholder: 'e.g. Cosplays', 'aria-label': title });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value.trim() || null); if (e.key === 'Escape') done(null); });
    const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) done(null); } },
      h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
        h('p', null, h('b', null, title)),
        input,
        h('div', { class: 'dialogbtns' },
          h('button', { type: 'button', class: 'ghost', onclick: () => done(null) }, 'Cancel'),
          h('button', { type: 'button', class: 'primary', onclick: () => done(input.value.trim() || null) }, okText))
      ));
    document.body.append(overlay);
    input.focus();
    input.select();
  });
}

// Pick a collection (or make a new one) for the selected outfits.
function chooseCollection() {
  return new Promise((resolve) => {
    const done = (v) => { overlay.remove(); resolve(v); };
    const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) done(null); } },
      h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
        h('p', null, h('b', null, 'Add to which collection?')),
        h('div', { class: 'chips pickcoll' },
          collections.map((c) => h('button', { type: 'button', class: 'chip', onclick: () => done(c) }, c.name)),
          h('button', {
            type: 'button', class: 'chipadd',
            onclick: async () => { overlay.remove(); const name = await askName('New collection', '', 'Create'); resolve(name ? await newCollection(name) : null); },
          }, '＋ New collection')
        ),
        h('div', { class: 'dialogbtns' }, h('button', { type: 'button', class: 'ghost', onclick: () => done(null) }, 'Cancel'))
      ));
    document.body.append(overlay);
  });
}

function shelfButton(key, label, cover) {
  const on = state.shelf === key;
  return h('button', {
    type: 'button', class: `shelfbtn ${on ? 'on' : ''}`, role: 'tab', 'aria-selected': String(on),
    onclick: () => { state.shelf = key; state.selected.clear(); render(); },
  },
  cover !== undefined
    ? (cover && cover.hasPicture ? thumbImg(cover.id) : h('span', { class: 'nocover' }, starSvg(16)))
    : null,
  label);
}

function renderShelf() {
  return h('div', { class: 'shelf', role: 'tablist', 'aria-label': 'Collections' },
    shelfButton('all', 'All'),
    shelfButton('fav', '⭐ Favorites'),
    collections.map((c) => shelfButton(c.id, `${c.name} · ${inCollection(c).length}`, coverOf(c))),
    h('button', {
      type: 'button', class: 'shelfbtn add',
      onclick: async () => {
        const c = await newCollection(await askName('New collection', '', 'Create'));
        if (c) { state.shelf = c.id; render(); }
      },
    }, '＋ New')
  );
}

// Shown above the grid while a collection is open.
function collectionHeader(c) {
  return h('div', { class: 'collhead' },
    h('h2', null, c.name),
    h('div', { class: 'collbtns' },
      h('button', {
        type: 'button', class: 'ghost small', disabled: !inCollection(c).length, title: 'Make a file to send to a friend',
        onclick: () => shareCollection(c),
      }, '📤 Share'),
      h('button', {
        type: 'button', class: 'ghost small',
        onclick: async () => {
          const name = await askName('Rename collection', c.name);
          if (!name) return;
          c.name = name;
          await saveCollections();
          render();
        },
      }, '✏️ Rename'),
      h('button', {
        type: 'button', class: 'ghost small',
        onclick: async () => {
          if (!await ask(`Delete the collection "${c.name}"? The outfits in it stay in your closet.`, 'Delete', 'Keep it', true)) return;
          for (const o of inCollection(c)) {
            o.collections = o.collections.filter((id) => id !== c.id);
            await saveOutfit(o, true);
          }
          collections = collections.filter((x) => x !== c);
          await saveCollections();
          state.shelf = 'all';
          render();
        },
      }, 'Delete')
    )
  );
}

function updateSelectBar() {
  const bar = document.getElementById('selectbar');
  if (!bar) return;
  const n = state.selected.size;
  bar.querySelector('.selcount').textContent = n ? `${n} selected` : 'Tap outfits to select them';
  bar.querySelectorAll('.needs').forEach((b) => { b.disabled = !n; });
  const shown = visibleOutfits();
  bar.querySelector('.selall').textContent =
    shown.length && shown.every((o) => state.selected.has(o.id)) ? 'Select none' : `Select all (${shown.length})`;
}

// Deletes many outfits at once, in one go (like the game's lookbook and photo album).
async function deleteOutfits(list) {
  const ids = list.map((o) => o.id);
  await tx(['outfits', 'images'], 'readwrite', (os, is) => {
    for (const id of ids) {
      is.delete(`${id}:full`);
      is.delete(`${id}:thumb`);
      os.delete(id);
    }
  });
  outfits = outfits.filter((o) => !ids.includes(o.id));
  for (const id of ids) {
    if (thumbUrls.has(id)) URL.revokeObjectURL(thumbUrls.get(id));
    thumbUrls.delete(id);
  }
}

function selectBar() {
  const coll = collectionById(state.shelf);
  const picked = () => outfits.filter((o) => state.selected.has(o.id));
  const finish = (msg) => { state.selecting = false; state.selected.clear(); toast(msg, 1600); render(); };
  const bar = h('div', { id: 'selectbar', class: 'selectbar' },
    h('span', { class: 'selcount' }),
    h('div', { class: 'collbtns' },
      h('button', {
        type: 'button', class: 'primary small needs',
        onclick: async () => {
          const c = await chooseCollection();
          if (!c) return;
          const list = picked();
          for (const o of list) {
            if (!o.collections.includes(c.id)) { o.collections.push(c.id); await saveOutfit(o, true); }
          }
          finish(`Added ${plural(list.length, 'outfit')} to ${c.name} ✨`);
        },
      }, '＋ Add to collection'),
      coll ? h('button', {
        type: 'button', class: 'ghost small needs',
        onclick: async () => {
          const list = picked();
          for (const o of list) {
            o.collections = o.collections.filter((id) => id !== coll.id);
            await saveOutfit(o, true);
          }
          finish(`Removed ${plural(list.length, 'outfit')} from ${coll.name}`);
        },
      }, 'Remove from here') : null,
      h('button', {
        type: 'button', class: 'danger small needs',
        onclick: async () => {
          const list = picked();
          if (!await ask(`Delete ${plural(list.length, 'outfit')}? Their pictures and codes will be gone. This can't be undone.`,
            'Delete', 'Keep them', true)) return;
          await deleteOutfits(list);
          finish(`Deleted ${plural(list.length, 'outfit')}`);
        },
      }, '🗑️ Delete'),
      h('button', {
        type: 'button', class: 'ghost small selall',
        onclick: () => {
          const shown = visibleOutfits();
          const all = shown.every((o) => state.selected.has(o.id));
          shown.forEach((o) => (all ? state.selected.delete(o.id) : state.selected.add(o.id)));
          fillGrid(state.gridShown);
          updateSelectBar();
        },
      }, 'Select all'),
      h('button', { type: 'button', class: 'ghost small', onclick: () => { state.selecting = false; state.selected.clear(); render(); } }, 'Done')
    )
  );
  setTimeout(updateSelectBar, 0);
  return bar;
}

// ---------- sharing one outfit ----------

// A ready-made post: name (inspired by), description, code. Never the private notes.
function shareText(o) {
  const title = [o.name || 'My outfit', o.inspired ? `(${o.inspired})` : ''].filter(Boolean).join(' ');
  return [`✨ ${title}`, o.description, o.code ? `Code: ${o.code}` : ''].filter(Boolean).join('\n');
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    const ta = h('textarea', { value: text, style: 'position:fixed;opacity:0' });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  flash(btn, 'Copied! ✨');
}

function flash(btn, text) {
  const was = btn.textContent;
  btn.textContent = text;
  btn.classList.add('done');
  setTimeout(() => { btn.textContent = was; btn.classList.remove('done'); }, 1400);
}

// Clipboards only take PNG pictures, so the JPEG is redrawn as a PNG first.
async function copyPicture(o, btn) {
  try {
    const bmp = await createImageBitmap(await getImage(`${o.id}:full`));
    const c = canvasOf(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    const png = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    flash(btn, 'Copied! ✨');
  } catch (err) {
    console.error(err);
    toast("This browser won't let the picture be copied.", 2500);
  }
}

// Phones: the normal share menu, with the picture and the text together.
async function sharePicture(o) {
  try {
    const blob = await getImage(`${o.id}:full`);
    const file = new File([blob], `${(o.name || 'outfit').replace(/[\\/:*?"<>|]+/g, '')}.jpg`, { type: blob.type || 'image/jpeg' });
    const data = { files: [file], text: shareText(o) };
    if (navigator.canShare && navigator.canShare(data)) await navigator.share(data);
    else await navigator.share({ text: shareText(o) });
  } catch (err) {
    if (err.name !== 'AbortError') { console.error(err); toast("Couldn't open the share menu.", 2000); }
  }
}

function sharePanel(o) {
  const canCopyPic = o.hasPicture && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write;
  const canShare = !!navigator.share && o.hasPicture;
  if (!o.code && !o.hasPicture) return null;
  if (o.private) {
    return h('section', { class: 'panel' }, h('h2', null, 'Share'),
      h('p', { class: 'muted small' }, "🔒 This outfit is private, so it can't be shared and is left out of shared collections. Your backups still keep it."));
  }
  const preview = h('pre', { class: 'sharetext' }, shareText(o));
  return h('section', { class: 'panel' },
    h('h2', null, 'Share'),
    preview,
    h('div', { class: 'collbtns' },
      h('button', { type: 'button', class: 'copy', onclick: (e) => copyText(shareText(o), e.currentTarget) }, '📋 Copy text'),
      canCopyPic ? h('button', { type: 'button', class: 'ghost small', onclick: (e) => copyPicture(o, e.currentTarget) }, '🖼️ Copy picture') : null,
      canShare ? h('button', { type: 'button', class: 'ghost small', onclick: () => sharePicture(o) }, '📤 Share…') : null
    ),
    h('p', { class: 'muted small' }, 'Notes are never included.')
  );
}

// On an outfit's page: which collections it's in. Opened from a collection, it can become its cover.
function collectionsPanel(o) {
  const panel = h('section', { class: 'panel' });
  const redraw = () => panel.replaceWith(collectionsPanel(o));
  const from = collectionById(state.shelf);
  put(panel,
    h('h2', null, 'Collections'),
    h('div', { class: 'chips' },
      collections.map((c) => h('button', {
        type: 'button', class: `chip ${o.collections.includes(c.id) ? 'on' : ''}`, 'aria-pressed': String(o.collections.includes(c.id)),
        onclick: () => { toggle(o.collections, c.id); saveOutfit(o, true); redraw(); },
      }, c.name)),
      h('button', {
        type: 'button', class: 'chipadd',
        onclick: async () => {
          const c = await newCollection(await askName('New collection', '', 'Create'));
          if (!c) return;
          if (!o.collections.includes(c.id)) o.collections.push(c.id);
          await saveOutfit(o, true);
          redraw();
        },
      }, '＋ New collection')
    ),
    from && o.collections.includes(from.id) && o.hasPicture
      ? (coverOf(from) === o && from.cover === o.id
        ? h('p', { class: 'muted small' }, `⭐ This is the cover of ${from.name}.`)
        : h('button', {
          type: 'button', class: 'ghost small covbtn',
          onclick: async () => { from.cover = o.id; await saveCollections(); toast(`Cover of ${from.name} ✨`); redraw(); },
        }, `🖼️ Use as cover of ${from.name}`))
      : null
  );
  return panel;
}

// ---------- Closet ----------

// Filters combine: an outfit must have every selected style, label and color.
function visibleOutfits() {
  const q = state.q.trim().toLowerCase();
  const f = state.filter;
  const list = outfits.filter((o) =>
    (state.shelf === 'all' || (state.shelf === 'fav' ? o.favorite : o.collections.includes(state.shelf))) &&
    f.styles.every((id) => o.styles.includes(id)) &&
    f.labels.every((id) => o.labels.includes(id)) &&
    f.colors.every((id) => o.colors.includes(id)) &&
    (!f.account || o.account === f.account) &&
    (!q || [o.name, o.inspired, o.description, o.notes, o.code].some((t) => (t || '').toLowerCase().includes(q)))
  );
  list.sort((a, b) => (state.sort === 'newest' ? b.takenAt - a.takenAt : a.takenAt - b.takenAt));
  return list;
}

function outfitCard(o) {
  const fav = h('button', {
    type: 'button', class: `fav ${o.favorite ? 'on' : ''}`, 'aria-label': o.favorite ? 'Unfavorite' : 'Favorite',
    onclick: (e) => {
      e.stopPropagation();
      o.favorite = !o.favorite;
      saveOutfit(o, true);
      fav.classList.toggle('on', o.favorite);
      if (state.shelf === 'fav') fillGrid();
    },
  }, '★');
  // In select mode, tapping a picture ticks it instead of opening it.
  const picked = state.selecting && state.selected.has(o.id);
  const open = state.selecting
    ? (e) => {
      if (state.selected.has(o.id)) state.selected.delete(o.id);
      else state.selected.add(o.id);
      e.currentTarget.closest('.card').classList.toggle('picked', state.selected.has(o.id));
      updateSelectBar();
    }
    : () => go('outfit', o.id);
  const thumb = o.hasPicture
    ? thumbImg(o.id)
    : h('div', { class: 'nopic' }, starSvg(44), h('small', null, 'No picture yet'));
  const chips = [
    ...o.styles.map(styleById).filter(Boolean).map((s) => styleChip(s, true)),
    ...sortedLabels(o.labels).map((l) => labelChip(l, true)),
  ];
  return h('article', { class: `card ${state.selecting ? 'selecting' : ''} ${picked ? 'picked' : ''}` },
    h('button', {
      type: 'button', class: 'thumb', onclick: open,
      'aria-label': state.selecting ? `Select ${o.name || 'outfit'}` : `Open ${o.name || 'outfit'}`,
    }, thumb, state.selecting ? h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓') : null),
    fav,
    o.private ? h('span', { class: 'lockbadge', title: 'Private', 'aria-label': 'Private' }, '🔒') : null,
    h('div', { class: 'body' },
      h('p', { class: `name ${o.name ? '' : 'untitled'}` }, o.name || 'Untitled'),
      h('p', { class: 'sub' }, o.inspired || fmtDate(o.takenAt)),
      o.colors.length ? h('div', { class: 'dots' }, COLORS.filter((c) => o.colors.includes(c.id)).map((c) => colorDot(c, true))) : null,
      chips.length ? h('div', { class: 'chips' }, chips.slice(0, 3), chips.length > 3 ? h('span', { class: 'more' }, `+${chips.length - 3}`) : null) : null,
      o.code
        ? h('button', { type: 'button', class: 'copy', onclick: (e) => copyCode(o.code, e.currentTarget) }, '📋 Copy code')
        : h('button', { type: 'button', class: 'copy add', onclick: open }, '＋ Add code')
    )
  );
}

// Big closets (thousands of outfits) stay fast: cards are drawn in batches as you scroll,
// instead of all at once. keep = how many to draw straight away (to come back to the same spot).
const GRID_BATCH = 120;
let gridObserver = null;
function fillGrid(keep = 0) {
  const grid = document.getElementById('grid');
  if (!grid) return;
  const list = visibleOutfits();
  state.gridShown = Math.min(list.length, Math.max(GRID_BATCH, Number(keep) || 0));
  grid.replaceChildren(...list.slice(0, state.gridShown).map(outfitCard));
  if (gridObserver) gridObserver.disconnect();
  document.getElementById('gridMore')?.remove();
  if (state.gridShown < list.length) {
    const more = h('div', { id: 'gridMore', 'aria-hidden': 'true' });
    grid.after(more);
    const loadMore = () => {
      // Keep adding batches while the end of the grid is near the bottom of the screen.
      while (state.gridShown < list.length && more.getBoundingClientRect().top < window.innerHeight + 800) {
        const next = list.slice(state.gridShown, state.gridShown + GRID_BATCH);
        state.gridShown += next.length;
        grid.append(...next.map(outfitCard));
      }
      if (state.gridShown >= list.length) { gridObserver.disconnect(); more.remove(); }
    };
    gridObserver = new IntersectionObserver((entries) => { if (entries[0].isIntersecting) loadMore(); }, { rootMargin: '800px' });
    gridObserver.observe(more);
  }
  const note = document.getElementById('gridNote');
  const searching = filterCount() || state.q;
  note.textContent = !outfits.length ? ''
    : !list.length && !searching && state.shelf === 'fav' ? 'No favorites yet. Tap ★ on an outfit.'
    : !list.length && !searching && state.shelf !== 'all' ? 'This collection is empty. Use Select to add outfits, or add one from its page.'
    : !list.length ? 'Nothing matches.'
    : searching ? `Showing ${list.length} of ${outfits.length}` : '';
}

function filterCount() {
  const f = state.filter;
  return f.styles.length + f.labels.length + f.colors.length + (f.account ? 1 : 0);
}

// Only labels that are actually on an outfit are offered as filters, to keep the list short.
function filterPanel() {
  const f = state.filter;
  const redo = () => render();
  const labels = sortedLabels([...new Set([...outfits.flatMap((o) => o.labels), ...f.labels])]);
  return h('section', { class: 'panel filters' },
    h('h2', null, 'Style'),
    h('div', { class: 'chips' }, gameLabels.style.map((s) =>
      styleChip(s, f.styles.includes(s.id), () => { f.styles = f.styles.includes(s.id) ? [] : [s.id]; redo(); }))),
    h('h2', null, 'Colors'),
    h('div', { class: 'dots' }, COLORS.map((c) =>
      colorDot(c, f.colors.includes(c.id), () => { toggle(f.colors, c.id); redo(); }, 'big'))),
    h('h2', null, 'Labels'),
    labels.length
      ? h('div', { class: 'chips' }, labels.map((l) => labelChip(l, f.labels.includes(l.id), () => { toggle(f.labels, l.id); redo(); })))
      : h('p', { class: 'muted small' }, 'Labels you add to outfits show up here.'),
    accounts.length > 1 ? [h('h2', null, 'Account'), accountPicker(f.account, (id) => { f.account = id; redo(); })] : null,
    filterCount() ? h('button', {
      type: 'button', class: 'ghost small clear',
      onclick: () => { state.filter = { styles: [], labels: [], colors: [], account: null }; redo(); },
    }, 'Clear filters') : null
  );
}

function renderCloset() {
  if (state.shelf !== 'all' && state.shelf !== 'fav' && !collectionById(state.shelf)) state.shelf = 'all';
  const coll = collectionById(state.shelf);
  const controls = outfits.length ? h('div', { class: 'controls' },
    h('input', {
      type: 'search', placeholder: 'Search names, notes, codes…', value: state.q, 'aria-label': 'Search',
      oninput: (e) => { state.q = e.target.value; fillGrid(); },
    }),
    h('select', { 'aria-label': 'Sort', onchange: (e) => { state.sort = e.target.value; fillGrid(); } },
      h('option', { value: 'newest', selected: state.sort === 'newest' }, 'Newest first'),
      h('option', { value: 'oldest', selected: state.sort === 'oldest' }, 'Oldest first')
    ),
    h('button', {
      type: 'button', class: `ghost filterbtn ${state.showFilters || filterCount() ? 'on' : ''}`, 'aria-expanded': String(state.showFilters),
      onclick: () => { state.showFilters = !state.showFilters; render(); },
    }, filterCount() ? `Filter · ${filterCount()}` : 'Filter'),
    h('button', {
      type: 'button', class: `ghost filterbtn ${state.selecting ? 'on' : ''}`,
      onclick: () => { state.selecting = !state.selecting; state.selected.clear(); render(); },
    }, state.selecting ? 'Cancel' : 'Select')
  ) : null;
  const empty = !outfits.length ? h('div', { class: 'empty' },
    starSvg(64),
    h('p', null, h('b', null, 'Your closet is empty.')),
    h('p', null, 'Add the QR screenshots you share from the game. Pocket Closet reads the code and keeps the picture.'),
    h('p', { class: 'muted' }, 'You can also drag them in or paste with Ctrl+V, lots at once.')
  ) : null;
  return [
    h('header', { class: 'top' },
      h('h1', null, starSvg(30), 'Pocket Closet'),
      h('span', { class: 'count' }, outfits.length ? plural(outfits.length, 'outfit') : '')
    ),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'primary', onclick: () => pickFiles(true, addFiles) }, '＋ Add screenshots'),
      h('button', { type: 'button', class: 'ghost', onclick: addByCode }, 'Add by code')
    ),
    outfits.length ? renderShelf() : null,
    controls,
    outfits.length && state.showFilters ? filterPanel() : null,
    coll ? collectionHeader(coll) : null,
    empty,
    h('p', { id: 'gridNote', class: 'muted' }),
    h('div', { id: 'grid', class: 'grid' }),
    state.selecting ? selectBar() : null,
  ];
}

async function addByCode() {
  const o = blankOutfit();
  await saveOutfit(o, true);
  outfits.push(o);
  go('outfit', o.id);
  document.querySelector('.codeInput')?.focus();
}

// ---------- One outfit ----------

function textField(o, key, label, opts = {}) {
  const props = {
    value: o[key] || '', placeholder: opts.placeholder || '',
    onchange: (e) => {
      o[key] = e.target.value.trim();
      saveOutfit(o);
      const preview = document.querySelector('.sharetext');
      if (preview) preview.textContent = shareText(o);
    },
  };
  return h('label', { class: 'field' }, h('span', null, label),
    opts.multi ? h('textarea', { ...props, rows: 3 }) : h('input', { ...props, type: 'text' }));
}

// The code is shown locked, so it can't be changed by accident. ✏️ Edit unlocks it until Save/Cancel.
function codeSection(o, editing = !o.code) {
  const wrap = h('div');
  const redraw = (ed) => wrap.replaceWith(codeSection(o, ed));
  if (!editing) {
    put(wrap, h('div', { class: 'coderow' },
      h('code', { class: 'codeShow' }, o.code),
      h('button', { type: 'button', class: 'copy', onclick: (e) => copyCode(o.code, e.currentTarget) }, '📋 Copy'),
      h('button', { type: 'button', class: 'ghost small', 'aria-label': 'Edit code', onclick: () => redraw(true) }, '✏️ Edit')
    ));
    return wrap;
  }
  const hint = h('p', { class: 'hint' }, codeHint(o.code, o.id) || '');
  const save = () => {
    o.code = input.value.trim();
    saveOutfit(o);
    redraw(false);
  };
  const input = h('input', {
    type: 'text', class: 'codeInput', value: o.code, placeholder: 'Paste the code, e.g. 7Ixxxxxxxxx#',
    autocomplete: 'off', spellcheck: false, 'aria-label': 'Outfit code',
    oninput: () => { hint.textContent = codeHint(input.value.trim(), o.id) || ''; },
    onkeydown: (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape' && o.code) redraw(false); },
  });
  put(wrap,
    h('div', { class: 'coderow' }, input,
      h('button', { type: 'button', class: 'copy', onclick: save }, 'Save'),
      o.code ? h('button', { type: 'button', class: 'ghost small', onclick: () => redraw(false) }, 'Cancel') : null
    ),
    hint
  );
  setTimeout(() => input.focus(), 0);
  return wrap;
}

// Style and labels for one outfit. Chosen labels show up front; "＋ Labels" opens the full list.
function labelsPanel(o) {
  const panel = h('section', { class: 'panel' });
  const redraw = () => panel.replaceWith(labelsPanel(o));
  const flip = (list, id) => { toggle(list, id); saveOutfit(o, true); redraw(); };
  const chosen = sortedLabels(o.labels);
  put(panel,
    h('h2', null, 'Style'),
    // In game an outfit has exactly one Style, so picking one replaces the other.
    h('div', { class: 'chips' }, gameLabels.style.map((s) => styleChip(s, o.styles.includes(s.id), () => {
      o.styles = o.styles.includes(s.id) ? [] : [s.id];
      saveOutfit(o, true);
      redraw();
    }))),
    h('h2', null, 'Labels'),
    h('div', { class: 'chips' },
      chosen.map((l) => labelChip(l, true, () => flip(o.labels, l.id))),
      h('button', {
        type: 'button', class: 'chipadd', 'aria-expanded': String(state.pickingLabels),
        onclick: () => { state.pickingLabels = !state.pickingLabels; redraw(); },
      }, state.pickingLabels ? 'Done' : '＋ Labels')
    )
  );
  if (state.pickingLabels) {
    // Each section folds away, and stays folded (some people never use the game labels).
    const fold = (key, title) => h('button', {
      type: 'button', class: 'foldbtn', 'aria-expanded': String(!prefs[key]),
      onclick: () => { prefs[key] = !prefs[key]; setMeta('prefs', prefs); redraw(); },
    }, `${prefs[key] ? '▸' : '▾'} ${title}`);
    const mine = [...customLabels].sort((a, b) => a.name.localeCompare(b.name));
    put(panel, h('div', { class: 'picker' },
      fold('foldGame', 'Game labels'),
      prefs.foldGame ? null
        : h('div', { class: 'chips' }, gameLabels.official.map((l) => labelChip(l, o.labels.includes(l.id), () => flip(o.labels, l.id)))),
      fold('foldMine', 'Your labels'),
      prefs.foldMine ? null : [
        mine.length ? h('div', { class: 'chips' }, mine.map((l) => labelChip(l, o.labels.includes(l.id), () => flip(o.labels, l.id)))) : null,
        newLabelForm((label) => {
          if (!o.labels.includes(label.id)) o.labels.push(label.id);
          saveOutfit(o, true);
          redraw();
        }),
      ]
    ));
  }
  return panel;
}

function colorsPanel(o) {
  const panel = h('section', { class: 'panel' });
  put(panel,
    h('h2', null, 'Colors'),
    h('div', { class: 'dots' }, COLORS.map((c) => colorDot(c, o.colors.includes(c.id), () => {
      toggle(o.colors, c.id);
      o.colorsEdited = true;
      saveOutfit(o, true);
      panel.replaceWith(colorsPanel(o));
    }, 'big'))),
    h('p', { class: 'muted small' }, o.colors.length
      ? COLORS.filter((c) => o.colors.includes(c.id)).map((c) => c.name).join(' · ') + (o.fromQr && !o.colorsEdited ? '  (guessed from the screenshot, tap to fix)' : '')
      : 'Tap the colors this outfit is mostly made of.')
  );
  return panel;
}

function renderOutfit() {
  const o = byId(state.openId);
  if (!o) { state.view = 'closet'; return renderCloset(); }

  const pic = h('div', { class: 'bigpic' });
  if (o.hasPicture) {
    getImage(`${o.id}:full`).then((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      pic.append(h('img', { src: url, alt: o.name || 'Outfit', onload: () => setTimeout(() => URL.revokeObjectURL(url), 1000) }));
    });
  } else {
    pic.append(h('div', { class: 'nopic big' }, starSvg(64), h('small', null, 'No picture yet')));
  }

  const favBtn = h('button', {
    type: 'button', class: `chip ${o.favorite ? 'on' : ''}`,
    onclick: () => { o.favorite = !o.favorite; saveOutfit(o); favBtn.classList.toggle('on', o.favorite); favBtn.textContent = o.favorite ? '⭐ Favorite' : '☆ Favorite'; },
  }, o.favorite ? '⭐ Favorite' : '☆ Favorite');

  // 🔒 Private: never shared, not even inside a shared collection. Backups still keep it.
  const privBtn = h('button', {
    type: 'button', class: `chip ${o.private ? 'on' : ''}`, 'aria-pressed': String(!!o.private),
    onclick: () => { o.private = !o.private; saveOutfit(o); render(); },
  }, o.private ? '🔒 Private' : '🔓 Private');

  const accountField = h('div', { class: 'field' }, h('span', null, 'Account'));
  const drawAccount = () => accountField.replaceChildren(h('span', null, 'Account'),
    accountPicker(o.account, (id) => { o.account = id; saveOutfit(o); drawAccount(); }));
  drawAccount();

  return [
    h('div', { class: 'detailbar' },
      h('button', { type: 'button', class: 'ghost', onclick: () => go('closet') }, '‹ Closet'),
      h('div', { class: 'collbtns' }, privBtn, favBtn)
    ),
    pic,
    h('section', { class: 'panel' },
      codeSection(o),
      h('p', { class: 'muted small' },
        o.fromQr ? `Read from the QR code · taken ${fmtDate(o.takenAt)}` : o.hasPicture ? `Added ${fmtDate(o.takenAt)}` : 'Added by code')
    ),
    h('section', { class: 'panel' },
      textField(o, 'name', 'Name', { placeholder: 'e.g. Rose Dress' }),
      textField(o, 'inspired', 'Inspired by', { placeholder: 'Character and series, for cosplays' }),
      textField(o, 'description', 'Short description'),
      textField(o, 'notes', 'Notes (private)', { multi: true }),
      accounts.length > 1 ? accountField : null
    ),
    labelsPanel(o),
    colorsPanel(o),
    collectionsPanel(o),
    sharePanel(o),
    h('section', { class: 'panel actionsCol' },
      o.hasPicture ? h('button', { type: 'button', class: 'ghost', onclick: () => adjustThumbnail(o) },
        o.crop ? '✂️ Adjust thumbnail (picked by hand)' : '✂️ Adjust thumbnail') : null,
      h('button', { type: 'button', class: 'ghost', onclick: () => pickFiles(false, (f) => replacePicture(o, f[0])) },
        o.hasPicture ? '🔁 Replace picture' : '🖼️ Add a picture'),
      h('p', { class: 'muted small' }, o.hasPicture
        ? 'Swap in a new picture. If it has a QR code, the code updates too. Everything else stays.'
        : "Add a photo of your outfit. Any picture works, it doesn't have to be a QR screenshot."),
      h('button', {
        type: 'button', class: 'danger',
        onclick: async () => {
          if (!await ask(`Delete ${o.name ? `"${o.name}"` : 'this outfit'}? This can't be undone.`, 'Delete', 'Keep it', true)) return;
          await deleteOutfit(o.id);
          outfits = outfits.filter((x) => x.id !== o.id);
          if (thumbUrls.has(o.id)) URL.revokeObjectURL(thumbUrls.get(o.id));
          thumbUrls.delete(o.id);
          toast('Deleted');
          go('closet');
        },
      }, 'Delete outfit')
    ),
  ];
}

// ---------- backups & sharing ----------

// A backup (or a shared collection) is one file: a first line saying what it is, then the length
// of the details, then the details as JSON (outfits, labels, collections, accounts), then every
// picture one after another. Pictures are stored as they are, so the file isn't bigger than needed.
async function packFile(list, details) {
  const images = [];
  const blobs = [];
  await tx('images', 'readonly', (s) => {
    for (const o of list) {
      if (!o.hasPicture) continue;
      for (const kind of ['full', 'thumb']) {
        const key = `${o.id}:${kind}`;
        const req = s.get(key);
        req.onsuccess = () => {
          if (!req.result) return;
          images.push({ key, type: req.result.type || 'image/jpeg', size: req.result.size });
          blobs.push(req.result);
        };
      }
    }
  });
  const json = new TextEncoder().encode(JSON.stringify({
    app: 'pocket-closet', version: 1, savedAt: new Date().toISOString(), ...details, outfits: list, images,
  }));
  return new Blob([`${BACKUP_MAGIC}\n${json.length}\n`, json, ...blobs], { type: 'application/octet-stream' });
}

function download(file, name) {
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function saveBackup() {
  try {
    toast('Packing your closet…', 60000);
    const file = await packFile(outfits, { kind: 'backup', customLabels, collections, accounts, prefs });
    download(file, `pocket-closet-backup-${new Date().toISOString().slice(0, 10)}.pocketcloset`);
    await setMeta('lastBackup', Date.now());
    toast(`Backup saved: ${plural(outfits.length, 'outfit')}, ${(file.size / 1048576).toFixed(1)} MB 💾`, 3000);
  } catch (err) {
    console.error(err);
    toast("Couldn't make the backup.", 3000);
  }
  render();
}

// 📤 Share a collection with a friend. Personal things stay home: notes, favorites, which of your
// accounts an outfit is on, and your own labels (so friends don't get a pile of labels they never
// made). Game labels, Style and colors come along, and so do crops.
async function shareCollection(c) {
  try {
    const kept = inCollection(c).filter((o) => o.private).length; // 🔒 private outfits stay home
    if (kept && kept === inCollection(c).length) {
      toast(`Everything in ${c.name} is private, so there's nothing to share. 🔒`, 3000);
      return;
    }
    toast('Packing the collection…', 60000);
    const list = inCollection(c).filter((o) => !o.private).map((o) => ({
      ...o, notes: '', favorite: false, account: null, collections: [c.id],
      labels: o.labels.filter((id) => !isCustom(id)),
    }));
    const file = await packFile(list, { kind: 'share', customLabels: [], collections: [{ ...c }], accounts: [] });
    const safe = c.name.replace(/[\\/:*?"<>|]+/g, '').trim() || 'collection';
    download(file, `${safe}.pocketcloset`);
    toast(`${c.name} is ready to send: ${plural(list.length, 'outfit')}, ${(file.size / 1048576).toFixed(1)} MB 📤` +
      (kept ? ` · ${kept} private left out 🔒` : ''), 3500);
  } catch (err) {
    console.error(err);
    toast("Couldn't pack the collection.", 3000);
  }
}

async function readBackup(file) {
  const start = await file.slice(0, 64).text();
  const [magic, len] = start.split('\n');
  if (magic !== BACKUP_MAGIC || !/^\d+$/.test(len || '')) throw new Error('This is not a Pocket Closet backup.');
  const offset = magic.length + len.length + 2;
  const details = JSON.parse(await file.slice(offset, offset + Number(len)).text());
  let pos = offset + Number(len);
  const images = new Map();
  for (const img of details.images || []) {
    images.set(img.key, file.slice(pos, pos + img.size, img.type));
    pos += img.size;
  }
  return { details, images };
}

// Things with the same name are treated as the same (your "cozy days" label on the phone and on
// the PC become one). Returns a map from backup ids to ids on this device.
function mergeByName(local, incoming) {
  const ids = new Map();
  for (const item of incoming || []) {
    const same = local.find((x) => x.id === item.id) || local.find((x) => x.name.toLowerCase() === item.name.toLowerCase());
    if (same) ids.set(item.id, same.id);
    else { local.push({ ...item }); ids.set(item.id, item.id); }
  }
  return ids;
}

// Restoring only adds: new outfits come in, outfits changed more recently in the backup are
// updated, and nothing on this device is ever deleted.
async function restoreBackup(file) {
  let backup;
  try {
    backup = await readBackup(file);
  } catch (err) {
    console.error(err);
    await ask(`That file couldn't be read as a backup. ${err.message}`, 'OK', 'Close');
    return;
  }
  const { details, images } = backup;
  const incoming = details.outfits || [];
  const shared = details.kind === 'share' ? (details.collections || [])[0] : null;
  const ok = await ask(shared
    ? `"${shared.name}" is a shared collection with ${plural(incoming.length, 'outfit')}. Add it to your closet?`
    : `This backup has ${plural(incoming.length, 'outfit')} (saved ${fmtDate(details.savedAt)}). ` +
      'Add them to your closet? Outfits you already have are only updated if the backup has a newer version. Nothing is deleted.',
  'Add them', 'Cancel');
  if (!ok) return;

  toast(shared ? 'Adding…' : 'Restoring…', 60000);
  const labelIds = mergeByName(customLabels, details.customLabels);
  const collIds = mergeByName(collections, details.collections);
  const accIds = mergeByName(accounts, details.accounts);
  for (const c of details.collections || []) {
    const mine = collectionById(collIds.get(c.id));
    if (mine && !mine.cover && c.cover) mine.cover = c.cover;
  }
  await Promise.all([saveCustomLabels(), saveCollections(), saveAccounts()]);

  let added = 0, updated = 0, skipped = 0;
  for (const src of incoming) {
    const o = {
      ...blankOutfit(), ...src,
      labels: (src.labels || []).map((id) => (isCustom(id) ? labelIds.get(id) || id : id)),
      collections: (src.collections || []).map((id) => collIds.get(id) || id),
      account: src.account ? accIds.get(src.account) || null : (accounts[0] ? accounts[0].id : null),
    };
    const here = byId(o.id);
    // A shared collection never changes outfits you already have (it has no notes or favorites
    // in it, so it would wipe yours). They're just added to the collection.
    const mineToo = here || (shared && o.code ? outfits.find((x) => x.code === o.code) : null);
    if (mineToo && shared) {
      const cid = collIds.get(shared.id);
      if (!mineToo.collections.includes(cid)) { mineToo.collections.push(cid); await saveOutfit(mineToo, true); }
      skipped++;
      continue;
    }
    if (here && (here.updatedAt || 0) >= (src.updatedAt || 0)) { skipped++; continue; }
    if (!here && o.code && outfits.some((x) => x.code === o.code)) { skipped++; continue; }
    const full = images.get(`${o.id}:full`), thumb = images.get(`${o.id}:thumb`);
    await tx(['outfits', 'images'], 'readwrite', (os, is) => {
      if (full) is.put(full, `${o.id}:full`);
      if (thumb) is.put(thumb, `${o.id}:thumb`);
      return os.put(o); // keeps the backup's updatedAt
    });
    if (here) { Object.assign(here, o); updated++; } else { outfits.push(o); added++; }
    if (thumb) {
      if (thumbUrls.has(o.id)) URL.revokeObjectURL(thumbUrls.get(o.id));
      thumbUrls.set(o.id, URL.createObjectURL(await getImage(`${o.id}:thumb`)));
    }
  }
  const bits = [shared ? `Added "${shared.name}": ${plural(added, 'new outfit')} ✨` : `Added ${plural(added, 'outfit')} ✨`];
  if (updated) bits.push(`${updated} updated`);
  if (skipped) bits.push(`${skipped} already here`);
  toast(bits.join(' · '), 3500);
  if (shared) { state.shelf = collIds.get(shared.id); go('closet'); } // open the new collection
  else render();
}

function backupPanel() {
  const last = h('p', { class: 'muted' });
  getMeta('lastBackup').then((t) => {
    last.textContent = t ? `Last backup: ${new Date(t).toLocaleString()}` : 'No backup saved yet.';
  });
  return h('section', { class: 'panel' },
    h('h2', null, 'Backup & sharing'),
    h('p', null, 'Your closet lives only in this browser. A backup is one file with all your outfits and pictures. ' +
      'Keep it somewhere safe.'),
    h('p', { class: 'muted small' }, 'To move your closet to another phone or PC: save a backup here, then open Pocket Closet there and restore it. ' +
      "Restoring only adds and updates, it never deletes, so it's safe to do both ways."),
    h('p', { class: 'muted small' }, 'Got a collection from a friend? Open it here too, or just drop the file onto the page. ' +
      'To share one of yours, open the collection and tap 📤 Share.'),
    last,
    h('div', { class: 'collbtns' },
      h('button', { type: 'button', class: 'primary', onclick: saveBackup, disabled: !outfits.length }, '💾 Save backup'),
      h('button', { type: 'button', class: 'ghost', onclick: () => pickFiles(false, (f) => restoreBackup(f[0]), '.pocketcloset,application/octet-stream') }, 'Open a backup or shared file')
    )
  );
}

// ---------- Settings ----------

// Rename, recolor or delete your own labels. Game labels can't be changed.
function myLabelsPanel() {
  const panel = h('section', { class: 'panel' });
  const redraw = () => panel.replaceWith(myLabelsPanel());
  const rows = customLabels.map((l) => {
    const uses = outfits.filter((o) => o.labels.includes(l.id)).length;
    return h('div', { class: 'labelrow' },
      labelChip(l, true),
      h('input', {
        type: 'text', value: l.name, maxLength: 30, 'aria-label': `Rename ${l.name}`,
        onchange: async (e) => {
          const name = e.target.value.trim();
          if (!name) { e.target.value = l.name; return; }
          l.name = name;
          await saveCustomLabels();
          toast('Saved');
          redraw();
        },
      }),
      h('div', { class: 'swatches' }, CUSTOM_COLORS.map((c) => h('button', {
        type: 'button', class: `swatch ${c === l.color ? 'on' : ''}`, style: `--c:${c}`, 'aria-label': `Color ${c}`,
        onclick: async () => { l.color = c; await saveCustomLabels(); redraw(); },
      }))),
      h('button', {
        type: 'button', class: 'ghost small',
        onclick: async () => {
          if (!await ask(`Delete your label "${l.name}"?${uses ? ` It will be taken off ${plural(uses, 'outfit')}.` : ''}`, 'Delete', 'Keep it', true)) return;
          for (const o of outfits.filter((x) => x.labels.includes(l.id))) {
            o.labels = o.labels.filter((id) => id !== l.id);
            await saveOutfit(o, true);
          }
          customLabels = customLabels.filter((x) => x !== l);
          await saveCustomLabels();
          redraw();
        },
      }, 'Delete'),
      h('span', { class: 'muted small' }, plural(uses, 'outfit'))
    );
  });
  put(panel,
    h('h2', null, 'Your labels'),
    ...(rows.length ? rows : [h('p', { class: 'muted' }, "You haven't made any labels yet. They're for anything personal: cozy days, for photos, needs a better hat…")]),
    newLabelForm(() => redraw())
  );
  return panel;
}

function renderSettings() {
  const storage = h('p', { class: 'muted' }, 'Checking storage…');
  if (navigator.storage && navigator.storage.estimate) {
    Promise.all([navigator.storage.estimate(), navigator.storage.persisted ? navigator.storage.persisted() : false])
      .then(([est, kept]) => {
        const mb = (est.usage / 1048576).toFixed(1);
        storage.textContent = `${plural(outfits.length, 'outfit')} · ${mb} MB used on this device. ` +
          (kept ? 'The browser has agreed to keep your closet safe. ✨' : 'Back up now and then, just in case.');
      });
  } else {
    storage.textContent = `${plural(outfits.length, 'outfit')} on this device.`;
  }
  return [
    h('header', { class: 'top' }, h('h1', null, starSvg(30), 'Settings')),
    myLabelsPanel(),
    accountsPanel(),
    h('section', { class: 'panel' }, h('h2', null, 'Your closet'), storage,
      h('p', { class: 'muted' }, 'Each device keeps its own closet. Use a backup to move it between phone and PC.')
    ),
    backupPanel(),
    h('section', { class: 'panel' }, h('h2', null, 'About'),
      h('p', null, 'Pocket Closet is a free, unofficial fan tool for saving Infinity Nikki outfits beyond the 100-slot lookbook.'),
      h('p', { class: 'muted' }, 'Everything stays on this device. No accounts, nothing uploaded. Not affiliated with the game or its makers.')
    ),
  ];
}

// ---------- shell ----------

const VIEWS = { closet: renderCloset, outfit: renderOutfit, settings: renderSettings };

// "Add by code" makes an outfit straight away; if it's left completely blank, it's dropped.
function isBlank(o) {
  return !o.code && !o.hasPicture && !o.name && !o.inspired && !o.description && !o.notes && !o.favorite && !o.private &&
    !o.styles.length && !o.labels.length && !o.colors.length && !o.collections.length;
}
function dropBlankOutfits() {
  const blank = outfits.filter((o) => isBlank(o) && !(state.view === 'outfit' && state.openId === o.id));
  if (!blank.length) return;
  outfits = outfits.filter((o) => !blank.includes(o));
  blank.forEach((o) => deleteOutfit(o.id).catch((err) => console.error(err)));
}

function render(keep = 0) {
  dropBlankOutfits();
  const app = document.getElementById('app');
  app.replaceChildren(...[].concat(VIEWS[state.view]()).filter(Boolean));
  if (state.view === 'closet') fillGrid(keep);
  const tab = state.view === 'outfit' ? 'closet' : state.view;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.view === tab));
}

document.querySelectorAll('.tabbar button').forEach((b) =>
  b.addEventListener('click', () => go(b.dataset.view))
);

// PC: drag screenshots onto the page, or paste them with Ctrl+V.
let dragDepth = 0;
const dropEl = document.getElementById('drop');
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; dropEl.classList.add('show'); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropEl.classList.remove('show'); } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropEl.classList.remove('show');
  // A dropped .pocketcloset file is a backup or a friend's collection; pictures are new outfits.
  const files = [...e.dataTransfer.files];
  const pack = files.find((f) => f.name.toLowerCase().endsWith('.pocketcloset'));
  if (pack) restoreBackup(pack);
  else addFiles(files);
});
window.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  if (state.view === 'outfit' && byId(state.openId)) replacePicture(byId(state.openId), files[0]);
  else addFiles(files);
});

async function start() {
  try {
    conn = await openDb();
    outfits = await getAllOutfits();
    await loadLabels();
    await loadAccounts();
    collections = (await getMeta('collections')) || [];
  } catch (err) {
    console.error(err);
    document.getElementById('app').replaceChildren(h('div', { class: 'empty' },
      h('p', null, h('b', null, "Pocket Closet can't open its storage.")),
      h('p', null, 'This can happen in a private/incognito window. Try a normal window.')));
    return;
  }
  render();
  await offerMerges();
  await refreshOldThumbs();
  // Ask the browser not to clear the closet when space runs low.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

start();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((err) => console.error(err));
}
