// Gravitas vault: local-first document store (browser adaptation of the Rust/SQLite pillar).
// - Folder intake via File System Access API (showDirectoryPicker) + drag-drop + file picker
// - Mass = word count + reference frequency. Connections = [[wikilinks]] + shared tags.
const LS_KEY = 'gravitas.v1';
const TABS_KEY = 'gravitas.tabsV1'; // multi-canvas store: {tabs:[{id,name,docs,activeId,main,assoc:[tabIds]}], activeTabId} (assoc is mutual; empty = isolated)
const STOP = new Set(('a,about,above,after,again,against,all,also,am,an,and,any,are,as,at,be,because,been,before,being,below,between,both,but,by,can,could,did,do,does,doing,down,during,each,few,for,from,further,had,has,have,having,he,her,here,hers,herself,him,himself,his,how,if,in,into,is,it,its,itself,more,most,nor,not,of,off,on,once,only,or,other,ought,our,ours,out,over,own,same,should,such,than,that,the,their,them,then,there,these,they,this,those,through,under,until,very,was,were,what,when,where,which,while,who,whom,why,with,would,your,will,just,often,however,therefore,thus,within,without,upon,along,among,used,using,use,study,studies,research,based,including,include,chapter,chapters,page,pages,table,tables,figure,figures,abstract,references,reference,appendix,method,methods,literature,introduction,conclusion,findings,analysis,et,al,via,per').split(','));

// reference lists are NOT what a document is about: a trailing References /
// Works Cited / Bibliography section repeats cited-author names dozens of times,
// which would otherwise forge "shared ground" between unrelated assignments that
// merely cite the same scholars. Strip that section (only) before topic analysis.
// Mass/word-count still uses the full text — this affects topic matching only.
function stripRefs(text) {
  const lines = String(text || '').split('\n');
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/^#+\s*/, '').trim().toLowerCase();
    if (l === 'references' || l === 'reference' || l === 'works cited' || l === 'bibliography') cut = i;
  }
  if (cut < 0) return String(text || '');
  // keep the body only if something substantial precedes the heading (else a doc
  // that IS mostly references keeps its text — never return an empty analysis)
  const head = lines.slice(0, cut).join('\n');
  return head.trim().length > 200 ? head : String(text || '');
}
function termFreq(text) {
  const m = new Map();
  for (const w of (String(text).toLowerCase().match(/[a-z]{4,}/g) || [])) {
    if (STOP.has(w)) continue;
    m.set(w, (m.get(w) || 0) + 1);
  }
  return m;
}

