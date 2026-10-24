// =====================================================================
// RETRO PIPELINE (M1) - low-res world target, palette dither, CRT overlay
// The world renders into a small RenderTexture which is shown scaled up
// with nearest-neighbour filtering; the HUD stays at full resolution.
// =====================================================================

// DITHER_STRENGTH (R4a): 0 = plain posterize, 1 = full Bayer offset
const RETRO = { PIXEL_SCALE: 3, DITHER: true, CRT: true, LEVELS: 6, DITHER_STRENGTH: 0.5 };
window.RETRO = RETRO;

// R2: snap a screen-space offset to whole low-res pixels (pure; unit-tested)
function snapToPixel(v, scale) { return Math.round(v / scale) * scale; }

const _retro = {
  ready: false,
  root: null,          // unscaled-world wrapper, scaled by 1/PIXEL_SCALE
  worldRT: null,       // world at low resolution
  ditherRT: null,      // world after the dither filter (still low res)
  ditherSprite: null,  // draws worldRT through the filter into ditherRT
  ditherFilter: null,
  display: null,       // full-screen nearest-scaled sprite on the stage
  crt: null,           // scanlines + vignette (full res, under the HUD)
  scanlines: null,
  vignette: null,
  rtW: 0, rtH: 0,
};

function retroState() {
  return { scale: RETRO.PIXEL_SCALE, rtWidth: _retro.rtW, rtHeight: _retro.rtH, dither: RETRO.DITHER, crt: RETRO.CRT };
}

// ---------------------------------------------------------------------
// R4: posterize + 4x4 Bayer ordered dither, small contrast/saturation boost
// ---------------------------------------------------------------------
const _RETRO_VERT = `
in vec2 aPosition;
out vec2 vTextureCoord;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
vec4 filterVertexPosition(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  return vec4(position, 0.0, 1.0);
}
vec2 filterTextureCoord(void) { return aPosition * (uOutputFrame.zw * uInputSize.zw); }
void main(void) {
  gl_Position = filterVertexPosition();
  vTextureCoord = filterTextureCoord();
}`;

