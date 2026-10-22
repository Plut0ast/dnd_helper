// Shared helpers for the TV, DM and player pages.

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const DICE = [4, 6, 8, 10, 12, 20, 100];

// Default token fills (match the server); the outline shows what a token is.
const ENEMY_COLOR = '#55575d';
const NPC_COLOR = '#e8e2d0';

// How much thicker or thinner than normal a wall is drawn.
const WALL_THICKNESS = { thin: 0.5, normal: 1, thick: 1.7 };

// One creature's space: a 5 ft square, or 1.5 m in metric.
const tokenSpan = (unit) => (unit === 'm' ? 1.5 : 5);

function initial(name) {
  return (String(name || '?').trim()[0] || '?').toUpperCase();
}

// Dark text on light token colours, white on dark ones.
function textOn(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#2a2000' : '#ffffff';
}

function hpColor(frac) {
  return frac >= 0.999 ? 'var(--hp-full)' : 'var(--hp-hurt)';
}

// Each status gets a stable colour from its text, so "Poisoned" always looks the same.
const TAG_COLORS = [
  ['#eaf3de', '#27500a'], ['#faeeda', '#633806'], ['#eeedfe', '#3c3489'], ['#e6f1fb', '#0c447c'],
  ['#fbeaf0', '#72243e'], ['#e1f5ee', '#085041'], ['#fcebeb', '#791f1f'], ['#f1efe8', '#444441'],
];
function tagStyle(text) {
  let h = 0;
  for (const c of String(text).toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const [bg, fg] = TAG_COLORS[h % TAG_COLORS.length];
  return `background:${bg};color:${fg}`;
}

function statusTags(statuses) {
  return (statuses || []).map((s) => `<span class="tag" style="${tagStyle(s)}">${esc(s)}</span>`).join('');
}

// Renders the current map with tokens into `container`.
// opts.draggable + opts.onMove(kind, id, x, y) enable DM dragging.
function createMapView(container, opts = {}) {
  container.classList.add('map-view');
  container.innerHTML = `<div class="map-empty">No map yet</div><div class="stage"><img alt=""><div class="grid" hidden></div><div class="axes" hidden></div>
    <div class="drawings"><svg class="walls" viewBox="0 0 1000 1000" preserveAspectRatio="none"></svg><div class="shapes"></div></div>
    <canvas class="fog" hidden></canvas><div class="tokens"></div></div>`;
  const empty = container.querySelector('.map-empty');
  const stage = container.querySelector('.stage');
  const img = stage.querySelector('img');
  const layer = stage.querySelector('.tokens');
  const grid = stage.querySelector('.grid');
  const axes = stage.querySelector('.axes');
  const wallsSvg = stage.querySelector('.walls');
  const shapesEl = stage.querySelector('.shapes');
  const fog = stage.querySelector('.fog');
  if (opts.fogOpacity) fog.style.opacity = opts.fogOpacity;
  let cellPx = 0; // size of one grid square (one token space) on screen
  const els = new Map(); // "kind:id" -> element
  let view = null;
  let dragging = null;
  let drawingsLocked = false; // the DM is dragging a shape: don't redraw under them
  let selectedShape = null;
  let selectedWall = null;
  // Camera: zoom 1 fits the whole map; below 1 it's smaller with space around it, above 1
  // it's zoomed in. (cx, cy) is the map point in the middle of the view.
  const WHOLE_MAP = { zoom: 1, cx: 0.5, cy: 0.5 };
  const MIN_ZOOM = 0.25, MAX_ZOOM = 8;
  let cam = { ...WHOLE_MAP };
  let camMapId = null;

  function fit() {
    if (!view || !view.map) return;
    const cw = container.clientWidth, ch = container.clientHeight;
    const ratio = view.map.width / view.map.height;
    let w = cw, h = cw / ratio;
    if (h > ch) { h = ch; w = ch * ratio; }
    // Zoomed in, the map grows around the camera centre but never leaves a gap at an edge.
    w *= cam.zoom;
    h *= cam.zoom;
    let left = cw / 2 - cam.cx * w;
    let top = ch / 2 - cam.cy * h;
    left = w > cw ? Math.min(0, Math.max(cw - w, left)) : (cw - w) / 2;
    top = h > ch ? Math.min(0, Math.max(ch - h, top)) : (ch - h) / 2;
    cam.cx = (cw / 2 - left) / w;
    cam.cy = (ch / 2 - top) / h;
    stage.style.width = `${w}px`;
    stage.style.height = `${h}px`;
    stage.style.left = `${left}px`;
    stage.style.top = `${top}px`;
    const { realWidth, unit } = view.map;
    let size;
    if (realWidth) {
      // True to scale: a token is one 5 ft (1.5 m) square of the map.
      size = (w / realWidth) * tokenSpan(unit);
    } else {
      size = w * 0.035 * (view.map.tokenScale || 1);
    }
    stage.style.setProperty('--tok', `${Math.max(10, size)}px`);

    cellPx = size;
    const g = view.map.grid;
    grid.hidden = !(g && g.show);
    axes.hidden = grid.hidden || g.numbers === false;
    if (!grid.hidden) {
      const tone = g.color === 'light' ? 'light' : 'dark';
      grid.className = `grid ${tone}`;
      grid.style.backgroundSize = `${cellPx}px ${cellPx}px`;
      if (!axes.hidden) drawAxes(w, h, tone);
    }
    scheduleFog();
  }

  // Label the grid lines like graph paper, measured from the bottom-left corner. With a
  // real map size the labels are distances (5, 10, 15 … with "ft" or "m" in the corner);
  // without one they just count squares. Labels thin out when squares get small.
  function drawAxes(w, h, tone) {
    axes.className = `axes ${tone}`;
    const { realWidth, unit } = view.map;
    const step = realWidth ? tokenSpan(unit) : 1;
    const minGap = realWidth ? 26 : 18; // distance labels are wider than square counts
    const every = [1, 2, 4, 5, 10, 20, 50].find((n) => n * cellPx >= minGap) || 100;
    const fmt = (n) => String(Math.round(n * step * 10) / 10);
    const cols = Math.floor(w / cellPx);
    const rows = Math.floor(h / cellPx);
    let html = realWidth ? `<span class="axis-unit">${unit === 'm' ? 'm' : 'ft'}</span>` : '';
    for (let i = every; i < cols; i += every) html += `<span class="x" style="left:${i * cellPx}px">${fmt(i)}</span>`;
    for (let j = every; j < rows; j += every) html += `<span class="y" style="top:${h - j * cellPx}px">${fmt(j)}</span>`;
    axes.innerHTML = html;
  }

  // With the grid on, dropped tokens settle into the middle of a square.
  // Squares are measured from the bottom-left corner, like the grid lines.
  function snapped(x, y) {
    const g = view && view.map && view.map.grid;
    if (!g || !g.show || g.snap === false || !cellPx) return { x, y };
    const w = stage.clientWidth, h = stage.clientHeight;
    const sx = (Math.floor((x * w) / cellPx) + 0.5) * cellPx;
    const sy = h - (Math.floor(((1 - y) * h) / cellPx) + 0.5) * cellPx;
    return { x: Math.min(1, sx / w), y: Math.max(0, sy / h) };
  }

  new ResizeObserver(fit).observe(container);

  function place(el, x, y) {
    el.style.left = `${x * 100}%`;
    el.style.top = `${y * 100}%`;
    el._fx = x;
    el._fy = y;
  }

  function startDrag(ev, kind, tid, el) {
    if (!opts.draggable) return;
    ev.preventDefault();
    el.setPointerCapture(ev.pointerId);
    dragging = `${kind}:${tid}`;
    el.classList.add('dragging');
    let last = 0;
    const move = (e) => {
      const r = stage.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      place(el, x, y);
      const now = performance.now();
      if (now - last > 33) { last = now; opts.onMove(kind, tid, x, y); }
      el._pos = { x, y };
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.classList.remove('dragging');
      if (el._pos) {
        const p = snapped(el._pos.x, el._pos.y);
        place(el, p.x, p.y);
        opts.onMove(kind, tid, p.x, p.y);
      }
      dragging = null;
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  function tokenEl(kind, tid) {
    const key = `${kind}:${tid}`;
    let el = els.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = `token ${kind}`;
      el.addEventListener('pointerdown', (ev) => startDrag(ev, kind, tid, el));
      layer.appendChild(el);
      els.set(key, el);
    }
    el._seen = true;
    return el;
  }

  function render(next) {
    view = next;
    const map = view.map;
    empty.style.display = map ? 'none' : '';
    stage.style.display = map ? '' : 'none';
    if (!map) return;
    if (map.id !== camMapId) { camMapId = map.id; cam = { ...WHOLE_MAP }; } // new map: show all of it
    if (map.kind === 'blank') {
      // No image: just the DM's colour (the grid and drawings go on top).
      img.hidden = true;
      img.removeAttribute('src');
      stage.style.background = map.bg;
    } else {
      img.hidden = false;
      stage.style.background = '';
      const src = `/uploads/${map.file}`;
      if (img.getAttribute('src') !== src) img.src = src;
    }
    fit();
    if (!drawingsLocked) renderDrawings(map);

    els.forEach((el) => { el._seen = false; });

    for (const p of view.players) {
      if (!p.pos || p.dead) continue;
      const el = tokenEl('player', p.id);
      el.style.background = p.color;
      el.style.color = textOn(p.color);
      el.title = p.name;
      el.innerHTML = `<span class="tok-face">${esc(initial(p.name))}</span><span class="tok-name">${esc(p.name)}</span>`;
      if (dragging !== `player:${p.id}`) place(el, p.pos.x, p.pos.y);
    }

    for (const n of view.npcTokens || []) {
      const el = tokenEl('npc', n.id);
      el.classList.toggle('unknown', !n.known);
      el.title = n.name;
      const fill = n.known ? n.color || NPC_COLOR : '#8a8578'; // strangers stay plain grey
      el.innerHTML = `<span class="tok-face" style="background:${fill};color:${textOn(fill)}">${n.known ? esc(initial(n.name)) : '?'}</span><span class="tok-name">${esc(n.name)}</span>`;
      if (dragging !== `npc:${n.id}`) place(el, n.x, n.y);
    }

    for (const e of view.enemies) {
      const el = tokenEl('enemy', e.id);
      // The DM gets real numbers; everyone else gets a fraction from the server.
      const f = e.hpFrac !== undefined ? e.hpFrac : Math.max(0, Math.min(1, e.hp / e.maxHp));
      el.classList.toggle('hidden-enemy', !!e.hidden);
      el.title = e.name;
      el.innerHTML = `
        <div class="tok-bar"><div style="width:${f * 100}%"></div></div>
        <span class="tok-face" style="background:${e.color || ENEMY_COLOR};color:${textOn(e.color || ENEMY_COLOR)}">${esc(e.label)}</span>
        <div class="tok-tags">${statusTags(e.statuses)}</div>`;
      if (dragging !== `enemy:${e.id}`) place(el, e.x, e.y);
    }

    els.forEach((el, key) => {
      if (!el._seen) { el.remove(); els.delete(key); }
    });
    scheduleFog();
  }

  // Walls are lines in a 1000×1000 box stretched over the map; shapes are boxes in %.
  function renderDrawings(map) {
    const k = (v) => (v * 1000).toFixed(1);
    wallsSvg.innerHTML = (map.walls || []).map((w) => {
      const pts = `x1="${k(w.x1)}" y1="${k(w.y1)}" x2="${k(w.x2)}" y2="${k(w.y2)}"`;
      const thick = WALL_THICKNESS[w.thickness] || 1;
      const style = `--wt:${thick};${w.type !== 'window' && w.color ? `--wc:${w.color}` : ''}`;
      const cls = `${w.type === 'window' ? 'window' : ''} ${w.id === selectedWall ? 'selected' : ''}`;
      return `<g data-wall="${w.id}" class="${cls}" style="${style}"><line class="wall-hit" ${pts}/><line class="wall-edge" ${pts}/><line class="wall" ${pts}/></g>`;
    }).join('');
    shapesEl.innerHTML = (map.shapes || []).map((s) => {
      const fill = s.type === 'text' ? `color:${s.color}` : `background:${s.color};color:${textOn(s.color)}`;
      return `<div class="shape ${s.type} ${s.id === selectedShape ? 'selected' : ''}" data-shape="${s.id}"
        style="left:${s.x * 100}%;top:${s.y * 100}%;width:${s.w * 100}%;height:${s.h * 100}%;${fill}"><span>${esc(s.text)}</span></div>`;
    }).join('');
  }

  // Apply a single token move pushed from the DM without a full re-render.
  function moveToken(kind, tid, x, y) {
    const el = els.get(`${kind}:${tid}`);
    if (el && dragging !== `${kind}:${tid}`) place(el, x, y);
    scheduleFog(); // who can see what may have changed
  }

  // ---------- darkness outside rooms ----------
  // Once the walls close at least one room, everything outside the rooms is dark,
  // except what the players can see: by day, anything in their line of sight (walls
  // block it, windows don't); at night, only within their light radius. Enemies and
  // NPCs in the dark are hidden too, unless this view sees everything (the DM's).

  let fogFrame = null;
  let roomsKey = '';
  let rooms = [];
  function scheduleFog() {
    if (!fogFrame) fogFrame = requestAnimationFrame(() => { fogFrame = null; drawFog(); });
  }

  function nightRadius(map, w) {
    const r = (map.lighting && map.lighting.radius) || 30;
    return map.realWidth ? (r / map.realWidth) * w : w * 0.15;
  }

  function drawFog() {
    const map = view && view.map;
    const w = stage.clientWidth, h = stage.clientHeight;
    const lighting = (map && map.lighting) || {};
    const segs = ((map && map.walls) || []).map((s) => ({
      a: { x: s.x1 * w, y: s.y1 * h }, b: { x: s.x2 * w, y: s.y2 * h }, type: s.type,
    }));
    const key = `${w}x${h}|${JSON.stringify(map && map.walls)}`;
    if (key !== roomsKey) { roomsKey = key; rooms = Sight.findRooms(segs); }
    fog.hidden = !(map && lighting.fog !== false && rooms.length && w > 0);
    if (fog.hidden) {
      els.forEach((el) => el.classList.remove('in-dark'));
      return;
    }

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    fog.width = Math.round(w * dpr);
    fog.height = Math.round(h * dpr);
    const ctx = fog.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    // Cut the visible parts out of the darkness.
    ctx.globalCompositeOperation = 'destination-out';
    const path = (poly) => {
      ctx.beginPath();
      poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
    };
    for (const r of rooms) { path(r); ctx.fill(); }

    const night = lighting.time === 'night';
    const radius = night ? nightRadius(map, w) : Infinity;
    const blockers = segs.filter((s) => s.type !== 'window');
    const views = [];
    for (const p of view.players) {
      if (!p.pos || p.dead) continue;
      const o = { x: p.pos.x * w, y: p.pos.y * h };
      const poly = Sight.visibleFrom(o, blockers, w, h);
      views.push({ o, poly });
      ctx.save();
      path(poly);
      ctx.clip();
      if (night) {
        // A soft-edged pool of light, like a torch.
        const glow = ctx.createRadialGradient(o.x, o.y, radius * 0.6, o.x, o.y, radius);
        glow.addColorStop(0, '#000');
        glow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(o.x, o.y, radius, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(0, 0, w, h);
      }
      ctx.restore();
    }

    if (opts.seeAll) return;
    const seen = (x, y) => rooms.some((r) => Sight.inside({ x, y }, r))
      || views.some((v) => Math.hypot(x - v.o.x, y - v.o.y) <= radius && Sight.inside({ x, y }, v.poly));
    els.forEach((el, k) => {
      if (k.startsWith('player:')) return;
      el.classList.toggle('in-dark', !seen(el._fx * w, el._fy * h));
    });
  }

  // Screen point -> fraction of the map.
  function toFrac(clientX, clientY) {
    const r = stage.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (clientY - r.top) / r.height)),
    };
  }

  // Snap to the nearest grid line crossing (for walls and shape corners), if the grid is on.
  function snapCorner(x, y) {
    const g = view && view.map && view.map.grid;
    if (!g || !g.show || g.snap === false || !cellPx) return { x, y };
    const w = stage.clientWidth, h = stage.clientHeight;
    return {
      x: Math.min(1, (Math.round((x * w) / cellPx) * cellPx) / w),
      y: Math.max(0, (h - Math.round(((1 - y) * h) / cellPx) * cellPx) / h),
    };
  }

  function selectShape(sid) {
    selectedShape = sid;
    shapesEl.querySelectorAll('.shape').forEach((el) => el.classList.toggle('selected', el.dataset.shape === sid));
  }

  function selectWall(wid) {
    selectedWall = wid;
    wallsSvg.querySelectorAll('g[data-wall]').forEach((g) => g.classList.toggle('selected', g.dataset.wall === wid));
  }

  // One grid square as a fraction of the map's width and height.
  function cellFrac() {
    if (!cellPx || !stage.clientWidth) return null;
    return { x: cellPx / stage.clientWidth, y: cellPx / stage.clientHeight };
  }

  // Zoom by `factor`, keeping the map point under (clientX, clientY) where it is.
  function zoomAt(clientX, clientY, factor) {
    const r = container.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const p = { x: (clientX - sr.left) / sr.width, y: (clientY - sr.top) / sr.height };
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * factor));
    const W = (sr.width / cam.zoom) * zoom, H = (sr.height / cam.zoom) * zoom;
    const left = clientX - r.left - p.x * W, top = clientY - r.top - p.y * H;
    cam = { zoom, cx: (r.width / 2 - left) / W, cy: (r.height / 2 - top) / H };
    fit();
    return { ...cam };
  }

  function panBy(dx, dy) {
    cam.cx -= dx / stage.clientWidth;
    cam.cy -= dy / stage.clientHeight;
    fit();
    return { ...cam };
  }

  function setCamera(c) {
    cam = c ? { zoom: c.zoom, cx: c.cx, cy: c.cy } : { ...WHOLE_MAP };
    fit();
  }

  return {
    render, moveToken, stage, toFrac, snapCorner, selectShape, selectWall, cellFrac,
    zoomAt, panBy, setCamera, camera: () => ({ ...cam }),
    lockDrawings(on) { drawingsLocked = on; if (!on && view && view.map) renderDrawings(view.map); },
  };
}

