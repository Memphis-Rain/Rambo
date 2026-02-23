// =====================================================================
// PROCEDURAL 3D TREES - Pre-projected 3D trees with baked lighting
// Generates 3D geometry, projects to isometric 2D, renders as PIXI.Graphics
// =====================================================================

const treeGeometryCache = new Map();

// Sun direction for lighting (upper-left, slightly behind)
const SUN_DIR = normalize3([-0.4, -0.3, 0.8]);

function normalize3(v) {
  const len = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
  return [v[0]/len, v[1]/len, v[2]/len];
}

function dot3(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }

// =====================================================================
// GEOMETRY PRIMITIVES (generate 3D positions + normals + indices)
// =====================================================================

function generateCylinder(rTop, rBottom, height, segments) {
  segments = segments || 8;
  const positions = [];
  const normals = [];
  const indices = [];

  // Bottom ring (y=0) and top ring (y=height) in local 3D space
  // Using Y-up convention: x=right, y=up, z=forward
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    // Bottom vertex
    positions.push(rBottom * cos, 0, rBottom * sin);
    normals.push(cos, 0, sin);

    // Top vertex
    positions.push(rTop * cos, height, rTop * sin);
    normals.push(cos, 0, sin);
  }

  // Side faces
  for (let i = 0; i < segments; i++) {
    const b0 = i * 2, t0 = i * 2 + 1;
    const b1 = (i + 1) * 2, t1 = (i + 1) * 2 + 1;
    indices.push(b0, b1, t0);
    indices.push(t0, b1, t1);
  }

  // Top cap
  const topCenter = positions.length / 3;
  positions.push(0, height, 0);
  normals.push(0, 1, 0);
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    positions.push(rTop * Math.cos(angle), height, rTop * Math.sin(angle));
    normals.push(0, 1, 0);
  }
  for (let i = 0; i < segments; i++) {
    indices.push(topCenter, topCenter + 1 + i, topCenter + 2 + i);
  }

  return { positions, normals, indices };
}

function generateIcosphere(radius, subdivisions) {
  subdivisions = subdivisions || 1;

  // Start with icosahedron
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [
    -1, t, 0,  1, t, 0,  -1,-t, 0,  1,-t, 0,
     0,-1, t,  0, 1, t,   0,-1,-t,  0, 1,-t,
     t, 0,-1,  t, 0, 1,  -t, 0,-1, -t, 0, 1
  ];
  let faces = [
    0,11,5, 0,5,1, 0,1,7, 0,7,10, 0,10,11,
    1,5,9, 5,11,4, 11,10,2, 10,7,6, 7,1,8,
    3,9,4, 3,4,2, 3,2,6, 3,6,8, 3,8,9,
    4,9,5, 2,4,11, 6,2,10, 8,6,7, 9,8,1
  ];

  // Normalize initial vertices
  for (let i = 0; i < verts.length; i += 3) {
    const len = Math.sqrt(verts[i]*verts[i] + verts[i+1]*verts[i+1] + verts[i+2]*verts[i+2]);
    verts[i] /= len; verts[i+1] /= len; verts[i+2] /= len;
  }

  // Subdivide
  const midpointCache = {};
  function getMidpoint(i1, i2) {
    const key = Math.min(i1,i2) + '_' + Math.max(i1,i2);
    if (midpointCache[key] !== undefined) return midpointCache[key];
    const x = (verts[i1*3] + verts[i2*3]) / 2;
    const y = (verts[i1*3+1] + verts[i2*3+1]) / 2;
    const z = (verts[i1*3+2] + verts[i2*3+2]) / 2;
    const len = Math.sqrt(x*x + y*y + z*z);
    const idx = verts.length / 3;
    verts.push(x/len, y/len, z/len);
    midpointCache[key] = idx;
    return idx;
  }

  for (let s = 0; s < subdivisions; s++) {
    const newFaces = [];
    for (let i = 0; i < faces.length; i += 3) {
      const a = faces[i], b = faces[i+1], c = faces[i+2];
      const ab = getMidpoint(a, b);
      const bc = getMidpoint(b, c);
      const ca = getMidpoint(c, a);
      newFaces.push(a,ab,ca, b,bc,ab, c,ca,bc, ab,bc,ca);
    }
    faces = newFaces;
  }

  // Scale and build output
  const positions = [];
  const norms = [];
  for (let i = 0; i < verts.length; i += 3) {
    positions.push(verts[i] * radius, verts[i+1] * radius, verts[i+2] * radius);
    norms.push(verts[i], verts[i+1], verts[i+2]); // normals = normalized positions for sphere
  }

  return { positions, normals: norms, indices: faces };
}

