// =====================================================================
// GAME STATE - All global mutable state (PixiJS + WebGL)
// =====================================================================

// PixiJS Application & Renderer
let app = null;
let stage = null;
let renderer = null;

// Containers for scene graph organization
let worldContainer = null;
let terrainContainer = null;
let effectsContainer = null;
let uiContainer = null;

// Legacy canvas references (keep for compatibility with existing code)
const canvas = document.getElementById('game');
let ctx = null; // Will be null, PixiJS handles rendering
const notifEl = document.getElementById('notif');
let DPR = window.devicePixelRatio || 1;

let W, H;
let gameStarted = false;
let paused = false;
let gameTime = 0;
let score = 0;
let kills = 0;
let combo = 0;
let comboTimer = 0;
let bestCombo = 0;
let wave = 0;
let waveTimer = 0;
let waveCooldown = 3;
let waveActive = false;
let enemiesThisWave = 0;
let enemiesSpawned = 0;
let shakeX = 0, shakeY = 0, shakeMag = 0;
let lastTime = 0;
let dt = 0;
let notifTimer = 0;
let notifText = '';
let unlockedWeapons = 1;

// Boss state
let bossActive = false;
let bossTarget = -1;
let pendingBossSpawn = -1;

// Shield & Special
let shieldRegenTimer = 0;

// Camera
const cam = { x: 0, y: 0, tx: 0, ty: 0 };

// Input
const keys = {};
let mouseX = 0, mouseY = 0;
let mouseDown = false;
let mouseJustPressed = false;
let mouseRightDown = false;
let mouseRightJustPressed = false;
let mouseWorldX = 0, mouseWorldY = 0;
let floatingTexts = [];

// Entity pools
let player = null;
const enemies = [];
const bullets = [];
const particles = [];
const bloodPools = [];
const bodies = [];
const shells = [];
const decals = [];
const obstacles = [];
const pickups = [];
const envObjects = [];
const envChunks = new Set();
const shockwaveEffects = [];

// Terrain chunks cache (now stores PixiJS Sprites with RenderTextures)
const chunkCache = new Map();

// PixiJS sprite pools (for performance)
const spritePool = {
  bullets: [],
  particles: [],
  enemies: [],
  shells: []
};

// Initialize PixiJS Application
async function initPixiApp() {
  app = new PIXI.Application();

  await app.init({
    canvas: canvas,
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: 0x2a3a2a,
    resolution: DPR,
    autoDensity: true,
    antialias: false, // Disable for pixel-perfect rendering
    powerPreference: 'high-performance',
    hello: true // Shows PixiJS version in console
  });

  renderer = app.renderer;
  stage = app.stage;

  W = renderer.width / DPR;
  H = renderer.height / DPR;

  // Create scene graph containers
  worldContainer = new PIXI.Container();
  worldContainer.sortableChildren = true; // Enable depth sorting
  stage.addChild(worldContainer);

  terrainContainer = new PIXI.Container();
  terrainContainer.zIndex = -1000000; // Always behind everything (entity depths can go very negative)
  worldContainer.addChild(terrainContainer);

  effectsContainer = new PIXI.Container();
  effectsContainer.zIndex = 1000000; // Always in front
  worldContainer.addChild(effectsContainer);

  uiContainer = new PIXI.Container();
  uiContainer.zIndex = 2000; // Always on top
  stage.addChild(uiContainer);

  // Handle window resize
  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.resize(w, h);
    W = w;
    H = h;
  });

  console.log(`PixiJS initialized: ${W}x${H} @ ${DPR}x DPR, WebGL ${renderer.context.webGLVersion}`);
}
