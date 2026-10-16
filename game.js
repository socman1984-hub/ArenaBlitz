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
  tone(f, dur, type = 'square', vol = 0.05, f2 = null) {
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
    this.tone(rand(820, 900), 0.05, 'square', 0.012, 300);
  },
  hit() { this.tone(rand(180, 240), 0.05, 'square', 0.02, 90); },
  boom(big) {
    const now = performance.now();
    if (!big && now - this.lastBoom < 40) return;
    this.lastBoom = now;
    this.noise(big ? 0.9 : 0.25, big ? 0.35 : 0.1, big ? 2200 : 900);
  },
  hurt() { this.tone(220, 0.3, 'sawtooth', 0.08, 50); },
  pickup() { this.tone(660, 0.08, 'square', 0.04); setTimeout(() => this.tone(990, 0.1, 'square', 0.04), 70); },
  power() { this.tone(160, 0.45, 'sawtooth', 0.06, 1400); },
  denied() { this.tone(110, 0.12, 'square', 0.04); },
  jingle(notes, gap = 110) { notes.forEach((f, i) => setTimeout(() => this.tone(f, 0.16, 'square', 0.045), i * gap)); },
};

// ---------------------------------------------------------------- data
const WEAPONS = {
  basic:  { name: 'BLASTER', rate: 0.12, count: 1, arc: 0,    jitter: 0.03, dmg: 1 },
  rapid:  { name: 'RAPID',   rate: 0.05, count: 1, arc: 0,    jitter: 0.09, dmg: 1 },
  spread: { name: 'SPREAD',  rate: 0.14, count: 5, arc: 0.65, jitter: 0.02, dmg: 1 },
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
  { id: 'damage',   icon: '💥', name: 'FIREPOWER',      desc: '+25% bullet damage',        max: 5, cost: 25, step: 20 },
  { id: 'rate',     icon: '⚡', name: 'TRIGGER FINGER', desc: '+15% fire rate',            max: 5, cost: 25, step: 20 },
  { id: 'multi',    icon: '🔱', name: 'MULTI-SHOT',     desc: '+1 bullet per shot',        max: 3, cost: 50, step: 40 },
  { id: 'pierce',   icon: '🎯', name: 'PIERCING',       desc: 'Bullets pass through +1',   max: 3, cost: 40, step: 35 },
  { id: 'speed',    icon: '👟', name: 'SPEED BOOTS',    desc: '+10% move speed',           max: 4, cost: 20, step: 15 },
  { id: 'hp',       icon: '🛡️', name: 'ARMOR',          desc: '+1 max heart',              max: 4, cost: 35, step: 25 },
  { id: 'blast',    icon: '💣', name: 'EXTRA BLAST',    desc: '+1 BLAST each round',       max: 2, cost: 50, step: 40 },
  { id: 'missiles', icon: '🚀', name: 'MISSILE PODS',   desc: '+6 missiles per volley',    max: 3, cost: 30, step: 25 },
  { id: 'blades',   icon: '🌀', name: 'BLADE MASTER',   desc: '+1 blade, +2s spin time',   max: 3, cost: 30, step: 25 },
  { id: 'magnet',   icon: '🧲', name: 'MAGNET',         desc: 'Pull pickups, +50% drops',  max: 2, cost: 25, step: 25 },
];

const ABILITIES = [
  { id: 'blast',    name: 'BLAST',    max: 1, color: '#ff5533', keys: ['1', 'q', ' '] },
  { id: 'missiles', name: 'MISSILES', max: 2, color: '#33ccff', keys: ['2', 'e'] },
  { id: 'blades',   name: 'BLADES',   max: 1, color: '#cc66ff', keys: ['3', 'r'] },
];

