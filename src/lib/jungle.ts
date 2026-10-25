import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* --------------------------------------------------------------------------
   Amazon rainforest belt

   The campus sits in a clearing, so the whole horizon is jungle: multi-layer
   canopy, emergent giants, palms, tree ferns, lianas, a black-water river,
   drifting mist and a few macaws circling overhead. Everything is instanced
   merged geometry with vertex colors, so the forest costs a handful of draw
   calls regardless of tree count. Decorative only — no live-data element.
   -------------------------------------------------------------------------- */

const TRUNK_BROWNS = [0x3f2f1e, 0x33261a, 0x4a3826, 0x2c2116];
const CANOPY_GREENS = [0x166534, 0x15803d, 0x1b7a3f, 0x14663a, 0x2a7d3f, 0x1d8a44];

interface JungleMacaw {
  group: THREE.Group;
  cx: number;
  cz: number;
  radius: number;
  height: number;
  speed: number;
  phase: number;
  wingL: THREE.Mesh;
  wingR: THREE.Mesh;
}

interface JungleMist {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  baseX: number;
  baseZ: number;
  drift: number;
  speed: number;
}

let macaws: JungleMacaw[] = [];
let mists: JungleMist[] = [];
let fireflies: THREE.Points | null = null;
let fireflyMat: THREE.PointsMaterial | null = null;
let waterBands: THREE.Mesh[] = [];

let rngState = 0x9e3779b9;
function rnd(): number {
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  rngState >>>= 0;
  return rngState / 0x100000000;
}
function range(min: number, max: number): number {
  return min + rnd() * (max - min);
}
function pick<T>(list: T[]): T {
  return list[Math.floor(rnd() * list.length)] ?? list[0]!;
}

function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  if (merged) return merged;
  // A null geometry would kill every frame of the renderer, so fall back to
  // a simple cone on merge failure. Logged once per rebuild.
  console.warn('[jungle] geometry merge failed, using fallback silhouette');
  return tinted(new THREE.ConeGeometry(2.5, 9, 7), new THREE.Color(0x1d5c2e), 0.4).translate(0, 4.5, 0);
}

