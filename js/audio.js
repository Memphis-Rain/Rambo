// =====================================================================
// AUDIO ENGINE (Procedural Web Audio) - with proper node cleanup
// =====================================================================
let audioCtx = null;
let masterGain = null;
let _activeSounds = 0;
const _MAX_CONCURRENT_SOUNDS = 20;
const _soundThrottle = {}; // type -> last play time
const _THROTTLE_MS = 25; // min ms between same sound type

// Pre-cached noise buffers (pools of 4 variants per type to avoid repetition)
const _noisePool = {};
const _noiseIdx = {};
const _POOL_SIZE = 4;

function initAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.3;
  masterGain.connect(audioCtx.destination);

  // Pre-generate noise buffer pools for frequently-used sounds
  _buildNoisePool('pistol', 0.05, (i, len) => (Math.random()*2-1) * (1-i/len));
  _buildNoisePool('smg', 0.03, (i, len) => (Math.random()*2-1) * (1-i/len)*0.8);
  _buildNoisePool('shotgun', 0.12, (i, len) => (Math.random()*2-1) * Math.pow(1-i/len, 0.5));
  _buildNoisePool('rifle', 0.06, (i, len) => (Math.random()*2-1) * (1-i/len)*0.9);
  _buildNoisePool('minigun', 0.02, (i, len) => (Math.random()*2-1) * (1-i/len)*0.6);
  _buildNoisePool('hit', 0.04, (i, len) => (Math.random()*2-1) * (1-i/len)*0.5);
  _buildNoisePool('explosion', 0.5, (i, len) => (Math.random()*2-1) * Math.pow(1-i/len, 0.3) * 1.5);
  _buildNoisePool('big_explosion', 0.8, (i, len) => (Math.random()*2-1) * Math.pow(1-i/len, 0.2) * 2.0);
  _buildNoisePool('railgun', 0.35, (i, len) => (Math.random()*2-1) * Math.pow(1-i/len, 0.15) * 1.8);
  _buildNoisePool('bfg', 0.6, (i, len) => (Math.random()*2-1) * Math.pow(1-i/len, 0.12) * 2);
  // N1 grenades: throw whoosh (swells then fades) and the geyser's water splash
  _buildNoisePool('whoosh', 0.16, (i, len) => (Math.random()*2-1) * Math.sin(Math.PI*i/len) * 0.7);
  _buildNoisePool('splash', 0.6, (i, len) => { const u = i/len; return (Math.random()*2-1) * Math.min(1, u*12) * Math.pow(1-u, 1.5); });
  // F1/F3: flamethrower roar bed (looped, so plain white noise: no seam click) and fire crackle
  _buildNoisePool('flame', 1.0, () => Math.random()*2-1);
  _buildNoisePool('crackle', 0.4, (i, len) => { const u = i/len; return (Math.random() < 0.004 ? (Math.random()*2-1) * 3 : (Math.random()*2-1) * 0.08) * (1-u); });
  _buildNoisePool('shockwave', 0.8, (i, len) => Math.sin(i/audioCtx.sampleRate*2*Math.PI*30*(1-i/len)) * Math.pow(1-i/len, 0.3));
}

function _buildNoisePool(type, dur, fn) {
  _noisePool[type] = [];
  _noiseIdx[type] = 0;
  const len = Math.floor(audioCtx.sampleRate * dur);
  for(let p = 0; p < _POOL_SIZE; p++){
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for(let i = 0; i < len; i++) d[i] = fn(i, len);
    _noisePool[type].push(buf);
  }
}

function _getNoise(type) {
  const pool = _noisePool[type];
  if(!pool) return null;
  const buf = pool[_noiseIdx[type] % _POOL_SIZE];
  _noiseIdx[type]++;
  return buf;
}