function generateCone(radius, height, segments) {
  segments = segments || 8;
  const positions = [];
  const normals = [];
  const indices = [];

  // Apex
  positions.push(0, height, 0);
  normals.push(0, 1, 0);

  // Base ring
  const slopeLen = Math.sqrt(radius * radius + height * height);
  const ny = radius / slopeLen;
  const nr = height / slopeLen;

  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    positions.push(radius * cos, 0, radius * sin);
    normals.push(nr * cos, ny, nr * sin);
  }

  // Side faces
  for (let i = 0; i < segments; i++) {
    indices.push(0, i + 1, i + 2);
  }

  // Base cap
  const baseCenter = positions.length / 3;
  positions.push(0, 0, 0);
  normals.push(0, -1, 0);
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    positions.push(radius * Math.cos(angle), 0, radius * Math.sin(angle));
    normals.push(0, -1, 0);
  }
  for (let i = 0; i < segments; i++) {
    indices.push(baseCenter, baseCenter + 2 + i, baseCenter + 1 + i);
  }

  return { positions, normals, indices };
}

// =====================================================================
// TRANSFORM + COMBINE HELPERS
// =====================================================================

function translateGeometry(geom, dx, dy, dz) {
  const p = geom.positions;
  for (let i = 0; i < p.length; i += 3) {
    p[i] += dx; p[i+1] += dy; p[i+2] += dz;
  }
  return geom;
}

function scaleGeometry(geom, sx, sy, sz) {
  const p = geom.positions;
  for (let i = 0; i < p.length; i += 3) {
    p[i] *= sx; p[i+1] *= sy; p[i+2] *= sz;
  }
  // Normals need inverse-transpose scaling for non-uniform scale
  if (sx !== sy || sy !== sz) {
    const n = geom.normals;
    for (let i = 0; i < n.length; i += 3) {
      n[i] /= sx; n[i+1] /= sy; n[i+2] /= sz;
      const len = Math.sqrt(n[i]*n[i] + n[i+1]*n[i+1] + n[i+2]*n[i+2]);
      if (len > 0) { n[i] /= len; n[i+1] /= len; n[i+2] /= len; }
    }
  }
  return geom;
}

function mergeGeometries(geoList) {
  const positions = [];
  const normals = [];
  const indices = [];
  let offset = 0;

  for (const g of geoList) {
    positions.push(...g.positions);
    normals.push(...g.normals);
    for (const idx of g.indices) {
      indices.push(idx + offset);
    }
    offset += g.positions.length / 3;
  }

  return { positions, normals, indices };
}

function cloneGeometry(g) {
  return {
    positions: g.positions.slice(),
    normals: g.normals.slice(),
    indices: g.indices.slice()
  };
}

// Rotate geometry around the Y axis by angle (radians)
function rotateGeometryY(geom, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const p = geom.positions;
  const n = geom.normals;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], z = p[i+2];
    p[i] = x * cos + z * sin;
    p[i+2] = -x * sin + z * cos;
    const nx = n[i], nz = n[i+2];
    n[i] = nx * cos + nz * sin;
    n[i+2] = -nx * sin + nz * cos;
  }
  return geom;
}

// Rotate geometry around the Z axis by angle (radians) - for branch angles
function rotateGeometryZ(geom, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const p = geom.positions;
  const n = geom.normals;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i+1];
    p[i] = x * cos - y * sin;
    p[i+1] = x * sin + y * cos;
    const nx = n[i], ny = n[i+1];
    n[i] = nx * cos - ny * sin;
    n[i+1] = nx * sin + ny * cos;
  }
  return geom;
}

// =====================================================================
// ISOMETRIC PROJECTION + LIGHTING BAKE
// =====================================================================