function tinted(
  geometry: THREE.BufferGeometry,
  color: THREE.Color,
  jitter: number,
): THREE.BufferGeometry {
  const c = color.clone();
  c.offsetHSL(range(-jitter, jitter) * 0.08, range(-jitter, jitter) * 0.06, range(-jitter, jitter) * 0.08);
  const count = geometry.attributes['position']!.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * Each species is one merged geometry built from primitives:
 *  giant   — emergent ceiba with buttress roots and an umbrella crown
 *  nut     — tall straight trunk, single round crown above the canopy
 *  fig     — mid canopy tree with hanging lianas
 *  palm    — slender açaí trunk with radiating fronds
 *  fern    — understory tree fern
 *  bush    — broad-leaf shrub
 */
function speciesGeometry(kind: string): THREE.BufferGeometry {
  const trunk = (r1: number, r2: number, h: number, color: number): THREE.BufferGeometry => {
    const geo = new THREE.CylinderGeometry(r1, r2, h, 7, 1, false);
    return tinted(geo, new THREE.Color(color), 0.5).translate(0, h / 2, 0);
  };
  const blob = (
    r: number,
    x: number,
    y: number,
    z: number,
    color: number,
    flat = 1,
  ): THREE.BufferGeometry => {
    // Low-poly faceted crown. Must stay indexed (like every other part) or
    // mergeGeometries refuses to combine it with the indexed trunks.
    const geo = new THREE.SphereGeometry(r, 8, 6);
    geo.scale(1, flat, 1);
    return tinted(geo, new THREE.Color(color), 0.8).translate(x, y, z);
  };
  const frond = (length: number, color: number, tilt: number, rot: number): THREE.BufferGeometry => {
    const geo = new THREE.ConeGeometry(0.42, length, 4, 1, false);
    tinted(geo, new THREE.Color(color), 0.7);
    geo.rotateX(Math.PI / 2 + tilt);
    geo.translate(0, 0, length / 2 - 0.3);
    geo.rotateY(rot);
    return geo;
  };

  if (kind === 'giant') {
    const parts: THREE.BufferGeometry[] = [trunk(0.9, 1.7, 24, pick(TRUNK_BROWNS))];
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2;
      const root = new THREE.ConeGeometry(0.55, 3.4, 4);
      tinted(root, new THREE.Color(0x4a3826), 0.5);
      root.rotateX(0.42);
      root.translate(Math.cos(angle) * 1.6, 1.4, Math.sin(angle) * 1.6);
      root.rotateY(-angle);
      parts.push(root);
    }
    const leafA = pick(CANOPY_GREENS);
    parts.push(blob(5.2, 0, 25.4, 0, leafA, 0.55));
    parts.push(blob(3.6, 4.2, 24.6, 1.2, leafA, 0.6));
    parts.push(blob(3.4, -3.8, 24.2, -2.0, leafA, 0.6));
    parts.push(blob(3.0, 0.8, 24.4, -4.4, leafA, 0.6));
    return mergeParts(parts);
  }
  if (kind === 'nut') {
    const parts = [trunk(0.55, 0.95, 19, pick(TRUNK_BROWNS))];
    const leaf = pick(CANOPY_GREENS);
    parts.push(blob(4.4, 0, 19.6, 0, leaf, 0.8));
    parts.push(blob(2.6, 2.6, 18.6, 1.0, leaf, 0.8));
    return mergeParts(parts);
  }
  if (kind === 'fig') {
    const parts = [trunk(0.5, 0.8, 12, pick(TRUNK_BROWNS))];
    const leaf = pick(CANOPY_GREENS);
    parts.push(blob(4.0, 0, 13.2, 0, leaf, 0.7));
    parts.push(blob(2.6, 3.2, 12.2, -0.8, leaf, 0.7));
    parts.push(blob(2.4, -2.8, 12.0, 1.6, leaf, 0.7));
    for (let i = 0; i < 4; i++) {
      const vine = new THREE.CylinderGeometry(0.05, 0.05, range(2.5, 5.5), 3);
      tinted(vine, new THREE.Color(0x2d4a1e), 0.6);
      const angle = (i / 4) * Math.PI * 2 + range(-0.4, 0.4);
      vine.translate(Math.cos(angle) * range(2.4, 3.6), range(8.8, 10.2), Math.sin(angle) * range(2.4, 3.6));
      parts.push(vine);
    }
    return mergeParts(parts);
  }
  if (kind === 'palm') {
    const parts = [trunk(0.16, 0.24, 9.5, 0x6b5a3e)];
    const green = 0x2c7a3f;
    for (let i = 0; i < 9; i++) {
      parts.push(frond(range(3.4, 4.6), green, range(-0.15, 0.6), (i / 9) * Math.PI * 2));
      parts[parts.length - 1]!.translate(0, 9.7, 0);
    }
    return mergeParts(parts);
  }
  if (kind === 'fern') {
    const parts = [trunk(0.14, 0.2, 2.2, 0x4a3b28)];
    for (let i = 0; i < 7; i++) {
      const f = frond(range(1.6, 2.3), 0x3c8f4e, range(0.1, 0.5), (i / 7) * Math.PI * 2);
      f.translate(0, 2.4, 0);
      parts.push(f);
    }
    return mergeParts(parts);
  }
  // bush
  const leaf = 0x2f6e38;
  return mergeParts([
    blob(1.1, 0, 1.0, 0, leaf, 0.75),
    blob(0.8, 0.9, 0.8, 0.4, leaf, 0.75),
    blob(0.7, -0.7, 0.7, -0.5, leaf, 0.75),
  ]);
}

interface TreeSpec {
  kind: string;
  heightRange: [number, number];
  density: number; // relative weight
}

const SPECIES: TreeSpec[] = [
  { kind: 'giant', heightRange: [0.85, 1.35], density: 0.14 },
  { kind: 'nut', heightRange: [0.8, 1.3], density: 0.16 },
  { kind: 'fig', heightRange: [0.8, 1.4], density: 0.22 },
  { kind: 'palm', heightRange: [0.75, 1.5], density: 0.18 },
  { kind: 'fern', heightRange: [0.7, 1.6], density: 0.16 },
  { kind: 'bush', heightRange: [0.7, 1.7], density: 0.14 },
];

