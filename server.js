// Tabletop: a same-room homebrew D&D table.
// The DM keeps several campaigns; one plays at a time. The TV, the DM's device and the players' phones all
// connect here over Socket.IO; each gets a view of the state filtered for its role.

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const portArg = process.argv.indexOf('--port');
const PORT = Number(portArg > -1 && process.argv[portArg + 1]) || Number(process.env.PORT) || 3000;
// `node server.js --data <folder>` keeps saves somewhere else (handy for testing).
const dataArg = process.argv.indexOf('--data');
const DATA_DIR = dataArg > -1 && process.argv[dataArg + 1] ? path.resolve(process.argv[dataArg + 1]) : path.join(__dirname, 'data');
const CAMPAIGNS_DIR = path.join(DATA_DIR, 'campaigns');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const ACTIVE_FILE = path.join(DATA_DIR, 'active.json');
const OLD_SAVES_DIR = path.join(DATA_DIR, 'saves'); // saves from before campaigns; moved over once
const PIN_FILE = path.join(DATA_DIR, 'dm-pin.txt');

fs.mkdirSync(CAMPAIGNS_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// The DM PIN stays the same between runs so the DM only has to learn it once.
function loadPin() {
  if (process.env.DM_PIN) return String(process.env.DM_PIN);
  try {
    const pin = fs.readFileSync(PIN_FILE, 'utf8').trim();
    if (pin) return pin;
  } catch {}
  const pin = String(crypto.randomInt(1000, 10000));
  fs.writeFileSync(PIN_FILE, pin);
  return pin;
}
const DM_PIN = loadPin();

// ---------- helpers ----------

const id = () => crypto.randomBytes(6).toString('hex');
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : fallback);
const frac = (v) => clamp(Number(v) || 0, 0, 1);
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const color = (v, fallback) => (COLOR_RE.test(v) ? v : fallback);
const sides = (v) => clamp(int(v, 20), 2, 1000);
const RELATIONSHIPS = ['Hostile', 'Unfriendly', 'Neutral', 'Friendly', 'Allied'];
// Default token fills; the DM can recolour each one.
const ENEMY_COLOR = '#55575d';
const NPC_COLOR = '#e8e2d0';
const WALL_COLOR = '#2b2622';
const THICKNESS = ['thin', 'normal', 'thick'];

// "Old Marta" -> "OM", "Grog" -> "GR"
function initials(name) {
  const words = name.split(/\s+/).map((w) => w.replace(/[^A-Za-z0-9]/g, '')).filter(Boolean);
  const label = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '').slice(0, 2);
  return label.toUpperCase() || 'EN';
}

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) code += letters[crypto.randomInt(letters.length)];
  return code;
}

function lanAddress() {
  const candidates = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) candidates.push(a.address);
    }
  }
  // Home Wi-Fi is almost always 192.168.x.x; prefer it over VPN/virtual adapters.
  return candidates.find((a) => a.startsWith('192.168.')) || candidates[0] || 'localhost';
}
const JOIN_URL = `http://${lanAddress()}:${PORT}/play`;
let joinQr = '';
QRCode.toDataURL(JOIN_URL, { margin: 1, width: 240 }).then((q) => { joinQr = q; });

// ---------- game state ----------

function newState(name = 'New campaign') {
  return {
    version: 1,
    campaignId: id(),
    campaignName: name,
    roomCode: makeCode(),
    maps: [],          // { id, name, file, width, height, tokenScale, realWidth, unit: 'ft' | 'm',
                       //   grid: { show, color: 'dark' | 'light', snap, numbers },
                       //   kind: 'image' | 'blank', bg (blank maps: colour), realHeight (blank maps),
                       //   walls: [{ id, type: 'wall' | 'window', x1, y1, x2, y2, color, thickness }],
                       //   shapes: [{ id, type, x, y, w, h, color, text }],
                       //   lighting: { time: 'day' | 'night', radius (night sight, in the map's unit), fog } }
                       //   (positions and sizes are fractions of the map)
    currentMapId: null,
    players: [],       // see makePlayer
    enemies: [],       // { id, mapId, name, label, x, y, hp, maxHp, statuses, hidden }
    npcs: [],          // { id, name, description, location, revealAll, revealedTo: [playerId],
                       //   positions: { mapId: { x, y } }, relationships: { playerId: 'Hostile'…'Allied' } }
    scene: '',
    showJoin: true,
    attributes: [],          // { id, name }: the stats every character in this campaign has
    attributeMode: 'players', // 'players' fill in their own values, or 'dm' only (real dice, no cheating)
    log: [],           // rolls and rulings, newest last
    savedAt: null,
  };
}

function makePlayer(name, playerColor) {
  return {
    id: id(),
    name,
    color: playerColor,
    hp: 10,
    maxHp: 10,
    statuses: [],
    die: 20,
    rollMode: 'digital', // 'digital' = app rolls, 'physical' = real dice, result typed in
    positions: {},       // mapId -> { x, y } as fractions of the map size
    sheet: { stats: [], inventory: [], backstory: '', notes: '' },
    attributes: {},      // attributeId -> value, for the campaign's attributes
    npcNotes: {},        // npcId -> the player's private notes
    dead: false,         // dead characters can't be picked when joining
    createdAt: Date.now(),
  };
}

// ---------- campaigns on disk ----------
// data/campaigns/<campaignId>/campaign.json                       everything but the characters
// data/campaigns/<campaignId>/characters/<id>/character.json      one folder per character, so the
//                                                                 DM can move it to another campaign
// data/active.json                                                which campaign is being played