const PICKUPS = {
  heart:  { color: '#ff4466', label: '♥', name: '+1 LIFE' },
  rapid:  { color: '#ff9f1a', label: 'R', name: 'RAPID FIRE!' },
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
let player, bullets, ebullets, enemies, particles, pickups, texts, missiles, effects, boss;
let round = 0, score = 0, combo = 0, comboT = 0;
let spawnQueue = [], spawnT = 0, roundPhase = 'intro', phaseT = 0;
let shake = 0, flash = 0, flashColor = '255,255,255', time = 0, overT = 0;
let banner = null;
let charges = [0, 0, 0];
let best = store.get('arena_best', 0);
let newBest = false;
let credits = 0, levels = {}, flawless = true;
let shopCards = [], shopMsg = null;
let twist = null, lastTwist = null, forcedTwist = null, lastLayout = null, themeIdx = 0;
let pillars = [], mines = [], warps = [], strikes = [], puddles = [], seen = new Set();

const lvl = id => levels[id] || 0;
const upgradeCost = u => u.cost + u.step * lvl(u.id);
const healCost = () => 15 + round * 2;

function newGame() {
  player = {
    x: W / 2, y: H / 2, r: 13, hp: 5, maxHp: 5, inv: 0,
    fireT: 0, weapon: 'basic', weaponT: 0, ax: 1, ay: 0,
    blades: 0, bladeA: 0, walk: 0, muzzle: 0, moving: false,
  };
  credits = 0; levels = {};
  bullets = []; ebullets = []; enemies = []; particles = [];
  pickups = []; texts = []; missiles = []; effects = [];
  pillars = []; mines = []; warps = [];
  boss = null;
  twist = lastTwist = lastLayout = null; seen = new Set(['grunt']);
  score = 0; combo = 0; comboT = 0; shake = 0; flash = 0;
  newBest = false;
  state = 'play'; paused = false;
  startRound(1);
}

function startRound(n) {
  round = n;
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
  flawless = true;
  charges = ABILITIES.map(a => a.max + (a.id === 'blast' ? lvl('blast') : 0));
  const fresh = [...new Set(spawnQueue)].filter(t => INTRO[t] && !seen.has(t));
  fresh.forEach(t => seen.add(t));
  if (fresh.length) notes.push('NEW ENEMY: ' + fresh.map(t => INTRO[t]).join(', '));
  const tw = twist && TWISTS[twist];
  showBanner(`ROUND ${n}`, isBoss ? `BOSS: ${bossDef().name}! ${bossDef().hint}` : tw ? `${tw.name}: ${tw.hint}` : 'POWERS RECHARGED. FIGHT!',
    notes.join('   ·   '), isBoss ? bossDef().color : tw ? tw.color : '#fff');
  if (isBoss) Sound.jingle([196, 185, 175, 165], 160);
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
  if (player) pushOutOfPillars(player, player.r);
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
  for (let i = 0; i < count; i++) q.push(weighted(pool));
  if (n === 3) q.splice(q.length >> 1, 0, 'tank');   // first taste of a big guy
  if (isBoss) q.unshift('boss');
  return q;
}

function showBanner(title, sub, note = '', color = '#fff') { banner = { title, sub, note, color, t: note ? 3.4 : 2.6 }; }

// ---------------------------------------------------------------- entities
function makeEnemy(type, x, y) {
  const d = ETYPES[type];
  const hpMul = 1 + (round - 1) * 0.1;
  const spMul = Math.min(1.6, 1 + (round - 1) * 0.03) * (twist === 'overdrive' ? 1.3 : 1);
  const e = {
    type, x, y, r: d.r * SPR, color: d.color, score: d.score, cr: d.cr,
    hp: Math.ceil(d.hp * hpMul), maxHp: 0,
    speed: d.speed * spMul * rand(0.9, 1.1),
    kx: 0, ky: 0, hitT: 0, bladeCD: 0, t: rand(0, 10), wob: rand(0, Math.PI * 2),
    fireT: rand(1, 2.5), entering: false, dnx: 0, dny: 0, dead: false, face: 0,
  };
  if (type === 'boss') {
    const bd = bossDef();
    e.kind = bd.id; e.color = bd.color;
    e.hp = Math.round(260 + round * 45);
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
  for (let i = 0; i < n; i++) {
    const a = rand(0, Math.PI * 2), s = rand(0.2, 1) * spd;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.3, 0.8), max: 0.8, color, size: rand(size * 0.5, size * 1.4) });
  }
  if (particles.length > 700) particles.splice(0, particles.length - 700);
}