function projectAndLight(geom, baseColor, isoScale) {
  isoScale = isoScale || CFG.ISO_SCALE;
  const positions3D = geom.positions;
  const norms = geom.normals;
  const numVerts = positions3D.length / 3;

  // Output: 2D positions (x,y per vertex), vertex colors (r,g,b,a per vertex)
  const positions2D = new Float32Array(numVerts * 2);
  const colors = new Float32Array(numVerts * 4);

  const baseR = ((baseColor >> 16) & 0xFF) / 255;
  const baseG = ((baseColor >> 8) & 0xFF) / 255;
  const baseB = (baseColor & 0xFF) / 255;

  for (let i = 0; i < numVerts; i++) {
    const x3 = positions3D[i*3];
    const y3 = positions3D[i*3+1]; // up
    const z3 = positions3D[i*3+2];

    // Isometric projection: map 3D (x, y_up, z) to screen
    // In the game's iso system: screenX = worldX - worldY, screenY = (worldX + worldY) * ISO_SCALE
    // Map 3D x→worldX, 3D z→worldY, 3D y→height (subtract from screenY)
    positions2D[i*2] = x3 - z3;
    positions2D[i*2+1] = (x3 + z3) * isoScale - y3;

    // Lighting
    const nx = norms[i*3], ny = norms[i*3+1], nz = norms[i*3+2];
    // Transform normal to iso space for lighting
    const brightness = 0.35 + 0.65 * Math.max(0, dot3([nx, ny, nz], SUN_DIR));

    colors[i*4] = baseR * brightness;
    colors[i*4+1] = baseG * brightness;
    colors[i*4+2] = baseB * brightness;
    colors[i*4+3] = 1.0;
  }

  return { positions2D, colors, indices: geom.indices };
}

// Sort triangles back-to-front by 3D depth (x + z in world space, since camera looks from +x,+z)
function sortTriangles(projected, positions3D) {
  const indices = projected.indices;
  const numTris = indices.length / 3;
  const triDepths = [];

  for (let i = 0; i < numTris; i++) {
    const i0 = indices[i*3], i1 = indices[i*3+1], i2 = indices[i*3+2];
    // Depth = average x+z of the three vertices in 3D
    const d0 = positions3D[i0*3] + positions3D[i0*3+2];
    const d1 = positions3D[i1*3] + positions3D[i1*3+2];
    const d2 = positions3D[i2*3] + positions3D[i2*3+2];
    triDepths.push({ depth: (d0 + d1 + d2) / 3, i0: indices[i*3], i1: indices[i*3+1], i2: indices[i*3+2] });
  }

  // Sort back-to-front (farther = lower depth = drawn first)
  triDepths.sort((a, b) => a.depth - b.depth);

  const sortedIndices = new Uint16Array(indices.length);
  for (let i = 0; i < triDepths.length; i++) {
    sortedIndices[i*3] = triDepths[i].i0;
    sortedIndices[i*3+1] = triDepths[i].i1;
    sortedIndices[i*3+2] = triDepths[i].i2;
  }

  return sortedIndices;
}

// =====================================================================
// TREE COMPOSITION - Build complete trees from primitives
// =====================================================================

