'use strict';
// Arena Blitz — a Smash TV-style twin-stick arena shooter.
// Left thumb moves, right thumb aims, the gun fires on its own.
// Each round you get a fresh set of power attacks (Blast, Missiles, Blades).

(() => {
// ---------------------------------------------------------------- setup
const W = 880, H = 500;          // arena size in world units (wide and short to fill phone screens, so everything draws bigger)
const WALL = 26, DOOR_W = 90;
const SPR = 1.25;                // characters draw (and enemies collide) this much bigger than their art
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

let dpr = 1, scale = 1, offX = 0, offY = 0, sw = 0, sh = 0;
let safe = { l: 0, r: 0, t: 0, b: 0 };   // iPhone notch / home bar insets, in CSS px

const rand = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const d2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
function weighted(pairs) {
  const total = pairs.reduce((s, p) => s + p[1], 0);
  let r = Math.random() * total;
  for (const [v, w] of pairs) if ((r -= w) <= 0) return v;
  return pairs[pairs.length - 1][0];
}
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
const vibrate = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} };
let netOut = null;   // while hosting: effects and sounds queued up to replay on friends' phones

// ---------------------------------------------------------------- sound
const Sound = {
  ctx: null, noiseBuf: null, muted: store.get('arena_muted', false), lastShot: 0, lastBoom: 0,
  init() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
      const len = this.ctx.sampleRate * 1;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },
  tone(...a) { this.beep(...a); },
  beep(f, dur, type = 'square', vol = 0.05, f2 = null) {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(t); o.stop(t + dur);
  },
  noise(dur, vol = 0.2, freq = 1200) {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime, s = this.ctx.createBufferSource();
    const f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    s.buffer = this.noiseBuf;
    f.type = 'lowpass';
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(60, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.ctx.destination);
    s.start(t); s.stop(t + dur);
  },
  shot() {
    const now = performance.now();
    if (now - this.lastShot < 75) return;
    this.lastShot = now;
    this.beep(rand(820, 900), 0.05, 'square', 0.012, 300);
  },
  hit() { this.beep(rand(180, 240), 0.05, 'square', 0.02, 90); },
  boom(big) {
    const now = performance.now();
    if (!big && now - this.lastBoom < 40) return;
    this.lastBoom = now;
    this.noise(big ? 0.9 : 0.25, big ? 0.35 : 0.1, big ? 2200 : 900);
  },
  hurt() { this.beep(220, 0.3, 'sawtooth', 0.08, 50); },
  pickup() { this.beep(660, 0.08, 'square', 0.04); setTimeout(() => this.beep(990, 0.1, 'square', 0.04), 70); },
  power() { this.beep(160, 0.45, 'sawtooth', 0.06, 1400); },
  denied() { this.beep(110, 0.12, 'square', 0.04); },
  jingle(notes, gap = 110) { notes.forEach((f, i) => setTimeout(() => this.beep(f, 0.16, 'square', 0.045), i * gap)); },
};
// Game sounds also play on friends' phones. (Shop and menu sounds call these through localSound.)
for (const k of ['tone', 'shot', 'hit', 'boom', 'hurt', 'pickup', 'power', 'jingle']) {
  const f = Sound[k];
  Sound[k] = function (...a) { if (netOut) netOut.push(['s', k, a]); return f.apply(this, a); };
}
function localSound(fn) { const o = netOut; netOut = null; try { fn(); } finally { netOut = o; } }

// ---------------------------------------------------------------- data
const WEAPONS = {
  basic:  { name: 'BLASTER', rate: 0.12, count: 1, arc: 0,    jitter: 0.03, dmg: 1,   color: '#fff' },
  rapid:  { name: 'RAPID',   rate: 0.05, count: 1, arc: 0,    jitter: 0.09, dmg: 1,   color: '#ff9f1a' },
  spread: { name: 'SPREAD',  rate: 0.14, count: 5, arc: 0.65, jitter: 0.02, dmg: 1,   color: '#5be36b' },
  laser:  { name: 'LASER',   rate: 0.1,  count: 1, arc: 0,    jitter: 0.01, dmg: 1.5, color: '#ff4fd8', pierce: 3, speed: 980 },
};

const ETYPES = {
  grunt:    { r: 12, hp: 2,  speed: 80,  color: '#ff6a3d', score: 100,   cr: 1 },
  runner:   { r: 9,  hp: 1,  speed: 165, color: '#ffd43b', score: 150,   cr: 1 },
  shooter:  { r: 13, hp: 4,  speed: 70,  color: '#33ddff', score: 300,   cr: 2 },
  splitter: { r: 16, hp: 5,  speed: 62,  color: '#5be36b', score: 250,   cr: 2 },
  tank:     { r: 22, hp: 14, speed: 42,  color: '#b266ff', score: 600,   cr: 4 },
  boss:     { r: 48, hp: 300, speed: 45, color: '#ff3366', score: 10000, cr: 40 },
};

// Upgrade shop opens after every SHOP_EVERY rounds. Prices go up by `step` per level owned.
const SHOP_EVERY = 2;
const UPGRADES = [
  { id: 'damage',   icon: '💥', name: 'FIREPOWER',      desc: '+25% bullet damage',        max: 8, cost: 25, step: 20 },
  { id: 'rate',     icon: '⚡', name: 'TRIGGER FINGER', desc: '+15% fire rate',            max: 6, cost: 25, step: 20 },
  { id: 'multi',    icon: '🔱', name: 'MULTI-SHOT',     desc: '+1 bullet per shot',        max: 3, cost: 50, step: 40 },
  { id: 'pierce',   icon: '🎯', name: 'PIERCING',       desc: 'Bullets pass through +1',   max: 3, cost: 40, step: 35 },
  { id: 'speed',    icon: '👟', name: 'SPEED BOOTS',    desc: '+10% move speed',           max: 4, cost: 20, step: 15 },
  { id: 'hp',       icon: '🛡️', name: 'ARMOR',          desc: '+1 max heart',              max: 6, cost: 35, step: 25 },
  { id: 'blast',    icon: '💣', name: 'EXTRA BLAST',    desc: '+1 BLAST each round',       max: 2, cost: 50, step: 40 },
  { id: 'missiles', icon: '🚀', name: 'MISSILE PODS',   desc: '+6 missiles per volley',    max: 3, cost: 30, step: 25 },
  { id: 'blades',   icon: '🌀', name: 'BLADE MASTER',   desc: '+1 blade, +2s spin time',   max: 3, cost: 30, step: 25 },
  { id: 'magnet',   icon: '🧲', name: 'MAGNET',         desc: 'Pull pickups, +50% drops',  max: 2, cost: 25, step: 25 },
  { id: 'crit',     icon: '🍀', name: 'LUCKY SHOT',     desc: '+8% chance of 3x damage',   max: 5, cost: 30, step: 25 },
  { id: 'regen',    icon: '💉', name: 'FIELD MEDIC',    desc: 'Heal 1 heart every round',  max: 2, cost: 60, step: 60 },
  { id: 'surge',    icon: '⏱️', name: 'POWER SURGE',    desc: 'Gun pickups last +4s',      max: 3, cost: 25, step: 20 },
  { id: 'over',     icon: '🔥', name: 'OVERCHARGE',     desc: '+10% damage, no limit',     max: Infinity, cost: 80, step: 40 },
];

// Gear: bought in the shop, kicks in when the next round's fight starts and runs on a
// timer, just like a pickup. Price grows with the round.
const GEAR = [
  { id: 'spread', icon: '🔱', name: 'SPREAD GUN',  desc: 'Fire 5 shots at once',       cost: 12, per: 1.5, gun: true },
  { id: 'rapid',  icon: '🔫', name: 'RAPID FIRE',  desc: 'More than twice as fast',    cost: 10, per: 1.5, gun: true },
  { id: 'laser',  icon: '🔴', name: 'LASER',       desc: 'Hard hits, pierces 3',       cost: 15, per: 2, gun: true },
  { id: 'shield', icon: '🛡️', name: 'FORCE FIELD', desc: 'Blocks up to 2 hits',        cost: 12, per: 1.5 },
  { id: 'drone',  icon: '🤖', name: 'BUDDY DRONE', desc: 'Helper that shoots for you', cost: 15, per: 2 },
  { id: 'gems',   icon: '💎', name: 'GEM DOUBLER', desc: 'Double ◆ from kills',         cost: 12, per: 1 },
  { id: 'pack',   icon: '🔋', name: 'POWER PACK',  desc: '+1 of every power',          cost: 20, per: 2, once: true },
];
const gearCost = g => Math.round(g.cost + g.per * round);
const buffTime = (p = me) => 10 + 4 * L(p, 'surge');   // same length as a gun pickup

const ABILITIES = [
  { id: 'blast',    name: 'BLAST',    max: 1, color: '#ff5533', keys: ['1', 'q', ' '] },
  { id: 'missiles', name: 'MISSILES', max: 2, color: '#33ccff', keys: ['2', 'e'] },
  { id: 'blades',   name: 'BLADES',   max: 1, color: '#cc66ff', keys: ['3', 'r'] },
];

const PICKUPS = {
  heart:  { color: '#ff4466', label: '♥', name: '+1 LIFE' },
  rapid:  { color: '#ff9f1a', label: 'R', name: 'RAPID FIRE!' },
  laser:  { color: '#ff4fd8', label: 'L', name: 'LASER!' },
  spread: { color: '#5be36b', label: 'S', name: 'SPREAD GUN!' },
  charge: { color: '#33ccff', label: '⚡', name: '' },
  coin:   { color: '#4dfff0', label: '◆', name: '+10 ◆' },
};

const doors = [
  { x: W / 2,        y: WALL / 2,     nx: 0,  ny: 1,  flash: 0 },
  { x: W / 2,        y: H - WALL / 2, nx: 0,  ny: -1, flash: 0 },
  { x: WALL / 2,     y: H / 2,        nx: 1,  ny: 0,  flash: 0 },
  { x: W - WALL / 2, y: H / 2,        nx: -1, ny: 0,  flash: 0 },
];

// Every 5 rounds (one act, ending in a boss) the arena gets a new look.
const THEMES = [
  { name: 'NEON STUDIO', base: '#17142a', tiles: ['#1d1a33', '#221e3b'], wall: '#2b2550', neon: '#ff3df0', ring: '#33ccff', bulb: '#ffe066', bulbOff: '#5a4a2a' },
  { name: 'TOXIC DOME',  base: '#0f1a14', tiles: ['#13241a', '#182c20'], wall: '#1f3b2a', neon: '#7cfc00', ring: '#ffe03c', bulb: '#d4ff4d', bulbOff: '#3a4a1a' },
  { name: 'FROST RINK',  base: '#0f1826', tiles: ['#14233a', '#192a45'], wall: '#22395a', neon: '#5fe1ff', ring: '#ffffff', bulb: '#d8f7ff', bulbOff: '#2a4256' },
  { name: 'INFERNO',     base: '#1f0e0b', tiles: ['#2a1410', '#331912'], wall: '#4a1d12', neon: '#ff6a1a', ring: '#ffc83c', bulb: '#ffb347', bulbOff: '#5a2a14' },
];

// Pillar layouts. Pillars block movement and all bullets, so they work as cover.
const pl = (fx, fy, r) => ({ x: fx * W, y: fy * H, r });
const LAYOUTS = {
  four:    [pl(0.3, 0.3, 30), pl(0.7, 0.3, 30), pl(0.3, 0.7, 30), pl(0.7, 0.7, 30)],
  corners: [pl(0.17, 0.22, 38), pl(0.83, 0.22, 38), pl(0.17, 0.78, 38), pl(0.83, 0.78, 38)],
  diamond: [pl(0.5, 0.25, 26), pl(0.5, 0.75, 26), pl(0.3, 0.5, 26), pl(0.7, 0.5, 26)],
  lanes:   [0.28, 0.5, 0.72].flatMap(fx => [pl(fx, 0.3, 22), pl(fx, 0.7, 22)]),
  ring:    [0, 1, 2, 3, 4, 5].map(k => ({ x: W / 2 + Math.cos(k * Math.PI / 3 + Math.PI / 6) * 190,
                                         y: H / 2 + Math.sin(k * Math.PI / 3 + Math.PI / 6) * 135, r: 20 })),
};

// Round twists: most rounds from round 3 on get one special rule.
const TWISTS = {
  swarm:     { name: 'SWARM',       hint: 'A flood of fast bugs!',                        color: '#ffd43b', from: 3 },
  ambush:    { name: 'AMBUSH',      hint: 'Enemies warp in anywhere: watch the red rings', color: '#ff4466', from: 3 },
  cash:      { name: 'CASH RUSH',   hint: 'Double ◆ from every kill',                     color: '#4dfff0', from: 3 },
  mines:     { name: 'MINEFIELD',   hint: 'Shoot the mines or lure enemies onto them',    color: '#ff9f1a', from: 3 },
  snipers:   { name: 'SNIPER NEST', hint: 'Drones everywhere: hide behind pillars',       color: '#33ddff', from: 4 },
  overdrive: { name: 'OVERDRIVE',   hint: 'Faster enemies, but free rapid fire',          color: '#ff9f1a', from: 4 },
  lights:    { name: 'LIGHTS OUT',  hint: 'You can only see what is near you',            color: '#9b8cff', from: 5 },
  heavy:     { name: 'HEAVY METAL', hint: 'Fewer enemies, all of them big',               color: '#b266ff', from: 6 },
};

// Each arena theme has its own boss (same order as THEMES).
const BOSSES = [
  { id: 'overlord', name: 'THE OVERLORD',  color: '#ff3366', hint: 'Twin cannons, bullet rings and minions' },
  { id: 'queen',    name: 'SLUDGE QUEEN',  color: '#7cfc00', hint: 'Dodge the acid and stay out of the puddles' },
  { id: 'sentinel', name: 'CRYO SENTINEL', color: '#5fe1ff', hint: 'Sidestep its charge, then hit it while it is dazed' },
  { id: 'titan',    name: 'MAGMA TITAN',   color: '#ff6a1a', hint: 'Watch the floor for meteors; slip through the gap in the fire' },
];
const bossDef = () => BOSSES[themeIdx % BOSSES.length];

const INTRO = {
  runner: 'SKITTER (fast)', shooter: 'EYE DRONE (shoots)', splitter: 'SLIME (splits in two)', tank: 'JUGGERNAUT (armored)',
};

// ---------------------------------------------------------------- state
let state = 'title';      // notes | title | play | shop | over
let paused = false;
let players = [], me = null;   // me = the player this phone controls
let bullets = [], ebullets = [], enemies = [], particles = [], pickups = [], texts = [], missiles = [], effects = [], boss = null;
let round = 0, score = 0, combo = 0, comboT = 0;
let spawnQueue = [], spawnT = 0, roundPhase = 'intro', phaseT = 0;
let shake = 0, flash = 0, flashColor = '255,255,255', time = 0, overT = 0;
let banner = null;
let best = store.get('arena_best', 0);
let newBest = false;
let shopCards = [], shopMsg = null, shopTab = 'up', shopTabs = [];
let nPlayers = 1, crowd = 1, nextEid = 1, enemiesLeft = 0;   // crowd = how much bigger waves are with friends
let twist = null, lastTwist = null, forcedTwist = null, lastLayout = null, themeIdx = 0;
let pillars = [], mines = [], warps = [], strikes = [], puddles = [], seen = new Set();

const L = (p, id) => p.levels[id] || 0;   // a player's upgrade level
const lvl = id => L(me, id);
const upgradeCost = (u, p = me) => u.cost + u.step * L(p, u.id);
const healCost = () => 15 + round * 2;
const alive = () => players.filter(p => !p.down);

// Each player's suit color.
const PCOL = [
  { main: '#6bb4ff', dark: '#1a52a8', edge: '#0c2a5a', pad: '#2f74d0', tag: '#33ccff' },
  { main: '#ff9a8a', dark: '#b8261b', edge: '#5a0c0c', pad: '#d0402f', tag: '#ff6b6b' },
  { main: '#9dff8a', dark: '#1f9a3a', edge: '#0c4a1a', pad: '#2fb04f', tag: '#7CFC00' },
  { main: '#ffe27a', dark: '#c08a12', edge: '#5a400c', pad: '#d0a02f', tag: '#ffd43b' },
];
const pname = p => 'P' + (p.pid + 1);

function makePlayer(pid) {
  return {
    pid, x: W / 2, y: H / 2, r: 13, hp: 5, maxHp: 5, inv: 0,
    fireT: 0, weapon: 'basic', weaponT: 0, weaponMax: 10, shield: 0, ax: 1, ay: 0,
    blades: 0, bladeA: 0, walk: 0, muzzle: 0, moving: false, down: false, joining: false,
    credits: 0, levels: {}, charges: [0, 0, 0], gear: [], buffs: { shield: 0, drone: 0, gems: 0 }, buffMax: 10,
    drone: { a: pid * 1.6, t: 0 }, flawless: true, ready: false,
  };
}

function newGame() {
  const pids = net.role === 'host' ? [0, ...[...net.peers.values()].map(c => c.pid)] : [0];
  players = pids.sort().map(makePlayer);
  me = players[0];
  players.forEach((p, i) => { p.x = W / 2 + (i - (players.length - 1) / 2) * 50; });
  shopTab = 'up';
  bullets = []; ebullets = []; enemies = []; particles = [];
  pickups = []; texts = []; missiles = []; effects = [];
  pillars = []; mines = []; warps = [];
  boss = null;
  twist = lastTwist = lastLayout = null; seen = new Set(['grunt']);
  score = 0; combo = 0; comboT = 0; shake = 0; flash = 0;
  newBest = false; againAsked = false;
  state = 'play'; paused = false;
  startRound(1);
}

function startRound(n) {
  round = n;
  nPlayers = players.length;
  crowd = 1 + 0.6 * (nPlayers - 1);
  for (const p of players) if (p.down) revive(p);
  const isBoss = n % 5 === 0;
  const notes = [];
  if ((n - 1) % 5 === 0) {
    setTheme(Math.floor((n - 1) / 5));
    notes.push(`ACT ${themeIdx + 1}: ${THEMES[themeIdx % THEMES.length].name}`);
  }
  twist = pickTwist(n, isBoss);
  setupArena(n, isBoss);
  spawnQueue = buildWave(n);
  spawnT = 0;
  roundPhase = 'intro'; phaseT = 2;
  for (const p of players) {
    p.flawless = true; p.ready = false;
    p.charges = ABILITIES.map(a => a.max + (a.id === 'blast' ? L(p, 'blast') : 0) + (p.gear.includes('pack') ? 1 : 0));
    p.buffs = { shield: 0, drone: 0, gems: 0 }; p.shield = 0;
    if (n > 1 && L(p, 'regen')) p.hp = Math.min(p.maxHp, p.hp + L(p, 'regen'));
  }
  const fresh = [...new Set(spawnQueue)].filter(t => INTRO[t] && !seen.has(t));
  fresh.forEach(t => seen.add(t));
  if (fresh.length) notes.push('NEW ENEMY: ' + fresh.map(t => INTRO[t]).join(', '));
  const tw = twist && TWISTS[twist];
  showBanner(`ROUND ${n}`, isBoss ? `BOSS: ${bossDef().name}! ${bossDef().hint}` : tw ? `${tw.name}: ${tw.hint}` : 'POWERS RECHARGED. FIGHT!',
    notes.join('   ·   '), isBoss ? bossDef().color : tw ? tw.color : '#fff');
  if (isBoss) Sound.jingle([196, 185, 175, 165], 160);
}

// A downed player comes back at the start of the next round (someone who just joined comes in fresh).
function revive(p) {
  p.down = false;
  p.hp = p.joining ? p.maxHp : Math.max(1, Math.ceil(p.maxHp / 2));
  p.joining = false; p.inv = 2;
  p.x = W / 2 + rand(-60, 60); p.y = H / 2 + rand(-40, 40);
}

// Switch on whatever was bought in the shop. Called when the fight starts.
function activateGear() {
  for (const p of players) {
    if (!p.gear.length) continue;
    const t = buffTime(p);
    const gun = GEAR.find(g => g.gun && p.gear.includes(g.id));
    if (gun) { p.weapon = gun.id; p.weaponT = p.weaponMax = t; }
    p.buffMax = t;
    for (const id of ['shield', 'drone', 'gems']) if (p.gear.includes(id)) p.buffs[id] = t;
    if (p.gear.includes('shield')) p.shield = 2;
    p.gear = [];
    Sound.power();
    addText(p.x, p.y - 34, 'GEAR ON!', '#7CFC00', 16, 1);
  }
}

function updateBuffs(p, dt) {
  for (const id in p.buffs) if (p.buffs[id] > 0) p.buffs[id] = Math.max(0, p.buffs[id] - dt);
  if (p.buffs.shield <= 0) p.shield = 0;
}

function pickTwist(n, isBoss) {
  if (forcedTwist !== null) { const f = forcedTwist; forcedTwist = null; return f || null; }
  if (isBoss || n < 3) return null;
  if (n > 3 && Math.random() < 0.2) return null;   // the odd plain round
  const t = pick(Object.keys(TWISTS).filter(k => TWISTS[k].from <= n && k !== lastTwist));
  lastTwist = t;
  return t;
}

