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

function playSound(type, volume=1) {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') { try { audioCtx.resume(); } catch(e){} }

  // Throttle: skip if same sound played too recently
  const now = performance.now();
  if (_soundThrottle[type] && now - _soundThrottle[type] < _THROTTLE_MS) return;
  _soundThrottle[type] = now;

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
  } else if (type === 'tesla') {
    soundDur = 0.15;
    const osc = audioCtx.createOscillator();
    osc.type='sawtooth'; osc.frequency.setValueAtTime(2000,t);
    osc.frequency.exponentialRampToValueAtTime(80,t+0.12);
    osc.connect(g); g.gain.value = volume*0.15; osc.start(t); osc.stop(t+0.12);
    const osc2 = audioCtx.createOscillator();
    osc2.type='square'; osc2.frequency.setValueAtTime(150,t);
    osc2.frequency.setValueAtTime(300,t+0.04);
    osc2.frequency.setValueAtTime(100,t+0.08);
    const g2 = audioCtx.createGain(); g2.gain.value = volume*0.08; g2.connect(bus);
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