const _RETRO_FRAG = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uLevels;
uniform float uContrast;
uniform float uSaturation;
uniform float uStrength;
uniform vec2 uOffset; // world offset in low-res px: anchors the pattern to the world
// Recursive Bayer matrix without arrays (portable across GLSL versions)
float bayer2(vec2 a) {
  a = floor(a);
  return fract(dot(a, vec2(0.5, a.y * 0.75)));
}
float bayer4(vec2 p) {
  return bayer2(0.5 * p) * 0.25 + bayer2(p);
}
void main(void) {
  vec4 c = texture(uTexture, vTextureCoord);
  vec3 col = c.a > 0.0 ? c.rgb / c.a : c.rgb;
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(luma), col, uSaturation);
  col = (col - 0.5) * uContrast + 0.5;
  col = clamp(col, 0.0, 1.0);
  float steps = uLevels - 1.0;
  // Centred Bayer offset scaled by strength: flat areas round to one level,
  // only gradients near a level boundary pick up the pattern
  float offset = 0.5 + (bayer4(gl_FragCoord.xy - uOffset) + 0.5 / 16.0 - 0.5) * uStrength;
  col = floor(col * steps + offset) / steps;
  finalColor = vec4(clamp(col, 0.0, 1.0) * c.a, c.a);
}`;

function _createDitherFilter() {
  return new PIXI.Filter({
    glProgram: PIXI.GlProgram.from({ vertex: _RETRO_VERT, fragment: _RETRO_FRAG, name: 'retro-dither' }),
    resources: {
      retroUniforms: {
        uLevels: { value: RETRO.LEVELS, type: 'f32' },
        uContrast: { value: 1.08, type: 'f32' },
        uSaturation: { value: 1.18, type: 'f32' },
        uStrength: { value: RETRO.DITHER_STRENGTH, type: 'f32' },
        uOffset: { value: new Float32Array(2), type: 'vec2<f32>' },
      },
    },
    padding: 0,
    resolution: 1,
    antialias: false,
  });
}

// ---------------------------------------------------------------------
// R5: CRT overlay - scanline tile + vignette (no curvature: keeps aim exact)
// ---------------------------------------------------------------------
function _makeScanlineTexture(period) {
  const c = document.createElement('canvas');
  c.width = 1; c.height = period;
  const ctx2 = c.getContext('2d');
  ctx2.fillStyle = 'rgba(0,0,0,0.25)';
  ctx2.fillRect(0, period - 1, 1, 1);
  const tex = PIXI.Texture.from(c);
  tex.source.scaleMode = 'nearest';
  return tex;
}

function _makeVignetteTexture(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.ceil(w / 4)); c.height = Math.max(2, Math.ceil(h / 4));
  const ctx2 = c.getContext('2d');
  const g = ctx2.createRadialGradient(c.width / 2, c.height / 2, Math.min(c.width, c.height) * 0.35,
    c.width / 2, c.height / 2, Math.max(c.width, c.height) * 0.72);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx2.fillStyle = g;
  ctx2.fillRect(0, 0, c.width, c.height);
  return PIXI.Texture.from(c);
}

// ---------------------------------------------------------------------
// Setup / resize
// ---------------------------------------------------------------------
function initRetro() {
  if (_retro.ready) return;
  // Re-parent the world: it is no longer drawn by the stage directly
  stage.removeChild(worldContainer);
  _retro.root = new PIXI.Container();
  _retro.root.addChild(worldContainer);

  _retro.ditherFilter = _createDitherFilter();
  _retro.ditherSprite = new PIXI.Sprite();
  _retro.ditherSprite.filters = [_retro.ditherFilter];

  _retro.display = new PIXI.Sprite();
  stage.addChildAt(_retro.display, 0);

  _retro.crt = new PIXI.Container();
  stage.addChildAt(_retro.crt, 1);

  _retro.ready = true;
  rebuildRetroTargets();
  window.addEventListener('resize', rebuildRetroTargets);

  // R3: render the low-res pass each display frame, after the game update
  // (UPDATE_PRIORITY.HIGH) and before the app renders the stage (LOW)
  app.ticker.add(renderRetro, null, PIXI.UPDATE_PRIORITY.NORMAL);
}

function rebuildRetroTargets() {
  if (!_retro.ready) return;
  const s = RETRO.PIXEL_SCALE;
  const w = Math.max(1, Math.ceil(W / s));
  const h = Math.max(1, Math.ceil(H / s));
  if (_retro.worldRT) { _retro.worldRT.destroy(true); _retro.ditherRT.destroy(true); }
  _retro.worldRT = PIXI.RenderTexture.create({ width: w, height: h, resolution: 1, scaleMode: 'nearest', antialias: false });
  _retro.ditherRT = PIXI.RenderTexture.create({ width: w, height: h, resolution: 1, scaleMode: 'nearest', antialias: false });
  _retro.rtW = w; _retro.rtH = h;
  _retro.root.scale.set(1 / s);
  _retro.ditherSprite.texture = _retro.worldRT;
  _retro.display.scale.set(s);
  _applyRetroToggles();

  // CRT layer sized to the screen
  if (_retro.scanlines) { _retro.scanlines.destroy({ texture: true, textureSource: true }); _retro.scanlines = null; }
  if (_retro.vignette) { _retro.vignette.destroy({ texture: true, textureSource: true }); _retro.vignette = null; }
  _retro.scanlines = new PIXI.TilingSprite({ texture: _makeScanlineTexture(Math.max(2, s)), width: W, height: H });
  _retro.vignette = new PIXI.Sprite(_makeVignetteTexture(W, H));
  _retro.vignette.width = W; _retro.vignette.height = H;
  _retro.crt.addChild(_retro.scanlines, _retro.vignette);
}

function _applyRetroToggles() {
  if (!_retro.ready) return;
  _retro.display.texture = RETRO.DITHER ? _retro.ditherRT : _retro.worldRT;
  const u = _retro.ditherFilter.resources.retroUniforms.uniforms;
  u.uLevels = RETRO.LEVELS;
  u.uStrength = clamp(RETRO.DITHER_STRENGTH, 0, 1);
  _retro.crt.visible = RETRO.CRT;
}

// Snapped on-screen offset of the world (also used for mouse aim, Q5)
function updateRetroCamera() {
  const s = RETRO.PIXEL_SCALE;
  worldOffsetX = snapToPixel(W / 2 - cam.x + shakeX, s);
  worldOffsetY = snapToPixel(H / 2 - cam.y + shakeY, s);
  worldContainer.x = worldOffsetX;
  worldContainer.y = worldOffsetY;
}

function renderRetro() {
  if (!_retro.ready) return;
  uiContainer.visible = gameStarted; // no stale HUD under the title screen
  // Live-tunable from the console (RETRO.DITHER_STRENGTH / RETRO.LEVELS)
  const u = _retro.ditherFilter.resources.retroUniforms.uniforms;
  u.uStrength = clamp(RETRO.DITHER_STRENGTH, 0, 1);
  u.uLevels = RETRO.LEVELS;
  // R2/R4: move the Bayer grid with the world so dither doesn't shimmer as
  // the camera scrolls (mod 4 = the pattern period; measured: 100% of pixels
  // stay put across a 1 low-res px pan at x3/x4, was ~20%)
  const s = RETRO.PIXEL_SCALE;
  u.uOffset[0] = ((Math.round((worldOffsetX || 0) / s) % 4) + 4) % 4;
  u.uOffset[1] = ((Math.round((worldOffsetY || 0) / s) % 4) + 4) % 4;
  renderer.render({ container: _retro.root, target: _retro.worldRT, clear: true, clearColor: [0.16, 0.23, 0.16, 1] });
  if (RETRO.DITHER) {
    renderer.render({ container: _retro.ditherSprite, target: _retro.ditherRT, clear: true, clearColor: [0, 0, 0, 1] });
  }
}

// ---------------------------------------------------------------------
// R6: showcase toggles (F6 scale, F7 dither, F8 CRT)
// ---------------------------------------------------------------------
function cycleRetroScale() {
  RETRO.PIXEL_SCALE = RETRO.PIXEL_SCALE >= 4 ? 1 : RETRO.PIXEL_SCALE + 1;
  rebuildRetroTargets();
  showNotification(`PIXEL x${RETRO.PIXEL_SCALE}`, 1.2);
}
function toggleRetroDither() {
  RETRO.DITHER = !RETRO.DITHER;
  _applyRetroToggles();
  showNotification(`DITHER ${RETRO.DITHER ? 'ON' : 'OFF'}`, 1.2);
}
function toggleRetroCRT() {
  RETRO.CRT = !RETRO.CRT;
  _applyRetroToggles();
  showNotification(`CRT ${RETRO.CRT ? 'ON' : 'OFF'}`, 1.2);
}