function setupArena(n, isBoss) {
  pillars = []; mines = []; warps = []; strikes = []; puddles = [];
  let lay = null;
  if (isBoss) lay = 'four';
  else if (n >= 2 && (twist === 'snipers' || Math.random() > 0.15)) lay = pick(Object.keys(LAYOUTS).filter(k => k !== lastLayout));
  lastLayout = lay;
  if (lay) pillars = LAYOUTS[lay].map(c => ({ ...c, rise: 0 }));
  for (const p of players) pushOutOfPillars(p, p.r);
  if (twist === 'mines') placeMines(8 + Math.min(6, n >> 1));
}

function setTheme(i) { themeIdx = i; buildFloor(THEMES[i % THEMES.length]); }

function buildWave(n) {
  const q = [];
  const isBoss = n % 5 === 0;
  let count = isBoss ? 8 + n * 2 : 12 + n * 5;
  let pool = [['grunt', 10]];
  if (n >= 2) pool.push(['runner', 3 + n]);
  if (n >= 3) pool.push(['shooter', 2 + n * 0.5]);
  if (n >= 4) pool.push(['splitter', 3 + n * 0.4]);
  if (n >= 6) pool.push(['tank', 1 + n * 0.3]);
  if (twist === 'swarm') { count = Math.round(count * 1.6); pool = [['runner', 8], ['grunt', 2]]; }
  else if (twist === 'snipers') { count = Math.round(count * 0.8); pool = [['shooter', 5], ['grunt', 3], ['runner', 2]]; }
  else if (twist === 'heavy') { count = Math.max(6, Math.round(count * 0.4)); pool = [['tank', 4], ['splitter', 4], ['grunt', 1]]; }
  count = Math.round(count * crowd);   // bigger waves with friends
  for (let i = 0; i < count; i++) q.push(weighted(pool));
  if (n === 3) q.splice(q.length >> 1, 0, 'tank');   // first taste of a big guy
  if (isBoss) q.unshift('boss');
  return q;
}

function showBanner(title, sub, note = '', color = '#fff') { banner = { title, sub, note, color, t: note ? 3.4 : 2.6 }; }

// ---------------------------------------------------------------- entities
function makeEnemy(type, x, y) {
  const d = ETYPES[type];
  const hpMul = (1 + (round - 1) * 0.1) * (1 + 0.15 * (nPlayers - 1));
  const spMul = Math.min(1.6, 1 + (round - 1) * 0.03) * (twist === 'overdrive' ? 1.3 : 1);
  const e = {
    id: nextEid++, type, x, y, r: d.r * SPR, color: d.color, score: d.score, cr: d.cr,
    hp: Math.ceil(d.hp * hpMul), maxHp: 0,
    speed: d.speed * spMul * rand(0.9, 1.1),
    kx: 0, ky: 0, hitT: 0, bladeCD: 0, t: rand(0, 10), wob: rand(0, Math.PI * 2),
    fireT: rand(1, 2.5), entering: false, dnx: 0, dny: 0, dead: false, face: 0,
  };
  if (type === 'boss') {
    const bd = bossDef();
    e.kind = bd.id; e.color = bd.color;
    e.hp = Math.round((260 + round * 45) * (1 + 0.8 * (nPlayers - 1)));   // much tougher with friends
    e.speed = d.speed;
    e.burstT = 2.5; e.spawnT = 4; e.fireT = 1.5;
    e.mode = 'walk'; e.modeT = 2.5; e.spin = 0; e.ring2T = 0; e.cdx = 0; e.cdy = 1; e.px = x; e.py = y;
  }
  e.maxHp = e.hp;
  return e;
}

function spawnFromDoor(type, door, i) {
  // Big groups queue up three abreast behind the door, so nobody starts outside the doorway
  const side = (i % 3 - 1) * 24, back = 12 + Math.floor(i / 3) * 34;
  const e = makeEnemy(type,
    door.x + (door.nx === 0 ? side : 0) - door.nx * back,
    door.y + (door.ny === 0 ? side : 0) - door.ny * back);
  e.entering = true; e.dnx = door.nx; e.dny = door.ny; e.enterT = 0;
  enemies.push(e);
  if (type === 'boss') boss = e;
}

function fireEnemyBullet(x, y, dx, dy, speed, color) {
  ebullets.push({ x, y, vx: dx * speed, vy: dy * speed, r: 6, life: 5, color });
}

function burst(x, y, color, n, spd, size = 4) {
  if (netOut) netOut.push(['b', Math.round(x), Math.round(y), color, n, spd, size]);
  for (let i = 0; i < n; i++) {
    const a = rand(0, Math.PI * 2), s = rand(0.2, 1) * spd;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.3, 0.8), max: 0.8, color, size: rand(size * 0.5, size * 1.4) });
  }
  if (particles.length > 700) particles.splice(0, particles.length - 700);
}

function addText(x, y, text, color = '#fff', size = 14, life = 0.8) {
  if (netOut) netOut.push(['t', Math.round(x), Math.round(y), text, color, size, life]);
  texts.push({ x, y, text, color, size, life, max: life });
}

// Shake, flash and buzz either everyone (p = null) or just one player's phone.
function addShake(n, p = null) {
  if (!p || p === me) shake = Math.max(shake, n);
  if (netOut && p !== me) netOut.push(['k', n, p ? p.pid : -1]);
}
function addFlash(a, color, p = null) {
  if (!p || p === me) { flash = a; flashColor = color; }
  if (netOut && p !== me) netOut.push(['f', a, color, p ? p.pid : -1]);
}
function buzz(ms, p = null) {
  if (!p || p === me) vibrate(ms);
  if (netOut && p !== me) netOut.push(['v', ms, p ? p.pid : -1]);
}

const comboMult = () => 1 + Math.min(4, Math.floor(combo / 10));

function damage(e, dmg, kvx = 0, kvy = 0, kb = 1) {
  if (e.dead) return;
  if (e.mode === 'stun') dmg *= 2;
  e.hp -= dmg;
  e.hitT = 0.07;
  if (e.type !== 'boss') {
    const l = Math.hypot(kvx, kvy) || 1;
    const k = (e.type === 'tank' ? 35 : 110) * kb;
    e.kx += kvx / l * k; e.ky += kvy / l * k;
  }
  if (e.hp <= 0) killEnemy(e);
}

function killEnemy(e) {
  e.dead = true;
  combo++; comboT = 2;
  const pts = e.score * comboMult();
  score += pts;
  // everyone gets paid for every kill; bigger waves pay less each, so it evens out with solo
  for (const p of players) p.credits += e.cr * (twist === 'cash' ? 2 : 1) * (p.buffs.gems > 0 ? 2 : 1) / crowd;
  if (e.type === 'boss') {
    burst(e.x, e.y, e.color, 90, 450, 7);
    burst(e.x, e.y, '#fff', 40, 300, 5);
    addShake(28); addFlash(0.7, '255,255,255');
    Sound.boom(true); buzz(200);
    for (let i = 0; i < 6; i++) dropPickup(e.x + rand(-60, 60), e.y + rand(-60, 60), true);
    addText(e.x, e.y - 60, '+' + pts, '#ffd43b', 28, 1.6);
    boss = null;
    strikes = []; puddles = [];
    for (const o of enemies) if (!o.dead && o.type !== 'boss') killEnemy(o);
  } else {
    burst(e.x, e.y, e.color, e.r > 18 ? 22 : 12, 220);
    Sound.boom(false);
    addShake(e.r > 18 ? 6 : 2);
    addText(e.x, e.y - e.r, '+' + pts, comboMult() > 1 ? '#ffd43b' : '#fff', 12, 0.6);
    if (Math.random() < 0.055 * (1 + 0.5 * Math.max(...players.map(p => L(p, 'magnet'))))) dropPickup(e.x, e.y);
    else if (twist === 'cash' && e.cr && Math.random() < 0.2) dropPickup(e.x, e.y, false, 'coin');
  }
  if (e.type === 'splitter') {
    for (let i = 0; i < 2; i++) {
      const m = makeEnemy('runner', e.x + rand(-8, 8), e.y + rand(-8, 8));
      if (!e.cr) m.cr = 0;
      m.kx = rand(-220, 220); m.ky = rand(-220, 220);
      enemies.push(m);
    }
  }
}

function dropPickup(x, y, rich = false, type = null) {
  const pool = [['rapid', 1.5], ['spread', 1.5], ['laser', 1], ['charge', 2], ['coin', rich ? 7 : 5]];
  if (alive().some(p => p.hp < p.maxHp)) pool.push(['heart', rich ? 4 : 2]);
  const pk = { type: type || weighted(pool), x: clamp(x, WALL + 20, W - WALL - 20), y: clamp(y, WALL + 20, H - WALL - 20), life: 9, t: 0 };
  pushOutOfPillars(pk, 16);
  pickups.push(pk);
}

function collect(pk, p) {
  const def = PICKUPS[pk.type];
  Sound.pickup();
  let label = def.name;
  switch (pk.type) {
    case 'heart': p.hp = Math.min(p.maxHp, p.hp + 1); break;
    case 'rapid': case 'spread': case 'laser':
      p.weapon = pk.type; p.weaponT = p.weaponMax = 10 + 4 * L(p, 'surge'); break;
    case 'coin': p.credits += 10; break;
    case 'charge': {
      const i = randi(0, ABILITIES.length - 1);
      p.charges[i]++;
      label = '+1 ' + ABILITIES[i].name;
      break;
    }
  }
  addText(pk.x, pk.y - 16, label, def.color, 15, 1.1);
}

function hurtPlayer(p) {
  if (!p || p.down || p.inv > 0 || state !== 'play') return;
  if (p.shield > 0) {   // force field soaks the hit
    p.shield--; p.inv = 1;
    burst(p.x, p.y, '#5fe1ff', 18, 220);
    addText(p.x, p.y - 34, p.shield ? 'SHIELD!' : 'SHIELD DOWN', '#5fe1ff', 15, 0.9);
    Sound.hit(); buzz(40, p);
    return;
  }
  p.hp--;
  p.inv = 1.6;
  p.flawless = false;
  addShake(14, p); addFlash(0.35, '255,40,60', p);
  combo = 0;
  Sound.hurt(); buzz(90, p);
  burst(p.x, p.y, PCOL[p.pid].pad, 16, 200);
  for (const e of enemies) {
    if (e.type === 'boss') continue;
    const dx = e.x - p.x, dy = e.y - p.y, dd = Math.hypot(dx, dy) || 1;
    if (dd < 140) { e.kx += dx / dd * 420; e.ky += dy / dd * 420; }
  }
  if (p.hp <= 0) downPlayer(p);
}

// Out of hearts. Solo that's game over; with friends you sit out until the next round.
function downPlayer(p) {
  p.down = true; p.hp = 0; p.blades = 0; p.weapon = 'basic'; p.weaponT = 0; p.shield = 0;
  p.buffs = { shield: 0, drone: 0, gems: 0 };
  burst(p.x, p.y, PCOL[p.pid].pad, 40, 300, 6);
  if (players.every(o => o.down)) { gameOver(); return; }
  Sound.boom(true);
  addText(p.x, p.y - 30, `${pname(p)} IS DOWN!`, '#ff4466', 16, 1.6);
  addText(p.x, p.y - 10, 'back next round', '#ffffff', 12, 1.6);
}

function gameOver() {
  state = 'over'; overT = 0;
  for (const p of players) {
    burst(p.x, p.y, PCOL[p.pid].pad, 60, 350, 6);
    burst(p.x, p.y, '#ffd3a0', 30, 250, 5);
  }
  Sound.boom(true);
  Sound.jingle([392, 330, 262, 196], 180);
  buzz([100, 60, 200]);
  if (score > best) { best = score; newBest = true; store.set('arena_best', best); }
  sticks.left = sticks.right = null;
}

// ---------------------------------------------------------------- abilities
function useAbility(i, p = me) {
  if (state !== 'play' || paused || !p || p.down) return;
  if (net.role === 'guest') {   // the host fires it; we just ask
    if (me.charges[i] > 0) { netSend(['a', i]); me.charges[i]--; btnPress[i] = 0.15; } else Sound.denied();
    return;
  }
  if (p.charges[i] <= 0) { if (p === me) Sound.denied(); return; }
  p.charges[i]--;
  if (p === me) btnPress[i] = 0.15;
  const id = ABILITIES[i].id;
  if (id === 'blast') {
    effects.push({ x: p.x, y: p.y, r: 10, max: 480, hit: new Set() });
    addShake(22); addFlash(0.4, '255,140,60');
    Sound.boom(true); Sound.power(); buzz(120, p);
    addText(p.x, p.y - 30, 'BLAST!', '#ff5533', 22, 1);
  } else if (id === 'missiles') {
    const base = Math.atan2(p.ay, p.ax);
    const n = 14 + 6 * L(p, 'missiles');
    for (let k = 0; k < n; k++) {
      const a = base + (k / (n - 1) - 0.5) * Math.PI * 1.7;
      missiles.push({ x: p.x, y: p.y, a, speed: 220, target: null, life: 3.5 });
    }
    Sound.power(); buzz(60, p);
    addText(p.x, p.y - 30, 'MISSILES!', '#33ccff', 22, 1);
  } else if (id === 'blades') {
    p.blades = 8 + 2 * L(p, 'blades');
    Sound.power(); buzz(60, p);
    addText(p.x, p.y - 30, 'BLADES!', '#cc66ff', 22, 1);
  }
}

// ---------------------------------------------------------------- upgrade shop
function openShop() {
  state = 'shop';
  for (const p of players) p.ready = false;
  shopMsg = null;
  sticks.left = sticks.right = null;
  bullets.length = 0; missiles.length = 0;
  layoutShop();
  Sound.jingle([392, 523, 659, 784, 659, 784], 90);
}

function layoutShop() {
  const items = shopTab === 'up'
    ? [...UPGRADES.map(u => ({ kind: 'up', u })), { kind: 'go' }]
    : [...GEAR.map(g => ({ kind: 'gear', g })), { kind: 'heal' }, { kind: 'go' }];
  const aw = sw - safe.l - safe.r, pad = 10, gap = 8;
  const tw = Math.min(200, (aw - pad * 2 - gap) / 2), tx = safe.l + aw / 2 - tw - gap / 2;
  shopTabs = [{ id: 'up', label: 'UPGRADES', sub: 'keep forever' }, { id: 'gear', label: 'GEAR', sub: '' }]
    .map((t, i) => ({ ...t, x: tx + i * (tw + gap), y: safe.t + 58, w: tw, h: 30 }));
  const top = safe.t + 96;
  let cols = 3;
  for (; cols < 6; cols++) {   // fewest columns that still leaves the cards tall enough
    const r = Math.ceil(items.length / cols);
    if ((sh - safe.b - top - pad - gap * (r - 1)) / r >= 66) break;
  }
  const rows = Math.ceil(items.length / cols);
  const cw = Math.min(220, (aw - pad * 2 - gap * (cols - 1)) / cols);
  const ch = Math.min(100, (sh - safe.b - top - pad - gap * (rows - 1)) / rows);
  const x0 = safe.l + (aw - (cw * cols + gap * (cols - 1))) / 2;
  shopCards = items.map((it, i) => ({
    ...it, flash: 0,
    x: x0 + (i % cols) * (cw + gap), y: top + Math.floor(i / cols) * (ch + gap), w: cw, h: ch,
  }));
}

function shopSay(text, color = '#ff6b6b') { shopMsg = { text, color, t: 1.6 }; }

function setShopTab(t) {
  if (t === shopTab) return;
  shopTab = t; layoutShop(); localSound(() => Sound.tone(660, 0.05, 'square', 0.03));
}

// Tapping a shop card. A friend's purchase goes to the host, which answers with the result.
function buy(c) {
  const id = c.u ? c.u.id : c.g ? c.g.id : null;
  if (net.role === 'guest') {
    if (c.kind === 'go') me.ready = true;
    netSend(['buy', c.kind, id]);
    return;
  }
  buyResult(buyFor(me, c.kind, id), c);
}

function buyResult(r, c = null) {
  if (r.go) return;
  if (!r.ok) { shopSay(r.text); localSound(() => Sound.denied()); return; }
  if (r.text) shopSay(r.text, r.color);
  if (c) c.flash = 0.35;
  else for (const k of shopCards) if (k.kind === r.kind && (k.u || k.g || {}).id === r.id) k.flash = 0.35;
  localSound(() => Sound.pickup());
  vibrate(30);
}

// The actual purchase, run by the host (or in solo) for whichever player bought it.
function buyFor(p, kind, id) {
  const no = text => ({ ok: false, text });
  if (kind === 'go') { p.ready = true; checkAllReady(); return { ok: true, go: true }; }
  if (kind === 'gear') {
    const g = GEAR.find(o => o.id === id);
    if (!g) return no('?');
    if (p.gear.includes(g.id)) return no('Already bought');
    if (g.gun && GEAR.some(o => o.gun && p.gear.includes(o.id))) return no('You can only carry one gun');
    if (p.credits < gearCost(g)) return no('Not enough ◆');
    p.credits -= gearCost(g);
    p.gear.push(g.id);
    return { ok: true, kind, id, color: '#7CFC00', text: g.once ? `${g.name} ready for next round` : `${g.name}: ${buffTime(p)}s next round` };
  }
  if (kind === 'heal') {
    if (p.hp >= p.maxHp) return no('Already at full health');
    if (p.credits < healCost()) return no('Not enough ◆');
    p.credits -= healCost();
    p.hp = p.maxHp;
    return { ok: true, kind, id };
  }
  const u = UPGRADES.find(o => o.id === id);
  if (!u) return no('?');
  if (L(p, u.id) >= u.max) return no('Already maxed out');
  if (p.credits < upgradeCost(u, p)) return no('Not enough ◆');
  p.credits -= upgradeCost(u, p);
  p.levels[u.id] = L(p, u.id) + 1;
  if (u.id === 'hp') { p.maxHp++; p.hp++; }
  return { ok: true, kind, id, color: '#7CFC00', text: `${u.name} → LEVEL ${L(p, u.id)}` };
}

// The next round starts once everyone has tapped READY.
function checkAllReady() {
  if (state === 'shop' && players.length && players.every(p => p.ready)) { state = 'play'; startRound(round + 1); }
}

function explode(x, y, radius, dmg) {
  burst(x, y, '#ffb347', 10, 200, 4);
  burst(x, y, '#fff', 4, 120, 3);
  Sound.boom(false);
  addShake(4);
  const rr = radius * radius;
  for (const e of enemies) {
    if (!e.dead && d2(e.x, e.y, x, y) < rr + e.r * e.r) damage(e, dmg, e.x - x, e.y - y, 1.2);
  }
}

function nearestPlayer(x, y) {
  let best = null, bd = Infinity;
  for (const p of players) {
    if (p.down) continue;
    const dd = d2(p.x, p.y, x, y);
    if (dd < bd) { bd = dd; best = p; }
  }
  return best;
}
const look = e => nearestPlayer(e.x, e.y) || me;   // who an enemy is staring at

function nearestEnemy(x, y) {
  let bestE = null, bd = Infinity;
  for (const e of enemies) {
    if (e.dead) continue;
    const dd = d2(e.x, e.y, x, y);
    if (dd < bd) { bd = dd; bestE = e; }
  }
  return bestE;
}

// ---------------------------------------------------------------- arena hazards
// Push a circle out of any pillar it overlaps. Returns the pillar it hit, if any.
function pushOutOfPillars(o, r) {
  let hit = null;
  for (const c of pillars) {
    const dx = o.x - c.x, dy = o.y - c.y, min = r + c.r, dd = dx * dx + dy * dy;
    if (dd >= min * min) continue;
    const d = Math.sqrt(dd), ux = d > 0.01 ? dx / d : 1, uy = d > 0.01 ? dy / d : 0;
    o.x = c.x + ux * min; o.y = c.y + uy * min;
    hit = c;
  }
  return hit;
}
const inPillar = (x, y, pad = 0) => pillars.some(c => d2(x, y, c.x, c.y) < (c.r + pad) ** 2);

function openSpot(minDist) {
  for (let tries = 0; tries < 200; tries++) {
    const x = rand(WALL + 40, W - WALL - 40), y = rand(WALL + 40, H - WALL - 40);
    if (alive().every(p => d2(x, y, p.x, p.y) > minDist * minDist) && !inPillar(x, y, 30)) return { x, y };
  }
  const p = alive()[0] || players[0];
  return { x: W - p.x, y: H - p.y };
}

function placeMines(n) {
  for (let tries = 0; mines.length < n && tries < 400; tries++) {
    const { x, y } = openSpot(150);
    if (doors.some(d => d2(x, y, d.x, d.y) < 110 * 110)) continue;
    if (mines.some(m => d2(x, y, m.x, m.y) < 70 * 70)) continue;
    mines.push({ x, y, fuse: -1, t: rand(0, 6) });
  }
}

