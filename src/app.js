// Gravitas app wiring: vault <-> universe <-> renderer, glass panels, intake.
import { vault } from './vault.js';
import { Universe } from './physics.js';
import { Renderer } from './render.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let uni = null; // active canvas universe (each canvas keeps its own persistent universe)
const unis = new Map(); // tabId -> Universe: formations survive tab switches, twins stay locked
let ren = null;
let activeId = null;
let matchSet = null;
let viewNotesAll = true; // sticky-note squares on every body that HAS a note (solid yellow)
let viewNotesSun = true; // sticky-note square on the selected body (solid if noted, hollow frame if not)
let selSet = new Set(); // marquee box selection: body ids in the active tab (owned here, read by ren.selSet)
function pruneSel() { for (const sid of [...selSet]) if (!vault.byId(sid)) selSet.delete(sid); }
let edgeInfo = []; // active canvas's edge list incl. shared topic terms, for the reader panel
const edgeByTab = new Map(); // tabId -> { n, edges }: formations persist AND shared ground stays correct
// refresh the reader's edge list for a canvas: reuse the cache when its doc
// set is unchanged, else recompute edges only (never touches body positions).
function refreshEdgeInfo(id) {
  const t = vault.tabs.find(x => x.id === id) || vault.tab();
  if (!t) { edgeInfo = []; return edgeInfo; }
  const cached = edgeByTab.get(t.id);
  if (cached && cached.n === t.docs.length) { edgeInfo = cached.edges; return edgeInfo; }
  try {
    const prev = vault.activeTabId;
    vault.activeTabId = t.id;
    const { edges } = vault.universe();
    vault.activeTabId = prev;
    edgeByTab.set(t.id, { n: t.docs.length, edges });
    edgeInfo = edges;
  } catch { edgeInfo = (cached && cached.edges) || []; }
  return edgeInfo;
}
let raf = 0;

vault.load();

function setLog(msg) {
  try {
    const el = document.querySelector('#intakeLog');
    if (el) el.textContent = msg || '';
    if (msg) localStorage.setItem('gravitas.lastMsg', msg);
  } catch {}
}
// constellation picker: checkbox list with the shared-vocabulary receipts per body,
// so nothing travels that the user didn't approve. Resolves chosen ids or null.
function openPickModal(destName, items) {
  // items: [{id, name, terms[], sun?:true}]
  return new Promise((resolve) => {
    const m = $('#pickModal');
    if (!m) { resolve(items.map(i => i.id)); return; }
    $('#pickTitle').textContent = `Copy to “${destName}”`;
    $('#pickSub').textContent = 'Uncheck anything that should stay behind. The words under each body are what it shares with the sun.';
    const list = $('#pickList');
    list.innerHTML = '';
    const boxes = [];
    for (const it of items) {
      const lab = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = true;
      const tx = document.createElement('span');
      const nm = document.createElement('b');
      nm.textContent = (it.sun ? '◉ ' : '') + it.name;
      if (it.sun) nm.className = 'pk-sun';
      tx.appendChild(nm);
      if (it.terms && it.terms.length) {
        const tt = document.createElement('span');
        tt.className = 'pk-t';
        tt.textContent = 'via ' + it.terms.join(', ');
        tx.appendChild(tt);
      }
      lab.appendChild(cb); lab.appendChild(tx);
      list.appendChild(lab);
      boxes.push({ id: it.id, cb });
    }
    const ok = $('#pickOk'), cancel = $('#pickCancel');
    const sync = () => {
      const n = boxes.filter(b => b.cb.checked).length;
      ok.textContent = n ? `Copy ${n} ${n === 1 ? 'body' : 'bodies'}` : 'Copy';
      ok.disabled = !n || !armed;
    };
    let armed = false;
    const armT = setTimeout(() => { armed = true; sync(); }, 300);
    list.onchange = sync;
    sync();
    m.hidden = false; // the dialog starts hidden in markup — show it now that it's built
    const done = (v) => {
      clearTimeout(armT);
      m.hidden = true;
      ok.onclick = cancel.onclick = null;
      list.onchange = null;
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(null); }
      else if (e.key === 'Enter' && !ok.disabled) { e.stopPropagation(); done(boxes.filter(b => b.cb.checked).map(b => b.id)); }
    };
    ok.onclick = () => { if (!ok.disabled) done(boxes.filter(b => b.cb.checked).map(b => b.id)); };
    cancel.onclick = () => done(null);
    document.addEventListener('keydown', onKey, true);
  });
}
function toast(msg, ms = 2400) {
  const t = $('#toastEl');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), ms);
}

// in-app confirm dialog (native confirm()/alert() are blocked in some sandboxed
// preview/export shells and absent on touch flows — this glass modal always works).
// Resolves true only on an explicit Confirm click / Enter. The button arms after a
// beat so a double-click aimed at whatever opened the dialog can't instantly confirm.
function confirmDlg(msg, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    const m = $('#confirmModal');
    if (!m) { resolve(true); return; }
    $('#confirmTitle').textContent = 'Are you sure?';
    $('#confirmMsg').textContent = msg;
    const ok = $('#confirmOk'), cancel = $('#confirmCancel');
    ok.textContent = okLabel;
    ok.disabled = true;
    m.hidden = false;
    const arm = setTimeout(() => { ok.disabled = false; }, 350);
    const done = (v) => {
      clearTimeout(arm);
      m.hidden = true;
      ok.onclick = cancel.onclick = null;
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      else if (e.key === 'Enter' && !ok.disabled) { e.stopPropagation(); done(true); }
    };
    ok.onclick = () => { if (!ok.disabled) done(true); };
    cancel.onclick = () => done(false);
    document.addEventListener('keydown', onKey, true);
  });
}

// ---------- universe speed state (persisted) ----------
// rotOn = running (false = paused: freezes physics + camera + glow pulse).
// rotMul = time-scale 0..3 (0 = stopped via slider). Log slider = fine slow-mo.
const ROT_BASE = 0.00045;
const SPEED_MIN = 0.02, SPEED_MAX = 3;
let rotOn = true;
let autoDist = false; // auto-distribute: pin bodies in a fit-to-canvas orb (orbital motion overridden until toggled off)
let simpleOrb = false; // simple-orb mode: flat white discs + thin black outline, no photo/glow overlays
let simpleOrb2 = false; // simple-orb 2: original blue orbs with photo overlays stripped (mutually exclusive with simpleOrb)
let rotMul = 1;
let ovAlpha = 0.6, ovLast = 0.6;
let lbScale = 1, lbLast = 1; // file-name label size (0 = hidden) // body texture overlay opacity (0 = off)
let bgShade = 1; // canvas background shade (1 = black deep-space, 0 = white)
let glowScale = 1, glowLast = 1; // halo radius multiplier (0 = none, 1 = current, 2 = double)
let tetherScale = 1, tetherLast = 1; // tether thickness multiplier (0 = hidden, 1 = current, 2 = double)
let tetherColor = '#82aaff'; // tether tint (shared-ground links auto-contrast off it)
let backdrop = ''; // canvas backdrop photo (filename in src/backdrops, '' = none)
let backdropAlpha = 0.55, backdropLast = 0.55; // backdrop opacity (0 = off)
let paneAlpha = 1, paneLast = 1; // Docuverse / Active-body / Cloud pane background opacity (0 = clear, 1 = current glass)
let glazeLeft = true, glazeDoc = true, glazeCloud = true; // per-pane polished-glass overlay (false = flat background)
let leftCollapsed = false, docCollapsed = false; // panel collapse state (collapse = shrink up to a top tab)
let docWidth = 0; // reader pane width override in px (0 = default 380)
let lensThematic = false; // thematic lens: same docs + same physics, recomposed from theme/tag tethers
let thematicWhole = false; // whole-docuverse thematic: distilled from every shared canvas (general-state entry)
let wholeUni = null, wholeBuilt = '', wholeThemes = []; // whole-docuverse thematic universe + its theme records
const thematicUnis = new Map(); // tabId -> Universe (thematic recomposition; regular ones stay in unis)
const thematicBuilt = new Map(); // tabId -> docs.length the thematic uni was built from
const thematicThemes = new Map(); // tabId -> distilled theme records [{id,label,terms,weight,mass,members[]}]
const sliderToSpeed = (v) => {
  v = Number(v);
  if (!(v > 0)) return 0;
  return SPEED_MIN * Math.pow(SPEED_MAX / SPEED_MIN, v / 100);
};
const speedToSlider = (s) => {
  if (!(s > 0)) return 0;
  const v = 100 * Math.log(s / SPEED_MIN) / Math.log(SPEED_MAX / SPEED_MIN);
  return Math.max(0, Math.min(100, Math.round(v)));
};
const fmtSpeed = (s) => {
  if (!(s > 0)) return '0×';
  return (Math.round(s * 100) / 100) + '×';
};
try {
  const ui = JSON.parse(localStorage.getItem('gravitas.ui') || '{}');
  if (typeof ui.rotOn === 'boolean') rotOn = ui.rotOn;
  if (ui.autoDist === true) autoDist = true;
  if (ui.simpleOrb === true) simpleOrb = true;
  if (ui.simpleOrb2 === true) simpleOrb2 = true;
  if (simpleOrb && simpleOrb2) simpleOrb2 = false; // never both (older pref wins)
  const stored = ui.speedMul ?? ui.rotMul;
    if (typeof ui.ovAlpha === 'number' && ui.ovAlpha >= 0 && ui.ovAlpha <= 1) ovAlpha = ui.ovAlpha;
    if (typeof ui.ovLast === 'number' && ui.ovLast > 0 && ui.ovLast <= 1) ovLast = ui.ovLast;
    if (typeof ui.lbScale === 'number' && ui.lbScale >= 0 && ui.lbScale <= 1.5) lbScale = ui.lbScale;
    if (typeof ui.lbLast === 'number' && ui.lbLast > 0 && ui.lbLast <= 1.5) lbLast = ui.lbLast;
    if (typeof ui.bgShade === 'number' && ui.bgShade >= 0 && ui.bgShade <= 1) bgShade = ui.bgShade;
    if (typeof ui.glow === 'number' && ui.glow >= 0 && ui.glow <= 2) glowScale = ui.glow;
    if (typeof ui.glowLast === 'number' && ui.glowLast > 0 && ui.glowLast <= 2) glowLast = ui.glowLast;
    if (typeof ui.tether === 'number' && ui.tether >= 0 && ui.tether <= 2) tetherScale = ui.tether;
    if (typeof ui.tetherLast === 'number' && ui.tetherLast > 0 && ui.tetherLast <= 2) tetherLast = ui.tetherLast;
    if (typeof ui.tetherColor === 'string' && /^#[0-9a-f]{6}$/i.test(ui.tetherColor)) tetherColor = ui.tetherColor;
    if (typeof ui.backdrop === 'string' && /^[a-z0-9._-]+\.jpg$/i.test(ui.backdrop)) backdrop = ui.backdrop;
    if (typeof ui.backdropAlpha === 'number' && ui.backdropAlpha >= 0 && ui.backdropAlpha <= 1) backdropAlpha = ui.backdropAlpha;
    if (typeof ui.backdropLast === 'number' && ui.backdropLast > 0 && ui.backdropLast <= 1) backdropLast = ui.backdropLast;
    if (typeof ui.paneAlpha === 'number' && ui.paneAlpha >= 0 && ui.paneAlpha <= 1) paneAlpha = ui.paneAlpha;
    if (typeof ui.paneLast === 'number' && ui.paneLast > 0 && ui.paneLast <= 1) paneLast = ui.paneLast;
    if (ui.glazeLeft === false) glazeLeft = false;
    if (ui.glazeDoc === false) glazeDoc = false;
    if (ui.glazeCloud === false) glazeCloud = false;
    if (ui.leftCollapsed === true) leftCollapsed = true;
    if (ui.docCollapsed === true) docCollapsed = true;
    if (typeof ui.docWidth === 'number' && ui.docWidth >= 260 && ui.docWidth <= 900) docWidth = ui.docWidth;
    if (ui.lensThematic === true) lensThematic = true;
    if (ui.viewNotesAll === false) viewNotesAll = false;
    if (ui.viewNotesSun === false) viewNotesSun = false;
    if (ui.viewNotes === false) { viewNotesAll = false; viewNotesSun = false; } // legacy single toggle
  if (stored >= 0 && stored <= 3) rotMul = stored;
} catch { /* fresh prefs */ }
function saveUi() {
  try { localStorage.setItem('gravitas.ui', JSON.stringify({ rotOn, rotMul, speedMul: rotMul, autoDist, simpleOrb, simpleOrb2, ovAlpha, ovLast, lbScale, lbLast, bgShade, glow: glowScale, glowLast, tether: tetherScale, tetherLast, tetherColor, backdrop, backdropAlpha, backdropLast, paneAlpha, paneLast, glazeLeft, glazeDoc, glazeCloud, leftCollapsed, docCollapsed, docWidth, lensThematic, viewNotesAll, viewNotesSun })); } catch { /* private mode */ }
}
// bottom hint pill: flip to a light pill on a white canvas, dark pill on black
function syncHintContrast() {
  try { document.body.classList.toggle('light-canvas', (typeof bgShade === 'number' ? bgShade : 1) < 0.5); } catch {}
}
// pane text: when the canvas is light AND the pane glass is faded, the panes sit
// on a near-white backdrop — flip their text to dark (same idea as the pill).
// Dark canvas never flips (light text on near-black stays readable at any alpha).
function syncPaneContrast() {
  try {
    const canvasLight = (typeof bgShade === 'number' ? bgShade : 1) < 0.5;
    const panesClear = (typeof paneAlpha === 'number' ? paneAlpha : 1) < 0.7;
    document.body.classList.toggle('light-panes', canvasLight && panesClear);
  } catch {}
}
// reader pane width: discrete left-edge handle stretches it (persisted)
function clampDocW(w) {
  const max = Math.max(280, Math.min(900, window.innerWidth * 0.9 - 32));
  return Math.max(260, Math.min(max, Math.round(w)));
}
function applyDocWidth() {
  try {
    const p = document.getElementById('docPanel');
    if (!p) return;
    p.style.width = docWidth > 0 ? clampDocW(docWidth) + 'px' : '';
    syncResizeHandle();
  } catch {}
}
function syncResizeHandle() {
  try {
    const p = document.getElementById('docPanel'), h = document.getElementById('docResize');
    if (!p || !h) return;
    if (p.classList.contains('collapsed') || window.innerWidth <= 760 || !p.offsetParent) { h.style.display = 'none'; return; }
    h.style.display = 'flex';
    const r = p.getBoundingClientRect();
    h.style.left = Math.round(r.left - 11) + 'px';
    h.style.top = Math.round(r.top + r.height / 2 - 27) + 'px';
  } catch {}
}
// Thematic lens: the same docs, masses and orbital mechanics, recomposed around
// distilled theme bodies. Co-related concepts (terms that travel together across
// the topic web) are clumped into theme bodies whose mass follows their thematic
// weight; docs tether to the themes they evidence. Explicit [[ref]] tethers are
// left out so citation structure can't warp the theme map. The regular
// per-canvas universe is never touched; toggling back restores it exactly
// (formation included).
function themeById(id) {
  if (typeof id !== 'string' || !id.startsWith('theme_')) return null;
  if (thematicWhole) return wholeThemes.find(t => t.id === id) || null;
  const list = thematicThemes.get(vault.activeTabId) || [];
  return list.find(t => t.id === id) || null;
}
// clump co-related terms into themes, sized by thematic weight (deterministic:
// ranked by evidence, ties broken alphabetically — no randomness).
// minDf: a term must evidence in at least this many docs to seed or join a
// theme — this keeps one-off citation surnames ("mislevy", "gonzales") from
// becoming theme labels while true shared concepts survive.
// maxDfRatio: the boilerplate guard — a term present in the full text of more
// than this fraction of the corpus ("teacher" in 54/84, "report" in 31/84…)
// is wallpaper, not a concept, so it can neither seed nor join a theme. The
// lower bound stays on edge-evidence df (the term must actually travel
// tethers). Pass 1.0 to skip the cap (the no-shared-concepts fallback does
// exactly that).
// docTexts powers the citation-author hygiene pass (surnames that only ever
// travel with years / "et al." are dropped before distillation).
function distillThemes(bodies, edges, minDf = 1, docTexts = [], maxDfRatio = 0.30) {
  const bump = (m, k, w) => m.set(k, (m.get(k) || 0) + w);
  const termW = new Map();   // term -> Σ edge-sim evidence
  const docTerm = new Map(); // docId -> Map(term -> evidence)
  const co = new Map();      // term -> Map(term -> co-travel evidence)
  for (const e of edges) {
    if (e.kind !== 'topic' || !Array.isArray(e.topics)) continue;
    const w = (typeof e.sim === 'number' && e.sim > 0) ? e.sim : 0.1;
    const ts = [...new Set(e.topics)];
    for (const t of ts) {
      bump(termW, t, w);
      if (!docTerm.has(e.source)) docTerm.set(e.source, new Map());
      if (!docTerm.has(e.target)) docTerm.set(e.target, new Map());
      bump(docTerm.get(e.source), t, w);
      bump(docTerm.get(e.target), t, w);
    }
    for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
      const a = ts[i] < ts[j] ? ts[i] : ts[j], b = ts[i] < ts[j] ? ts[j] : ts[i];
      if (!co.has(a)) co.set(a, new Map());
      bump(co.get(a), b, w);
    }
  }
  // citation-author hygiene: drop terms that mostly travel WITH years or
  // "et al." (in-text citations like "(Mislevy, 2006)") — shared surnames are
  // statistically shared but they are not themes. While scanning, record each
  // term's FULL-TEXT document frequency: the boilerplate guard below needs the
  // real corpus df ("teacher" in 54 of 84 texts), not the thin edge-evidence
  // df, to tell wallpaper from concepts.
  const textDf = new Map(); // term -> #docs whose full text contains it
  try {
    const textById = new Map((docTexts || []).map(d => [d.id, String(d.text || '').toLowerCase()]));
    if (textById.size) {
      const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const cite = [];
      for (const t of [...termW.keys()]) {
        const e = escRe(t);
        const reCite = new RegExp('\\b' + e + "\\b[\\s\\S]{0,40}\\b(?:19|20)\\d{2}\\b|\\b(?:19|20)\\d{2}\\b[\\s\\S]{0,40}\\b" + e + '\\b|\\b' + e + '\\s+et\\s+al\\b');
        const reTerm = new RegExp('\\b' + e + '\\b');
        let dfD = 0, patD = 0;
        for (const [, tx] of textById) {
          if (!reTerm.test(tx)) continue;
          dfD++;
          if (reCite.test(tx)) patD++;
        }
        textDf.set(t, dfD);
        if (dfD >= 2 && patD / dfD >= 0.5) cite.push(t);
      }
      for (const t of cite) {
        termW.delete(t);
        for (const [, m] of docTerm) m.delete(t);
        co.delete(t);
        for (const [, m] of co) m.delete(t);
      }
    }
  } catch { /* hygiene is best-effort — never break the lens */ }
  const docSet = new Map(); // term -> Set(docIds)
  for (const [docId, tm] of docTerm) for (const t of tm.keys()) {
    if (!docSet.has(t)) docSet.set(t, new Set());
    docSet.get(t).add(docId);
  }
  const docFreq = (t) => (docSet.get(t) ? docSet.get(t).size : 0);
  // boilerplate guard on FULL-TEXT df: a term present in more than this share
  // of the corpus ("teacher" in 54/84, "report" in 31/84…) is wallpaper, not a
  // concept — it can neither seed nor join a theme. Edge-evidence df stays as
  // the lower bound (the term must actually travel tethers). Fail-open: terms
  // missing from textDf (hygiene skipped/failed) are judged by edges alone.
  const maxDf = Math.max(4, Math.round(bodies.length * maxDfRatio));
  const distinctive = (t) => docFreq(t) >= minDf && (textDf.size === 0 || (textDf.get(t) ?? 0) <= maxDf);
  const coW = (a, b) => {
    const x = a < b ? a : b, y = a < b ? b : a;
    return (co.get(x) && co.get(x).get(y)) || 0;
  };
  const maxThemes = Math.max(4, Math.min(16, Math.round(bodies.length / 6)));
  const ranked = [...termW.entries()]
    .filter(([t]) => distinctive(t))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const used = new Set(), themes = [];
  for (const [seed] of ranked) {
    if (themes.length >= maxThemes) break;
    if (used.has(seed)) continue;
    const rel = [...termW.keys()]
      .filter(t => t !== seed && !used.has(t) && distinctive(t))
      .map(t => [t, coW(seed, t)])
      .filter(([, w]) => w > 0)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 4).map(([t]) => t);
    const terms = [seed, ...rel];
    terms.forEach(t => used.add(t));
    const weight = terms.reduce((s, t) => s + (termW.get(t) || 0), 0);
    themes.push({ id: 'theme_' + themes.length, label: terms.slice(0, 2).join(' · '), terms, weight, mass: 0, members: [] });
  }
  // each doc grounds itself in its top-2 evidenced themes (orphans stay orphans)
  for (const b of bodies) {
    const dt = docTerm.get(b.id);
    if (!dt) continue;
    const scored = themes.map((th, i) => {
      let s = 0; for (const t of th.terms) s += dt.get(t) || 0;
      return [i, s];
    }).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).slice(0, 2);
    for (const [i] of scored) themes[i].members.push(b.id);
  }
  const live = themes.filter(th => th.members.length > 0);
  for (const th of live) th.mass = Math.max(10, Math.min(55, 10 + th.weight * 3));
  return live;
}
// shared theme distillation: strict shared-concepts pass (single-doc citation
// surnames can't seed or join, corpus-wide boilerplate can't either), relaxed
// fallback only when the strict pass finds nothing at all.
function distillFor(bodies, edges, texts) {
  const minDf = bodies.length < 12 ? 2 : 3;
  let themes = distillThemes(bodies, edges, minDf, texts);
  if (!themes.length) themes = distillThemes(bodies, edges, 1, texts, 1.0);
  return themes;
}
// compose theme bodies webbed by shared grounded docs into a settled universe.
// preferredId becomes the sun when it names a theme; defaultToAnchor falls back
// to the heaviest theme (per-canvas entry with a selected doc) — otherwise the
// map stays sunless and the canvas center holds gravity.
function seatThematic(u, themes, preferredId, defaultToAnchor) {
  // THEMATIC CLUSTERS ONLY: no doc bodies in this universe — just the theme
  // bodies, webbed by shared grounded docs (every theme gets ≥1 tether so no
  // theme drifts off as a comet).
  const themeNodes = themes.map(th => ({ id: th.id, label: th.label, mass: th.mass, tags: [], words: 0, origin: th.id }));
  const memberSet = new Map(themes.map(th => [th.id, new Set(th.members)]));
  const sharedCount = (a, b) => {
    let n = 0; const A = memberSet.get(a.id), B = memberSet.get(b.id);
    for (const id of A) if (B.has(id)) n++;
    return n;
  };
  const allEdges = [];
  const linked = new Set();
  for (let i = 0; i < themes.length; i++) for (let j = i + 1; j < themes.length; j++) {
    const n = sharedCount(themes[i], themes[j]);
    if (n > 0) { allEdges.push({ source: themes[i].id, target: themes[j].id, kind: 'topic', topics: [], sim: n }); linked.add(themes[i].id); linked.add(themes[j].id); }
  }
  const anchor = [...themes].sort((a, b) => b.mass - a.mass || (a.id < b.id ? -1 : 1))[0];
  for (const th of themes) {
    if (!linked.has(th.id) && anchor && th !== anchor) { allEdges.push({ source: th.id, target: anchor.id, kind: 'topic', topics: [], sim: 0.05 }); linked.add(th.id); }
  }
  u.setData(themeNodes, allEdges, themes.some(th => th.id === preferredId) ? preferredId : (defaultToAnchor && anchor ? anchor.id : null));
  // seat it settled: deterministic golden-angle spread per shell (no random
  // clumps, same graph → same map every open), correct orbital velocities,
  // then enough physics to web the clusters — the lens opens composed even
  // when the universe is paused or at slow-motion (no live sim will pull
  // fresh shell seeds together; a 13-node graph settles in milliseconds).
  try {
    const GA = Math.PI * (3 - Math.sqrt(5));
    const byShell = new Map();
    for (const n of u.nodes) {
      const key = n.shell || 0;
      if (!byShell.has(key)) byShell.set(key, []);
      byShell.get(key).push(n);
    }
    for (const [, arr] of byShell) arr.forEach((n, k) => {
      if (n.id === u.sunId) return;
      const a = k * GA, R = n.shell || 120;
      n.x = Math.cos(a) * R; n.z = Math.sin(a) * R;
      n.y = (k % 2 ? -1 : 1) * ((k >> 1) % 4 + 1) * R * 0.09;
    });
    u.initOrbitals(1);
    for (let i = 0; i < 400; i++) {
      u.step(u.dt || 0.3);
      // never let the settle park bodies on the sun: a chaotic transient can
      // throw a node inside its shell (they pile up on the corona edge and
      // read as "not connected"). Clamp radius to the inner half of its shell
      // and let the springs arrange the angles instead.
      for (const n of u.nodes) {
        if (n.id === u.sunId) continue;
        const r = Math.hypot(n.x, n.y, n.z) || 1, min = (n.shell || 120) * 0.55;
        if (r < min) { const k = min / r; n.x *= k; n.y *= k; n.z *= k; }
      }
    }
  } catch { /* the live sim finishes the job */ }
}
function getThematicUni(tabId) {
  const t = vault.tabs.find(x => x.id === tabId) || vault.tab();
  if (!t) return null;
  let u = thematicUnis.get(t.id);
  const stamp = t.docs.length + ':b5'; // rebuild when docs change OR the distillation rules change
  if (!u || thematicBuilt.get(t.id) !== stamp) {
    const prev = vault.activeTabId;
    vault.activeTabId = t.id;
    const { bodies, edges } = (() => { try { return vault.universe(); } catch { return { bodies: [], edges: [] }; } })();
    vault.activeTabId = prev;
    const themes = distillFor(bodies, edges, t.docs);
    thematicThemes.set(t.id, themes);
    if (!u) { u = new Universe(); thematicUnis.set(t.id, u); }
    // entering from general state (no selection) leaves the map sunless too —
    // the canvas center holds gravity there as well.
    seatThematic(u, themes, t.activeId, t.activeId != null);
    thematicBuilt.set(t.id, stamp);
  }
  return u;
}
// whole docuverse: every shared canvas's docs, deduped by copy-lineage (copies
// across canvases are the same body, counted once). Isolated verses stay out.
function wholeDocuverseDocs() {
  const seen = new Set(); const docs = [];
  for (const t of vault.scopeTabs()) for (const d of (t.docs || [])) {
    const root = d.origin || d.id;
    if (seen.has(root)) continue; seen.add(root);
    docs.push(d);
  }
  return docs;
}
// whole-docuverse thematic universe: distilled from the entire shared corpus,
// not just the active tab. Entered from the general state (nothing selected).
function getThematicWhole() {
  const docs = wholeDocuverseDocs();
  const stamp = docs.length + ':w1'; // w = whole-docuverse distillation rules
  if (!wholeUni) wholeUni = new Universe();
  if (wholeBuilt !== stamp) {
    let bodies = [], edges = [];
    try { ({ bodies, edges } = vault.universe(docs)); } catch { /* the lens stays empty below */ }
    wholeThemes = distillFor(bodies, edges, docs);
    // entering from general state stays sunless (center gravity); an already
    // selected whole theme survives rebuilds as the sun.
    seatThematic(wholeUni, wholeThemes, activeId, false);
    wholeBuilt = stamp;
  }
  return wholeUni;
}
// the thematic universe for a canvas id — the whole docuverse when in whole mode.
function thematicUniFor(id) {
  return thematicWhole ? getThematicWhole() : getThematicUni(id);
}
function syncAutoBtn() {
  const b = $('#autoBtn');
  if (!b) return;
  b.classList.toggle('on', autoDist);
  b.title = autoDist
    ? 'Auto-distribute is ON — click to restore orbital dynamics'
    : 'Auto-distribute: pin bodies in a fit-to-canvas orb (orbital motion overridden while on)';
}
function syncSimpleOrbBtn() {
  const b = $('#simpleOrbBtn');
  if (!b) return;
  b.classList.toggle('on', simpleOrb);
  b.title = simpleOrb
    ? 'Simple-orb mode is ON — click to restore textured orbs'
    : 'Simple Orb: flat white discs with a thin black outline (photo + glow overlays off)';
}
function syncSimpleOrb2Btn() {
  const b = $('#simpleOrb2Btn');
  if (!b) return;
  b.classList.toggle('on', simpleOrb2);
  b.title = simpleOrb2
    ? 'Simple-orb-2 mode is ON — click to restore photo overlays'
    : 'Simple Orb 2: original blue orbs with the photo overlays stripped';
}
// auto-distribute: sun at the center, every other body pinned on mass-ranked
// fibonacci shells (even angular spacing = least-obstruction display), scaled
// to an ellipse that fits the canvas. Eased per-frame so toggles morph.
// Velocities are zeroed while pinned, so unpinning resumes orbital dynamics
// calmly from the orb.
function layoutOrb(u) {
  if (!u || !u.nodes || !u.nodes.length) return;
  const r = document.getElementById('uniCv').getBoundingClientRect();
  const W = Math.max(50, r.width), H = Math.max(50, (r.height || 400));
  const s = (ren.project(0, 0, 0).s || 1);
  const R = Math.min(W, H) * 0.42 / Math.max(0.05, s);
  const aspect = Math.min(2.2, Math.max(1, W / Math.max(1, H)));
  const RX = R * aspect, RY = R, RZ = R * 0.72;
  const sunId = (activeId && u.byId.has(activeId)) ? activeId : u.sunId;
  const fib = (i, n, rad) => {
    const golden = Math.PI * (3 - Math.sqrt(5));
    const y = n <= 1 ? 0 : 1 - (2 * (i + 0.5)) / n;
    const rr = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * (i + 0.5);
    return [Math.cos(th) * rr * rad, y * rad, Math.sin(th) * rr * rad];
  };
  const k = 0.16; // ease per frame
  for (const n of u.nodes) {
    n.vx = n.vy = n.vz = 0;
    if (n.id === sunId) { n.x += (0 - n.x) * k; n.y += (0 - n.y) * k; n.z += (0 - n.z) * k; }
  }
  const others = u.nodes.filter(n => n.id !== sunId).sort((a, b) => (b.mass || 0) - (a.mass || 0));
  const cut = Math.max(1, Math.ceil(others.length * 0.18));
  const inner = others.slice(0, cut), outer = others.slice(cut);
  inner.forEach((n, i) => { const [x, y, z] = fib(i, inner.length, 0.55); n.x += (x * RX - n.x) * k; n.y += (y * RY - n.y) * k; n.z += (z * RZ - n.z) * k; });
  outer.forEach((n, i) => { const [x, y, z] = fib(i, outer.length, 1); n.x += (x * RX - n.x) * k; n.y += (y * RY - n.y) * k; n.z += (z * RZ - n.z) * k; });
}
function syncLensBtn() {
  const b = $('#lensBtn');
  if (!b) return;
  b.classList.toggle('on', lensThematic);
  b.textContent = (lensThematic && thematicWhole) ? '◉ Thematic ⋃' : '◉ Thematic';
  b.title = (lensThematic && thematicWhole)
    ? 'Thematic lens: whole-docuverse theme map (click to restore the regular view)'
    : 'Thematic lens: recompose the universe from shared themes + tags only (same physics, same bodies)';
}
function applyLens() {
  if (lensThematic) uni = thematicUniFor(vault.activeTabId) || unis.get(vault.activeTabId) || null;
  else uni = unis.get(vault.activeTabId) || null;
  // a lens swap is a view change: drop any search dimming (it references the
  // other universe's ids and would leave the restored view half-dark)
  try { $('#searchPop').innerHTML = ''; $('#searchInput').value = ''; } catch {}
  matchSet = null;
  if (uni && activeId && uni.sunId !== activeId && uni.byId.has(activeId)) uni.focus(activeId);
  if (uni && activeId && !uni.byId.has(activeId)) activeId = uni.sunId; // stale theme sun
  try { vault.tab().activeId = activeId; } catch {}
  syncLensBtn();
  renderDoc();
  updateStats();
}
// panel collapse: shrink the column up into a slim top tab (arrow flips ▲/▼)
function setCollapsed(id, on) {
  const p = document.getElementById(id);
  if (!p) return;
  p.classList.toggle('collapsed', !!on);
  const b = p.querySelector('[data-collapse]');
  if (b) { b.textContent = on ? '▼' : '▲'; b.title = on ? 'Expand panel' : 'Collapse panel'; }
  if (id === 'leftPanel') leftCollapsed = !!on;
  if (id === 'docPanel') docCollapsed = !!on;
  saveUi();
  try { syncResizeHandle(); } catch {}
}
// bottom pill "Tethers" button: show/hide the tether lines only (bodies always stay).
// It drives the same tetherScale as the left-panel Tether row, so both stay in sync.
function syncIsoBtn() {
  const b = $('#isoBtn');
  if (!b) return;
  b.classList.toggle('on', tetherScale > 0);
  b.textContent = '◉ Tethers';
}