// Keeps the local view in sync with "token" events so moves show up instantly.
function applyTokenMove(view, t) {
  if (!view) return;
  if (t.kind === 'player') {
    const p = view.players.find((x) => x.id === t.id);
    if (p) p.pos = { x: t.x, y: t.y };
  } else if (t.kind === 'npc') {
    const n = (view.npcTokens || []).find((x) => x.id === t.id);
    if (n) { n.x = t.x; n.y = t.y; }
  } else {
    const e = view.enemies.find((x) => x.id === t.id);
    if (e) { e.x = t.x; e.y = t.y; }
  }
}

// How an NPC feels about a player, worst to best.
const RELATIONSHIPS = {
  Hostile: 'background:#fcebeb;color:#791f1f',
  Unfriendly: 'background:#faeeda;color:#633806',
  Neutral: 'background:#f1efe8;color:#444441',
  Friendly: 'background:#eaf3de;color:#27500a',
  Allied: 'background:#e6f1fb;color:#0c447c',
};
function relTag(level) {
  return `<span class="tag" style="${RELATIONSHIPS[level] || RELATIONSHIPS.Neutral}">${esc(level || 'Neutral')}</span>`;
}

// One player in the party bar: icon, name, exact HP, bar, status effects.
function memberHtml(p) {
  if (p.dead) {
    return `<div class="member" style="opacity:.5">
      <div class="face" style="background:${p.color};color:${textOn(p.color)}">${esc(initial(p.name))}</div>
      <div class="info"><div class="top"><span>${esc(p.name)}</span><span class="hp">Dead</span></div></div>
    </div>`;
  }
  const f = Math.max(0, Math.min(1, p.hp / p.maxHp));
  return `<div class="member">
    <div class="face" style="background:${p.color};color:${textOn(p.color)}">${esc(initial(p.name))}</div>
    <div class="info">
      <div class="top"><span>${esc(p.name)}</span><span class="hp">${p.hp} / ${p.maxHp}</span></div>
      <div class="bar"><div style="width:${f * 100}%;background:${hpColor(f)}"></div></div>
      <div class="tags">${p.statuses.length ? statusTags(p.statuses) : '<span class="none">No effects</span>'}</div>
    </div>
  </div>`;
}

function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