function buildTreeGeometry(radius, height) {
  const parts = [];

  // Shadow disc (flat ellipse at ground level)
  const shadow = generateCylinder(0, 0, 0, 8);
  // Build shadow as a simple flat disc manually
  const shadowVerts = { positions: [0, 0.1, 0], normals: [0, -1, 0], indices: [] };
  const shadowSegs = 10;
  for (let i = 0; i <= shadowSegs; i++) {
    const a = (i / shadowSegs) * Math.PI * 2;
    shadowVerts.positions.push(radius * 0.7 * Math.cos(a), 0.1, radius * 0.3 * Math.sin(a));
    shadowVerts.normals.push(0, -1, 0);
  }
  for (let i = 0; i < shadowSegs; i++) {
    shadowVerts.indices.push(0, i + 1, i + 2);
  }

  // Trunk
  const trunkR = Math.max(4, radius * 0.15);
  const trunkH = height * 0.5;
  const trunk = generateCylinder(trunkR * 0.7, trunkR, trunkH, 6);

  // Canopy - 2-3 icospheres for organic look
  // Scale to match old 2D ellipse visuals (~r*1.0 screen pixels wide)
  const canopyR = radius * 0.75;
  const canopy1 = cloneGeometry(generateIcosphere(canopyR, 1));
  translateGeometry(canopy1, 0, trunkH + canopyR * 0.4, 0);

  const canopy2 = cloneGeometry(generateIcosphere(canopyR * 0.8, 1));
  translateGeometry(canopy2, canopyR * 0.25, trunkH + canopyR * 0.65, canopyR * 0.15);

  const canopy3 = cloneGeometry(generateIcosphere(canopyR * 0.65, 1));
  translateGeometry(canopy3, -canopyR * 0.2, trunkH + canopyR * 0.8, -canopyR * 0.1);

  // Project + light each part with different colors
  const shadowProj = projectAndLight(shadowVerts, 0x000000, CFG.ISO_SCALE);
  // Override shadow alpha
  for (let i = 0; i < shadowProj.colors.length; i += 4) {
    shadowProj.colors[i] = 0; shadowProj.colors[i+1] = 0;
    shadowProj.colors[i+2] = 0; shadowProj.colors[i+3] = 0.22;
  }

  const trunkProj = projectAndLight(trunk, 0x554433);
  const canopy1Proj = projectAndLight(canopy1, 0x11aa44);
  const canopy2Proj = projectAndLight(canopy2, 0x22bb55);
  const canopy3Proj = projectAndLight(canopy3, 0x44cc77);

  // Sort each part's triangles
  const shadowIdx = sortTriangles(shadowProj, shadowVerts.positions);
  const trunkIdx = sortTriangles(trunkProj, trunk.positions);
  const canopy1Idx = sortTriangles(canopy1Proj, canopy1.positions);
  const canopy2Idx = sortTriangles(canopy2Proj, canopy2.positions);
  const canopy3Idx = sortTriangles(canopy3Proj, canopy3.positions);

  // Merge all projected data
  return mergeProjected([
    { proj: shadowProj, sortedIdx: shadowIdx },
    { proj: trunkProj, sortedIdx: trunkIdx },
    { proj: canopy1Proj, sortedIdx: canopy1Idx },
    { proj: canopy2Proj, sortedIdx: canopy2Idx },
    { proj: canopy3Proj, sortedIdx: canopy3Idx },
  ]);
}

function buildPineGeometry(radius, height) {
  // Trunk
  const trunkR = Math.max(3, radius * 0.12);
  const trunkH = height * 0.35;
  const trunk = generateCylinder(trunkR * 0.7, trunkR, trunkH, 6);

  // Shadow disc
  const shadowVerts = { positions: [0, 0.1, 0], normals: [0, -1, 0], indices: [] };
  const shadowSegs = 8;
  for (let i = 0; i <= shadowSegs; i++) {
    const a = (i / shadowSegs) * Math.PI * 2;
    shadowVerts.positions.push(radius * 0.6 * Math.cos(a), 0.1, radius * 0.25 * Math.sin(a));
    shadowVerts.normals.push(0, -1, 0);
  }
  for (let i = 0; i < shadowSegs; i++) shadowVerts.indices.push(0, i+1, i+2);

  // Stacked cones (4 layers) - scale up to match old triangular visuals
  const cones = [];
  const coneColors = [0x119944, 0x11aa44, 0x22aa55, 0x33bb66];
  for (let i = 0; i < 4; i++) {
    const layerR = radius * (1 - i * 0.2) * 0.75;
    const layerH = height * 0.28;
    const cone = generateCone(layerR, layerH, 7);
    const baseY = trunkH + i * height * 0.16;
    translateGeometry(cone, 0, baseY, 0);
    cones.push({ geom: cone, color: coneColors[i] });
  }

  const shadowProj = projectAndLight(shadowVerts, 0x000000);
  for (let i = 0; i < shadowProj.colors.length; i += 4) {
    shadowProj.colors[i] = 0; shadowProj.colors[i+1] = 0;
    shadowProj.colors[i+2] = 0; shadowProj.colors[i+3] = 0.22;
  }
  const trunkProj = projectAndLight(trunk, 0x443322);

  const projParts = [
    { proj: shadowProj, sortedIdx: sortTriangles(shadowProj, shadowVerts.positions) },
    { proj: trunkProj, sortedIdx: sortTriangles(trunkProj, trunk.positions) },
  ];

  for (const c of cones) {
    const proj = projectAndLight(c.geom, c.color);
    projParts.push({ proj, sortedIdx: sortTriangles(proj, c.geom.positions) });
  }

  return mergeProjected(projParts);
}