function pickSpecies(): TreeSpec {
  const r = rnd();
  let acc = 0;
  for (const s of SPECIES) {
    acc += s.density;
    if (r <= acc) return s;
  }
  return SPECIES[SPECIES.length - 1]!;
}

/** How far a point sits outside the campus rectangle (0 when inside). */
function clearingDistance(x: number, z: number): number {
  const dx = Math.max(-60 - x, x - 120, 0);
  const dz = Math.max(-75 - z, z - 75, 0);
  return Math.hypot(dx, dz);
}

/** Keep the southern entrance trail fading into the trees. */
function inCorridor(x: number, z: number): boolean {
  return x > 16 && x < 44 && z > 75 && z < 140;
}

/** Forest floor so the distant trees never stand over empty space. */
function createForestFloor(root: THREE.Group, isDark: boolean): void {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = isDark ? '#0a1a0f' : '#28401f';
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 900; i++) {
      const shade = isDark ? 12 + Math.random() * 26 : 34 + Math.random() * 40;
      ctx.fillStyle = `rgba(${shade * 0.7},${shade + 14},${shade * 0.5},0.5)`;
      ctx.fillRect(Math.random() * 256, Math.random() * 256, 2 + Math.random() * 3, 2 + Math.random() * 3);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(26, 22);
  texture.colorSpace = THREE.SRGBColorSpace;
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(520, 460),
    new THREE.MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(30, -0.05, 0);
  root.add(floor);
}

/** Centre line of the black-water river that cuts the eastern jungle. */
function riverCenterX(z: number): number {
  const t = (z + 150) / 300;
  return 158 + Math.sin(t * Math.PI * 2.2) * 12;
}

/** Approximate distance to the river centre line (used to carve tree banks). */
function riverDistance(x: number, z: number): number {
  let min = Infinity;
  for (let zi = -150; zi <= 150; zi += 12) {
    const d = Math.hypot(x - riverCenterX(zi), z - zi);
    if (d < min) min = d;
  }
  return min;
}

function createRiver(root: THREE.Group, isDark: boolean): void {
  waterBands.length = 0;
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= 30; i++) {
    const z = -150 + (i / 30) * 300;
    points.push(new THREE.Vector3(riverCenterX(z), 0, z));
  }
  const curve = new THREE.CatmullRomCurve3(points);

  const ribbon = (half: number, y: number): THREE.BufferGeometry => {
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const steps = 90;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const p = curve.getPointAt(t);
      const tangent = curve.getTangentAt(t);
      const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
      const width = half * (0.8 + 0.4 * Math.sin(t * 21));
      positions.push(
        p.x - normal.x * width, y, p.z - normal.z * width,
        p.x + normal.x * width, y, p.z + normal.z * width,
      );
      uvs.push(0, t * 10, 1, t * 10);
      if (i < steps) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  };

  // Mud banks under, black water above. Both sit between the forest floor
  // (-0.05) and the campus lawn (-0.04) so neither hides the other.
  const bank = new THREE.Mesh(
    ribbon(7.6, -0.045),
    new THREE.MeshLambertMaterial({ color: isDark ? 0x241c12 : 0x5a4632 }),
  );
  root.add(bank);
  const water = new THREE.Mesh(
    ribbon(4.4, -0.035),
    new THREE.MeshStandardMaterial({
      color: isDark ? 0x081c1a : 0x1f4d5c,
      roughness: 0.08,
      metalness: 0.5,
      transparent: true,
      opacity: 0.94,
    }),
  );
  root.add(water);
  waterBands.push(water);
}

