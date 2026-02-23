// =====================================================================
// UTILITY FUNCTIONS, NOISE, ISOMETRIC TRANSFORMS
// =====================================================================

function lerp(a,b,t){ return a+(b-a)*t; }
function clamp(v,lo,hi){ return v<lo?lo:v>hi?hi:v; }
function dist(x1,y1,x2,y2){ const dx=x2-x1,dy=y2-y1; return Math.sqrt(dx*dx+dy*dy); }
function angle(x1,y1,x2,y2){ return Math.atan2(y2-y1,x2-x1); }
function randRange(a,b){ return a+Math.random()*(b-a); }
function randInt(a,b){ return Math.floor(randRange(a,b+1)); }
function hsl(h,s,l){ return `hsl(${h},${s}%,${l}%)`; }
function rgba(r,g,b,a){ return `rgba(${r},${g},${b},${a})`; }

// Isometric transforms
function toScreen(wx, wy) {
  return { x: (wx - wy), y: (wx + wy) * CFG.ISO_SCALE };
}
function toWorld(sx, sy) {
  const wy2 = sy / CFG.ISO_SCALE;
  return { x: (sx + wy2) * 0.5, y: (wy2 - sx) * 0.5 };
}
function depthKey(wx, wy) { return wx + wy; }

// Seeded random for chunks
function seededRand(seed) {
  let s = seed | 0;
  return function() { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

function createOffscreen(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { canvas: c, ctx: c.getContext('2d') };
}

function darkenColor(hex, factor) {
  if(hex.startsWith('#')){
    let r = parseInt(hex.slice(1,2), 16) * 17;
    let g = parseInt(hex.slice(2,3), 16) * 17;
    let b = parseInt(hex.slice(3,4), 16) * 17;
    r = Math.floor(r * factor);
    g = Math.floor(g * factor);
    b = Math.floor(b * factor);
    return `rgb(${r},${g},${b})`;
  }
  return hex;
}

// =====================================================================
// SIMPLEX NOISE (simplified 2D)
// =====================================================================
const PERM = new Uint8Array(512);
const GRAD = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
(function initNoise(){
  const p = new Uint8Array(256);
  for(let i=0;i<256;i++) p[i]=i;
  for(let i=255;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [p[i],p[j]]=[p[j],p[i]]; }
  for(let i=0;i<512;i++) PERM[i]=p[i&255];
})();

function noise2D(x, y) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
  const xf = x - Math.floor(x), yf = y - Math.floor(y);
  const u = xf*xf*(3-2*xf), v = yf*yf*(3-2*yf);
  const aa = PERM[PERM[X]+Y], ab = PERM[PERM[X]+Y+1];
  const ba = PERM[PERM[X+1]+Y], bb = PERM[PERM[X+1]+Y+1];
  const g = (h,x,y) => { const g2=GRAD[h&7]; return g2[0]*x+g2[1]*y; };
  const l1 = g(aa,xf,yf)*(1-u) + g(ba,xf-1,yf)*u;
  const l2 = g(ab,xf,yf-1)*(1-u) + g(bb,xf-1,yf-1)*u;
  return l1*(1-v) + l2*v;
}

function fbm(x, y, octaves=4) {
  let val=0, amp=0.5, freq=1;
  for(let i=0;i<octaves;i++){ val+=noise2D(x*freq,y*freq)*amp; amp*=0.5; freq*=2; }
  return val;
}
