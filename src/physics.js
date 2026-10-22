// Gravitas orbital engine: true N-body gravity around an active-doc sun,
// tangential orbital-velocity init, Hooke spring tethers, orphan comet drift.
// Semi-implicit Euler at fixed dt with damping. Pure math — no DOM.
export class PhysicsNode {
  constructor(id, label, mass, x, y, z, isActive = false) {
    this.id = id;
    this.label = label;
    this.mass = mass;
    this.radius = isActive ? 10 : Math.max(5, Math.sqrt(mass) * 1.8);
    this.x = x; this.y = y; this.z = z;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.fx = 0; this.fy = 0; this.fz = 0;
    this.isActive = isActive;
    this.deg = 0;
  }
  applyForce(fx, fy, fz) { this.fx += fx; this.fy += fy; this.fz += fz; }
  update(damping = 0.985, dt = 0.4) {
    this.vx += (this.fx / this.mass) * dt;
    this.vy += (this.fy / this.mass) * dt;
    this.vz += (this.fz / this.mass) * dt;
    this.vx *= damping; this.vy *= damping; this.vz *= damping;
    this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;
    this.fx = 0; this.fy = 0; this.fz = 0;
  }
  speed() { return Math.hypot(this.vx, this.vy, this.vz); }
}

const rnd = (a, b) => a + Math.random() * (b - a);

export class Universe {
  constructor(opts = {}) {
    this.G = opts.G ?? 25;              // gravitational constant (tuned units)
    this.sunMass = opts.sunMass ?? 600; // the active document's enforced mass
    this.springK = opts.springK ?? 0.04;
    this.restLen = opts.restLen ?? 170;
    this.damping = opts.damping ?? 0.999; // whisper-light: orbits must not decay
    this.dt = opts.dt ?? 0.3;
    this.shellK = opts.shellK ?? 0.15;  // guiding-center tether to shell radius (dominant, stable)
    this.vmax = opts.vmax ?? 30;        // cruise-speed cap (no slingshot escapes)
    this.cometPush = opts.cometPush ?? 26; // outward drift for orphans
    this.cometCap = opts.cometCap ?? 1400; // soft rim of the observable universe
    this.coronaR = opts.coronaR ?? 55;  // radiation pressure: nothing is swallowed
    this.coronaK = opts.coronaK ?? 0.5; // (mass-scaled, so it beats gravity for all bodies)
    this.shells = opts.shells ?? [150, 250, 350]; // orbit radii by link depth
    this.nodes = [];
    this.edges = [];
    this.byId = new Map();
    this.sunId = null;
  }

  setData(bodies, edges, sunId) {
    const old = this.byId;
    this.edges = (edges || []).map(e => ({ source: e.source, target: e.target, kind: e.kind || 'ref' }));
    // explicit null = general state (no sun — the canvas center holds gravity);
    // undefined = legacy default to the first body.
    if (sunId === undefined) sunId = bodies[0]?.id || null;
    this.sunId = sunId && bodies.some(b => b.id === sunId) ? sunId : null;
    // BFS depth from the sun -> orbital shells
    const adj = new Map();
    for (const e of this.edges) {
      if (!adj.has(e.source)) adj.set(e.source, []);
      if (!adj.has(e.target)) adj.set(e.target, []);
      adj.get(e.source).push(e.target);
      adj.get(e.target).push(e.source);
    }
    const depth = new Map();
    if (this.sunId) {
      depth.set(this.sunId, 0);
      const q = [this.sunId];
      while (q.length) {
        const id = q.shift();
        for (const nb of (adj.get(id) || [])) {
          if (!depth.has(nb)) { depth.set(nb, depth.get(id) + 1); q.push(nb); }
        }
      }
    }
    this.nodes = bodies.map((b) => {
      const o = old.get(b.id);
      const active = b.id === this.sunId;
      const d = depth.has(b.id) ? depth.get(b.id) : -1;
      // sunless (general state): no BFS depths — incumbents keep their shells so
      // the formation holds instead of rescattering; newcomers take the outer shell.
      const shell = d < 0 ? ((o && o.shell) || this.shells[2] * 1.5) : d === 0 ? 0 : this.shells[Math.min(d - 1, this.shells.length - 1)];
      const n = new PhysicsNode(b.id, b.label, active ? this.sunMass : Math.max(1.5, b.mass), o ? o.x : 0, o ? o.y : 0, o ? o.z : 0, active);
      n.trueMass = Math.max(1.5, b.mass); // vault mass: survives the sun's 600 override (display + defocus restore)
      n.origin = b.origin || b.id; // copy-lineage root: quantum lock across canvases
      n.depth = d;
      n.shell = shell;
      n.tags = b.tags || [];
      n.phase = hash01(b.id) * 6.283; // stable pulse offset
      if (!o) {
        // seat newcomers on their shell sphere, sun at origin
        const th = rnd(0, Math.PI * 2), ph = Math.acos(rnd(-1, 1));
        const R = shell || 1;
        n.x = R * Math.sin(ph) * Math.cos(th);
        n.y = R * Math.sin(ph) * Math.sin(th) * 0.7;
        n.z = R * Math.cos(ph);
      }
      return n;
    });
    this.byId = new Map(this.nodes.map(n => [n.id, n]));
    for (const e of this.edges) {
      const a = this.byId.get(e.source), b = this.byId.get(e.target);
      if (a) a.deg++; if (b) b.deg++;
    }
    this.initOrbitals(1); // full orbital-velocity init on (re)build
  }