// Mines go off when you, an enemy or one of your bullets touches them. You get a moment to run.
function updateMines(dt) {
  for (const m of mines) {
    m.t += dt;
    if (m.fuse < 0) {
      let trip = alive().some(p => d2(m.x, m.y, p.x, p.y) < (p.r + 12) ** 2);
      if (!trip) for (const e of enemies) if (!e.dead && !e.entering && d2(m.x, m.y, e.x, e.y) < (e.r + 10) ** 2) { trip = true; break; }
      if (!trip) for (const b of bullets) if (!b.dead && d2(m.x, m.y, b.x, b.y) < 16 * 16) { trip = true; b.dead = true; break; }
      if (trip) { m.fuse = 0.45; Sound.tone(880, 0.08, 'square', 0.04); }
    } else if ((m.fuse -= dt) <= 0) {
      m.dead = true;
      explode(m.x, m.y, 80, 10);
      burst(m.x, m.y, '#ff9f1a', 24, 320, 5);
      addShake(10);
      for (const p of alive()) if (d2(m.x, m.y, p.x, p.y) < 70 * 70) hurtPlayer(p);
      for (const o of mines) if (!o.dead && o.fuse < 0 && d2(m.x, m.y, o.x, o.y) < 90 * 90) o.fuse = 0.15;   // chain reaction
    }
  }
  mines = mines.filter(m => !m.dead);
  bullets = bullets.filter(b => !b.dead);
}

// Ambush spawns: a warning ring shows where an enemy is about to appear.
function updateWarps(dt) {
  for (const w of warps) {
    if ((w.t -= dt) > 0) continue;
    w.dead = true;
    const e = makeEnemy(w.type, w.x, w.y);
    pushOutOfPillars(e, e.r);
    enemies.push(e);
    burst(w.x, w.y, '#ff4466', 14, 200, 3);
    Sound.tone(300, 0.12, 'sawtooth', 0.03, 600);
  }
  warps = warps.filter(w => !w.dead);
}

// ---------------------------------------------------------------- input
const keys = {};
const sticks = { left: null, right: null };
const STICK_R = 56;
let mouse = { x: 0, y: 0, active: false };
let abilityBtns = [], pauseBtn = {}, muteBtn = {};
const btnPress = [0, 0, 0];

// All buttons live in a column on the right edge, beside the arena, so they never cover the action.
const SIDE_W = 78;
function layout() {
  const cx = sw - safe.r - SIDE_W / 2;
  const bs = Math.min(32, (sh - safe.t - safe.b - 120) / 6.6);   // shrink a little on very short screens
  abilityBtns = ABILITIES.map((a, i) => ({ x: cx, y: sh - safe.b - 10 - bs - (ABILITIES.length - 1 - i) * (bs * 2 + 10), r: bs }));
  pauseBtn = { x: cx, y: safe.t + 28, r: 20 };
  muteBtn = { x: cx, y: pauseBtn.y + 48, r: 20 };
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  sw = window.innerWidth; sh = window.innerHeight;
  canvas.width = Math.round(sw * dpr); canvas.height = Math.round(sh * dpr);
  canvas.style.width = sw + 'px'; canvas.style.height = sh + 'px';
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['l', 'r', 't', 'b']) safe[k] = parseFloat(cs.getPropertyValue('--safe-' + k)) || 0;
  // Fit the arena between the notch and the opposite edge (the floor may run under the home bar).
  const aw = sw - safe.l - safe.r - SIDE_W, ah = sh - safe.t;
  scale = Math.min(aw / W, ah / H);
  offX = safe.l + (aw - W * scale) / 2; offY = safe.t + (ah - H * scale) / 2;
  layout();
  if (state === 'shop') layoutShop();
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => { setTimeout(resize, 200); setTimeout(resize, 600); });

const hitBtn = (b, x, y, pad = 10) => d2(b.x, b.y, x, y) < (b.r + pad) * (b.r + pad);

function goFullscreen() {
  if (!isTouch) return;
  try {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) return;
    Promise.resolve(req.call(el, { navigationUI: 'hide' }))
      .then(() => screen.orientation && screen.orientation.lock ? screen.orientation.lock('landscape') : null)
      .catch(() => {});
  } catch (e) {}
}

// Returns true when the tap was consumed by UI rather than a stick.
function handleTap(x, y) {
  if (uiState !== state) render();   // screen changed since the last frame: make sure its buttons exist
  for (const b of uiButtons) if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) { b.action(); return true; }
  if (state === 'notes') { state = 'title'; return true; }
  if (state === 'title' || state === 'lobby' || state === 'join') return true;
  if (state === 'over') { if (net.role === 'solo' && overT > 1) { if (updateReady) location.reload(); else newGame(); } return true; }
  if (state === 'shop') {
    for (const t of shopTabs) if (x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h) { setShopTab(t.id); return true; }
    for (const c of shopCards) {
      if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) { buy(c); break; }
    }
    return true;
  }
  if (hitBtn(muteBtn, x, y)) { Sound.muted = !Sound.muted; store.set('arena_muted', Sound.muted); return true; }
  if (hitBtn(pauseBtn, x, y)) { togglePause(); return true; }
  if (paused) { togglePause(); return true; }
  for (let i = 0; i < abilityBtns.length; i++) {
    if (hitBtn(abilityBtns[i], x, y, 6)) { useAbility(i); return true; }
  }
  return false;
}

function setMouse(cx, cy) {
  mouse.x = (cx - offX) / scale; mouse.y = (cy - offY) / scale; mouse.active = true;
}

canvas.addEventListener('pointerdown', e => {
  e.preventDefault();
  Sound.init();
  const x = e.clientX, y = e.clientY;
  if (handleTap(x, y)) return;
  if (state !== 'play') return;
  if (e.pointerType === 'mouse') { setMouse(x, y); return; }
  const side = x < sw / 2 ? 'left' : 'right';
  if (!sticks[side]) sticks[side] = { id: e.pointerId, ox: x, oy: y, x, y, vx: 0, vy: 0 };
});

canvas.addEventListener('pointermove', e => {
  if (e.pointerType === 'mouse') { setMouse(e.clientX, e.clientY); return; }
  for (const side of ['left', 'right']) {
    const s = sticks[side];
    if (!s || s.id !== e.pointerId) continue;
    s.x = e.clientX; s.y = e.clientY;
    let dx = s.x - s.ox, dy = s.y - s.oy;
    const dd = Math.hypot(dx, dy);
    if (dd > STICK_R) {   // floating stick: drag the base along with the thumb
      s.ox = s.x - dx / dd * STICK_R; s.oy = s.y - dy / dd * STICK_R;
      dx = s.x - s.ox; dy = s.y - s.oy;
    }
    s.vx = dx / STICK_R; s.vy = dy / STICK_R;
  }
});

function releasePointer(e) {
  for (const side of ['left', 'right']) {
    if (sticks[side] && sticks[side].id === e.pointerId) sticks[side] = null;
  }
}
canvas.addEventListener('pointerup', releasePointer);
canvas.addEventListener('pointercancel', releasePointer);
canvas.addEventListener('contextmenu', e => e.preventDefault());

window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  keys[k] = true;
  Sound.init();
  if (k.startsWith('arrow')) mouse.active = false;
  if (state === 'notes' && (k === 'enter' || k === ' ')) { state = 'title'; return; }
  if (state === 'title' && (k === 'enter' || k === ' ')) { newGame(); return; }
  if (state === 'lobby' && k === 'enter' && net.role === 'host') { newGame(); return; }
  if (state === 'over' && (k === 'enter' || k === ' ') && overT > 1) {
    if (net.role !== 'solo') playAgain();
    else if (updateReady) location.reload(); else newGame();
    return;
  }
  if (state === 'shop' && k === 'enter') { buy(shopCards[shopCards.length - 1]); return; }
  if (state === 'shop' && (k === 'tab' || k === 'arrowleft' || k === 'arrowright')) { e.preventDefault(); setShopTab(shopTab === 'up' ? 'gear' : 'up'); return; }
  if (state !== 'play') return;
  if (k === 'p' || k === 'escape') { togglePause(); return; }
  if (k === 'm') { Sound.muted = !Sound.muted; store.set('arena_muted', Sound.muted); return; }
  if (e.repeat) return;
  ABILITIES.forEach((a, i) => { if (a.keys.includes(k)) useAbility(i); });
  if (k === ' ' || k.startsWith('arrow')) e.preventDefault();
});
window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'play' && net.role !== 'guest') {
    paused = true; sticks.left = sticks.right = null;
    if (net.role === 'host') hostBroadcast();   // tell friends before this phone goes to sleep
  }
});

// ---------------------------------------------------------------- update
function update(dt) {
  time += dt;
  updateRound(dt);
  moveLocal(me, dt);
  for (const p of players) { updateBuffs(p, dt); updateGun(p, dt); }
  updateEnemies(dt);
  updateShots(dt);
  updateMines(dt);
  updateWarps(dt);
  updateBossHazards(dt);
  updateAbilities(dt);
  for (const c of pillars) c.rise = Math.min(1, c.rise + dt * 3);
  updatePickups(dt);
  updateFx(dt);
  enemies = enemies.filter(e => !e.dead);
  if (comboT > 0) { comboT -= dt; if (comboT <= 0) combo = 0; }
}

function updateRound(dt) {
  for (const d of doors) d.flash = Math.max(0, d.flash - dt);
  if (roundPhase === 'intro') {
    phaseT -= dt;
    if (phaseT <= 0) { roundPhase = 'fight'; activateGear(); }
  } else if (roundPhase === 'fight') {
    spawnT -= dt;
    const cap = (30 + round * 3) * crowd;
    if (spawnQueue.length && spawnT <= 0 && enemies.length < cap) {
      const group = spawnQueue[0] === 'boss' ? 1 : Math.min(spawnQueue.length, randi(2, 3 + Math.floor(round / 3)));
      if (twist === 'ambush' && Math.random() < 0.65) {
        const at = openSpot(170);
        for (let i = 0; i < group; i++) {
          warps.push({ type: spawnQueue.shift(), x: clamp(at.x + rand(-35, 35), WALL + 30, W - WALL - 30),
                       y: clamp(at.y + rand(-35, 35), WALL + 30, H - WALL - 30), t: 1.1 });
        }
      } else {
        const door = spawnQueue[0] === 'boss' ? doors[0] : pick(doors);
        for (let i = 0; i < group; i++) spawnFromDoor(spawnQueue.shift(), door, i);
        door.flash = 0.8;
      }
      spawnT = Math.max(0.55, 2.0 - round * 0.08) / Math.sqrt(crowd);
    }
    if (!spawnQueue.length && !warps.length && enemies.length === 0) {
      roundPhase = 'clear'; phaseT = 3.2;
      for (const m of mines) burst(m.x, m.y, '#888', 6, 80, 3);   // leftover mines fizzle out
      mines = []; strikes = []; puddles = [];
      const bonus = round * 1000;
      const crBase = 8 + round * 2;
      score += bonus;
      for (const p of players) {
        p.credits += crBase + (p.flawless && !p.down ? 10 : 0);
        if (players.length > 1 && p.flawless && !p.down) addText(p.x, p.y - 34, 'FLAWLESS +10 ◆', '#4dfff0', 14, 1.6);
      }
      ebullets.length = 0;
      const shopNext = round % SHOP_EVERY === 0;
      const fl = players.length === 1 && me.flawless;
      showBanner(`ROUND ${round} CLEAR!`,
        `+${crBase + (fl ? 10 : 0)} ◆${players.length > 1 ? ' each' : ''}${fl ? '  FLAWLESS!' : ''}${shopNext ? '  ·  UPGRADE SHOP OPEN' : ''}`);
      Sound.jingle([523, 659, 784, 1046]);
    }
  } else if (roundPhase === 'clear') {
    phaseT -= dt;
    if (phaseT <= 0) {
      if (round % SHOP_EVERY === 0) openShop();
      else startRound(round + 1);
    }
  }
}

// Your own movement and aim run on your phone, even as a guest, so the controls feel instant.
function moveLocal(p, dt) {
  if (!p) return;
  let mx = 0, my = 0;
  if (keys['w']) my -= 1;
  if (keys['s']) my += 1;
  if (keys['a']) mx -= 1;
  if (keys['d']) mx += 1;
  if (sticks.left) { mx = sticks.left.vx; my = sticks.left.vy; }
  // One speed: any push past the small dead zone moves you full speed; only the direction counts.
  const ml = Math.hypot(mx, my);
  p.moving = ml > 0.12;
  if (p.moving) { mx /= ml; my /= ml; }
  if (p.moving) {
    const spd = 235 * (1 + 0.1 * L(p, 'speed'));
    p.x += mx * spd * dt; p.y += my * spd * dt;
    p.walk += dt * 13;
  }
  pushOutOfPillars(p, p.r);
  p.x = clamp(p.x, WALL + p.r, W - WALL - p.r);
  p.y = clamp(p.y, WALL + p.r, H - WALL - p.r);

  // aiming (keeps the last direction when you let go)
  let ax = 0, ay = 0;
  if (keys['arrowleft']) ax -= 1;
  if (keys['arrowright']) ax += 1;
  if (keys['arrowup']) ay -= 1;
  if (keys['arrowdown']) ay += 1;
  if (sticks.right && Math.hypot(sticks.right.vx, sticks.right.vy) > 0.2) { ax = sticks.right.vx; ay = sticks.right.vy; }
  else if (!ax && !ay && mouse.active) { ax = mouse.x - p.x; ay = mouse.y - p.y; }
  const al = Math.hypot(ax, ay);
  if (al > 0.001) { p.ax = ax / al; p.ay = ay / al; }
}

// Gun, timers and drone. The host runs this for every player.
function updateGun(p, dt) {
  if (p.inv > 0) p.inv -= dt;
  if (p.muzzle > 0) p.muzzle -= dt;
  if (p.down) return;
  if (p.weaponT > 0) { p.weaponT -= dt; if (p.weaponT <= 0) p.weapon = 'basic'; }
  const w = WEAPONS[twist === 'overdrive' && p.weapon === 'basic' ? 'rapid' : p.weapon];
  const count = w.count + L(p, 'multi'), arc = w.arc + L(p, 'multi') * 0.14;
  const dmg = w.dmg * dmgMult(p), spd = w.speed || 640;
  p.fireT -= dt;
  while (p.fireT <= 0) {
    const base = Math.atan2(p.ay, p.ax);
    for (let k = 0; k < count; k++) {
      const a = base + (count > 1 ? (k / (count - 1) - 0.5) * arc : 0) + rand(-w.jitter, w.jitter);
      fireBullet({
        x: p.x + Math.cos(base) * 14, y: p.y - 2 + Math.sin(base) * 14,   // close in, so huggers still get hit
        vx: Math.cos(a) * spd, vy: Math.sin(a) * spd, r: 7, dmg: rollCrit(dmg, p), life: 1.2,
        pierce: L(p, 'pierce') + (w.pierce || 0), hits: null, color: w.speed ? w.color : null,
      });
    }
    p.fireT += w.rate / (1 + 0.15 * L(p, 'rate'));
    p.muzzle = 0.05;
    Sound.shot();
  }

  // buddy drone: circles you and plinks the nearest enemy
  const dr = p.drone;
  dr.a += dt * 2.2;
  if (p.buffs.drone > 0) {
    dronePos(p);
    dr.t -= dt;
    const t = nearestEnemy(dr.x, dr.y);
    if (t && dr.t <= 0 && d2(t.x, t.y, dr.x, dr.y) < 460 * 460) {
      dr.t = 0.3 / (1 + 0.15 * L(p, 'rate'));
      const a = Math.atan2(t.y - dr.y, t.x - dr.x);
      fireBullet({ x: dr.x, y: dr.y, vx: Math.cos(a) * 700, vy: Math.sin(a) * 700, r: 6,
        dmg: rollCrit(dmgMult(p), p), life: 1, pierce: 0, hits: null, color: '#7CFC00' });
    }
  }
}
function dronePos(p) { p.drone.x = p.x + Math.cos(p.drone.a) * 42; p.drone.y = p.y + Math.sin(p.drone.a) * 30 - 10; }

// Friends' phones get a copy of every shot and animate it themselves.
function fireBullet(b) {
  bullets.push(b);
  if (netOut) netOut.push(['B', Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy), b.pierce, b.color, b.life, b.r]);
}

const dmgMult = p => (1 + 0.25 * L(p, 'damage')) * (1 + 0.1 * L(p, 'over'));
const rollCrit = (d, p) => Math.random() < 0.08 * L(p, 'crit') ? d * 3 : d;

function updateEnemies(dt) {
  for (const e of enemies) {
    if (e.dead) continue;
    const p = nearestPlayer(e.x, e.y) || players[0];   // everyone goes after whoever is closest
    e.tgt = p;
    e.t += dt;
    if (e.hitT > 0) e.hitT -= dt;
    if (e.bladeCD > 0) e.bladeCD -= dt;

    if (e.entering) {
      const s = Math.max(e.speed, 90);
      e.x += e.dnx * s * dt; e.y += e.dny * s * dt;
      // failsafe: never let anyone wander off outside the arena while walking in
      if ((e.enterT += dt) > 4) { e.x = clamp(e.x, WALL + e.r + 1, W - WALL - e.r - 1); e.y = clamp(e.y, WALL + e.r + 1, H - WALL - e.r - 1); }
      if (e.x > WALL + e.r && e.x < W - WALL - e.r && e.y > WALL + e.r && e.y < H - WALL - e.r) e.entering = false;
      continue;
    }

    let dx = p.x - e.x, dy = p.y - e.y;
    const dist = Math.hypot(dx, dy) || 1;
    dx /= dist; dy /= dist;
    let mx = dx, my = dy;

    switch (e.type) {
      case 'grunt': case 'splitter': case 'tank': {
        const w = Math.sin(e.t * 3 + e.wob) * 0.4;
        mx = dx - dy * w; my = dy + dx * w;
        break;
      }
      case 'shooter': {
        const strafe = Math.sin(e.t * 0.7 + e.wob) > 0 ? 1 : -1;
        const fwd = dist > 290 ? 1 : dist < 190 ? -1 : 0;
        mx = dx * fwd - dy * strafe * 0.8; my = dy * fwd + dx * strafe * 0.8;
        e.fireT -= dt;
        if (e.fireT <= 0 && dist < 520) {
          e.fireT = rand(1.7, 2.7) / Math.min(1.8, 1 + round * 0.03);
          fireEnemyBullet(e.x, e.y, dx, dy, 230);
          Sound.tone(520, 0.08, 'triangle', 0.025, 260);
        }
        break;
      }
      case 'boss': { const steer = bossAI(e, dx, dy, dt); if (steer) { mx = steer[0]; my = steer[1]; } break; }
    }

    const l = Math.hypot(mx, my) || 1;
    e.face = Math.atan2(my, mx);
    e.x += (mx / l * e.speed + e.kx) * dt;
    e.y += (my / l * e.speed + e.ky) * dt;
    const decay = Math.min(1, dt * 6);
    e.kx -= e.kx * decay; e.ky -= e.ky * decay;
    e.x = clamp(e.x, WALL + e.r, W - WALL - e.r);
    e.y = clamp(e.y, WALL + e.r, H - WALL - e.r);
    const c = pushOutOfPillars(e, e.r);
    if (c) {   // slide around the pillar, toward whichever side the player is on
      const ux = (e.x - c.x) / (e.r + c.r), uy = (e.y - c.y) / (e.r + c.r);
      const side = (-uy * (p.x - e.x) + ux * (p.y - e.y)) >= 0 ? 1 : -1;
      e.x += -uy * side * e.speed * dt; e.y += ux * side * e.speed * dt;
    }

    for (const q of players) {   // touch range uses the un-enlarged size, to stay forgiving
      if (!q.down && d2(e.x, e.y, q.x, q.y) < (e.r / SPR + q.r - 3) ** 2) hurtPlayer(q);
    }
  }

  // keep enemies from stacking on top of each other
  const n = enemies.length;
  for (let i = 0; i < n; i++) {
    const a = enemies[i];
    if (a.entering || a.dead) continue;
    for (let j = i + 1; j < n; j++) {
      const b = enemies[j];
      if (b.entering || b.dead) continue;
      const dx = b.x - a.x, dy = b.y - a.y, min = a.r + b.r;
      const dd = dx * dx + dy * dy;
      if (dd >= min * min || dd === 0) continue;
      const dist = Math.sqrt(dd), push = (min - dist);
      const wa = b.r / (a.r + b.r), wb = a.r / (a.r + b.r);
      const ux = dx / dist, uy = dy / dist;
      if (a.type !== 'boss') { a.x -= ux * push * wa; a.y -= uy * push * wa; }
      if (b.type !== 'boss') { b.x += ux * push * wb; b.y += uy * push * wb; }
    }
  }
}

function bossAI(e, dx, dy, dt) {
  switch (e.kind) {
    case 'queen': return queenAI(e, dx, dy, dt);
    case 'sentinel': return sentinelAI(e, dx, dy, dt);
    case 'titan': return titanAI(e, dx, dy, dt);
  }
  return overlordAI(e, dx, dy, dt);
}