// ---------------------------------------------------------------------
// F1: flamethrower roar. The weapon retriggers every 50 ms while held, so
// there is ONE live voice: each call extends it (and jitters its tone for
// the roll-and-lick flicker) instead of stacking 20 voices a second. It
// sustains _FLAME_HOLD s past the last call, then ramps linearly to 0 (no
// click) and its whole subgraph is stopped and disconnected.
// ---------------------------------------------------------------------
const _FLAME_ATK = 0.05;  // s ignition swell
const _FLAME_HOLD = 0.09; // s sustain past the last trigger (> the 50 ms refire)
const _FLAME_REL = 0.14;  // s release ramp
let _flame = null;        // the live roar voice, or null
// F3 'fire' crackle limits (enforced in playSound)
const _FIRE_GAP_MS = 90, _FIRE_MAX = 3;
let _fireLast = 0, _fireActive = 0;
// F2 scream limits: at most one start per 0.4 s, at most 2 sounding at once
const _SCREAM_GAP_MS = 400, _SCREAM_MAX = 2;
let _screamLast = 0, _screamActive = 0;
// Counters for tests and debugging (read-only to the game)
const _audioStats = { flameVoices: 0, flameExtends: 0, screamCalls: 0, screamStarted: 0 };

// Gain the roar envelope has at ctx time t, from the schedule we last wrote
function _flameEnvAt(v, t) {
  if (t < v.atkEnd) return v.atkFrom + (v.level - v.atkFrom) * Math.max(0, (t - v.atkStart) / (v.atkEnd - v.atkStart));
  if (t < v.holdEnd) return v.level;
  if (t < v.relEnd) return v.level * (v.relEnd - t) / _FLAME_REL;
  return 0;
}

function _flameSchedule(v, t, level) {
  const g = v.vg.gain;
  const from = _flameEnvAt(v, t);
  g.cancelScheduledValues(t);
  g.setValueAtTime(from, t);
  v.atkFrom = from; v.atkStart = t; v.level = level;
  v.atkEnd = t + (from < level * 0.5 ? _FLAME_ATK : 0.025);
  v.holdEnd = Math.max(v.atkEnd, t + _FLAME_HOLD);
  v.relEnd = v.holdEnd + _FLAME_REL;
  g.linearRampToValueAtTime(level, v.atkEnd);
  g.setValueAtTime(level, v.holdEnd);
  g.linearRampToValueAtTime(0, v.relEnd);
  // Flicker: the burner's band and body wander a little on every retrigger
  v.bp.frequency.setTargetAtTime(620 + Math.random() * 700, t, 0.035);
  v.roar.gain.setTargetAtTime(1.3 + Math.random() * 0.8, t, 0.03);
  v.lastWall = performance.now();
}

// Free the voice once it has been silent past its release (wall-clock based, so a
// suspended context can't keep it alive forever)
function _flameReap(v) {
  const left = v.lastWall + (_FLAME_HOLD + _FLAME_REL) * 1000 + 40 - performance.now();
  if (left > 0) { setTimeout(() => _flameReap(v), left); return; }
  try { v.src.stop(); } catch(e){}
  try { v.bus.disconnect(); } catch(e){}
  _activeSounds = Math.max(0, _activeSounds - 1);
  if (_flame === v) _flame = null;
}