const isId = (v) => typeof v === 'string' && /^[a-f0-9]{12}$/.test(v);
const campaignDir = (cid) => path.join(CAMPAIGNS_DIR, cid);
const charactersDir = (cid) => path.join(campaignDir(cid), 'characters');
const characterFile = (cid, pid) => path.join(charactersDir(cid), pid, 'character.json');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function readCharacters(cid) {
  const dir = charactersDir(cid);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((pid) => {
      try { return readJson(characterFile(cid, pid)); } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

function readCampaign(cid) {
  const saved = readJson(path.join(campaignDir(cid), 'campaign.json'));
  return { ...newState(), ...saved, campaignId: cid, players: readCharacters(cid) };
}

// Writes a campaign's file and one folder per character, and deletes the folders of
// characters that were removed or moved away.
function saveCampaign(s = state) {
  const { players, ...rest } = s;
  writeJson(path.join(campaignDir(s.campaignId), 'campaign.json'), { ...rest, savedAt: new Date().toISOString() });
  fs.mkdirSync(charactersDir(s.campaignId), { recursive: true });
  for (const p of players) writeJson(characterFile(s.campaignId, p.id), p);
  const keep = new Set(players.map((p) => p.id));
  for (const pid of fs.readdirSync(charactersDir(s.campaignId))) {
    if (!keep.has(pid)) fs.rmSync(path.join(charactersDir(s.campaignId), pid), { recursive: true, force: true });
  }
}

const setActive = (cid) => writeJson(ACTIVE_FILE, { campaignId: cid });

function listCampaigns() {
  return fs.readdirSync(CAMPAIGNS_DIR)
    .filter(isId)
    .map((cid) => {
      try {
        const c = readJson(path.join(campaignDir(cid), 'campaign.json'));
        return {
          id: cid, name: c.campaignName, savedAt: c.savedAt, maps: (c.maps || []).length,
          characters: readCharacters(cid).map((p) => ({ id: p.id, name: p.name, color: p.color, dead: !!p.dead })),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}

// Saves from before campaigns existed (data/saves/*.json) each become a campaign; the
// autosave becomes the one that's playing. The old folder is kept, renamed, as a backup.
function migrateOldSaves() {
  if (!fs.existsSync(OLD_SAVES_DIR)) return null;
  let activeId = null;
  for (const file of fs.readdirSync(OLD_SAVES_DIR).filter((f) => f.endsWith('.json'))) {
    try {
      const old = readJson(path.join(OLD_SAVES_DIR, file));
      const s = { ...newState(), ...old, campaignId: id() };
      s.players = (old.players || []).map((p, i) => ({ dead: false, createdAt: Date.now() + i, ...p }));
      saveCampaign(s);
      if (file === '_autosave.json') activeId = s.campaignId;
      console.log(`Moved "${s.campaignName}" (${file}) into its own campaign folder`);
    } catch (err) {
      console.error(`Could not move ${file} into a campaign:`, err.message);
    }
  }
  fs.renameSync(OLD_SAVES_DIR, path.join(DATA_DIR, 'saves-before-campaigns'));
  return activeId;
}

function loadStartingCampaign() {
  let cid = migrateOldSaves();
  if (!cid) {
    try { cid = readJson(ACTIVE_FILE).campaignId; } catch {}
  }
  const all = fs.readdirSync(CAMPAIGNS_DIR).filter(isId);
  if (!all.includes(cid)) cid = all[0];
  if (cid) {
    try {
      setActive(cid);
      return readCampaign(cid);
    } catch (err) {
      console.error('Could not open the last campaign:', err.message);
    }
  }
  const s = newState('My first campaign');
  saveCampaign(s);
  setActive(s.campaignId);
  return s;
}

let state = loadStartingCampaign();

const currentMap = () => state.maps.find((m) => m.id === state.currentMapId) || null;
const findPlayer = (pid) => state.players.find((p) => p.id === pid);
const findEnemy = (eid) => state.enemies.find((e) => e.id === eid);

// Give every player a spot on the current map so new joiners appear somewhere sensible.
function ensurePositions() {
  const map = currentMap();
  if (!map) return;
  state.players.forEach((p, i) => {
    if (!p.positions[map.id] && !p.dead) p.positions[map.id] = { x: 0.08 + (i % 6) * 0.06, y: 0.12 + Math.floor(i / 6) * 0.1 };
  });
}

// ---------- role-filtered views ----------

function publicPlayer(p) {
  return {
    id: p.id, name: p.name, color: p.color, hp: p.hp, maxHp: p.maxHp, dead: !!p.dead,
    statuses: p.statuses, pos: p.dead ? null : p.positions[state.currentMapId] || null,
  };
}

// Players and the TV only see an enemy's health as a fraction, never the numbers.
function publicEnemies() {
  return state.enemies
    .filter((e) => e.mapId === state.currentMapId && !e.hidden)
    .map((e) => ({
      id: e.id, name: e.name, label: e.label, color: e.color || ENEMY_COLOR, x: e.x, y: e.y, statuses: e.statuses,
      hpFrac: e.maxHp > 0 ? clamp(e.hp / e.maxHp, 0, 1) : 0,
    }));
}

function baseView() {
  return {
    campaignName: state.campaignName,
    roomCode: state.roomCode,
    joinUrl: JOIN_URL,
    qr: joinQr,
    showJoin: state.showJoin,
    map: currentMap(),
    players: state.players.map(publicPlayer),
    enemies: publicEnemies(),
    npcTokens: npcTokens(() => false),
    scene: state.scene,
    tvCamera: tvCamera(),
    attributes: state.attributes,
    attributeMode: state.attributeMode,
  };
}

// When the DM turns on "TV follows my view", the TV zooms and pans with the DM's map.
// It resets whenever a different map is shown.
let camera = null; // { mapId, zoom, cx, cy }
const tvCamera = () => (camera && camera.mapId === state.currentMapId ? camera : null);

// Only keep values for attributes this campaign actually has.
function setAttributeValues(p, values) {
  if (!values || typeof values !== 'object') return;
  p.attributes = p.attributes || {};
  for (const a of state.attributes) {
    if (values[a.id] !== undefined) p.attributes[a.id] = str(String(values[a.id]), 20).trim();
  }
}

// A character moving between campaigns keeps values for attributes with the same name.
function remapAttributes(p, fromAttrs, toAttrs) {
  const byName = {};
  for (const a of fromAttrs || []) {
    const v = p.attributes && p.attributes[a.id];
    if (v !== undefined && v !== '') byName[a.name.toLowerCase()] = v;
  }
  p.attributes = {};
  for (const a of toAttrs || []) {
    const v = byName[a.name.toLowerCase()];
    if (v !== undefined) p.attributes[a.id] = v;
  }
}

const attributesOf = (cid) => (cid === state.campaignId
  ? state.attributes
  : readJson(path.join(campaignDir(cid), 'campaign.json')).attributes || []);

// NPCs placed on the current map. Their name only shows to people who've met them;
// everyone else sees a "?" stranger.
function npcTokens(knows) {
  return state.npcs
    .filter((n) => n.positions && n.positions[state.currentMapId])
    .map((n) => {
      const known = n.revealAll || knows(n);
      return { id: n.id, ...n.positions[state.currentMapId], known, name: known ? n.name : 'Stranger', color: n.color || NPC_COLOR };
    });
}

const tvView = () => ({ ...baseView(), role: 'tv', log: state.log.filter((l) => !l.secret).slice(-20) });

function playerView(p) {
  return {
    ...baseView(),
    role: 'player',
    me: p,
    npcTokens: npcTokens((n) => n.revealedTo.includes(p.id)),
    npcs: state.npcs
      .filter((n) => n.revealAll || n.revealedTo.includes(p.id))
      .map(({ id: nid, name, description, location, relationships, color: c }) => ({
        id: nid, name, description, location, color: c || NPC_COLOR,
        relationship: (relationships && relationships[p.id]) || 'Neutral',
      })),
    log: state.log.filter((l) => !l.secret || l.playerId === p.id).slice(-30),
  };
}

// Players with at least one phone connected right now.
function onlinePlayerIds() {
  const ids = [];
  for (const s of io.sockets.sockets.values()) {
    if (s.data.role === 'player' && s.data.playerId) ids.push(s.data.playerId);
  }
  return ids;
}

// ---------- drawing undo/redo ----------
// Each map keeps a short history of its walls and shapes while the server runs
// (it isn't saved: a restart starts a fresh history).

const drawHistory = new Map(); // mapId -> { undo: [snapshot], redo: [snapshot], lastKey, lastAt }

function historyFor(map) {
  if (!drawHistory.has(map.id)) drawHistory.set(map.id, { undo: [], redo: [], lastKey: null, lastAt: 0 });
  return drawHistory.get(map.id);
}

// Remember the drawing as it is before a change. Repeated changes with the same key
// close together (typing into one shape) share one snapshot.
function snapshotDrawing(map, key = null) {
  const h = historyFor(map);
  const now = Date.now();
  if (key && h.lastKey === key && now - h.lastAt < 3000) {
    h.lastAt = now;
    return;
  }
  h.undo.push(JSON.stringify({ walls: map.walls || [], shapes: map.shapes || [] }));
  if (h.undo.length > 100) h.undo.shift();
  h.redo = [];
  h.lastKey = key;
  h.lastAt = now;
}

function historyCounts() {
  const h = drawHistory.get(state.currentMapId);
  return { undo: h ? h.undo.length : 0, redo: h ? h.redo.length : 0 };
}

const dmView = () => ({
  ...state, role: 'dm', joinUrl: JOIN_URL, qr: joinQr, map: currentMap(), online: onlinePlayerIds(),
  drawHistory: historyCounts(),
});

// ---------- autosave ----------

let autosaveTimer = null;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try {
      saveCampaign();
    } catch (err) {
      console.error('Autosave failed:', err.message);
    }
  }, 1000);
}

// Ctrl+C in the server window: write the last second of changes before quitting.
process.on('SIGINT', () => {
  clearTimeout(autosaveTimer);
  try { saveCampaign(); } catch {}
  process.exit(0);
});

// ---------- server ----------

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 30e6 });

// Has server.js been edited since this server started? Then it's running old code and
// the DM screen asks for a restart (pages always load the newest files; the server doesn't).
const SERVER_FILE = path.join(__dirname, 'server.js');
const startedWith = fs.statSync(SERVER_FILE).mtimeMs;
app.get('/api/outdated', (req, res) => {
  let outdated = false;
  try { outdated = fs.statSync(SERVER_FILE).mtimeMs > startedWith; } catch {}
  res.json({ outdated });
});

app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '1h' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

function sendView(s) {
  const role = s.data.role;
  if (!role && s.data.picking) s.emit('picker:refresh'); // phones on the character list
  else if (role === 'dm') s.emit('state', dmView());
  else if (role === 'tv') s.emit('state', tvView());
  else if (role === 'player') {
    const p = findPlayer(s.data.playerId);
    if (p) s.emit('state', playerView(p));
    else {
      s.data.role = null;
      s.emit('player:gone');
    }
  }
}

function broadcast() {
  ensurePositions();
  scheduleAutosave();
  for (const s of io.sockets.sockets.values()) sendView(s);
}

function pushLog(entry) {
  state.log.push({ id: id(), time: Date.now(), ruling: '', ruled: false, secret: false, ...entry });
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
}

const roll = (n) => crypto.randomInt(1, n + 1);

const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

function statusList(v) {
  return Array.isArray(v) ? v.map((s) => str(s, 40).trim()).filter(Boolean).slice(0, 20) : [];
}

io.on('connection', (socket) => {
  // Register a handler that only runs for an authenticated DM.
  const dmOn = (event, fn) => socket.on(event, (data = {}, cb) => {
    if (socket.data.role !== 'dm') return typeof cb === 'function' && cb({ ok: false, error: 'Not the DM' });
    try {
      const result = fn(data);
      broadcast();
      if (typeof cb === 'function') cb({ ok: true, ...(result || {}) });
    } catch (err) {
      console.error(event, err);
      if (typeof cb === 'function') cb({ ok: false, error: err.message });
    }
  });

  // Same, for a player who has joined.
  const playerOn = (event, fn) => socket.on(event, (data = {}, cb) => {
    const p = socket.data.role === 'player' && findPlayer(socket.data.playerId);
    if (!p) return typeof cb === 'function' && cb({ ok: false, error: 'Join the game first' });
    fn(p, data);
    broadcast();
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('tv:hello', () => {
    socket.data.role = 'tv';
    sendView(socket);
  });

  socket.on('dm:auth', (data = {}, cb) => {
    if (str(data.pin, 20) !== DM_PIN) return cb && cb({ ok: false, error: 'Wrong PIN' });
    socket.data.role = 'dm';
    sendView(socket);
    cb && cb({ ok: true });
  });

  // Step 1 of joining: check the code and list the campaign's living characters to pick from.
  socket.on('player:lookup', (data = {}, cb) => {
    if (typeof cb !== 'function') return;
    if (str(data.code, 10).toUpperCase() !== state.roomCode) return cb({ ok: false, error: 'That room code is wrong' });
    socket.data.picking = true; // keep this phone's character list fresh until it joins
    const online = onlinePlayerIds();
    cb({
      ok: true,
      campaignName: state.campaignName,
      characters: state.players.filter((p) => !p.dead)
        .map((p) => ({ id: p.id, name: p.name, color: p.color, inUse: online.includes(p.id) })),
    });
  });

  // Step 2: play as an existing character (data.id) or make a new one (data.create).
  socket.on('player:join', (data = {}, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (str(data.code, 10).toUpperCase() !== state.roomCode) return reply({ ok: false, error: 'That room code is wrong' });
    let p;
    if (data.create) {
      const name = str(data.create.name, 30).trim();
      if (!name) return reply({ ok: false, error: 'Give your character a name' });
      if (state.players.some((x) => !x.dead && x.name.toLowerCase() === name.toLowerCase())) {
        return reply({ ok: false, error: 'A character with that name already exists. Pick them from the list.' });
      }
      p = makePlayer(name, color(data.create.color, '#f06a1e'));
      state.players.push(p);
    } else {
      p = findPlayer(data.id);
      if (!p) return reply({ ok: false, error: 'That character isn\'t in this campaign' });
      if (p.dead) return reply({ ok: false, error: `${p.name} has died` });
    }
    socket.data.role = 'player';
    socket.data.playerId = p.id;
    socket.data.picking = false;
    reply({ ok: true, id: p.id, code: state.roomCode });
    broadcast();
  });

  // ----- player actions -----

  playerOn('player:action', (p, data) => {
    if (p.dead) return;
    const physical = p.rollMode === 'physical';
    let result = null;
    if (!physical) result = roll(p.die);
    else if (data.result !== undefined && data.result !== '' && data.result !== null) result = clamp(int(data.result), 0, 9999);
    pushLog({
      kind: 'action', playerId: p.id, who: p.name, color: p.color,
      action: str(data.text, 300).trim(), die: p.die, result, mode: p.rollMode,
    });
  });

  playerOn('player:sheet', (p, data) => {
    const s = data.sheet || {};
    p.sheet = {
      stats: (Array.isArray(s.stats) ? s.stats : []).slice(0, 40)
        .map((x) => ({ name: str(x && x.name, 40), value: str(x && x.value, 40) })),
      inventory: (Array.isArray(s.inventory) ? s.inventory : []).slice(0, 100)
        .map((x) => ({ name: str(x && x.name, 60), note: str(x && x.note, 200) })),
      backstory: str(s.backstory, 5000),
      notes: str(s.notes, 5000),
    };
  });

  // Players may only fill in their own attributes if the DM allows it.
  playerOn('player:attributes', (p, data) => {
    if (state.attributeMode === 'dm') return;
    setAttributeValues(p, data.values);
  });

  playerOn('player:npcNote', (p, data) => {
    if (state.npcs.some((n) => n.id === data.npcId)) p.npcNotes[data.npcId] = str(data.text, 2000);
  });

  // Leaving unlinks this phone; the character stays saved and can be picked again later.
  playerOn('player:leave', () => {
    socket.data.role = null;
    socket.data.playerId = null;
  });

  // Keeps the DM's "connected" dots up to date.
  socket.on('disconnect', () => {
    if (socket.data.role === 'player') broadcast();
    // With no DM left to steer it, a following TV goes back to showing the whole map.
    const dmLeft = [...io.sockets.sockets.values()].some((s) => s.data.role === 'dm');
    if (socket.data.role === 'dm' && !dmLeft && camera) {
      camera = null;
      for (const s of io.sockets.sockets.values()) if (s.data.role === 'tv') s.emit('camera', null);
    }
  });

  // ----- DM: campaign, maps and tokens -----

  dmOn('dm:campaign', (d) => {
    if (d.name !== undefined) state.campaignName = str(d.name, 80).trim() || state.campaignName;
    if (d.scene !== undefined) state.scene = str(d.scene, 500);
    if (d.showJoin !== undefined) state.showJoin = !!d.showJoin;
    if (d.newCode) state.roomCode = makeCode();
  });

  dmOn('dm:uploadMap', (d) => {
    const ext = IMAGE_TYPES[d.type];
    if (!ext) throw new Error('Use a PNG, JPG, WebP or GIF image');
    if (!d.data || !d.data.length) throw new Error('The image was empty');
    const file = `${id()}.${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, file), Buffer.from(d.data));
    const map = {
      id: id(), name: str(d.name, 60).trim() || 'Map', file,
      width: clamp(int(d.width, 1600), 1, 20000), height: clamp(int(d.height, 900), 1, 20000), tokenScale: 1,
    };
    state.maps.push(map);
    if (!state.currentMapId) state.currentMapId = map.id;
    return { mapId: map.id };
  });

  // A map with no image: a coloured area of a given real size, gridded by default.
  dmOn('dm:blankMap', (d) => {
    const unit = d.unit === 'm' ? 'm' : 'ft';
    const realWidth = clamp(Number(d.realWidth) || 60, 5, 5000);
    const realHeight = clamp(Number(d.realHeight) || 40, 5, 5000);
    const bg = color(d.bg, '#ffffff');
    const n = parseInt(bg.slice(1), 16);
    const darkBg = ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 < 128;
    const map = {
      id: id(), kind: 'blank', name: str(d.name, 60).trim() || 'Blank map', file: null,
      bg, realWidth, realHeight, unit,
      width: realWidth * 100, height: realHeight * 100, tokenScale: 1,
      grid: { show: true, color: darkBg ? 'light' : 'dark', snap: true }, walls: [], shapes: [],
    };
    state.maps.push(map);
    if (!state.currentMapId) state.currentMapId = map.id;
    return { mapId: map.id };
  });

  dmOn('dm:map', (d) => {
    const map = state.maps.find((m) => m.id === d.id);
    if (!map) throw new Error('Map not found');
    if (d.show) state.currentMapId = map.id;
    if (d.name !== undefined) map.name = str(d.name, 60).trim() || map.name;
    if (d.tokenScale !== undefined) map.tokenScale = clamp(Number(d.tokenScale) || 1, 0.3, 4);
    if (map.kind === 'blank') {
      // A blank map's shape comes from its real size, so resizing reshapes it.
      if (d.bg !== undefined) map.bg = color(d.bg, map.bg);
      if (Number(d.realWidth) > 0) map.realWidth = clamp(Number(d.realWidth), 5, 5000);
      if (Number(d.realHeight) > 0) map.realHeight = clamp(Number(d.realHeight), 5, 5000);
      map.width = map.realWidth * 100;
      map.height = map.realHeight * 100;
    } else if (d.realWidth !== undefined) {
      // How wide the map is in real life; tokens are then drawn 5 ft / 1.5 m across.
      map.realWidth = Number(d.realWidth) > 0 ? clamp(Number(d.realWidth), 1, 100000) : null;
    }
    if (d.unit !== undefined) map.unit = d.unit === 'm' ? 'm' : 'ft';
    // Rooms and darkness: outside closed rooms is dark unless players can see it.
    if (d.lighting) {
      const l = { time: 'day', radius: 30, fog: true, ...map.lighting };
      if (d.lighting.time !== undefined) l.time = d.lighting.time === 'night' ? 'night' : 'day';
      if (d.lighting.radius !== undefined) l.radius = clamp(Number(d.lighting.radius) || 30, 1, 1000);
      if (d.lighting.fog !== undefined) l.fog = !!d.lighting.fog;
      map.lighting = l;
    }
    // Grid overlay: one square per token space; tokens can snap to it.
    if (d.grid) {
      const g = { show: false, color: 'dark', snap: true, ...map.grid };
      if (d.grid.show !== undefined) g.show = !!d.grid.show;
      if (d.grid.color !== undefined) g.color = d.grid.color === 'light' ? 'light' : 'dark';
      if (d.grid.snap !== undefined) g.snap = !!d.grid.snap;
      if (d.grid.numbers !== undefined) g.numbers = !!d.grid.numbers;
      map.grid = g;
    }
  });

  // Walls and shapes drawn on the current map.
  const drawingMap = () => {
    const map = currentMap();
    if (!map) throw new Error('Show a map first');
    map.walls = map.walls || [];
    map.shapes = map.shapes || [];
    return map;
  };
  const SHAPE_TYPES = ['rect', 'circle', 'text'];

  dmOn('dm:wall', (d) => {
    const map = drawingMap();
    snapshotDrawing(map);
    if (d.add) {
      const w = {
        id: id(), type: d.add.type === 'window' ? 'window' : 'wall',
        x1: frac(d.add.x1), y1: frac(d.add.y1), x2: frac(d.add.x2), y2: frac(d.add.y2),
        color: WALL_COLOR, thickness: 'normal',
      };
      if (w.x1 === w.x2 && w.y1 === w.y2) throw new Error('Drag to draw a wall');
      if (map.walls.length >= 2000) throw new Error('This map has too many walls');
      map.walls.push(w);
    }
    if (d.update) {
      const w = map.walls.find((x) => x.id === d.update.id);
      if (!w) throw new Error('Wall not found');
      for (const k of ['x1', 'y1', 'x2', 'y2']) if (d.update[k] !== undefined) w[k] = frac(d.update[k]);
      if (d.update.type !== undefined) w.type = d.update.type === 'window' ? 'window' : 'wall';
      if (d.update.color !== undefined) w.color = color(d.update.color, w.color || WALL_COLOR);
      if (d.update.thickness !== undefined) w.thickness = THICKNESS.includes(d.update.thickness) ? d.update.thickness : 'normal';
    }
    if (d.remove) map.walls = map.walls.filter((w) => w.id !== d.remove);
    if (d.clear) map.walls = [];
  });

  dmOn('dm:shape', (d) => {
    const map = drawingMap();
    // Typing into one shape's text is a single undo step.
    const onlyText = d.update && Object.keys(d.update).every((k) => k === 'id' || k === 'text');
    snapshotDrawing(map, onlyText ? `text:${d.update.id}` : null);
    const apply = (s, v) => {
      if (v.x !== undefined) s.x = frac(v.x);
      if (v.y !== undefined) s.y = frac(v.y);
      if (v.w !== undefined) s.w = clamp(Number(v.w) || 0.05, 0.005, 1);
      if (v.h !== undefined) s.h = clamp(Number(v.h) || 0.05, 0.005, 1);
      if (v.color !== undefined) s.color = color(v.color, s.color || '#c9b98f');
      if (v.text !== undefined) s.text = str(v.text, 300);
      // Shapes stay fully on the map.
      s.x = Math.min(s.x, 1 - s.w);
      s.y = Math.min(s.y, 1 - s.h);
    };
    if (d.add) {
      if (map.shapes.length >= 500) throw new Error('This map has too many shapes');
      const s = { id: id(), type: SHAPE_TYPES.includes(d.add.type) ? d.add.type : 'rect', color: '#c9b98f', text: '' };
      apply(s, { x: 0.4, y: 0.4, w: 0.1, h: 0.1, ...d.add });
      map.shapes.push(s);
      return { shapeId: s.id };
    }
    if (d.update) {
      const s = map.shapes.find((x) => x.id === d.update.id);
      if (!s) throw new Error('Shape not found');
      apply(s, d.update);
    }
    if (d.remove) map.shapes = map.shapes.filter((s) => s.id !== d.remove);
  });

  dmOn('dm:drawing', (d) => {
    const map = drawingMap();
    const h = historyFor(map);
    const current = JSON.stringify({ walls: map.walls, shapes: map.shapes });
    const restore = (snap) => {
      Object.assign(map, JSON.parse(snap));
      h.lastKey = null;
    };
    if (d.undo) {
      if (!h.undo.length) throw new Error('Nothing to undo');
      h.redo.push(current);
      restore(h.undo.pop());
    }
    if (d.redo) {
      if (!h.redo.length) throw new Error('Nothing to redo');
      h.undo.push(current);
      restore(h.redo.pop());
    }
    if (d.reset && (map.walls.length || map.shapes.length)) {
      snapshotDrawing(map);
      map.walls = [];
      map.shapes = [];
    }
  });

  dmOn('dm:deleteMap', (d) => {
    state.maps = state.maps.filter((m) => m.id !== d.id);
    drawHistory.delete(d.id);
    state.enemies = state.enemies.filter((e) => e.mapId !== d.id);
    state.players.forEach((p) => delete p.positions[d.id]);
    state.npcs.forEach((n) => n.positions && delete n.positions[d.id]);
    if (state.currentMapId === d.id) state.currentMapId = state.maps[0] ? state.maps[0].id : null;
    // The image file is left on disk: campaigns made from older saves may share it.
  });

  // Token drags are frequent, so they skip the full broadcast and send only the move.
  socket.on('dm:move', (d = {}) => {
    if (socket.data.role !== 'dm' || !state.currentMapId) return;
    const pos = { x: frac(d.x), y: frac(d.y) };
    if (d.kind === 'player') {
      const p = findPlayer(d.id);
      if (!p) return;
      p.positions[state.currentMapId] = pos;
    } else if (d.kind === 'npc') {
      const n = state.npcs.find((x) => x.id === d.id);
      if (!n || !n.positions || !n.positions[state.currentMapId]) return;
      n.positions[state.currentMapId] = pos;
    } else {
      const e = findEnemy(d.id);
      if (!e) return;
      Object.assign(e, pos);
    }
    scheduleAutosave();
    socket.broadcast.emit('token', { kind: d.kind, id: d.id, ...pos });
  });

  // The DM's zoom and pan, for the TV to follow (null = TV shows the whole map).
  // Sent often while zooming, so like token moves it skips the full broadcast.
  socket.on('dm:camera', (d) => {
    if (socket.data.role !== 'dm') return;
    camera = d && state.currentMapId
      ? { mapId: state.currentMapId, zoom: clamp(Number(d.zoom) || 1, 0.25, 8), cx: frac(d.cx), cy: frac(d.cy) }
      : null;
    for (const s of io.sockets.sockets.values()) if (s.data.role === 'tv') s.emit('camera', tvCamera());
  });

  // ----- DM: players -----

  dmOn('dm:player', (d) => {
    const p = findPlayer(d.id);
    if (!p) throw new Error('Player not found');
    const patch = d.patch || {};
    if (patch.maxHp !== undefined) p.maxHp = clamp(int(patch.maxHp, p.maxHp), 1, 99999);
    if (patch.hp !== undefined) p.hp = clamp(int(patch.hp, p.hp), -99999, 99999);
    if (patch.hpDelta !== undefined) p.hp = clamp(p.hp + int(patch.hpDelta), -99999, 99999);
    if (patch.die !== undefined) p.die = sides(patch.die);
    if (patch.rollMode !== undefined) p.rollMode = patch.rollMode === 'physical' ? 'physical' : 'digital';
    if (patch.color !== undefined) p.color = color(patch.color, p.color);
    if (patch.name !== undefined) p.name = str(patch.name, 30).trim() || p.name;
    if (patch.statuses !== undefined) p.statuses = statusList(patch.statuses);
    if (patch.dead !== undefined) p.dead = !!patch.dead;
    if (patch.attributes) setAttributeValues(p, patch.attributes);
    if (patch.giveItem) p.sheet.inventory.push({ name: str(patch.giveItem.name, 60), note: str(patch.giveItem.note, 200) });
  });

  dmOn('dm:allPlayers', (d) => {
    for (const p of state.players) {
      if (d.die !== undefined) p.die = sides(d.die);
      if (d.rollMode !== undefined) p.rollMode = d.rollMode === 'physical' ? 'physical' : 'digital';
    }
  });

  // The campaign's attribute list, and who fills in the values.
  dmOn('dm:attributes', (d) => {
    if (d.add) {
      const names = (Array.isArray(d.add) ? d.add : [d.add]).map((n) => str(n, 30).trim()).filter(Boolean);
      for (const name of names) {
        if (state.attributes.length >= 30) break;
        if (state.attributes.some((a) => a.name.toLowerCase() === name.toLowerCase())) continue;
        state.attributes.push({ id: id(), name });
      }
    }
    if (d.rename) {
      const a = state.attributes.find((x) => x.id === d.rename.id);
      const name = str(d.rename.name, 30).trim();
      if (a && name) a.name = name;
    }
    if (d.remove) state.attributes = state.attributes.filter((a) => a.id !== d.remove);
    if (d.mode !== undefined) state.attributeMode = d.mode === 'dm' ? 'dm' : 'players';
  });

  dmOn('dm:removePlayer', (d) => {
    state.players = state.players.filter((p) => p.id !== d.id);
  });

  // ----- DM: enemies -----

  dmOn('dm:addEnemy', (d) => {
    if (!state.currentMapId) throw new Error('Show a map first');
    const maxHp = clamp(int(d.maxHp, 10), 1, 99999);
    const name = str(d.name, 40).trim() || 'Enemy';
    state.enemies.push({
      id: id(), mapId: state.currentMapId, name,
      label: str(d.label, 3).trim() || name.slice(0, 2).toUpperCase(),
      x: 0.5 + (Math.random() - 0.5) * 0.1, y: 0.5 + (Math.random() - 0.5) * 0.1,
      hp: maxHp, maxHp, statuses: [], hidden: !!d.hidden, color: color(d.color, ENEMY_COLOR),
    });
  });

  dmOn('dm:enemy', (d) => {
    const e = findEnemy(d.id);
    if (!e) throw new Error('Enemy not found');
    const patch = d.patch || {};
    if (patch.maxHp !== undefined) e.maxHp = clamp(int(patch.maxHp, e.maxHp), 1, 99999);
    if (patch.hp !== undefined) e.hp = clamp(int(patch.hp, e.hp), -99999, 99999);
    if (patch.hpDelta !== undefined) e.hp = clamp(e.hp + int(patch.hpDelta), -99999, 99999);
    if (patch.name !== undefined) e.name = str(patch.name, 40).trim() || e.name;
    if (patch.label !== undefined) e.label = str(patch.label, 3).trim() || e.label;
    if (patch.color !== undefined) e.color = color(patch.color, e.color || ENEMY_COLOR);
    if (patch.hidden !== undefined) e.hidden = !!patch.hidden;
    if (patch.statuses !== undefined) e.statuses = statusList(patch.statuses);
  });

  dmOn('dm:removeEnemy', (d) => {
    state.enemies = state.enemies.filter((e) => e.id !== d.id);
  });

  // ----- DM: NPCs -----

  dmOn('dm:npc', (d) => {
    let n = state.npcs.find((x) => x.id === d.id);
    if (!n) {
      n = { id: id(), name: '', description: '', location: '', revealAll: false, revealedTo: [], positions: {} };
      state.npcs.push(n);
    }
    if (!n.positions) n.positions = {}; // NPCs from older saves
    if (d.onMap !== undefined) {
      if (!state.currentMapId) throw new Error('Show a map first');
      if (d.onMap) n.positions[state.currentMapId] = { x: 0.5 + (Math.random() - 0.5) * 0.1, y: 0.5 + (Math.random() - 0.5) * 0.1 };
      else delete n.positions[state.currentMapId];
    }
    n.name = str(d.name, 60).trim() || n.name || 'Unnamed';
    if (d.color !== undefined) n.color = color(d.color, n.color || NPC_COLOR);
    if (d.description !== undefined) n.description = str(d.description, 2000);
    if (d.location !== undefined) n.location = str(d.location, 100);
    if (d.revealAll !== undefined) n.revealAll = !!d.revealAll;
    if (Array.isArray(d.revealedTo)) n.revealedTo = d.revealedTo.filter((pid) => findPlayer(pid));
    if (d.relationship && findPlayer(d.relationship.playerId) && RELATIONSHIPS.includes(d.relationship.level)) {
      n.relationships = { ...n.relationships, [d.relationship.playerId]: d.relationship.level };
    }
    return { npcId: n.id };
  });

  // The NPC turns on the party: an enemy token takes its place on the map. The NPC
  // entry stays so players keep their notes, but every relationship becomes Hostile.
  dmOn('dm:npcToEnemy', (d) => {
    const n = state.npcs.find((x) => x.id === d.id);
    if (!n) throw new Error('NPC not found');
    if (!state.currentMapId) throw new Error('Show a map first');
    const pos = (n.positions && n.positions[state.currentMapId]) || { x: 0.5, y: 0.5 };
    const maxHp = clamp(int(d.maxHp, 10), 1, 99999);
    state.enemies.push({
      id: id(), mapId: state.currentMapId, name: n.name,
      label: initials(n.name),
      x: pos.x, y: pos.y, hp: maxHp, maxHp, statuses: [], hidden: false, npcId: n.id, color: n.color || ENEMY_COLOR,
    });
    if (n.positions) delete n.positions[state.currentMapId];
    n.relationships = Object.fromEntries(state.players.map((p) => [p.id, 'Hostile']));
  });

  dmOn('dm:deleteNpc', (d) => {
    state.npcs = state.npcs.filter((n) => n.id !== d.id);
  });

  // ----- DM: rolls and rulings -----

  dmOn('dm:roll', (d) => {
    const die = sides(d.die);
    const physical = d.mode === 'physical';
    pushLog({
      kind: 'dm', who: 'DM', color: '#888780', action: str(d.label, 200).trim(),
      die, result: physical ? clamp(int(d.result), 0, 9999) : roll(die),
      mode: physical ? 'physical' : 'digital', secret: !!d.secret, ruled: true,
    });
  });

  dmOn('dm:logEntry', (d) => {
    const entry = state.log.find((l) => l.id === d.id);
    if (!entry) throw new Error('Roll not found');
    if (d.result !== undefined) entry.result = d.result === '' || d.result === null ? null : clamp(int(d.result), 0, 9999);
    if (d.secret !== undefined) entry.secret = !!d.secret;
    if (d.ruling !== undefined) {
      entry.ruling = str(d.ruling, 500).trim();
      entry.ruled = true;
      entry.ruledAt = Date.now();
    }
    if (d.dismiss) entry.ruled = true;
  });

  dmOn('dm:clearLog', () => {
    state.log = [];
  });

  // ----- DM: campaigns -----
  // One campaign plays at a time. Switching keeps the room code, so the TV's QR still works;
  // phones whose character isn't in the new campaign go back to the character picker.

  dmOn('dm:listCampaigns', () => {
    saveCampaign(); // so the list shows the latest of the one being played
    return { activeId: state.campaignId, campaigns: listCampaigns() };
  });

  dmOn('dm:openCampaign', (d) => {
    if (!isId(d.id) || !fs.existsSync(campaignDir(d.id))) throw new Error('Campaign not found');
    if (d.id === state.campaignId) return;
    saveCampaign();
    state = { ...readCampaign(d.id), roomCode: state.roomCode };
    setActive(state.campaignId);
  });

  dmOn('dm:newCampaign', (d) => {
    saveCampaign();
    state = { ...newState(str(d.name, 80).trim() || 'New campaign'), roomCode: state.roomCode };
    saveCampaign();
    setActive(state.campaignId);
  });

  dmOn('dm:deleteCampaign', (d) => {
    if (!isId(d.id)) throw new Error('Campaign not found');
    if (d.id === state.campaignId) throw new Error('Open a different campaign before deleting this one');
    fs.rmSync(campaignDir(d.id), { recursive: true, force: true });
    return { activeId: state.campaignId, campaigns: listCampaigns() };
  });

  // Move a character's folder from one campaign to another (either may be the one playing).
  dmOn('dm:moveCharacter', (d) => {
    const { id: pid, from, to } = d;
    if (![pid, from, to].every(isId) || from === to) throw new Error('Pick a different campaign');
    if (!fs.existsSync(campaignDir(to))) throw new Error('Campaign not found');
    if (fs.existsSync(characterFile(to, pid))) throw new Error('That campaign already has this character');
    if (from === state.campaignId) {
      const p = findPlayer(pid);
      if (!p) throw new Error('Character not found');
      const moved = structuredClone(p);
      remapAttributes(moved, state.attributes, attributesOf(to));
      writeJson(characterFile(to, pid), moved);
      state.players = state.players.filter((x) => x.id !== pid);
      saveCampaign(); // removes the folder here
    } else {
      const file = characterFile(from, pid);
      if (!fs.existsSync(file)) throw new Error('Character not found');
      const p = readJson(file);
      remapAttributes(p, attributesOf(from), attributesOf(to));
      if (to === state.campaignId) state.players.push(p);
      else writeJson(characterFile(to, pid), p);
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      if (to === state.campaignId) saveCampaign();
    }
    return { activeId: state.campaignId, campaigns: listCampaigns() };
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  Tabletop is running');
  console.log(`  Campaign: ${state.campaignName}`);
  console.log(`  TV:       http://localhost:${PORT}/tv`);
  console.log(`  DM:       http://localhost:${PORT}/dm   (PIN ${DM_PIN})`);
  console.log(`  Players:  ${JOIN_URL}   (room code ${state.roomCode})`);
  console.log('');
});