function spawnMinions(e, type, n) {
  for (let k = 0; k < n; k++) {
    const a = rand(0, Math.PI * 2);
    const m = makeEnemy(type, e.x + Math.cos(a) * 70, e.y + Math.sin(a) * 70);
    m.cr = 0;   // no farming credits off a boss's endless minions
    enemies.push(m);
  }
}

// A marked spot on the floor that blows up after a moment (acid lobs, meteors).
function addStrike(x, y, r, t, color, puddle = false) {
  strikes.push({ x: clamp(x, WALL + 20, W - WALL - 20), y: clamp(y, WALL + 20, H - WALL - 20), r, t, max: t, color, puddle });
}

// Sludge Queen: lobs acid that leaves burning puddles, sprays acid, and births slimes.
function queenAI(e, dx, dy, dt) {
  const enraged = e.hp < e.maxHp * 0.5;
  e.speed = enraged ? 58 : 38;
  e.burstT -= dt; e.spawnT -= dt; e.fireT -= dt;
  if (e.burstT <= 0) {
    const n = enraged ? 4 : 3;
    for (let k = 0; k < n; k++) addStrike(e.tgt.x + (k ? rand(-110, 110) : 0), e.tgt.y + (k ? rand(-90, 90) : 0), 46, 1.1, '#7cfc00', true);
    e.burstT = enraged ? 1.8 : 2.6;
    Sound.tone(180, 0.3, 'sine', 0.05, 90);
  }
  if (e.fireT <= 0) {
    const base = Math.atan2(dy, dx), n = enraged ? 9 : 7;
    for (let k = 0; k < n; k++) {
      const a = base + (k / (n - 1) - 0.5) * 1.1;
      fireEnemyBullet(e.x, e.y, Math.cos(a), Math.sin(a), 150, '#9dff3d');
    }
    e.fireT = enraged ? 2.2 : 3;
  }
  if (e.spawnT <= 0) { spawnMinions(e, 'splitter', 1); e.spawnT = enraged ? 6 : 8; }
  return null;
}

// Cryo Sentinel: spins out ice shards, then locks on and charges. Dazed (double damage) after it crashes.
function sentinelAI(e, dx, dy, dt) {
  const enraged = e.hp < e.maxHp * 0.5;
  const moved = (e.x - e.px) * e.cdx + (e.y - e.py) * e.cdy;   // progress along the charge line
  e.px = e.x; e.py = e.y;
  e.modeT -= dt;
  if (e.mode === 'walk') {
    e.speed = enraged ? 70 : 52;
    e.fireT -= dt;
    if (e.fireT <= 0) {
      const arms = enraged ? 3 : 2;
      e.spin += 0.45;
      for (let k = 0; k < arms; k++) {
        const a = e.spin + k * Math.PI * 2 / arms;
        fireEnemyBullet(e.x, e.y, Math.cos(a), Math.sin(a), 170, '#bff4ff');
      }
      e.fireT = 0.26;
    }
    if (e.modeT <= 0) { e.mode = 'aim'; e.modeT = 0.95; Sound.tone(300, 0.9, 'sawtooth', 0.04, 900); }
    return null;
  }
  if (e.mode === 'aim') {
    e.speed = 0;
    if (e.modeT > 0.35) { e.cdx = dx; e.cdy = dy; }   // tracks you, then locks in for the last moment
    if (e.modeT <= 0) { e.mode = 'charge'; e.modeT = 1.6; }
    return null;
  }
  if (e.mode === 'charge') {
    e.speed = enraged ? 620 : 540;
    if (Math.random() < 0.8) burst(e.x, e.y, '#d8f7ff', 2, 60, 4);
    // stopped short (hit a wall or pillar), or ran out of steam
    if ((e.modeT < 1.5 && moved < e.speed * dt * 0.6) || e.modeT <= 0) {
      e.mode = 'stun'; e.modeT = enraged ? 1.0 : 1.4;
      addShake(16); Sound.boom(true); buzz(80);
      const n = enraged ? 18 : 12, off = rand(0, 1);
      for (let k = 0; k < n; k++) {
        const a = off + k / n * Math.PI * 2;
        fireEnemyBullet(e.x, e.y, Math.cos(a), Math.sin(a), 190, '#bff4ff');
      }
      burst(e.x, e.y, '#d8f7ff', 30, 300, 5);
      addText(e.x, e.y - 70, 'DAZED!', '#5fe1ff', 18, 1);
    }
    return [e.cdx, e.cdy];
  }
  // stunned
  e.speed = 0;
  if (e.modeT <= 0) { e.mode = 'walk'; e.modeT = enraged ? 2 : 3; e.fireT = 0.5; }
  return null;
}

// Magma Titan: meteors on marked spots, expanding fire rings with a gap, and fast imps.
function titanAI(e, dx, dy, dt) {
  const enraged = e.hp < e.maxHp * 0.5;
  e.speed = enraged ? 66 : 46;
  e.burstT -= dt; e.spawnT -= dt; e.fireT -= dt;
  if (e.burstT <= 0) {
    for (const p of alive()) addStrike(p.x, p.y, 58, 1.3, '#ff6a1a');
    for (let k = 0; k < (enraged ? 6 : 4); k++) { const o = openSpot(0); addStrike(o.x, o.y, 58, 1.3, '#ff6a1a'); }
    e.burstT = enraged ? 2.2 : 3.2;
    Sound.tone(90, 0.5, 'sawtooth', 0.05, 40);
  }
  if (e.fireT <= 0) {
    fireRing(e);
    if (enraged) e.ring2T = 0.45;   // a second ring right behind the first
    e.fireT = enraged ? 2.6 : 3.6;
  }
  if (e.ring2T > 0 && (e.ring2T -= dt) <= 0) fireRing(e);
  if (e.spawnT <= 0) { spawnMinions(e, 'runner', enraged ? 3 : 2); e.spawnT = enraged ? 4 : 5.5; }
  return null;
}

function fireRing(e) {
  const n = 30, gap = randi(0, n - 1);
  for (let k = 0; k < n; k++) {
    if (Math.abs(((k - gap + n + n / 2) % n) - n / 2) <= 2) continue;   // five-shot gap to slip through
    const a = k / n * Math.PI * 2;
    fireEnemyBullet(e.x, e.y, Math.cos(a), Math.sin(a), 150, '#ffb347');
  }
  Sound.tone(140, 0.25, 'square', 0.04, 70);
}

// The Overlord: twin cannons, bullet rings, and minions.
function overlordAI(e, dx, dy, dt) {
  const enraged = e.hp < e.maxHp * 0.5;
  e.speed = enraged ? 72 : 45;
  e.burstT -= dt; e.spawnT -= dt; e.fireT -= dt;
  if (e.burstT <= 0) {
    const n = enraged ? 22 : 14, off = rand(0, Math.PI * 2);
    for (let k = 0; k < n; k++) {
      const a = off + k / n * Math.PI * 2;
      fireEnemyBullet(e.x, e.y, Math.cos(a), Math.sin(a), enraged ? 200 : 170);
    }
    e.burstT = enraged ? 1.7 : 2.7;
    Sound.tone(110, 0.35, 'sawtooth', 0.06, 50);
  }
  if (e.fireT <= 0) {
    const base = Math.atan2(dy, dx);
    for (let k = -1; k <= 1; k++) fireEnemyBullet(e.x, e.y, Math.cos(base + k * 0.2), Math.sin(base + k * 0.2), 260);
    e.fireT = enraged ? 0.9 : 1.5;
  }
  if (e.spawnT <= 0) { spawnMinions(e, enraged ? 'runner' : 'grunt', 3); e.spawnT = enraged ? 3.5 : 5; }
  return null;
}

// Strikes go off when their timer runs out; acid ones leave a puddle that burns while you stand in it.
function updateBossHazards(dt) {
  for (const st of strikes) {
    if ((st.t -= dt) > 0) continue;
    st.dead = true;
    burst(st.x, st.y, st.color, 18, 260, 5);
    burst(st.x, st.y, '#fff', 6, 160, 3);
    Sound.boom(false); addShake(6);
    for (const p of alive()) if (d2(st.x, st.y, p.x, p.y) < (st.r + p.r * 0.5) ** 2) hurtPlayer(p);
    if (st.puddle) puddles.push({ x: st.x, y: st.y, r: st.r * 0.8, life: 4, max: 4 });
  }
  strikes = strikes.filter(st => !st.dead);
  for (const pd of puddles) {
    pd.life -= dt;
    if (pd.life > 0.5) for (const p of alive()) if (d2(pd.x, pd.y, p.x, p.y) < (pd.r * 0.8) ** 2) hurtPlayer(p);
  }
  puddles = puddles.filter(pd => pd.life > 0);
}

function inArena(x, y, pad = 0) {
  return x > WALL - pad && x < W - WALL + pad && y > WALL - pad && y < H - WALL + pad;
}

function updateShots(dt) {
  for (const b of bullets) {
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    if (b.life <= 0 || !inArena(b.x, b.y) || inPillar(b.x, b.y)) {
      b.dead = true;
      if (Math.random() < 0.3) burst(b.x, b.y, '#ffe066', 2, 80, 2);
      continue;
    }
    for (const e of enemies) {
      if (e.dead) continue;
      const rr = e.r + b.r;
      if (d2(e.x, e.y, b.x, b.y) < rr * rr) {
        if (b.hits && b.hits.includes(e)) continue;
        damage(e, b.dmg, b.vx, b.vy);
        burst(b.x, b.y, e.hp > 0 ? '#fff' : e.color, 3, 120, 2);
        if (e.hp > 0) Sound.hit();
        if (b.pierce > 0) { b.pierce--; (b.hits || (b.hits = [])).push(e); continue; }
        b.dead = true;
        break;
      }
    }
  }
  bullets = bullets.filter(b => !b.dead);

  for (const b of ebullets) {
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    if (b.life <= 0 || !inArena(b.x, b.y, -4) || inPillar(b.x, b.y)) { b.dead = true; continue; }
    for (const p of players) {
      if (p.down || p.inv > 0) continue;
      const rr = b.r + p.r - 4;
      if (d2(p.x, p.y, b.x, b.y) < rr * rr) { b.dead = true; hurtPlayer(p); break; }
    }
  }
  ebullets = ebullets.filter(b => !b.dead);
}

function updateAbilities(dt) {
  // blast shockwave
  for (const fx of effects) {
    fx.r += 1050 * dt;
    for (const e of enemies) {
      if (e.dead || fx.hit.has(e)) continue;
      if (d2(e.x, e.y, fx.x, fx.y) <= (fx.r + e.r) ** 2) {
        fx.hit.add(e);
        damage(e, e.type === 'boss' ? 45 : 30, e.x - fx.x, e.y - fx.y, 4);
      }
    }
    for (const b of ebullets) if (d2(b.x, b.y, fx.x, fx.y) < fx.r * fx.r) b.dead = true;
    if (fx.r >= fx.max) fx.dead = true;
  }
  effects = effects.filter(f => !f.dead);

  // homing missiles
  for (const m of missiles) {
    m.life -= dt;
    if (!m.target || m.target.dead) m.target = nearestEnemy(m.x, m.y);
    if (m.target) {
      const want = Math.atan2(m.target.y - m.y, m.target.x - m.x);
      let diff = want - m.a;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      m.a += clamp(diff, -7 * dt, 7 * dt);
    }
    m.speed = Math.min(620, m.speed + 700 * dt);
    m.x += Math.cos(m.a) * m.speed * dt; m.y += Math.sin(m.a) * m.speed * dt;
    particles.push({ x: m.x, y: m.y, vx: rand(-20, 20), vy: rand(-20, 20), life: 0.3, max: 0.3, color: '#9be7ff', size: 3 });
    let hit = m.life <= 0 || !inArena(m.x, m.y) || inPillar(m.x, m.y);
    if (!hit) for (const e of enemies) {
      if (!e.dead && d2(e.x, e.y, m.x, m.y) < (e.r + 6) ** 2) { hit = true; break; }
    }
    if (hit) { m.dead = true; explode(m.x, m.y, 55, 7); }
  }
  missiles = missiles.filter(m => !m.dead);

  // spinning blades
  for (const p of players) {
    if (!(p.blades > 0)) continue;
    p.blades -= dt;
    p.bladeA += dt * 7;
    const nb = 4 + L(p, 'blades');
    for (let k = 0; k < nb; k++) {
      const a = p.bladeA + k * Math.PI * 2 / nb;
      const bx = p.x + Math.cos(a) * 64, by = p.y + Math.sin(a) * 64;
      for (const e of enemies) {
        if (e.dead || e.bladeCD > 0) continue;
        if (d2(e.x, e.y, bx, by) < (e.r + 15) ** 2) {
          damage(e, 3, e.x - p.x, e.y - p.y, 1.6);
          e.bladeCD = 0.15;
          burst(bx, by, '#e8c8ff', 4, 150, 3);
          Sound.hit();
        }
      }
      for (const b of ebullets) if (d2(b.x, b.y, bx, by) < 18 * 18) b.dead = true;
    }
  }
  for (let i = 0; i < btnPress.length; i++) if (btnPress[i] > 0) btnPress[i] -= dt;
}

function updatePickups(dt) {
  for (const pk of pickups) {
    pk.life -= dt; pk.t += dt;
    const p = nearestPlayer(pk.x, pk.y);
    if (!p) continue;
    const magnetR = 110 * L(p, 'magnet');
    const dx = p.x - pk.x, dy = p.y - pk.y, dd = Math.hypot(dx, dy) || 1;
    if (roundPhase === 'clear') {   // vacuum up leftovers between rounds
      pk.x += dx / dd * 500 * dt; pk.y += dy / dd * 500 * dt;
      pk.life = Math.max(pk.life, 1);
    } else if (dd < magnetR) {
      pk.x += dx / dd * 380 * dt; pk.y += dy / dd * 380 * dt;
    }
    if (d2(p.x, p.y, pk.x, pk.y) < (p.r + 16) ** 2) { collect(pk, p); pk.dead = true; }
    else if (pk.life <= 0) pk.dead = true;
  }
  pickups = pickups.filter(pk => !pk.dead);
}

function updateFx(dt) {
  for (const pt of particles) {
    pt.x += pt.vx * dt; pt.y += pt.vy * dt;
    pt.vx *= 1 - Math.min(1, dt * 3); pt.vy *= 1 - Math.min(1, dt * 3);
    pt.life -= dt;
  }
  particles = particles.filter(pt => pt.life > 0);
  for (const t of texts) { t.y -= 30 * dt; t.life -= dt; }
  texts = texts.filter(t => t.life > 0);
  if (banner) { banner.t -= dt; if (banner.t <= 0) banner = null; }
  shake = Math.max(0, shake - 60 * dt);
  flash = Math.max(0, flash - dt * 1.6);
}

// ---------------------------------------------------------------- render
const floor = document.createElement('canvas');
function buildFloor(th) {
  const S = 2;
  floor.width = W * S; floor.height = H * S;
  const f = floor.getContext('2d');
  f.scale(S, S);
  f.fillStyle = th.base; f.fillRect(0, 0, W, H);
  const T = 40;
  for (let y = WALL; y < H - WALL; y += T) {
    for (let x = WALL; x < W - WALL; x += T) {
      f.fillStyle = th.tiles[((x - WALL) / T + (y - WALL) / T) % 2 < 1 ? 0 : 1];
      f.fillRect(x, y, T, T);
    }
  }
  // center stage logo
  f.globalAlpha = 0.18; f.strokeStyle = th.neon; f.lineWidth = 6;
  f.beginPath(); f.arc(W / 2, H / 2, 120, 0, Math.PI * 2); f.stroke();
  f.globalAlpha = 0.12; f.strokeStyle = th.ring; f.lineWidth = 3;
  f.beginPath(); f.arc(W / 2, H / 2, 150, 0, Math.PI * 2); f.stroke();
  f.globalAlpha = 1;
  f.fillStyle = 'rgba(255,255,255,0.06)';
  f.font = 'bold 54px system-ui, sans-serif'; f.textAlign = 'center'; f.textBaseline = 'middle';
  f.fillText('ARENA', W / 2, H / 2 - 18);
  f.fillText('BLITZ', W / 2, H / 2 + 34);
  // walls
  f.fillStyle = th.wall;
  f.fillRect(0, 0, W, WALL); f.fillRect(0, H - WALL, W, WALL);
  f.fillRect(0, 0, WALL, H); f.fillRect(W - WALL, 0, WALL, H);
  f.strokeStyle = th.neon; f.lineWidth = 3;
  f.strokeRect(WALL - 1.5, WALL - 1.5, W - WALL * 2 + 3, H - WALL * 2 + 3);
  // doorways
  f.fillStyle = '#07060d';
  f.fillRect(W / 2 - DOOR_W / 2, 0, DOOR_W, WALL);
  f.fillRect(W / 2 - DOOR_W / 2, H - WALL, DOOR_W, WALL);
  f.fillRect(0, H / 2 - DOOR_W / 2, WALL, DOOR_W);
  f.fillRect(W - WALL, H / 2 - DOOR_W / 2, WALL, DOOR_W);
}
buildFloor(THEMES[0]);

// marquee bulbs around the arena, like a TV game show set
const bulbs = [];
for (let x = 40; x < W - 20; x += 40) {
  if (Math.abs(x - W / 2) > DOOR_W / 2 + 6) { bulbs.push([x, WALL / 2]); bulbs.push([x, H - WALL / 2]); }
}
for (let y = 40; y < H - 20; y += 40) {
  if (Math.abs(y - H / 2) > DOOR_W / 2 + 6) { bulbs.push([WALL / 2, y]); bulbs.push([W - WALL / 2, y]); }
}

function drawArena() {
  const th = THEMES[themeIdx % THEMES.length];
  ctx.drawImage(floor, 0, 0, W, H);
  const step = Math.floor(time * 8);
  for (let i = 0; i < bulbs.length; i++) {
    const on = (i + step) % 4 === 0;
    ctx.fillStyle = on ? th.bulb : th.bulbOff;
    ctx.beginPath(); ctx.arc(bulbs[i][0], bulbs[i][1], on ? 4 : 3, 0, Math.PI * 2); ctx.fill();
  }
  for (const d of doors) {
    if (d.flash <= 0) continue;
    const a = 0.5 + 0.5 * Math.sin(time * 40);
    ctx.fillStyle = `rgba(255,60,60,${0.35 + a * 0.5})`;
    if (d.nx === 0) ctx.fillRect(W / 2 - DOOR_W / 2, d.y - WALL / 2, DOOR_W, WALL);
    else ctx.fillRect(d.x - WALL / 2, H / 2 - DOOR_W / 2, WALL, DOOR_W);
  }
}

function circle(x, y, r, fill) { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }

// ---- sprite helpers. Gradients are built around (0,0) once and reused; we translate to each entity.
const gcache = {};
function rgrad(key, x, y, r, stops) {
  let g = gcache[key];
  if (!g) {
    g = ctx.createRadialGradient(x, y, 0, x, y, r);
    for (const [o, c] of stops) g.addColorStop(o, c);
    gcache[key] = g;
  }
  return g;
}
function lgrad(key, x0, y0, x1, y1, stops) {
  let g = gcache[key];
  if (!g) {
    g = ctx.createLinearGradient(x0, y0, x1, y1);
    for (const [o, c] of stops) g.addColorStop(o, c);
    gcache[key] = g;
  }
  return g;
}
function rrect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function oval(x, y, rx, ry, rot, fill) {
  ctx.fillStyle = fill;
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); ctx.fill();
}
function outline(color, w) { ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke(); }
function shadow(x, y, rx, ry) { oval(x, y, rx, ry, 0, 'rgba(0,0,0,0.32)'); }
const WH = '#ffffff';