// corpus analysis: TF-IDF vectors per doc + pairwise topic similarity.
// Lets imported Office/PDF prose tether by what it's ABOUT, not just markup.
// idfFloor: idf is computed against max(docs, idfFloor) — a lone handful of docs
// pulled onto a small canvas share so much vocabulary that raw idf collapses and
// their sims sink below the gate, orphaning the very web that was copied over.
// The floor keeps small canvases comparable to the main universe (84+ docs).
function analyzeTopics(docs, idfFloor = 30) {
  const n = docs.length;
  const Neff = Math.max(n, idfFloor);
  const tf = new Map(); // id -> Map(term -> count)
  const df = new Map(); // term -> doc count
  for (const d of docs) {
    const f = termFreq(stripRefs(d.text));
    tf.set(d.id, f);
    for (const t of f.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = new Map();
  for (const [t, c] of df) idf.set(t, Math.log(1 + Neff / c));
  const vec = new Map(); // id -> Map(term -> tf*idf), norm
  const norm = new Map();
  for (const d of docs) {
    const v = new Map();
    let s = 0;
    for (const [t, c] of tf.get(d.id)) {
      const w = (1 + Math.log(c)) * idf.get(t);
      v.set(t, w); s += w * w;
    }
    vec.set(d.id, v); norm.set(d.id, Math.sqrt(s) || 1);
  }
  return { tf, idf, df, vec, norm };
}

function cosineTopic(a, b, T) {
  const va = T.vec.get(a.id), vb = T.vec.get(b.id);
  if (!va || !vb) return null;
  const [small, big] = va.size <= vb.size ? [va, vb] : [vb, va];
  let dot = 0;
  const shared = [];
  for (const [t, w] of small) {
    const w2 = big.get(t);
    if (w2 !== undefined) { dot += w * w2; shared.push([t, w + w2]); }
  }
  const sim = dot / (T.norm.get(a.id) * T.norm.get(b.id));
  if (!(sim > 0) || !shared.length) return null;
  // recognizable glue first: terms with high combined TF-IDF in BOTH docs
  // (rare one-off mentions sink; the words the docs are actually about float)
  shared.sort((x, y) => y[1] - x[1]);
  return { sim, shared: shared.map(s => s[0]) };
}

// distinctive high-contrast identity colors for isolated verses (shared blue is
// reserved for associated tabs, so the palette stays clear of it)
const ISO_COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#3bc9db', '#b197fc', '#f783ac', '#e8eef7'];

const normTitle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const uid = (p = 'd_') => p + Math.random().toString(36).slice(2, 10);

function parseDoc(text) {
  const links = [...String(text).matchAll(/\[\[([^\[\]]+?)\]\]/g)].map(m => m[1].trim().split('|')[0].trim()).filter(Boolean);
  const tags = [...String(text).matchAll(/(?:^|\s)#([A-Za-z0-9_\-/]{2,})/g)].map(m => m[1].toLowerCase());
  const words = (String(text).match(/\S+/g) || []).length;
  return { links, tags, words };
}

// Normalize one raw doc row from disk (backup file, localStorage, legacy
// store): every downstream consumer assumes id/name/text/words/links/tags
// exist, so a single ragged row (missing links, numeric text, …) used to
// throw mid-load and abort the whole restore as "not working". Fill, coerce
// and recompute instead — never throw for a ragged row.
function normalizeDoc(raw, fallbackName) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const id = (typeof r.id === 'string' && r.id.trim()) ? r.id.trim().slice(0, 64)
    : (typeof r.docId === 'string' && r.docId.trim()) ? r.docId.trim().slice(0, 64) : uid();
  const name = String(r.name || fallbackName || 'Untitled').trim().slice(0, 160) || 'Untitled';
  const text = (typeof r.text === 'string') ? r.text
    : (typeof r.body === 'string') ? r.body
    : (typeof r.content === 'string') ? r.content : '';
  let links = Array.isArray(r.links) ? r.links.map(String).map(s => s.trim()).filter(Boolean) : null;
  let tags = Array.isArray(r.tags) ? r.tags.map(String).map(s => s.trim().toLowerCase()).filter(Boolean) : null;
  let words = (typeof r.words === 'number' && isFinite(r.words) && r.words >= 0) ? Math.round(r.words) : null;
  if (links === null || tags === null || words === null) {
    let p = null;
    try { p = parseDoc(text); } catch { p = { links: [], tags: [], words: 0 }; }
    if (links === null) links = p.links;
    if (tags === null) tags = p.tags;
    if (words === null) words = (String(text).match(/\S+/g) || []).length;
  }
  const doc = { id, name, text, words, links, tags };
  const origin = (typeof r.origin === 'string' && r.origin.trim()) ? r.origin.trim().slice(0, 64) : undefined;
  if (origin) doc.origin = origin;
  if (typeof r.note === 'string' && r.note.trim()) doc.note = r.note.slice(0, 140);
  // preserve unknown future fields only when JSON-safe (skip functions/DOM)
  for (const k of ['createdAt', 'updatedAt', 'mtime', 'color']) {
    if (r[k] !== undefined && (typeof r[k] === 'string' || typeof r[k] === 'number')) doc[k] = r[k];
  }
  return doc;
}

export const vault = {
  tabs: [], // canvases: [{id, name, docs[], activeId}]
  activeTabId: null,
  tab() { return this.tabs.find(t => t.id === this.activeTabId) || this.tabs[0]; },
  get docs() { const t = this.tab(); return t ? t.docs : []; },
  set docs(v) { const t = this.tab(); if (t) t.docs = v; },
  topicSim: 0.10,   // min TF-IDF cosine to be a topic *candidate*
  topicShared: 3,   // min shared terms to be a topic *candidate*
  topicMaxDf: 1.0,  // shared terms must appear in at most this fraction of docs
  topicTopK: 5,     // each doc keeps tethers to at most its K closest topics
  topicIdfFloor: 30, // idf sample-size floor: small canvases stay comparable to big ones

  // normalize one raw doc row (backup restore, storage repair)
  normalizeDoc,
  // normalize raw tab rows (load + backup restore): ids, names, mutual assoc
  // lists. Legacy `disassociated:false` rows join the whole legacy shared
  // pool; legacy isolated rows start alone. Unknown/stale ids are dropped.
  // Ragged rows never throw: missing ids are minted, missing docs default to
  // [], and every doc passes through normalizeDoc so universe()/renderDoc()
  // can always assume id/name/text/words/links/tags exist.
  adoptTabs(rawTabs) {
    if (!Array.isArray(rawTabs) || !rawTabs.length) throw new Error('That backup has no canvases (tabs is empty).');
    const seenTabIds = new Set();
    const tabs = rawTabs.map((rt, ti) => {
      const t = (rt && typeof rt === 'object') ? rt : {};
      let id = (typeof t.id === 'string' && t.id.trim()) ? t.id.trim().slice(0, 64) : uid('tab_');
      while (seenTabIds.has(id)) id = uid('tab_');
      seenTabIds.add(id);
      const rawDocs = Array.isArray(t.docs) ? t.docs : (Array.isArray(t.documents) ? t.documents : []);
      const seenDocIds = new Set();
      const docs = rawDocs.map((rd, di) => {
        const d = normalizeDoc(rd, 'Untitled ' + (di + 1));
        while (seenDocIds.has(d.id)) d.id = uid();
        seenDocIds.add(d.id);
        if (d.origin && !seenDocIds.has(d.origin)) { /* cross-tab lineage stays as-is */ }
        return d;
      });
      // cross-tab duplicate doc ids (same body copied verbatim with the same id
      // instead of a fresh copy id) would collapse twin tracking — mint fresh
      // ids for repeats beyond the first occurrence across the whole file.
      return { id, name: String(t.name || ('Canvas ' + (ti + 1))).slice(0, 40), docs, _activeRaw: (t.activeId === null) ? null : (typeof t.activeId === 'string' ? t.activeId : undefined), main: t.main === true, assoc: Array.isArray(t.assoc) ? t.assoc.map(String) : null, color: (typeof t.color === 'string' && /^#[0-9a-f]{6}$/i.test(t.color)) ? t.color : null, _iso: t.disassociated === true };
    });
    // second pass: de-dupe doc ids ACROSS tabs (keep the first, mint the rest)
    {
      const seen = new Set();
      for (const t of tabs) for (const d of t.docs) {
        if (seen.has(d.id)) d.id = uid();
        seen.add(d.id);
      }
    }
    for (const t of tabs) {
      const ids = new Set(t.docs.map(d => d.id));
      if (t._activeRaw === null && t.docs.length) t.activeId = null; // explicit general state
      else if (typeof t._activeRaw === 'string' && ids.has(t._activeRaw)) t.activeId = t._activeRaw;
      else t.activeId = t.docs[0]?.id || null;
      delete t._activeRaw;
    }
    const ids = new Set(tabs.map(t => t.id));
    const pool = tabs.filter(t => !t._iso);
    for (const t of tabs) {
      if (t.assoc) t.assoc = [...new Set(t.assoc.filter(id => id !== t.id && ids.has(id)))];
      else if (!t._iso) t.assoc = pool.filter(x => x.id !== t.id).map(x => x.id);
      else t.assoc = [];
      delete t._iso;
    }
    if (!tabs.some(t => t.main)) tabs[0].main = true; // first/starting tab is the main verse
    this.tabs = tabs;
    this.ensureIsoColors();
    return tabs;
  },

  load() {
    try {
      const raw = localStorage.getItem(TABS_KEY);
      if (raw) {
        const o = JSON.parse(raw);
        if (o && Array.isArray(o.tabs) && o.tabs.length && o.tabs.every(t => t && (Array.isArray(t.docs) || Array.isArray(t.documents)))) {
          try {
            this.adoptTabs(o.tabs);
          } catch (e) { console.warn('stored tabs unusable, reseeding', e); throw e; }
          if (!this.tabs.some(t => t.id === o.activeTabId)) o.activeTabId = this.tabs[0].id;
          this.activeTabId = o.activeTabId;
          return;
        }
      }
    } catch { /* fall through to legacy migrate / seed */ }
    // first run with tabs: migrate the legacy single-universe store, else seed
    let docs = null;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && Array.isArray(d.docs) && d.docs.length) docs = d.docs;
      }
    } catch { /* fresh seed */ }
    if (!docs) docs = seedDocs();
    try { docs = docs.map((d, i) => normalizeDoc(d, 'Untitled ' + (i + 1))); } catch { docs = seedDocs(); }
    this.tabs = [{ id: uid('tab_'), name: 'Universe 1', docs, activeId: docs[0]?.id || null, main: true, assoc: [], color: null }];
    this.activeTabId = this.tabs[0].id;
    this.persist();
  },
  persist() {
    try { localStorage.setItem(TABS_KEY, JSON.stringify({ tabs: this.tabs, activeTabId: this.activeTabId })); }
    catch { /* quota / private mode */ }
  },
  reset() { this.docs = seedDocs(); this.persist(); },
  // ---------- canvases (top tabs): separate doc sets, copy bodies between them ----------
  createTab(name) {
    const clean = String(name || '').trim().slice(0, 40) || ('Universe ' + (this.tabs.length + 1));
    const t = { id: uid('tab_'), name: clean, docs: [], activeId: null, main: false, assoc: [], color: null };
    this.tabs.push(t);
    // new canvases join the active tab's association — the shared verse they were built from
    for (const s of this.scopeTabs()) {
      if (s.id === t.id) continue;
      if (!t.assoc.includes(s.id)) t.assoc.push(s.id);
      s.assoc = s.assoc || [];
      if (!s.assoc.includes(t.id)) s.assoc.push(t.id);
    }
    this.persist();
    return t;
  },
  closeTab(id) {
    if (this.tabs.length <= 1) return false;
    const i = this.tabs.findIndex(t => t.id === id);
    if (i < 0) return false;
    this.tabs.splice(i, 1);
    for (const t of this.tabs) if (t.assoc) t.assoc = t.assoc.filter(x => x !== id); // drop dead links
    this.ensureIsoColors(); // a close can strand a verse into isolation
    if (this.activeTabId === id) this.activeTabId = this.tabs[Math.max(0, i - 1)].id;
    if (!this.tabs.some(t => t.main)) this.tabs[0].main = true; // closing the main verse promotes the oldest tab
    this.persist();
    return true;
  },
  renameTab(id, name) {
    const t = this.tabs.find(t => t.id === id);
    if (!t) return null;
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) return null;
    t.name = clean;
    this.persist();
    return t;
  },
  // association: valid linked verse ids (mutual by construction, stale ids dropped)
  assocIds(t) {
    const tb = typeof t === 'string' ? this.tabs.find(x => x.id === t) : t;
    if (!tb) return [];
    return (tb.assoc || []).filter(id => id !== tb.id && this.tabs.some(x => x.id === id));
  },
  // isolated = a lone verse in a multi-verse universe (a single-verse universe is never "isolated")
  isIso(t) { return this.tabs.length > 1 && this.assocIds(t).length === 0; },
  // every isolated verse owns a distinctive palette color (kept when it links
  // and unlinks again, so its identity is stable). Shared tabs ignore it and
  // wear the shared accent instead.
  ensureIsoColors() {
    for (const t of this.tabs) {
      if (typeof t.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(t.color)) t.color = null;
      if (this.isIso(t) && !t.color) {
        const used = new Set(this.tabs.filter(x => x !== t && this.isIso(x) && x.color).map(x => x.color));
        const free = ISO_COLORS.filter(c => !used.has(c));
        const pool = free.length ? free : ISO_COLORS;
        t.color = pool[Math.floor(Math.random() * pool.length)];
      }
    }
    this.persist();
  },
  // slide a tab one slot left (-1) or right (+1). End tabs can only go one way.
  moveTab(id, dir) {
    const i = this.tabs.findIndex(t => t.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.tabs.length) return false;
    [this.tabs[i], this.tabs[j]] = [this.tabs[j], this.tabs[i]];
    this.persist();
    return true;
  },
  // link/unlink two verses (always mutual). Returns true when linked, false when unlinked.
  toggleAssoc(id, otherId) {
    const a = this.tabs.find(t => t.id === id), b = this.tabs.find(t => t.id === otherId);
    if (!a || !b || id === otherId) return null;
    a.assoc = a.assoc || []; b.assoc = b.assoc || [];
    const on = !a.assoc.includes(otherId);
    if (on) { a.assoc.push(otherId); if (!b.assoc.includes(id)) b.assoc.push(id); }
    else { a.assoc = a.assoc.filter(x => x !== otherId); b.assoc = b.assoc.filter(x => x !== id); }
    this.ensureIsoColors(); // newly isolated verses get their color here
    return on;
  },
  // interaction scope: the active tab plus every verse it is associated with
  // (copies, deletes, twins). A verse with no associations only ever touches itself.
  scopeTabs() {
    const a = this.tab();
    if (!a) return this.tabs.slice();
    const ids = new Set([a.id, ...this.assocIds(a)]);
    return this.tabs.filter(t => ids.has(t.id));
  },
  // copy (never move) a body to another canvas. Solo = just that body; otherwise its
  // shared-ground constellation travels too (topic tethers only — the same set the
  // isolated view shows), so the local web re-forms there. Bodies already present
  // (by name) are skipped.
  sendCopyTo(docId, tabId, solo = false) {
    const src = this.docs.find(d => d.id === docId);
    if (!src) return null;
    const want = new Set([docId]);
    if (!solo) {
      const { edges } = this.universe();
      for (const e of edges) {
        if (e.kind !== 'topic') continue; // refs/tags stay behind; shared ground travels
        if (e.source === docId) want.add(e.target);
        else if (e.target === docId) want.add(e.source);
      }
    }
    return this.copyIdsTo(tabId, [...want]);
  },
  // copy an explicit set of bodies (by id) into another canvas. Same skip + lineage
  // rules as sendCopyTo; the constellation picker uses this with a user-chosen set.
  copyIdsTo(tabId, ids) {
    const t = this.tabs.find(t => t.id === tabId);
    if (!t || t.id === this.activeTabId) return null;
    if (!new Set(this.scopeTabs().map(t => t.id)).has(tabId)) return null; // unassociated verses neither send nor receive copies
    const names = new Set(t.docs.map(x => x.name.toLowerCase()));
    const copied = [];
    let skipped = 0;
    for (const d of this.docs.filter(d => ids.includes(d.id))) {
      if (names.has(d.name.toLowerCase())) { skipped++; continue; } // already there
      const c = { id: uid(), name: d.name, text: d.text, words: d.words, links: [...d.links], tags: [...d.tags], origin: d.origin || d.id };
      t.docs.push(c);
      names.add(c.name.toLowerCase());
      copied.push(c);
    }
    this.persist();
    return { copied, skipped };
  },
  // delete scope: active tab + every tab it interacts with (associated cluster).
  // A verse with no associations purges only itself; deletes never reach
  // unassociated verses. Finds every copy by lineage (origin survives renames)
  // plus same-name duplicates ("Report (2).md" stems match "Report.md").
  // Returns total bodies removed.
  removeEverywhere(docId) {
    const all = this.tabs.flatMap(t => t.docs);
    const d = this.docs.find(d => d.id === docId) || all.find(d => d.id === docId);
    if (!d) return 0;
    const root = d.origin || d.id;
    const stem = (n) => String(n || '').toLowerCase().replace(/\s\(\d+\)(\.[^.]+)?$/, '$1');
    const nm = stem(d.name);
    const scope = new Set(this.scopeTabs().map(t => t.id));
    let n = 0;
    for (const t of this.tabs) {
      if (!scope.has(t.id)) continue; // isolated verses keep their copies
      const before = t.docs.length;
      t.docs = t.docs.filter(x => !(x.id === docId || x.id === root || x.origin === root || stem(x.name) === nm));
      n += before - t.docs.length;
    }
    this.persist();
    return n;
  },

  titleOf(d) { return (d.name || 'Untitled').replace(/\.(md|markdown|txt|csv|pdf|docx?|xlsx?|pptx?)$/i, ''); },
  byId(id) { return this.docs.find(d => d.id === id) || null; },
  byIdAnywhere(id) { return this.byId(id) || this.tabs.flatMap(t => t.docs || []).find(d => d.id === id) || null; }, // whole-docuverse thematic: members may live on other canvases
  byTitle(t) {
    const c = String(t || '').trim().toLowerCase().replace(/\.(md|markdown|txt|csv|pdf|docx?|xlsx?|pptx?)$/i, '');
    return this.docs.find(d => this.titleOf(d).toLowerCase() === c) || null;
  },

  addFile(name, text) {    const clean = String(name || 'untitled').trim() || 'untitled';
    const p = parseDoc(text);
    const d = { id: uid(), name: clean, text: String(text), words: p.words, links: p.links, tags: p.tags };
    // dedupe by name
    let n = clean, i = 1;
    const names = new Set(this.docs.map(x => x.name.toLowerCase()));
    while (names.has(n.toLowerCase())) { i++; n = clean.replace(/(\.[^.]+)?$/, ` (${i})$1`); }
    d.name = n;
    this.docs.push(d);
    this.persist();
    return d;
  },

  rename(id, title) {
    const d = this.byId(id);
    if (!d) return null;
    const clean = String(title || '').trim().replace(/[\\/:*?"<>|]/g, '') || 'Untitled';
    const ext = (d.name.match(/\.[^.]+$/) || [''])[0];
    d.name = clean + ext;
    this.persist();
    return d;
  },

  remove(id) {
    const i = this.docs.findIndex(d => d.id === id);
    if (i < 0) return false;
    this.docs.splice(i, 1);
    this.persist();
    return true;
  },

  // mass = word count + reference frequency (explicit refs AND topic resonance).
  // degMap: id -> count of topic-neighbors (computed in universe()).
  // docs/byTitle default to the active tab; the whole-docuverse thematic passes
  // every canvas's docs so masses and title lookups span the full corpus.
  masses(degMap, docs, byTitle) {
    docs = docs || this.docs;
    byTitle = byTitle || ((t) => this.byTitle(t));
    const inCount = new Map(docs.map(d => [d.id, 0]));
    for (const d of docs) {
      for (const t of d.links) {
        const hit = byTitle(t);
        if (hit) inCount.set(hit.id, inCount.get(hit.id) + 1);
      }
    }
    const tagOwners = new Map();
    for (const d of docs) for (const t of d.tags) {
      if (!tagOwners.has(t)) tagOwners.set(t, new Set());
      tagOwners.get(t).add(d.id);
    }
    const out = new Map();
    for (const d of docs) {
      let refs = inCount.get(d.id) + d.links.length;
      for (const t of d.tags) refs += Math.max(0, (tagOwners.get(t)?.size || 1) - 1) * 0.5;
      refs += (degMap?.get(d.id) || 0) * 1.0;
      out.set(d.id, 2 + d.words / 150 + refs * 1.5);
    }
    return out;
  },

  // bodies[]: {id,label,mass,tags,words}  links[]: {source,target,kind,topics?}
  // kinds: ref ([[link]] or title mention) · tag (shared #tag) · topic (shared vocabulary)
  // docs defaults to the active tab; the whole-docuverse thematic passes every
  // canvas's docs so the web spans the full corpus, not just one tab.
  universe(docs) {
    docs = docs || this.docs;
    const self = this;
    const byTitle = (t) => {
      const c = String(t || '').trim().toLowerCase().replace(/\.(md|markdown|txt|csv|pdf|docx?|xlsx?|pptx?)$/i, '');
      return docs.find(d => self.titleOf(d).toLowerCase() === c) || null;
    };
    const T = analyzeTopics(docs, this.topicIdfFloor ?? 30);
    // topic adjacency first (masses need it)
    const topicDeg = new Map(docs.map(d => [d.id, 0]));
    const cand = []; // every above-bar pair, ranked — each doc keeps its TOP-K
    for (let i = 0; i < docs.length; i++) {
      for (let j = i + 1; j < docs.length; j++) {
        const a = docs[i], b = docs[j];
        const r = cosineTopic(a, b, T);
        if (!r) continue;
        const sig = r.shared.filter(t => (T.df.get(t) || 0) <= docs.length * (this.topicMaxDf ?? 1));
        if (r.sim >= (this.topicSim ?? 0.10) && sig.length >= (this.topicShared ?? 3)) {
          cand.push({ a, b, sim: r.sim, terms: r.shared.slice(0, 5) });
        }
      }
    }
    cand.sort((x, y) => y.sim - x.sim);
    const K = this.topicTopK ?? 5;
    const topicPairs = [];
    for (const c of cand) {
      if ((topicDeg.get(c.a.id) || 0) >= K || (topicDeg.get(c.b.id) || 0) >= K) continue;
      topicDeg.set(c.a.id, topicDeg.get(c.a.id) + 1);
      topicDeg.set(c.b.id, topicDeg.get(c.b.id) + 1);
      topicPairs.push([c.a.id, c.b.id, c.terms, c.sim]);
    }
    const masses = this.masses(topicDeg, docs, byTitle);
    const bodies = docs.map(d => ({
      id: d.id, label: this.titleOf(d), mass: masses.get(d.id) || 2,
      tags: d.tags, words: d.words, origin: d.origin || d.id,
    }));
    const edges = [];
    const seen = new Set();
    const push = (a, b, kind, topics, sim) => {
      if (a === b) return;
      const k = a < b ? a + '|' + b : b + '|' + a;
      if (seen.has(k)) return;
      seen.add(k); edges.push({ source: a, target: b, kind, topics, sim });
    };
    // title mentions: doc A names doc B's title in plain prose → a ref tether
    const titles = new Map(docs.map(d => [d.id, normTitle(this.titleOf(d))]));
    for (const d of docs) {
      const body = String(d.text).toLowerCase();
      for (const o of docs) {
        if (o.id === d.id) continue;
        const t = titles.get(o.id);
        if (t && t.length >= 8 && body.includes(t)) push(d.id, o.id, 'ref');
      }
      for (const t of d.links) {
        const hit = byTitle(t);
        if (hit) push(d.id, hit.id, 'ref');
        // dangling targets still count for mass, but render as comets, not ghosts
      }
      for (const o of docs) {
        if (o.id >= d.id) continue;
        if (o.tags.some(t => d.tags.includes(t))) push(d.id, o.id, 'tag');
      }
    }
    for (const [a, b, shared, sim] of topicPairs) push(a, b, 'topic', shared, sim);
    return { bodies, edges };
  },

  search(q) {
    q = String(q || '').trim().toLowerCase();
    // tag pills (and typed queries) carry a '#' prefix, but tags, titles and
    // prose are stored/matched without it — strip it so '#education' finds the
    // same bodies 'education' would (literal '#tag' prose still matches below).
    if (q.startsWith('#')) q = q.slice(1).trim();
    if (!q) return [];
    return this.docs
      .map(d => {
        const t = this.titleOf(d).toLowerCase();
        let s = -1;
        if (t === q) s = 100;
        else if (t.startsWith(q)) s = 80;
        else if (t.includes(q)) s = 60;
        else if (d.tags.join(' ').includes(q)) s = 40;
        else if (d.text.toLowerCase().includes(q)) s = 20;
        return s >= 0 ? { doc: d, score: s } : null;
      })
      .filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 12);
  },
};

function D(name, text) {
  const p = parseDoc(text);
  return { id: uid(), name, text, words: p.words, links: p.links, tags: p.tags };
}

function seedDocs() {
  return [
    D('Gravity Primer.md', `# Gravity Primer

Gravity equals relevance. Bodies with more words and more references pull harder.
Everything orbits the active document — the sun of this system. #physics #gravity

Linked ideas: [[Orbital Mechanics]] and [[Mission Log]].`),
    D('Orbital Mechanics.md', `# Orbital Mechanics

Circular orbits need tangential velocity v = sqrt(G*M/r). Too slow and the body
falls in; too fast and it escapes into the dark. Springs hold linked pairs at a
stable distance like rigid tethers. #physics #orbits

See [[Gravity Primer]] and the [[Star Chart]].`),
    D('Mission Log.md', `# Mission Log

Day 14: the universe is stable. Unlinked comets drift outward past the Kuiper
line while the inner system hums. Focus shifts are smooth — the old sun cools,
the new one ignites. #journal #orbits

Ref: [[Gravity Primer]].`),
    D('Star Chart.md', `# Star Chart

A catalogue of every body: mass from word count, brightness from references.
Dense clusters mark hot topics. #catalog #physics

Cross-check [[Orbital Mechanics]] and [[Comet Registry]].`),
    D('Comet Registry.md', `# Comet Registry

Orphans with no links drift outward like distant comets. They are not lost —
a single reference can capture them back into the system. #catalog

Related: [[Star Chart]].`),
    D('Deep Field Notes.md', `# Deep Field Notes

Observations from the edge of the vault. Faint bodies, weak pull, long years.
Nothing here links anywhere — yet. #journal`),
    D('Engine Room.md', `# Engine Room

N-body gravity plus Hooke springs plus comet drift, integrated semi-implicitly
at a fixed timestep with damping. Deterministic, stable, endless. #physics #engines

Tune via [[Gravity Primer]].`),
    D('Gardener Almanac.md', `# Gardener Almanac

Plant by the moon, water by the rain. A quiet life far from the inner planets,
sharing only the tag-soil with the rest of the vault. #soil #journal`),
    D('Soil Samples.md', `# Soil Samples

Nitrogen, loam, patience. The garden cluster holds together through shared tags
alone — no explicit references needed. #soil`),
    D('Lone Signal.txt', `A narrow-band transmission from outside the system.
No links. No tags. Just drifting.`),
  ];
}