function createMist(root: THREE.Group): void {
  mists.length = 0;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const grad = ctx.createRadialGradient(64, 64, 6, 64, 64, 62);
  grad.addColorStop(0, 'rgba(220,235,225,0.55)');
  grad.addColorStop(1, 'rgba(220,235,225,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  for (let i = 0; i < 8; i++) {
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(46, 12), material);
    mesh.rotation.x = -Math.PI / 2;
    let baseX: number;
    let baseZ: number;
    if (i < 3) {
      // Low haze drifting over the black-water river.
      baseZ = -110 + i * 100 + range(-12, 12);
      baseX = riverCenterX(baseZ) + range(-6, 6);
    } else if (i < 6) {
      baseX = -70 + ((i - 3) % 3) * 60 + range(-8, 8);
      baseZ = range(-118, -100);
    } else {
      baseX = -70 + (i % 2) * 90 + range(-8, 8);
      baseZ = range(96, 112);
    }
    mesh.position.set(baseX, 0.9 + (i % 3) * 0.5, baseZ);
    root.add(mesh);
    mists.push({ mesh, material, baseX, baseZ, drift: range(0, Math.PI * 2), speed: range(0.6, 1.4) });
  }
}

function createFireflies(root: THREE.Group, isDark: boolean): void {
  if (!isDark) return;
  const count = 70;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const edge = Math.floor(rnd() * 4);
    let x = 30;
    let z = 0;
    if (edge === 0) {
      x = range(-88, 148);
      z = range(78, 96);
    } else if (edge === 1) {
      x = range(-88, 148);
      z = range(-104, -78);
    } else if (edge === 2) {
      x = range(-84, -60);
      z = range(-96, 96);
    } else {
      x = range(122, 148);
      z = range(-96, 96);
    }
    positions[i * 3] = x;
    positions[i * 3 + 1] = range(0.6, 3.2);
    positions[i * 3 + 2] = z;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  fireflyMat = new THREE.PointsMaterial({
    color: 0xd9f2a5,
    size: 0.32,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  fireflies = new THREE.Points(geo, fireflyMat);
  root.add(fireflies);
}

function createMacaws(root: THREE.Group): void {
  macaws = [];
  const bodyColors = [0xdc2626, 0x2563eb, 0xf59e0b, 0x16a34a];
  for (let i = 0; i < 4; i++) {
    const group = new THREE.Group();
    const color = bodyColors[i % bodyColors.length] ?? 0xdc2626;
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.7, 3, 6), mat);
    body.rotation.z = Math.PI / 2;
    group.add(body);
    const wingGeo = new THREE.PlaneGeometry(0.9, 0.4);
    wingGeo.translate(0, 0, 0.45);
    const wingMat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.85,
      side: THREE.DoubleSide,
    });
    const wingL = new THREE.Mesh(wingGeo, wingMat);
    wingL.position.set(0, 0.08, 0);
    wingL.rotation.x = Math.PI / 2;
    const wingR = wingL.clone();
    wingR.position.y = -0.08;
    group.add(wingL, wingR);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.14), mat);
    tail.position.x = -0.6;
    group.add(tail);

    group.traverse((obj) => {
      obj.castShadow = false;
      obj.receiveShadow = false;
    });
    root.add(group);
    macaws.push({
      group,
      cx: range(0, 60),
      cz: range(-30, 60),
      radius: range(24, 46),
      height: range(21, 30),
      speed: range(0.16, 0.3),
      phase: range(0, Math.PI * 2),
      wingL,
      wingR,
    });
  }
}

