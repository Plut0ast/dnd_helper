// Rooms and line of sight, worked out from the walls the DM draws.
// Everything here is in screen pixels: points are { x, y }, segments are { a, b }.

const Sight = (() => {
  const EPS = 0.75; // points closer than this (px) count as touching

  const lerp = (s, t) => ({ x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t });

  // Where segment s is cut by other walls: their ends landing on it (T-junctions)
  // and walls crossing it. Returned as positions 0..1 along s.
  function cutsAlong(s, segs) {
    const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
    const len2 = dx * dx + dy * dy;
    const ts = [0, 1];
    for (const o of segs) {
      if (o === s) continue;
      for (const p of [o.a, o.b]) {
        const t = ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / len2;
        if (t <= 1e-6 || t >= 1 - 1e-6) continue;
        const q = lerp(s, t);
        if (Math.hypot(p.x - q.x, p.y - q.y) < EPS) ts.push(t);
      }
      const ex = o.b.x - o.a.x, ey = o.b.y - o.a.y;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const ax = o.a.x - s.a.x, ay = o.a.y - s.a.y;
      const t = (ax * ey - ay * ex) / den;
      const u = (ax * dy - ay * dx) / den;
      if (t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6) ts.push(t);
    }
    return ts.sort((p, q) => p - q);
  }

  // Closed rooms: loops of at least `minWalls` wall pieces joined end to end. Walls that
  // don't close a loop are ignored. Returns polygons (arrays of points).
  function findRooms(segs, minWalls = 4) {
    segs = segs.filter((s) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) >= EPS);

    // Graph of wall pieces, merging ends that touch.
    const nodes = [];
    const nodeAt = (p) => {
      let n = nodes.find((m) => Math.hypot(m.x - p.x, m.y - p.y) < EPS);
      if (!n) { n = { x: p.x, y: p.y, id: nodes.length, nbrs: new Set() }; nodes.push(n); }
      return n;
    };
    for (const s of segs) {
      const ts = cutsAlong(s, segs);
      for (let i = 0; i < ts.length - 1; i++) {
        if (ts[i + 1] - ts[i] < 1e-6) continue;
        const u = nodeAt(lerp(s, ts[i])), v = nodeAt(lerp(s, ts[i + 1]));
        if (u !== v) { u.nbrs.add(v); v.nbrs.add(u); }
      }
    }

    // Loose ends can't be part of a room: trim them away.
    let trimmed = true;
    while (trimmed) {
      trimmed = false;
      for (const n of nodes) {
        if (n.nbrs.size === 1) {
          const [m] = n.nbrs;
          m.nbrs.delete(n);
          n.nbrs.clear();
          trimmed = true;
        }
      }
    }

    // Walk the faces of the drawing. Each neighbour list is sorted by angle; arriving at b
    // from a, carry on along the edge just clockwise of b→a. Enclosed faces then come out
    // anticlockwise (positive area) and the outside of each group of walls negative.
    const ang = (from, to) => Math.atan2(to.y - from.y, to.x - from.x);
    const sorted = new Map(nodes.map((n) => [n, [...n.nbrs].sort((p, q) => ang(n, p) - ang(n, q))]));
    const seen = new Set();
    const rooms = [];
    for (const u of nodes) {
      for (const v of sorted.get(u)) {
        if (seen.has(`${u.id}>${v.id}`)) continue;
        const face = [];
        let a = u, b = v, guard = 0;
        do {
          seen.add(`${a.id}>${b.id}`);
          face.push(a);
          const around = sorted.get(b);
          const i = around.indexOf(a);
          const next = around[(i - 1 + around.length) % around.length];
          a = b;
          b = next;
        } while ((a !== u || b !== v) && ++guard < 10000);
        if (face.length >= minWalls && area(face) > 1) rooms.push(face.map(({ x, y }) => ({ x, y })));
      }
    }
    return rooms;
  }

  function area(poly) {
    let s = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      s += p.x * q.y - q.x * p.y;
    }
    return s / 2;
  }

  // Distance along a ray from o in direction (dx, dy) to segment s, or null if it misses.
  function rayHit(o, dx, dy, s) {
    const ex = s.b.x - s.a.x, ey = s.b.y - s.a.y;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) return null;
    const ax = s.a.x - o.x, ay = s.a.y - o.y;
    const t = (ax * ey - ay * ex) / den;
    const u = (ax * dy - ay * dx) / den;
    return t >= 0 && u >= -1e-9 && u <= 1 + 1e-9 ? t : null;
  }

  // Everything visible from o, as a polygon: rays fanned out towards every wall end,
  // each stopped by the nearest wall. `blockers` are walls only (windows let sight through);
  // the edges of a w×h map always stop a ray.
  function visibleFrom(o, blockers, w, h) {
    const box = [
      { a: { x: 0, y: 0 }, b: { x: w, y: 0 } }, { a: { x: w, y: 0 }, b: { x: w, y: h } },
      { a: { x: w, y: h }, b: { x: 0, y: h } }, { a: { x: 0, y: h }, b: { x: 0, y: 0 } },
    ];
    const segs = blockers.concat(box);
    const angles = [];
    for (const s of segs) {
      for (const p of [s.a, s.b]) {
        const a = Math.atan2(p.y - o.y, p.x - o.x);
        angles.push(a - 1e-4, a, a + 1e-4);
      }
    }
    angles.sort((p, q) => p - q);
    const poly = [];
    for (const a of angles) {
      const dx = Math.cos(a), dy = Math.sin(a);
      let best = Infinity;
      for (const s of segs) {
        const t = rayHit(o, dx, dy, s);
        if (t !== null && t < best) best = t;
      }
      if (best < Infinity) poly.push({ x: o.x + dx * best, y: o.y + dy * best });
    }
    return poly;
  }

  function inside(p, poly) {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
    }
    return hit;
  }

  return { findRooms, visibleFrom, inside, area };
})();

if (typeof module !== 'undefined') module.exports = Sight;