  // give every satellite its circular-orbit tangential velocity v = sqrt(G*M/r)
  // blend 0..1 (1 = snap, ~0.3 = smooth focus-transition glide). Positions are
  // never touched here — guiding tethers glide bodies to new shells on their own.
  initOrbitals(blend = 1, seatSun = true) {
    const sun = this.byId.get(this.sunId);
    // general state (no sun): the center itself pulls with sunMass, so every
    // body still gets a proper circular-orbit velocity around the origin.
    const M = sun ? sun.mass : this.sunMass;
    if (sun) {
      if (seatSun) { sun.x = sun.y = sun.z = 0; }
      sun.vx = sun.vy = sun.vz = 0;
    }
    for (const n of this.nodes) {
      if (n === sun) continue;
      const r = Math.max(40, Math.hypot(n.x, n.y, n.z) || 1);
      const dx = n.x / r, dy = n.y / r, dz = n.z / r;
      // tangential direction: radial × tilted axis (stable inclinations, no polar pile-up)
      const ax = 0.25, ay = 1, az = 0.35;
      const tx = dy * az - dz * ay, ty = dz * ax - dx * az, tz = dx * ay - dy * ax;
      const tl = Math.hypot(tx, ty, tz) || 1;
      const v = Math.sqrt(this.G * M / Math.max(40, r));
      const dir = (hash01(n.id) < 0.85) ? 1 : -1; // mostly prograde, some retrograde
      const nvx = (tx / tl) * v * dir, nvy = (ty / tl) * v * dir, nvz = (tz / tl) * v * dir;
      n.vx += (nvx - n.vx) * blend;
      n.vy += (nvy - n.vy) * blend;
      n.vz += (nvz - n.vz) * blend;
    }
  }

  // release the sun: the ex-sun cools back to its vault mass and the canvas
  // center becomes the gravitational center. Returns true when there was a sun.
  defocus() {
    const s = this.byId.get(this.sunId);
    if (s) { s.isActive = false; s.mass = s.trueMass != null ? s.trueMass : Math.max(1.5, s.mass === this.sunMass ? 6 : s.mass); s.radius = Math.max(5, Math.sqrt(s.mass) * 1.8); }
    const had = this.sunId != null;
    this.sunId = null;
    return had;
  }

  focus(id) {
    if (!this.byId.has(id) || id === this.sunId) return false;
    const old = this.byId.get(this.sunId);
    if (old) { old.isActive = false; old.mass = old.trueMass != null ? old.trueMass : Math.max(1.5, old.mass === this.sunMass ? 6 : old.mass); old.radius = Math.max(5, Math.sqrt(old.mass) * 1.8); }
    this.sunId = id;
    const sun = this.byId.get(id);
    sun.isActive = true; sun.mass = this.sunMass; sun.radius = 10;
    // re-shell by new BFS depths, then glide trajectories across (no teleport)
    const adj = new Map();
    for (const e of this.edges) {
      if (!adj.has(e.source)) adj.set(e.source, []);
      if (!adj.has(e.target)) adj.set(e.target, []);
      adj.get(e.source).push(e.target);
      adj.get(e.target).push(e.source);
    }
    const depth = new Map([[id, 0]]);
    const q = [id];
    while (q.length) {
      const cur = q.shift();
      for (const nb of (adj.get(cur) || [])) {
        if (!depth.has(nb)) { depth.set(nb, depth.get(cur) + 1); q.push(nb); }
      }
    }
    for (const n of this.nodes) {
      const d = depth.has(n.id) ? depth.get(n.id) : -1;
      n.depth = d;
      n.shell = d < 0 ? this.shells[2] * 1.5 : d === 0 ? 0 : this.shells[Math.min(d - 1, this.shells.length - 1)];
    }
    // the dethroned sun sits exactly at the origin with zero velocity — shove it
    // off-center so it catches a proper tangential velocity below
    if (old && Math.hypot(old.x, old.y, old.z) < 1) { old.x += 80; old.z += 40; }
    this.initOrbitals(0.35, false); // glide, never teleport: step() eases the sun home
    return true;
  }