function placeForest(root: THREE.Group, isDark: boolean): void {
  // Reset deterministic layout per rebuild (theme flips call build again).
  rngState = 0x9e3779b9 ^ (isDark ? 0x5f : 0xa3);

  interface Bucket {
    matrices: THREE.Matrix4[];
    tints: THREE.Color[];
  }
  // Key = species + octant, so the frustum can drop whole forest sectors.
  const buckets = new Map<string, Bucket>();
  const dummy = new THREE.Object3D();

  const TARGET = 470;
  let guard = 0;
  for (let placed = 0; placed < TARGET && guard++ < TARGET * 40; ) {
    const x = range(30 - 235, 30 + 235);
    const z = range(-225, 225);
    const clearance = clearingDistance(x, z);
    if (clearance < 2 || clearance > 175) continue;
    if (inCorridor(x, z)) continue;
    if (riverDistance(x, z) < 11) continue;
    // Density fades slightly with distance so the clearing reads first.
    if (clearance > 60 && rnd() < 0.25) continue;
    placed++;

    const spec = pickSpecies();
    const scale = range(spec.heightRange[0], spec.heightRange[1]);
    const octant =
      Math.floor((((Math.atan2(z, x - 30) + Math.PI) / (Math.PI * 2)) * 8)) % 8;
    const key = `${spec.kind}#${octant}`;
    const entry = buckets.get(key) ?? { matrices: [], tints: [] };
    dummy.position.set(x, 0, z);
    dummy.rotation.set(0, rnd() * Math.PI * 2, range(-0.05, 0.05));
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    entry.matrices.push(dummy.matrix.clone());
    // Near-neutral brightness jitter: keeps each tree's own greens readable
    // instead of grinding them into gray under a saturated multiplier.
    const mult = isDark ? range(0.42, 0.72) : range(0.95, 1.3);
    entry.tints.push(new THREE.Color(mult * 0.98, mult, mult * 0.94));
    buckets.set(key, entry);
  }

  const geometryCache = new Map<string, THREE.BufferGeometry>();
  const materialCache = new Map<string, THREE.Material>();
  for (const [key, entry] of buckets) {
    if (entry.matrices.length === 0) continue;
    const kind = key.split('#')[0]!;
    const geometry = geometryCache.get(kind) ?? speciesGeometry(kind);
    geometryCache.set(kind, geometry);
    const material =
      materialCache.get(kind) ??
      new THREE.MeshLambertMaterial({ vertexColors: true });
    materialCache.set(kind, material);
    const instanced = new THREE.InstancedMesh(geometry, material, entry.matrices.length);
    entry.matrices.forEach((m, idx) => {
      instanced.setMatrixAt(idx, m);
      instanced.setColorAt(idx, entry.tints[idx]!);
    });
    instanced.instanceMatrix.needsUpdate = true;
    if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
    instanced.computeBoundingSphere();
    instanced.castShadow = false;
    instanced.receiveShadow = false;
    instanced.name = `jungle-${key}`;
    root.add(instanced);
  }
}

/**
 * Build the whole forest into `root` (the content group). Idempotent per
 * rebuild: callers clear meshes via the scene disposal pass.
 */
export function buildAmazonRainforest(root: THREE.Group, isDark: boolean): void {
  resetJungle();
  createForestFloor(root, isDark);
  placeForest(root, isDark);
  createRiver(root, isDark);
  createMist(root);
  createFireflies(root, isDark);
  createMacaws(root);
}

export function animateJungle(dt: number, time: number): void {
  for (const mist of mists) {
    mist.drift += dt * mist.speed * 0.12;
    mist.mesh.position.x = mist.baseX + Math.sin(mist.drift) * 9;
    mist.material.opacity = 0.14 + (Math.sin(mist.drift * 2.1) + 1) * 0.055;
  }

  for (const macaw of macaws) {
    macaw.phase += dt * macaw.speed;
    const x = macaw.cx + Math.cos(macaw.phase) * macaw.radius;
    const z = macaw.cz + Math.sin(macaw.phase) * macaw.radius * 0.62;
    const y = macaw.height + Math.sin(macaw.phase * 3.1) * 1.4;
    macaw.group.position.set(x, y, z);
    macaw.group.rotation.y = -macaw.phase + Math.PI / 2;
    const flap = Math.sin(time * 9 + macaw.phase * 4) * 0.7;
    macaw.wingL.rotation.y = flap * 0.55;
    macaw.wingR.rotation.y = -flap * 0.55;
  }

  if (fireflies && fireflyMat) {
    fireflyMat.opacity = 0.55 + Math.sin(time * 2.6) * 0.3;
    const attribute = fireflies.geometry.attributes['position'] as THREE.BufferAttribute;
    for (let i = 0; i < attribute.count; i++) {
      const base = attribute.getY(i);
      attribute.setY(i, base + Math.sin(time * 1.4 + i * 0.7) * 0.0035);
    }
    attribute.needsUpdate = true;
  }

  for (const water of waterBands) {
    const mat = water.material as THREE.MeshStandardMaterial;
    mat.roughness = 0.05 + Math.sin(time * 0.6) * 0.03;
  }
}

export function resetJungle(): void {
  macaws = [];
  mists = [];
  fireflies = null;
  fireflyMat = null;
  waterBands = [];
}