// ---------- "?" explicator popups: editable in the editor, locked in desktop exports ----------
// DESKTOP EXPORT NOTE: set `window.GRAVITAS_HELP_LOCKED = true` in the exported shell
// (e.g. `<script>window.GRAVITAS_HELP_LOCKED = true</script>` before src/app.js) to hide
// every ✎ edit button. file:// / Tauri / Electron shells are auto-locked below, so a plain
// static export already ships read-only even if you forget the flag.
const DEFAULT_HELP = {
  shared: 'Shared ground = the same (or very similar) conversation. We compare the distinctive themes in each file — files (\'bodies\') sharing themes with this one land here.',
  mass: 'Mass is pull. Bigger, more comprehensive, files \'weigh\' more, so they tug harder on everything around them.',
  energy: 'Total motion in the document universe. High "system energy" numbers mean bodies are flying fast — especially if more files (\'bodies\') are being added — and it settles as correlational orbits stabilize.',
  rim: 'The edge of the visualized document universe. Files (\'bodies\') drifting past it are loners with no links — a single reference can pull them back in and connect them.',
  thematic: 'Thematic lens: rebuilds the universe from shared themes + tags only — one body per theme, sized by its weight. Click a member to drill down; toggle Thematic off to restore the full universe.',
};
const HELP_TITLES = {
  shared: 'Shared Ground', mass: 'Mass', energy: 'System energy', rim: 'The rim', thematic: 'Thematic lens',
};
let helpTexts = { ...DEFAULT_HELP };
try {
  const stored = JSON.parse(localStorage.getItem('gravitas.help') || '{}');
  for (const k of Object.keys(DEFAULT_HELP)) {
    if (typeof stored[k] === 'string' && stored[k].trim()) helpTexts[k] = stored[k];
  }
} catch { /* fresh prefs */ }
function saveHelp() {
  try { localStorage.setItem('gravitas.help', JSON.stringify(helpTexts)); } catch { /* private mode */ }
}
function helpEditAllowed() {
  try {
    if (window.GRAVITAS_HELP_LOCKED === true) return false;
    const q = new URLSearchParams(location.search || '');
    if (q.get('helpedit') === '0' || q.get('noedit') === '1') return false;
    if (window.__TAURI__ || window.__TAURI_INTERNALS__ || window.__TAURI_METADATA__) return false;
    const p = String(location.protocol || '').toLowerCase();
    if (p === 'file:' || p === 'tauri:' || p === 'wry:' || p === 'app:') return false;
    const ua = String(navigator.userAgent || '').toLowerCase();
    if (ua.includes(' tauri/') || ua.includes('electron/') || ua.includes(' wry/')) return false;
  } catch { /* default to editable */ }
  return true;
}
function applyHelpToStatic() {
  for (const k of Object.keys(DEFAULT_HELP)) {
    const el = document.querySelector(`[data-help-text="${k}"]`);
    if (el) el.textContent = helpTexts[k];
  }
}
let helpEditingKey = null;
function openHelpEditor(key) {
  if (!helpEditAllowed() || !DEFAULT_HELP[key]) return;
  helpEditingKey = key;
  const modal = document.querySelector('#helpEditModal');
  const title = document.querySelector('#helpEditTitle');
  const area = document.querySelector('#helpEditText');
  if (!modal || !area) return;
  if (title) title.textContent = `Edit “${HELP_TITLES[key] || key}” explanation`;
  area.value = helpTexts[key];
  modal.hidden = false;
  setTimeout(() => { try { area.focus(); area.select(); } catch {} }, 30);
}
function closeHelpEditor() {
  helpEditingKey = null;
  const modal = document.querySelector('#helpEditModal');
  if (modal) modal.hidden = true;
}
function saveHelpEditor(reset) {
  if (!helpEditingKey) return;
  const area = document.querySelector('#helpEditText');
  if (reset) {
    helpTexts[helpEditingKey] = DEFAULT_HELP[helpEditingKey];
  } else if (area) {
    const v = area.value.trim();
    helpTexts[helpEditingKey] = v || DEFAULT_HELP[helpEditingKey];
  }
  saveHelp();
  // live-update every visible popup with this key (static + just-rendered dynamic)
  document.querySelectorAll(`[data-help-text="${helpEditingKey}"]`).forEach(el => { el.textContent = helpTexts[helpEditingKey]; });
  closeHelpEditor();
  toast('Explanation saved');
}
let virtT = performance.now() / 1000; // virtual clock: frozen on pause, slowed by slider
let lastReal = performance.now();

// ---------- canvases (top tabs): switch / create / close / render ----------
function renderTabs() {
  const bar = $('#tabBar');
  if (!bar) return;
  bar.innerHTML = `<span class="tabbar-label">Active DocuVerse Projects</span><span class="tabbar-row">` + vault.tabs.map(t => {
    const iso = vault.isIso(t);
    const tinted = iso && typeof t.color === 'string' && /^#[0-9a-f]{6}$/i.test(t.color);
    return `<button class="tab${t.id === vault.activeTabId ? ' active' : ''}${iso ? ' iso' : ''}${tinted ? ' tinted' : ''}" data-tab="${t.id}"${tinted ? ` style="--tabc:${t.color}"` : ''} title="${esc(t.name)}${t.main ? ' — main verse' : ''}${iso ? ' — isolated verse: uploads, searches and deletes stay in this tab' : ''} — double-click to rename, right-click for associations">${t.main ? '★ ' : ''}${iso ? '◌ ' : ''}${esc(t.name)} · ${t.docs.length}${vault.tabs.length > 1 ? `<span class="tabx" data-closetab="${t.id}" title="Close canvas">×</span>` : ''}</button>`;
  }).join('') + `<button class="tab tabadd" data-addtab="1" title="New canvas">+</button></span>`;
}
function switchCanvas(id) {
  const t = vault.tabs.find(t => t.id === id);
  if (!t || id === vault.activeTabId) return;
  try { vault.tab().activeId = activeId; } catch {} // remember where we were
  vault.activeTabId = id;
  vault.persist();
  if (!unis.has(id)) rebuildTab(id); // first visit builds it (copies snap into lockstep below)
  uni = unis.get(id); // swap live universes: formations hold, no re-scatter
  if (lensThematic) uni = thematicUniFor(id) || uni; // lens persists across canvases
  if (thematicWhole) {
    // whole-docuverse view spans every canvas: keep a live whole theme, else stay general
    if (!themeById(activeId)) activeId = uni ? uni.sunId : null;
  } else {
    // an explicitly cleared sun (general state) stays cleared — don't resurrect docs[0]
    activeId = (t.activeId && vault.byId(t.activeId)) ? t.activeId : ((t.activeId === null && t.docs.length) ? null : (t.docs[0]?.id || null));
    t.activeId = activeId;
  }
  refreshEdgeInfo(id); // reader was showing the previous canvas's tethers (SHARED GROUND — 0)
  syncLensBtn(); // the lens pill reflects whole/per-tab state, which jumps can change
  renderDoc();
  updateStats();
  renderTabs();
  try { $('#searchPop').innerHTML = ''; $('#searchInput').value = ''; } catch {}
  matchSet = null;
  selSet.clear(); // selections never travel between canvases
  toast(`Canvas: ${t.name} (${t.docs.length} bodies)`);
}
async function closeCanvas(id) {
  const t = vault.tabs.find(t => t.id === id);
  if (!t) return;
  if (vault.tabs.length <= 1) { toast('That is the only canvas'); return; }
  if (!await confirmDlg(`Close canvas “${t.name}” with ${t.docs.length} bodies? They will be deleted.`, 'Close canvas')) return;
  const wasActive = id === vault.activeTabId;
  vault.closeTab(id);
  unis.delete(id);
  thematicUnis.delete(id); thematicBuilt.delete(id);
  if (wasActive) {
    const nid = vault.activeTabId;
    if (!unis.has(nid)) rebuildTab(nid);
    uni = unis.get(nid);
    if (lensThematic) uni = thematicUniFor(nid) || uni;
    activeId = vault.tab().activeId;
    if (activeId && !vault.byId(activeId) && !themeById(activeId)) activeId = null; // stale sun
    if (activeId == null && vault.tab().activeId !== null) activeId = vault.docs[0]?.id || null; // general state (explicit null) stays general
    vault.tab().activeId = activeId;
    refreshEdgeInfo(nid);
    try { $('#searchPop').innerHTML = ''; $('#searchInput').value = ''; } catch {}
    matchSet = null;
    selSet.clear();
    renderDoc();
    updateStats();
  }
  renderTabs();
  toast(`Canvas “${t.name}” closed`);
}

// verse isolation: any tab with no associations is a fully separate DocuVerse
// (uploads, searches, tags, copies, deletes, twin motion stay inside).
// Linking is done per-verse from the tab's right-click menu; closing the main
// verse promotes the oldest tab.

// removal entry points (shared by the right-click menu AND the reader-panel buttons,
// so touch users with no right-click can also remove bodies).
async function removeFromCanvas(id) {
  const d = vault.byId(id);
  if (!d) return;
  const root = d.origin || d.id;
  const elsewhere = vault.tabs.filter(t => t.id !== vault.activeTabId && t.docs.some(x => x.id === root || x.origin === root)).length;
  if (!await confirmDlg(`Remove “${vault.titleOf(d)}” from “${vault.tab().name}” only?${elsewhere ? ` (Still in ${elsewhere} other canvas${elsewhere === 1 ? '' : 'es'}.)` : ''}`, 'Remove')) return;
  const wasSun = id === activeId;
  vault.remove(id);
  selSet.delete(id); // drop it from any box selection too
  if (activeId != null && (wasSun || !vault.byId(activeId))) activeId = vault.docs[0]?.id || null; // general state (null) stays general
  vault.tab().activeId = activeId;
  rebuild(activeId);
  renderTabs();
  toast('Removed from this canvas');
}
async function deleteEverywhere(id) {
  const d = vault.byId(id) || vault.tabs.flatMap(t => t.docs).find(x => x.id === id);
  if (!d) return;
  const root = d.origin || d.id;
  const scope = vault.scopeTabs(); // unassociated verses purge only themselves
  const hits = scope.filter(t => t.docs.some(x => x.id === id || x.id === root || x.origin === root)).length;
  const where = scope.length > 1
    ? `“${vault.tab().name}” and its ${scope.length - 1} associated verse${scope.length === 2 ? '' : 's'} (${hits} canvas${hits === 1 ? '' : 'es'} hold it)`
    : `“${vault.tab().name}” only (isolated verse — other canvases keep their copies)`;
  if (!await confirmDlg(`Delete “${vault.titleOf(d)}” from ${where}? This cannot be undone.`, 'Delete everywhere')) return;
  const n = vault.removeEverywhere(id);
  pruneSel(); // universe-wide purge can take selected bodies with it
  rebuildAllTabs();
  if (activeId != null && !vault.byId(activeId)) activeId = vault.docs[0]?.id || null; // general state (null) stays general
  vault.tab().activeId = activeId;
  renderDoc();
  updateStats();
  renderTabs();
  toast(`Deleted ${n} ${n === 1 ? 'copy' : 'copies'} from the universe`);
}
// empty the active canvas (bodies only — the canvas itself stays open; other canvases untouched)
async function removeAllFromCanvas() {
  const t = vault.tab();
  if (!t) return;
  if (!t.docs.length) { toast('This canvas is already empty'); return; }
  if (!await confirmDlg(`Remove all ${t.docs.length} ${t.docs.length === 1 ? 'body' : 'bodies'} from “${t.name}” only? The canvas stays open but empty. Other canvases are untouched.`, 'Remove all')) return;
  t.docs = [];
  t.activeId = null;
  selSet.clear();
  vault.persist();
  activeId = null;
  rebuild(null);
  renderTabs();
  toast(`Removed everything from “${t.name}”`);
}