function _playFlame(volume) {
  const t = audioCtx.currentTime;
  const level = volume * 0.3;
  const v = _flame;
  if (v && t < v.relEnd - 0.01) { _audioStats.flameExtends++; _flameSchedule(v, t, level); return; }
  if (v) _flame = null; // a fading voice: let its own reaper free it
  if (_activeSounds >= _MAX_CONCURRENT_SOUNDS) return;
  _activeSounds++;
  _audioStats.flameVoices++;
  const bus = audioCtx.createGain(); bus.connect(masterGain);
  const vg = audioCtx.createGain(); vg.gain.value = 0; vg.connect(bus);
  // One looped noise bed feeds three bands: burner roar, low rumble, gas hiss
  const src = audioCtx.createBufferSource();
  src.buffer = _getNoise('flame'); src.loop = true;
  src.playbackRate.value = 0.9 + Math.random() * 0.2;
  const bp = audioCtx.createBiquadFilter();
  bp.type = 'bandpass'; bp.Q.value = 0.9;
  bp.frequency.setValueAtTime(320, t); // ignition: the band sweeps up into the roar
  const roar = audioCtx.createGain(); roar.gain.value = 1.6;
  src.connect(bp); bp.connect(roar); roar.connect(vg);
  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 170; lp.Q.value = 0.8;
  const rumble = audioCtx.createGain(); rumble.gain.value = 2.6;
  src.connect(lp); lp.connect(rumble); rumble.connect(vg);
  const hp = audioCtx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 3600;
  const hiss = audioCtx.createGain(); hiss.gain.value = 0.12;
  src.connect(hp); hp.connect(hiss); hiss.connect(vg);
  src.start(t, Math.random() * 0.9);
  const nv = { bus, vg, src, bp, roar, atkFrom: 0, atkStart: t, atkEnd: t, holdEnd: t, relEnd: t, level: 0, lastWall: 0 };
  _flameSchedule(nv, t, level);
  _flame = nv;
  setTimeout(() => _flameReap(nv), (_FLAME_HOLD + _FLAME_REL) * 1000 + 40);
}

// ---------------------------------------------------------------------
// F2: burning-enemy scream. Saw + square through three vowel formants, with
// vibrato and a falling pitch; pitch, length, vowel and vibrato vary per call.
// Hard limits: one start per _SCREAM_GAP_MS, at most _SCREAM_MAX at once.
// ---------------------------------------------------------------------
function _playScream(volume, now) {
  _audioStats.screamCalls++;
  if (now - _screamLast < _SCREAM_GAP_MS || _screamActive >= _SCREAM_MAX) return;
  if (_activeSounds >= _MAX_CONCURRENT_SOUNDS) return;
  _screamLast = now; _screamActive++; _activeSounds++;
  _audioStats.screamStarted++;
  const t = audioCtx.currentTime;
  const dur = 0.4 + Math.random() * 0.2;
  const f0 = 340 + Math.random() * 280;
  const end = t + dur;
  const bus = audioCtx.createGain(); bus.connect(masterGain);
  const vg = audioCtx.createGain(); vg.connect(bus);
  const peak = volume * 0.55;
  vg.gain.setValueAtTime(0, t);
  vg.gain.linearRampToValueAtTime(peak, t + 0.03);
  vg.gain.setValueAtTime(peak, t + dur * 0.45);
  vg.gain.linearRampToValueAtTime(0, end);
  const mix = audioCtx.createGain();
  const lfo = audioCtx.createOscillator();
  lfo.type = 'sine'; lfo.frequency.value = 6 + Math.random() * 4;
  const lfoG = audioCtx.createGain(); lfoG.gain.value = f0 * 0.04;
  lfo.connect(lfoG);
  const oscs = [];
  for (const [type, detune, amp] of [['sawtooth', 0, 1], ['square', 14, 0.3]]) {
    const o = audioCtx.createOscillator();
    o.type = type; o.detune.value = detune;
    o.frequency.setValueAtTime(f0 * 0.88, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 1.12, t + 0.07);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.5, end);
    lfoG.connect(o.frequency);
    const og = audioCtx.createGain(); og.gain.value = amp;
    o.connect(og); og.connect(mix);
    oscs.push(o);
  }
  // Vowel: an open "aah" that closes toward "aw" as the breath runs out
  const fv = 0.9 + Math.random() * 0.2;
  for (const [f, q, amp] of [[820, 5, 2.0], [1250, 6, 1.4], [2700, 8, 0.6]]) {
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = q;
    bp.frequency.setValueAtTime(f * fv, t);
    bp.frequency.linearRampToValueAtTime(f * fv * 0.82, end);
    const fg = audioCtx.createGain(); fg.gain.value = amp;
    mix.connect(bp); bp.connect(fg); fg.connect(vg);
  }
  for (const o of oscs) { o.start(t); o.stop(end + 0.02); }
  lfo.start(t); lfo.stop(end + 0.02);
  setTimeout(() => {
    _screamActive = Math.max(0, _screamActive - 1);
    _activeSounds = Math.max(0, _activeSounds - 1);
    try { bus.disconnect(); } catch(e){}
  }, dur * 1000 + 80);
}