function buildBushGeometry(radius) {
  // Shadow
  const shadowVerts = { positions: [0, 0.1, 0], normals: [0, -1, 0], indices: [] };
  const shadowSegs = 8;
  for (let i = 0; i <= shadowSegs; i++) {
    const a = (i / shadowSegs) * Math.PI * 2;
    shadowVerts.positions.push(radius * 0.75 * Math.cos(a), 0.1, radius * 0.3 * Math.sin(a));
    shadowVerts.normals.push(0, -1, 0);
  }
  for (let i = 0; i < shadowSegs; i++) shadowVerts.indices.push(0, i+1, i+2);

  // Hemisphere (icosphere with bottom half clamped)
  const sphere = generateIcosphere(radius * 1.1, 1);
  // Clamp vertices below y=0 to y=0
  for (let i = 0; i < sphere.positions.length; i += 3) {
    if (sphere.positions[i+1] < 0) {
      sphere.positions[i+1] = 0;
      sphere.normals[i+1] = Math.abs(sphere.normals[i+1]); // flip normal up
    }
  }
  translateGeometry(sphere, 0, radius * 0.1, 0);

  // Secondary smaller lump
  const lump = generateIcosphere(radius * 0.75, 1);
  for (let i = 0; i < lump.positions.length; i += 3) {
    if (lump.positions[i+1] < 0) lump.positions[i+1] = 0;
  }
  translateGeometry(lump, radius * 0.2, radius * 0.15, radius * 0.1);

  const shadowProj = projectAndLight(shadowVerts, 0x000000);
  for (let i = 0; i < shadowProj.colors.length; i += 4) {
    shadowProj.colors[i] = 0; shadowProj.colors[i+1] = 0;
    shadowProj.colors[i+2] = 0; shadowProj.colors[i+3] = 0.18;
  }

  const mainProj = projectAndLight(sphere, 0x22aa44);
  const lumpProj = projectAndLight(lump, 0x44cc66);

  return mergeProjected([
    { proj: shadowProj, sortedIdx: sortTriangles(shadowProj, shadowVerts.positions) },
    { proj: mainProj, sortedIdx: sortTriangles(mainProj, sphere.positions) },
    { proj: lumpProj, sortedIdx: sortTriangles(lumpProj, lump.positions) },
  ]);
}

function buildDeadTreeGeometry(height) {
  // Shadow
  const shadowVerts = { positions: [0, 0.1, 0], normals: [0, -1, 0], indices: [] };
  const shadowSegs = 6;
  for (let i = 0; i <= shadowSegs; i++) {
    const a = (i / shadowSegs) * Math.PI * 2;
    shadowVerts.positions.push(5 * Math.cos(a), 0.1, 2.5 * Math.sin(a));
    shadowVerts.normals.push(0, -1, 0);
  }
  for (let i = 0; i < shadowSegs; i++) shadowVerts.indices.push(0, i+1, i+2);

  // Main trunk
  const trunk = generateCylinder(1.5, 2.5, height, 5);

  // Branch stubs
  const branch1 = generateCylinder(0.8, 1.2, height * 0.3, 4);
  rotateGeometryZ(branch1, -0.6);
  translateGeometry(branch1, 0, height * 0.5, 0);

  const branch2 = generateCylinder(0.6, 1.0, height * 0.25, 4);
  rotateGeometryZ(branch2, 0.5);
  rotateGeometryY(branch2, 1.2);
  translateGeometry(branch2, 0, height * 0.7, 0);

  const shadowProj = projectAndLight(shadowVerts, 0x000000);
  for (let i = 0; i < shadowProj.colors.length; i += 4) {
    shadowProj.colors[i] = 0; shadowProj.colors[i+1] = 0;
    shadowProj.colors[i+2] = 0; shadowProj.colors[i+3] = 0.15;
  }
  const trunkProj = projectAndLight(trunk, 0x554433);
  const b1Proj = projectAndLight(branch1, 0x554433);
  const b2Proj = projectAndLight(branch2, 0x443322);

  return mergeProjected([
    { proj: shadowProj, sortedIdx: sortTriangles(shadowProj, shadowVerts.positions) },
    { proj: trunkProj, sortedIdx: sortTriangles(trunkProj, trunk.positions) },
    { proj: b1Proj, sortedIdx: sortTriangles(b1Proj, branch1.positions) },
    { proj: b2Proj, sortedIdx: sortTriangles(b2Proj, branch2.positions) },
  ]);
}