// Masked brute with a spiked club — the basic grunt.
function drawBrute(e, fl) {
  const face = look(e).x < e.x ? -1 : 1;
  const step = e.entering ? 0 : Math.sin(e.t * 11);
  shadow(e.x, e.y + 13, 12, 4.5);
  ctx.save(); ctx.translate(e.x, e.y); ctx.scale(face, 1);
  // legs + boots
  ctx.fillStyle = fl ? WH : '#4a1a10';
  rrect(-8, 2, 6, 9 + step * 2.5, 2); ctx.fill();
  rrect(2, 2, 6, 9 - step * 2.5, 2); ctx.fill();
  ctx.fillStyle = fl ? WH : '#1c1410';
  rrect(-9, 9 + step * 2.5, 8, 4, 2); ctx.fill();
  rrect(1, 9 - step * 2.5, 8, 4, 2); ctx.fill();
  // club arm, swinging overhead
  ctx.save(); ctx.translate(6, -5); ctx.rotate(Math.sin(e.t * 7 + e.wob) * 0.7 - 0.3);
  ctx.fillStyle = fl ? WH : '#6b4422'; rrect(-1.5, -20, 4, 20, 2); ctx.fill();
  ctx.fillStyle = fl ? WH : '#8b5a2b'; rrect(-4.5, -29, 10, 12, 5); ctx.fill();
  outline(fl ? WH : '#3d2410', 1.2);
  if (!fl) for (const [sx, sy] of [[-5, -25], [6, -25], [0.5, -30], [-5, -20], [6, -20]]) circle(sx, sy, 1.5, '#d8d8d8');
  circle(0, 0, 3.5, fl ? WH : '#e0603f');
  ctx.restore();
  // torso
  ctx.fillStyle = fl ? WH : lgrad('bruteBody', 0, -11, 0, 6, [[0, '#ff8a5c'], [1, '#a8301a']]);
  rrect(-11, -10, 20, 16, 7); ctx.fill();
  outline(fl ? WH : '#4a140a', 1.5);
  if (!fl) {
    ctx.fillStyle = '#3a2418'; ctx.fillRect(-11, 1, 20, 3);
    ctx.fillStyle = '#c9a227'; ctx.fillRect(-3, 1, 4, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.2)'; rrect(-8, -8, 7, 5, 2.5); ctx.fill();
  }
  circle(-10, -1, 4, fl ? WH : '#e0603f');
  // head: hockey mask
  oval(1, -13, 6.5, 7.5, 0, fl ? WH : lgrad('bruteMask', 0, -20, 0, -6, [[0, '#ffffff'], [1, '#b9b2a0']]));
  outline(fl ? WH : '#5b5546', 1.2);
  if (!fl) {
    oval(-1, -14, 1.9, 1.3, 0.3, '#1a0a0a'); oval(4, -14, 1.9, 1.3, -0.3, '#1a0a0a');
    circle(-1, -14, 0.8, '#ff3030'); circle(4, -14, 0.8, '#ff3030');
    for (const [hx, hy] of [[0, -9.5], [2.5, -9.5], [1.2, -8], [-2.5, -11], [5, -11]]) circle(hx, hy, 0.6, '#7a7466');
    ctx.fillStyle = '#d32f2f'; ctx.fillRect(0.5, -20.5, 1.5, 5);
  }
  ctx.restore();
}

// Fast six-legged skitter bug — the runner.
function drawSkitter(e, fl) {
  shadow(e.x, e.y + 7, 11, 4);
  ctx.save(); ctx.translate(e.x, e.y); ctx.rotate(e.face);
  ctx.strokeStyle = fl ? WH : '#4a3200'; ctx.lineWidth = 1.8; ctx.lineCap = 'round';
  for (let i = -1; i <= 1; i++) for (const s of [-1, 1]) {
    const sw_ = Math.sin(e.t * 28 + i * 2.1 + (s > 0 ? Math.PI : 0)) * 3;
    ctx.beginPath();
    ctx.moveTo(i * 3.5, 0);
    ctx.lineTo(i * 3.5 + sw_ + 1, s * 7);
    ctx.lineTo(i * 4.5 + sw_ * 1.4 - 2, s * 12);
    ctx.stroke();
  }
  oval(-5, 0, 7.5, 5.5, 0, fl ? WH : rgrad('skitAbd', -6, -2, 9, [[0, '#ffe680'], [1, '#c77800']]));
  outline(fl ? WH : '#5a3a00', 1);
  if (!fl) {
    ctx.strokeStyle = 'rgba(90,50,0,0.6)'; ctx.lineWidth = 1.2;
    for (const k of [-9, -6, -3]) { ctx.beginPath(); ctx.moveTo(k, -4.3); ctx.quadraticCurveTo(k + 1.5, 0, k, 4.3); ctx.stroke(); }
  }
  oval(4, 0, 5, 4.2, 0, fl ? WH : rgrad('skitHead', 3, -2, 6, [[0, '#fff0a0'], [1, '#e09a00']]));
  ctx.strokeStyle = fl ? WH : '#3a2400'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(8, -2); ctx.quadraticCurveTo(12, -3, 12, -0.5); ctx.moveTo(8, 2); ctx.quadraticCurveTo(12, 3, 12, 0.5); ctx.stroke();
  if (!fl) {
    circle(6.5, -2, 2.6, 'rgba(255,40,40,0.35)'); circle(6.5, 2, 2.6, 'rgba(255,40,40,0.35)');
    circle(6.5, -2, 1.3, '#ff2a2a'); circle(6.5, 2, 1.3, '#ff2a2a');
  }
  ctx.restore();
}

// Hovering eye drone — the shooter. Its lens tracks you and glows red before it fires.
function drawDrone(e, fl) {
  const hover = Math.sin(e.t * 4 + e.wob) * 3;
  shadow(e.x, e.y + 14, 10 - hover * 0.4, 3.5);
  ctx.save(); ctx.translate(e.x, e.y - 5 + hover);
  if (!fl) {
    ctx.fillStyle = 'rgba(90,210,255,0.55)';
    ctx.beginPath(); ctx.moveTo(-4, 10); ctx.lineTo(4, 10); ctx.lineTo(0, 16 + Math.random() * 5); ctx.closePath(); ctx.fill();
  }
  ctx.fillStyle = fl ? WH : '#1b5566';
  rrect(-18, -3, 7, 8, 2); ctx.fill(); rrect(11, -3, 7, 8, 2); ctx.fill();
  circle(0, 0, 12, fl ? WH : rgrad('droneBody', -4, -5, 17, [[0, '#e6fdff'], [0.35, '#4fd2ee'], [1, '#0b3d4c']]));
  outline(fl ? WH : '#062a33', 1.5);
  ctx.strokeStyle = fl ? WH : 'rgba(170,245,255,0.85)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(0, 1, 16, 4, Math.sin(e.t * 2) * 0.25, 0, Math.PI * 2); ctx.stroke();
  if (!fl) {
    const a = Math.atan2(look(e).y - e.y, look(e).x - e.x), ex = Math.cos(a) * 4, ey = Math.sin(a) * 3;
    const charging = e.fireT < 0.5;
    circle(ex, ey, 5.5, '#08161b');
    if (charging) circle(ex, ey, 8, 'rgba(255,50,80,0.35)');
    circle(ex, ey, 3.3, charging ? '#ff3355' : '#ff9a33');
    circle(ex - 1.1, ey - 1.1, 1, '#fff');
  }
  ctx.restore();
}

// Gooey slime that splits in two when it dies.
function drawSlime(e, fl) {
  shadow(e.x, e.y + 13, 15, 5);
  ctx.save(); ctx.translate(e.x, e.y);
  const n = 18;
  ctx.beginPath();
  for (let k = 0; k <= n; k++) {
    const a = k / n * Math.PI * 2;
    const rr = e.r * (1 + 0.09 * Math.sin(e.t * 5 + k * 1.7));
    const px = Math.cos(a) * rr * 1.05, py = Math.min(Math.sin(a) * rr * 0.92, 12);
    k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = fl ? WH : rgrad('slime', -5, -6, 22, [[0, '#d4ffbf'], [0.4, '#5be36b'], [1, '#1c7a2c']]);
  ctx.fill();
  outline(fl ? WH : '#0f4a18', 1.5);
  if (!fl) {
    circle(3, 4, 5, 'rgba(20,90,30,0.45)');
    circle(-7, 5 - (e.t * 6 % 6), 1.8, 'rgba(255,255,255,0.35)');
    circle(8, 2 - (e.t * 4 % 5), 1.3, 'rgba(255,255,255,0.3)');
    oval(-6, -8, 4.5, 2.5, -0.5, 'rgba(255,255,255,0.6)');
    const a = Math.atan2(look(e).y - e.y, look(e).x - e.x), lx = Math.cos(a) * 1.4, ly = Math.sin(a) * 1.4;
    for (const s of [-1, 1]) {
      circle(s * 4.5, -2, 3.4, '#fff');
      circle(s * 4.5 + lx, -2 + ly, 1.8, '#111');
    }
    ctx.strokeStyle = '#0f4a18'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, 3, 3.5, 0.2, Math.PI - 0.2); ctx.stroke();
  }
  ctx.restore();
}

// Armored treaded juggernaut — the tank. Hull turns with movement, turret tracks you.
function drawJuggernaut(e, fl) {
  shadow(e.x, e.y + 18, 24, 7);
  ctx.save(); ctx.translate(e.x, e.y); ctx.rotate(e.face);
  for (const s of [-1, 1]) {
    ctx.fillStyle = fl ? WH : '#1e1e24';
    rrect(-20, s * 15 - 5, 40, 10, 4); ctx.fill();
    if (!fl) {
      ctx.fillStyle = '#4a4a55';
      const off = (e.t * 30) % 6;
      for (let x = -18 + off; x < 17; x += 6) ctx.fillRect(x, s * 15 - 4, 2, 8);
    }
  }
  ctx.fillStyle = fl ? WH : lgrad('tankHull', 0, -12, 0, 12, [[0, '#c99cff'], [0.5, '#8a4fd6'], [1, '#4a2380']]);
  rrect(-17, -12, 34, 24, 6); ctx.fill();
  outline(fl ? WH : '#2a0f50', 1.5);
  if (!fl) {
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; rrect(8, -10, 8, 20, 3); ctx.fill();
    ctx.fillStyle = '#ffcc33'; ctx.fillRect(12, -8, 2, 4); ctx.fillRect(12, 4, 2, 4);
    for (const [rx, ry] of [[-14, -9], [-14, 9], [5, -9], [5, 9]]) circle(rx, ry, 1.3, '#e0ccff');
  }
  ctx.restore();
  ctx.save(); ctx.translate(e.x, e.y); ctx.rotate(Math.atan2(look(e).y - e.y, look(e).x - e.x));
  ctx.fillStyle = fl ? WH : '#3a2060'; rrect(4, -3, 22, 6, 2); ctx.fill();
  ctx.fillStyle = fl ? WH : '#241040'; ctx.fillRect(24, -4.5, 5, 9);
  circle(0, 0, 10, fl ? WH : rgrad('tankTur', -3, -3, 12, [[0, '#ecdcff'], [1, '#6a35b0']]));
  outline(fl ? WH : '#2a0f50', 1.5);
  if (!fl) { circle(-2, 0, 3.5, '#4a2380'); circle(3, -3, 1.5, '#ff4466'); }
  ctx.restore();
}

// The boss: a spiked war machine with twin cannons and a glowing core.
function drawOverlord(e, fl) {
  const enraged = e.hp < e.maxHp * 0.5;
  shadow(e.x, e.y + 42, 54, 14);
  ctx.save(); ctx.translate(e.x, e.y);
  ctx.save(); ctx.rotate(e.t * (enraged ? 1.8 : 0.6));
  ctx.fillStyle = fl ? WH : '#5a5f6e';
  for (let k = 0; k < 10; k++) {
    ctx.rotate(Math.PI / 5);
    ctx.beginPath(); ctx.moveTo(40, -8); ctx.lineTo(63, 0); ctx.lineTo(40, 8); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  const a = Math.atan2(look(e).y - e.y, look(e).x - e.x);
  for (const s of [-1, 1]) {
    ctx.save(); ctx.rotate(a + s * 0.55);
    ctx.fillStyle = fl ? WH : '#3b3f4a'; rrect(28, -9, 32, 18, 4); ctx.fill();
    outline(fl ? WH : '#15171c', 2);
    ctx.fillStyle = fl ? WH : '#1a1c22'; ctx.fillRect(56, -6, 9, 12);
    if (!fl) { ctx.fillStyle = enraged ? '#ff5a1f' : '#ffcc33'; ctx.fillRect(36, -2, 14, 4); }
    ctx.restore();
  }
  circle(0, 0, 46, fl ? WH : rgrad('bossShell', -15, -18, 62, [[0, '#ff9fb3'], [0.4, '#d0234a'], [1, '#3a0414']]));
  outline(fl ? WH : '#2a020c', 3);
  if (!fl) {
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 3;
    for (let k = 0; k < 6; k++) { ctx.beginPath(); ctx.arc(0, 0, 34, k * Math.PI / 3 + 0.2, k * Math.PI / 3 + 0.85); ctx.stroke(); }
    for (let k = 0; k < 8; k++) {
      const ra = k / 8 * Math.PI * 2 + 0.4;
      circle(Math.cos(ra) * 41, Math.sin(ra) * 41, 2, '#ffb3c2');
    }
    const pulse = 0.75 + 0.25 * Math.sin(e.t * (enraged ? 12 : 5));
    circle(0, 0, 26 * pulse, enraged ? 'rgba(255,90,20,0.35)' : 'rgba(255,220,60,0.3)');
    circle(0, 0, 17, '#1a0006');
    circle(0, 0, 12 * pulse, enraged ? '#ff5a1f' : '#ffd43b');
    circle(-3, -3, 3.5, '#fff');
    for (const k of [-1, 0, 1]) {
      ctx.fillStyle = enraged ? '#ff3b3b' : '#ff9e3b';
      rrect(k * 12 - 4, -33, 8, 4, 2); ctx.fill();
    }
  }
  ctx.restore();
}

// Sludge Queen: a huge wobbling slime wearing a crown.
function drawQueen(e, fl) {
  const enraged = e.hp < e.maxHp * 0.5;
  shadow(e.x, e.y + 40, 56, 14);
  ctx.save(); ctx.translate(e.x, e.y);
  const wob = Math.sin(e.t * (enraged ? 7 : 4));
  ctx.fillStyle = fl ? WH : rgrad('queenBody', -14, -20, 70, [[0, '#e6ffcc'], [0.35, '#7be35b'], [1, '#1d6b22']]);
  ctx.beginPath();
  for (let k = 0; k <= 24; k++) {
    const a = k / 24 * Math.PI * 2;
    const r = 48 + Math.sin(a * 5 + e.t * 3) * 3 + (Math.sin(a) > 0 ? 4 : 0);
    ctx.lineTo(Math.cos(a) * r * (1 + wob * 0.05), Math.sin(a) * r * (1 - wob * 0.05) + 4);
  }
  ctx.closePath(); ctx.fill();
  outline(fl ? WH : '#0f4a18', 3);
  if (!fl) {
    for (let k = 0; k < 5; k++) {   // bubbles drifting up inside
      const by = 30 - ((e.t * 18 + k * 13) % 60);
      circle(Math.sin(k * 2.3) * 26, by, 3 + k % 3, 'rgba(230,255,200,0.35)');
    }
    for (const sx of [-15, 15]) {
      circle(sx, -6, 9, '#fff');
      const a = Math.atan2(look(e).y - e.y, look(e).x - e.x);
      circle(sx + Math.cos(a) * 4, -6 + Math.sin(a) * 4, 4.5, enraged ? '#c00' : '#10300f');
    }
    ctx.strokeStyle = '#10300f'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 12, 12, 0.2, Math.PI - 0.2); ctx.stroke();
    // crown
    ctx.fillStyle = '#ffd43b';
    ctx.beginPath(); ctx.moveTo(-22, -40);
    for (let k = 0; k < 5; k++) { ctx.lineTo(-22 + k * 11 + 5.5, -60); ctx.lineTo(-22 + (k + 1) * 11, -44); }
    ctx.lineTo(22, -38); ctx.closePath(); ctx.fill();
    outline('#8a6400', 2);
    circle(0, -46, 3.5, '#ff3366');
  }
  ctx.restore();
}

// Cryo Sentinel: an ice robot ringed with crystals and a single tracking eye.
function drawSentinel(e, fl) {
  const aiming = e.mode === 'aim', stunned = e.mode === 'stun';
  shadow(e.x, e.y + 42, 54, 14);
  ctx.save(); ctx.translate(e.x + (aiming ? rand(-1.5, 1.5) : 0), e.y);
  ctx.save(); ctx.rotate(e.t * (e.mode === 'charge' ? 6 : 0.5));
  for (let k = 0; k < 8; k++) {
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = fl ? WH : k % 2 ? '#bff4ff' : '#7fd8f5';
    ctx.beginPath(); ctx.moveTo(36, -9); ctx.lineTo(64, 0); ctx.lineTo(36, 9); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  ctx.fillStyle = fl ? WH : lgrad('sentBody', 0, -44, 0, 44, [[0, '#e8fbff'], [0.5, '#4aa8d8'], [1, '#13406a']]);
  ctx.beginPath();
  for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2 + Math.PI / 8; ctx.lineTo(Math.cos(a) * 44, Math.sin(a) * 44); }
  ctx.closePath(); ctx.fill();
  outline(fl ? WH : '#0b2a45', 3);
  if (!fl) {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-28, -18); ctx.lineTo(-10, -32); ctx.moveTo(14, 26); ctx.lineTo(30, 10); ctx.stroke();
    circle(0, 0, 18, '#0b1e33');
    const a = Math.atan2(look(e).y - e.y, look(e).x - e.x);
    const eye = stunned ? '#7a8a99' : aiming || e.mode === 'charge' ? '#ff3b3b' : '#5fe1ff';
    circle(Math.cos(a) * 6, Math.sin(a) * 6, 11, eye);
    circle(Math.cos(a) * 6 - 3, Math.sin(a) * 6 - 3, 3, '#fff');
    if (stunned) for (let k = 0; k < 3; k++) {   // dizzy stars
      const sa = e.t * 5 + k * 2.1;
      label('✦', Math.cos(sa) * 30, -54 + Math.sin(sa) * 8, 14, '#ffe066', 'center');
    }
  }
  ctx.restore();
}

// Magma Titan: a cracked rock demon with lava veins, horns and a flickering flame crown.
function drawTitan(e, fl) {
  const enraged = e.hp < e.maxHp * 0.5;
  shadow(e.x, e.y + 44, 56, 14);
  ctx.save(); ctx.translate(e.x, e.y);
  if (!fl) for (let k = 0; k < 9; k++) {   // flame crown
    const a = -Math.PI / 2 + (k - 4) * 0.28, h = 18 + Math.sin(e.t * 14 + k * 1.7) * 7 + (enraged ? 8 : 0);
    ctx.fillStyle = k % 2 ? '#ffb347' : '#ff5a1f';
    ctx.beginPath();
    ctx.moveTo(Math.cos(a - 0.12) * 40, Math.sin(a - 0.12) * 40);
    ctx.lineTo(Math.cos(a) * (44 + h), Math.sin(a) * (44 + h));
    ctx.lineTo(Math.cos(a + 0.12) * 40, Math.sin(a + 0.12) * 40);
    ctx.fill();
  }
  for (const s of [-1, 1]) {   // horns
    ctx.fillStyle = fl ? WH : '#2a1a14';
    ctx.beginPath(); ctx.moveTo(s * 22, -34); ctx.quadraticCurveTo(s * 52, -50, s * 50, -72); ctx.quadraticCurveTo(s * 40, -48, s * 10, -38); ctx.fill();
  }
  circle(0, 0, 46, fl ? WH : rgrad('titanBody', -14, -16, 64, [[0, '#7a4a3a'], [0.5, '#3b211a'], [1, '#160a07']]));
  outline(fl ? WH : '#0a0402', 3);
  if (!fl) {
    const glow = 0.6 + 0.4 * Math.sin(e.t * (enraged ? 10 : 4));
    ctx.strokeStyle = `rgba(255,${enraged ? 70 : 120},20,${glow})`; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-30, 20); ctx.lineTo(-14, 8); ctx.lineTo(-20, -6);
    ctx.moveTo(28, 24); ctx.lineTo(16, 10); ctx.lineTo(24, -4);
    ctx.moveTo(-6, 36); ctx.lineTo(4, 26); ctx.lineTo(0, 16);
    ctx.stroke();
    for (const sx of [-15, 15]) {
      ctx.fillStyle = '#ffe066';
      ctx.beginPath(); ctx.moveTo(sx - 9, -14); ctx.lineTo(sx + 9, -14 + (sx < 0 ? 5 : -5)); ctx.lineTo(sx, -6); ctx.fill();
    }
    ctx.fillStyle = `rgba(255,90,20,${glow})`; rrect(-14, 6, 28, 8, 3); ctx.fill();
  }
  ctx.restore();
}

function drawEnemy(e) {
  const fl = e.hitT > 0;
  ctx.save(); ctx.translate(e.x, e.y); ctx.scale(SPR, SPR); ctx.translate(-e.x, -e.y);
  switch (e.type) {
    case 'grunt': drawBrute(e, fl); break;
    case 'runner': drawSkitter(e, fl); break;
    case 'shooter': drawDrone(e, fl); break;
    case 'splitter': drawSlime(e, fl); break;
    case 'tank': drawJuggernaut(e, fl); break;
    case 'boss':
      if (e.kind === 'queen') drawQueen(e, fl);
      else if (e.kind === 'sentinel') drawSentinel(e, fl);
      else if (e.kind === 'titan') drawTitan(e, fl);
      else drawOverlord(e, fl);
      break;
  }
  ctx.restore();
  if (e.type !== 'boss' && e.hp < e.maxHp && e.maxHp > 3) {
    const wdt = e.r * 2, top = e.y - e.r - (e.type === 'grunt' ? 26 : 10);
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(e.x - wdt / 2, top, wdt, 4);
    ctx.fillStyle = '#7CFC00'; ctx.fillRect(e.x - wdt / 2, top, wdt * Math.max(0, e.hp / e.maxHp), 4);
  }
}