// bulk removal for the marquee box selection: bodies AND their docs leave this
// tab only (each tab owns its doc copies — other canvases keep theirs).
async function removeIdsFromCanvas(ids) {
  const t = vault.tab();
  if (!t) return;
  const targets = [...new Set(ids || [])].filter(sid => t.docs.some(d => d.id === sid));
  if (!targets.length) { toast('Selected bodies are themes — exit the Thematic lens to delete docs'); selSet.clear(); return; }
  if (!await confirmDlg(`Delete ${targets.length} ${targets.length === 1 ? 'body' : 'bodies'} AND ${targets.length === 1 ? 'its doc' : 'their docs'} from “${t.name}” only? Other canvases keep their copies. This cannot be undone.`, 'Delete')) return;
  t.docs = t.docs.filter(d => !targets.includes(d.id));
  targets.forEach(sid => selSet.delete(sid));
  vault.persist();
  if (!vault.byId(activeId)) activeId = vault.docs[0]?.id || null;
  vault.tab().activeId = activeId;
  rebuild(activeId);
  renderDoc();
  updateStats();
  renderTabs();
  toast(`Deleted ${targets.length} ${targets.length === 1 ? 'body' : 'bodies'} (+ docs) from “${t.name}”`);
}
// nuke the whole tab universe + its docs (the "Remove all" sibling with explicit docs wording)
async function removeUniverseFromCanvas() {
  const t = vault.tab();
  if (!t) return;
  if (!t.docs.length) { toast('This canvas is already empty'); return; }
  if (!await confirmDlg(`Delete the ENTIRE “${t.name}” universe — all ${t.docs.length} ${t.docs.length === 1 ? 'body' : 'bodies'} AND their docs? This tab only; other canvases keep their copies. This cannot be undone.`, 'Delete universe')) return;
  t.docs = [];
  t.activeId = null;
  selSet.clear();
  vault.persist();
  activeId = null;
  rebuild(null);
  renderDoc();
  updateStats();
  renderTabs();
  toast(`Deleted the “${t.name}” universe + docs`);
}
// per-canvas persistent universes: switching tabs swaps the live universe instead
// of rebuilding, so every canvas holds its exact formation (rotation included).
function rebuildTab(tabId) {
  const prevActive = vault.activeTabId;
  vault.activeTabId = tabId;
  const tab = vault.tab();
  const { bodies, edges } = vault.universe();
  let u = unis.get(tabId);
  if (!u) { u = new Universe(); unis.set(tabId, u); }
  u.setData(bodies, edges, tab.activeId);
  tab.activeId = u.sunId;
  vault.activeTabId = prevActive;
  edgeByTab.set(tabId, { n: tab.docs.length, edges });
  if (tabId === prevActive) edgeInfo = edges;
  vault.persist();
  return u;
}
function rebuildAllTabs() {
  for (const t of vault.tabs) rebuildTab(t.id);
  uni = unis.get(vault.activeTabId) || null;
  if (lensThematic) uni = thematicUniFor(vault.activeTabId) || uni;
  return uni;
}
function rebuild(sunId) {
  // active-tab rebuild (legacy entry point): optional sun override, then refresh panes
  if (sunId && vault.byId(sunId)) vault.tab().activeId = sunId;
  uni = rebuildTab(vault.activeTabId);
  if (lensThematic) uni = thematicUniFor(vault.activeTabId) || uni;
  activeId = uni ? uni.sunId : null;
  vault.tab().activeId = activeId;
  renderDoc();
  updateStats();
}
// quantum lock: every copy mirrors its root's live pose in every canvas, each frame.
// The first canvas holding a root (usually the main canvas) is the source of truth.
function entangleSync() {
  const seen = new Map(); // rootId -> primary node
  const syncScope = new Set(vault.scopeTabs().map(t => t.id)); // only the active association stays in lockstep
  for (const t of vault.tabs) {
    if (!syncScope.has(t.id)) continue; // unassociated verses evolve independently — no twin lockstep
    const u = unis.get(t.id);
    if (!u) continue;
    for (const n of u.nodes) {
      const root = n.origin || n.id;
      const p = seen.get(root);
      if (!p) seen.set(root, n);
      else { n.x = p.x; n.y = p.y; n.z = p.z; n.vx = p.vx; n.vy = p.vy; n.vz = p.vz; }
    }
  }
}

function updateStats() {
  const s = uni.stats();
  { const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('#stBodies', s.bodies); set('#stLinks', s.links);
    set('#stKe', s.ke.toFixed(0)); set('#stRim', s.maxR.toFixed(0)); }
}

// remember a newly focused sun on its canvas (survives reloads via vault.persist)
function claimSun(id) {
  activeId = id;
  try { const t = vault.tab(); if (t) t.activeId = id; vault.persist(); } catch {}
}
// general state: no active body — the sun cools back to a body and the canvas
// center becomes the gravitational center. Returns true when something changed.
function defocusSun() {
  if (!uni) return false;
  if (activeId == null && uni.sunId == null) return false;
  uni.defocus();
  activeId = null;
  try { const t = vault.tab(); if (t) t.activeId = null; vault.persist(); } catch {}
  renderDoc();
  updateStats();
  return true;
}
// sticky notes: one 140-char note per body, drawn as a yellow square left of its
// label. Single source of truth on the vault doc — the canvas square and the
// reader pop-out are mirror views re-rendered from it on every change.
const NOTE_MAX = 140;
let notePopId = null; // doc id shown in the reader's note pop-out
let noteEditId = null; // doc id being edited in the floating canvas editor
function getNote(id) { const d = vault.byId(id); return (d && typeof d.note === 'string') ? d.note : ''; }
function refreshNoteViews(id) {
  if (activeId === id) renderDoc(); // refreshes the notes button too
  if (notePopId === id && !$('#notePop').hidden) renderNotePop(false);
}
function saveNote(id, text) {
  const d = vault.byId(id); if (!d) return false;
  text = String(text ?? '').slice(0, NOTE_MAX);
  if (text.trim()) d.note = text; else delete d.note;
  vault.persist();
  refreshNoteViews(id);
  return true;
}
function deleteNote(id) {
  const d = vault.byId(id); if (!d || !d.note) return false;
  delete d.note;
  vault.persist();
  refreshNoteViews(id);
  return true;
}
// floating canvas editor (opened by clicking a body's note square; sun stays put)
function openNoteEditor(id, cx, cy) {
  const d = vault.byId(id); if (!d) return;
  noteEditId = id;
  $('#noteEditTitle').textContent = '◉ ' + vault.titleOf(d);
  $('#noteEditText').value = getNote(id);
  $('#noteEditCount').textContent = String(getNote(id).length);
  $('#noteEditDelete').style.display = getNote(id) ? '' : 'none';
  const el = $('#noteEdit');
  el.hidden = false;
  el.style.left = Math.max(8, Math.min(window.innerWidth - 266, cx + 12)) + 'px';
  el.style.top = Math.max(8, Math.min(window.innerHeight - 250, cy + 12)) + 'px';
  setTimeout(() => { try { $('#noteEditText').focus(); } catch {} }, 30);
}
function closeNoteEditor() { const el = $('#noteEdit'); if (el) el.hidden = true; noteEditId = null; }
// reader pop-out for the active body's note (copy / delete mirror the square)
function openNotePop(id) {
  if (notePopId === id && !$('#notePop').hidden) { closeNotePop(); return; } // toggle
  if (!vault.byId(id)) return;
  notePopId = id;
  renderNotePop(false);
  $('#notePop').hidden = false;
}
function closeNotePop() { const el = $('#notePop'); if (el) el.hidden = true; notePopId = null; }
function renderNotePop(editing) {
  const d = vault.byId(notePopId); if (!d) { closeNotePop(); return; }
  const note = getNote(notePopId);
  const box = $('#notePop');
  if (editing || !note) {
    box.innerHTML = `<div class="np-head"><span class="np-title">◉ ${esc(vault.titleOf(d))}</span><span class="np-cap" data-np="close">✕</span></div>` +
      `<textarea class="np-area" id="notePopText" maxlength="${NOTE_MAX}" placeholder="140 characters max…">${esc(note)}</textarea>` +
      `<div class="np-count"><span id="notePopCount">${note.length}</span>/${NOTE_MAX}</div>` +
      `<div class="rowbtns"><button class="btn" data-np="save">Save</button><button class="btn" data-np="close">Cancel</button></div>`;
    const ta = $('#notePopText');
    if (ta) {
      ta.addEventListener('input', () => { const c = $('#notePopCount'); if (c) c.textContent = String(ta.value.length); });
      setTimeout(() => { try { ta.focus(); } catch {} }, 30);
    }
  } else {
    box.innerHTML = `<div class="np-head"><span class="np-title">◉ ${esc(vault.titleOf(d))}</span><span class="np-cap" data-np="copy">copy</span><span class="np-cap danger" data-np="del">delete</span><span class="np-cap" data-np="edit">edit</span><span class="np-cap" data-np="close">✕</span></div>` +
      `<div class="np-text">${esc(note)}</div>`;
  }
}
async function copyNotePop() {
  const note = getNote(notePopId);
  if (!note) return;
  try { await navigator.clipboard.writeText(note); }
  catch { const ta = document.createElement('textarea'); ta.value = note; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch {} ta.remove(); }
  toast('Sticky note copied');
}
function setKicker(s) { const k = $('#docPanel .kicker'); if (k && k.textContent !== s) k.textContent = s; }
// general-state reader: no active body — a live overview with drill-down rows,
// never stale bodies. Thematic general lists the lens's themes; regular general
// lists the canvas. An empty canvas keeps its import hint.
function renderGeneral() {
  const t = vault.tab();
  const docs = t ? (t.docs || []) : [];
  if (lensThematic) {
    const themes = thematicWhole ? wholeThemes : (thematicThemes.get(vault.activeTabId) || []);
    const scope = thematicWhole ? 'the whole docuverse' : `“${t ? t.name : 'this canvas'}”`;
    setKicker(thematicWhole ? '◈ THEMATIC — WHOLE DOCUVERSE' : '◈ THEMATIC — NO ACTIVE THEME');
    $('#docTitle').textContent = thematicWhole ? '◈ Whole docuverse — thematic map' : '◈ Thematic — no active theme';
    const grounded = themes.reduce((s, th) => s + ((th.members && th.members.length) || 0), 0);
    $('#docMeta').textContent = `${themes.length} themes · ${grounded} grounded bodies · distilled from ${scope}`;
    $('#docTags').innerHTML = '';
    $('#docBody').innerHTML = `<span style="color:var(--mut)">${themes.length ? 'Click a theme body to inspect its concepts and grounded bodies.' : 'No shared concepts to distill yet — add documents with overlapping vocabulary.'} Click empty space anytime to release the sun; the canvas center holds gravity in this state.</span>`;
    const sg = $('#docShared');
    if (sg) sg.innerHTML = '';
    $('#docLinks').innerHTML = (themes.length ? `<div class="bl-head">THEMES — ${themes.length}</div>` : '') +
      [...themes].sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1))
        .map(th => `<button class="bl-row" data-open="${th.id}">◈ ${esc(th.label)}<span>${esc((th.terms || []).slice(0, 3).join(' · '))}</span></button>`).join('');
  } else {
    setKicker('◌ GENERAL STATE — CENTER GRAVITY');
    const sg = $('#docShared');
    if (sg) sg.innerHTML = '';
    if (!docs.length) {
      $('#docTitle').textContent = 'Empty canvas';
      $('#docMeta').innerHTML = '';
      $('#docTags').innerHTML = '';
      $('#docBody').innerHTML = '<span style="color:var(--mut)">This canvas is empty — import files, or right-click a body on another canvas and copy it here.</span>';
      $('#docLinks').innerHTML = '';
    } else {
      const tethers = uni ? uni.edges.length : 0;
      const words = docs.reduce((s, d) => s + (d.words || 0), 0);
      $('#docTitle').textContent = `◌ ${t.name} — general view`;
      $('#docMeta').textContent = `${docs.length} bodies · ${tethers} tethers · ${words} words · no active body`;
      $('#docTags').innerHTML = '';
      $('#docBody').innerHTML = '<span style="color:var(--mut)">Click any body to make it the gravitational center. Click empty space to release the sun — the canvas center holds gravity. Toggle Thematic with nothing selected for the whole-docuverse theme map.</span>';
      const big = [...docs].sort((a, b) => (b.words || 0) - (a.words || 0)).slice(0, 6);
      $('#docLinks').innerHTML = `<div class="bl-head">LARGEST BODIES — ${big.length}</div>` +
        big.map(o => `<button class="bl-row" data-open="${o.id}">◉ ${esc(vault.titleOf(o))}<span>${o.words} words</span></button>`).join('');
    }
  }
  const da = $('#docActions');
  if (da) da.hidden = true; // nothing active — nothing to remove or delete
  try { syncResizeHandle(); } catch {}
}
function renderDoc() {
  const d = vault.byId(activeId);
  if (!d) {
    const th = themeById(activeId);
    if (th && uni && uni.byId.has(activeId)) {
      setKicker(thematicWhole ? '◈ ACTIVE THEME — WHOLE DOCUVERSE' : '◈ ACTIVE THEME — GRAVITATIONAL CENTER');
      renderThemeDoc(th); return;
    }
    // general state (or an empty canvas): the overview reader, never stale bodies
    renderGeneral();
    return;
  }
  setKicker('◉ ACTIVE BODY — GRAVITATIONAL CENTER');
  $('#docTitle').textContent = vault.titleOf(d);
  const m = uni.byId.get(activeId);
  $('#docMeta').innerHTML = `${d.words} words · mass ${(m ? (m.trueMass ?? m.mass) : 0).toFixed(1)} <span class="sg-help" data-sghelp tabindex="0">?</span> · ${d.links.length} outgoing refs<div class="sg-help-pop" role="note" data-help-pop="mass"><span class="help-text" data-help-text="mass">${esc(helpTexts.mass)}</span><button class="help-edit-btn" data-help-edit="mass" title="Edit this explanation">✎ edit</button></div>`;
  $('#docTags').innerHTML = d.tags.map(t =>
    `<button class="tagpill${t.startsWith('auto/') ? ' auto' : ''}" data-tag="${esc(t)}">#${esc(t)}</button>`).join('') +
    `<button class="tagpill notesbtn" data-notes="${d.id}" title="Sticky note for this body (140 characters max)">notes</button>`;
  $('#docBody').innerHTML = renderBody(d.text);
  // shared ground -> top hover spillover menu (up to 12 tethers, scrolls)
  const res = edgeInfo.filter(e => e.kind === 'topic' && (e.source === d.id || e.target === d.id)).slice(0, 12);
  const sg = $('#docShared');
  sg.classList.remove('open'); sg.classList.remove('help-open');
  sg.innerHTML = `<span class="sg-label" data-sg tabindex="0">SHARED GROUND — ${res.length}</span><span class="sg-help" data-sghelp tabindex="0">?</span>` +
    `<div class="sg-help-pop" role="note" data-help-pop="shared"><span class="help-text" data-help-text="shared">${esc(helpTexts.shared)}</span><button class="help-edit-btn" data-help-edit="shared" title="Edit this explanation">✎ edit</button></div>` +
    `<div class="sg-menu" role="menu">` + (res.length ? res.map(e => {
      const oid = e.source === d.id ? e.target : e.source;
      const o = vault.byId(oid);
      if (!o) return '';
      return `<button class="bl-row" data-open="${oid}">◉ ${esc(vault.titleOf(o))}<span>${esc((e.topics || []).join(' · '))}</span></button>`;
    }).join('') : '<div class="sg-empty">No shared ground.</div>') + `</div>`;
  // bodies referencing this one stay inline below the body text
  const back = vault.docs.filter(o => o.id !== d.id && o.links.some(t => vault.byTitle(t)?.id === d.id));
  $('#docLinks').innerHTML = (back.length ? `<div class="bl-head">PULLED INTO ORBIT — ${back.length}</div>` : '') +
    back.map(o => `<button class="bl-row" data-open="${o.id}">◉ ${esc(vault.titleOf(o))}</button>`).join('');
  const da = $('#docActions');
  if (da) da.hidden = false;
  try { syncResizeHandle(); } catch {}
}

// reader panel for a distilled theme body: its concepts + grounded member docs.
// Member rows reuse data-open, so clicking one focuses that doc in the lens.
function renderThemeDoc(th) {
  const node = uni ? uni.byId.get(th.id) : null;
  $('#docTitle').textContent = '◈ ' + th.label;
  $('#docMeta').innerHTML = `theme · weight ${th.weight.toFixed(1)} · mass ${((node && (node.trueMass ?? node.mass)) ?? th.mass).toFixed(1)} <span class="sg-help" data-sghelp tabindex="0">?</span><div class="sg-help-pop" role="note" data-help-pop="mass"><span class="help-text" data-help-text="mass">${esc(helpTexts.mass)}</span><button class="help-edit-btn" data-help-edit="mass" title="Edit this explanation">✎ edit</button></div>`;
  $('#docTags').innerHTML = th.terms.map(term =>
    `<button class="tagpill" data-tag="${esc(term)}">#${esc(term)}</button>`).join('');
  // theme summary, wired to THIS theme: its top-evidence concepts, its weight
  // rank across the lens, and its closest neighboring theme by shared grounded
  // bodies — so every theme reads distinctly instead of sharing boilerplate.
  const tAll = thematicWhole ? wholeThemes : (thematicThemes.get(vault.activeTabId) || []);
  const tRank = [...tAll].sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1)).findIndex(t => t.id === th.id) + 1;
  const mine = new Set(th.members || []);
  let nb = null, nbN = 0;
  for (const o of tAll) {
    if (o.id === th.id) continue;
    let n = 0; for (const id of (o.members || [])) if (mine.has(id)) n++;
    if (n > nbN) { nbN = n; nb = o; }
  }
  const tN = th.terms.length, mN = th.members.length;
  const tMass = ((node && (node.trueMass ?? node.mass)) ?? th.mass);
  const tShown = esc(th.terms.slice(0, 3).join(', ')) + (tN > 3 ? ` +${tN - 3} more` : '');
  const rankTxt = tRank === 1 ? `heaviest of ${tAll.length}` : (tRank > 0 ? `#${tRank} of ${tAll.length}` : 'unranked');
  $('#docBody').innerHTML = `<span style="color:var(--mut)">Top evidence: ${tShown} — ${tN} co-traveling concept${tN === 1 ? '' : 's'} grounding ${mN} ${mN === 1 ? 'body' : 'bodies'}. Ranked ${rankTxt} by thematic weight (${th.weight.toFixed(1)} → mass ${tMass.toFixed(1)}).${nb && nbN > 0 ? ` Closest neighbor: ◈ ${esc(nb.label)} (${nbN} shared ${nbN === 1 ? 'body' : 'bodies'}).` : ''}</span>`;
  // shared ground, theme edition: neighboring themes + the grounded bodies they
  // share (the thematic universe webs themes by shared members). Same dropdown
  // pattern as docs; rows drill into the neighboring theme.
  const tunEdges = (uni && Array.isArray(uni.edges) ? uni.edges : [])
    .filter(e => e.kind === 'topic' && (e.source === th.id || e.target === th.id)).slice(0, 12);
  const tRows = [];
  for (const e of tunEdges) {
    const oid = e.source === th.id ? e.target : e.source;
    const o = themeById(oid);
    if (!o) continue;
    const oSet = new Set(o.members || []);
    const common = (th.members || []).map(id => vault.byIdAnywhere(id)).filter(o2 => o2 && oSet.has(o2.id));
    tRows.push({ oid, label: o.label, span: common.length ? common.slice(0, 5).map(o2 => vault.titleOf(o2)).join(' · ') : (o.terms || []).slice(0, 5).join(' · ') });
  }
  const sg = $('#docShared');
  if (sg) {
    sg.classList.remove('open'); sg.classList.remove('help-open');
    sg.innerHTML = `<span class="sg-label" data-sg tabindex="0">SHARED GROUND — ${tRows.length}</span><span class="sg-help" data-sghelp tabindex="0">?</span>` +
      `<div class="sg-help-pop" role="note" data-help-pop="shared"><span class="help-text" data-help-text="shared">${esc(helpTexts.shared)}</span><button class="help-edit-btn" data-help-edit="shared" title="Edit this explanation">✎ edit</button></div>` +
      `<div class="sg-menu" role="menu">` + (tRows.length ? tRows.map(r =>
        `<button class="bl-row" data-open="${r.oid}">◈ ${esc(r.label)}<span>${esc(r.span)}</span></button>`).join('') : '<div class="sg-empty">No shared ground.</div>') + `</div>`;
  }
  const rows = th.members.map(id => vault.byIdAnywhere(id)).filter(Boolean);
  $('#docLinks').innerHTML = (rows.length ? `<div class="bl-head">GROUNDED BODIES — ${rows.length}</div>` : '') +
    rows.map(o => `<button class="bl-row" data-open="${o.id}">◉ ${esc(vault.titleOf(o))}</button>`).join('');
  const da = $('#docActions');
  if (da) da.hidden = true; // themes are derived — nothing to remove or delete
  try { syncResizeHandle(); } catch {}
}