function addText(x, y, text, color = '#fff', size = 14, life = 0.8) {
  texts.push({ x, y, text, color, size, life, max: life });
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
  credits += e.cr * (twist === 'cash' ? 2 : 1);
  if (e.type === 'boss') {
    burst(e.x, e.y, e.color, 90, 450, 7);
    burst(e.x, e.y, '#fff', 40, 300, 5);
    shake = Math.max(shake, 28); flash = 0.7; flashColor = '255,255,255';
    Sound.boom(true); vibrate(200);
    for (let i = 0; i < 6; i++) dropPickup(e.x + rand(-60, 60), e.y + rand(-60, 60), true);
    addText(e.x, e.y - 60, '+' + pts, '#ffd43b', 28, 1.6);
    boss = null;
    strikes = []; puddles = [];
    for (const o of enemies) if (!o.dead && o.type !== 'boss') killEnemy(o);
  } else {
    burst(e.x, e.y, e.color, e.r > 18 ? 22 : 12, 220);
    Sound.boom(false);
    shake = Math.max(shake, e.r > 18 ? 6 : 2);
    addText(e.x, e.y - e.r, '+' + pts, comboMult() > 1 ? '#ffd43b' : '#fff', 12, 0.6);
    if (Math.random() < 0.075 * (1 + 0.5 * lvl('magnet'))) dropPickup(e.x, e.y);
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
  const pool = [['rapid', 3], ['spread', 3], ['charge', 2.5], ['coin', rich ? 6 : 3]];
  if (player.hp < player.maxHp) pool.push(['heart', rich ? 4 : 2]);
  const pk = { type: type || weighted(pool), x: clamp(x, WALL + 20, W - WALL - 20), y: clamp(y, WALL + 20, H - WALL - 20), life: 9, t: 0 };
  pushOutOfPillars(pk, 16);
  pickups.push(pk);
}

function collect(p) {
  const def = PICKUPS[p.type];
  Sound.pickup();
  let label = def.name;
  switch (p.type) {
    case 'heart': player.hp = Math.min(player.maxHp, player.hp + 1); break;
    case 'rapid': case 'spread': player.weapon = p.type; player.weaponT = 10; break;
    case 'coin': credits += 10; break;
    case 'charge': {
      const i = randi(0, ABILITIES.length - 1);
      charges[i]++;
      label = '+1 ' + ABILITIES[i].name;
      break;
    }
  }
  addText(p.x, p.y - 16, label, def.color, 15, 1.1);
}

function hurtPlayer() {
  if (player.inv > 0 || state !== 'play') return;
  player.hp--;
  player.inv = 1.6;
  flawless = false;
  shake = Math.max(shake, 14); flash = 0.35; flashColor = '255,40,60';
  combo = 0;
  Sound.hurt(); vibrate(90);
  burst(player.x, player.y, '#3a8dff', 16, 200);
  for (const e of enemies) {
    if (e.type === 'boss') continue;
    const dx = e.x - player.x, dy = e.y - player.y, dd = Math.hypot(dx, dy) || 1;
    if (dd < 140) { e.kx += dx / dd * 420; e.ky += dy / dd * 420; }
  }
  if (player.hp <= 0) gameOver();
}

function gameOver() {
  state = 'over'; overT = 0;
  burst(player.x, player.y, '#3a8dff', 60, 350, 6);
  burst(player.x, player.y, '#ffd3a0', 30, 250, 5);
  Sound.boom(true);
  Sound.jingle([392, 330, 262, 196], 180);
  vibrate([100, 60, 200]);
  if (score > best) { best = score; newBest = true; store.set('arena_best', best); }
  sticks.left = sticks.right = null;
}

// ---------------------------------------------------------------- abilities
function useAbility(i) {
  if (state !== 'play' || paused) return;
  if (charges[i] <= 0) { Sound.denied(); return; }
  charges[i]--;
  btnPress[i] = 0.15;
  const id = ABILITIES[i].id;
  if (id === 'blast') {
    effects.push({ x: player.x, y: player.y, r: 10, max: 480, hit: new Set() });
    shake = Math.max(shake, 22); flash = 0.4; flashColor = '255,140,60';
    Sound.boom(true); Sound.power(); vibrate(120);
    addText(player.x, player.y - 30, 'BLAST!', '#ff5533', 22, 1);
  } else if (id === 'missiles') {
    const base = Math.atan2(player.ay, player.ax);
    const n = 14 + 6 * lvl('missiles');
    for (let k = 0; k < n; k++) {
      const a = base + (k / (n - 1) - 0.5) * Math.PI * 1.7;
      missiles.push({ x: player.x, y: player.y, a, speed: 220, target: null, life: 3.5 });
    }
    Sound.power(); vibrate(60);
    addText(player.x, player.y - 30, 'MISSILES!', '#33ccff', 22, 1);
  } else if (id === 'blades') {
    player.blades = 8 + 2 * lvl('blades');
    Sound.power(); vibrate(60);
    addText(player.x, player.y - 30, 'BLADES!', '#cc66ff', 22, 1);
  }
}

// ---------------------------------------------------------------- upgrade shop
function openShop() {
  state = 'shop';
  shopMsg = null;
  sticks.left = sticks.right = null;
  bullets.length = 0; missiles.length = 0;
  layoutShop();
  Sound.jingle([392, 523, 659, 784, 659, 784], 90);
}

function layoutShop() {
  const items = [...UPGRADES.map(u => ({ kind: 'up', u })), { kind: 'heal' }, { kind: 'go' }];
  const cols = sw - safe.l - safe.r >= 560 ? 4 : 3, rows = Math.ceil(items.length / cols);
  const top = safe.t + 60, pad = 10, gap = 8;
  const aw = sw - safe.l - safe.r;
  const cw = Math.min(220, (aw - pad * 2 - gap * (cols - 1)) / cols);
  const ch = Math.min(100, (sh - safe.b - top - pad - gap * (rows - 1)) / rows);
  const x0 = safe.l + (aw - (cw * cols + gap * (cols - 1))) / 2;
  shopCards = items.map((it, i) => ({
    ...it, flash: 0,
    x: x0 + (i % cols) * (cw + gap), y: top + Math.floor(i / cols) * (ch + gap), w: cw, h: ch,
  }));
}

function shopSay(text, color = '#ff6b6b') { shopMsg = { text, color, t: 1.6 }; }

function buy(c) {
  if (c.kind === 'go') { state = 'play'; startRound(round + 1); return; }
  if (c.kind === 'heal') {
    if (player.hp >= player.maxHp) { shopSay('Already at full health'); Sound.denied(); return; }
    if (credits < healCost()) { shopSay('Not enough ◆'); Sound.denied(); return; }
    credits -= healCost();
    player.hp = player.maxHp;
  } else {
    const u = c.u;
    if (lvl(u.id) >= u.max) { shopSay('Already maxed out'); Sound.denied(); return; }
    if (credits < upgradeCost(u)) { shopSay('Not enough ◆'); Sound.denied(); return; }
    credits -= upgradeCost(u);
    levels[u.id] = lvl(u.id) + 1;
    if (u.id === 'hp') { player.maxHp++; player.hp++; }
    shopSay(`${u.name} → LEVEL ${lvl(u.id)}`, '#7CFC00');
  }
  c.flash = 0.35;
  Sound.pickup();
  vibrate(30);
}

function explode(x, y, radius, dmg) {
  burst(x, y, '#ffb347', 10, 200, 4);
  burst(x, y, '#fff', 4, 120, 3);
  Sound.boom(false);
  shake = Math.max(shake, 4);
  const rr = radius * radius;
  for (const e of enemies) {
    if (!e.dead && d2(e.x, e.y, x, y) < rr + e.r * e.r) damage(e, dmg, e.x - x, e.y - y, 1.2);
  }
}

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
    if (d2(x, y, player.x, player.y) > minDist * minDist && !inPillar(x, y, 30)) return { x, y };
  }
  return { x: W - player.x, y: H - player.y };
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
      let trip = d2(m.x, m.y, player.x, player.y) < (player.r + 12) ** 2;
      if (!trip) for (const e of enemies) if (!e.dead && !e.entering && d2(m.x, m.y, e.x, e.y) < (e.r + 10) ** 2) { trip = true; break; }
      if (!trip) for (const b of bullets) if (!b.dead && d2(m.x, m.y, b.x, b.y) < 16 * 16) { trip = true; b.dead = true; break; }
      if (trip) { m.fuse = 0.45; Sound.tone(880, 0.08, 'square', 0.04); }
    } else if ((m.fuse -= dt) <= 0) {
      m.dead = true;
      explode(m.x, m.y, 80, 10);
      burst(m.x, m.y, '#ff9f1a', 24, 320, 5);
      shake = Math.max(shake, 10);
      if (d2(m.x, m.y, player.x, player.y) < 70 * 70) hurtPlayer();
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
  if (state === 'notes') { state = 'title'; return true; }
  if (state === 'title') { goFullscreen(); newGame(); return true; }
  if (state === 'over') { if (overT > 1) { if (updateReady) location.reload(); else newGame(); } return true; }
  if (state === 'shop') {
    for (const c of shopCards) {
      if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) { buy(c); break; }
    }
    return true;
  }
  if (hitBtn(muteBtn, x, y)) { Sound.muted = !Sound.muted; store.set('arena_muted', Sound.muted); return true; }
  if (hitBtn(pauseBtn, x, y)) { paused = !paused; sticks.left = sticks.right = null; return true; }
  if (paused) { paused = false; return true; }
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
  if (state === 'over' && (k === 'enter' || k === ' ') && overT > 1) { if (updateReady) location.reload(); else newGame(); return; }
  if (state === 'shop' && k === 'enter') { buy(shopCards[shopCards.length - 1]); return; }
  if (state !== 'play') return;
  if (k === 'p' || k === 'escape') { paused = !paused; return; }
  if (k === 'm') { Sound.muted = !Sound.muted; store.set('arena_muted', Sound.muted); return; }
  if (e.repeat) return;
  ABILITIES.forEach((a, i) => { if (a.keys.includes(k)) useAbility(i); });
  if (k === ' ' || k.startsWith('arrow')) e.preventDefault();
});
window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'play') { paused = true; sticks.left = sticks.right = null; }
});