// The hero: armored arena commando with a visor helmet and a rifle that follows your aim.
function drawPlayerGun(a, p) {
  ctx.save(); ctx.translate(0, -2); ctx.rotate(a);
  if (Math.cos(a) < 0) ctx.scale(1, -1);   // keep the gun right side up when aiming left
  ctx.fillStyle = '#1f5fbf'; rrect(0, -3, 9, 6, 3); ctx.fill();
  ctx.fillStyle = '#3a3f4a'; rrect(6, -3.5, 17, 7, 2); ctx.fill();
  ctx.fillStyle = '#6b7280'; ctx.fillRect(9, -3.5, 11, 2);
  ctx.fillStyle = '#9aa3b2'; ctx.fillRect(21, -2, 6, 4);
  ctx.fillStyle = '#2a2d33'; ctx.fillRect(11, 3, 4, 4);
  circle(8, 0.5, 3, '#222');
  ctx.fillStyle = '#33e0ff'; ctx.fillRect(15, -1, 4, 1.5);
  if (p.muzzle > 0) {
    ctx.fillStyle = 'rgba(255,240,150,0.95)';
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const ma = k / 8 * Math.PI * 2, mr = k % 2 ? 3 : 8;
      ctx.lineTo(30 + Math.cos(ma) * mr, Math.sin(ma) * mr);
    }
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

function drawPlayer(p) {
  if (state === 'over') return;
  const col = PCOL[p.pid];
  const blink = !p.down && p.inv > 0 && Math.floor(time * 18) % 2 === 0;
  if (p.down) ctx.globalAlpha = 0.3;   // downed: a see-through ghost until next round
  const a = Math.atan2(p.ay, p.ax);
  const face = p.ax < 0 ? -1 : 1;
  ctx.save(); ctx.translate(p.x, p.y); ctx.scale(SPR, SPR); ctx.translate(-p.x, -p.y);
  shadow(p.x, p.y + 15, 13, 5);
  if (!blink) {
    const step = p.moving ? Math.sin(p.walk) : 0;
    const bob = p.moving ? Math.abs(Math.cos(p.walk)) * 1.2 : 0;
    ctx.save(); ctx.translate(p.x, p.y);
    const gunBehind = p.ay < -0.5;
    // legs + boots
    for (const [lx, s] of [[-7, step], [1, -step]]) {
      const len = 9 + s * 2.5;
      ctx.fillStyle = '#2a3a5c'; ctx.fillRect(lx, 3, 6, len);
      ctx.fillStyle = '#15151c'; rrect(lx - 0.5, 2 + len, 7, 4, 1.5); ctx.fill();
    }
    ctx.translate(0, -bob);
    // backpack
    ctx.fillStyle = '#3d4a5e'; rrect(-face * 9 - 4, -8, 8, 12, 2); ctx.fill();
    ctx.fillStyle = '#ffcc33'; ctx.fillRect(-face * 9 - 1, -6, 2, 2);
    if (gunBehind) drawPlayerGun(a, p);
    // torso
    ctx.fillStyle = lgrad('pTorso' + p.pid, 0, -9, 0, 7, [[0, col.main], [1, col.dark]]);
    rrect(-9, -9, 18, 15, 5); ctx.fill();
    outline(col.edge, 1.5);
    ctx.fillStyle = 'rgba(255,255,255,0.22)'; rrect(-6, -7, 12, 6, 3); ctx.fill();
    ctx.fillStyle = '#2b2b2b'; ctx.fillRect(-9, 3, 18, 3);
    ctx.fillStyle = '#ffd43b'; ctx.fillRect(-2, 3, 4, 3);
    circle(-8, -6, 3.5, col.pad); circle(8, -6, 3.5, col.pad);
    // helmet + visor
    circle(0, -14, 7.5, rgrad('pHelm', -2, -17, 10, [[0, '#c8d6e8'], [1, '#3b4a5e']]));
    outline('#1c2533', 1.2);
    ctx.fillStyle = 'rgba(51,224,255,0.35)'; rrect(face > 0 ? -2 : -8, -17, 10, 6, 3); ctx.fill();
    ctx.fillStyle = '#33e0ff'; rrect(face > 0 ? -1 : -7, -16, 8, 4, 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillRect(face > 0 ? 4 : -5, -15.5, 2, 1.2);
    ctx.fillStyle = '#ff3344'; ctx.fillRect(-1, -22, 2, 4);
    if (!gunBehind) drawPlayerGun(a, p);
    ctx.restore();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
  if (players.length > 1 && p !== me) {   // name tag over friends
    label(p.down ? pname(p) + ' DOWN' : pname(p), p.x, p.y - 38, 11, col.tag, 'center');
  }
  if (p.blades > 0) {
    const fade = p.blades < 1.5 && Math.floor(time * 12) % 2 === 0;
    const nb = 4 + L(p, 'blades');
    if (!fade) for (let k = 0; k < nb; k++) {
      const ba = p.bladeA + k * Math.PI * 2 / nb;
      const bx = p.x + Math.cos(ba) * 64, by = p.y + Math.sin(ba) * 64;
      ctx.save(); ctx.translate(bx, by); ctx.rotate(time * 20);
      circle(0, 0, 17, 'rgba(204,102,255,0.18)');
      ctx.fillStyle = '#e8c8ff'; ctx.beginPath();
      for (let s = 0; s < 8; s++) {
        const sa = s / 8 * Math.PI * 2, rr = s % 2 ? 7 : 15;
        ctx.lineTo(Math.cos(sa) * rr, Math.sin(sa) * rr);
      }
      ctx.closePath(); ctx.fill();
      circle(0, 0, 4, '#8a3ccc');
      ctx.restore();
    }
  }
}

function drawGearFx(p) {
  if (state === 'over' || p.down) return;
  if (p.shield > 0) {
    ctx.strokeStyle = `rgba(95,225,255,${0.45 + 0.2 * Math.sin(time * 6)})`; ctx.lineWidth = p.shield > 1 ? 3 : 1.5;
    ctx.beginPath(); ctx.arc(p.x, p.y - 4, 28, 0, Math.PI * 2); ctx.stroke();
  }
  const dr = p.drone;
  if (p.buffs.drone > 0 && (p.buffs.drone > 1.5 || Math.floor(time * 10) % 2)) {
    dronePos(p);
    shadow(dr.x, dr.y + 22, 7, 3);
    circle(dr.x, dr.y, 9, '#4caf50');
    circle(dr.x - 2.5, dr.y - 2.5, 3, 'rgba(255,255,255,0.45)');
    circle(dr.x, dr.y + 1, 3.5, '#111');
    circle(dr.x + 1, dr.y, 1.3, '#7CFC00');
  }
}

function drawShots() {
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,224,102,0.35)'; ctx.lineWidth = 8;
  ctx.beginPath();
  for (const b of bullets) if (!b.color) { ctx.moveTo(b.x - b.vx * 0.02, b.y - b.vy * 0.02); ctx.lineTo(b.x, b.y); }
  ctx.stroke();
  ctx.strokeStyle = '#fff3b0'; ctx.lineWidth = 3.5;
  ctx.stroke();
  for (const b of bullets) {   // laser and drone shots get their own color
    if (!b.color) continue;
    ctx.strokeStyle = b.color; ctx.lineWidth = 6; ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.moveTo(b.x - b.vx * 0.025, b.y - b.vy * 0.025); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.globalAlpha = 1; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
  }

  for (const m of missiles) {
    ctx.save(); ctx.translate(m.x, m.y); ctx.rotate(m.a);
    ctx.fillStyle = '#e6f7ff'; ctx.fillRect(-7, -3, 14, 6);
    ctx.fillStyle = '#33ccff'; ctx.fillRect(-9, -4, 4, 8);
    ctx.restore();
  }

  drawEnemyBullets();
}

function drawEnemyBullets() {
  const pulse = 1 + Math.sin(time * 15) * 0.15;
  for (const b of ebullets) {
    const c = b.color || '#ff4f9a';
    ctx.globalAlpha = 0.3; circle(b.x, b.y, 9 * pulse, c); ctx.globalAlpha = 1;
    circle(b.x, b.y, 5, c);
    circle(b.x, b.y, 2.5, '#fff');
  }
}

function drawHazards() {
  const th = THEMES[themeIdx % THEMES.length];
  for (const pd of puddles) {
    const a = Math.min(1, pd.life / 0.8) * (0.55 + 0.1 * Math.sin(time * 6 + pd.x));
    ctx.globalAlpha = a;
    circle(pd.x, pd.y, pd.r, '#4fbf2a');
    circle(pd.x - pd.r * 0.2, pd.y - pd.r * 0.2, pd.r * 0.5, '#9dff3d');
    ctx.globalAlpha = 1;
  }
  for (const st of strikes) {
    const k = 1 - st.t / st.max;
    ctx.globalAlpha = 0.25; circle(st.x, st.y, st.r * k, st.color); ctx.globalAlpha = 1;
    ctx.strokeStyle = st.color; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2); ctx.stroke();
  }
  if (boss && !boss.dead && boss.kind === 'sentinel' && boss.mode === 'aim') {
    const b = boss, len = 1200, wdt = b.r * 1.6;
    ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(Math.atan2(b.cdy, b.cdx));
    ctx.fillStyle = `rgba(255,60,60,${0.12 + 0.12 * Math.sin(time * 30)})`;
    ctx.fillRect(0, -wdt / 2, len, wdt);
    ctx.strokeStyle = 'rgba(255,80,80,0.6)'; ctx.lineWidth = 2;
    ctx.strokeRect(0, -wdt / 2, len, wdt);
    ctx.restore();
  }
  for (const c of pillars) {
    const r = c.r * (0.3 + 0.7 * c.rise);
    shadow(c.x + 5, c.y + 7, r, r * 0.85);
    circle(c.x, c.y, r, th.wall);
    ctx.strokeStyle = th.neon; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(c.x, c.y, r - 1.5, 0, Math.PI * 2); ctx.stroke();
    circle(c.x - r * 0.22, c.y - r * 0.25, r * 0.5, 'rgba(255,255,255,0.08)');
  }
  for (const m of mines) {
    const lit = m.fuse >= 0 ? Math.floor(time * 16) % 2 === 0 : Math.sin(m.t * 4) > 0.3;
    if (m.fuse >= 0) {
      ctx.strokeStyle = 'rgba(255,60,60,0.5)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(m.x, m.y, 70, 0, Math.PI * 2); ctx.stroke();
    }
    circle(m.x, m.y, 12, '#2a2a30');
    ctx.strokeStyle = '#ff9f1a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(m.x, m.y, 10, 0, Math.PI * 2); ctx.stroke();
    circle(m.x, m.y, 4, lit ? '#ff3b3b' : '#5a1a1a');
  }
  for (const w of warps) {
    const k = Math.max(0, w.t / 1.1);
    ctx.strokeStyle = `rgba(255,68,102,${0.9 - k * 0.5})`; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(w.x, w.y, 10 + k * 30, 0, Math.PI * 2); ctx.stroke();
    circle(w.x, w.y, 6 * (1 - k) + 2, '#ff4466');
  }
}

// LIGHTS OUT: dark everywhere except around you. Enemy eyes and bullets still glow so it stays fair.
function drawDarkness() {
  const p = me;
  const g = ctx.createRadialGradient(p.x, p.y, 70, p.x, p.y, 220);
  g.addColorStop(0, 'rgba(4,3,10,0)'); g.addColorStop(1, 'rgba(4,3,10,0.92)');
  ctx.fillStyle = g; ctx.fillRect(-60, -60, W + 120, H + 120);
  for (const e of enemies) {
    circle(e.x, e.y - e.r * 0.3, 7, 'rgba(255,255,255,0.15)');
    circle(e.x, e.y - e.r * 0.3, 3, e.color);
  }
  drawEnemyBullets();
}

// When a thumb is over your guy, show a zoomed-in bubble of him just above, where you can see it.
let peekA = 0;
function drawPeek() {
  if (!isTouch || state !== 'play' || paused) { peekA = 0; return; }
  if (!me) return;
  const px = offX + me.x * scale, py = offY + me.y * scale;
  const covered = [sticks.left, sticks.right].some(s => s && d2(s.x, s.y, px, py) < 120 * 120);
  peekA = clamp(peekA + (covered ? 0.2 : -0.1), 0, 1);
  if (peekA <= 0) return;
  const R = 54, rs = R / 1.4;
  const bx = clamp(px, safe.l + R + 6, sw - safe.r - R - 6);
  let by = py - R - 64;
  if (by < safe.t + R + 6) by = py + R + 64;
  ctx.save();
  ctx.globalAlpha = peekA * 0.95;
  ctx.beginPath(); ctx.arc(bx, by, R, 0, Math.PI * 2);
  ctx.save(); ctx.clip();
  ctx.fillStyle = '#0d0b18'; ctx.fillRect(bx - R, by - R, R * 2, R * 2);
  ctx.drawImage(canvas, (px - rs) * dpr, (py - rs) * dpr, rs * 2 * dpr, rs * 2 * dpr, bx - R, by - R, R * 2, R * 2);
  ctx.restore();
  ctx.strokeStyle = '#33e0ff'; ctx.lineWidth = 2.5; ctx.stroke();
  const dir = by < py ? 1 : -1;   // little tail pointing back at the player
  ctx.fillStyle = '#33e0ff';
  ctx.beginPath(); ctx.moveTo(bx - 8, by + dir * (R - 1)); ctx.lineTo(bx + 8, by + dir * (R - 1)); ctx.lineTo(bx, by + dir * (R + 10)); ctx.fill();
  ctx.restore();
}

function drawPickups() {
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const pk of pickups) {
    if (pk.life < 2 && Math.floor(pk.t * 10) % 2 === 0) continue;
    const def = PICKUPS[pk.type];
    const y = pk.y + Math.sin(pk.t * 5) * 3;
    circle(pk.x, y, 17, 'rgba(255,255,255,0.12)');
    circle(pk.x, y, 13, def.color);
    ctx.fillStyle = '#111'; ctx.font = 'bold 15px system-ui, sans-serif';
    ctx.fillText(def.label, pk.x, y + 1);
  }
}

function drawFx() {
  for (const fx of effects) {
    const k = fx.r / fx.max;
    ctx.strokeStyle = `rgba(255,140,60,${1 - k})`; ctx.lineWidth = 18 * (1 - k) + 3;
    ctx.beginPath(); ctx.arc(fx.x, fx.y, fx.r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = `rgba(255,255,220,${(1 - k) * 0.8})`; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(fx.x, fx.y, fx.r * 0.92, 0, Math.PI * 2); ctx.stroke();
  }
  for (const pt of particles) {
    ctx.globalAlpha = Math.max(0, pt.life / pt.max);
    ctx.fillStyle = pt.color;
    ctx.fillRect(pt.x - pt.size / 2, pt.y - pt.size / 2, pt.size, pt.size);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const t of texts) {
    ctx.globalAlpha = Math.min(1, t.life / t.max * 2);
    ctx.font = `bold ${t.size}px system-ui, sans-serif`;
    ctx.fillStyle = '#000'; ctx.fillText(t.text, t.x + 1.5, t.y + 1.5);
    ctx.fillStyle = t.color; ctx.fillText(t.text, t.x, t.y);
  }
  ctx.globalAlpha = 1;
}

function label(text, x, y, size, color = '#fff', align = 'left', weight = 'bold') {
  ctx.font = `${weight} ${size}px system-ui, sans-serif`;
  ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillText(text, x + 2, y + 2);
  ctx.fillStyle = color; ctx.fillText(text, x, y);
}

function drawHeart(x, y, s, filled) {
  ctx.fillStyle = filled ? '#ff4466' : 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.35);
  ctx.bezierCurveTo(x, y, x - s * 0.6, y, x - s * 0.6, y + s * 0.35);
  ctx.bezierCurveTo(x - s * 0.6, y + s * 0.7, x, y + s * 0.85, x, y + s);
  ctx.bezierCurveTo(x, y + s * 0.85, x + s * 0.6, y + s * 0.7, x + s * 0.6, y + s * 0.35);
  ctx.bezierCurveTo(x + s * 0.6, y, x, y, x, y + s * 0.35);
  ctx.fill();
}

function drawHud() {
  const p = me;
  const left = safe.l + 14, top = safe.t;
  label(`SCORE ${score.toLocaleString()}`, left, top + 22, 18);
  for (let i = 0; i < p.maxHp; i++) drawHeart(left + 9 + i * 22, top + 38, 18, i < p.hp);
  drawGem(left + 7, top + 70, 7);
  label(`${Math.floor(p.credits)}`, left + 19, top + 70, 15, '#4dfff0');
  let y = top + 92;
  if (combo >= 5) { label(`x${comboMult()} COMBO ${combo}`, left, y, 14, '#ffd43b'); y += 20; }
  if (p.weapon !== 'basic') {
    const w = WEAPONS[p.weapon];
    label(w.name, left, y, 13, w.color);
    if (p.weaponT > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.fillRect(left + 62, y - 3, 60, 6);
      ctx.fillStyle = '#fff'; ctx.fillRect(left + 62, y - 3, 60 * Math.max(0, p.weaponT / p.weaponMax), 6);
    }
    y += 20;
  }
  for (const g of GEAR) {   // bought buffs still running, each with its timer
    const t = p.buffs[g.id];
    if (!(t > 0)) continue;
    ctx.font = '13px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
    ctx.fillText(g.icon, left, y);
    ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.fillRect(left + 22, y - 3, 60, 6);
    ctx.fillStyle = '#7CFC00'; ctx.fillRect(left + 22, y - 3, 60 * t / p.buffMax, 6);
    y += 18;
  }
  if (p.down) label(p.joining ? 'JOINING · in from the next round' : 'YOU\'RE DOWN · back next round', left, y + 4, 13, p.joining ? '#7CFC00' : '#ff6b6b');

  if (players.length > 1) {   // friends' hearts, top right of the arena
    const rx = offX + W * scale - 12;
    let fy = top + 22;
    for (const o of players) {
      if (o === me) continue;
      label(o.down ? `${pname(o)} DOWN` : `${pname(o)} ${'♥'.repeat(Math.max(0, o.hp))}`, rx, fy, 12, o.down ? '#888' : PCOL[o.pid].tag, 'right');
      fy += 17;
    }
  }

  const mid = offX + W * scale / 2;
  label(`ROUND ${round}`, mid, top + 20, 18, '#fff', 'center');
  const left2 = net.role === 'guest' ? enemiesLeft : spawnQueue.length + warps.length + enemies.length;
  if (roundPhase !== 'clear') label(`${left2} enemies left`, mid, top + 40, 12, 'rgba(255,255,255,0.7)', 'center', 'normal');
  if (twist && roundPhase !== 'clear') label(TWISTS[twist].name, mid, top + 58, 12, TWISTS[twist].color, 'center');

  if (boss && !boss.dead) {
    const bw = Math.min(360, sw * 0.5), bx = mid - bw / 2, by = top + 54;
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(bx - 2, by - 2, bw + 4, 14);
    ctx.fillStyle = boss.color; ctx.fillRect(bx, by, bw * Math.max(0, boss.hp / boss.maxHp), 10);
    label(bossDef().name, mid, by + 22, 12, boss.color, 'center');
  }

  // pause & mute
  for (const b of [pauseBtn, muteBtn]) circle(b.x, b.y, b.r, 'rgba(255,255,255,0.12)');
  ctx.fillStyle = '#fff';
  ctx.fillRect(pauseBtn.x - 6, pauseBtn.y - 8, 4, 16); ctx.fillRect(pauseBtn.x + 2, pauseBtn.y - 8, 4, 16);
  drawSpeaker(muteBtn.x, muteBtn.y, Sound.muted);

  // ability buttons
  ABILITIES.forEach((a, i) => {
    const b = abilityBtns[i];
    const ready = p.charges[i] > 0 && !p.down;
    const pr = btnPress[i] > 0 ? 0.88 : 1;
    ctx.globalAlpha = ready ? 0.95 : 0.35;
    circle(b.x, b.y, b.r * pr, 'rgba(0,0,0,0.5)');
    ctx.strokeStyle = a.color; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r * pr, 0, Math.PI * 2); ctx.stroke();
    circle(b.x, b.y, b.r * pr - 5, ready ? a.color + '55' : 'transparent');
    drawAbilityIcon(a.id, b.x, b.y - 4, b.r * 0.42, a.color);
    ctx.globalAlpha = 1;
    label(a.name, b.x, b.y + b.r * 0.5, isTouch ? 10 : 9, '#fff', 'center');
    circle(b.x + b.r * 0.72, b.y - b.r * 0.72, 10, ready ? '#fff' : '#555');
    ctx.fillStyle = '#111'; ctx.font = 'bold 12px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(p.charges[i], b.x + b.r * 0.72, b.y - b.r * 0.72 + 1);
    if (!isTouch) label(a.keys[0], b.x - b.r * 0.72, b.y - b.r * 0.72, 11, 'rgba(255,255,255,0.6)', 'center');
  });
}

function drawGem(x, y, s) {
  ctx.fillStyle = '#4dfff0';
  ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.8, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s * 0.8, y); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.8, y); ctx.lineTo(x, y); ctx.closePath(); ctx.fill();
}