function playSound(type, volume=1) {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') { try { audioCtx.resume(); } catch(e){} }

  // Throttle: skip if same sound played too recently
  const now = performance.now();
  if (_soundThrottle[type] && now - _soundThrottle[type] < _THROTTLE_MS) return;
  _soundThrottle[type] = now;
  // F1/F2/F3: voices with their own limits and lifetimes (see above)
  if (type === 'flamethrower') { _playFlame(volume); return; }
  if (type === 'scream') { _playScream(volume, now); return; }
  if (type === 'fire' && (_fireLast && now - _fireLast < _FIRE_GAP_MS || _fireActive >= _FIRE_MAX)) return;

  // Limit concurrent sounds to prevent audio context overload
  if (_activeSounds >= _MAX_CONCURRENT_SOUNDS) return;
  _activeSounds++;

  const t = audioCtx.currentTime;

  // Single bus gain for this sound - ALL nodes route through here
  // Disconnecting this one node severs the entire subgraph
  const bus = audioCtx.createGain();
  bus.gain.value = 1;
  bus.connect(masterGain);

  // Primary gain (volume control for main voice)
  const g = audioCtx.createGain();
  g.connect(bus);
  g.gain.value = volume * 0.4;

  let soundDur = 0.5;

  if (type === 'pistol') {
    soundDur = 0.1;
    const osc = audioCtx.createOscillator();
    osc.type = 'square'; osc.frequency.setValueAtTime(200, t);
    osc.frequency.exponentialRampToValueAtTime(50, t+0.08);
    osc.connect(g); osc.start(t); osc.stop(t+0.08);
    g.gain.exponentialRampToValueAtTime(0.001, t+0.08);
    const ns = audioCtx.createBufferSource(); ns.buffer = _getNoise('pistol');
    const ng = audioCtx.createGain(); ng.gain.value = volume*0.3;
    ng.connect(bus); ns.connect(ng); ns.start(t); ns.stop(t+0.05);
  } else if (type === 'smg') {
    soundDur = 0.05;
    const ns = audioCtx.createBufferSource(); ns.buffer = _getNoise('smg');
    ns.connect(g); ns.start(t); ns.stop(t+0.03);
    g.gain.exponentialRampToValueAtTime(0.001, t+0.04);
  } else if (type === 'shotgun') {
    soundDur = 0.2;
    const ns = audioCtx.createBufferSource(); ns.buffer = _getNoise('shotgun');
    ns.connect(g); g.gain.value = volume*0.7; ns.start(t); ns.stop(t+0.12);
    g.gain.exponentialRampToValueAtTime(0.001, t+0.15);
  } else if (type === 'rifle') {
    soundDur = 0.1;
    const ns = audioCtx.createBufferSource(); ns.buffer = _getNoise('rifle');
    ns.connect(g); ns.start(t); ns.stop(t+0.06);
    const osc = audioCtx.createOscillator();
    osc.type='sawtooth'; osc.frequency.setValueAtTime(150,t);
    osc.frequency.exponentialRampToValueAtTime(40,t+0.05);
    const og = audioCtx.createGain(); og.gain.value = volume*0.15; og.connect(bus);
    osc.connect(og); osc.start(t); osc.stop(t+0.05);
  } else if (type === 'minigun') {
    soundDur = 0.05;
    const ns = audioCtx.createBufferSource(); ns.buffer = _getNoise('minigun');
    ns.connect(g); g.gain.value = volume*0.25; ns.start(t); ns.stop(t+0.02);
  } else if (type === 'rocket') {
    soundDur = 0.45;
    const osc = audioCtx.createOscillator();
    osc.type='sawtooth'; osc.frequency.setValueAtTime(300,t);
    osc.frequency.exponentialRampToValueAtTime(20,t+0.4);
    osc.connect(g); g.gain.value = volume*0.3; osc.start(t); osc.stop(t+0.4);
    g.gain.exponentialRampToValueAtTime(0.001,t+0.4);
  } else if (type === 'plasma') {
    soundDur = 0.2;
    const osc = audioCtx.createOscillator();
    osc.type='sine'; osc.frequency.setValueAtTime(800,t);
    osc.frequency.exponentialRampToValueAtTime(200,t+0.15);
    osc.connect(g); g.gain.value = volume*0.2; osc.start(t); osc.stop(t+0.15);
    const osc2 = audioCtx.createOscillator();
    osc2.type='sine'; osc2.frequency.setValueAtTime(1200,t);
    osc2.frequency.exponentialRampToValueAtTime(400,t+0.1);
    const g2 = audioCtx.createGain(); g2.gain.value = volume*0.1; g2.connect(bus);
    osc2.connect(g2); osc2.start(t); osc2.stop(t+0.1);
  } else if (type === 'railgun') {
    soundDur = 0.4;
    const ns = audioCtx.createBufferSource(); ns.buffer = _getNoise('railgun');
    ns.connect(g); g.gain.value = volume*0.5; ns.start(t); ns.stop(t+0.35);
    g.gain.exponentialRampToValueAtTime(0.001, t+0.35);
    const osc = audioCtx.createOscillator();
    osc.type='sine'; osc.frequency.setValueAtTime(50,t);
    osc.frequency.exponentialRampToValueAtTime(12,t+0.3);
    const og = audioCtx.createGain(); og.gain.value = volume*0.4; og.connect(bus);
    osc.connect(og); osc.start(t); osc.stop(t+0.3);
    og.gain.exponentialRampToValueAtTime(0.001,t+0.3);
  } else if (type === 'bfg') {
    soundDur = 0.7;
    const ns = audioCtx.createBufferSource(); ns.buffer = _getNoise('bfg');
    ns.connect(g); g.gain.value = volume*0.6; ns.start(t); ns.stop(t+0.6);
    g.gain.setValueAtTime(volume*0.6,t);
    g.gain.exponentialRampToValueAtTime(0.001,t+0.6);
    const osc = audioCtx.createOscillator();
    osc.type='sine'; osc.frequency.setValueAtTime(80,t);
    osc.frequency.exponentialRampToValueAtTime(8,t+0.5);
    const og = audioCtx.createGain(); og.gain.value = volume*0.5; og.connect(bus);
    osc.connect(og); osc.start(t); osc.stop(t+0.5);
    og.gain.exponentialRampToValueAtTime(0.001,t+0.5);
  } else if (type === 'disintegrator') {
    soundDur = 0.08;
    const osc = audioCtx.createOscillator();
    osc.type='sawtooth'; osc.frequency.setValueAtTime(3200,t);
    osc.frequency.exponentialRampToValueAtTime(1800,t+0.05);
    osc.connect(g); g.gain.value = volume*0.07; osc.start(t); osc.stop(t+0.05);
    g.gain.exponentialRampToValueAtTime(0.001,t+0.06);
  } else if (type === 'explosion') {
    soundDur = 0.55;
    const ns = audioCtx.createBufferSource(); ns.buffer = _getNoise('explosion');
    ns.connect(g); g.gain.value = volume*0.6; ns.start(t); ns.stop(t+0.5);
    g.gain.setValueAtTime(volume*0.6,t);
    g.gain.exponentialRampToValueAtTime(0.001,t+0.5);
    const osc = audioCtx.createOscillator();
    osc.type='sine'; osc.frequency.setValueAtTime(60,t);
    osc.frequency.exponentialRampToValueAtTime(15,t+0.4);
    const og = audioCtx.createGain(); og.gain.value = volume*0.5; og.connect(bus);
    osc.connect(og); osc.start(t); osc.stop(t+0.4);
    og.gain.exponentialRampToValueAtTime(0.001,t+0.4);
  } else if (type === 'big_explosion') {
    soundDur = 0.9;
    const ns = audioCtx.createBufferSource(); ns.buffer = _getNoise('big_explosion');
    ns.connect(g); g.gain.value = volume*0.8; ns.start(t); ns.stop(t+0.8);
    g.gain.setValueAtTime(volume*0.8,t);
    g.gain.exponentialRampToValueAtTime(0.001,t+0.8);
    const osc = audioCtx.createOscillator();
    osc.type='sine'; osc.frequency.setValueAtTime(40,t);
    osc.frequency.exponentialRampToValueAtTime(8,t+0.7);
    const og = audioCtx.createGain(); og.gain.value = volume*0.7; og.connect(bus);
    osc.connect(og); osc.start(t); osc.stop(t+0.7);
    og.gain.exponentialRampToValueAtTime(0.001,t+0.7);
  } else if (type === 'grenade') {
    // N1: the RPG boom pitched up and shorter (same noise pool, sped up)
    soundDur = 0.4;
    const ns = audioCtx.createBufferSource(); ns.buffer = _getNoise('explosion');
    ns.playbackRate.value = 1.45;
    ns.connect(g); ns.start(t); ns.stop(t+0.34);
    g.gain.setValueAtTime(volume*0.6,t);
    g.gain.exponentialRampToValueAtTime(0.001,t+0.34);
    const osc = audioCtx.createOscillator();
    osc.type='sine'; osc.frequency.setValueAtTime(95,t);
    osc.frequency.exponentialRampToValueAtTime(24,t+0.28);
    const og = audioCtx.createGain(); og.gain.value = volume*0.45; og.connect(bus);
    osc.connect(og); osc.start(t); osc.stop(t+0.28);
    og.gain.exponentialRampToValueAtTime(0.001,t+0.28);
  } else if (type === 'geyser') {
    // N1: underwater blast - a low-passed, softer boom plus a watery splash
    soundDur = 0.75;
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 380; lp.Q.value = 0.7;
    lp.connect(g);
    const ns = audioCtx.createBufferSource(); ns.buffer = _getNoise('explosion');
    ns.connect(lp); ns.start(t); ns.stop(t+0.45);
    g.gain.setValueAtTime(volume*0.5,t);
    g.gain.exponentialRampToValueAtTime(0.001,t+0.45);
    const osc = audioCtx.createOscillator();
    osc.type='sine'; osc.frequency.setValueAtTime(48,t);
    osc.frequency.exponentialRampToValueAtTime(14,t+0.35);
    const og = audioCtx.createGain(); og.gain.value = volume*0.4; og.connect(bus);
    osc.connect(og); osc.start(t); osc.stop(t+0.35);
    og.gain.exponentialRampToValueAtTime(0.001,t+0.35);
    // Splash: the column breaking the surface, just after the thump
    const sp = audioCtx.createBufferSource(); sp.buffer = _getNoise('splash');
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.setValueAtTime(900,t+0.05);
    bp.frequency.exponentialRampToValueAtTime(2600,t+0.6); bp.Q.value = 0.8;
    const sg = audioCtx.createGain(); sg.gain.value = volume*0.35; sg.connect(bus);
    sp.connect(bp); bp.connect(sg); sp.start(t+0.05); sp.stop(t+0.65);
  } else if (type === 'grenade_throw') {
    // N1: pin click (two metallic ticks) + a small whoosh as it leaves the hand
    soundDur = 0.22;
    const osc = audioCtx.createOscillator();
    osc.type='square'; osc.frequency.setValueAtTime(2600,t);
    osc.frequency.setValueAtTime(3400,t+0.035);
    osc.connect(g); osc.start(t); osc.stop(t+0.05);
    g.gain.setValueAtTime(volume*0.1,t);
    g.gain.setValueAtTime(0.0001,t+0.012);
    g.gain.setValueAtTime(volume*0.07,t+0.035);
    g.gain.exponentialRampToValueAtTime(0.0001,t+0.05);
    const ns = audioCtx.createBufferSource(); ns.buffer = _getNoise('whoosh');
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.setValueAtTime(700,t+0.04);
    bp.frequency.exponentialRampToValueAtTime(2000,t+0.2); bp.Q.value = 1.2;
    const ng = audioCtx.createGain(); ng.gain.value = volume*0.35; ng.connect(bus);
    ns.connect(bp); bp.connect(ng); ns.start(t+0.04); ns.stop(t+0.2);
  } else if (type === 'grenade_bounce') {
    // N1: a short metallic tick on the ground/obstacle
    soundDur = 0.06;
    const osc = audioCtx.createOscillator();
    osc.type='triangle'; osc.frequency.setValueAtTime(1900,t);
    osc.frequency.exponentialRampToValueAtTime(1100,t+0.04);
    osc.connect(g); osc.start(t); osc.stop(t+0.045);
    g.gain.setValueAtTime(volume*0.25,t);
    g.gain.exponentialRampToValueAtTime(0.001,t+0.045);
  } else if (type === 'fire') {
    // F3: burning-tree crackle - sparse pops over a soft low flutter
    soundDur = 0.42; _fireActive++; _fireLast = now;
    const ns = audioCtx.createBufferSource(); ns.buffer = _getNoise('crackle');
    ns.playbackRate.value = 0.8 + Math.random()*0.5;
    const hp = audioCtx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1400;
    ns.connect(hp); hp.connect(g); ns.start(t); ns.stop(t+0.4);
    g.gain.setValueAtTime(volume*0.5,t);
    const rs = audioCtx.createBufferSource(); rs.buffer = _getNoise('flame');
    const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260;
    const rg = audioCtx.createGain(); rg.connect(bus);
    rg.gain.setValueAtTime(0,t); rg.gain.linearRampToValueAtTime(volume*0.25,t+0.08);
    rg.gain.linearRampToValueAtTime(0,t+0.4);
    rs.connect(lp); lp.connect(rg); rs.start(t, Math.random()*0.5); rs.stop(t+0.4);
    setTimeout(() => { _fireActive = Math.max(0, _fireActive - 1); }, 450);
  } else if (type === 'hit') {
    soundDur = 0.06;
    const ns = audioCtx.createBufferSource(); ns.buffer = _getNoise('hit');
    ns.connect(g); g.gain.value = volume*0.2; ns.start(t); ns.stop(t+0.04);
  } else if (type === 'death') {
    soundDur = 0.35;
    const osc = audioCtx.createOscillator();
    osc.type='sawtooth'; osc.frequency.setValueAtTime(200,t);
    osc.frequency.exponentialRampToValueAtTime(50,t+0.3);
    osc.connect(g); g.gain.value = volume*0.15; osc.start(t); osc.stop(t+0.3);
    g.gain.exponentialRampToValueAtTime(0.001,t+0.3);
  } else if (type === 'pickup') {
    soundDur = 0.25;
    const osc = audioCtx.createOscillator();
    osc.type='sine'; osc.frequency.setValueAtTime(400,t);
    osc.frequency.linearRampToValueAtTime(800,t+0.15);
    osc.connect(g); g.gain.value = volume*0.15; osc.start(t); osc.stop(t+0.2);
    g.gain.exponentialRampToValueAtTime(0.001,t+0.2);
  } else if (type === 'unlock') {
    soundDur = 0.45;
    const osc = audioCtx.createOscillator();
    osc.type='sine';
    osc.frequency.setValueAtTime(523,t);
    osc.frequency.setValueAtTime(659,t+0.1);
    osc.frequency.setValueAtTime(784,t+0.2);
    osc.connect(g); g.gain.value = volume*0.2; osc.start(t); osc.stop(t+0.4);
    g.gain.setValueAtTime(volume*0.2,t+0.3);
    g.gain.exponentialRampToValueAtTime(0.001,t+0.4);
  } else if (type === 'shockwave') {
    soundDur = 0.9;
    const ns = audioCtx.createBufferSource(); ns.buffer = _getNoise('shockwave');
    ns.connect(g); g.gain.value = volume*0.6; ns.start(t); ns.stop(t+0.8);
    g.gain.exponentialRampToValueAtTime(0.001,t+0.8);
  } else if (type === 'shield_hit') {
    soundDur = 0.2;
    const osc = audioCtx.createOscillator();
    osc.type='sine'; osc.frequency.setValueAtTime(600,t);
    osc.frequency.exponentialRampToValueAtTime(200,t+0.15);
    osc.connect(g); g.gain.value = volume*0.12; osc.start(t); osc.stop(t+0.15);
    g.gain.exponentialRampToValueAtTime(0.001,t+0.15);
  } else if (type === 'shield_break') {
    soundDur = 0.35;
    const osc = audioCtx.createOscillator();
    osc.type='sawtooth'; osc.frequency.setValueAtTime(800,t);
    osc.frequency.exponentialRampToValueAtTime(100,t+0.25);
    osc.connect(g); g.gain.value = volume*0.2; osc.start(t); osc.stop(t+0.25);
    g.gain.exponentialRampToValueAtTime(0.001,t+0.3);
  } else if (type === 'boss_spawn') {
    soundDur = 1.2;
    const osc = audioCtx.createOscillator();
    osc.type='sawtooth'; osc.frequency.setValueAtTime(80,t);
    osc.frequency.setValueAtTime(60,t+0.5);
    osc.connect(g); g.gain.value = volume*0.25; osc.start(t); osc.stop(t+1.0);
    g.gain.setValueAtTime(volume*0.25,t+0.7);
    g.gain.exponentialRampToValueAtTime(0.001,t+1.0);
    const osc2 = audioCtx.createOscillator();
    osc2.type='sine'; osc2.frequency.setValueAtTime(120,t+0.3);
    osc2.frequency.setValueAtTime(90,t+0.8);
    const g2 = audioCtx.createGain(); g2.gain.value = volume*0.15; g2.connect(bus);
    osc2.connect(g2); osc2.start(t+0.3); osc2.stop(t+1.0);
    g2.gain.exponentialRampToValueAtTime(0.001,t+1.0);
  } else if (type === 'boss_death') {
    soundDur = 0.8;
    const osc = audioCtx.createOscillator();
    osc.type='sine';
    osc.frequency.setValueAtTime(392,t);
    osc.frequency.setValueAtTime(523,t+0.15);
    osc.frequency.setValueAtTime(659,t+0.3);
    osc.frequency.setValueAtTime(784,t+0.45);
    osc.connect(g); g.gain.value = volume*0.25; osc.start(t); osc.stop(t+0.7);
    g.gain.setValueAtTime(volume*0.25,t+0.55);
    g.gain.exponentialRampToValueAtTime(0.001,t+0.7);
  }

  // CRITICAL: Disconnect the bus node after sound ends.
  // This severs the ENTIRE subgraph (all oscillators, gains, sources)
  // from masterGain, allowing Chrome to GC all nodes.
  // Without this, gain nodes accumulate forever and eventually kill audio.
  setTimeout(() => {
    _activeSounds = Math.max(0, _activeSounds - 1);
    try { bus.disconnect(); } catch(e){}
  }, soundDur * 1000 + 50);
}