function renderBody(text) {
  // strip a leading H1 (title is already in the header), light inline markup
  let e = esc(text).replace(/^#\s+.*$/m, '').trim();
  e = e
    .replace(/\[\[([^\[\]]+?)\]\]/g, (m, inner) => {
      const parts = inner.split('|');
      return `<span class="wl" data-wl="${esc(parts[0].trim())}">${esc((parts[1] ?? parts[0]).trim())}</span>`;
    })
    .replace(/(^|\s)#([A-Za-z0-9_\-/]{2,})/g, '$1<span class="tag" data-tag="$2">#$2</span>')
    .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
  return e || '<span style="color:var(--mut)">Empty body.</span>';
}

// ---------- intake: real folder select + files + drop ----------
const OFFICE_MSG = 'Office libraries load from a CDN on first use — check connection and retry.';
const INTAKE_RE = /\.(md|markdown|txt|csv|pdf|docx?|xlsx?|pptx?)$/i;
const INTAKE_LABEL = '.md / .txt / .csv / .pdf / .docx / .xlsx / .pptx';
function cleanName(f) {
  let n = (f && f.name) || '';
  if (!n && f && f.webkitRelativePath) n = String(f.webkitRelativePath).split('/').pop() || '';
  n = String(n || '').trim();
  n = n.replace(/[\s.]+$/, '');
  if (!n && f && f.webkitRelativePath) n = String(f.webkitRelativePath);
  return n || 'unnamed';
}
function extOf(name) {
  const m = String(name || '').trim().toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? '.' + m[1] : '(no extension)';
}
function intakeAllowed(f) {
  const nm = cleanName(f);
  if (INTAKE_RE.test(nm)) return true;
  const ty = String((f && f.type) || '').toLowerCase().split(';')[0].trim();
  if (!ty) return false;
  if (ty.includes('wordprocessingml') || ty === 'application/msword') return true;
  if (ty.includes('spreadsheetml') || ty === 'application/vnd.ms-excel') return true;
  if (ty.includes('presentationml') || ty === 'application/vnd.ms-powerpoint') return true;
  if (ty === 'application/pdf') return true;
  if (ty.indexOf('text/') === 0) return true;
  return false;
}
async function readFileAsText(f) {
  const nm = cleanName(f);
  if (/\.pdf$/i.test(nm)) {
    try {
      const pdfjs = await import('https://esm.sh/pdfjs-dist@4.2.67/build/pdf.mjs');
      const lib = pdfjs.getDocument ? pdfjs : (pdfjs.default || {});
      if (lib?.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
        lib.GlobalWorkerOptions.workerSrc = 'https://esm.sh/pdfjs-dist@4.2.67/build/pdf.worker.mjs';
      }
      const getDocument = lib.getDocument;
      if (!getDocument) throw new Error('PDF engine did not load.');
      const data = new Uint8Array(await f.arrayBuffer());
      if (!data.length) throw new Error('That file looks empty (0 bytes).');
      const pdf = await getDocument({ data }).promise;
      let out = [];
      for (let p = 1; p <= Math.min(pdf.numPages, 60); p++) {
        const tc = await (await pdf.getPage(p)).getTextContent();
        out.push((tc.items || []).map(i => i.str || '').join(' '));
      }
      try { await pdf.destroy(); } catch { /* done anyway */ }
      const text = out.join('\n\n').trim();
      if (!text) throw new Error('No readable text — scanned images or a locked file?');
      return text;
    } catch (e) {
      if (e && /scanned|locked|readable|empty|engine/i.test(e.message || '')) throw e;
      throw new Error('Could not read that PDF (' + ((e && e.message) || 'parse failed') + ').');
    }
  }
  if (/\.docx$/i.test(nm)) {
    let buf = null;
    try { buf = await f.arrayBuffer(); } catch (e) { throw new Error('Could not read that file from disk (browser blocked it).'); }
    if (!buf || !buf.byteLength) throw new Error('That file looks empty (0 bytes) — it may be a cloud placeholder. Open it in Word/Drive once, then re-save / download a copy.');
    // Primary: mammoth (best fidelity: headers, footnotes, tables).
    try {
      const m = await import('https://esm.sh/mammoth@1.9.1/mammoth.browser');
      const lib = m.default || m;
      const res = await lib.extractRawText({ arrayBuffer: buf.slice(0) });
      const text = String((res && res.value) || '').trim();
      if (text) return text;
      // empty from mammoth -> fall through to raw-XML fallback below
    } catch (e) {
      if (e && /readable/i.test(e.message || '')) {
        // mammoth read it but found no text — still try raw fallback before giving up
      } else {
        console.warn('mammoth failed, trying raw docx fallback', (e && e.message) || e);
      }
    }
    // Fallback: raw word/document.xml text (no CDN fidelity, but works offline /
    // when mammoth is blocked). A .docx is a zip: pull every w:t node.
    try {
      const fflate = await import('https://esm.sh/fflate@0.8.2');
      const unzip = fflate.unzipSync || (fflate.default || {}).unzipSync;
      if (!unzip) throw new Error('Archive engine did not load.');
      const files = unzip(new Uint8Array(buf));
      const docKeys = Object.keys(files).filter(k => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\w*\.xml$/.test(k));
      if (!docKeys.length) throw new Error('Not a Word file inside (no word/document.xml). Is it encrypted / password-protected?');
      const dec = new TextDecoder();
      const parts = [];
      // document first, then headers/footers/notes
      docKeys.sort((a, b) => (a.includes('document') ? -1 : 0) - (b.includes('document') ? -1 : 0));
      for (const k of docKeys.slice(0, 8)) {
        let xml = null;
        try { xml = new DOMParser().parseFromString(dec.decode(files[k]), 'application/xml'); } catch { continue; }
        if (!xml || xml.querySelector('parsererror')) continue;
        const texts = [...xml.getElementsByTagNameNS('*', 't')].map(el => el.textContent || '');
        const chunk = texts.join(' ').replace(/\s+/g, ' ').trim();
        if (chunk) parts.push(chunk);
      }
      const text = parts.join('\n\n').trim();
      if (text) return text;
      throw new Error('No readable text in that document (images only? encrypted?).');
    } catch (e2) {
      if (e2 && /readable|encrypted|password|Not a Word/i.test(e2.message || '')) throw e2;
      throw new Error('Could not read that Word file (' + ((e2 && e2.message) || OFFICE_MSG) + ').');
    }
  }
  if (/\.xlsx?$/i.test(nm)) {
    try {
      const m = await import('https://esm.sh/xlsx@0.18.5');
      const XLSX = m.default || m;
      if (!XLSX.read) throw new Error('Spreadsheet engine did not load.');
      const wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: 'array' });
      const parts = [];
      for (const name of (wb.SheetNames || []).slice(0, 20)) {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
        if (csv && csv.trim()) parts.push('# Sheet: ' + name + '\n\n' + csv.trim());
      }
      const text = parts.join('\n\n').trim();
      if (!text) throw new Error('No readable data in any sheet.');
      return text;
    } catch (e) {
      if (e && /readable|sheet/i.test(e.message || '')) throw e;
      throw new Error('Could not read that spreadsheet (' + ((e && e.message) || OFFICE_MSG) + ').');
    }
  }
  if (/\.pptx$/i.test(nm)) {
    try {
      const fflate = await import('https://esm.sh/fflate@0.8.2');
      const unzip = fflate.unzipSync || (fflate.default || {}).unzipSync;
      if (!unzip) throw new Error('Archive engine did not load.');
      const files = unzip(new Uint8Array(await f.arrayBuffer()));
      const slides = Object.keys(files).filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k))
        .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)).slice(0, 100);
      if (!slides.length) throw new Error('No slides found in that file.');
      const dec = new TextDecoder();
      const parts = [];
      slides.forEach((k, i) => {
        const xml = new DOMParser().parseFromString(dec.decode(files[k]), 'application/xml');
        if (xml.querySelector('parsererror')) return; // skip one corrupt slide
        const texts = [...xml.getElementsByTagNameNS('*', 't')].map(el => el.textContent || '');
        if (texts.join(' ').trim()) parts.push('# Slide ' + (i + 1) + '\n\n' + texts.join(' ').trim());
      });
      const text = parts.join('\n\n').trim();
      if (!text) throw new Error('No readable text on any slide.');
      return text;
    } catch (e) {
      if (e && /slide|readable/i.test(e.message || '')) throw e;
      throw new Error('Could not read those slides (' + ((e && e.message) || OFFICE_MSG) + ').');
    }
  }
  if (/\.doc$/i.test(nm)) throw new Error('Legacy .doc — re-save it as .docx in Word, then import that.');
  if (/\.ppt$/i.test(nm)) throw new Error('Legacy .ppt — re-save it as .pptx in PowerPoint, then import that.');
  return await f.text();
}

async function ingestFiles(files, ctx) {
  const arr = [...(files || [])];
  if (!arr.length) {
    console.warn('ingestFiles: empty file list', ctx || '');
    const where = ctx && ctx.where ? ' (' + ctx.where + ')' : '';
    const types = ctx && ctx.types && ctx.types.length ? ' — drop carried [' + ctx.types.join(', ') + '], no file bytes' : '';
    toast('Nothing was dropped' + where + types + ' — use the Files button and pick the .docx from disk', 6500);
    return;
  }
  const list = arr.filter(intakeAllowed);
  const skipped = arr.filter(f => !intakeAllowed(f));
  if (skipped.length) console.warn('intake skipped', skipped.map(f => ({ name: (f && f.name) || '(unnamed)', type: (f && f.type) || '' })));
  if (!list.length) {
    const shown = skipped.slice(0, 3).map(f => '"' + cleanName(f) + '" ' + extOf(cleanName(f))).join(' \u00B7 ');
    const more = skipped.length > 3 ? ' (+' + (skipped.length - 3) + ' more)' : '';
    const hint = skipped.some(f => /\.(zip|rar|7z|pages|numbers|key|odt|ods|odp|rtf)$/i.test(cleanName(f)))
      ? ' \u2014 that looks like an archive/iWork/OpenDocument file: unzip or export it first (.docx/.pdf/.md)'
      : '';
    toast('No documents found \u2014 skipped ' + skipped.length + ' file' + (skipped.length === 1 ? '' : 's') + ': ' + shown + more + hint + ' (' + INTAKE_LABEL + ')', 7000);
    return;
  }
  let n = 0;
  const errs = [];
  const newIds = [];
  let dupes = 0;
  const seen = new Set(vault.docs.map(d => d.text.replace(/\s+/g, ' ').trim()));
  const intakeRec = { at: new Date().toISOString(), total: arr.length, allowed: list.length, skipped: skipped.length, files: [] };
  try { window.__gravitas.lastIntake = intakeRec; } catch {}
  for (const f of list.slice(0, 60)) {
    const rec = { name: cleanName(f), type: (f && f.type) || '', size: (f && typeof f.size === 'number') ? f.size : null, status: 'pending' };
    intakeRec.files.push(rec);
    try {
      toast('Reading ' + cleanName(f) + '\u2026');
      if (rec.size === 0) throw new Error('That file looks empty (0 bytes) — it may be a cloud placeholder. Open it once, then download a fresh copy.');
      const text = (await readFileAsText(f)).slice(0, 60000);
      rec.textLen = text.length;
      const key = text.replace(/\s+/g, ' ').trim();
      if (seen.has(key)) { dupes++; continue; } // same bytes as something already here
      seen.add(key);
      const cn = cleanName(f);
      const d = vault.addFile(cn.replace(/\.(markdown)$/i, '.md'), '# ' + cn.replace(/\.[^.]+$/, '') + '\n\n' + text);
      newIds.push(d.id);
      n++;
      rec.status = 'ok'; rec.docId = d.id;
    } catch (e) { const msg = ((e && e.message) || String(e)); errs.push(cleanName(f) + ': ' + msg); rec.status = 'error'; rec.error = msg; console.warn('import failed', cleanName(f), e); }
  }
  rebuild(activeId);
  // newly arrived bodies become the center of attention: focus the first one so
  // it glides to the origin as the sun (orphans otherwise drift far out of view)
  if (newIds.length && uni.focus(newIds[0])) { claimSun(newIds[0]); renderDoc(); }
  const firstName = newIds.length ? vault.titleOf(vault.byId(newIds[0])) : '';
  const dupeNote = dupes ? ' \u00B7 ' + dupes + ' duplicate' + (dupes === 1 ? '' : 's') + ' already here' : '';
  const skipNote = skipped.length ? ' \u00B7 ' + skipped.length + ' skipped (not a document)' : '';
  const finalMsg = n ? (n === 1 ? '\u201C' + firstName + '\u201D captured \u2014 now the sun' + dupeNote + skipNote : n + ' documents captured \u2014 \u201C' + firstName + '\u201D is now the sun' + dupeNote + skipNote)
    : (dupes ? 'Nothing new \u2014 ' + dupes + ' duplicate' + (dupes === 1 ? '' : 's') + ' already in the universe' : (errs.length ? 'Nothing imported \u2014 ' + errs[0] : 'Nothing imported'));
  intakeRec.toast = finalMsg; intakeRec.imported = n; intakeRec.errors = errs.slice(0, 5);
  setLog(finalMsg);
  if (n) toast(finalMsg);
  else toast(finalMsg, errs.length || dupes ? 8000 : 2400);
}

async function collectDirRecursive(dir, out, skipped, depth) {
  depth = depth || 0;
  if (depth > 4 || out.length >= 60) return;
  for await (const entry of dir.values()) {
    if (out.length >= 60) break;
    try {
      if (entry.kind === 'file') {
        let f = null;
        try { f = await entry.getFile(); } catch { continue; }
        if (intakeAllowed(f)) out.push(f);
        else skipped.push(entry.name || cleanName(f));
      } else if (entry.kind === 'directory') {
        await collectDirRecursive(entry, out, skipped, depth + 1);
      }
    } catch { /* keep scanning the rest */ }
  }
}

// Dropping a FOLDER yields zero entries in e.dataTransfer.files on most
// browsers — the files live behind DataTransferItems. Walk those so a
// dropped folder of .docx files actually imports (recursively, capped).
async function getDropFiles(dt) {
  const items = dt && dt.items ? [...dt.items] : [];
  const hasEntries = items.some(it => (it && (it.webkitGetAsEntry || it.getAsEntry || it.getAsFileSystemHandle)));
  if (!hasEntries) {
    // No entry APIs (rare): still honor plain file items, then files.
    const viaItems = [];
    for (const it of items) { try { const f = it.getAsFile && it.getAsFile(); if (f) viaItems.push(f); } catch {} }
    if (viaItems.length) return viaItems;
    return dt && dt.files ? [...dt.files] : [];
  }
  const out = [];
  const walkEntry = (entry) => new Promise((resolve) => {
    if (!entry) return resolve();
    try {
      if (entry.isFile) {
        entry.file((f) => { if (f) out.push(f); resolve(); }, () => resolve());
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readAll = () => {
          reader.readEntries(async (batch) => {
            if (!batch.length) return resolve();
            for (const b of batch) await walkEntry(b);
            if (out.length >= 60) return resolve();
            readAll();
          }, () => resolve());
        };
        readAll();
      } else resolve();
    } catch { resolve(); }
  });
  for (const it of items) {
    if (out.length >= 60) break;
    try {
      if (it.getAsFileSystemHandle) {
        const h = await it.getAsFileSystemHandle().catch(() => null);
        if (h && h.kind === 'file') {
          const f = await h.getFile().catch(() => null);
          if (f) out.push(f);
          continue;
        }
        if (h && h.kind === 'directory') {
          const tmp = [], sk = [];
          await collectDirRecursive(h, tmp, sk).catch(() => {});
          for (const f of tmp) out.push(f);
          continue;
        }
      }
      const fn = it.webkitGetAsEntry || it.getAsEntry;
      const entry = fn ? fn.call(it) : null;
      if (entry) await walkEntry(entry);
      else { const f = it.getAsFile && it.getAsFile(); if (f) out.push(f); }
    } catch { /* next item */ }
  }
  if (out.length) return out;
  return dt && dt.files ? [...dt.files] : [];
}

async function pickFolder() {
  setLog('Waiting for folder selection…');
  try {
    // No File System Access API (Firefox/Safari/iOS) -> hidden webkitdirectory
    // picker, which still recurses into subfolders natively.
    if (!window.showDirectoryPicker) {
      const fi = document.querySelector('#folderInput');
      if (fi) { fi.click(); return; }
      document.querySelector('#fileInput').click(); return;
    }
    const dir = await window.showDirectoryPicker();
    const files = [], skipped = [];
    await collectDirRecursive(dir, files, skipped);
    if (!files.length) {
      if (skipped.length) {
        const shown = skipped.slice(0, 3).map(s => '"' + s + '" ' + extOf(s)).join(' \u00B7 ');
        toast('No documents in that folder \u2014 ' + skipped.length + ' file' + (skipped.length === 1 ? '' : 's') + ' skipped (' + shown + '). Looking for ' + INTAKE_LABEL, 7000);
      } else toast('No documents in that folder (subfolders included) \u2014 looking for ' + INTAKE_LABEL, 5000);
      return;
    }
    await ingestFiles(files);
  } catch (e) {
    if (e?.name === 'AbortError') { setLog('Folder selection cancelled — no files chosen'); return; }
    // Real picker missing/blocked -> legacy folder input (also gives its own waiting state)
    try {
      const fi = document.querySelector('#folderInput');
      if (fi) { setLog('Waiting for folder selection…'); fi.click(); }
      else document.querySelector('#fileInput').click();
    } catch { setLog('Folder picker blocked — use the Files button instead'); }
  }
}

// ---------- main loop ----------
function loop() {
  cancelAnimationFrame(raf);
  lastReal = performance.now();
  const tick = () => {
    const nowReal = performance.now();
    const dtReal = Math.min(0.1, Math.max(0, (nowReal - lastReal) / 1000));
    lastReal = nowReal;
    if (rotOn && rotMul > 0) {
      const s = rotMul;
      const sims = [];
      for (const t of vault.tabs) { // every canvas simulates, so twins share one motion
        const u = unis.get(t.id);
        if (u) sims.push(u);
      }
      if (lensThematic) { // the live thematic recomposition simulates too (same mechanics)
        const tu = thematicUniFor(vault.activeTabId);
        if (tu && !sims.includes(tu)) sims.push(tu);
      }
      for (const u of sims) {
        if (autoDist && u === uni) continue; // pinned orb: the drawn canvas holds still while the others keep simulating
        const baseDt = u.dt || 0.3;
        if (s <= 1.2) u.step(baseDt * s);
        else { const sub = 2; for (let i = 0; i < sub; i++) u.step(baseDt * s / sub); }
      }
      entangleSync(); // quantum lock across canvases
      if (ren.cam.auto) ren.cam.yaw += ROT_BASE * s;
      virtT += dtReal * s;
    }
    if (autoDist && uni) layoutOrb(uni); // pinned fit-to-canvas orb overrides orbital motion
    let noteMarks = null; // body id -> 'full' (has note) | 'empty' (sun placeholder)
    if (viewNotesAll || viewNotesSun) {
      noteMarks = new Map();
      // All: solid squares, only on bodies that actually have notes — never placeholders
      if (viewNotesAll) for (const d of vault.docs) if (typeof d.note === 'string' && d.note) noteMarks.set(d.id, 'full');
      // Active body: the selected body always gets its square — solid when noted, hollow frame when not
      if (viewNotesSun && activeId && vault.byId(activeId) && !noteMarks.has(activeId)) noteMarks.set(activeId, 'empty');
    }
    ren.draw(uni, { match: matchSet, now: virtT, noteMarks });
    if ((tick.n = (tick.n || 0) + 1) % 20 === 0) updateStats();
    raf = requestAnimationFrame(tick);
  };
  tick();
}