  step(dt = this.dt) {
    const sun = this.byId.get(this.sunId);
    // 1. N-body gravity (softened) — sun dominates; satellite pairs whisper
    const ns = this.nodes;
    for (let i = 0; i < ns.length; i++) {
      const a = ns[i];
      for (let j = i + 1; j < ns.length; j++) {
        const b = ns[j];
        let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const r2 = dx * dx + dy * dy + dz * dz + 900; // softening
        const r = Math.sqrt(r2);
        const bothSat = a !== sun && b !== sun;
        const G = bothSat ? this.G * 0.02 : this.G; // satellites barely tug each other
        const f = G * a.mass * b.mass / r2;
        const ux = dx / r, uy = dy / r, uz = dz / r;
        a.applyForce(ux * f, uy * f, uz * f);
        b.applyForce(-ux * f, -uy * f, -uz * f);
      }
    }
    // 1b. general state (no sun): the canvas center is the gravitational center —
    // every body feels the pull of a central mass, so the lens holds together
    // and orbits the origin instead of drifting apart.
    if (!sun) {
      for (const n of ns) {
        const r2 = n.x * n.x + n.y * n.y + n.z * n.z + 900;
        const r = Math.sqrt(r2);
        const f = this.G * this.sunMass * n.mass / r2;
        n.applyForce(-n.x / r * f, -n.y / r * f, -n.z / r * f);
      }
    }
    // 2. Hooke springs along tethers
    for (const e of this.edges) {
      const a = this.byId.get(e.source), b = this.byId.get(e.target);
      if (!a || !b || a === sun || b === sun) continue; // sun-satellite bonds are gravity's job
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const r = Math.hypot(dx, dy, dz) || 1;
      const f = (r - this.restLen) * this.springK;
      const ux = dx / r, uy = dy / r, uz = dz / r;
      a.applyForce(ux * f, uy * f, uz * f);
      b.applyForce(-ux * f, -uy * f, -uz * f);
    }
    // 2b. solar corona: radiation pressure scales with body mass, so nothing
    // (however heavy) can ever fall into the sun — acceleration is mass-free
    for (const n of ns) {
      if (n === sun) continue;
      const r = Math.hypot(n.x, n.y, n.z) || 0.001;
      if (r < this.coronaR) {
        const f = (this.coronaR - r) * this.coronaK * n.mass;
        n.applyForce(n.x / r * f, n.y / r * f, n.z / r * f);
      }
    }
    // 3a. guiding-center tethers: linked bodies rest near their shell radius
    for (const n of ns) {
      if (n === sun || (n.deg || 0) === 0) continue;
      const r = Math.hypot(n.x, n.y, n.z) || 1;
      const want = n.shell || r;
      const f = (r - want) * this.shellK;
      n.applyForce(-n.x / r * f, -n.y / r * f, -n.z / r * f);
    }
    // 3b. orphan comet drift: isolates sail outward, soft-capped at the rim
    for (const n of ns) {
      if (n === sun || (n.deg || 0) > 0) continue;
      const r = Math.hypot(n.x, n.y, n.z) || 1;
      const f = r > this.cometCap
        ? -(r - this.cometCap) * 0.05 // beyond the rim: gentle pull back
        : this.cometPush / Math.max(1, r / 200);
      n.applyForce(n.x / r * f, n.y / r * f * 0.6, n.z / r * f);
    }
    // 4. integrate; the new sun glides home fast, then locks to the origin
    for (const n of ns) {
      if (n === sun) {
        n.vx = -n.x * 0.12; n.vy = -n.y * 0.12; n.vz = -n.z * 0.12;
        n.x += n.vx * dt * 4; n.y += n.vy * dt * 4; n.z += n.vz * dt * 4;
        if (Math.hypot(n.x, n.y, n.z) < 1) { n.x = n.y = n.z = 0; n.vx = n.vy = n.vz = 0; }
        n.fx = n.fy = n.fz = 0;
        continue;
      }
      // radial braking for tethered bodies: kills shell oscillation, spares orbit speed
      if ((n.deg || 0) > 0) {
        const r = Math.hypot(n.x, n.y, n.z) || 1;
        const ux = n.x / r, uy = n.y / r, uz = n.z / r;
        const vr = n.vx * ux + n.vy * uy + n.vz * uz;
        const brake = 0.9;
        n.vx -= ux * vr * (1 - brake);
        n.vy -= uy * vr * (1 - brake);
        n.vz -= uz * vr * (1 - brake);
      }
      n.update((n.deg || 0) > 0 ? 1.0 : this.damping, dt); // orbiters: no isotropic drag (it eats tangential speed); radial brake + tethers stabilize
      const sp = n.speed();
      if (sp > this.vmax) { // cruise-speed cap: no slingshot escapes
        const k = this.vmax / sp;
        n.vx *= k; n.vy *= k; n.vz *= k;
      }
      if (!Number.isFinite(n.x + n.y + n.z)) { // watchdog: reseat escapees
        n.x = n.shell || 200; n.y = 0; n.z = 0;
        n.vx = n.vy = n.vz = 0;
      }
    }
  }

  stats() {
    let e = 0, mx = 0;
    for (const n of this.nodes) { e += n.speed() * n.speed(); mx = Math.max(mx, Math.hypot(n.x, n.y, n.z)); }
    return { bodies: this.nodes.length, links: this.edges.length, ke: e, maxR: mx };
  }
}

function hash01(s) {
  let h = 7;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
  return (Math.abs(h) % 1000) / 1000;
}