// ---------------------------------------------------------------- update
function update(dt) {
  time += dt;
  updateRound(dt);
  updatePlayer(dt);
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
    if (phaseT <= 0) roundPhase = 'fight';
  } else if (roundPhase === 'fight') {
    spawnT -= dt;
    const cap = 30 + round * 3;
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
      spawnT = Math.max(0.55, 2.0 - round * 0.08);
    }
    if (!spawnQueue.length && !warps.length && enemies.length === 0) {
      roundPhase = 'clear'; phaseT = 3.2;
      for (const m of mines) burst(m.x, m.y, '#888', 6, 80, 3);   // leftover mines fizzle out
      mines = []; strikes = []; puddles = [];
      const bonus = round * 1000;
      const crBonus = 8 + round * 2 + (flawless ? 10 : 0);
      score += bonus;
      credits += crBonus;
      ebullets.length = 0;
      const shopNext = round % SHOP_EVERY === 0;
      showBanner(`ROUND ${round} CLEAR!`,
        `+${crBonus} ◆${flawless ? '  FLAWLESS!' : ''}${shopNext ? '  ·  UPGRADE SHOP OPEN' : ''}`);
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

function updatePlayer(dt) {
  const p = player;
  // movement
  let mx = 0, my = 0;
  if (keys['w']) my -= 1;
  if (keys['s']) my += 1;
  if (keys['a']) mx -= 1;
  if (keys['d']) mx += 1;
  if (sticks.left) { mx = sticks.left.vx; my = sticks.left.vy; }
  const ml = Math.hypot(mx, my);
  if (ml > 1) { mx /= ml; my /= ml; }
  p.moving = ml > 0.12;
  if (p.moving) {
    const spd = 235 * (1 + 0.1 * lvl('speed'));
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

  // always shooting
  if (p.weaponT > 0) { p.weaponT -= dt; if (p.weaponT <= 0) p.weapon = 'basic'; }
  const w = WEAPONS[twist === 'overdrive' && p.weapon === 'basic' ? 'rapid' : p.weapon];
  const count = w.count + lvl('multi'), arc = w.arc + lvl('multi') * 0.14;
  const dmg = w.dmg * (1 + 0.25 * lvl('damage'));
  p.fireT -= dt;
  while (p.fireT <= 0) {
    const base = Math.atan2(p.ay, p.ax);
    for (let k = 0; k < count; k++) {
      const a = base + (count > 1 ? (k / (count - 1) - 0.5) * arc : 0) + rand(-w.jitter, w.jitter);
      bullets.push({
        x: p.x + Math.cos(base) * 14, y: p.y - 2 + Math.sin(base) * 14,   // close in, so huggers still get hit
        vx: Math.cos(a) * 640, vy: Math.sin(a) * 640, r: 7, dmg, life: 1.2,
        pierce: lvl('pierce'), hits: null,
      });
    }
    p.fireT += w.rate / (1 + 0.15 * lvl('rate'));
    p.muzzle = 0.05;
    Sound.shot();
  }
  if (p.muzzle > 0) p.muzzle -= dt;
  if (p.inv > 0) p.inv -= dt;
}

function updateEnemies(dt) {
  const p = player;
  for (const e of enemies) {
    if (e.dead) continue;
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

    if (d2(e.x, e.y, p.x, p.y) < (e.r / SPR + p.r - 3) ** 2) hurtPlayer();   // touch range uses the un-enlarged size, to stay forgiving
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
    for (let k = 0; k < n; k++) addStrike(player.x + (k ? rand(-110, 110) : 0), player.y + (k ? rand(-90, 90) : 0), 46, 1.1, '#7cfc00', true);
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
      shake = Math.max(shake, 16); Sound.boom(true); vibrate(80);
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
    addStrike(player.x, player.y, 58, 1.3, '#ff6a1a');
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
    Sound.boom(false); shake = Math.max(shake, 6);
    if (d2(st.x, st.y, player.x, player.y) < (st.r + player.r * 0.5) ** 2) hurtPlayer();
    if (st.puddle) puddles.push({ x: st.x, y: st.y, r: st.r * 0.8, life: 4, max: 4 });
  }
  strikes = strikes.filter(st => !st.dead);
  for (const pd of puddles) {
    pd.life -= dt;
    if (pd.life > 0.5 && d2(pd.x, pd.y, player.x, player.y) < (pd.r * 0.8) ** 2) hurtPlayer();
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

  const p = player;
  for (const b of ebullets) {
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    if (b.life <= 0 || !inArena(b.x, b.y, -4) || inPillar(b.x, b.y)) { b.dead = true; continue; }
    const rr = b.r + p.r - 4;
    if (d2(p.x, p.y, b.x, b.y) < rr * rr && p.inv <= 0) { b.dead = true; hurtPlayer(); }
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
  const p = player;
  if (p.blades > 0) {
    p.blades -= dt;
    p.bladeA += dt * 7;
    const nb = 4 + lvl('blades');
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
  const p = player;
  const magnetR = 110 * lvl('magnet');
  for (const pk of pickups) {
    pk.life -= dt; pk.t += dt;
    const dx = p.x - pk.x, dy = p.y - pk.y, dd = Math.hypot(dx, dy) || 1;
    if (roundPhase === 'clear') {   // vacuum up leftovers between rounds
      pk.x += dx / dd * 500 * dt; pk.y += dy / dd * 500 * dt;
      pk.life = Math.max(pk.life, 1);
    } else if (dd < magnetR) {
      pk.x += dx / dd * 380 * dt; pk.y += dy / dd * 380 * dt;
    }
    if (d2(p.x, p.y, pk.x, pk.y) < (p.r + 16) ** 2) { collect(pk); pk.dead = true; }
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
  const face = player.x < e.x ? -1 : 1;
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
    const a = Math.atan2(player.y - e.y, player.x - e.x), ex = Math.cos(a) * 4, ey = Math.sin(a) * 3;
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
    const a = Math.atan2(player.y - e.y, player.x - e.x), lx = Math.cos(a) * 1.4, ly = Math.sin(a) * 1.4;
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
  ctx.save(); ctx.translate(e.x, e.y); ctx.rotate(Math.atan2(player.y - e.y, player.x - e.x));
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
  const a = Math.atan2(player.y - e.y, player.x - e.x);
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
      const a = Math.atan2(player.y - e.y, player.x - e.x);
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
    const a = Math.atan2(player.y - e.y, player.x - e.x);
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
function drawPlayerGun(a) {
  ctx.save(); ctx.translate(0, -2); ctx.rotate(a);
  if (Math.cos(a) < 0) ctx.scale(1, -1);   // keep the gun right side up when aiming left
  ctx.fillStyle = '#1f5fbf'; rrect(0, -3, 9, 6, 3); ctx.fill();
  ctx.fillStyle = '#3a3f4a'; rrect(6, -3.5, 17, 7, 2); ctx.fill();
  ctx.fillStyle = '#6b7280'; ctx.fillRect(9, -3.5, 11, 2);
  ctx.fillStyle = '#9aa3b2'; ctx.fillRect(21, -2, 6, 4);
  ctx.fillStyle = '#2a2d33'; ctx.fillRect(11, 3, 4, 4);
  circle(8, 0.5, 3, '#222');
  ctx.fillStyle = '#33e0ff'; ctx.fillRect(15, -1, 4, 1.5);
  if (player.muzzle > 0) {
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

function drawPlayer() {
  const p = player;
  if (state === 'over') return;
  const blink = p.inv > 0 && Math.floor(time * 18) % 2 === 0;
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
    if (gunBehind) drawPlayerGun(a);
    // torso
    ctx.fillStyle = lgrad('pTorso', 0, -9, 0, 7, [[0, '#6bb4ff'], [1, '#1a52a8']]);
    rrect(-9, -9, 18, 15, 5); ctx.fill();
    outline('#0c2a5a', 1.5);
    ctx.fillStyle = 'rgba(255,255,255,0.22)'; rrect(-6, -7, 12, 6, 3); ctx.fill();
    ctx.fillStyle = '#2b2b2b'; ctx.fillRect(-9, 3, 18, 3);
    ctx.fillStyle = '#ffd43b'; ctx.fillRect(-2, 3, 4, 3);
    circle(-8, -6, 3.5, '#2f74d0'); circle(8, -6, 3.5, '#2f74d0');
    // helmet + visor
    circle(0, -14, 7.5, rgrad('pHelm', -2, -17, 10, [[0, '#c8d6e8'], [1, '#3b4a5e']]));
    outline('#1c2533', 1.2);
    ctx.fillStyle = 'rgba(51,224,255,0.35)'; rrect(face > 0 ? -2 : -8, -17, 10, 6, 3); ctx.fill();
    ctx.fillStyle = '#33e0ff'; rrect(face > 0 ? -1 : -7, -16, 8, 4, 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillRect(face > 0 ? 4 : -5, -15.5, 2, 1.2);
    ctx.fillStyle = '#ff3344'; ctx.fillRect(-1, -22, 2, 4);
    if (!gunBehind) drawPlayerGun(a);
    ctx.restore();
  }
  ctx.restore();
  if (p.blades > 0) {
    const fade = p.blades < 1.5 && Math.floor(time * 12) % 2 === 0;
    const nb = 4 + lvl('blades');
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

function drawShots() {
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,224,102,0.35)'; ctx.lineWidth = 8;
  ctx.beginPath();
  for (const b of bullets) { ctx.moveTo(b.x - b.vx * 0.02, b.y - b.vy * 0.02); ctx.lineTo(b.x, b.y); }
  ctx.stroke();
  ctx.strokeStyle = '#fff3b0'; ctx.lineWidth = 3.5;
  ctx.stroke();

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
  const p = player;
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
  const px = offX + player.x * scale, py = offY + player.y * scale;
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
  const p = player;
  const left = safe.l + 14, top = safe.t;
  label(`SCORE ${score.toLocaleString()}`, left, top + 22, 18);
  for (let i = 0; i < p.maxHp; i++) drawHeart(left + 9 + i * 22, top + 38, 18, i < p.hp);
  drawGem(left + 7, top + 70, 7);
  label(`${credits}`, left + 19, top + 70, 15, '#4dfff0');
  let y = top + 92;
  if (combo >= 5) { label(`x${comboMult()} COMBO ${combo}`, left, y, 14, '#ffd43b'); y += 20; }
  if (p.weapon !== 'basic') {
    const w = WEAPONS[p.weapon];
    label(w.name, left, y, 13, p.weapon === 'rapid' ? '#ff9f1a' : '#5be36b');
    ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.fillRect(left + 62, y - 3, 60, 6);
    ctx.fillStyle = '#fff'; ctx.fillRect(left + 62, y - 3, 60 * Math.max(0, p.weaponT / 10), 6);
  }

  const mid = offX + W * scale / 2;
  label(`ROUND ${round}`, mid, top + 20, 18, '#fff', 'center');
  const left2 = spawnQueue.length + warps.length + enemies.length;
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
    const ready = charges[i] > 0;
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
    ctx.fillText(charges[i], b.x + b.r * 0.72, b.y - b.r * 0.72 + 1);
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
  const ct = `${credits}`;
  ctx.font = 'bold 17px system-ui, sans-serif';
  const tw = ctx.measureText(ct).width;
  drawGem(sw / 2 - tw / 2 - 10, safe.t + 44, 7);
  label(ct, sw / 2 - tw / 2 + 2, safe.t + 44, 17, '#4dfff0');
  if (shopMsg) label(shopMsg.text, sw - safe.r - 14, safe.t + 44, 13, shopMsg.color, 'right');
  label(`Next: round ${round + 1}`, safe.l + 14, safe.t + 44, 12, 'rgba(255,255,255,0.55)', 'left', 'normal');

  for (const c of shopCards) {
    let title, desc, icon, cost = 0, can = false, maxed = false, pips = null;
    if (c.kind === 'go') {
      ctx.fillStyle = c.flash > 0 ? '#9dff8a' : '#2fa84f';
      rrect(c.x, c.y, c.w, c.h, 10); ctx.fill();
      outline('#7CFC00', 2);
      label('NEXT ROUND ▶', c.x + c.w / 2, c.y + c.h / 2, Math.min(18, c.w / 9), '#fff', 'center');
      continue;
    }
    if (c.kind === 'heal') {
      title = 'MED KIT'; desc = 'Refill all hearts'; icon = '❤️';
      cost = healCost(); can = credits >= cost && player.hp < player.maxHp;
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
    ctx.globalAlpha = can || maxed ? 1 : 0.55;
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
    if (pips) {
      for (let i = 0; i < pips[1]; i++) {
        ctx.fillStyle = i < pips[0] ? '#7CFC00' : 'rgba(255,255,255,0.18)';
        ctx.fillRect(c.x + 10 + i * 11, c.y + c.h - 16, 8, 8);
      }
    }
    if (maxed) label('MAX', c.x + c.w - 10, c.y + c.h - 12, 13, '#7CFC00', 'right');
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
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0d0b18'; ctx.fillRect(0, 0, canvas.width, canvas.height);

  const sx = shake > 0 ? rand(-shake, shake) * 0.5 : 0, sy = shake > 0 ? rand(-shake, shake) * 0.5 : 0;
  const k = scale * dpr;
  ctx.setTransform(k, 0, 0, k, (offX + sx * scale) * dpr, (offY + sy * scale) * dpr);
  drawArena();
  if (state !== 'title' && state !== 'notes') {
    drawHazards();
    drawPickups();
    for (const e of enemies) drawEnemy(e);
    drawPlayer();
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

  if (state === 'title') {
    const pulse = 0.6 + 0.4 * Math.sin(time * 4);
    drawCenterPanel([
      { text: 'ARENA BLITZ', size: Math.min(64, sw / 10), color: '#ff3df0' },
      { text: 'Survive the arena. Blast everything.', size: 15, color: '#9be7ff', weight: 'normal' },
      { gap: 24 },
      { text: isTouch ? 'TAP TO START' : 'CLICK OR PRESS ENTER', size: 22, color: `rgba(255,224,102,${pulse})` },
      { gap: 20 },
      { text: isTouch ? 'Left thumb: move  ·  Right thumb: aim  ·  Gun fires automatically'
                      : 'WASD: move  ·  Mouse / Arrows: aim  ·  Gun fires automatically', size: 13, color: '#ccc', weight: 'normal' },
      { text: isTouch ? 'Tap BLAST · MISSILES · BLADES for power attacks — they recharge every round'
                      : '1 / 2 / 3 (or Q / E / R): power attacks — they recharge every round', size: 13, color: '#ccc', weight: 'normal' },
      { text: 'Earn ◆ from kills and clean rounds — spend them in the upgrade shop every 2 rounds', size: 13, color: '#4dfff0', weight: 'normal' },
      { gap: 14 },
      { text: best ? `BEST ${best.toLocaleString()}` : '', size: 14, color: '#ffd43b' },
    ]);
    if (runningVersion) label(`v${runningVersion}`, safe.l + 12, sh - safe.b - 14, 12, 'rgba(255,255,255,0.45)', 'left', 'normal');
    return;
  }

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
      { text: isTouch ? 'Tap to resume' : 'Click or press P to resume', size: 16, color: '#ccc', weight: 'normal' },
    ]);
  }

  if (state === 'over' && overT > 0.8) {
    drawCenterPanel([
      { text: 'GAME OVER', size: 48, color: '#ff4466' },
      { text: `Reached round ${round}`, size: 16, color: '#ccc', weight: 'normal' },
      { gap: 10 },
      { text: `SCORE ${score.toLocaleString()}`, size: 26 },
      { text: newBest ? 'NEW BEST!' : `BEST ${best.toLocaleString()}`, size: 16, color: '#ffd43b' },
      { gap: 20 },
      { text: overT > 1 ? (isTouch ? 'TAP TO PLAY AGAIN' : 'CLICK OR PRESS ENTER') : '', size: 20, color: '#ffe066' },
      { text: updateReady ? `Update ready: v${latestVersion} installs when you continue` : '', size: 13, color: '#7CFC00', weight: 'normal' },
    ]);
  }
}

// ---------------------------------------------------------------- loop
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.033, (now - last) / 1000);
  last = now;
  const portrait = isTouch && sh > sw;
  if (state === 'play' && !paused && !portrait && !window.__freeze) update(dt);
  else if (state === 'over') { overT += dt; time += dt; updateFx(dt); }
  else if (state === 'shop') {
    time += dt;
    for (const c of shopCards) if (c.flash > 0) c.flash -= dt;
    if (shopMsg && (shopMsg.t -= dt) <= 0) shopMsg = null;
  }
  else time += dt;
  render();
  requestAnimationFrame(frame);
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
  get enemies() { return enemies.length; }, get enemyList() { return enemies; }, get player() { return player; }, startRound, useAbility, newGame,
  get credits() { return credits; }, set credits(v) { credits = v; }, get levels() { return levels; },
  set round(v) { round = v; }, openShop, get twist() { return twist; }, set nextTwist(v) { forcedTwist = v; },
  get pillars() { return pillars; }, get boss() { return boss; }, setTheme, get mines() { return mines; }, step: dt => { if (state === 'play') update(dt); }, spawn: (type, x, y) => enemies.push(makeEnemy(type, x, y)) };
})();