function drawShop() {
  ctx.fillStyle = 'rgba(8,6,16,0.9)'; ctx.fillRect(0, 0, sw, sh);
  label('UPGRADE SHOP', sw / 2, safe.t + 20, 22, '#ffe066', 'center');
  const credits = Math.floor(me.credits);
  const ct = `${credits}`;
  ctx.font = 'bold 17px system-ui, sans-serif';
  const tw = ctx.measureText(ct).width;
  drawGem(sw / 2 - tw / 2 - 10, safe.t + 44, 7);
  label(ct, sw / 2 - tw / 2 + 2, safe.t + 44, 17, '#4dfff0');
  if (shopMsg) label(shopMsg.text, sw - safe.r - 14, safe.t + 44, 13, shopMsg.color, 'right');
  label(`Next: round ${round + 1}`, safe.l + 14, safe.t + 44, 12, 'rgba(255,255,255,0.55)', 'left', 'normal');

  for (const t of shopTabs) {
    const on = t.id === shopTab;
    ctx.fillStyle = on ? 'rgba(255,224,102,0.22)' : 'rgba(255,255,255,0.05)';
    rrect(t.x, t.y, t.w, t.h, 8); ctx.fill();
    outline(on ? '#ffe066' : 'rgba(255,255,255,0.18)', on ? 2 : 1);
    label(t.label, t.x + t.w / 2, t.y + 11, 13, on ? '#ffe066' : '#fff', 'center');
    label(t.id === 'gear' ? `next round · ${buffTime()}s each` : t.sub, t.x + t.w / 2, t.y + 23, 10, 'rgba(255,255,255,0.6)', 'center', 'normal');
  }

  const hasGun = GEAR.some(o => o.gun && me.gear.includes(o.id));
  for (const c of shopCards) {
    let title, desc, icon, cost = 0, can = false, maxed = false, pips = null, owned = false;
    if (c.kind === 'go') {
      ctx.fillStyle = c.flash > 0 ? '#9dff8a' : '#2fa84f';
      rrect(c.x, c.y, c.w, c.h, 10); ctx.fill();
      outline('#7CFC00', 2);
      const nReady = players.filter(o => o.ready).length;
      const txt = players.length < 2 ? 'NEXT ROUND ▶' : me.ready ? `WAITING ${nReady}/${players.length}` : `READY ▶ (${nReady}/${players.length})`;
      label(txt, c.x + c.w / 2, c.y + c.h / 2, Math.min(18, c.w / 9), '#fff', 'center');
      continue;
    }
    if (c.kind === 'heal') {
      title = 'MED KIT'; desc = 'Refill all hearts'; icon = '❤️';
      cost = healCost(); can = credits >= cost && me.hp < me.maxHp;
    } else if (c.kind === 'gear') {
      const g = c.g;
      title = g.name; desc = g.desc; icon = g.icon;
      owned = me.gear.includes(g.id); cost = gearCost(g);
      if (!g.once) desc += ` (${buffTime()}s)`;
      can = !owned && !(g.gun && hasGun) && credits >= cost;
    } else {
      const u = c.u;
      title = u.name; desc = u.desc; icon = u.icon;
      maxed = lvl(u.id) >= u.max; cost = upgradeCost(u);
      can = !maxed && credits >= cost;
      pips = [lvl(u.id), u.max];
    }
    ctx.fillStyle = c.flash > 0 ? 'rgba(124,252,0,0.35)' : can ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.035)';
    rrect(c.x, c.y, c.w, c.h, 10); ctx.fill();
    outline(can ? 'rgba(77,255,240,0.7)' : 'rgba(255,255,255,0.12)', can ? 2 : 1);
    ctx.globalAlpha = can || maxed || owned ? 1 : 0.55;
    const iconS = Math.min(24, c.h * 0.3);
    ctx.font = `${iconS}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(icon, c.x + iconS * 0.5 + 10, c.y + c.h * 0.36);
    const tx = c.x + iconS + 16, maxW = c.x + c.w - tx - 6;
    const ts = Math.min(13, c.w / 13);
    ctx.font = `bold ${ts}px system-ui, sans-serif`; ctx.textAlign = 'left';
    ctx.fillStyle = '#fff'; ctx.fillText(title, tx, c.y + c.h * 0.22, maxW);
    ctx.font = `${ts - 2}px system-ui, sans-serif`; ctx.fillStyle = '#b8b8c8';
    ctx.fillText(desc, tx, c.y + c.h * 0.45, maxW);
    if (pips && pips[1] === Infinity) label(`LV ${pips[0]}`, c.x + 10, c.y + c.h - 12, 12, '#7CFC00');
    else if (pips) {
      for (let i = 0; i < pips[1]; i++) {
        ctx.fillStyle = i < pips[0] ? '#7CFC00' : 'rgba(255,255,255,0.18)';
        ctx.fillRect(c.x + 10 + i * 11, c.y + c.h - 16, 8, 8);
      }
    }
    if (maxed) label('MAX', c.x + c.w - 10, c.y + c.h - 12, 13, '#7CFC00', 'right');
    else if (owned) label('BOUGHT', c.x + c.w - 10, c.y + c.h - 12, 12, '#7CFC00', 'right');
    else {
      ctx.font = 'bold 14px system-ui, sans-serif';
      const cw2 = ctx.measureText(`${cost}`).width;
      drawGem(c.x + c.w - 22 - cw2, c.y + c.h - 12, 5.5);
      label(`${cost}`, c.x + c.w - 10, c.y + c.h - 12, 14, credits >= cost ? '#4dfff0' : '#ff6b6b', 'right');
    }
    ctx.globalAlpha = 1;
  }
}

function drawSpeaker(x, y, muted) {
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(x - 9, y - 4); ctx.lineTo(x - 4, y - 4); ctx.lineTo(x + 2, y - 9);
  ctx.lineTo(x + 2, y + 9); ctx.lineTo(x - 4, y + 4); ctx.lineTo(x - 9, y + 4); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = muted ? '#ff4466' : '#fff'; ctx.lineWidth = 2;
  ctx.beginPath();
  if (muted) { ctx.moveTo(x + 5, y - 5); ctx.lineTo(x + 11, y + 5); ctx.moveTo(x + 11, y - 5); ctx.lineTo(x + 5, y + 5); }
  else { ctx.arc(x + 3, y, 7, -0.8, 0.8); }
  ctx.stroke();
}

function drawAbilityIcon(id, x, y, s, color) {
  ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineWidth = 2.5;
  if (id === 'blast') {
    ctx.beginPath();
    for (let k = 0; k < 16; k++) {
      const a = k / 16 * Math.PI * 2, r = k % 2 ? s * 0.5 : s;
      ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    ctx.closePath(); ctx.fill();
  } else if (id === 'missiles') {
    for (const dx of [-s * 0.55, 0, s * 0.55]) {
      ctx.beginPath();
      ctx.moveTo(x + dx, y - s); ctx.lineTo(x + dx + s * 0.25, y - s * 0.5);
      ctx.lineTo(x + dx + s * 0.25, y + s * 0.7); ctx.lineTo(x + dx - s * 0.25, y + s * 0.7);
      ctx.lineTo(x + dx - s * 0.25, y - s * 0.5); ctx.closePath(); ctx.fill();
    }
  } else {
    ctx.beginPath();
    for (let k = 0; k < 12; k++) {
      const a = k / 12 * Math.PI * 2 + time * 3, r = k % 2 ? s * 0.45 : s;
      ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    ctx.closePath(); ctx.fill();
    circle(x, y, s * 0.25, color);
  }
}

function drawSticks() {
  if (!isTouch || state !== 'play' || paused) return;
  const hint = round <= 2;
  for (const side of ['left', 'right']) {
    const s = sticks[side];
    if (s) {
      ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(s.ox, s.oy, STICK_R, 0, Math.PI * 2); ctx.stroke();
      circle(s.ox + s.vx * STICK_R, s.oy + s.vy * STICK_R, 24, side === 'left' ? 'rgba(58,141,255,0.5)' : 'rgba(255,224,102,0.5)');
    } else if (hint) {
      const x = side === 'left' ? safe.l + STICK_R + 40 : sw - safe.r - SIDE_W - STICK_R - 40, y = sh * 0.72;
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, STICK_R, 0, Math.PI * 2); ctx.stroke();
      label(side === 'left' ? 'MOVE' : 'AIM', x, y, 13, 'rgba(255,255,255,0.35)', 'center');
    }
  }
}

function drawCenterPanel(lines) {
  ctx.fillStyle = 'rgba(8,6,16,0.72)'; ctx.fillRect(0, 0, sw, sh);
  let y = sh / 2 - lines.reduce((s, l) => s + (l.gap || l.size * 1.5), 0) / 2;
  for (const l of lines) {
    const h = l.gap || l.size * 1.5;
    if (l.text) label(l.text, sw / 2, y + h / 2, l.size, l.color || '#fff', 'center', l.weight || 'bold');
    y += h;
  }
}

function render() {
  uiButtons = []; uiState = state;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0d0b18'; ctx.fillRect(0, 0, canvas.width, canvas.height);

  const sx = shake > 0 ? rand(-shake, shake) * 0.5 : 0, sy = shake > 0 ? rand(-shake, shake) * 0.5 : 0;
  const k = scale * dpr;
  ctx.setTransform(k, 0, 0, k, (offX + sx * scale) * dpr, (offY + sy * scale) * dpr);
  drawArena();
  if (state !== 'title' && state !== 'notes' && state !== 'lobby' && state !== 'join') {
    drawHazards();
    drawPickups();
    for (const e of enemies) drawEnemy(e);
    for (const p of players) if (p !== me) drawPlayer(p);
    if (me) drawPlayer(me);
    for (const p of players) drawGearFx(p);
    drawShots();
    drawFx();
    if (twist === 'lights' && state === 'play' && roundPhase !== 'clear') drawDarkness();
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (flash > 0) { ctx.fillStyle = `rgba(${flashColor},${Math.min(0.5, flash * 0.6)})`; ctx.fillRect(0, 0, sw, sh); }
  drawPeek();

  const portrait = isTouch && sh > sw;
  if (portrait) {
    drawCenterPanel([
      { text: '↻', size: 64, color: '#33ccff' },
      { text: 'Rotate your phone', size: 24 },
      { text: 'Arena Blitz plays in landscape', size: 14, color: '#aaa', weight: 'normal' },
    ]);
    return;
  }

  if (state === 'notes' && release) {
    const pulse = 0.6 + 0.4 * Math.sin(time * 4);
    drawCenterPanel([
      { text: 'ARENA BLITZ', size: Math.min(40, sw / 14), color: '#ff3df0' },
      { text: `Version ${release.version}  ·  ${release.date}`, size: 14, color: '#9be7ff', weight: 'normal' },
      { gap: 14 },
      { text: "WHAT'S NEW", size: 18, color: '#ffe066' },
      ...release.notes.map(n => ({ text: '• ' + n, size: 14, weight: 'normal' })),
      { gap: 18 },
      { text: isTouch ? 'TAP TO CONTINUE' : 'CLICK OR PRESS ENTER', size: 18, color: `rgba(255,224,102,${pulse})` },
    ]);
    return;
  }

  if (state === 'title') { drawTitle(); return; }
  if (state === 'lobby') { drawLobby(); return; }
  if (state === 'join') return;

  if (state === 'shop') { drawShop(); return; }

  drawHud();
  drawSticks();

  if (banner && state === 'play') {
    const a = Math.min(1, banner.t * 2);
    ctx.globalAlpha = a;
    const mid = offX + W * scale / 2;
    label(banner.title, mid, sh * 0.36, Math.min(46, sw / 14), '#ffe066', 'center');
    label(banner.sub, mid, sh * 0.36 + 38, 16, banner.color, 'center');
    if (banner.note) label(banner.note, mid, sh * 0.36 + 64, 14, '#9be7ff', 'center');
    ctx.globalAlpha = 1;
  }

  if (paused && state === 'play') {
    drawCenterPanel([
      { text: 'PAUSED', size: 42, color: '#33ccff' },
      { text: net.role !== 'solo' ? 'Paused for everyone · tap to resume' : isTouch ? 'Tap to resume' : 'Click or press P to resume', size: 16, color: '#ccc', weight: 'normal' },
    ]);
    if (net.role !== 'solo') uiButton(net.role === 'host' ? 'END GAME' : 'LEAVE', sw / 2, sh * 0.72, 160, 44, '#a83232', () => leaveGame());
  }

  if (state === 'over' && overT > 0.8) {
    drawCenterPanel([
      { text: 'GAME OVER', size: 48, color: '#ff4466' },
      { text: players.length > 1 ? `Your team reached round ${round}` : `Reached round ${round}`, size: 16, color: '#ccc', weight: 'normal' },
      { gap: 10 },
      { text: `SCORE ${score.toLocaleString()}`, size: 26 },
      { text: newBest ? 'NEW BEST!' : `BEST ${best.toLocaleString()}`, size: 16, color: '#ffd43b' },
      { gap: 20 },
      { text: net.role !== 'solo'
          ? (overT > 1 ? (againAsked ? 'Starting…' : `Next game starts in ${Math.max(1, Math.ceil(AUTO_RESTART - overT))} — everyone stays in`) : '')
          : overT > 1 ? (isTouch ? 'TAP TO PLAY AGAIN' : 'CLICK OR PRESS ENTER') : '', size: 18, color: '#ffe066' },
      { text: updateReady && net.role === 'solo' ? `Update ready: v${latestVersion} installs when you continue` : '', size: 13, color: '#7CFC00', weight: 'normal' },
    ]);
    if (net.role !== 'solo' && overT > 1) {
      // Every phone can restart; the whole room goes in together. LEAVE is small and out of the way.
      uiButton('PLAY AGAIN', sw / 2, sh * 0.85, 190, 46, '#2fa84f', playAgain);
      uiButton('LEAVE', sw - safe.r - 66, sh - safe.b - 30, 100, 36, '#444', () => leaveGame());
    }
  }
}

// ---------------------------------------------------------------- loop
let last = performance.now();
function frame(now) {
  tick(Math.min(0.033, (now - last) / 1000));
  last = now;
  requestAnimationFrame(frame);
}

function tick(dt) {
  const portrait = isTouch && sh > sw;
  if (net.role === 'guest') guestFrame(dt);
  else if (state === 'play' && !paused && !portrait && !window.__freeze) update(dt);
  else if (state === 'over') {
    overT += dt; time += dt; updateFx(dt);
    if (net.role === 'host' && overT > AUTO_RESTART) newGame();
  }
  else if (state === 'shop') {
    time += dt;
    for (const c of shopCards) if (c.flash > 0) c.flash -= dt;
    if (shopMsg && (shopMsg.t -= dt) <= 0) shopMsg = null;
  }
  else time += dt;
  if (net.role === 'host' && (net.sendT -= dt) <= 0) { net.sendT = 0.05; hostBroadcast(); }
  render();
}

// ---------------------------------------------------------------- multiplayer
// One phone hosts and runs the real game; friends join with a 4-letter code. PeerJS (a free
// matchmaking service) only introduces the phones, then they talk to each other directly.
// Each phone moves its own player (so controls feel instant) and the host sends everyone a
// snapshot of the arena 20 times a second, plus a copy of every shot, sound and spark.
const net = { role: 'solo', peer: null, code: '', peers: new Map(), host: null, sendT: 0, inT: 0 };
const MAX_PLAYERS = 4;
const roomId = code => 'arenablitz-room-' + code.toLowerCase();
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
let titleMsg = '', uiButtons = [], uiState = '';

function loadPeerJs() {
  if (window.Peer) return Promise.resolve();
  return new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
    sc.onload = () => window.Peer ? res() : rej(new Error('no Peer'));
    sc.onerror = () => { sc.remove(); rej(new Error('load failed')); };
    document.head.appendChild(sc);
  });
}

// After a team game over the room restarts by itself, or sooner when anyone taps PLAY AGAIN.
const AUTO_RESTART = 10;
let againAsked = false;
function playAgain() {
  if (state !== 'over' || overT <= 1) return;
  if (net.role === 'guest') { if (!againAsked) { againAsked = true; netSend(['again']); } }
  else newGame();
}

function netSend(msg) { if (net.host && net.host.open) net.host.send(msg); }
function sendTo(pid, msg) { for (const g of net.peers.values()) if (g.pid === pid && g.conn.open) g.conn.send(msg); }

// Back to the title screen, closing any connection.
function leaveGame(msg = '', keepPage = false) {
  if (!keepPage) rejoin = null;
  const pr = net.peer;
  net.role = 'solo'; net.peer = null; net.host = null; net.peers.clear(); net.code = '';
  try { if (pr) pr.destroy(); } catch (e) {}
  netOut = null;
  players = []; me = null; boss = null;
  enemies = []; bullets = []; ebullets = []; pickups = []; missiles = []; effects = []; particles = []; texts = [];
  pillars = []; mines = []; warps = []; strikes = []; puddles = [];
  paused = false; banner = null; shake = 0; flash = 0;
  state = 'title'; titleMsg = msg;
  sticks.left = sticks.right = null;
  showJoinBox(false);
  if (updateReady && !keepPage) location.reload();
}

// A guest whose link to the host drops (phone slept, Wi-Fi blipped) rejoins the same room by itself,
// so nobody has to type the code again.
let rejoin = null;   // { code, tries }
const REJOIN_TRIES = 6;
function lostHost() {
  const code = net.code;
  leaveGame(`Connection lost. Rejoining room ${code}…`, true);
  rejoin = { code, tries: 0 };
  setTimeout(tryRejoin, 1000);
}
function tryRejoin() {
  if (!rejoin || state !== 'title' || net.peer) { rejoin = null; return; }   // they moved on (solo, host, join box)
  rejoin.tries++;
  titleMsg = `Rejoining room ${rejoin.code}…`;
  joinGame(rejoin.code);
}
function rejoinFailed(why) {
  if (rejoin && rejoin.tries < REJOIN_TRIES) { setTimeout(tryRejoin, 2500); return true; }
  if (rejoin) { titleMsg = `Couldn't get back into room ${rejoin.code}. ${why}`; rejoin = null; if (updateReady) location.reload(); return true; }
  return false;
}