// Merge multiple projected+sorted parts into a single positions/colors/indices set
function mergeProjected(parts) {
  let totalVerts = 0;
  let totalIdx = 0;
  for (const p of parts) {
    totalVerts += p.proj.positions2D.length / 2;
    totalIdx += p.sortedIdx.length;
  }

  const positions = new Float32Array(totalVerts * 2);
  const colors = new Float32Array(totalVerts * 4);
  const indices = new Uint16Array(totalIdx);
  let vOff = 0, iOff = 0, vertOffset = 0;

  for (const p of parts) {
    const nv = p.proj.positions2D.length / 2;
    positions.set(p.proj.positions2D, vOff * 2);
    colors.set(p.proj.colors, vOff * 4);
    for (let i = 0; i < p.sortedIdx.length; i++) {
      indices[iOff + i] = p.sortedIdx[i] + vertOffset;
    }
    vOff += nv;
    iOff += p.sortedIdx.length;
    vertOffset += nv;
  }

  return { positions, colors, indices };
}

// =====================================================================
// PIXI.JS v8 GRAPHICS RENDERING
// =====================================================================

function bucketKey(type, radius, height) {
  // Bucket dimensions to nearest 15 to reduce unique geometries (~15-20 total)
  const r = radius ? Math.round(radius / 15) * 15 : 0;
  const h = height ? Math.round(height / 15) * 15 : 0;
  return `${type}_r${r}_h${h}`;
}

function getTreeGeometry(type, radius, height) {
  const key = bucketKey(type, radius, height);
  if (treeGeometryCache.has(key)) return treeGeometryCache.get(key);

  // Bucket the dimensions
  const r = radius ? Math.round(radius / 15) * 15 : 0;
  const h = height ? Math.round(height / 15) * 15 : 0;

  let data;
  if (type === 'tree') {
    data = buildTreeGeometry(r || 40, h || 80);
  } else if (type === 'pine') {
    data = buildPineGeometry(r || 30, h || 80);
  } else if (type === 'bush') {
    data = buildBushGeometry(r || 18);
  } else if (type === 'deadtree') {
    data = buildDeadTreeGeometry(h || 40);
  } else {
    return null;
  }

  treeGeometryCache.set(key, data);
  return data;
}

function createTreeGraphics(type, radius, height) {
  const data = getTreeGeometry(type, radius, height);
  if (!data) return null;

  const graphics = new PIXI.Graphics();
  const positions = data.positions;
  const colors = data.colors;
  const indices = data.indices;

  // Draw triangles in the order of indices
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i], i1 = indices[i+1], i2 = indices[i+2];

    // Get the three points
    const x0 = positions[i0 * 2];
    const y0 = positions[i0 * 2 + 1];
    const x1 = positions[i1 * 2];
    const y1 = positions[i1 * 2 + 1];
    const x2 = positions[i2 * 2];
    const y2 = positions[i2 * 2 + 1];

    // Get the color for this vertex (use first vertex color for the whole triangle)
    const r = colors[i0 * 4];
    const g = colors[i0 * 4 + 1];
    const b = colors[i0 * 4 + 2];
    const a = colors[i0 * 4 + 3];

    // Draw the triangle
    graphics.beginFill((r * 255) << 16 | (g * 255) << 8 | (b * 255), a);
    graphics.moveTo(x0, y0);
    graphics.lineTo(x1, y1);
    graphics.lineTo(x2, y2);
    graphics.closePath();
    graphics.endFill();
  }

  return graphics;
}