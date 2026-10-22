# DocuVerse — living 3D document universe

Web adaptation of the Tauri spec: no Rust/React — vanilla JS + Canvas 2D with a
custom 3D projection renderer. Vault persists in `localStorage` (`gravitas.v1`).

## Files
- `index.html` — shell + CSS + boot (`src/app.js`)
- `src/vault.js` — local doc store, intake, mass = words + refs, links/tags parse,
  TF-IDF topic correlation (topicSim/topicShared/topicMaxDf gates, topK cap,
  idf sample floor so small canvases keep webs comparable to the big universe)
- `src/physics.js` — N-body gravity, orbital-velocity init, Hooke springs, comets
- `src/render.js` — orbit camera + perspective projection, glow nodes, neon beams
- `src/app.js` — wiring, panels, folder/file/drop intake, search, universe speed
  controls (Pause + log slow-motion slider), body context menu + properties dialog

## Physics (tuned, verified headless)
- Sun (active doc) mass 600 at origin; satellites `v = sqrt(G*M/r)` tangential.
- The 600 is a physics override — every node keeps its vault mass in `trueMass`,
  which is what the meta line + Properties show, and what an ex-sun is restored to.- Linked bodies: shell tethers by BFS depth (150/250/350) + radial braking
  (no isotropic drag — it eats orbits). Peer springs (sun bonds are gravity's).
- Corona: mass-scaled radiation pressure below r=55 — nothing is swallowed.
- Comets (degree 0): outward drift, soft rim cap 1400. vmax 30, dt 0.3.
- Focus: new sun GLIDES home (never teleports); old sun shoved off-center and
  blended to orbital velocity. Bounds after transitions: 50 < r < 1500.
- General state (no active body): off-click into empty space releases the sun
  (`Universe.defocus()` restores its vault mass); the canvas center itself pulls
  with sunMass so the lens holds together and orbits the origin. Orbital-velocity
  init and shell memory keep the formation instead of rescattering.

## Intake formats
- `.md/.markdown/.txt/.csv` plain text · `.pdf` (pdf.js) · `.docx` (mammoth) ·
  `.xlsx/.xls` (SheetJS, per-sheet CSV) · `.pptx` (slide text) · legacy
  `.doc/.ppt` rejected with a re-save message · exact-duplicate text skipped.
- Every import auto-focuses as the sun; failures toast the real reason (6s).
- Names are trimmed (`"report.docx "` works), extensionless-but-typed files are
  accepted by MIME, and skips are named in the toast (`"archive.zip" .zip …`).
- Folder button + drag-drop recurse into subfolders (File System Access when
  available, `webkitdirectory`/DataTransfer entries otherwise, 60-file cap).

## Labels
- Left panel Labels row: slider 0–150% for file-name size under bodies
  (far left = hidden), button toggles show/hide (restores last nonzero).
  Persisted in `gravitas.ui` as lbScale/lbLast, applied as ren.labelScale.

## Background shade
- Left panel Shade row (under Labels): slider 0–100% for canvas background
  brightness — far left = flat white, far right = black deep-space (as today);
  button flips between the two extremes. Label ink, selection rings and the
  starfield invert with the shade so text stays readable on white.
  Persisted in `gravitas.ui` as bgShade, applied as ren.bgShade, and included
  in cloud backups / master files (`settings.bgShade`).

## Glow radius
- Left panel Glow row (under Shade): slider for the halo radius around bodies —
  far left = no glow, middle (50) = current look, far right = double radius;
  button toggles glow on/off (restores last nonzero). Persisted in
  `gravitas.ui` as glow/glowLast, applied as ren.glowScale, and included in
  cloud backups / master files (`settings.glow`).

## Tether thickness
- Left panel Tether row (under Glow): slider for tether line thickness —
  far left = hidden, middle (50) = current look, far right = double thickness;
  button toggles tethers on/off (restores last nonzero). Persisted in
  `gravitas.ui` as tether/tetherLast, applied as ren.tetherScale, and included
  in cloud backups / master files (`settings.tether`).
- The palette swatches in the same row set the tether color (persisted as
  `tetherColor`). The active body's shared-ground tethers auto-contrast:
  the renderer derives their color as the complementary hue of the selected
  tether color (vividness enforced, achromatic picks land on cyan), so the
  shared-ground links always stand apart — default sky-blue tethers keep
  the classic gold shared-ground links.

## Column collapse
- ▲ arrows at the top-right of the DocuVerse column and the Active Body column
  shrink that column upward into a slim top tab (▼ restores it). Persisted in
  `gravitas.ui` and in cloud backups / master files.

## Tethers toggle (bottom pill)
- ◉ Tethers button in the bottom hint pill: shows/hides the tether lines
  between bodies — bodies themselves always stay put. It drives the same
  setting as the left-panel Tether row, so both stay in sync. (The hint pill
  hides on narrow phone screens, so this shortcut is desktop-wide only.)
- ◉ Distribute button next to Thematic: auto-distribute pins every body in a
  fit-to-canvas orb (sun at the center, other bodies on mass-ranked fibonacci
  shells, scaled to an ellipse matching the viewport) and freezes orbital
  motion — pan/zoom/orbit still work, but bodies hold still with zero drift.
  Toggling off restores orbital dynamics from the orb. Persisted in
  `gravitas.ui`.
- ○ Simple Orb button after Distribute: renders every body as a flat white
  disc with a thin black outline — gradient shading, glow halos and
  photo-texture overlays are all skipped (labels, tethers, selection rings
  stay). Toggling off restores the textured orbs. Persisted in
  `gravitas.ui`.
- ○ Simple Orb 2 button after Simple Orb: keeps the original blue orbs
  (gradients + glow halos) but strips only the photo-texture overlays.
  Mutually exclusive with Simple Orb — turning one on turns the other off.
  Toggling off restores the photo overlays. Persisted in `gravitas.ui`.

## Thematic lens (bottom pill)
- ◉ Thematic button next to Tethers: the universe holds THEME BODIES ONLY —
  no doc bodies. Co-related concepts (terms that travel together across the
  shared-vocabulary web) are distilled into first-class theme bodies labeled
  with their concepts (e.g. "self-efficacy · alignment").
- Each theme's mass follows its thematic weight, so heavier themes pull harder
  and anchor their clusters under the same orbital mechanics and slider
  settings. Themes web together through shared grounded docs (every theme gets
  ≥1 tether — nothing drifts off); explicit [[ref]] tethers are left out so
  citation structure can't warp the map.
- Theme hygiene: a concept must evidence in ≥3 docs (≥2 on small canvases) to
  seed or join a theme, so one-off citation surnames never become labels; a
  term present in the full text of more than ~30% of the corpus ("teacher",
  "report", "canvas" …) is treated as boilerplate wallpaper and can neither
  seed nor join either. The lens opens pre-settled — clusters arrive webbed
  even when the universe is paused or at slow-motion.
- Clicking a theme shows its concepts + grounded member bodies; clicking a
  member drills down — the lens exits and the doc opens as sun in the regular
  view. Search in the lens lights up the themes grounding the hits. Toggling
  off restores the regular universe exactly as it was (formation included).
  The lens persists across canvas switches, in `gravitas.ui`, and in cloud
  backups / master files.
- General state: off-click into empty space releases the sun (◌ GENERAL STATE
  — CENTER GRAVITY) — no active body, the canvas center holds gravity, and the
  reader shows a live overview (counts + largest bodies as drill-down rows).
  It survives canvas switches and reloads; clicking any body claims a new sun.
- Whole docuverse: pressing Thematic with nothing selected distills EVERY
  shared canvas at once (copies deduped by lineage; isolated verses stay out)
  into one theme map (◉ Thematic ⋃, kicker ◈ THEMATIC — WHOLE DOCUVERSE).
  Member rows can ground bodies from other canvases — clicking one jumps to
  that canvas and opens the doc as sun.

## Canvases (top tabs)
- The dark pill at the top holds one tab per DocuVerse canvas. Tabs are separate
  doc sets — switch to compartmentalize views, or copy bodies between canvases
  (right-click a body → Copy to …) to build related constellations elsewhere.
- Right-click a body for two delete scopes: Remove from this canvas (stays
  everywhere else) vs Delete from entire universe (purges every copy on every
  canvas, found by copy-lineage even after renames, plus same-name duplicates).
- Box-select: shift-drag stretches a crisp selection box (shift-click toggles
  one body, plain click / Esc clears). Right-click the selection for two more
  delete scopes, both confined to the active tab (other canvases keep their
  copies): delete just the selected bodies + their docs, or delete the entire
  tab universe + docs.
- + creates a canvas (starts empty), × closes one (confirm; its bodies are
  deleted), double-click renames. Right-click offers solo copy (just this body)
  or constellation copy (a picker lists every proposed body with the shared
  words behind it — uncheck anything that shouldn't travel, so nothing random
  ever arrives). The transferred sun becomes the destination canvas's new sun
  (when it travels — otherwise that canvas keeps its own). Bodies already there
  are skipped.
- Quantum twins: a copy mirrors its original's live position and velocity in
  every canvas, each frame (first canvas holding the root is the source of
  truth) — transferred bodies keep the exact same rotation and motion as the
  main canvas. Each canvas also keeps its own persistent universe, so switching
  tabs never re-scatters formations. Each canvas remembers its own sun — or its sunless general state.

## Sticky notes (140 chars per body)
- One sticky note per body, stored on the vault doc (persisted in localStorage,
  cloud backups and master files). Click its yellow square — drawn tight to the
  left of the label, sized to the label's font height, with ruled-line texture —
  to open a floating editor (140-char counter, Save / Delete / Cancel) without
  moving the sun. Bodies with notes show a solid square; the sun shows a dashed
  hollow placeholder so a first note can be created in-canvas. Right-clicking a
  body offers the same editor via a "Sticky note…" menu item.
- DocuVerse pane: "View notes: All / Active body" checkboxes (both ticked by
  default, persisted in `gravitas.ui`). All shows solid yellow squares only on
  bodies that actually have notes — never placeholders. Active body always
  marks the selected body: solid when it has a note, hollow frame when not.
- Active-body reader: yellow `notes` button after the tag pills opens a pop-out
  with the note plus `copy` / `delete` captions (top-right), `edit` and `✕`.
  Empty pop-outs offer an inline add form. Every mutation re-renders both
  mirrors (square + pop-out); copy uses the clipboard with a fallback.
- Glass finish: the DocuVerse, Active body and Cloud panes share a crisp glass
  overlay — diagonal sheen gradients + 18px blur/saturate, painted as the pane
  background so all text, toggles, thumbnails and filenames render in front.
  On a white canvas (`body.light-canvas`) the same panes deepen to a near-solid
  dark base with muted sheen and a harder edge/shadow so they stay sharp and
  readable; the black-canvas look is untouched.
  Each pane has a small glossy dot in its top-right corner that toggles its own
  glass off (flat background, dimmed dot) and back on; hovering the dot shows
  an explainer caption. Per-pane state (`glazeLeft/glazeDoc/glazeCloud`,
  persisted in `gravitas.ui`); hidden when its pane is collapsed.

## Verse associations (link canvases)
- The top bar is labeled Active DocuVerse Projects; the first/starting tab is
  the ★ main verse. Right-click any tab for its associations menu: a
  checkable list of every other verse by full name (✓ linked, ○ unlinked,
  ★ main, isolated verses marked). Tapping a verse links or unlinks it —
  links are always mutual, the menu stays open for multi-select, and no
  confirms interrupt.
- A verse with no links is isolated (◌ dashed tab): uploads land only in
  that tab, searches/tags/indexes are already per-tab, copies neither leave
  nor enter (the body menu says so, with an associate hint), Delete spans
  only that tab, and quantum-twin lockstep skips it so its formation evolves
  independently. Copies made before an unlink stay untouched wherever they
  are. New canvases (+) join the association they were built from.
- Linked tabs wear the shared accent color in the top pill (blue tint,
  glowing when active); the moment a tab's last link is removed it drops to
  a dim dashed grey, and linking restores the shared color instantly.
- Every isolated verse owns a distinctive high-contrast identity color
  (assigned from a fixed palette, unused-first, kept when it links and
  unlinks again). While isolated the tab wears its color — solid border,
  tinted fill, matching glow; linking hands it the shared blue back.
- Tab order is user-arranged: each tab's menu has a Position section with
  "← Move left" / "Move right →" (end tabs offer only the one way that
  exists). Order persists, ships in backups, and never affects links.
- Closing the main verse promotes the oldest remaining tab to main; closing
  any verse drops its id from everyone else's link lists.
- Stored in `gravitas.tabsV1` as mutual `assoc` id lists (legacy
  `disassociated` flags migrate: shared rows join the legacy pool, isolated
  rows start alone; legacy `gravitas.v1` migrates into Universe 1 on first
  run); cloud backups / master files carry every canvas plus links.

## Reader pane
- Top of the pane is a SHARED GROUND hover menu (topic-tethered bodies +
  shared terms, up to 12); hover the label to open, tap it on touch, Esc or a
  selection closes it. Explicit [[links]] stay inline below as before.

## "?" explicators (editable in the editor, locked on desktop)
- All four helpers are editable: SHARED GROUND (? in the reader pane),
  mass (? in the doc meta line), system energy + rim (? in the left panel).
  Hover/tap a ? to read it, click its ✎ edit button to rewrite it.
- Wording persists in `localStorage` (`gravitas.help`) and rides along in
  cloud backups / master files (`settings.help`).
- The ✎ buttons only appear in the Perchance editor/preview (`body.help-can-edit`).
  Desktop shells are read-only: file:// / tauri: / wry: / app: protocols,
  Tauri/Electron user-agents, and `window.GRAVITAS_HELP_LOCKED === true` all
  hide the buttons. For a desktop export, add
  `<script>window.GRAVITAS_HELP_LOCKED = true</script>` before src/app.js
  (or append `?helpedit=0` to preview the locked state).

## Body overlays
- Each body gets a stable photo texture from `src/overlays/` (35 256px
  thumbs built from the Pexels set, manifest in `src/overlays.json`),
  picked + spun/mirrored by id hash so neighbours differ; sun keeps 45%.
- Left panel: Overlay slider = opacity (persisted in `gravitas.ui`),
  Overlay button = on/off toggle (restores last nonzero). Loader is
  index-stable: a failed image leaves that body gradient.

## Cloud backup (bottom-left box)
- Push backup → JSON snapshot (live src/* + main.pjs via API + vault docs +
  settings) uploaded to a permanent uploads.dev URL; last 8 kept in
  `gravitas.backups`. Master file = same schema, downloaded locally.
- Load… restores a master file (confirm → prefs + docs + rebuild, with an
  explicit "already matches — nothing changed" line when the file holds the
  same docs). Merge… adds the file's documents into the current canvas instead
  (keeps what is open; exact-text duplicates are skipped, same-name arrivals
  land as "Name (2).md"). Dropping a downloaded
  `docuverse-master-settings.json` onto the canvas offers the Load path. The
  loader accepts current files plus tabs-only / vault-only / legacy `{docs}` /
  bare-array shapes, normalizes ragged doc rows (missing id/links/tags/words
  are repaired, never abort the restore), and reports the exact problem (bad
  JSON vs not-a-backup vs empty) instead of silently doing nothing. All
  personalization ships in `settings` (speed, overlay, labels, shade, glow,
  tether + color, backdrop, panes, glaze, collapse, width, lens, notes filters,
  topics, help wording).
- index.html isn't fetchable at runtime in preview, so the shell is
  best-effort (saved-page fallback) — src/ + main.pjs carry all logic.

## Licensing (Option A — Gumroad verify + local persistence)
- First launch shows an Activate modal (logo, key field, Get-a-key link to
  `https://gumroad.com/l/ltsmdc`). One key = one device (seat limit 1).
- `src/license.js` verifies once via
  `POST https://api.gumroad.com/v2/licenses/verify`
  (`product_permalink=ltsmdc`, `increment_uses_count=true`) and caches the
  activation in `localStorage` (`docuverse.license.v1`) for 30 days offline.
  Silent re-checks use `increment_uses_count=false` (no seat consumed).
- Keys already showing >1 use are refused — reset uses in Gumroad (Customers
  → sale → reset uses) for reinstalls. CloudBox shows `Licensed: <email>`
  with a per-device deactivate (server-side uses still need a Gumroad reset).
- `LICENSE.enforceOnWeb` gates the web build too; set `false` to only gate
  desktop shells (Tauri / file://). `src/icon.png` (master) + `src/icon-512.png`
  (tab icon, also `$meta.icon`) are the packaged icons.
- Desktop shells: scaffold + build recipe in `src/tools/desktop/`
  (Tauri v2: `.dmg` arm64/x64, `.msi`/NSIS `.exe` x64). Installers must be
  compiled on a Mac / Windows machine — see `README-DESKTOP.md`.
- Client-side checks are bypassable by design — casual licensing, not DRM.
  Never put Gumroad access tokens in this code; only the public permalink +
  the customer-typed key are ever sent.

## Gotchas
- `caretRangeFromPoint`-style APIs don't apply; picking is manual screen-space.
- Synthetic pointer events work for tests (native caret rules don't apply here).
- window.__gravitas = {uni, ren, vault, activeId, ingestFiles, getDropFiles} debug handle.
- showDirectoryPicker used when available, else file picker fallback.