// ---- hosting
function hostGame() {
  if (net.peer) return;
  titleMsg = 'Opening a room…';
  loadPeerJs().then(() => {
    const code = Array.from({ length: 4 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ'[randi(0, 22)]).join('');
    const peer = new Peer(roomId(code));
    net.peer = peer;
    peer.on('open', () => {
      if (net.peer !== peer) return;
      net.role = 'host'; net.code = code; netOut = [];
      players = [makePlayer(0)]; me = players[0];
      state = 'lobby'; titleMsg = '';
    });
    peer.on('connection', conn => conn.on('open', () => addGuest(conn)));
    peer.on('disconnected', () => { if (net.peer === peer) try { peer.reconnect(); } catch (e) {} });
    peer.on('error', err => {
      if (net.peer !== peer) return;
      if (err.type === 'unavailable-id') { net.peer = null; peer.destroy(); hostGame(); return; }   // code taken: pick another
      if (net.role !== 'host') { net.peer = null; peer.destroy(); titleMsg = `Couldn't open a room (${err.type}). Check your internet.`; }
    });
  }).catch(() => { titleMsg = "Couldn't load multiplayer. Check your internet."; });
}

function addGuest(conn) {
  if (net.role !== 'host') { conn.close(); return; }
  if (players.length >= MAX_PLAYERS) { conn.send(['bye', 'That room is full (4 players max)']); setTimeout(() => conn.close(), 500); return; }
  const pid = [1, 2, 3].find(i => !players.some(o => o.pid === i));
  const p = makePlayer(pid);
  if (state !== 'lobby') {   // jumped in mid-game: sits out until the next round, with some ◆ to catch up
    p.down = true; p.joining = true; p.credits = 15 * round;
    addText(W / 2, H / 2 - 60, `${pname(p)} JOINED! In from the next round`, PCOL[pid].tag, 18, 2.2);
  }
  players.push(p); players.sort((a, b) => a.pid - b.pid);
  net.peers.set(conn.peer, { conn, pid });
  conn.send(['hi', pid, net.code, runningVersion]);
  conn.on('data', d => fromGuest(pid, d));
  const gone = () => dropGuest(conn.peer);
  conn.on('close', gone); conn.on('error', gone);
}

function dropGuest(id) {
  const g = net.peers.get(id);
  if (!g) return;
  net.peers.delete(id);
  const p = players.find(o => o.pid === g.pid);
  players = players.filter(o => o.pid !== g.pid);
  if (p && state === 'play') addText(p.x, p.y - 30, `${pname(p)} LEFT`, '#aaa', 16, 1.6);
  if (state === 'play' && players.every(o => o.down)) gameOver();
  checkAllReady();
}

function fromGuest(pid, d) {
  const p = players.find(o => o.pid === pid);
  if (!p || !Array.isArray(d)) return;
  switch (d[0]) {
    case 'i':   // where they are and where they're aiming
      p.x = clamp(+d[1] || 0, WALL, W - WALL); p.y = clamp(+d[2] || 0, WALL, H - WALL);
      p.ax = d[3] / 100 || 0; p.ay = d[4] / 100 || 0; p.moving = !!d[5]; p.walk = d[6] / 10 || 0;
      break;
    case 'a': useAbility(d[1] | 0, p); break;
    case 'buy': if (state === 'shop') sendTo(pid, ['say', buyFor(p, d[1], d[2])]); break;
    case 'p': if (state === 'play') paused = !paused; break;
    case 'again': playAgain(); break;
  }
}

function hostBroadcast() {
  if (!net.peers.size) { netOut.length = 0; return; }
  const msg = ['s', snapshot()];
  for (const g of net.peers.values()) if (g.conn.open) { try { g.conn.send(msg); } catch (e) {} }
}

function encPlayer(p) {
  return {
    pid: p.pid, x: Math.round(p.x), y: Math.round(p.y), ax: r2(p.ax), ay: r2(p.ay), hp: p.hp, maxHp: p.maxHp, inv: r1(p.inv),
    weapon: p.weapon, weaponT: r1(p.weaponT), weaponMax: p.weaponMax, shield: p.shield, blades: r1(p.blades),
    walk: r1(p.walk), moving: p.moving, muzzle: p.muzzle > 0 ? 0.05 : 0, down: p.down, joining: p.joining, credits: Math.floor(p.credits),
    levels: p.levels, charges: p.charges, gear: p.gear, buffMax: p.buffMax, ready: p.ready, flawless: p.flawless,
    buffs: { shield: r1(p.buffs.shield), drone: r1(p.buffs.drone), gems: r1(p.buffs.gems) },
  };
}

function snapshot() {
  const fx = netOut; netOut = [];
  return {
    st: state, ph: roundPhase, rd: round, sc: score, cb: combo, tw: twist, th: themeIdx, pz: paused, n: nPlayers,
    left: spawnQueue.length + warps.length + enemies.length, bn: banner, df: doors.map(d => r1(d.flash)),
    pl: players.map(encPlayer),
    en: enemies.filter(e => !e.dead).map(e => [e.id, e.type, e.kind || 0, Math.round(e.x), Math.round(e.y), r1(e.r), r1(e.hp), e.maxHp,
      e.hitT > 0 ? 1 : 0, r2(e.face), r1(e.t), r2(e.wob), r1(e.fireT), e.mode || 0, e.entering ? 1 : 0, r2(e.cdx || 0), r2(e.cdy || 0)]),
    eb: ebullets.map(b => [Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy), b.color || 0]),
    mi: missiles.map(m => [Math.round(m.x), Math.round(m.y), r2(m.a), Math.round(m.speed)]),
    ef: effects.map(f => [Math.round(f.x), Math.round(f.y), Math.round(f.r), f.max]),
    pk: pickups.map(k => [k.type, Math.round(k.x), Math.round(k.y), r1(k.life), r1(k.t)]),
    pi: pillars.map(c => [Math.round(c.x), Math.round(c.y), c.r, r2(c.rise)]),
    mn: mines.map(m => [Math.round(m.x), Math.round(m.y), r2(m.fuse), r1(m.t)]),
    wp: warps.map(w => [Math.round(w.x), Math.round(w.y), r2(w.t)]),
    sk: strikes.map(k => [Math.round(k.x), Math.round(k.y), k.r, r2(k.t), k.max, k.color]),
    pd: puddles.map(k => [Math.round(k.x), Math.round(k.y), r1(k.r), r2(k.life), k.max]),
    fx,
  };
}

// ---- joining
function joinGame(code) {
  code = (code || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (code.length !== 4) { joinSay('Enter the 4-letter code from the host'); return; }
  if (net.peer) return;
  joinSay('Connecting…', '#ffe066');
  loadPeerJs().then(() => {
    const peer = new Peer();
    net.peer = peer;
    const timer = setTimeout(() => {
      if (net.peer === peer && net.role !== 'guest') {
        net.peer = null; peer.destroy();
        if (!rejoinFailed('The host may have left.')) joinSay("Couldn't reach that room. Check the code and try again.");
      }
    }, 15000);
    peer.on('open', () => {
      if (net.peer !== peer) return;
      const conn = peer.connect(roomId(code), { reliable: true, serialization: 'json' });
      net.host = conn;
      conn.on('data', d => fromHost(d, code));
      const lost = () => { if (net.host === conn && net.role === 'guest') lostHost(); };
      conn.on('close', lost); conn.on('error', lost);
    });
    peer.on('error', err => {
      if (net.peer !== peer || net.role === 'guest') return;   // once in, only the link to the host matters
      clearTimeout(timer); net.peer = null; peer.destroy();
      if (rejoinFailed(err.type === 'peer-unavailable' ? 'The host may have left.' : 'Check your internet.')) return;
      joinSay(err.type === 'peer-unavailable' ? 'No room with that code. Check it and try again.' : `Couldn't connect (${err.type})`);
    });
  }).catch(() => { if (!rejoinFailed('Check your internet.')) joinSay("Couldn't load multiplayer. Check your internet."); });
}

function fromHost(d, code) {
  if (!Array.isArray(d)) return;
  if (d[0] === 'hi') {
    if (d[3] && runningVersion && d[3] !== runningVersion) {
      leaveGame(`Different game versions (you ${runningVersion}, host ${d[3]}). Reopen the game on both phones to update.`);
      return;
    }
    net.role = 'guest'; net.code = code; netOut = null;
    rejoin = null; titleMsg = '';
    me = makePlayer(d[1]); players = [me];
    state = 'lobby'; showJoinBox(false);
  } else if (d[0] === 'bye') leaveGame(d[1]);
  else if (d[0] === 'say') buyResult(d[1]);
  else if (d[0] === 's' && net.role === 'guest') applySnapshot(d[1]);
}

const MINE_ONLY = ['x', 'y', 'ax', 'ay', 'moving', 'walk'];   // this phone is in charge of these for its own player
function applySnapshot(s) {
  const was = state;
  state = s.st; roundPhase = s.ph; round = s.rd; score = s.sc; combo = s.cb; twist = s.tw; paused = s.pz; nPlayers = s.n;
  enemiesLeft = s.left; banner = s.bn;
  if (s.th !== themeIdx) setTheme(s.th);
  s.df.forEach((f, i) => { doors[i].flash = f; });
  const fresh = state === 'play' && was !== 'play' && was !== 'shop';   // a new game: take the host's starting spot
  players = s.pl.map(o => {
    let p = o.pid === me.pid ? me : players.find(q => q.pid === o.pid);
    if (!p) { p = makePlayer(o.pid); p.x = o.x; p.y = o.y; }
    for (const k in o) {
      if (k === 'pid') continue;
      if (p === me && !fresh && MINE_ONLY.includes(k)) continue;
      if (p !== me && (k === 'x' || k === 'y')) continue;
      p[k] = o[k];
    }
    if (p !== me) { p.tx = o.x; p.ty = o.y; }
    return p;
  });
  const old = new Map(enemies.map(e => [e.id, e]));
  enemies = s.en.map(a => {
    const e = old.get(a[0]) || { id: a[0], x: a[3], y: a[4], kx: 0, ky: 0 };
    [, e.type, e.kind, e.tx, e.ty, e.r, e.hp, e.maxHp, e.hitT, e.face, e.t, e.wob, e.fireT, e.mode, e.entering, e.cdx, e.cdy] = a;
    e.kind = e.kind || undefined; e.mode = e.mode || undefined; e.entering = !!e.entering; e.hitT = e.hitT ? 0.07 : 0;
    e.color = e.type === 'boss' ? (BOSSES.find(b => b.id === e.kind) || BOSSES[0]).color : ETYPES[e.type].color;
    return e;
  });
  boss = enemies.find(e => e.type === 'boss') || null;
  ebullets = s.eb.map(a => ({ x: a[0], y: a[1], vx: a[2], vy: a[3], color: a[4] || undefined, r: 6, life: 5 }));
  missiles = s.mi.map(a => ({ x: a[0], y: a[1], a: a[2], speed: a[3] }));
  effects = s.ef.map(a => ({ x: a[0], y: a[1], r: a[2], max: a[3] }));
  pickups = s.pk.map(a => ({ type: a[0], x: a[1], y: a[2], life: a[3], t: a[4] }));
  pillars = s.pi.map(a => ({ x: a[0], y: a[1], r: a[2], rise: a[3] }));
  mines = s.mn.map(a => ({ x: a[0], y: a[1], fuse: a[2], t: a[3] }));
  warps = s.wp.map(a => ({ x: a[0], y: a[1], t: a[2] }));
  strikes = s.sk.map(a => ({ x: a[0], y: a[1], r: a[2], t: a[3], max: a[4], color: a[5] }));
  puddles = s.pd.map(a => ({ x: a[0], y: a[1], r: a[2], life: a[3], max: a[4] }));
  for (const f of s.fx) replayFx(f);
  if (state !== was) sticks.left = sticks.right = null;
  if (state === 'shop' && was !== 'shop') { shopMsg = null; bullets = []; layoutShop(); }
  if (state !== 'over') againAsked = false;
  if (state === 'over' && was !== 'over') {
    overT = 0; newBest = false;
    if (score > best) { best = score; newBest = true; store.set('arena_best', best); }
  }
}

// Play back what happened on the host: sparks, floating text, sounds, shakes and shots.
function replayFx(f) {
  const mine = pid => pid === -1 || pid === me.pid;
  switch (f[0]) {
    case 'b': burst(f[1], f[2], f[3], f[4], f[5], f[6]); break;
    case 't': addText(f[1], f[2], f[3], f[4], f[5], f[6]); break;
    case 's': if (Sound[f[1]]) Sound[f[1]](...f[2]); break;
    case 'k': if (mine(f[2])) shake = Math.max(shake, f[1]); break;
    case 'f': if (mine(f[3])) { flash = f[1]; flashColor = f[2]; } break;
    case 'v': if (mine(f[2])) vibrate(f[1]); break;
    case 'B': bullets.push({ x: f[1], y: f[2], vx: f[3], vy: f[4], pierce: f[5], color: f[6], life: f[7], r: f[8], hits: null }); break;
  }
}

// A guest's frame: move yourself, tell the host, and smoothly animate everything else between snapshots.
function guestFrame(dt) {
  time += dt;
  const playing = state === 'play' && !paused;
  if (playing && !(isTouch && sh > sw)) moveLocal(me, dt);
  if (state === 'play' && (net.inT -= dt) <= 0) {
    net.inT = 1 / 30;
    netSend(['i', Math.round(me.x), Math.round(me.y), Math.round(me.ax * 100), Math.round(me.ay * 100), me.moving ? 1 : 0, Math.round(me.walk * 10)]);
  }
  if (state === 'over') overT += dt;
  if (state === 'shop') {
    for (const c of shopCards) if (c.flash > 0) c.flash -= dt;
    if (shopMsg && (shopMsg.t -= dt) <= 0) shopMsg = null;
  }
  updateFx(dt);
  for (let i = 0; i < btnPress.length; i++) if (btnPress[i] > 0) btnPress[i] -= dt;
  if (!playing) return;
  const k = Math.min(1, dt * 14);
  for (const p of players) {
    p.drone.a += dt * 2.2;
    if (p.blades > 0) p.bladeA += dt * 7;
    if (p === me) continue;
    if (p.tx !== undefined) { p.x += (p.tx - p.x) * k; p.y += (p.ty - p.y) * k; }
    if (p.moving) p.walk += dt * 13;
  }
  for (const e of enemies) { e.x += (e.tx - e.x) * k; e.y += (e.ty - e.y) * k; e.t += dt; if (e.hitT > 0) e.hitT -= dt; }
  for (const b of ebullets) { b.x += b.vx * dt; b.y += b.vy * dt; }
  for (const m of missiles) {
    m.x += Math.cos(m.a) * m.speed * dt; m.y += Math.sin(m.a) * m.speed * dt;
    particles.push({ x: m.x, y: m.y, vx: rand(-20, 20), vy: rand(-20, 20), life: 0.3, max: 0.3, color: '#9be7ff', size: 3 });
  }
  for (const f of effects) f.r = Math.min(f.max, f.r + 1050 * dt);
  for (const pk of pickups) { pk.t += dt; pk.life -= dt; }
  for (const m of mines) m.t += dt;
  for (const w of warps) w.t -= dt;
  for (const st of strikes) st.t = Math.max(0, st.t - dt);
  for (const pd of puddles) pd.life -= dt;
  for (const c of pillars) c.rise = Math.min(1, c.rise + dt * 3);
  for (const d of doors) d.flash = Math.max(0, d.flash - dt);
  // our copy of everyone's shots is just for show; the host decides what they hit
  for (const b of bullets) {
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    if (b.life <= 0 || !inArena(b.x, b.y) || inPillar(b.x, b.y)) { b.dead = true; continue; }
    for (const e of enemies) {
      if (d2(e.x, e.y, b.x, b.y) >= (e.r + b.r) ** 2 || (b.hits && b.hits.includes(e))) continue;
      if (b.pierce > 0) { b.pierce--; (b.hits || (b.hits = [])).push(e); } else { b.dead = true; break; }
    }
  }
  bullets = bullets.filter(b => !b.dead);
}

// ---- the join screen is a real text box, so phones bring up their keyboard
const joinBox = document.createElement('div');
joinBox.style.cssText = 'position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(8,6,16,0.9);' +
  'z-index:5;font-family:system-ui,sans-serif;color:#fff;text-align:center';
const jbtn = bg => `font:bold 17px system-ui,sans-serif;color:#fff;background:${bg};border:2px solid rgba(255,255,255,0.35);border-radius:12px;padding:10px 22px`;
joinBox.innerHTML = `<div style="padding:20px;max-width:360px">
  <div style="font-weight:bold;font-size:22px;color:#ffe066;margin-bottom:6px">JOIN A FRIEND</div>
  <div style="font-size:14px;color:#ccc;margin-bottom:14px">Type the 4-letter code on the host's screen</div>
  <input id="joinCode" maxlength="4" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false"
    style="font:bold 32px system-ui,sans-serif;width:160px;text-align:center;letter-spacing:8px;text-transform:uppercase;padding:8px;
    border-radius:10px;border:2px solid #33ccff;background:#17142a;color:#fff;-webkit-user-select:text;user-select:text">
  <div style="margin-top:14px;display:flex;gap:10px;justify-content:center">
    <button id="joinGo" style="${jbtn('#2fa84f')}">JOIN</button><button id="joinBack" style="${jbtn('#444')}">BACK</button>
  </div>
  <div id="joinMsg" style="margin-top:12px;font-size:14px;min-height:18px"></div></div>`;
document.body.appendChild(joinBox);
const joinInput = joinBox.querySelector('#joinCode'), joinMsgEl = joinBox.querySelector('#joinMsg');
joinBox.querySelector('#joinGo').onclick = () => joinGame(joinInput.value);
joinBox.querySelector('#joinBack').onclick = () => leaveGame();
joinInput.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') joinGame(joinInput.value); });
function joinSay(t, color = '#ff6b6b') { joinMsgEl.textContent = t; joinMsgEl.style.color = color; }
function showJoinBox(on) {
  joinBox.style.display = on ? 'flex' : 'none';
  if (on) { joinSay(''); joinInput.value = ''; setTimeout(() => joinInput.focus(), 50); } else joinInput.blur();
}

// Buttons drawn on the canvas (title, lobby, pause, game over). Rebuilt every frame.
function uiButton(text, cx, cy, w, h, color, action) {
  const x = cx - w / 2, y = cy - h / 2;
  ctx.fillStyle = color; rrect(x, y, w, h, 12); ctx.fill();
  outline('rgba(255,255,255,0.35)', 2);
  label(text, cx, cy, Math.min(18, w / 7), '#fff', 'center');
  uiButtons.push({ x, y, w, h, action });
}

function drawTitle() {
  ctx.fillStyle = 'rgba(8,6,16,0.72)'; ctx.fillRect(0, 0, sw, sh);
  const cx = sw / 2;
  label('ARENA BLITZ', cx, sh * 0.15, Math.min(56, sw / 11), '#ff3df0', 'center');
  label('Survive the arena. Blast everything.', cx, sh * 0.15 + 36, 15, '#9be7ff', 'center', 'normal');
  const bw = Math.min(190, (sw - safe.l - safe.r - 60) / 3), by = sh * 0.4;
  uiButton('PLAY SOLO', cx - bw - 12, by, bw, 52, '#2fa84f', () => { goFullscreen(); newGame(); });
  uiButton('HOST GAME', cx, by, bw, 52, '#2563c9', () => { goFullscreen(); hostGame(); });
  uiButton('JOIN GAME', cx + bw + 12, by, bw, 52, '#8a3ccc', () => { goFullscreen(); titleMsg = ''; state = 'join'; showJoinBox(true); });
  if (titleMsg) label(titleMsg, cx, by + 44, 14, titleMsg.endsWith('…') ? '#ffe066' : '#ff6b6b', 'center');
  const lines = [
    isTouch ? 'Left thumb: move  ·  Right thumb: aim  ·  Gun fires automatically' : 'WASD: move  ·  Mouse / Arrows: aim  ·  Gun fires automatically',
    isTouch ? 'Tap BLAST · MISSILES · BLADES for power attacks — they recharge every round' : '1 / 2 / 3 (or Q / E / R): power attacks — they recharge every round',
    'Earn ◆ from kills and clean rounds — spend them in the upgrade shop every 2 rounds',
    'Play with up to 3 friends: one phone taps HOST GAME, the others JOIN with its code',
  ];
  lines.forEach((t, i) => label(t, cx, sh * 0.6 + i * 20, 13, i === 2 ? '#4dfff0' : '#ccc', 'center', 'normal'));
  if (best) label(`BEST ${best.toLocaleString()}`, cx, sh * 0.6 + lines.length * 20 + 14, 14, '#ffd43b', 'center');
  if (runningVersion) label(`v${runningVersion}`, safe.l + 12, sh - safe.b - 14, 12, 'rgba(255,255,255,0.45)', 'left', 'normal');
}

function drawLobby() {
  ctx.fillStyle = 'rgba(8,6,16,0.8)'; ctx.fillRect(0, 0, sw, sh);
  const cx = sw / 2, host = net.role === 'host';
  if (host) {
    label('ROOM CODE', cx, sh * 0.13, 15, '#9be7ff', 'center');
    label(net.code, cx, sh * 0.13 + 40, 48, '#ffe066', 'center');
    label('Friends tap JOIN GAME and type this code', cx, sh * 0.13 + 78, 14, '#ccc', 'center', 'normal');
  } else {
    label(`ROOM ${net.code}`, cx, sh * 0.16, 30, '#ffe066', 'center');
    label('Waiting for the host to start…', cx, sh * 0.16 + 36, 15, '#ccc', 'center', 'normal');
  }
  const gap = Math.min(150, (sw - 40) / Math.max(1, players.length)), y = sh * 0.5;
  players.forEach((p, i) => {
    const x = cx + (i - (players.length - 1) / 2) * gap;
    circle(x, y - 6, 16, PCOL[p.pid].main);
    label(pname(p) + (p === me ? ' (you)' : ''), x, y + 24, 14, PCOL[p.pid].tag, 'center');
  });
  label(players.length > 1 ? 'More players = more enemies and a tougher boss' : 'Waiting for friends to join (you can also start alone)',
    cx, y + 52, 13, 'rgba(255,255,255,0.6)', 'center', 'normal');
  if (host) {
    uiButton('START', cx - 85, sh * 0.8, 150, 50, '#2fa84f', () => newGame());
    uiButton('BACK', cx + 85, sh * 0.8, 150, 50, '#444', () => leaveGame());
  } else uiButton('LEAVE', cx, sh * 0.8, 150, 50, '#444', () => leaveGame());
}

function togglePause() {
  sticks.left = sticks.right = null;
  if (net.role === 'guest') netSend(['p']);
  else paused = !paused;
}

// ---------------------------------------------------------------- version & auto-update
// version.json is the one place the version number and release notes live.
let release = null, runningVersion = null, latestVersion = null, updateReady = false;
function checkVersion() {
  fetch('version.json', { cache: 'no-store' }).then(r => r.json()).then(v => {
    latestVersion = v.version;
    if (!runningVersion) {
      runningVersion = v.version;
      release = v.releases && v.releases[0];
      if (state === 'title' && release) state = 'notes';
    } else if (v.version !== runningVersion) {
      updateReady = true;
      // Never reload in the middle of a run: wait for the title screen or game over.
      if (state === 'title' || state === 'notes') location.reload();
    }
  }).catch(() => {});
}
checkVersion();
setInterval(checkVersion, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });

resize();
requestAnimationFrame(frame);

// small hook for automated testing in a browser console
window.__arena = { get state() { return state; }, get round() { return round; }, get score() { return score; },
  get enemies() { return enemies.length; }, get enemyList() { return enemies; }, get player() { return me; }, get players() { return players; }, startRound, useAbility, newGame,
  get credits() { return me.credits; }, set credits(v) { me.credits = v; }, get levels() { return me.levels; }, get net() { return net; },
  set round(v) { round = v; }, openShop, get twist() { return twist; }, set nextTwist(v) { forcedTwist = v; },
  get pillars() { return pillars; }, get boss() { return boss; }, setTheme, get mines() { return mines; }, step: dt => { if (state === 'play') update(dt); }, tick, hostGame, joinGame, spawn: (type, x, y) => enemies.push(makeEnemy(type, x, y)) };
})();