// ---------- boot ----------
function boot() {
  ren = new Renderer($('#uniCv'));
  ren.selSet = selSet; // selection rings follow the box-select set live
  activeId = (vault.tab() && vault.tab().activeId === null && vault.docs.length) ? null : (vault.tab().activeId || vault.docs[0]?.id || null);
  rebuild(activeId);
  loop();
  // "?" explicators: show stored wording, gate ✎ buttons to the editor (never desktop)
  try {
    if (helpEditAllowed()) document.body.classList.add('help-can-edit');
    applyHelpToStatic();
    // renderDoc() ran inside rebuild() before the class existed — re-render so its
    // popups pick up stored wording too (cheap, keeps all four in sync).
    renderDoc(); applyHelpToStatic();
  } catch {}
  { const hs = $('#helpSaveBtn'); if (hs) hs.onclick = () => saveHelpEditor(false); }
  { const hr = $('#helpResetBtn'); if (hr) hr.onclick = () => saveHelpEditor(true); }
  { const hc = $('#helpCancelBtn'); if (hc) hc.onclick = closeHelpEditor; }

  // camera: drag empty space = pan \u00B7 press-drag a body = rotate \u00B7 click body = focus \u00B7 dblclick = refit
  const cv = $('#uniCv');
  cv.style.touchAction = 'none'; // single-finger drag must reach us on touch screens
  let downAt = 0, moved = false, lx = 0, ly = 0, downX = 0, downY = 0;
  let dragMode = null, downNode = null; // 'pan' | 'rotate' | 'select'
  // marquee box-select rectangle (plain fixed div = pixel-crisp 1px edges)
  const marquee = document.createElement('div');
  marquee.id = 'marquee'; marquee.hidden = true;
  document.body.appendChild(marquee);
  const endDrag = (e) => {
    if (e && e.isPrimary === false) return;
    if (dragMode === 'select') {
      marquee.hidden = true;
      if (moved && e) {
        // commit the box: shift still held = add to selection, else replace it
        const r = cv.getBoundingClientRect();
        const x0 = Math.min(downX, e.clientX) - r.left, x1 = Math.max(downX, e.clientX) - r.left;
        const y0 = Math.min(downY, e.clientY) - r.top, y1 = Math.max(downY, e.clientY) - r.top;
        if (!e.shiftKey) selSet.clear();
        for (const n of uni.nodes) {
          const p = n._p;
          // doc bodies only — thematic theme-bodies can't be deleted, so skip them
          if (p && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && vault.byId(n.id)) selSet.add(n.id);
        }
        toast(selSet.size ? `${selSet.size} selected — right-click to delete` : 'Nothing in the box');
      } else if (e) {
        // shift+click without a drag: toggle the one body under the cursor
        const r = cv.getBoundingClientRect();
        const n = ren.pick(uni.nodes, e.clientX - r.left, e.clientY - r.top);
        if (n && vault.byId(n.id)) {
          if (selSet.has(n.id)) selSet.delete(n.id); else selSet.add(n.id);
        }
      }
      dragMode = null; downNode = null;
      cv.style.cursor = 'grab';
      setTimeout(() => { ren.cam.auto = true; }, 6000); // resume the slow gyre
      return;
    }
    const quick = performance.now() - downAt < 500;
    if (!moved && quick) {
      const r = cv.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const n = ren.pick(uni.nodes, sx, sy);
      // sticky-note square first: it opens the note editor without moving the sun
      const noteId = (viewNotesAll || viewNotesSun) ? ren.noteHit(sx, sy) : null;
      if (noteId && vault.byId(noteId)) { openNoteEditor(noteId, e.clientX, e.clientY); }
      else if (n && uni.focus(n.id)) {
        claimSun(n.id);
        renderDoc();
        const nd = vault.byId(n.id);
        toast((nd ? vault.titleOf(nd) : n.label) + ' is now the sun');
      } else if (!n) {
        // off-click into empty space: drop the box selection AND the sun — no
        // active body, so the canvas center becomes the gravitational center.
        if (selSet.size) selSet.clear();
        if (defocusSun()) toast('General view — no active body; the canvas center holds gravity');
      }
    }
    dragMode = null; downNode = null;
    cv.style.cursor = 'grab';
    setTimeout(() => { ren.cam.auto = true; }, 6000); // resume the slow gyre
  };
  cv.addEventListener('pointerdown', (e) => {
    if (e.isPrimary === false) return;
    if (e.shiftKey && e.button === 0) {
      // shift+left-drag = marquee box-select (plain drag still pans, body-drag still rotates)
      dragMode = 'select';
      downNode = null;
      downAt = performance.now(); moved = false;
      lx = downX = e.clientX; ly = downY = e.clientY;
      ren.cam.auto = false;
      cv.style.cursor = 'crosshair';
      marquee.style.left = e.clientX + 'px'; marquee.style.top = e.clientY + 'px';
      marquee.style.width = '0px'; marquee.style.height = '0px';
      marquee.hidden = true; // stays hidden until the box passes the click threshold
      try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      return;
    }
    const r = cv.getBoundingClientRect();
    downNode = ren.pick(uni.nodes, e.clientX - r.left, e.clientY - r.top) || null;
    dragMode = null;
    downAt = performance.now(); moved = false;
    lx = downX = e.clientX; ly = downY = e.clientY;
    cv.style.cursor = downNode ? 'pointer' : 'grab';
    try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
  });
  cv.addEventListener('pointermove', (e) => {
    if (e.isPrimary === false) return;
    if (e.buttons) {
      if (dragMode === 'select') {
        // stretch the box; only counts as a drag past the click threshold
        if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) moved = true;
        marquee.hidden = !moved;
        marquee.style.left = Math.min(downX, e.clientX) + 'px';
        marquee.style.top = Math.min(downY, e.clientY) + 'px';
        marquee.style.width = Math.abs(e.clientX - downX) + 'px';
        marquee.style.height = Math.abs(e.clientY - downY) + 'px';
        lx = e.clientX; ly = e.clientY;
        return;
      }
      const dx = e.clientX - lx, dy = e.clientY - ly;
      if (!moved && Math.hypot(e.clientX - downX, e.clientY - downY) > 4) {
        moved = true;
        dragMode = downNode ? 'rotate' : 'pan';
        ren.cam.auto = false;
        cv.style.cursor = dragMode === 'pan' ? 'grabbing' : 'move';
      }
      if (moved) {
        if (dragMode === 'pan') {
          ren.cam.px = Math.max(-2500, Math.min(2500, (ren.cam.px || 0) + dx));
          ren.cam.py = Math.max(-2500, Math.min(2500, (ren.cam.py || 0) + dy));
        } else {
          ren.cam.yaw += dx * 0.005;
          ren.cam.pitch = Math.max(-1.2, Math.min(1.2, ren.cam.pitch + dy * 0.004));
        }
        lx = e.clientX; ly = e.clientY;
      }
    } else {
      const r = cv.getBoundingClientRect();
      ren.hover = ren.pick(uni.nodes, e.clientX - r.left, e.clientY - r.top);
      cv.style.cursor = ren.hover ? 'pointer' : 'grab';
    }
  });
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', () => { dragMode = null; downNode = null; marquee.hidden = true; cv.style.cursor = 'grab'; });
  cv.addEventListener('dblclick', () => ren.resetView());
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    ren.cam.dist = Math.min(1400, Math.max(220, ren.cam.dist * (e.deltaY > 0 ? 1.1 : 0.9)));
  }, { passive: false });

  // panels
  const inp = $('#searchInput');
  inp.addEventListener('input', () => {
    const raw = inp.value.trim().toLowerCase();
    const q = raw.startsWith('#') ? raw.slice(1).trim() : raw;
    const pop = $('#searchPop');
    if (!q) { pop.innerHTML = ''; matchSet = null; return; }
    const hits = vault.search(q);
    matchSet = new Set(hits.map(h => h.doc.id));
    let themeRows = '';
    if (lensThematic) { // thematic-only universe: light up themes grounding the hits
      const themes = thematicWhole ? wholeThemes : (thematicThemes.get(vault.activeTabId) || []);
      for (const th of themes) {
        if (th.members.some(id => matchSet.has(id))) matchSet.add(th.id);
      }
      // ...and surface the themes themselves: they ARE this universe's bodies,
      // so a term pill click lands on the theme it helped distill, not just docs
      themeRows = themes
        .filter(th => th.label.toLowerCase().includes(q) || th.terms.some(t => t.includes(q) || q.includes(t)))
        .map(th => `<button data-open="${th.id}"><b>◈ ${esc(th.label)}</b><span>theme · grounds ${th.members.length} ${th.members.length === 1 ? 'body' : 'bodies'}</span></button>`).join('');
    }
    const docRows = hits.map(({ doc }) =>
      `<button data-open="${doc.id}"><b>${esc(vault.titleOf(doc))}</b><span>${esc(doc.name)}</span></button>`).join('');
    pop.innerHTML = (themeRows + docRows)
      || '<div style="font-size:12px;color:var(--mut);padding:6px">No bodies match.</div>';
  });
  document.addEventListener('click', (e) => {
    const cx = e.target.closest('[data-closetab]');
    if (cx) { e.stopPropagation(); closeCanvas(cx.dataset.closetab); return; }
    const at = e.target.closest('[data-addtab]');
    if (at) {
      e.stopPropagation();
      const name = prompt('Name the new canvas:', 'Universe ' + (vault.tabs.length + 1));
      if (name !== null && name.trim()) { const t = vault.createTab(name.trim()); renderTabs(); switchCanvas(t.id); }
      return;
    }
    const tb = e.target.closest('[data-tab]');
    if (tb) { switchCanvas(tb.dataset.tab); return; }
    const o = e.target.closest('[data-open]');
    if (o) {
      const key = o.dataset.open;
      // whole-docuverse themes can ground bodies from other canvases — jump to
      // whichever canvas holds the doc, leaving the lens first.
      let d = vault.byId(key);
      const wasLens = lensThematic;
      if (!d && key && !String(key).startsWith('theme_')) {
        const ht = vault.tabs.find(t => (t.docs || []).some(x => x.id === key));
        if (ht) {
          d = ht.docs.find(x => x.id === key);
          if (lensThematic) { lensThematic = false; thematicWhole = false; }
          if (ht.id !== vault.activeTabId) switchCanvas(ht.id);
          else applyLens();
          saveUi();
        }
      } else if (d) {
        // drill-down: member docs live in the regular universe — exit the lens first
        if (lensThematic) { lensThematic = false; thematicWhole = false; applyLens(); saveUi(); }
      }
      if (d) {
        if (lensThematic) { lensThematic = false; thematicWhole = false; applyLens(); saveUi(); }
        if (wasLens) toast(`Regular view — “${vault.titleOf(d)}”`);
        claimSun(d.id);
        uni.focus(d.id);
        renderDoc();
        const w2 = document.querySelector('#docShared'); document.querySelectorAll('.help-open').forEach(w => w.classList.remove('open', 'help-open'))
      }
      else if (typeof key === 'string' && key.startsWith('theme_') && uni.byId.has(key) && uni.focus(key)) { claimSun(key); renderDoc(); }
      $('#searchPop').innerHTML = ''; inp.value = ''; matchSet = null;
      if (window.innerWidth <= 760) $('#docPanel').classList.add('open');
      return;
    }
    const he = e.target.closest('[data-help-edit]');
    if (he) { e.stopPropagation(); openHelpEditor(he.dataset.helpEdit); return; }
    const sgh = e.target.closest('[data-sghelp]');
    if (sgh) { const w0 = sgh.closest('.hw, #docMeta') || document.querySelector('#docShared'); if (w0) w0.classList.toggle('help-open'); return; }
    const sgl = e.target.closest('[data-sg]');
    if (sgl) { const w2 = document.querySelector('#docShared'); if (w2) w2.classList.toggle('open'); return; }
    const w = e.target.closest('[data-wl]');
    if (w) {
      const d = vault.byTitle(w.dataset.wl);
      if (d && uni.focus(d.id)) { claimSun(d.id); renderDoc(); }
      else toast(`"${w.dataset.wl}" is uncharted space`);
      return;
    }
    const nb = e.target.closest('[data-notes]');
    if (nb) { openNotePop(nb.dataset.notes); return; }
    const t = e.target.closest('[data-tag]');
    if (t) { inp.value = '#' + t.dataset.tag; inp.dispatchEvent(new Event('input')); }
  });
  $('#folderBtn').onclick = pickFolder;
  $('#fileBtn').onclick = () => { setLog('Waiting for file selection…'); toast('Choose .docx/.pdf/.md files…'); try { $('#fileInput').click(); } catch (e) { setLog('Picker blocked by the browser — try drag-drop instead'); } };
  $('#fileInput').onchange = (e) => {
    const fs = [...(e.target.files || [])]; e.target.value = '';
    if (!fs.length) { setLog('File selection cancelled — no files chosen'); return; }
    setLog('Picked ' + fs.length + ' file' + (fs.length === 1 ? '' : 's') + ' — reading…');
    ingestFiles(fs, { where: 'file-picker' });
  };
  const fi2 = $('#folderInput');
  if (fi2) fi2.onchange = (e) => {
    const fs = [...(e.target.files || [])]; e.target.value = '';
    if (!fs.length) { setLog('Folder selection cancelled — no files chosen'); return; }
    setLog('Picked folder (' + fs.length + ' files) — scanning…');
    ingestFiles(fs, { where: 'folder-picker' });
  };
  document.addEventListener('keydown', (e) => {
    // global "/" focuses search — but never when typing in a field (help editor, rename prompt inputs, etc.)
    if (e.key === '/' && document.activeElement !== inp && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) { e.preventDefault(); inp.focus(); }
  });
  // drag & drop files anywhere — without this, dropping a file navigates the
  // whole page away to the PDF (looks like "nothing happened")
  let dragN = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragN++; document.body.classList.add('dropping'); });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; document.body.classList.remove('dropping'); } });
  window.addEventListener('drop', async (e) => {
    e.preventDefault(); dragN = 0; document.body.classList.remove('dropping');
    const dt = e.dataTransfer;
    if (!dt) return;
    const types = dt.types ? [...dt.types] : [];
    const itemsDbg = dt.items ? [...dt.items].map(it => (it.kind || '?') + ':' + (it.type || '?')) : [];
    try {
      const fs = await getDropFiles(dt);
      const allFs = (fs && fs.length) ? fs : (dt.files && dt.files.length ? [...dt.files] : []);
      if (allFs.length) {
        // a dropped master file (*.json that parses as a backup) offers to
        // LOAD instead of importing as a document — dropping the file you
        // just downloaded is the most discoverable restore path.
        if (allFs.length === 1 && /\.json$/i.test((allFs[0].name || ''))) {
          try {
            const txt = await allFs[0].text();
            const jo = JSON.parse(txt);
            const isBackup = (jo && (jo.app === 'docuverse-backup' || jo.app === 'gravitas-backup')) ||
              (jo && typeof jo === 'object' && (Array.isArray(jo.tabs) || Array.isArray(jo.vault) || Array.isArray(jo.docs) || Array.isArray(jo.documents)));
            if (isBackup) {
              const n = (() => { try {
                if (Array.isArray(jo.tabs)) { let c = 0; for (const t of jo.tabs) if (t && Array.isArray(t.docs)) c += t.docs.length; return c; }
                const v = jo.vault || jo.docs || jo.documents; return Array.isArray(v) ? v.length : 0;
              } catch { return 0; } })();
              if (await confirmDlg(`Load dropped master file with ${n} documents? This replaces the current universe.`, 'Load file')) {
                if (typeof applyBackupObject === 'function' && applyBackupObject(jo)) {
                  try { renderCloudBox(); } catch {}
                  try {
                    const info = window.__gravitas.lastLoadInfo;
                    if (info && info.identical) toast(`Backup matches the open universe — nothing changed (${n} documents)`);
                    else if (info) toast(`DocuVerse master file loaded — ${info.before} → ${info.after} bodies`);
                    else toast(`DocuVerse master file loaded — ${n} documents`);
                  } catch { toast(`DocuVerse master file loaded — ${n} documents`); }
                }
              }
              return;
            }
          } catch { /* not a backup — fall through to normal intake below */ }
        }
        ingestFiles(allFs, { where: 'drop' }); return;
      }
      // No file bytes. Common sources: Gmail/Outlook/Drive web drags (links only),
      // desktop-Outlook FileGroupDescriptor, or cloud placeholders.
      console.warn('drop had no files', { types, itemsDbg });
      let detail = '';
      try {
        if (types.includes('Files') && dt.items && dt.items.length) {
          detail = ' — the browser blocked file access (items: ' + itemsDbg.slice(0, 4).join(', ') + ')';
        } else if (types.some(x => /FileGroupDescriptor|FileContents|chromium-x-ad|ms-/.test(x))) {
          detail = ' — that looks like a desktop-mail drag (Outlook FileGroupDescriptor): save the attachment to disk first';
        } else if (types.includes('text/uri-list') || types.includes('text/html')) {
          let s = '';
          try { s = dt.getData('text/uri-list') || dt.getData('text/plain') || ''; } catch {}
          s = String(s).slice(0, 120);
          detail = s ? ' — that drop was a link, not a file (' + s + (String(s).length >= 120 ? '…' : '') + '): download it first' : ' — that drop was a link/text, not a file: download it first';
        } else if (types.length) {
          detail = ' — drop carried [' + types.slice(0, 5).join(', ') + '], no file bytes';
        }
      } catch {}
      setLog('Nothing was dropped' + detail); toast('Nothing was dropped' + detail + ' — use the Files button and pick the .docx from disk', 8000);
    } catch (err) {
      console.warn('drop read failed', err);
      if (dt.files && dt.files.length) ingestFiles([...dt.files], { where: 'drop-retry' });
      else toast('Nothing was dropped (drop read failed) — use the Files button', 6500);
    }
  });
  // ---------- right-click context menu (Explorer-style, per body) ----------
  const ctx = $('#ctxMenu');
  function closeCtx() { ctx.hidden = true; }
  function ctxItem(label, danger, fn) {
    const b = document.createElement('button');
    b.className = 'ctx-item' + (danger ? ' danger' : '');
    b.textContent = label;
    b.onclick = (e) => { e.stopPropagation(); closeCtx(); fn(); };
    return b;
  }
  function showProps(id) {
    const d = vault.byId(id);
    if (!d) return;
    const m = uni.byId.get(id);
    const neigh = (edgeInfo || []).filter(e => e.source === id || e.target === id).length;
    $('#propsTitle').textContent = vault.titleOf(d);
    $('#propsBody').innerHTML = [
      ['File', d.name], ['Words', d.words], ['Mass', m ? (m.trueMass ?? m.mass).toFixed(1) : '—'],
      ['Outgoing refs', d.links.length], ['Tethers', neigh],
      ['Tags', d.tags.join(', ') || '—'],
      ['Added body', d.id],
    ].map(([k, v]) => `<div class="pr"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
    $('#propsModal').hidden = false;
  }
  function showThemeProps(th) {
    const m = uni.byId.get(th.id);
    $('#propsTitle').textContent = '◈ ' + th.label;
    $('#propsBody').innerHTML = [
      ['Kind', 'Distilled theme (thematic lens)'],
      ['Thematic weight', th.weight.toFixed(1)], ['Mass', m ? (m.trueMass ?? m.mass).toFixed(1) : th.mass.toFixed(1)],
      ['Concepts', th.terms.join(', ')],
      ['Grounded bodies', String(th.members.length)],
      ['Theme body', th.id],
    ].map(([k, v]) => `<div class="pr"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
    $('#propsModal').hidden = false;
  }
  function focusBody(id) {
    if (uni.focus(id)) { claimSun(id); renderDoc(); const d = vault.byId(id); toast(`${d ? vault.titleOf(d) : uni.byId.get(id).label} is now the sun`); }
  }
  function openCtx(x, y, id) {
    ctx.innerHTML = '';
    if (selSet.size > 0 && (!id || selSet.has(id))) {
      // box-selection menu: bulk-delete this tab's bodies + docs, or the whole tab universe
      const t = vault.tab();
      const inTab = t ? [...selSet].filter(sid => t.docs.some(d => d.id === sid)) : [];
      const head = document.createElement('div');
      head.className = 'ctx-head';
      head.textContent = `▦ ${inTab.length} selected`;
      ctx.appendChild(head);
      if (inTab.length) ctx.appendChild(ctxItem(`✕  Delete ${inTab.length} selected + ${inTab.length === 1 ? 'doc' : 'docs'} (this tab only)`, true, () => removeIdsFromCanvas(inTab)));
      ctx.appendChild(ctxItem(`✕  Delete entire “${t ? t.name : 'canvas'}” universe (${t ? t.docs.length : 0}) + docs`, true, () => removeUniverseFromCanvas()));
      ctx.appendChild(ctxItem('Clear selection', false, () => { selSet.clear(); }));
      ctx.hidden = false;
      const w = Math.min(280, ctx.offsetWidth || 220), h = ctx.offsetHeight || 200;
      ctx.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
      ctx.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
      return;
    }
    if (id) {
      const th = themeById(id);
      if (th) { // derived theme body: properties only — nothing to copy/rename/remove
        const head = document.createElement('div');
        head.className = 'ctx-head';
        head.textContent = '◈ ' + th.label;
        ctx.appendChild(head);
        ctx.appendChild(ctxItem('ℹ  Properties', false, () => showThemeProps(th)));
        ctx.hidden = false;
        const w = Math.min(280, ctx.offsetWidth || 220), h = ctx.offsetHeight || 200;
        ctx.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
        ctx.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
        return;
      }
      const d = vault.byId(id);
      if (!d) return;
      const head = document.createElement('div');
      head.className = 'ctx-head';
      head.textContent = '◉ ' + vault.titleOf(d);
      ctx.appendChild(head);
      ctx.appendChild(ctxItem('☉  Make sun (open)', false, () => focusBody(id)));
      ctx.appendChild(ctxItem('✎  Rename…', false, () => {
        const cur = vault.titleOf(d);
        const next = prompt('Rename body:', cur);
        if (next !== null && next.trim() && next.trim() !== cur) {
          vault.rename(id, next.trim());
          rebuild(activeId);
          toast(`Renamed to “${vault.titleOf(vault.byId(id))}”`);
        }
      }));
      ctx.appendChild(ctxItem('🗒  Sticky note…', false, () => openNoteEditor(id, x, y)));
      ctx.appendChild(ctxItem('⧉  Copy text', false, async () => {
        try { await navigator.clipboard.writeText(d.text); toast('Body text copied'); }
        catch { toast('Copy blocked by the browser'); }
      }));
      ctx.appendChild(ctxItem('⤓  Download file', false, () => {
        const blob = new Blob([d.text], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = d.name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        toast(`Downloading ${d.name}`);
      }));
      // transfer the local constellation to another canvas (copies, never moves).
      // Solo = just this body; constellation = this body + its shared-ground web
      // (the exact set the SHARED GROUND menu shows — hover the item to preview it).
      const neighbours = new Set();
      for (const e of edgeInfo) {
        if (e.kind !== 'topic') continue;
        if (e.source === id) neighbours.add(e.target);
        else if (e.target === id) neighbours.add(e.source);
      }
      neighbours.delete(id);
      // preview data: name + the shared vocabulary that forged each tether, so the
      // copy set is auditable (same topic edges the SHARED GROUND menu shows)
      const neighPrev = [];
      {
        const seenP = new Set();
        for (const e of edgeInfo) {
          if (e.kind !== 'topic') continue;
          let oid = null;
          if (e.source === id) oid = e.target;
          else if (e.target === id) oid = e.source;
          else continue;
          if (!neighbours.has(oid) || seenP.has(oid)) continue;
          seenP.add(oid);
          const o = vault.byId(oid);
          if (o) neighPrev.push({ id: oid, name: vault.titleOf(o), terms: (e.topics || []).slice(0, 3) });
        }
      }
      if (vault.tab() && vault.scopeTabs().length <= 1) ctx.appendChild(ctxItem('⧉ Copying is off in this isolated verse', false, () => toast('Associate this canvas with another verse (right-click its tab) to copy bodies out')));
      for (const ot of vault.scopeTabs().filter(x => x.id !== vault.activeTabId).slice(0, 8)) {
        // shared post-copy handling: the transferred sun becomes the destination's
        // sun (when it traveled — otherwise the canvas keeps its own). This runs
        // even when every body was already there (zero new copies): the counts may
        // not change, but the center still moves — otherwise the canvas sun and
        // the reader disagree. Then fold newcomers into an existing destination
        // universe (formation holds) or invalidate its edge cache for first visit.
        const afterCopy = (r, sunIdOrNull) => {
          if (!r) { toast('Copy failed'); return; }
          if (sunIdOrNull) {
            const src = vault.byId(sunIdOrNull);
            const dest = vault.tabs.find(t => t.id === ot.id);
            if (src && dest) {
              const root = src.origin || src.id;
              const sunCopy = dest.docs.find(x => x.id === root || x.origin === root);
              if (sunCopy) dest.activeId = sunCopy.id;
            }
          }
          if (r.copied.length) {
            if (unis.has(ot.id)) rebuildTab(ot.id);
            else edgeByTab.delete(ot.id);
            renderTabs(); toast(`Copied ${r.copied.length} ${r.copied.length === 1 ? 'body' : 'bodies'} to ${ot.name}${r.skipped ? ` (${r.skipped} already there)` : ''}`);
          }
          else {
            // nothing new, but the center may have moved: re-seat the existing
            // universe on the new sun so canvas and reader stay glued together
            if (unis.has(ot.id)) rebuildTab(ot.id);
            else edgeByTab.delete(ot.id);
            renderTabs(); toast(`Everything is already in ${ot.name}`);
          }
        };
        if (neighPrev.length) {
          const soloBtn = ctxItem(`⤉  Copy only this body to “${ot.name}”`, false, () => afterCopy(vault.sendCopyTo(id, ot.id, true), id));
          soloBtn.title = vault.titleOf(d);
          ctx.appendChild(soloBtn);
          // constellation goes through the picker: every proposed body listed with
          // its shared-vocabulary receipt, user unchecks whatever shouldn't travel
          const conBtn = ctxItem(`⤓  Copy constellation (${1 + neighPrev.length}) to “${ot.name}”`, false, async () => {
            const srcTab = vault.activeTabId;
            const ids = await openPickModal(ot.name, [{ id, name: vault.titleOf(d), terms: [], sun: true }, ...neighPrev]);
            if (!ids) return; // cancelled in the picker
            if (vault.activeTabId !== srcTab) { toast('Copy cancelled — canvas switched underneath'); return; }
            // sun stays the destination's center only if the user kept it selected
            if (ids) afterCopy(vault.copyIdsTo(ot.id, ids), ids.includes(id) ? id : null);
          });
          conBtn.title = 'Pick exactly what travels:\n' + neighPrev.map(p => `• ${p.name}` + (p.terms.length ? `  (via ${p.terms.join(', ')})` : '')).join('\n');
          ctx.appendChild(conBtn);
        } else {
          ctx.appendChild(ctxItem(`⤓  Copy to “${ot.name}”`, false, () => afterCopy(vault.sendCopyTo(id, ot.id, true), id)));
        }
      }
      ctx.appendChild(ctxItem('ℹ  Properties', false, () => showProps(id)));
      const hr = document.createElement('hr');
      ctx.appendChild(hr);
      ctx.appendChild(ctxItem('✕  Remove from this canvas', true, () => removeFromCanvas(id)));
      ctx.appendChild(ctxItem('✕  Delete from entire universe', true, () => deleteEverywhere(id)));
    } else {
      ctx.appendChild(ctxItem('⌂  Reset view', false, () => ren.resetView()));
      ctx.appendChild(ctxItem(rotOn ? '⏸  Pause universe' : '▶  Resume universe', false, () => { setRot(!rotOn); toast(rotOn ? 'Universe resumed' : 'Universe paused'); }));
      ctx.appendChild(ctxItem(`✕  Remove all from this canvas${vault.tab() && vault.tab().docs.length ? ` (${vault.tab().docs.length})` : ''}`, true, () => removeAllFromCanvas()));
    }
    ctx.hidden = false;
    const w = Math.min(280, ctx.offsetWidth || 220), h = ctx.offsetHeight || 200;
    ctx.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    ctx.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
  }
  const setRot = (on) => {
    rotOn = on;
    $('#rotBtn').textContent = rotOn ? '⏸ Pause' : '▶ Resume';
    saveUi();
  };
  cv.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const n = ren.pick(uni.nodes, e.clientX - r.left, e.clientY - r.top);
    if (n && selSet.size && !selSet.has(n.id)) selSet.clear(); // right-click elsewhere: single-body menu instead
    openCtx(e.clientX, e.clientY, n ? n.id : null);
  });
  document.addEventListener('click', (e) => { if (!ctx.hidden && !ctx.contains(e.target)) closeCtx(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeCtx(); selSet.clear(); $('#propsModal').hidden = true; closeHelpEditor(); closeNoteEditor(); closeNotePop(); const w2 = document.querySelector('#docShared'); document.querySelectorAll('.help-open').forEach(w => w.classList.remove('open', 'help-open')) }
    if ((e.key === ' ' || e.code === 'Space') && !/INPUT|TEXTAREA|BUTTON/.test(document.activeElement?.tagName || '')) {
      e.preventDefault(); setRot(!rotOn); toast(rotOn ? 'Universe resumed' : 'Universe paused');
    }
  });
  $('#propsClose').onclick = () => { $('#propsModal').hidden = true; };
  // reader-panel removal (same actions as the right-click menu — no right-click needed)
  $('#docRemoveBtn').onclick = () => removeFromCanvas(activeId);
  $('#docDeleteBtn').onclick = () => deleteEverywhere(activeId);
  // universe speed controls: Pause freezes physics + camera + glow; log slider = fine slow-mo
  const rotSlider = $('#rotSpeed');
  rotSlider.value = speedToSlider(rotMul);
  const syncMulLabel = () => { $('#rotMul').textContent = fmtSpeed(rotMul); };
  syncMulLabel();
  rotSlider.addEventListener('input', () => {
    rotMul = sliderToSpeed(rotSlider.value);
    syncMulLabel();
    saveUi();
    if (rotMul === 0 && rotOn) toast('Speed at full stop — raise the slider or hit Pause');
  });
  $('#rotBtn').onclick = () => { setRot(!rotOn); toast(rotOn ? 'Universe resumed' : 'Universe paused'); };
  // body texture overlays: slider = opacity, button = on/off toggle
  ren.overlayAlpha = ovAlpha;
  ren.simpleOrb = simpleOrb;
  ren.stripOverlays = simpleOrb2;
  fetch('src/overlays.json').then(r => r.json()).then(list => ren.loadOverlays(list)).catch(() => {});
  const ovSlider = $('#ovAlpha'), ovLbl = $('#ovMul'), ovBtnEl = $('#ovBtn');
  ovSlider.value = Math.round(ovAlpha * 100);
  const syncOv = () => { ovLbl.textContent = Math.round(ovAlpha * 100) + '%'; ren.overlayAlpha = ovAlpha; saveUi(); };
  ovSlider.addEventListener('input', () => {
    ovAlpha = ovSlider.value / 100;
    if (ovAlpha > 0) ovLast = ovAlpha;
    syncOv();
  });
  // file-name labels: slider = size (far left hides), button = show/hide toggle
  ren.labelScale = lbScale;
  ren.bgShade = bgShade;
  ren.glowScale = glowScale;
  ren.tetherScale = tetherScale;
  const lbSlider = $('#lbSize'), lbLbl = $('#lbMul'), lbBtnEl = $('#lbBtn');
  lbSlider.value = Math.round(lbScale * 100);
  const syncLb = () => { lbLbl.textContent = lbScale <= 0 ? 'hidden' : Math.round(lbScale * 100) + '%'; ren.labelScale = lbScale; saveUi(); };
  lbSlider.addEventListener('input', () => {
    lbScale = lbSlider.value / 100;
    if (lbScale > 0) lbLast = lbScale;
    syncLb();
  });
  lbBtnEl.onclick = () => {
    lbScale = lbScale > 0 ? 0 : (lbLast > 0 ? lbLast : 1);
    lbSlider.value = Math.round(lbScale * 100);
    syncLb();
    toast(lbScale > 0 ? 'Labels on (' + Math.round(lbScale * 100) + '%)' : 'Labels hidden');
  };
  syncLb();
  ovBtnEl.onclick = () => {
    ovAlpha = ovAlpha > 0 ? 0 : (ovLast > 0 ? ovLast : 0.6);
    ovSlider.value = Math.round(ovAlpha * 100);
    syncOv();
    toast(ovAlpha > 0 ? 'Overlay on (' + Math.round(ovAlpha * 100) + '%)' : 'Overlay off');
  };
  syncOv();
  // canvas background shade: slider = white (far left) .. black (far right), button = flip extremes
  const bgSlider = $('#bgShade'), bgLbl = $('#bgMul'), bgBtnEl = $('#bgBtn');
  bgSlider.value = Math.round(bgShade * 100);
  const syncBg = () => { bgLbl.textContent = Math.round(bgShade * 100) + '%'; ren.bgShade = bgShade; syncHintContrast(); syncPaneContrast(); saveUi(); };
  bgSlider.addEventListener('input', () => {
    bgShade = bgSlider.value / 100;
    syncBg();
  });
  bgBtnEl.onclick = () => {
    bgShade = bgShade > 0.5 ? 0 : 1;
    bgSlider.value = Math.round(bgShade * 100);
    syncBg();
    toast(bgShade > 0.5 ? 'Background black' : 'Background white');
  };
  syncBg();
  // halo glow radius: slider 0 (none) .. 50 (current) .. 100 (double), button = on/off toggle
  // canvas backdrop: photo texture behind everything, own opacity row (Overlay-style)
  const BACKDROPS = ['bg01.jpg', 'bg02.jpg', 'bg03.jpg', 'bg04.jpg', 'bg05.jpg', 'bg06.jpg', 'bg07.jpg', 'bg08.jpg', 'bg09.jpg', 'bg10.jpg', 'bg11.jpg', 'bg12.jpg'];
  const backdropImgs = new Map(BACKDROPS.map(f => {
    const im = new Image();
    im.src = 'src/backdrops/' + f;
    return [f, im];
  }));
  const applyBackdrop = () => {
    ren.backdrop = backdropImgs.get(backdrop) || null;
    ren.backdropAlpha = backdropAlpha;
  };
  const bdSlider = $('#bdAlpha'), bdLbl = $('#bdMul'), bdBtnEl = $('#bdBtn');
  bdSlider.value = Math.round(backdropAlpha * 100);
  const syncBd = () => {
    bdLbl.textContent = backdropAlpha <= 0 ? 'off' : Math.round(backdropAlpha * 100) + '%';
    applyBackdrop(); saveUi();
  };
  bdSlider.addEventListener('input', () => {
    backdropAlpha = bdSlider.value / 100;
    if (backdropAlpha > 0) backdropLast = backdropAlpha;
    syncBd();
  });
  bdBtnEl.onclick = () => {
    backdropAlpha = backdropAlpha > 0 ? 0 : (backdropLast > 0 ? backdropLast : 0.55);
    bdSlider.value = Math.round(backdropAlpha * 100);
    syncBd();
    toast(backdropAlpha > 0 ? 'Backdrop on (' + Math.round(backdropAlpha * 100) + '%)' : 'Backdrop off');
  };
  const bgswatches = [...document.querySelectorAll('#bgPal .bgsw')];
  const syncBgSw = () => bgswatches.forEach(b => b.classList.toggle('on', b.dataset.bg === backdrop && backdrop !== ''));
  bgswatches.forEach(b => { b.onclick = () => {
    backdrop = (backdrop === b.dataset.bg) ? '' : b.dataset.bg; // re-click clears
    if (backdrop && backdropAlpha <= 0) { backdropAlpha = backdropLast > 0 ? backdropLast : 0.55; bdSlider.value = Math.round(backdropAlpha * 100); }
    syncBgSw(); syncBd();
    toast(backdrop ? 'Backdrop ' + (b.title || backdrop) : 'Backdrop cleared');
  }; });
  syncBgSw();
  syncBd();
  const glSlider = $('#glSize'), glLbl = $('#glMul'), glBtnEl = $('#glBtn');
  glSlider.value = Math.round(glowScale * 50);
  const syncGl = () => { glLbl.textContent = Math.round(glowScale * 100) + '%'; ren.glowScale = glowScale; saveUi(); };
  glSlider.addEventListener('input', () => {
    glowScale = glSlider.value / 50;
    if (glowScale > 0) glowLast = glowScale;
    syncGl();
  });
  glBtnEl.onclick = () => {
    glowScale = glowScale > 0 ? 0 : (glowLast > 0 ? glowLast : 1);
    glSlider.value = Math.round(glowScale * 50);
    syncGl();
    toast(glowScale > 0 ? 'Glow on (' + Math.round(glowScale * 100) + '%)' : 'Glow off');
  };
  syncGl();
  // tether thickness: slider 0 (hidden) .. 50 (current) .. 100 (double), button = on/off toggle
  const teSlider = $('#teSize'), teLbl = $('#teMul'), teBtnEl = $('#teBtn');
  teSlider.value = Math.round(tetherScale * 50);
  const syncTe = () => { teLbl.textContent = Math.round(tetherScale * 100) + '%'; ren.tetherScale = tetherScale; syncIsoBtn(); saveUi(); };
  teSlider.addEventListener('input', () => {
    tetherScale = teSlider.value / 50;
    if (tetherScale > 0) tetherLast = tetherScale;
    syncTe();
  });
  teBtnEl.onclick = () => {
    tetherScale = tetherScale > 0 ? 0 : (tetherLast > 0 ? tetherLast : 1);
    teSlider.value = Math.round(tetherScale * 50);
    syncTe();
    toast(tetherScale > 0 ? 'Tethers on (' + Math.round(tetherScale * 100) + '%)' : 'Tethers hidden');
  };
  syncTe();
  // tether tint palette: 12 swatches, persisted, live on the renderer
  ren.tetherColor = tetherColor;
  const swatches = [...document.querySelectorAll('#tePal .tesw')];
  const syncSw = () => swatches.forEach(b => b.classList.toggle('on', (b.dataset.color || '').toLowerCase() === String(tetherColor).toLowerCase()));
  swatches.forEach(b => { b.onclick = () => { tetherColor = b.dataset.color; ren.tetherColor = tetherColor; syncSw(); saveUi(); toast('Tether color ' + (b.title || tetherColor)); }; });
  syncSw();
  // pane background opacity: slider = glass alpha, button = glass/clear toggle.
  // Only the pane BACKGROUNDS fade (a --paneAlpha multiplier on their background
  // paint) — text, buttons, sliders and the bottom pill are never touched.
  const paSlider = $('#paSize'), paLbl = $('#paMul'), paBtnEl = $('#paBtn');
  paSlider.value = Math.round(paneAlpha * 100);
  const syncPa = () => {
    paLbl.textContent = paneAlpha <= 0 ? 'clear' : Math.round(paneAlpha * 100) + '%';
    try { document.documentElement.style.setProperty('--paneAlpha', String(paneAlpha)); } catch {}
    syncPaneContrast();
    saveUi();
  };
  paSlider.addEventListener('input', () => {
    paneAlpha = paSlider.value / 100;
    if (paneAlpha > 0) paneLast = paneAlpha;
    syncPa();
  });
  paBtnEl.onclick = () => {
    paneAlpha = paneAlpha > 0 ? 0 : (paneLast > 0 ? paneLast : 1);
    paSlider.value = Math.round(paneAlpha * 100);
    syncPa();
    toast(paneAlpha > 0 ? 'Pane glass on (' + Math.round(paneAlpha * 100) + '%)' : 'Pane backgrounds clear');
  };
  syncPa();
  // per-pane glass overlay dots: toggle the polished-glass background (persisted)
  const glazeName = { leftPanel: 'DocuVerse', docPanel: 'Active body', cloudBox: 'Cloud backup' };
  const applyGlaze = () => {
    try {
      document.getElementById('leftPanel')?.classList.toggle('noglass', !glazeLeft);
      document.getElementById('docPanel')?.classList.toggle('noglass', !glazeDoc);
      document.getElementById('cloudBox')?.classList.toggle('noglass', !glazeCloud);
    } catch {}
  };
  document.querySelectorAll('.glassDot').forEach(b => {
    b.onclick = (e) => {
      e.stopPropagation();
      const id = b.dataset.glaze;
      if (id === 'leftPanel') glazeLeft = !glazeLeft;
      else if (id === 'docPanel') glazeDoc = !glazeDoc;
      else if (id === 'cloudBox') glazeCloud = !glazeCloud;
      else return;
      const on = id === 'leftPanel' ? glazeLeft : id === 'docPanel' ? glazeDoc : glazeCloud;
      applyGlaze(); saveUi();
      toast((glazeName[id] || 'Pane') + ' glass ' + (on ? 'on' : 'off'));
    };
  });
  applyGlaze();
  // column collapse arrows (persisted, collapse = shrink up to a top tab)
  document.querySelectorAll('[data-collapse]').forEach(b => {
    b.onclick = (e) => { e.stopPropagation(); setCollapsed(b.dataset.collapse, !document.getElementById(b.dataset.collapse)?.classList.contains('collapsed')); };
  });
  if (leftCollapsed) setCollapsed('leftPanel', true);
  if (docCollapsed) setCollapsed('docPanel', true);
  // reader pane resize: ‹ stretch arrow on the pane's left edge, drag to stretch
  const wireResize = (el, dir) => {
    if (!el) return;
    let dragX = 0, dragW = 0, dragging = false;
    el.addEventListener('pointerdown', (e) => {
      dragging = true; dragX = e.clientX;
      dragW = document.getElementById('docPanel')?.getBoundingClientRect().width || 380;
      try { el.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      docWidth = clampDocW(dragW + dir * (e.clientX - dragX));
      applyDocWidth();
    });
    const endDrag = () => { if (!dragging) return; dragging = false; saveUi(); };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('dblclick', () => { docWidth = 0; applyDocWidth(); saveUi(); toast('Reader width reset'); });
  };
  try {
    applyDocWidth();
    wireResize(document.getElementById('docResize'), -1); // left edge: drag left = widen
    window.addEventListener('resize', () => syncResizeHandle());
  } catch {}
  // bottom pill "Tethers" button: show/hide the tether lines (bodies always stay put)
  const isoBtn = $('#isoBtn');
  if (isoBtn) isoBtn.onclick = () => {
    tetherScale = tetherScale > 0 ? 0 : (tetherLast > 0 ? tetherLast : 1);
    teSlider.value = Math.round(tetherScale * 50);
    syncTe();
    toast(tetherScale > 0 ? 'Tethers shown' : 'Tethers hidden');
  };
  syncIsoBtn();
  // bottom pill "Distribute" button: pin bodies in a fit-to-canvas orb, overriding
  // orbital motion; toggling off restores dynamics (persisted)
  const autoBtn = $('#autoBtn');
  if (autoBtn) autoBtn.onclick = () => {
    autoDist = !autoDist;
    syncAutoBtn(); saveUi();
    toast(autoDist ? 'Auto-distribute on — bodies pinned in a fit-to-canvas orb' : 'Orbital dynamics restored');
  };
  syncAutoBtn();
  // bottom pill "Simple Orb" button: flat white discs + thin black outline,
  // photo + glow overlays off; toggling off restores textured orbs (persisted)
  const simpleOrbBtn = $('#simpleOrbBtn');
  if (simpleOrbBtn) simpleOrbBtn.onclick = () => {
    simpleOrb = !simpleOrb;
    if (simpleOrb) simpleOrb2 = false; // the two simple modes are mutually exclusive
    ren.simpleOrb = simpleOrb;
    ren.stripOverlays = simpleOrb2;
    syncSimpleOrbBtn(); syncSimpleOrb2Btn(); saveUi();
    toast(simpleOrb ? 'Simple Orb on — flat white discs, overlays off' : 'Textured orbs restored');
  };
  syncSimpleOrbBtn();
  // bottom pill "Simple Orb 2" button: original blue orbs with only the photo
  // overlays stripped (glow stays); toggling off restores photos (persisted)
  const simpleOrb2Btn = $('#simpleOrb2Btn');
  if (simpleOrb2Btn) simpleOrb2Btn.onclick = () => {
    simpleOrb2 = !simpleOrb2;
    if (simpleOrb2) simpleOrb = false; // the two simple modes are mutually exclusive
    ren.simpleOrb = simpleOrb;
    ren.stripOverlays = simpleOrb2;
    syncSimpleOrbBtn(); syncSimpleOrb2Btn(); saveUi();
    toast(simpleOrb2 ? 'Simple Orb 2 on — blue orbs, photo overlays stripped' : 'Photo overlays restored');
  };
  syncSimpleOrb2Btn();
  // bottom pill "Thematic" button: same docs + same physics, recomposed by themes/tags.
  // From the general state (nothing selected) it distills the WHOLE docuverse;
  // leaving the lens always drops the whole view.
  const lensBtn = $('#lensBtn');
  if (lensBtn) lensBtn.onclick = () => {
    lensThematic = !lensThematic;
    if (lensThematic) thematicWhole = (activeId == null);
    else thematicWhole = false;
    applyLens();
    saveUi();
    if (!lensThematic) toast('Regular view restored');
    else if (thematicWhole) {
      const n = wholeThemes.length, m = wholeDocuverseDocs().length;
      toast(n ? `Thematic lens — whole docuverse: ${n} theme${n === 1 ? '' : 's'} across ${m} bodies` : 'Thematic lens — no shared concepts in the docuverse yet');
    } else {
      const n = (thematicThemes.get(vault.activeTabId) || []).length;
      toast(n ? `Thematic lens — ${n} theme${n === 1 ? '' : 's'} distilled from shared concepts` : 'Thematic lens — no shared concepts in this canvas yet');
    }
  };
  // sticky notes: left-pane visibility filters, floating canvas editor, reader pop-out
  { const nva = $('#notesViewAll'); if (nva) { nva.checked = viewNotesAll; nva.onchange = () => { viewNotesAll = nva.checked; saveUi(); }; } }
  { const nvs = $('#notesViewSun'); if (nvs) { nvs.checked = viewNotesSun; nvs.onchange = () => { viewNotesSun = nvs.checked; saveUi(); }; } }
  $('#noteEditSave').onclick = () => { if (noteEditId && saveNote(noteEditId, $('#noteEditText').value)) toast('Sticky note saved'); closeNoteEditor(); };
  $('#noteEditDelete').onclick = () => { if (noteEditId && deleteNote(noteEditId)) toast('Sticky note deleted'); closeNoteEditor(); };
  $('#noteEditCancel').onclick = closeNoteEditor;
  $('#noteEditText').addEventListener('input', (e) => { $('#noteEditCount').textContent = String(e.target.value.length); });
  $('#notePop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-np]'); if (!b || !notePopId) return;
    const k = b.dataset.np;
    if (k === 'close') closeNotePop();
    else if (k === 'copy') copyNotePop();
    else if (k === 'del') { if (deleteNote(notePopId)) toast('Sticky note deleted'); }
    else if (k === 'edit') renderNotePop(true);
    else if (k === 'save') { const ta = $('#notePopText'); if (ta && saveNote(notePopId, ta.value)) toast('Sticky note saved'); }
  });
  // a persisted general state reopens on the whole-docuverse map when the lens is on
  if (lensThematic && vault.tab() && vault.tab().activeId === null && (vault.tab().docs || []).length) thematicWhole = true;
  syncLensBtn();
  if (lensThematic) applyLens(); // persisted lens: open directly in the thematic view
  // top canvas tabs: render + double-click a tab to rename it, right-click for verse isolation
  renderTabs();
  const tabBar = $('#tabBar');
  function openTabCtx(x, y, t) {
    ctx.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'ctx-head';
    head.textContent = `▦ ${t.name}`;
    ctx.appendChild(head);
    // Rename lives in the menu itself (double-click is undiscoverable and
    // native prompt() is blocked in some shells) — inline editor, no popup.
    {
      const rn = document.createElement('button');
      rn.className = 'ctx-item';
      rn.textContent = '✎ Rename';
      rn.title = `Rename “${t.name}”`;
      rn.onclick = (e) => {
        e.stopPropagation();
        head.innerHTML = '';
        const inp = document.createElement('input');
        inp.value = t.name;
        inp.maxLength = 40;
        inp.setAttribute('aria-label', 'Canvas name');
        inp.style.cssText = 'width:100%;box-sizing:border-box;background:rgba(10,14,20,.8);border:1px solid var(--line);color:var(--txt);border-radius:7px;padding:6px 8px;font-size:13px;outline:none;';
        head.appendChild(inp);
        inp.focus();
        try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch {}
        const commit = () => {
          const next = inp.value.trim();
          if (next && next !== t.name) {
            if (vault.renameTab(t.id, next)) { renderTabs(); toast(`Canvas renamed to “${next}”`); }
            else toast('That name is not usable');
          }
          openTabCtx(x, y, vault.tabs.find(v => v.id === t.id) || t);
        };
        inp.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Enter') commit();
          else if (ev.key === 'Escape') openTabCtx(x, y, t);
        });
        inp.addEventListener('click', (ev) => ev.stopPropagation());
        // swap the Rename row into Save/Cancel while editing
        rn.textContent = '✓ Save name';
        rn.title = 'Save the name above (Enter)';
        rn.onclick = (e2) => { e2.stopPropagation(); commit(); };
      };
      ctx.appendChild(rn);
    }
    const tIso = vault.isIso(t);
    const tLinks = vault.assocIds(t);
    const note = document.createElement('div');
    note.className = 'ctx-note';
    note.textContent = tIso
      ? 'Isolated verse: uploads, searches, tags, copies and deletes stay in this tab. Tap a verse below to link it.'
      : `Associated verse — copies, deletes and twin motion span the ${tLinks.length} linked verse${tLinks.length === 1 ? '' : 's'} below. Tap a verse to link or unlink it.`;
    ctx.appendChild(note);
    const sub = document.createElement('div');
    sub.className = 'ctx-sub';
    sub.textContent = 'Associate with';
    ctx.appendChild(sub);
    const others = vault.tabs.filter(x => x.id !== t.id);
    if (!others.length) {
      const solo = document.createElement('div');
      solo.className = 'ctx-note';
      solo.textContent = 'Create another canvas (+) to link verses.';
      ctx.appendChild(solo);
    } else {
      const list = document.createElement('div');
      list.className = 'ctx-picklist';
      for (const o of others) {
        const on = tLinks.includes(o.id);
        const b = document.createElement('button');
        b.className = 'ctx-item ctx-pick' + (on ? ' on' : '');
        b.textContent = (on ? '✓ ' : '○ ') + o.name + (o.main ? ' ★' : '') + (!on && vault.isIso(o) ? ' (isolated)' : '');
        b.title = on ? `Unlink from “${o.name}”` : `Link with “${o.name}”`;
        b.onclick = (e) => {
          e.stopPropagation();
          const linked = vault.toggleAssoc(t.id, o.id);
          if (linked === null) return;
          renderTabs();
          toast(linked ? `“${t.name}” ↔ “${o.name}” linked` : `“${t.name}” unlinked from “${o.name}”`);
          openTabCtx(x, y, t); // menu stays open for multi-select
        };
        list.appendChild(b);
      }
      ctx.appendChild(list);
    }
    // shuffle: slide this tab one slot left or right (end tabs offer one way only)
    const tIdx = vault.tabs.findIndex(x => x.id === t.id);
    if (tIdx > 0 || tIdx < vault.tabs.length - 1) {
      const mv = document.createElement('div');
      mv.className = 'ctx-sub';
      mv.textContent = 'Position';
      ctx.appendChild(mv);
      if (tIdx > 0) ctx.appendChild(ctxItem('←  Move left', false, () => { vault.moveTab(t.id, -1); renderTabs(); toast(`“${t.name}” moved left`); }));
      if (tIdx < vault.tabs.length - 1) ctx.appendChild(ctxItem('Move right  →', false, () => { vault.moveTab(t.id, 1); renderTabs(); toast(`“${t.name}” moved right`); }));
    }
    ctx.hidden = false;
    const w = Math.min(280, ctx.offsetWidth || 220), h = ctx.offsetHeight || 200;
    ctx.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    ctx.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
  }
  if (tabBar) tabBar.addEventListener('contextmenu', (e) => {
    if (e.target.closest('[data-closetab]') || e.target.closest('[data-addtab]')) return;
    const tbb = e.target.closest('[data-tab]');
    if (!tbb) return;
    const t = vault.tabs.find(t => t.id === tbb.dataset.tab);
    if (!t) return;
    e.preventDefault();
    openTabCtx(e.clientX, e.clientY, t);
  });
  if (tabBar) tabBar.addEventListener('dblclick', (e) => {
    if (e.target.closest('[data-closetab]') || e.target.closest('[data-addtab]')) return;
    const tbb = e.target.closest('[data-tab]');
    if (!tbb) return;
    const t = vault.tabs.find(t => t.id === tbb.dataset.tab);
    if (!t) return;
    const next = prompt('Name this canvas:', t.name);
    if (next !== null && next.trim() && next.trim() !== t.name) { vault.renameTab(t.id, next.trim()); renderTabs(); }
  });
  setRot(rotOn);
  // ---------- cloud backup: push snapshots, master settings file ----------
  const BACKUP_FILES = ['src/app.js', 'src/vault.js', 'src/physics.js', 'src/render.js', 'src/README.md', 'src/overlays.json'];
  let backupHist = [];
  try { backupHist = JSON.parse(localStorage.getItem('gravitas.backups') || '[]'); } catch { backupHist = []; }
  function renderCloudBox() {
    const last = backupHist[0];
    $('#cbStatus').textContent = last ? `${backupHist.length} push${backupHist.length === 1 ? '' : 'es'}` : 'no pushes yet';
    $('#cbLast').innerHTML = last
      ? `last push ${esc(new Date(last.at).toLocaleString())} · ${last.docs} docs · ${(last.bytes / 1024).toFixed(0)} KB<br><a href="${esc(last.url)}" target="_blank" rel="noopener">open backup file</a>`
      : 'Push to upload a full snapshot<br>(code + documents + settings).';
  }
  // ---------- dev builds pane (bottom-right, developer-only) ----------
  // Visible only in dev mode: ?dev=1 (or #dev), localStorage docuverse.dev=1,
  // or window.DOCUVERSE_DEV=true. Holds the Windows + Mac installer links;
  // the URLs persist in localStorage so they are pasted once per machine.
  const DEV_BUILDS_KEY = 'docuverse.devBuilds.v1';
  let devBuilds = { winUrl: '', winLabel: '', macUrl: '', macLabel: '', note: '' };
  try {
    const raw = JSON.parse(localStorage.getItem(DEV_BUILDS_KEY) || '{}');
    for (const k of ['winUrl', 'winLabel', 'macUrl', 'macLabel', 'note'])
      if (typeof raw[k] === 'string') devBuilds[k] = raw[k].slice(0, 500);
  } catch { /* fresh prefs */ }
  function saveDevBuilds() {
    try { localStorage.setItem(DEV_BUILDS_KEY, JSON.stringify(devBuilds)); } catch {}
  }
  function isDev() {
    try {
      if (window.DOCUVERSE_DEV === true) return true;
      const q = new URLSearchParams(location.search || '');
      if (q.get('dev') === '1') return true;
      if (/(?:^|&)dev(?:&|$)/.test(String(location.hash || '').replace(/^#/, ''))) return true;
      if (localStorage.getItem('docuverse.dev') === '1') return true;
    } catch {}
    return false;
  }
  function setDevBuilds(patch) {
    if (patch && typeof patch === 'object') {
      for (const k of ['winUrl', 'winLabel', 'macUrl', 'macLabel', 'note'])
        if (typeof patch[k] === 'string') devBuilds[k] = patch[k].slice(0, 500);
      saveDevBuilds();
    }
    renderDevBox();
    return { ...devBuilds };
  }
  function renderDevBox() {
    const box = $('#devBox');
    if (!box) return;
    // always visible while building (dev-gate removed per owner request)
    box.hidden = false;
    const link = (id, url, fallback) => {
      const a = $(id);
      if (!a) return;
      const u = String(url || '').trim();
      if (u) { a.href = u; a.removeAttribute('aria-disabled'); a.classList.remove('off'); a.removeAttribute('title'); }
      else { a.removeAttribute('href'); a.setAttribute('aria-disabled', 'true'); a.classList.add('off'); a.title = fallback; }
    };
    link('#devWin', devBuilds.winUrl, 'No Windows build linked yet — click edit links to paste the URL.');
    link('#devMac', devBuilds.macUrl, 'No Mac build linked yet — click edit links to paste the URL.');
    const wl = $('#devWinLabel'); if (wl) wl.textContent = devBuilds.winLabel || 'Windows · .exe / .msi';
    const ml = $('#devMacLabel'); if (ml) ml.textContent = devBuilds.macLabel || 'Mac · .dmg';
    const nt = $('#devNote'); if (nt) nt.textContent = devBuilds.note || '';
    const ed = $('#devEdit');
    if (ed && !ed.hidden) {
      const set = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v || ''; };
      set('#devWinUrl', devBuilds.winUrl); set('#devWinTitle', devBuilds.winLabel);
      set('#devMacUrl', devBuilds.macUrl); set('#devMacTitle', devBuilds.macLabel);
      set('#devNoteInput', devBuilds.note);
    }
  }
  async function buildBackupObject() {
    const files = {};
    for (const f of BACKUP_FILES) {
      try {
        const r = await fetch(f);
        if (!r.ok) throw new Error('http ' + r.status);
        files[f] = { ok: true, content: await r.text() };
      } catch { files[f] = { ok: false, content: null }; }
    }
    let mainPjs = null;
    try {
      const r = await fetch('https://perchance.org/api/getGeneratorsAndDependencies?generatorNames=' + encodeURIComponent(window.generatorName || ''));
      mainPjs = (await r.json()).generators?.[window.generatorName]?.code || null;
    } catch { /* offline — vault + settings still back up */ }
    let indexHtml = null;
    try {
      const r = await fetch(`https://null.perchance.org/${encodeURIComponent(window.generatorName || '')}`);
      const t = await r.text();
      if (t && t.includes('uniCv')) indexHtml = t;
    } catch { /* shell stays local-only */ }
    return {
      app: 'docuverse-backup', version: 1, pushedAt: new Date().toISOString(),
      generator: window.generatorName || null,
      mainPjs, indexHtml, files,
      // deep-clone doc rows: the backup must be a snapshot, not a live
      // reference — otherwise docs added after "build" leak into the file.
      tabs: vault.tabs.map(t => ({ id: t.id, name: t.name, docs: (t.docs || []).map(d => ({ ...d, links: [...(d.links || [])], tags: [...(d.tags || [])] })), activeId: t.activeId, main: t.main === true, assoc: [...(t.assoc || [])], color: t.color || null, disassociated: vault.isIso(t) })),
      activeTabId: vault.activeTabId,
      vault: vault.docs.map(d => ({ ...d, links: [...(d.links || [])], tags: [...(d.tags || [])] })), // legacy compat: active canvas docs
      settings: {
        rotOn, rotMul, speedMul: rotMul, autoDist, simpleOrb, simpleOrb2,
        ovAlpha, ovLast, lbScale, lbLast, bgShade,
        glow: glowScale, glowLast, tether: tetherScale, tetherLast, tetherColor,
        backdrop, backdropAlpha, backdropLast, paneAlpha, paneLast,
        glazeLeft, glazeDoc, glazeCloud,
        leftCollapsed, docCollapsed, docWidth, lensThematic,
        viewNotesAll, viewNotesSun,
        topicSim: vault.topicSim, topicShared: vault.topicShared,
        topicMaxDf: vault.topicMaxDf, topicTopK: vault.topicTopK,
        topicIdfFloor: vault.topicIdfFloor,
        help: { ...helpTexts },
      },
    };
  }
  function downloadMasterFile(obj) {
    const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'docuverse-master-settings.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  // total bodies across every canvas in a backup object (for the confirm line)
  function countBackupDocs(obj) {
    try {
      if (obj && Array.isArray(obj.tabs) && obj.tabs.length) {
        let n = 0;
        for (const t of obj.tabs) if (t && Array.isArray(t.docs)) n += t.docs.length;
        else if (t && Array.isArray(t.documents)) n += t.documents.length;
        return n;
      }
      const v = obj && (obj.vault || obj.docs || obj.documents);
      if (Array.isArray(v)) return v.length;
      if (Array.isArray(obj)) return obj.length;
    } catch {}
    return 0;
  }
  // a backup-shaped object? (checked BEFORE JSON.parse errors and before the
  // confirm dialog, so drops/clicks on random .json files get a clear toast)
  function looksLikeBackup(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    if (obj.app === 'docuverse-backup' || obj.app === 'gravitas-backup') return true;
    // forgiving: tab/doc arrays without the app tag still count (hand-made or
    // very old master files) — applyBackupObject validates the rest.
    if (Array.isArray(obj.tabs) && obj.tabs.length) return true;
    if (Array.isArray(obj.vault)) return true;
    if (Array.isArray(obj.docs) || Array.isArray(obj.documents)) return true;
    return false;
  }
  function applyBackupObject(obj) {
    try { if (window.__gravitas) window.__gravitas.lastLoadError = null; } catch {}
    // accept: current {app,tabs,vault}, tabs-only, vault-only, legacy
    // {docs}/{documents}, or a bare docs array. Anything else is rejected
    // with a specific toast (not a silent no-op).
    let src = obj;
    if (Array.isArray(src)) src = { vault: src, tabs: null };
    if (!src || typeof src !== 'object') { toast('That file is not a DocuVerse master file (no backup data)'); return false; }
    if (src.app && src.app !== 'docuverse-backup' && src.app !== 'gravitas-backup') { toast(`That file is a “${src.app}” file, not a DocuVerse master file`); return false; }
    const hasTabs = Array.isArray(src.tabs) && src.tabs.length > 0;
    const vaultArr = Array.isArray(src.vault) ? src.vault : (Array.isArray(src.docs) ? src.docs : (Array.isArray(src.documents) ? src.documents : null));
    if (!hasTabs && !vaultArr) { toast('That file is not a DocuVerse master file (no tabs or documents found)'); return false; }
    // snapshot the current universe so the result line can say what actually
    // changed — reloading the same docs over themselves reports "already
    // matches" instead of looking broken.
    const sigOf = (tabs) => {
      try {
        const names = [];
        for (const t of tabs) for (const d of (t.docs || [])) names.push(String(d.name || '') + ':' + String(d.text || '').length);
        return names.sort().join('\n');
      } catch { return ''; }
    };
    const beforeSig = sigOf(vault.tabs);
    const beforeCount = countBackupDocs({ tabs: vault.tabs });
    const s = (src.settings && typeof src.settings === 'object') ? src.settings : {};
    // settings first (validated; missing keys keep current values so old
    // master files don't wipe newer personalization)
    try {
      if (typeof s.rotOn === 'boolean') rotOn = s.rotOn;
      { const sv = s.speedMul ?? s.rotMul; if (typeof sv === 'number' && sv >= 0 && sv <= 3) rotMul = sv; }
      if (s.autoDist === true || s.autoDist === false) autoDist = s.autoDist;
      if (s.simpleOrb === true) { simpleOrb = true; simpleOrb2 = false; }
      else if (s.simpleOrb2 === true) { simpleOrb2 = true; simpleOrb = false; }
      else if (s.simpleOrb === false && s.simpleOrb2 === false) { simpleOrb = false; simpleOrb2 = false; }
      if (typeof s.ovAlpha === 'number' && s.ovAlpha >= 0 && s.ovAlpha <= 1) ovAlpha = s.ovAlpha;
      if (typeof s.ovLast === 'number' && s.ovLast > 0 && s.ovLast <= 1) ovLast = s.ovLast;
      if (typeof s.lbScale === 'number' && s.lbScale >= 0 && s.lbScale <= 1.5) lbScale = s.lbScale;
      if (typeof s.lbLast === 'number' && s.lbLast > 0 && s.lbLast <= 1.5) lbLast = s.lbLast;
      if (typeof s.bgShade === 'number' && s.bgShade >= 0 && s.bgShade <= 1) bgShade = s.bgShade;
      if (typeof s.glow === 'number' && s.glow >= 0 && s.glow <= 2) glowScale = s.glow;
      if (typeof s.glowLast === 'number' && s.glowLast > 0 && s.glowLast <= 2) glowLast = s.glowLast;
      if (typeof s.tether === 'number' && s.tether >= 0 && s.tether <= 2) tetherScale = s.tether;
      if (typeof s.tetherLast === 'number' && s.tetherLast > 0 && s.tetherLast <= 2) tetherLast = s.tetherLast;
      if (typeof s.tetherColor === 'string' && /^#[0-9a-f]{6}$/i.test(s.tetherColor)) tetherColor = s.tetherColor;
      if (typeof s.backdrop === 'string' && /^[a-z0-9._-]+\.jpg$/i.test(s.backdrop)) backdrop = s.backdrop;
      else if (s.backdrop === '') backdrop = '';
      if (typeof s.backdropAlpha === 'number' && s.backdropAlpha >= 0 && s.backdropAlpha <= 1) backdropAlpha = s.backdropAlpha;
      if (typeof s.backdropLast === 'number' && s.backdropLast > 0 && s.backdropLast <= 1) backdropLast = s.backdropLast;
      if (typeof s.paneAlpha === 'number' && s.paneAlpha >= 0 && s.paneAlpha <= 1) paneAlpha = s.paneAlpha;
      if (typeof s.paneLast === 'number' && s.paneLast > 0 && s.paneLast <= 1) paneLast = s.paneLast;
      if (s.glazeLeft === false) glazeLeft = false; else if (s.glazeLeft === true) glazeLeft = true;
      if (s.glazeDoc === false) glazeDoc = false; else if (s.glazeDoc === true) glazeDoc = true;
      if (s.glazeCloud === false) glazeCloud = false; else if (s.glazeCloud === true) glazeCloud = true;
      if (typeof s.docWidth === 'number' && s.docWidth >= 260 && s.docWidth <= 900) docWidth = s.docWidth;
      else if (s.docWidth === 0) docWidth = 0;
      if (s.leftCollapsed === true) leftCollapsed = true; else if (s.leftCollapsed === false) leftCollapsed = false;
      if (s.docCollapsed === true) docCollapsed = true; else if (s.docCollapsed === false) docCollapsed = false;
      if (s.viewNotesAll === false) viewNotesAll = false; else if (s.viewNotesAll === true) viewNotesAll = true;
      if (s.viewNotesSun === false) viewNotesSun = false; else if (s.viewNotesSun === true) viewNotesSun = true;
      if (s.viewNotes === false) { viewNotesAll = false; viewNotesSun = false; }
      for (const k of ['topicSim', 'topicShared', 'topicMaxDf', 'topicTopK', 'topicIdfFloor']) {
        if (typeof s[k] === 'number' && isFinite(s[k])) vault[k] = s[k];
      }
      if (s.help && typeof s.help === 'object') {
        for (const k of Object.keys(DEFAULT_HELP)) {
          if (typeof s.help[k] === 'string' && s.help[k].trim()) helpTexts[k] = s.help[k];
        }
        try { saveHelp(); } catch {}
      }
    } catch (e) { console.warn('backup settings restore skipped', e); }
    // docs / tabs (normalizeDoc inside adoptTabs repairs ragged rows; the
    // legacy vault-only path normalizes explicitly here)
    try {
      if (hasTabs) {
        vault.adoptTabs(src.tabs);
        const want = (typeof src.activeTabId === 'string') ? src.activeTabId : null;
        vault.activeTabId = (want && vault.tabs.some(t => t.id === want)) ? want : vault.tabs[0].id;
      } else {
        const norm = vaultArr.map((rd, i) => {
          try { return vault.normalizeDoc(rd, 'Untitled ' + (i + 1)); }
          catch { const p = { id: 'd_' + Math.random().toString(36).slice(2, 10), name: 'Untitled ' + (i + 1), text: '', words: 0, links: [], tags: [] }; return p; }
        });
        // legacy file: replace the active canvas, keep the other canvases
        if (!vault.tabs.length) {
          vault.tabs = [{ id: 'tab_' + Math.random().toString(36).slice(2, 10), name: 'Universe 1', docs: norm, activeId: norm[0]?.id || null, main: true, assoc: [], color: null }];
          vault.activeTabId = vault.tabs[0].id;
        } else {
          vault.tab().docs = norm;
          vault.tab().activeId = norm[0]?.id || null;
        }
        try { vault.persist(); } catch {}
      }
    } catch (e) {
      console.warn('backup docs restore failed', e);
      try { if (window.__gravitas) window.__gravitas.lastLoadError = String((e && e.message) || e); } catch {}
      toast(`Could not use the documents in that file (${(e && e.message) || e})`, 6000);
      return false;
    }
    // clear every per-canvas cache so the restored docs (not stale edges or
    // selections from the previous universe) render
    try {
      unis.clear();
      thematicUnis.clear(); thematicBuilt.clear();
      wholeUni = null; wholeBuilt = ''; wholeThemes = []; thematicWhole = false;
      edgeByTab.clear();
      selSet.clear(); matchSet = null;
      try { closeNoteEditor(); } catch {}
      try { closeNotePop(); } catch {}
      try { $('#searchPop').innerHTML = ''; $('#searchInput').value = ''; } catch {}
    } catch {}
    try { saveUi(); } catch {}
    try { vault.persist(); } catch {}
    try {
      rebuildAllTabs();
    } catch (e) {
      console.warn('backup rebuild failed', e);
      try { if (window.__gravitas) window.__gravitas.lastLoadError = String((e && e.message) || e); } catch {}
      toast(`Loaded the documents but the universe failed to rebuild (${(e && e.message) || e}) — reload the page`, 8000);
      return false;
    }
    activeId = vault.tab().activeId;
    if ((activeId == null && vault.tab().activeId !== null) || (activeId && !vault.byId(activeId))) {
      activeId = (vault.tab().activeId === null && vault.docs.length) ? null : (vault.docs[0]?.id || null);
    }
    try { vault.tab().activeId = activeId; } catch {}
    try { vault.persist(); } catch {}
    try { renderDoc(); } catch (e) { console.warn('renderDoc after load failed', e); }
    try { updateStats(); } catch {}
    try { renderTabs(); } catch {}
    try { applyHelpToStatic(); } catch {}
    // restore every control to the loaded settings (each guarded: a missing
    // slider must never abort the load)
    try { $('#rotSpeed').value = speedToSlider(rotMul); } catch {}
    try { $('#rotMul').textContent = fmtSpeed(rotMul); } catch {}
    try { setRot(rotOn); } catch {}
    try { const el = $('#ovAlpha'); if (el) el.value = Math.round(ovAlpha * 100); const lb = $('#ovMul'); if (lb) lb.textContent = Math.round(ovAlpha * 100) + '%'; if (ren) ren.overlayAlpha = ovAlpha; } catch {}
    try { const el = $('#lbSize'); if (el) el.value = Math.round(lbScale * 100); const lb = $('#lbMul'); if (lb) lb.textContent = lbScale <= 0 ? 'hidden' : Math.round(lbScale * 100) + '%'; if (ren) ren.labelScale = lbScale; } catch {}
    try { const el = $('#bgShade'); if (el) el.value = Math.round(bgShade * 100); const lb = $('#bgMul'); if (lb) lb.textContent = Math.round(bgShade * 100) + '%'; if (ren) ren.bgShade = bgShade; syncHintContrast(); syncPaneContrast(); } catch {}
    try { const el = $('#glSize'); if (el) el.value = Math.round(glowScale * 50); const lb = $('#glMul'); if (lb) lb.textContent = Math.round(glowScale * 100) + '%'; if (ren) ren.glowScale = glowScale; } catch {}
    try { const el = $('#teSize'); if (el) el.value = Math.round(tetherScale * 50); const lb = $('#teMul'); if (lb) lb.textContent = Math.round(tetherScale * 100) + '%'; if (ren) ren.tetherScale = tetherScale; syncIsoBtn(); } catch {}
    try { if (ren) ren.tetherColor = tetherColor; document.querySelectorAll('#tePal .tesw').forEach(b => b.classList.toggle('on', (b.dataset.color || '').toLowerCase() === String(tetherColor).toLowerCase())); } catch {}
    try { const el = $('#bdAlpha'); if (el) el.value = Math.round(backdropAlpha * 100); const lb = $('#bdMul'); if (lb) lb.textContent = backdropAlpha <= 0 ? 'off' : Math.round(backdropAlpha * 100) + '%'; if (ren) { ren.backdropAlpha = backdropAlpha; } try { applyBackdrop(); } catch {} } catch {}
    try { document.querySelectorAll('#bgPal .bgsw').forEach(b => b.classList.toggle('on', b.dataset.bg === backdrop && backdrop !== '')); } catch {}
    try { const el = $('#paSize'); if (el) el.value = Math.round(paneAlpha * 100); const lb = $('#paMul'); if (lb) lb.textContent = paneAlpha <= 0 ? 'clear' : Math.round(paneAlpha * 100) + '%'; try { document.documentElement.style.setProperty('--paneAlpha', String(paneAlpha)); } catch {} syncPaneContrast(); } catch {}
    try {
      document.getElementById('leftPanel')?.classList.toggle('noglass', !glazeLeft);
      document.getElementById('docPanel')?.classList.toggle('noglass', !glazeDoc);
      document.getElementById('cloudBox')?.classList.toggle('noglass', !glazeCloud);
    } catch {}
    try { applyDocWidth(); } catch {}
    try {
      const nva = $('#notesViewAll'); if (nva) nva.checked = viewNotesAll !== false;
      const nvs = $('#notesViewSun'); if (nvs) nvs.checked = viewNotesSun !== false;
    } catch {}
    try {
      if (leftCollapsed) setCollapsed('leftPanel', true); else setCollapsed('leftPanel', false);
      if (docCollapsed) setCollapsed('docPanel', true); else setCollapsed('docPanel', false);
    } catch {}
    try { if (ren) { ren.simpleOrb = simpleOrb; ren.stripOverlays = simpleOrb2; } syncAutoBtn(); syncSimpleOrbBtn(); syncSimpleOrb2Btn(); } catch {}
    try {
      lensThematic = s.lensThematic === true;
      syncLensBtn();
      if (lensThematic) applyLens();
    } catch {}
    try { saveUi(); } catch {}
    try { vault.persist(); } catch {}
    try {
      const afterCount = countBackupDocs({ tabs: vault.tabs });
      const afterSig = sigOf(vault.tabs);
      const identical = afterSig === beforeSig;
      try { if (window.__gravitas) window.__gravitas.lastLoadInfo = { before: beforeCount, after: afterCount, identical, canvases: vault.tabs.length }; } catch {}
      const where = `${afterCount} bodies across ${vault.tabs.length} canvas${vault.tabs.length === 1 ? '' : 'es'}`;
      if (identical) setLog(`Loaded backup: ${where} — already matches the current universe, nothing changed`);
      else setLog(`Loaded backup: ${beforeCount} → ${afterCount} bodies across ${vault.tabs.length} canvas${vault.tabs.length === 1 ? '' : 'es'}`);
    } catch {}
    return true;
  }
  async function pushBackup() {
    const up = (typeof root !== 'undefined' && root.uploadPlugin) || null;
    if (!up) { toast('Backup plugin still loading — wait a moment and retry', 4000); return; }
    try {
      toast('Packing backup…');
      const obj = await buildBackupObject();
      const json = JSON.stringify(obj);
      const res = await up(new File([json], `docuverse-backup-${Date.now()}.json`, { type: 'application/json' }));
      if (!res || !res.url) throw new Error((res && res.error) || 'upload failed');
      backupHist.unshift({ url: res.url, at: Date.now(), bytes: json.length, docs: vault.tabs.reduce((n, t) => n + (t.docs ? t.docs.length : 0), 0) });
      backupHist = backupHist.slice(0, 8);
      try { localStorage.setItem('gravitas.backups', JSON.stringify(backupHist)); } catch { /* private mode */ }
      renderCloudBox();
      toast('Backup pushed to the cloud ☁');
    } catch (e) {
      console.warn('backup failed', e);
      toast(`Backup failed (${(e && e.message) || e}) — retry in a moment`, 6000);
    }
  }
  $('#pushBtn').onclick = pushBackup;
  $('#dlMasterBtn').onclick = async () => {
    try { toast('Preparing DocuVerse master file…'); downloadMasterFile(await buildBackupObject()); toast('DocuVerse master file downloaded'); }
    catch (e) { toast(`Could not build DocuVerse master file (${(e && e.message) || e})`, 6000); }
  };
  $('#loadBtn').onclick = () => $('#loadInput').click();
  const mergeBtnEl = $('#mergeBtn');
  if (mergeBtnEl) mergeBtnEl.onclick = () => $('#mergeInput').click();
  // merge: add a backup file's documents into the CURRENT canvas, keeping
  // what is already open. Exact-text duplicates are skipped; same-name but
  // different-text docs arrive as "Name (2).md" so nothing is overwritten.
  // Returns {added, dupes, total} (added docs are already rebuilt + focused).
  function mergeBackupObject(obj) {
    let rawList = null;
    if (obj && Array.isArray(obj.tabs) && obj.tabs.length) {
      rawList = [];
      for (const t of obj.tabs) {
        const arr = (t && Array.isArray(t.docs)) ? t.docs : (t && Array.isArray(t.documents) ? t.documents : null);
        if (arr) for (const d of arr) rawList.push(d);
      }
    } else if (Array.isArray(obj)) rawList = obj.slice();
    else if (obj && Array.isArray(obj.vault)) rawList = obj.vault;
    else if (obj && Array.isArray(obj.docs)) rawList = obj.docs;
    else if (obj && Array.isArray(obj.documents)) rawList = obj.documents;
    if (!rawList || !rawList.length) { toast('That backup has no documents to merge'); return { added: 0, dupes: 0, total: 0 }; }
    const tab = vault.tab();
    if (!tab) { toast('No open canvas to merge into'); return { added: 0, dupes: 0, total: rawList.length }; }
    const seenText = new Set((tab.docs || []).map(d => String(d.text || '').replace(/\s+/g, ' ').trim()));
    const seenName = new Set((tab.docs || []).map(d => String(d.name || '').toLowerCase()));
    const seenId = new Set((tab.docs || []).map(d => d.id));
    let added = 0, dupes = 0;
    const newIds = [];
    for (let i = 0; i < rawList.length; i++) {
      let d = null;
      try { d = vault.normalizeDoc(rawList[i], 'Untitled ' + (i + 1)); }
      catch { continue; }
      const key = String(d.text || '').replace(/\s+/g, ' ').trim();
      if (key && seenText.has(key)) { dupes++; continue; } // same bytes already here
      seenText.add(key);
      // unique id (a backup merged over itself would otherwise twin-collide)
      if (!d.id || seenId.has(d.id)) {
        d.id = 'd_' + Math.random().toString(36).slice(2, 10);
        while (seenId.has(d.id)) d.id = 'd_' + Math.random().toString(36).slice(2, 10);
      }
      seenId.add(d.id);
      // unique name (same rule as file intake: "Report (2).md")
      let nm = d.name, k = 1;
      while (seenName.has(nm.toLowerCase())) {
        k++;
        nm = String(d.name).replace(/(\.[^.]+)?$/, ` (${k})$1`);
        if (k > 999) break;
      }
      d.name = nm;
      seenName.add(nm.toLowerCase());
      tab.docs.push(d);
      newIds.push(d.id);
      added++;
    }
    try { vault.persist(); } catch {}
    try { edgeByTab.delete(tab.id); } catch {}
    rebuild(activeId);
    if (newIds.length && uni && uni.focus(newIds[0])) { claimSun(newIds[0]); renderDoc(); }
    try { renderTabs(); } catch {}
    try { updateStats(); } catch {}
    return { added, dupes, total: rawList.length };
  }
  async function readBackupFile(f) {
    setLog(`Reading “${f.name}” (${(f.size / 1024).toFixed(0)} KB)…`);
    toast(`Reading “${f.name}”…`);
    let txt = null;
    try { txt = await f.text(); }
    catch (err) {
      try {
        txt = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result || ''));
          r.onerror = () => rej(r.error || new Error('FileReader failed'));
          r.readAsText(f);
        });
      } catch (err2) { toast(`Could not read “${f.name}” (${(err2 && err2.message) || err2})`, 8000); setLog(`Load failed: could not read “${f.name}”`); return null; }
    }
    if (!txt || !txt.trim()) { toast(`“${f.name}” looks empty (0 bytes of text)`); setLog(`Load failed: “${f.name}” is empty`); return null; }
    txt = String(txt).replace(/^﻿/, '').trim();
    let obj = null;
    try { obj = JSON.parse(txt); }
    catch (je) {
      const head = txt.slice(0, 160).replace(/\s+/g, ' ');
      console.warn('backup JSON.parse failed', je, head);
      try { window.__gravitas.lastLoadError = 'JSON: ' + ((je && je.message) || je); } catch {}
      toast(`Could not load “${f.name}” — not valid JSON (${(je && je.message) || je})`, 10000);
      setLog(`Load failed: “${f.name}” is not valid JSON — starts with: ${head.slice(0, 120)}…`);
      return null;
    }
    if (!looksLikeBackup(obj)) {
      const keys = (obj && typeof obj === 'object' && !Array.isArray(obj)) ? Object.keys(obj).slice(0, 8).join(', ') : (Array.isArray(obj) ? `array[${obj.length}]` : typeof obj);
      toast(`“${f.name}” is not a DocuVerse master file (found: ${keys || 'empty'})`, 10000);
      setLog(`Load failed: “${f.name}” has no backup data (found: ${keys || 'empty'})`);
      try { window.__gravitas.lastLoadError = 'not-a-backup: ' + (keys || 'empty'); } catch {}
      return null;
    }
    try { window.__gravitas._lastBackupObj = obj; window.__gravitas._lastBackupName = f.name; } catch {}
    return { obj, name: f.name };
  }
  $('#loadInput').onchange = async (e) => {
    const f = (e.target.files || [])[0];
    e.target.value = '';
    if (!f) return;
    const got = await readBackupFile(f);
    if (!got) return;
    const { obj } = got;
    try {
      const n = countBackupDocs(obj);
      const tabs = Array.isArray(obj.tabs) ? obj.tabs.length : 0;
      const detail = tabs > 1 ? `${n} bodies across ${tabs} canvases` : `${n} documents`;
      setLog(`Loaded “${f.name}” — asking to replace universe with ${detail}…`);
      if (!await confirmDlg(`Load DocuVerse master file with ${detail}? This replaces the current universe.`, 'Load file')) { setLog(`Load cancelled — kept current universe`); return; }
      if (applyBackupObject(obj)) {
        renderCloudBox();
        try {
          const info = window.__gravitas.lastLoadInfo;
          if (info && info.identical) toast(`Backup matches the open universe — nothing changed (${detail})`, 6000);
          else if (info) toast(`DocuVerse master file loaded — ${info.before} → ${info.after} bodies`, 6000);
          else toast(`DocuVerse master file loaded — ${detail}`, 6000);
        } catch { toast(`DocuVerse master file loaded — ${detail}`, 6000); }
      }
      else { setLog(`Load failed: applyBackupObject refused “${f.name}”`); }
    } catch (err) { console.warn('load failed', err); try { window.__gravitas.lastLoadError = String((err && err.message) || err); } catch {} toast(`Could not load that file (${(err && err.message) || err})`, 10000); setLog(`Load failed: ${(err && err.message) || err}`); }
  };
  const mergeInputEl = $('#mergeInput');
  if (mergeInputEl) mergeInputEl.onchange = async (e) => {
    const f = (e.target.files || [])[0];
    e.target.value = '';
    if (!f) return;
    const got = await readBackupFile(f);
    if (!got) return;
    const { obj } = got;
    try {
      const n = countBackupDocs(obj);
      const tabs = Array.isArray(obj.tabs) ? obj.tabs.length : 0;
      const detail = tabs > 1 ? `${n} bodies across ${tabs} canvases` : `${n} documents`;
      setLog(`Loaded “${f.name}” — asking to merge ${detail} into “${vault.tab().name}”…`);
      if (!await confirmDlg(`Merge ${detail} into “${vault.tab().name}”? Keeps what is open, adds the rest. Exact duplicates are skipped.`, 'Merge')) { setLog(`Merge cancelled — kept current universe`); return; }
      const r = mergeBackupObject(obj);
      try { renderCloudBox(); } catch {}
      if (r.added > 0) {
        const dupe = r.dupes ? ` · ${r.dupes} duplicate${r.dupes === 1 ? '' : 's'} skipped` : '';
        toast(`Merged ${r.added} document${r.added === 1 ? '' : 's'} into “${vault.tab().name}”${dupe}`);
        setLog(`Merged “${f.name}”: ${r.added} added${dupe} (${vault.docs.length} bodies now)`);
      } else if (r.dupes > 0) {
        toast(`Nothing new — all ${r.dupes} already in “${vault.tab().name}”`);
        setLog(`Merge: nothing new — all ${r.dupes} already open`);
      }
    } catch (err) { console.warn('merge failed', err); toast(`Could not merge that file (${(err && err.message) || err})`, 10000); setLog(`Merge failed: ${(err && err.message) || err}`); }
  };
  renderCloudBox();
  renderDevBox();
  try { window.addEventListener('hashchange', renderDevBox); } catch {}
  try {
    const devEditBtn = $('#devEditBtn');
    if (devEditBtn) devEditBtn.onclick = () => {
      const ed = $('#devEdit');
      if (!ed) return;
      ed.hidden = !ed.hidden;
      devEditBtn.textContent = ed.hidden ? 'edit links' : 'close';
      if (!ed.hidden) renderDevBox();
    };
    const devSaveBtn = $('#devSaveBtn');
    if (devSaveBtn) devSaveBtn.onclick = () => {
      const val = (id) => { const el = $(id); return el ? el.value : ''; };
      setDevBuilds({
        winUrl: val('#devWinUrl'), winLabel: val('#devWinTitle'),
        macUrl: val('#devMacUrl'), macLabel: val('#devMacTitle'),
        note: val('#devNoteInput'),
      });
      const ed = $('#devEdit'); if (ed) ed.hidden = true;
      const eb = $('#devEditBtn'); if (eb) eb.textContent = 'edit links';
      toast('Dev build links saved (this machine only)');
    };
    const devHideBtn = $('#devHideBtn');
    if (devHideBtn) devHideBtn.onclick = () => {
      try { localStorage.removeItem('docuverse.dev'); } catch {}
      const box = $('#devBox'); if (box) box.hidden = true;
      toast('Dev pane hidden — reopen with ?dev=1');
    };
  } catch {}
  // console fallback when the picker itself is blocked: paste/type the JSON
  // (or fetch a cloud URL) and load it without touching <input type=file>.
  // e.g. await __gravitas.loadBackupFromText(await (await fetch(url)).text())
  async function loadBackupFromText(txt, name) {
    txt = String(txt || '').replace(/^﻿/, '').trim();
    if (!txt) { toast('Nothing to load — empty text'); return false; }
    let obj = null;
    try { obj = JSON.parse(txt); }
    catch (je) { toast(`Not valid JSON (${(je && je.message) || je})`, 8000); return false; }
    if (!looksLikeBackup(obj)) { toast('Not a DocuVerse master file (no backup data)', 8000); return false; }
    const n = countBackupDocs(obj);
    if (!await confirmDlg(`Load backup with ${n} documents? This replaces the current universe.`, 'Load file')) return false;
    const ok = applyBackupObject(obj);
    if (ok) {
      try { renderCloudBox(); } catch {}
      try {
        const info = window.__gravitas.lastLoadInfo;
        if (info && info.identical) toast(`Backup matches the open universe — nothing changed (${n} documents)`);
        else if (info) toast(`DocuVerse master file loaded — ${info.before} → ${info.after} bodies`);
        else toast(`DocuVerse master file loaded — ${n} documents`);
      } catch { toast(`DocuVerse master file loaded — ${n} documents`); }
    }
    return ok;
  }
  async function mergeBackupFromText(txt) {
    txt = String(txt || '').replace(/^﻿/, '').trim();
    if (!txt) { toast('Nothing to merge — empty text'); return { added: 0, dupes: 0, total: 0 }; }
    let obj = null;
    try { obj = JSON.parse(txt); }
    catch (je) { toast(`Not valid JSON (${(je && je.message) || je})`, 8000); return { added: 0, dupes: 0, total: 0 }; }
    if (!looksLikeBackup(obj)) { toast('Not a DocuVerse master file (no backup data)', 8000); return { added: 0, dupes: 0, total: 0 }; }
    const r = mergeBackupObject(obj);
    try { renderCloudBox(); } catch {}
    if (r.added > 0) toast(`Merged ${r.added} document${r.added === 1 ? '' : 's'} (skipped ${r.dupes} duplicates)`);
    else toast(`Nothing new — all ${r.dupes} already open`);
    return r;
  }
  window.__gravitas = { get uni() { return uni; }, get unis() { return unis; }, get thematicThemes() { return thematicThemes; }, ren, vault, rebuild, rebuildAllTabs, entangleSync, renderTabs, switchCanvas, closeCanvas, removeFromCanvas, deleteEverywhere, removeAllFromCanvas, removeIdsFromCanvas, removeUniverseFromCanvas, toggleAssoc: (...a) => vault.toggleAssoc(...a), confirmDlg, openPickModal, buildBackupObject, applyBackupObject, mergeBackupObject, looksLikeBackup, countBackupDocs, loadBackupFromText, mergeBackupFromText, ingestFiles, getDropFiles, readFileAsText, intakeAllowed, cleanName, get devBuilds() { return { ...devBuilds }; }, setDevBuilds, isDev, renderDevBox, lastLoadError: null, lastLoadInfo: null, get activeId() { return activeId; }, defocusSun, getNote, saveNote, deleteNote, getThematicWhole, wholeDocuverseDocs, get thematicWhole() { return thematicWhole; }, get wholeThemes() { return wholeThemes; }, get helpTexts() { return { ...helpTexts }; }, openHelpEditor, helpEditAllowed, DEFAULT_HELP };
  window.addEventListener('resize', () => ren.resize());
}

if (document.readyState !== 'loading') boot();
else document.addEventListener('DOMContentLoaded', boot);
