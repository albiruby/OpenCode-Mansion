/**
 * Per-world content inventories.
 *
 * Forest keeps the classic estate (pool, courts, animal village, the full
 * attraction belt). Every other world REPLACES those clusters entirely with
 * its own structures — nothing is merely moved between maps. Each world also
 * declares its own fauna, campus staff, roam spots and camera presets.
 *
 * The office wing, workstations, squad loft, live screens and district towers
 * are the live-data spine and exist in every world (they carry the real
 * OpenCode sessions); everything else is world-specific.
 *
 * Builders receive a tiny api from the scene module so this file stays free
 * of scene imports (no cycles).
 */
import * as THREE from 'three';
import type { WorldThemeId } from './themes';

export interface ContentApi {
  tag(object: THREE.Object3D, label: string, kind: string, detail?: string, preset?: string): void;
  label(root: THREE.Group, x: number, y: number, z: number, text: string, scale?: number): void;
}

/** Collision box in campus-local coordinates: [x, z, w, d, rotation?] */
export type Collider = [number, number, number, number, number?];

export interface WorldItem {
  id: string;
  build(root: THREE.Group, isDark: boolean, api: ContentApi): void;
  colliders?: Collider[];
}

export interface StaffDef {
  name: string;
  x: number;
  z: number;
  rot: number;
  color: number;
}

export interface RoamSpot {
  x: number;
  z: number;
  rot: number;
}

export interface PresetSpot {
  pos: [number, number, number];
  look: [number, number, number];
}

export interface WorldContent {
  items: WorldItem[];
  /** Animal kinds allowed in this world (zones come from the spawn table). */
  fauna: string[];
  /** true = butterflies flutter (they make no sense in neon/space). */
  butterflies: boolean;
  staff: StaffDef[];
  /** Extra agent roam spots for this world's attractions (absolute coords). */
  roam: Record<string, RoamSpot[]>;
  /** Facility camera presets beyond the always-present spine. */
  presets: string[];
  presetSpots: Record<string, PresetSpot>;
}

/* ------------------------------------------------------------- primitives */

type MatOpts = {
  emissive?: number;
  ei?: number;
  metal?: number;
  rough?: number;
  transparent?: boolean;
  opacity?: number;
  flat?: boolean;
};

function mat(color: number, opts: MatOpts = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts.rough ?? 0.7,
    metalness: opts.metal ?? 0.05,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissive ? (opts.ei ?? 0.6) : 0,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    flatShading: opts.flat ?? false,
  });
}

function glow(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color });
}

/** Most builders tag the final mesh they added as their inspectable root. */
function last(root: THREE.Group): THREE.Object3D {
  return root.children[root.children.length - 1]!;
}

function box(
  root: THREE.Group,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  m: THREE.Material,
  ry = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.rotation.y = ry;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);
  return mesh;
}

function cyl(
  root: THREE.Group,
  rt: number,
  rb: number,
  h: number,
  x: number,
  y: number,
  z: number,
  m: THREE.Material,
  seg = 12,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);
  return mesh;
}

function ball(
  root: THREE.Group,
  r: number,
  x: number,
  y: number,
  z: number,
  m: THREE.Material,
  sx = 1,
  sy = 1,
  sz = 1,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 9), m);
  mesh.position.set(x, y, z);
  mesh.scale.set(sx, sy, sz);
  mesh.castShadow = true;
  root.add(mesh);
  return mesh;
}

function cone(root: THREE.Group, r: number, h: number, x: number, y: number, z: number, m: THREE.Material, seg = 10): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  root.add(mesh);
  return mesh;
}

function disc(root: THREE.Group, r: number, x: number, y: number, z: number, m: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.3, 22), m);
  mesh.position.set(x, y, z);
  mesh.receiveShadow = true;
  root.add(mesh);
  return mesh;
}

function flatDisc(root: THREE.Group, r: number, x: number, y: number, z: number, m: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(r, 26), m);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, y, z);
  mesh.receiveShadow = true;
  root.add(mesh);
  return mesh;
}

/** Little flag on a pole — generic set dressing helper. */
function pennant(root: THREE.Group, x: number, y: number, z: number, color: number, poleMat: THREE.Material): void {
  cyl(root, 0.05, 0.05, 2.4, x, y + 1.2, z, poleMat, 6);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.55), new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide }));
  flag.position.set(x + 0.45, y + 2.1, z);
  root.add(flag);
}

/* =================================================================== */
/*                        FLOATING KINGDOM                              */
/* =================================================================== */

function buildGiantTree(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const bark = mat(0x7c4a1f, { rough: 1 });
  const bark2 = mat(0x9a6233, { rough: 1 });
  const leaf = mat(0x7ade9b, { rough: 0.9 });
  const leaf2 = mat(0x5eead4, { rough: 0.9 });
  const pink = mat(0xf9a8d4, { rough: 0.9 });
  const wood = mat(0xcdb79e, { rough: 0.8 });

  cyl(root, 2.6, 4.4, 20, 60, 10, -30, bark, 10);
  cyl(root, 1.4, 2.6, 6, 60, 22, -30, bark2, 8);
  ball(root, 9, 60, 27, -30, leaf, 1.15, 0.8, 1.15);
  ball(root, 7, 53, 24, -26, leaf2, 1, 0.75, 1);
  ball(root, 6.4, 67, 25, -34, pink, 1, 0.7, 1);
  ball(root, 5.2, 60, 32, -30, leaf2, 1, 0.6, 1);
  // Treehouse nestled in the canopy.
  box(root, 6, 3.4, 5, 66, 23, -24, wood, -0.3);
  const roof = cone(root, 4.6, 3, 66, 26.6, -24, mat(0xef4444, { rough: 0.9 }), 4);
  roof.rotation.y = Math.PI / 4;
  box(root, 1.4, 1.6, 0.2, 65.4, 23, -21.6, mat(0x93c5fd, { emissive: 0x60a5fa, ei: 0.4, rough: 0.3 }), -0.3);
  // Roots clawing over the island edge.
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const root_ = new THREE.Mesh(new THREE.ConeGeometry(1.1, 7, 6), bark2);
    root_.position.set(60 + Math.cos(a) * 5.4, 1.6, -30 + Math.sin(a) * 5.4);
    root_.rotation.set(Math.PI / 2.3, a, -Math.cos(a) * 0.6);
    root.add(root_);
  }
  api.tag(last(root), 'Giant Tree HQ', 'Attraction', 'Pohon raksasa berisi rumah pohon kerajaan awan.');
  api.label(root, 60, 4.6, -30, 'GIANT TREE', 3.2);
}

function buildCloudTerraces(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const cloud = mat(0xf1f5ff, { rough: 0.95 });
  const rim = mat(0xc4b5fd, { emissive: 0x8b5cf6, ei: 0.35, rough: 0.4 });
  const flower = mat(0xf472b6, { rough: 0.8 });
  disc(root, 9, 10, 1.5, -40, cloud);
  disc(root, 6.4, 14, 6, -37, cloud);
  disc(root, 4, 17, 10, -35, cloud);
  // Under-islands (rock chunks hanging below).
  for (const [x, y, z, r] of [[10, -2.5, -40, 6], [14, 2, -37, 4]] as [number, number, number, number][]) {
    cone(root, r, 7, x, y - 3.5, z, mat(0x8d7f74, { rough: 1, flat: true }), 8).rotation.x = Math.PI;
  }
  cyl(root, 9.3, 9.3, 0.5, 10, 2.1, -40, rim, 24);
  cyl(root, 6.7, 6.7, 0.5, 14, 6.6, -37, rim, 24);
  cyl(root, 4.3, 4.3, 0.5, 17, 10.6, -35, rim, 24);
  // Flowers + crystals on top.
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    ball(root, 0.34, 10 + Math.cos(a) * 7.4, 2.1, -40 + Math.sin(a) * 7.4, flower);
  }
  cone(root, 1.1, 3.4, 17, 12.4, -35, mat(0xa5f3fc, { emissive: 0x22d3ee, ei: 0.7, transparent: true, opacity: 0.85 }), 5);
  api.tag(last(root), 'Cloud Terraces', 'Attraction', 'Taman bertingkat di atas gumpalan awan.');
}

function buildBalloonDock(root: THREE.Group, isDark: boolean, api: ContentApi): void {
  const deck = mat(0xcdb79e, { rough: 0.8 });
  const rope = mat(0xa16207, { rough: 1 });
  const crate = mat(isDark ? 0x3f3f46 : 0xb45309, { rough: 0.9 });
  box(root, 14, 1.2, 9, 92, 1.2, -48, deck);
  for (const [dx, dz] of [[-6, -3.5], [6, -3.5], [-6, 3.5], [6, 3.5]] as [number, number][]) {
    cyl(root, 0.28, 0.28, 4.6, 92 + dx, 1.2, -48 + dz, rope, 6);
  }
  // Two moored balloons.
  const colors = [0xf472b6, 0x60a5fa];
  colors.forEach((c, i) => {
    const g = new THREE.Group();
    const x = 88 + i * 8;
    g.position.set(x, 0, -52 + i * 6);
    ball(g, 3.4, 0, 8.6, 0, mat(c, { rough: 0.6 }), 1, 1.3, 1);
    box(g, 1.6, 1.1, 1.6, 0, 3.4, 0, crate);
    for (const [rx, rz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as [number, number][]) {
      const rope2 = cyl(g, 0.04, 0.04, 3.6, rx, 5.4, rz, rope, 5);
      rope2.rotation.z = -rx * 0.16;
    }
    root.add(g);
  });
  box(root, 4, 1.6, 3, 96, 0.8, -44, crate, 0.2);
  api.tag(last(root), 'Balloon Dock', 'Attraction', 'Dermaga balon udara kerajaan awan.');
}

function buildSkyBridge(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const plank = mat(0xcdb79e, { rough: 0.9 });
  const post = mat(0x92400e, { rough: 1 });
  const rope = mat(0xd6b46a, { rough: 1 });
  // Two stone gate posts with a plank span and sagging rope rails.
  for (const x of [36, 58]) {
    box(root, 2.4, 7, 2.4, x, 3.5, 54, post);
    ball(root, 1.5, x, 7.6, 54, mat(0xfde68a, { emissive: 0xf59e0b, ei: 0.7, rough: 0.4 }));
  }
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const x = 36 + t * 22;
    const sag = Math.sin(t * Math.PI) * 1.5;
    box(root, 1.0, 0.3, 2.6, x, 4.4 - sag, 54, plank);
    if (i % 2 === 0) {
      for (const dz of [-1.6, 1.6]) {
        cyl(root, 0.05, 0.05, 1.0, x, 5.0 - sag, 54 + dz, rope, 5);
      }
    }
  }
  for (const dz of [-1.6, 1.6]) {
    const rail = new THREE.Mesh(new THREE.TorusGeometry(11.4, 0.07, 4, 30, Math.PI), rope);
    rail.position.set(47, 5.6, 54 + dz);
    rail.rotation.z = Math.PI;
    rail.scale.y = 0.14;
    root.add(rail);
  }
  api.tag(last(root), 'Sky Bridge', 'Attraction', 'Jembatan gantung antar pilar awan.');
}

function buildWindmill(root: THREE.Group, isDark: boolean, api: ContentApi): void {
  const towerM = mat(isDark ? 0xe2e8f0 : 0xffffff, { rough: 0.7 });
  const roofM = mat(0xfb7185, { rough: 0.8 });
  const bladeM = mat(0xfda4af, { rough: 0.6 });
  cyl(root, 1.8, 3.0, 12, -44, 6, -30, towerM, 14);
  cone(root, 2.6, 3.4, -44, 13.7, -30, roofM, 10);
  box(root, 1.6, 2.4, 0.3, -44, 1.4, -27.4, mat(0x8b5e3c, { rough: 0.9 }));
  // Blade hub with four sails.
  const hub = new THREE.Group();
  hub.position.set(-44, 12, -27.6);
  for (let i = 0; i < 4; i++) {
    const blade = box(hub, 1.2, 6.5, 0.18, 0, 3.4, 0, bladeM);
    blade.rotation.z = (i * Math.PI) / 2;
    blade.position.set(Math.sin((i * Math.PI) / 2) * 3.4, Math.cos((i * Math.PI) / 2) * 3.4, 0);
  }
  ball(hub, 0.6, 0, 0, 0, mat(0xf59e0b, { rough: 0.5 }));
  root.add(hub);
  api.tag(towerM as unknown as THREE.Object3D ?? root, 'Windmill', 'Attraction', 'Kincir angin kerajaan awan.');
}

function buildSkyOrchard(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const trunk = mat(0xa16207, { rough: 1 });
  const fruits = [0xfde68a, 0xfda4af, 0xa5b4fc, 0x86efac, 0xfbcfe8, 0xfcd34d];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const x = 64 + Math.cos(a) * 9;
    const z = 44 + Math.sin(a) * 7;
    cyl(root, 0.3, 0.45, 3.2, x, 1.6, z, trunk, 7);
    ball(root, 2.4, x, 4.4, z, mat(0x86efac, { rough: 0.9 }), 1, 0.8, 1);
    ball(root, 0.5, x + 1, 3.6, z + 0.7, mat(fruits[i]!, { emissive: fruits[i]!, ei: 0.25, rough: 0.5 }));
    ball(root, 0.42, x - 0.8, 3.3, z - 0.9, mat(fruits[(i + 2) % 6]!, { emissive: fruits[(i + 2) % 6]!, ei: 0.25, rough: 0.5 }));
  }
  // Central picnic blanket + basket.
  box(root, 4.5, 0.1, 4.5, 64, 0.16, 44, mat(0xfda4af, { rough: 0.9 }), 0.4);
  box(root, 1.2, 0.8, 0.9, 64.6, 0.6, 44.4, mat(0xb45309, { rough: 0.9 }), 0.3);
  api.tag(last(root), 'Sky Orchard', 'Attraction', 'Kebun buah melayang dengan buah berpendar.');
}

function buildBakery(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const wall = mat(0xfff7ed, { rough: 0.8 });
  const roof = mat(0xf9a8d4, { rough: 0.8 });
  box(root, 8, 4.4, 6, 96, 2.2, 52, wall, 0.15);
  const r = cone(root, 6, 3.6, 96, 6.4, 52, roof, 6);
  r.rotation.y = 0.15 + Math.PI / 6;
  box(root, 1.8, 2.4, 0.3, 94.4, 1.2, 49.2, mat(0x8b5e3c, { rough: 0.9 }), 0.15);
  box(root, 2.2, 1.4, 0.2, 97.6, 3.0, 49.0, mat(0xfde68a, { emissive: 0xfbbf24, ei: 0.5, rough: 0.4 }), 0.15);
  // Chimney puff of clouds.
  box(root, 1, 1.8, 1, 99, 6.6, 54, mat(0xd6d3d1, { rough: 1 }), 0.15);
  ball(root, 1.2, 99.4, 8.4, 54, mat(0xffffff, { rough: 1, transparent: true, opacity: 0.9 }), 1.4, 0.8, 1.2);
  ball(root, 1.6, 100.4, 9.6, 54.4, mat(0xffffff, { rough: 1, transparent: true, opacity: 0.8 }), 1.5, 0.8, 1.2);
  pennant(root, 92, 0, 55, 0xf472b6, mat(0xa16207, { rough: 1 }));
  api.tag(last(root), 'Cloud Bakery', 'Attraction', 'Roti hangat dari oven kerajaan awan.');
}

function buildCrystalSpires(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const hues = [0x22d3ee, 0xa78bfa, 0xf472b6, 0xfde68a, 0x6ee7b7];
  const base = mat(0xcbd5e1, { rough: 0.9 });
  flatDisc(root, 7, -48, 0.1, 38, base);
  hues.forEach((h, i) => {
    const a = (i / hues.length) * Math.PI * 2;
    const x = -48 + Math.cos(a) * 4.4;
    const z = 38 + Math.sin(a) * 4.4;
    const hgt = 3 + (i % 3) * 1.6;
    cone(root, 0.9, hgt, x, hgt / 2, z, mat(h, { emissive: h, ei: 0.75, transparent: true, opacity: 0.92, rough: 0.2 }), 5);
    ball(root, 0.3, x, hgt + 0.5, z, glow(h));
  });
  cone(root, 1.5, 6.5, -48, 3.2, 38, mat(0xf0abfc, { emissive: 0xd946ef, ei: 0.8, transparent: true, opacity: 0.92, rough: 0.2 }), 5);
  api.tag(last(root), 'Crystal Spires', 'Attraction', 'Sembilan kristal berpendar di taman kerajaan.');
}

function buildMushroomRing(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const cap = [0xef4444, 0xf59e0b, 0x3b82f6, 0xf472b6];
  const stem = mat(0xfef3c7, { rough: 0.9 });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const x = 96 + Math.cos(a) * 5.5;
    const z = -8 + Math.sin(a) * 5.5;
    const s = 0.9 + (i % 3) * 0.35;
    cyl(root, 0.3 * s, 0.42 * s, 1.6 * s, x, 0.8 * s, z, stem, 8);
    const capM = mat(cap[i % 4]!, { emissive: cap[i % 4]!, ei: 0.5, rough: 0.6 });
    const capMesh = new THREE.Mesh(new THREE.SphereGeometry(1.1 * s, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), capM);
    capMesh.position.set(x, 1.6 * s, z);
    root.add(capMesh);
  }
  flatDisc(root, 7, 96, 0.12, -8, mat(0x4ade80, { rough: 1 }));
  api.tag(last(root), 'Mushroom Ring', 'Attraction', 'Cincin jamur pelangi penanda tempat angker-angker manis.');
}

const FLOATING_ITEMS: WorldItem[] = [
  { id: 'giant-tree', build: buildGiantTree, colliders: [[60, -30, 8, 8]] },
  { id: 'cloud-terraces', build: buildCloudTerraces, colliders: [[10, -40, 17, 17], [14, -37, 11, 11]] },
  { id: 'balloon-dock', build: buildBalloonDock, colliders: [[92, -48, 13, 8]] },
  { id: 'sky-bridge', build: buildSkyBridge, colliders: [[36, 54, 2, 3], [58, 54, 2, 3], [47, 54, 22, 1.6]] },
  { id: 'windmill', build: buildWindmill, colliders: [[-44, -30, 5, 5]] },
  { id: 'sky-orchard', build: buildSkyOrchard, colliders: [[64, 44, 17, 13]] },
  { id: 'bakery', build: buildBakery, colliders: [[96, 52, 8, 6]] },
  { id: 'crystal-spires', build: buildCrystalSpires, colliders: [[-48, 38, 12, 12]] },
  { id: 'mushroom-ring', build: buildMushroomRing, colliders: [] },
];

/* =================================================================== */
/*                          CYBER MEGACITY                              */
/* =================================================================== */

function buildHoloArcade(root: THREE.Group, isDark: boolean, api: ContentApi): void {
  const shell = mat(isDark ? 0x111827 : 0x1f2937, { rough: 0.6, metal: 0.3 });
  const neon = [0x22d3ee, 0xe879f9, 0xf59e0b, 0xa3e635];
  const boothNames = ['PIXEL PALACE', 'HOLO RACE', 'DANCE MAT', 'SHOOTER X'];
  for (let i = 0; i < 4; i++) {
    const x = -18 + i * 6.5;
    const z = -46;
    box(root, 5.4, 4.6, 4.4, x, 2.3, z, shell);
    box(root, 5.8, 0.5, 4.8, x, 4.8, z, glow(neon[i]!));
    // Marquee screen.
    box(root, 4.4, 1.2, 0.2, x, 3.9, z + 2.3, glow(neon[i]!));
    // Screen face.
    box(root, 3.6, 2.0, 0.15, x, 1.9, z + 2.3, mat(0x0b1220, { emissive: neon[i]!, ei: 0.35, rough: 0.3 }));
    api.tag(last(root), boothNames[i]!, 'Attraction', 'Booth arcade holografik neon kota.');
  }
  api.label(root, -8, 6.4, -46, 'HOLO ARCADE', 3.4);
}

function buildSkatePark(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const conc = mat(0x94a3b8, { rough: 0.95 });
  const rail = mat(0xe2e8f0, { metal: 0.85, rough: 0.3 });
  const grind = mat(0x22d3ee, { emissive: 0x22d3ee, ei: 0.4, metal: 0.6, rough: 0.35 });
  flatDisc(root, 12, -46, 0.12, 34, conc);
  // Quarter pipes.
  for (const [x, ry] of [[-54, Math.PI / 2], [-38, -Math.PI / 2]] as [number, number][]) {
    const ramp = box(root, 9, 0.6, 7, x, 1.6, 34, conc);
    ramp.rotation.z = x < -46 ? 0.42 : -0.42;
    ramp.rotation.y = ry > 0 ? 0.06 : -0.06;
    box(root, 0.4, 0.4, 7, x + (x < -46 ? -3.6 : 3.6), 3.4, 34, rail);
  }
  // Funbox + rail.
  box(root, 5, 1.1, 4, -46, 0.7, 30, conc);
  box(root, 6.4, 0.25, 0.3, -46, 1.35, 26.5, grind);
  for (const x of [-48.4, -43.6]) cyl(root, 0.1, 0.1, 1.4, x, 0.7, 26.5, rail, 6);
  // Bowl hint: sunken ring of blocks.
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    box(root, 2.4, 0.7, 1.2, -46 + Math.cos(a) * 8, 0.4, 38 + Math.sin(a) * 8, conc, -a);
  }
  api.tag(last(root), 'Skate Park', 'Attraction', 'Taman skate beton dengan quarter pipe neon.');
}

function buildRamenAlley(root: THREE.Group, isDark: boolean, api: ContentApi): void {
  const stall = mat(isDark ? 0x1f2937 : 0x374151, { rough: 0.7 });
  const awning = [0xef4444, 0xf59e0b, 0x22c55e];
  const stool = mat(0xf87171, { rough: 0.7 });
  for (let i = 0; i < 3; i++) {
    const x = 44 + i * 9;
    const z = 30;
    box(root, 7, 3.6, 5, x, 1.8, z, stall);
    box(root, 7.6, 0.4, 5.6, x, 3.9, z, mat(awning[i]!, { rough: 0.8 }));
    box(root, 5.6, 1.0, 0.6, x, 1.1, z + 2.8, mat(0x78350f, { rough: 0.9 })); // counter
    // Lantern string.
    for (let k = 0; k < 4; k++) {
      ball(root, 0.34, x - 2.4 + k * 1.6, 3.2, z + 3.1, glow(k % 2 ? 0xfb923c : 0xef4444));
    }
    // Stools.
    for (const dx of [-1.8, 1.4]) {
      cyl(root, 0.5, 0.5, 0.2, x + dx, 0.9, z + 4, stool, 8);
      cyl(root, 0.12, 0.16, 0.9, x + dx, 0.45, z + 4, mat(0x475569, { metal: 0.6, rough: 0.4 }), 6);
    }
    // Steam pot glow.
    ball(root, 0.4, x + 2.2, 1.6, z - 1.2, glow(0xfde68a));
    api.tag(last(root), `Ramen Stall ${i + 1}`, 'Attraction', 'Warung ramen neon di gang kota.');
  }
}

function buildServerFarm(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const cab = mat(0x0f172a, { metal: 0.55, rough: 0.35 });
  const led = [0x22d3ee, 0xa3e635, 0xe879f9];
  for (let i = 0; i < 6; i++) {
    const row = i % 3;
    const col = Math.floor(i / 3);
    const x = 84 + row * 5;
    const z = -38 + col * 8;
    box(root, 3.4, 4.8, 4, x, 2.4, z, cab);
    for (let l = 0; l < 7; l++) {
      box(root, 3.0, 0.22, 0.1, x, 0.8 + l * 0.55, z + 2.05, glow(led[(i + l) % 3]!));
    }
    // Roof cooling fan.
    cyl(root, 1.2, 1.2, 0.4, x, 5.0, z, mat(0x334155, { metal: 0.7, rough: 0.4 }), 12);
  }
  api.label(root, 89, 6.6, -34, 'SERVER FARM', 2.8);
  api.tag(last(root), 'Server Farm', 'Attraction', 'Blok server luar ruangan dengan deretan LED.');
}

function buildDronePort(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const pad = mat(0x1e293b, { rough: 0.8 });
  const mark = glow(0x22d3ee);
  flatDisc(root, 10, 66, 0.14, 62, pad);
  flatDisc(root, 6.4, 66, 0.16, 62, mat(0x0f172a, { rough: 0.9 }));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    flatDisc(root, 2.2, 66 + Math.cos(a) * 5, 0.18, 62 + Math.sin(a) * 5, mark);
  }
  // Docked delivery drones.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    const x = 66 + Math.cos(a) * 5;
    const z = 62 + Math.sin(a) * 5;
    box(root, 1.6, 0.5, 2.6, x, 0.5, z, mat(0x0f172a, { metal: 0.7, rough: 0.4 }), a);
    for (const [rx, rz] of [[-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]] as [number, number][]) {
      cyl(root, 0.5, 0.5, 0.08, x + rx, 0.85, z + rz, mat(0x334155, { metal: 0.6, rough: 0.4 }), 8);
    }
    ball(root, 0.16, x, 0.55, z + 1.3, glow(0xef4444));
  }
  // Beacon mast.
  cyl(root, 0.3, 0.5, 8, 74, 4, 56, mat(0x475569, { metal: 0.7, rough: 0.4 }), 8);
  ball(root, 0.7, 74, 8.4, 56, glow(0xf59e0b));
  api.tag(last(root), 'Drone Port', 'Attraction', 'Pangkalan drone pengantar kota neon.');
}

function buildClubStage(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const deck = mat(0x111827, { rough: 0.6 });
  const truss = mat(0x64748b, { metal: 0.8, rough: 0.35 });
  box(root, 14, 1.4, 8, -24, 0.7, -30, deck);
  // Truss arch.
  for (const x of [-30, -18]) {
    box(root, 0.7, 7, 0.7, x, 3.5, -33, truss);
    box(root, 0.7, 7, 0.7, x, 3.5, -27, truss);
  }
  box(root, 13, 0.7, 0.7, -24, 7.2, -33, truss);
  box(root, 13, 0.7, 0.7, -24, 7.2, -27, truss);
  // Light bars + speakers.
  for (let i = 0; i < 4; i++) {
    ball(root, 0.5, -29 + i * 3.4, 6.6, -33, glow([0x22d3ee, 0xe879f9, 0xf59e0b, 0xa3e635][i]!));
  }
  for (const x of [-30.6, -17.4]) {
    box(root, 1.6, 3.2, 1.6, x, 1.6, -30, mat(0x0b1220, { rough: 0.7 }));
    for (let s = 0; s < 3; s++) ball(root, 0.42, x, 0.8 + s * 1.0, -29.2, mat(0x1e293b, { rough: 0.5 }));
  }
  // DJ booth front.
  box(root, 4.4, 1.2, 1.6, -24, 2.0, -26.6, mat(0x1e293b, { emissive: 0x7c3aed, ei: 0.5, rough: 0.4 }));
  api.label(root, -24, 9.0, -30, 'NEON CLUB', 3.4);
  api.tag(last(root), 'Neon Club Stage', 'Attraction', 'Panggung DJ dengan truss dan lampu neon.');
}

function buildBillboardGarden(root: THREE.Group, isDark: boolean, api: ContentApi): void {
  const hedge = mat(isDark ? 0x14532d : 0x22c55e, { rough: 1 });
  const post = mat(0x334155, { metal: 0.7, rough: 0.4 });
  const ads: [number, string][] = [
    [0x22d3ee, 'SYNTH-COLA'],
    [0xe879f9, 'NEON NOODLE'],
    [0xf59e0b, 'DRONE DELIVERY'],
    [0xa3e635, 'HOLO-CINEMA'],
  ];
  ads.forEach(([color, text], i) => {
    const x = 54 + (i % 2) * 12;
    const z = -10 + Math.floor(i / 2) * 10;
    box(root, 9, 5.6, 0.5, x, 4.4, z, glow(color));
    box(root, 8.4, 5.0, 0.14, x, 4.4, z + 0.32, mat(0x0b1220, { emissive: color, ei: 0.3, rough: 0.3 }));
    for (const dx of [-3.6, 3.6]) cyl(root, 0.22, 0.22, 5.2, x + dx, 2.6, z, post, 8);
    box(root, 6, 1, 2.4, x, 0.5, z + 3, hedge);
    api.tag(last(root), `Billboard: ${text}`, 'Attraction', 'Papan iklan holografik kota cyber.');
  });
}

function buildNeonTunnel(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const frame = mat(0x0f172a, { rough: 0.6, metal: 0.4 });
  const colors = [0x22d3ee, 0xe879f9, 0xf59e0b];
  for (let i = 0; i < 7; i++) {
    const z = 44 + i * 1.8;
    const arch = new THREE.Mesh(new THREE.TorusGeometry(6, 0.35, 6, 24, Math.PI), glow(colors[i % 3]!));
    arch.position.set(56, 0.4, z);
    root.add(arch);
    box(root, 0.7, 1.2, 0.7, 50, 0.6, z, frame);
    box(root, 0.7, 1.2, 0.7, 62, 0.6, z, frame);
  }
  box(root, 13, 0.4, 13.6, 56, 0.12, 50, mat(0x1e293b, { rough: 0.5 }));
  api.tag(last(root), 'Neon Tunnel', 'Attraction', 'Terowongan busur neon pejalan kaki.');
}

function buildRobotPetPark(root: THREE.Group, isDark: boolean, api: ContentApi): void {
  const fence = mat(0x475569, { metal: 0.7, rough: 0.4 });
  const grass = mat(isDark ? 0x14532d : 0x16a34a, { rough: 1 });
  flatDisc(root, 11, 96, 0.12, 60, grass);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    cyl(root, 0.16, 0.16, 1.4, 96 + Math.cos(a) * 11, 0.7, 60 + Math.sin(a) * 11, fence, 6);
  }
  // Hydration station + bone-shaped toy (two blocks + connector).
  box(root, 1.4, 1.0, 1.4, 96, 0.5, 60, mat(0x334155, { metal: 0.6, rough: 0.4 }));
  ball(root, 0.5, 96, 1.2, 60, glow(0x22d3ee));
  box(root, 2.4, 0.5, 0.7, 92, 0.3, 56, mat(0xe879f9, { emissive: 0xe879f9, ei: 0.4, rough: 0.5 }), 0.5);
  api.tag(last(root), 'Robot Pet Park', 'Attraction', 'Taman anjing robot dengan stasiun cairan pendingin.');
}

const CYBER_ITEMS: WorldItem[] = [
  { id: 'holo-arcade', build: buildHoloArcade, colliders: [[-18, -46, 26, 5]] },
  { id: 'skate-park', build: buildSkatePark, colliders: [[-46, 34, 24, 24]] },
  { id: 'ramen-alley', build: buildRamenAlley, colliders: [[44, 30, 7, 5], [53, 30, 7, 5], [62, 30, 7, 5]] },
  { id: 'server-farm', build: buildServerFarm, colliders: [[84, -38, 15, 5], [84, -30, 15, 5]] },
  { id: 'drone-port', build: buildDronePort, colliders: [[66, 62, 20, 20]] },
  { id: 'club-stage', build: buildClubStage, colliders: [[-24, -30, 14, 9]] },
  { id: 'billboard-garden', build: buildBillboardGarden, colliders: [[54, -10, 9, 1], [66, -10, 9, 1], [54, 0, 9, 1], [66, 0, 9, 1]] },
  { id: 'neon-tunnel', build: buildNeonTunnel, colliders: [] },
  { id: 'robot-pet-park', build: buildRobotPetPark, colliders: [[96, 60, 3, 3]] },
];

/* =================================================================== */
/*                        TROPICAL PARADISE                             */
/* =================================================================== */

function buildVolleyCourt(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const sand = mat(0xe8cf97, { rough: 1 });
  const line = mat(0xffffff, { rough: 0.7 });
  box(root, 16, 0.3, 9, 66, 0.16, -34, sand);
  // Boundary lines.
  for (const dz of [-4.2, 4.2]) box(root, 16, 0.06, 0.16, 66, 0.34, -34 + dz, line);
  for (const dx of [-7.7, 7.7]) box(root, 0.16, 0.06, 8.6, 66 + dx, 0.34, -34, line);
  // Net.
  for (const dx of [-8.4, 8.4]) cyl(root, 0.12, 0.14, 3.2, 66 + dx, 1.6, -34, mat(0xffffff, { rough: 0.5 }), 8);
  const net = new THREE.Mesh(new THREE.PlaneGeometry(16.6, 1.1), new THREE.MeshStandardMaterial({ color: 0xf1f5f9, wireframe: true, transparent: true, opacity: 0.85 }));
  net.position.set(66, 2.6, -34);
  root.add(net);
  // Ball + sand flags.
  ball(root, 0.45, 71, 0.6, -30, mat(0xfde68a, { rough: 0.6 }));
  pennant(root, 57, 0.3, -38, 0x22c55e, mat(0x92400e, { rough: 1 }));
  pennant(root, 75, 0.3, -30, 0xf97316, mat(0x92400e, { rough: 1 }));
  api.tag(last(root), 'Beach Volleyball', 'Attraction', 'Lapangan voli pantai dengan net dan bendera.');
}

function buildTikiBar(root: THREE.Group, isDark: boolean, api: ContentApi): void {
  const wood = mat(isDark ? 0x5b4426 : 0xa16207, { rough: 0.9 });
  const thatch = mat(0xd6b46a, { rough: 1 });
  const bamboo = mat(0x84cc16, { rough: 0.85 });
  // Bar counter (curved via segments).
  for (let i = 0; i < 7; i++) {
    const a = -0.9 + (i / 6) * 1.8;
    box(root, 2.2, 1.3, 1.1, 52 + Math.sin(a) * 5.6, 0.65, 34 + Math.cos(a) * 2.4, wood, a);
  }
  // Roof on four bamboo poles.
  for (const [dx, dz] of [[-5, -3], [5, -3], [-5, 3], [5, 3]] as [number, number][]) {
    cyl(root, 0.18, 0.22, 4.4, 52 + dx, 2.2, 34 + dz, bamboo, 8);
  }
  const roof = cone(root, 8, 3.4, 52, 5.6, 34, thatch, 10);
  roof.scale.z = 0.7;
  // Bottles on the shelf + string lights.
  for (let i = 0; i < 8; i++) {
    ball(root, 0.24, 49 + i * 0.86, 1.7, 32.4, glow([0x22d3ee, 0xf472b6, 0xfde68a][i % 3]!));
  }
  for (let i = 0; i < 6; i++) ball(root, 0.16, 47.4 + i * 1.9, 4.0, 36.6, glow(i % 2 ? 0xfde68a : 0xfda4af));
  // Stools.
  for (const dx of [-3.4, -1.2, 1.2, 3.4]) {
    cyl(root, 0.42, 0.42, 0.2, 52 + dx, 0.9, 37.4, mat(0xef4444, { rough: 0.7 }), 8);
    cyl(root, 0.1, 0.14, 0.9, 52 + dx, 0.45, 37.4, wood, 6);
  }
  api.label(root, 52, 7.4, 34, 'TIKI BAR', 2.6);
  api.tag(last(root), 'Tiki Bar', 'Attraction', 'Bar tikar atap alang-alang dengan lampu tali.');
}

function buildSurfStand(root: THREE.Group, isDark: boolean, api: ContentApi): void {
  const rack = mat(isDark ? 0x5b4426 : 0xa16207, { rough: 0.9 });
  const boardColors = [0xef4444, 0xf59e0b, 0x22d3ee, 0xf472b6, 0x84cc16];
  // Rack of surfboards.
  box(root, 0.5, 3.2, 6, 14, 1.6, 56, rack);
  for (let i = 0; i < 5; i++) {
    const z = 53.6 + i * 1.2;
    const board = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 2.4, 4, 8), mat(boardColors[i]!, { rough: 0.5 }));
    board.position.set(15.2 + (i % 2) * 0.5, 1.7, z);
    board.rotation.set(0.12, 0, -0.14);
    root.add(board);
  }
  // Stand-up paddle leaning on the rack.
  const paddle = cyl(root, 0.07, 0.07, 3.4, 13.2, 1.7, 59.2, mat(0xfde68a, { rough: 0.7 }), 6);
  paddle.rotation.z = 0.3;
  // Umbrella.
  cyl(root, 0.1, 0.1, 3.6, 11, 1.8, 53, mat(0x92400e, { rough: 1 }), 6);
  const umb = cone(root, 2.6, 1.2, 11, 3.8, 53, mat(0xf97316, { rough: 0.8 }), 10);
  umb.scale.z = 1;
  api.tag(last(root), 'Surf Stand', 'Attraction', 'Rak papan selancar warna-warni di bawah payung.');
}

function buildPier(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const plank = mat(0xcdb79e, { rough: 0.95 });
  const post = mat(0x78350f, { rough: 1 });
  const rope = mat(0xd6b46a, { rough: 1 });
  box(root, 24, 0.6, 4.4, 96, 1.0, 12, plank);
  for (let i = 0; i <= 7; i++) {
    const x = 84 + i * 3.4;
    for (const dz of [-1.9, 1.9]) {
      cyl(root, 0.24, 0.3, 3.4, x, -0.6, 12 + dz, post, 7);
      if (i % 2 === 0) cyl(root, 0.06, 0.06, 1.0, x, 1.8, 12 + dz, rope, 5);
    }
  }
  // Rope rails.
  for (const dz of [-1.9, 1.9]) {
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 24), rope);
    rail.rotation.z = Math.PI / 2;
    rail.position.set(96, 1.9, 12 + dz);
    root.add(rail);
  }
  // Fisher's crate + bucket + dangling line.
  box(root, 1.6, 1, 1.4, 104, 1.8, 12, mat(0xb45309, { rough: 0.9 }));
  cyl(root, 0.4, 0.34, 0.7, 101, 1.7, 13, mat(0x94a3b8, { metal: 0.6, rough: 0.4 }), 10);
  const line = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 3), rope);
  line.position.set(107, 0.4, 12);
  root.add(line);
  api.tag(last(root), 'Fisher Pier', 'Attraction', 'Dermaga kayu untuk memancing dan memandang laut.');
}

function buildTurtleSanctuary(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const sand = mat(0xe6d8ad, { rough: 1 });
  const fence = mat(0x92400e, { rough: 1 });
  box(root, 16, 0.28, 12, 80, 0.16, 68, sand);
  for (let i = 0; i < 16; i++) {
    const t = i / 16;
    let x: number;
    let z: number;
    if (t < 0.4) {
      x = 72 + (t / 0.4) * 16;
      z = 62;
    } else if (t < 0.65) {
      x = 88;
      z = 62 + ((t - 0.4) / 0.25) * 12;
    } else if (t < 0.9) {
      x = 88 - ((t - 0.65) / 0.25) * 16;
      z = 74;
    } else {
      x = 72;
      z = 74 - ((t - 0.9) / 0.1) * 12;
    }
    cyl(root, 0.14, 0.16, 1.2, x, 0.6, z, fence, 6);
  }
  // Little shelter + heat lamp.
  box(root, 4, 0.4, 3, 76, 1.6, 64, mat(0xd6b46a, { rough: 1 }));
  for (const [dx, dz] of [[-1.7, -1.2], [1.7, -1.2], [-1.7, 1.2], [1.7, 1.2]] as [number, number][]) {
    cyl(root, 0.1, 0.1, 1.5, 76 + dx, 0.75, 64 + dz, fence, 6);
  }
  ball(root, 0.3, 83, 0.5, 65, glow(0xfbbf24));
  api.tag(last(root), 'Turtle Sanctuary', 'Attraction', 'Penangkaran kura-kura berpagar pasir.');
}

function buildHammockGrove(root: THREE.Group, isDark: boolean, api: ContentApi): void {
  const trunk = mat(isDark ? 0x5b4426 : 0x92400e, { rough: 1 });
  const cloth = [0xf9a8d4, 0xa5b4fc, 0xfde68a, 0x86efac];
  for (let i = 0; i < 4; i++) {
    const x = -46 + (i % 2) * 11;
    const z = 26 + Math.floor(i / 2) * 9;
    cyl(root, 0.3, 0.42, 4.4, x, 2.2, z, trunk, 8);
    cyl(root, 0.3, 0.42, 4.4, x + 7, 2.2, z, trunk, 8);
    const hammock = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 7, 8, 1, true, 0, Math.PI), mat(cloth[i]!, { rough: 0.9, transparent: true, opacity: 0.95 }));
    hammock.position.set(x + 3.5, 2.3, z);
    hammock.rotation.z = Math.PI / 2;
    hammock.rotation.y = Math.PI / 2;
    root.add(hammock);
    ball(root, 1.6, x + 3.5, 5.6, z, mat(0x4ade80, { rough: 0.95 }), 1.6, 0.7, 1.6);
  }
  api.tag(last(root), 'Hammock Grove', 'Attraction', 'Gugusan hammock di bawah naungan pohon.');
}

function buildLighthouse(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const white = mat(0xf8fafc, { rough: 0.7 });
  const red = mat(0xef4444, { rough: 0.7 });
  for (let i = 0; i < 6; i++) {
    const h = 2.6;
    const r0 = 3.4 - i * 0.38;
    cyl(root, r0 - 0.3, r0, h, -44, 1.3 + i * h, -40, i % 2 === 0 ? white : red, 16);
  }
  cyl(root, 2.4, 2.4, 0.6, -44, 17.4, -40, mat(0x475569, { metal: 0.6, rough: 0.4 }), 16);
  ball(root, 1.7, -44, 19.2, -40, glow(0xfde68a));
  cone(root, 2.6, 2.4, -44, 21.6, -40, red, 12);
  // Door + spiral hint.
  box(root, 1.4, 2.2, 0.4, -44, 1.1, -36.7, mat(0x78350f, { rough: 0.9 }));
  api.label(root, -44, 15.2, -40, 'LIGHTHOUSE', 2.4);
  api.tag(last(root), 'Lighthouse', 'Attraction', 'Mercusuar pita merah-putih di tepi pulau.');
}

function buildKiteAndFruitStand(root: THREE.Group, isDark: boolean, api: ContentApi): void {
  const stall = mat(isDark ? 0x5b4426 : 0xb45309, { rough: 0.9 });
  const kite = [0xef4444, 0x22d3ee, 0xfde68a, 0xa855f7];
  box(root, 6, 2.6, 4, 14, 1.3, -42, stall);
  box(root, 6.6, 0.35, 4.6, 14, 2.8, -42, mat(0xf97316, { rough: 0.85 }));
  // Pineapple crates.
  for (let i = 0; i < 3; i++) {
    box(root, 1.6, 0.8, 1.6, 11.6 + i * 1.7, 0.4, -38.6, mat(0x84cc16, { rough: 0.9 }));
    ball(root, 0.4, 11.6 + i * 1.7, 1.1, -38.6, mat(0xfde68a, { rough: 0.7 }));
  }
  // Kites stuck in the sand.
  for (let i = 0; i < 4; i++) {
    const x = 19 + (i % 2) * 4;
    const z = -45 + Math.floor(i / 2) * 4;
    cyl(root, 0.05, 0.05, 2.4, x, 1.2, z, mat(0x78350f, { rough: 1 }), 5);
    const k = new THREE.Mesh(new THREE.OctahedronGeometry(0.9), mat(kite[i]!, { rough: 0.7 }));
    k.position.set(x + 0.4, 3.4, z);
    k.scale.y = 1.5;
    root.add(k);
  }
  api.tag(last(root), 'Kite & Fruit Stand', 'Attraction', 'Layang-layang dan buah tropis segar.');
}

function buildBeachBonfire(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const stone = mat(0x78716c, { rough: 1 });
  const log = mat(0x57534e, { rough: 1 });
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    ball(root, 0.7, 44 + Math.cos(a) * 3.4, 0.5, 68 + Math.sin(a) * 3.4, stone, 1, 0.7, 1);
  }
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const l = cyl(root, 0.32, 0.32, 3.2, 44 + Math.cos(a) * 0.7, 1.1, 68 + Math.sin(a) * 0.7, log, 7);
    l.rotation.set(Math.PI / 2.6, a, 0);
  }
  const flame = cone(root, 1.1, 2.6, 44, 2.4, 68, glow(0xf97316), 8);
  flame.scale.y = 1.2;
  cone(root, 0.6, 1.6, 44, 2.2, 68, glow(0xfde68a), 8);
  api.tag(flame, 'Beach Bonfire', 'Attraction', 'Perapian driftwood untuk malam pantai.');
}

const TROPICAL_ITEMS: WorldItem[] = [
  { id: 'volley', build: buildVolleyCourt, colliders: [[66, -34, 16, 9]] },
  { id: 'tiki-bar', build: buildTikiBar, colliders: [[52, 34, 13, 7]] },
  { id: 'surf-stand', build: buildSurfStand, colliders: [[14, 56, 4, 8]] },
  { id: 'pier', build: buildPier, colliders: [[96, 12, 24, 4]] },
  { id: 'turtle-sanctuary', build: buildTurtleSanctuary, colliders: [[80, 68, 16, 12]] },
  { id: 'hammock-grove', build: buildHammockGrove, colliders: [[-40, 30, 18, 18]] },
  { id: 'lighthouse', build: buildLighthouse, colliders: [[-44, -40, 7, 7]] },
  { id: 'kite-fruit', build: buildKiteAndFruitStand, colliders: [[14, -42, 7, 5]] },
  { id: 'bonfire', build: buildBeachBonfire, colliders: [[44, 68, 7, 7]] },
];

/* =================================================================== */
/*                             TOYBOX WORLD                             */
/* =================================================================== */

function buildTrainLoop(root: THREE.Group, isDark: boolean, api: ContentApi): void {
  const rail = mat(0x94a3b8, { metal: 0.7, rough: 0.4 });
  const tie = mat(isDark ? 0x3f3f46 : 0x8b5e3c, { rough: 0.9 });
  const cx = 64;
  const cz = -36;
  const R = 17;
  // Ties + rails around a big loop.
  for (let i = 0; i < 44; i++) {
    const a = (i / 44) * Math.PI * 2;
    const x = cx + Math.cos(a) * R;
    const z = cz + Math.sin(a) * (R - 5);
    box(root, 1.6, 0.16, 3.6, x, 0.2, z, tie, -a);
  }
  for (const off of [-1.1, 1.1]) {
    const railGeo = new THREE.TorusGeometry(R, 0.12, 5, 60);
    const railMesh = new THREE.Mesh(railGeo, rail);
    railMesh.position.set(cx, 0.42, cz);
    railMesh.rotation.x = Math.PI / 2;
    railMesh.scale.z = (R - 5) / R;
    railMesh.position.z = cz;
    root.add(railMesh);
    void off;
  }
  // Engine + two cars on the near side.
  const train = [0xef4444, 0xf59e0b, 0x3b82f6];
  for (let i = 0; i < 3; i++) {
    const a = -0.5 - i * 0.36;
    const x = cx + Math.cos(a) * R;
    const z = cz + Math.sin(a) * (R - 5);
    box(root, 4.4, 2.2, 2.6, x, 1.5, z, mat(train[i]!, { rough: 0.5 }), -a + Math.PI / 2);
    if (i === 0) cyl(root, 0.5, 0.6, 1.4, x, 3.3, z, mat(0x334155, { metal: 0.5, rough: 0.5 }), 8);
    for (const dx of [-1.4, 1.4]) {
      cyl(root, 0.5, 0.5, 0.3, x + Math.cos(-a) * dx, 0.6, z + Math.sin(-a) * dx, mat(0x111827, { rough: 0.6 }), 10).rotation.z = Math.PI / 2;
    }
  }
  // Station shed.
  box(root, 7, 4, 5, cx + 6, 2, cz + 20, mat(0xf472b6, { rough: 0.7 }));
  const roof = cone(root, 5.4, 2.6, cx + 6, 5.3, cz + 20, mat(0xef4444, { rough: 0.8 }), 4);
  roof.rotation.y = Math.PI / 4;
  box(root, 1.6, 2.4, 0.3, cx + 6, 1.2, cz + 22.6, mat(0x8b5e3c, { rough: 0.9 }));
  api.label(root, cx + 6, 7.6, cz + 20, 'TOY STATION', 2.4);
  api.tag(last(root), 'Toy Train Circuit', 'Attraction', 'Lintasan kereta mainan melingkar dengan stasiun.');
}

function buildGiantSandbox(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const frame = mat(0xf59e0b, { rough: 0.8 });
  const sand = mat(0xf2dfae, { rough: 1 });
  box(root, 20, 1.4, 1.6, 44, 0.7, 30, frame);
  box(root, 20, 1.4, 1.6, 44, 0.7, 50, frame);
  box(root, 1.6, 1.4, 19, 34, 0.7, 40, frame);
  box(root, 1.6, 1.4, 19, 54, 0.7, 40, frame);
  box(root, 19, 0.4, 18, 44, 0.4, 40, sand);
  // Sandcastle + bucket + shovel.
  box(root, 3.2, 2.4, 3.2, 44, 1.6, 40, sand);
  cone(root, 1.6, 2, 44, 3.8, 40, sand, 6);
  cyl(root, 1.0, 0.8, 1.4, 39, 1.3, 44, mat(0xef4444, { rough: 0.7 }), 10);
  const shovel = cyl(root, 0.1, 0.1, 2.6, 50, 1.4, 45, mat(0x3b82f6, { rough: 0.7 }), 6);
  shovel.rotation.z = 0.6;
  api.tag(last(root), 'Giant Sandbox', 'Attraction', 'Kotak pasir raksasa dengan istana pasir.');
}

function buildMarbleRun(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const wood = mat(0xf59e0b, { rough: 0.8 });
  const chutes = [0xef4444, 0x3b82f6, 0x22c55e, 0xa855f7];
  // Tall tower with zigzag slides.
  box(root, 6, 1, 6, 14, 0.5, -46, wood);
  for (let i = 0; i < 5; i++) {
    const y = 1.6 + i * 2.6;
    box(root, 5.4 - i * 0.5, 2.2, 5.4 - i * 0.5, 14, y + 1.1, -46, mat([0xef4444, 0xf59e0b, 0xfacc15, 0x22c55e, 0x3b82f6][i]!, { rough: 0.6 }));
    const slide = box(root, 6.5, 0.4, 1.2, 14 + (i % 2 === 0 ? 4 : -4), y + 0.6, -46 + (i % 2 === 0 ? 1.6 : -1.6), mat(chutes[i % 4]!, { rough: 0.5 }), 0);
    slide.rotation.z = i % 2 === 0 ? -0.35 : 0.35;
    ball(root, 0.55, 14 + (i % 2 === 0 ? 6.4 : -6.4), y + 1.9, -46 + (i % 2 === 0 ? 1.6 : -1.6), glow(chutes[(i + 1) % 4]!));
  }
  cone(root, 3, 2.4, 14, 15.6, -46, mat(0xf472b6, { rough: 0.7 }), 8);
  api.tag(last(root), 'Marble Run Tower', 'Attraction', 'Menara lintasan kelereng berwarna pelangi.');
}

function buildBallPit(root: THREE.Group, isDark: boolean, api: ContentApi): void {
  const wall = mat(0xf472b6, { rough: 0.7 });
  const balls = [0xef4444, 0xfde68a, 0x60a5fa, 0x4ade80, 0xa855f7];
  box(root, 18, 2.2, 2, 76, 1.1, 40, wall);
  box(root, 18, 2.2, 2, 76, 1.1, 54, wall);
  box(root, 2, 2.2, 12, 67, 1.1, 47, wall);
  box(root, 2, 2.2, 12, 85, 1.1, 47, wall);
  box(root, 18, 0.5, 14, 76, 0.5, 47, mat(isDark ? 0x1e293b : 0xdbeafe, { rough: 0.9 }));
  // Heaps of coloured balls.
  let n = 0;
  for (let gx = 0; gx < 9; gx++) {
    for (let gz = 0; gz < 7; gz++) {
      const x = 69 + gx * 1.75;
      const z = 41.5 + gz * 1.85;
      ball(root, 0.62, x, 1.1 + ((gx + gz) % 3) * 0.3, z, mat(balls[n % 5]!, { rough: 0.4 }));
      n++;
    }
  }
  // Slide into the pit.
  const slide = box(root, 4, 0.5, 8, 76, 2.4, 57.4, mat(0xfde68a, { rough: 0.5 }));
  slide.rotation.x = -0.44;
  api.tag(last(root), 'Ball Pit', 'Attraction', 'Kolam bola raksasa dengan seluncuran.');
}

function buildSeesawsAndSwings(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const wood = mat(0x92400e, { rough: 0.9 });
  const bright = [0xef4444, 0x3b82f6, 0x22c55e];
  for (let i = 0; i < 2; i++) {
    const x = -20 + i * 9;
    const z = 54;
    cyl(root, 0.5, 0.7, 1.2, x, 0.6, z, wood, 8);
    const plank = box(root, 7.5, 0.4, 1.2, x, 1.5, z, mat(bright[i]!, { rough: 0.6 }));
    plank.rotation.z = i === 0 ? 0.18 : -0.2;
    ball(root, 0.5, x + 3.6, 1.9 + (i === 0 ? 0.6 : -0.6), z, mat(0xfde68a, { rough: 0.6 }));
    ball(root, 0.5, x - 3.6, 1.9 + (i === 0 ? -0.6 : 0.6), z, mat(0xfde68a, { rough: 0.6 }));
  }
  // A-frame swings.
  const ax = -6;
  const az = 58;
  for (const dx of [-4, 4]) {
    for (const s of [-1, 1]) {
      const leg = cyl(root, 0.16, 0.2, 5, ax + dx + s * 1.2, 2.4, az, mat(0x3b82f6, { rough: 0.7 }), 7);
      leg.rotation.z = s * 0.42;
    }
  }
  box(root, 9.6, 0.3, 0.4, ax, 4.9, az, mat(0x3b82f6, { rough: 0.7 }));
  for (const dx of [-2.2, 2.2]) {
    for (const s of [-1, 1]) cyl(root, 0.05, 0.05, 3, ax + dx + s * 0.55, 3.3, az, mat(0x94a3b8, { metal: 0.6, rough: 0.4 }), 5);
    box(root, 1.6, 0.2, 0.7, ax + dx, 1.85, az, mat(bright[2]!, { rough: 0.6 }));
  }
  api.tag(last(root), 'Seesaws & Swings', 'Attraction', 'Jungkat-jungkit dan ayunan taman bermain.');
}

function buildPuppetTheater(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const stage = mat(0xdc2626, { rough: 0.7 });
  const gold = mat(0xfcd34d, { metal: 0.5, rough: 0.4 });
  const curtain = mat(0xfef3c7, { rough: 0.9 });
  box(root, 14, 1.2, 9, -46, 0.6, -6, stage);
  box(root, 14, 7, 1.4, -46, 4.4, -10, mat(0xef4444, { rough: 0.7 }));
  box(root, 10, 4.6, 0.3, -46, 3.6, -9.2, mat(0x78350f, { rough: 0.9 }));
  // Proscenium + curtains.
  for (const dx of [-6.6, 6.6]) box(root, 1.4, 7.6, 1.8, -46 + dx, 4.4, -6, gold);
  box(root, 15, 1.2, 2, -46, 8.2, -6, gold);
  for (const dx of [-4.4, 4.4]) box(root, 2.4, 5, 0.3, -46 + dx, 4.2, -8.9, curtain);
  // Puppet characters on the stage (wooden blocks with heads).
  for (const dx of [-2, 2]) {
    box(root, 1.2, 1.6, 0.8, -46 + dx, 2.0, -5, mat(dx > 0 ? 0x60a5fa : 0xf472b6, { rough: 0.6 }));
    ball(root, 0.6, -46 + dx, 3.3, -5, mat(0xfde68a, { rough: 0.6 }));
  }
  // Audience bench rows.
  for (let r = 0; r < 2; r++) {
    box(root, 10, 0.5, 1.2, -46, 0.6 + r * 0.4, -1.6 + r * 3, wood());
  }
  api.label(root, -46, 9.6, -6, 'PUPPET SHOW', 2.6);
  api.tag(last(root), 'Puppet Theater', 'Attraction', 'Panggung wayang kayu dengan gordyn emas.');
}

function wood(): THREE.MeshStandardMaterial {
  return mat(0xa16207, { rough: 0.9 });
}

function buildFerrisWheel(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const frame = mat(0xf87171, { rough: 0.6, metal: 0.2 });
  const gondola = [0xef4444, 0xfde68a, 0x60a5fa, 0x4ade80, 0xa855f7, 0xf472b6];
  const cx = 100;
  const cz = -10;
  // Legs.
  for (const s of [-1, 1]) {
    const leg = cyl(root, 0.4, 0.6, 14, cx + s * 5, 7, cz, frame, 8);
    leg.rotation.z = -s * 0.36;
  }
  // Big ring.
  const ring = new THREE.Mesh(new THREE.TorusGeometry(9, 0.5, 6, 40), frame);
  ring.position.set(cx, 14, cz);
  root.add(ring);
  const hub = cyl(root, 0.9, 0.9, 1.4, cx, 14, cz, mat(0xfde68a, { rough: 0.5 }), 12);
  hub.rotation.x = Math.PI / 2;
  // Spokes + gondolas.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 18), frame);
    spoke.position.set(cx, 14, cz);
    spoke.rotation.z = a + Math.PI / 2;
    root.add(spoke);
    box(root, 1.7, 1.5, 1.7, cx + Math.cos(a) * 9, 14 + Math.sin(a) * 9, cz, mat(gondola[i % 6]!, { rough: 0.6 }));
  }
  api.tag(last(root), 'Toy Ferris Wheel', 'Attraction', 'Bianglala mainan dengan delapan gondola pelangi.');
}

function buildBlockCastle(root: THREE.Group, isDark: boolean, api: ContentApi): void {
  const colors = [0xef4444, 0x3b82f6, 0xfacc15, 0x22c55e, 0xa855f7];
  const cx = 96;
  const cz = 64;
  // Four corner towers of stacked blocks + keep in the middle.
  const corners: [number, number][] = [[-8, -6], [8, -6], [-8, 6], [8, 6]];
  corners.forEach(([dx, dz], i) => {
    for (let s = 0; s < 4; s++) {
      const size = 5.4 - s * 0.5;
      box(root, size, 2.4, size, cx + dx, 1.2 + s * 2.4, cz + dz, mat(colors[(i + s) % 5]!, { rough: 0.6 }), (s % 2) * 0.16);
    }
    cone(root, 3, 2.6, cx + dx, 11.4, cz + dz, mat(colors[(i + 2) % 5]!, { rough: 0.7 }), 6);
  });
  box(root, 10, 6, 7, cx, 3, cz, mat(colors[isDark ? 4 : 0]!, { rough: 0.6 }));
  // Gate arch.
  box(root, 4, 4.5, 1.4, cx, 2.25, cz - 4.4, mat(0x78350f, { rough: 0.9 }));
  ball(root, 1.2, cx, 7.4, cz, glow(0xfde68a));
  pennant(root, cx, 6, cz - 4.4, 0xef4444, mat(0x64748b, { metal: 0.5, rough: 0.4 }));
  api.label(root, cx, 13.6, cz, 'BLOCK CASTLE', 2.6);
  api.tag(last(root), 'Block Castle', 'Attraction', 'Istana balok raksasa dengan menara bertumpuk.');
}

function buildRockingHorses(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const body = [0xf59e0b, 0xf472b6, 0x60a5fa];
  const rock = mat(0x92400e, { rough: 0.9 });
  for (let i = 0; i < 3; i++) {
    const x = 31 + i * 5;
    const z = 68;
    // Rocker arc.
    const arc = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.16, 5, 14, Math.PI), rock);
    arc.position.set(x, 0.5, z);
    arc.rotation.y = Math.PI / 2;
    root.add(arc);
    box(root, 2.6, 1, 0.9, x, 1.4, z, mat(body[i]!, { rough: 0.6 }));
    ball(root, 0.7, x + 1.3, 2.1, z, mat(body[i]!, { rough: 0.6 }), 1.2, 1, 0.9);
    box(root, 0.3, 0.6, 0.3, x - 0.6, 2.1, z, rock);
    cone(root, 0.3, 0.6, x + 1.7, 2.6, z, mat(0x111827, { rough: 0.7 }), 5).rotation.z = -0.5;
  }
  api.tag(last(root), 'Rocking Horses', 'Attraction', 'Deretan kuda-kuda goyang kayu warna-warni.');
}

const TOYBOX_ITEMS: WorldItem[] = [
  { id: 'train-loop', build: buildTrainLoop, colliders: [[64, -36, 36, 36]] },
  { id: 'sandbox', build: buildGiantSandbox, colliders: [[44, 40, 20, 19]] },
  { id: 'marble-run', build: buildMarbleRun, colliders: [[14, -46, 6, 6]] },
  { id: 'ball-pit', build: buildBallPit, colliders: [[76, 47, 18, 14]] },
  { id: 'seesaws', build: buildSeesawsAndSwings, colliders: [[-16, 54, 16, 4], [-6, 58, 9, 3]] },
  { id: 'puppet-theater', build: buildPuppetTheater, colliders: [[-46, -6, 14, 11]] },
  { id: 'ferris', build: buildFerrisWheel, colliders: [[100, -10, 11, 4]] },
  { id: 'block-castle', build: buildBlockCastle, colliders: [[96, 64, 22, 16]] },
  { id: 'rocking-horses', build: buildRockingHorses, colliders: [[36, 68, 14, 3]] },
];

/* =================================================================== */
/*                          SPACE COLONY                                */
/* =================================================================== */

function buildDockingBay(root: THREE.Group, isDark: boolean, api: ContentApi): void {
  const hull = mat(0xcbd5e1, { metal: 0.65, rough: 0.35 });
  const dark = mat(0x1e293b, { metal: 0.5, rough: 0.4 });
  const strip = glow(0x38bdf8);
  // Hangar arch.
  const arch = new THREE.Mesh(new THREE.TorusGeometry(11, 1.2, 8, 26, Math.PI), hull);
  arch.position.set(66, 0.4, -46);
  root.add(arch);
  box(root, 24, 0.6, 24, 66, 0.3, -38, mat(isDark ? 0x334155 : 0x94a3b8, { rough: 0.8 }));
  for (const dx of [-11, 11]) {
    box(root, 1.6, 8, 2, 66 + dx, 4, -46, dark);
    box(root, 0.4, 6, 0.4, 66 + dx, 4, -44.8, strip);
  }
  // Shuttle nose poking out of the bay.
  const nose = new THREE.Mesh(new THREE.ConeGeometry(3.4, 9, 12), hull);
  nose.position.set(66, 3.6, -36);
  nose.rotation.x = Math.PI / 2.2;
  root.add(nose);
  box(root, 5, 3.4, 6, 66, 2.4, -43, hull);
  for (const dx of [-3.4, 3.4]) {
    const fin = box(root, 0.6, 2.6, 3, 66 + dx, 1.6, -45, mat(0xef4444, { rough: 0.6 }));
    fin.rotation.z = dx > 0 ? -0.4 : 0.4;
  }
  // Cargo crates.
  for (let i = 0; i < 5; i++) {
    box(root, 2.2, 2.2, 2.2, 56 + (i % 3) * 2.6, 1.1 + Math.floor(i / 3) * 2.3, -30, mat(i % 2 ? 0xf59e0b : 0x64748b, { metal: 0.5, rough: 0.5 }), i * 0.3);
  }
  // Floodlights.
  for (const [fx, fz] of [[54, -48], [78, -48]] as [number, number][]) {
    cyl(root, 0.2, 0.3, 7, fx, 3.5, fz, dark, 8);
    ball(root, 0.8, fx, 7.4, fz, glow(0xfef9c3));
  }
  api.label(root, 66, 13.6, -46, 'DOCKING BAY', 3.2);
  api.tag(last(root), 'Docking Bay', 'Attraction', 'Hangar dok dengan hidung pesawat dan peti kargo.');
}

function buildBiodome(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const frame = mat(0xe2e8f0, { metal: 0.7, rough: 0.3 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0xa5f3fc,
    transparent: true,
    opacity: 0.22,
    roughness: 0.1,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  // Dome + meridian ribs.
  const dome = new THREE.Mesh(new THREE.SphereGeometry(12, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2), glass);
  dome.position.set(64, 0.4, 40);
  root.add(dome);
  for (let i = 0; i < 6; i++) {
    const rib = new THREE.Mesh(new THREE.TorusGeometry(12, 0.18, 5, 30, Math.PI), frame);
    rib.position.set(64, 0.4, 40);
    rib.rotation.y = (i / 6) * Math.PI;
    root.add(rib);
  }
  const base = new THREE.Mesh(new THREE.TorusGeometry(12, 0.6, 6, 40), frame);
  base.position.set(64, 0.4, 40);
  base.rotation.x = Math.PI / 2;
  root.add(base);
  // Hydroponic plant rows inside.
  const soil = mat(0x3f6212, { rough: 1 });
  const leaf = mat(0x4ade80, { emissive: 0x22c55e, ei: 0.2, rough: 0.8 });
  for (let r = 0; r < 4; r++) {
    const z = 34 + r * 4;
    box(root, 16, 0.6, 1.4, 64, 1.0, z, soil);
    for (let p = 0; p < 7; p++) {
      ball(root, 0.6, 57.5 + p * 2.2, 1.9, z, leaf, 1, 1.3, 1);
      ball(root, 0.22, 57.5 + p * 2.2, 2.8, z, glow(p % 2 ? 0xf472b6 : 0xfde68a));
    }
  }
  api.tag(last(root), 'Hydroponic Biodome', 'Attraction', 'Kubah kaca dengan barisan sayuran hidroponik.');
}

function buildRoverGarage(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const shed = mat(0x64748b, { metal: 0.6, rough: 0.4 });
  const rover = mat(0xf8fafc, { metal: 0.4, rough: 0.5 });
  const tire = mat(0x111827, { rough: 0.8 });
  // Open shed.
  box(root, 12, 0.5, 9, 26, 4.6, 58, shed);
  for (const [dx, dz] of [[-5.5, -4], [5.5, -4], [-5.5, 4], [5.5, 4]] as [number, number][]) {
    box(root, 0.7, 4.6, 0.7, 26 + dx, 2.3, 58 + dz, shed);
  }
  box(root, 12, 0.3, 9, 26, 0.16, 58, mat(0x334155, { rough: 0.9 }));
  // Rover body + mast + wheels.
  box(root, 5, 1.8, 7, 26, 1.6, 58, rover);
  box(root, 4, 1, 4, 26, 3.0, 59, mat(0x0f172a, { metal: 0.6, rough: 0.4 }));
  cyl(root, 0.12, 0.12, 2.4, 27.4, 4.6, 57, shed, 6);
  ball(root, 0.5, 27.4, 5.9, 57, glow(0x38bdf8));
  for (const dx of [-2.7, 2.7]) {
    for (const dz of [-2.4, 0, 2.4]) {
      const w = cyl(root, 0.9, 0.9, 0.7, 26 + dx, 0.9, 58 + dz, tire, 12);
      w.rotation.z = Math.PI / 2;
    }
  }
  // Tool rack + spare wheels.
  box(root, 0.6, 3, 6, 32.4, 1.5, 58, shed);
  for (let i = 0; i < 3; i++) {
    const sp = cyl(root, 1, 1, 0.5, 33.4, 1 + i * 0.1, 55 + i * 3, tire, 12);
    sp.rotation.x = Math.PI / 2;
  }
  api.tag(last(root), 'Rover Garage', 'Attraction', 'Garasi rover bulan dengan tiang antena.');
}

function buildCryoRow(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const shell = mat(0xe2e8f0, { metal: 0.55, rough: 0.3 });
  const glowLine = glow(0x38bdf8);
  for (let i = 0; i < 4; i++) {
    const x = -52 + i * 4.4;
    const z = 30;
    const pod = new THREE.Mesh(new THREE.CapsuleGeometry(1.4, 2.6, 6, 12), shell);
    pod.position.set(x, 2.0, z);
    pod.rotation.z = Math.PI / 2;
    pod.rotation.y = 0.06;
    root.add(pod);
    // Window strip + frost light.
    box(root, 2.6, 1.0, 0.12, x, 2.4, z + 1.4, mat(0x93c5fd, { emissive: 0x60a5fa, ei: 0.6, rough: 0.2, transparent: true, opacity: 0.85 }));
    box(root, 3.4, 0.2, 0.2, x, 0.6, z + 1.6, glowLine);
    // Pedestal.
    cyl(root, 1.9, 2.2, 0.7, x, 0.35, z, mat(0x475569, { metal: 0.7, rough: 0.4 }), 12);
  }
  // Control console.
  box(root, 3.4, 1.6, 1.4, -54, 0.9, 34, mat(0x1e293b, { metal: 0.6, rough: 0.4 }), 0.3);
  box(root, 3, 1.0, 0.14, -54, 1.9, 34.5, glow(0x22d3ee));
  api.label(root, -45, 6.6, 30, 'CRYO BAY', 2.4);
  api.tag(last(root), 'Cryo Pods', 'Attraction', 'Deretan kapsul tidur beku dengan lampu pendingin.');
}

function buildZeroGRing(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const frame = mat(0x94a3b8, { metal: 0.8, rough: 0.3 });
  const glowRing = glow(0x818cf8);
  // Big ring on two A-frame legs.
  const ring = new THREE.Mesh(new THREE.TorusGeometry(8, 0.7, 8, 40), frame);
  ring.position.set(-14, 9.4, -40);
  root.add(ring);
  const inner = new THREE.Mesh(new THREE.TorusGeometry(8, 0.18, 6, 40), glowRing);
  inner.position.copy(ring.position);
  root.add(inner);
  for (const s of [-1, 1]) {
    for (const tilt of [-0.3, 0.3]) {
      const leg = cyl(root, 0.3, 0.4, 10.6, -14 + s * 6 + tilt * 6, 5, -40, frame, 8);
      leg.rotation.z = -s * 0.32 + tilt * 0.4;
    }
  }
  // Mats + chalk orbit line on the ground.
  box(root, 6, 0.2, 4, -14, 0.2, -32, mat(0x6366f1, { rough: 0.9 }));
  flatDisc(root, 10.4, -14, 0.13, -40, mat(0x0f172a, { rough: 0.9 }));
  flatDisc(root, 7.2, -14, 0.15, -40, glowRing);
  // Suit stand-in: helmet on a post.
  cyl(root, 0.3, 0.4, 1.8, -6, 0.9, -34, frame, 8);
  ball(root, 0.8, -6, 2.4, -34, mat(0xf8fafc, { metal: 0.3, rough: 0.4 }));
  ball(root, 0.58, -6, 2.5, -33.5, mat(0x1c1917, { metal: 0.8, rough: 0.2, emissive: 0x38bdf8, ei: 0.25 }), 1, 1, 0.6);
  api.tag(last(root), 'Zero-G Ring', 'Attraction', 'Cincin gravitasi nol untuk latihan luar angkasa.');
}

function buildMagLevTube(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const pylon = mat(0x475569, { metal: 0.7, rough: 0.4 });
  const tube = mat(0xe2e8f0, { metal: 0.6, rough: 0.3, transparent: true, opacity: 0.55 });
  const line = glow(0x22d3ee);
  for (let i = 0; i <= 6; i++) {
    const x = 76 + i * 6.6;
    box(root, 1.4, 5, 1.4, x, 2.5, 44, pylon);
    box(root, 3.4, 0.6, 2.4, x, 5.3, 44, pylon);
  }
  const seg = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 42, 14, 1, true), tube);
  seg.rotation.z = Math.PI / 2;
  seg.position.set(96, 6.4, 44);
  root.add(seg);
  box(root, 42, 0.14, 0.14, 96, 6.4, 45.4, line);
  box(root, 42, 0.14, 0.14, 96, 6.4, 42.6, line);
  api.tag(last(root), 'Mag-Lev Tube', 'Attraction', 'Tabung magnet melayang menghubungkan modul.');
}

function buildTelescopes(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const dish = mat(0xe2e8f0, { metal: 0.6, rough: 0.4 });
  const frame = mat(0x64748b, { metal: 0.7, rough: 0.4 });
  box(root, 10, 0.4, 8, -44, 0.2, -64, mat(0x1f2937, { rough: 0.9 }));
  for (const [dx, dz, scale] of [[-2.6, -1.4, 1], [2.6, 1.6, 0.75]] as [number, number, number][]) {
    const x = -44 + dx;
    const z = -64 + dz;
    cyl(root, 0.6, 1.0, 3 * scale, x, 1.5 * scale, z, frame, 10);
    const d = new THREE.Mesh(new THREE.SphereGeometry(3.2 * scale, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2.6), dish);
    d.position.set(x, 4 * scale, z);
    d.rotation.x = 2.2;
    d.rotation.z = 0.3;
    root.add(d);
    ball(root, 0.4 * scale, x, 4.4 * scale, z + 1.4 * scale, glow(0xfbbf24));
  }
  // Little control hut.
  box(root, 4, 3, 3.4, -51, 1.5, -66, mat(0x1e293b, { rough: 0.7 }));
  box(root, 3, 1.0, 0.12, -51, 2.2, -64.3, glow(0x22d3ee));
  api.tag(last(root), 'Telescope Array', 'Attraction', 'Dua piringan teleskop memandang planet.');
}

function buildCargoYard(root: THREE.Group, isDark: boolean, api: ContentApi): void {
  const pallet = mat(isDark ? 0x334155 : 0x94a3b8, { rough: 0.9 });
  const crate = [0xf59e0b, 0x64748b, 0x14b8a6];
  box(root, 24, 0.4, 16, 90, 0.2, -66, pallet);
  let n = 0;
  for (let gx = 0; gx < 5; gx++) {
    for (let gz = 0; gz < 3; gz++) {
      const h = 1 + ((gx + gz) % 3);
      for (let s = 0; s < h; s++) {
        box(root, 3.4, 2, 3.4, 81 + gx * 4.6, 1.4 + s * 2.1, -71 + gz * 5, mat(crate[(n + s) % 3]!, { metal: 0.5, rough: 0.5 }), (gx + gz) * 0.1);
      }
      n++;
    }
  }
  // Warning beacon at the yard corner.
  cyl(root, 0.2, 0.3, 5, 101, 2.5, -59, mat(0x475569, { metal: 0.7, rough: 0.4 }), 8);
  ball(root, 0.6, 101, 5.4, -59, glow(0xf59e0b));
  api.tag(last(root), 'Cargo Yard', 'Attraction', 'Yard kargo modul dengan peti bertumpuk.');
}

function buildSolarField(root: THREE.Group, _isDark: boolean, api: ContentApi): void {
  const panel = mat(0x1e3a8a, { metal: 0.5, rough: 0.25, emissive: 0x1d4ed8, ei: 0.15 });
  const frame = mat(0xcbd5e1, { metal: 0.7, rough: 0.35 });
  for (let gx = 0; gx < 3; gx++) {
    for (let gz = 0; gz < 2; gz++) {
      const x = -8 + gx * 6;
      const z = 58 + gz * 7;
      box(root, 5, 0.3, 3.4, x, 2.2, z, panel, -0.2);
      for (const dx of [-1.8, 1.8]) cyl(root, 0.14, 0.2, 2.1, x + dx, 1.05, z, frame, 6);
      box(root, 5.4, 0.2, 0.3, x, 3.0, z + 1.7, frame, -0.2);
    }
  }
  // Power pylon with glowing core.
  cyl(root, 0.5, 0.8, 7, -8, 3.5, 52, frame, 8);
  ball(root, 1.1, -8, 7.6, 52, glow(0xa78bfa));
  api.tag(last(root), 'Solar Array', 'Attraction', 'Ladang panel surya untuk daya stasiun.');
}

const SPACE_ITEMS: WorldItem[] = [
  { id: 'docking-bay', build: buildDockingBay, colliders: [[66, -42, 26, 22]] },
  { id: 'biodome', build: buildBiodome, colliders: [[64, 40, 24, 24]] },
  { id: 'rover-garage', build: buildRoverGarage, colliders: [[26, 58, 12, 9]] },
  { id: 'cryo-row', build: buildCryoRow, colliders: [[-45, 31, 17, 4]] },
  { id: 'zero-g-ring', build: buildZeroGRing, colliders: [[-14, -40, 18, 18]] },
  { id: 'mag-lev', build: buildMagLevTube, colliders: [[96, 44, 42, 3]] },
  { id: 'telescopes', build: buildTelescopes, colliders: [[-44, -64, 14, 10]] },
  { id: 'cargo-yard', build: buildCargoYard, colliders: [[90, -66, 24, 16]] },
  { id: 'solar-field', build: buildSolarField, colliders: [[-8, 60, 16, 12]] },
];

/* =================================================================== */
/*                          PER-WORLD TABLE                             */
/* =================================================================== */

const ALWAYS_PRESETS = ['overview', 'office', 'iso', 'dev', 'server', 'top', 'lounge', 'coffee', 'board', 'command'];

function worldStaff(defs: [string, number, number, number, number][]): StaffDef[] {
  return defs.map(([name, x, z, rot, color]) => ({ name, x, z, rot, color }));
}

function spots(key: string, list: [number, number, number][]): Record<string, RoamSpot[]> {
  return { [key]: list.map(([x, z, rot]) => ({ x, z, rot })) };
}

function preset(
  x: number,
  y: number,
  z: number,
  lx: number,
  ly: number,
  lz: number,
): PresetSpot {
  return { pos: [x, y, z], look: [lx, ly, lz] };
}

const FLOATING: WorldContent = {
  items: FLOATING_ITEMS,
  fauna: ['rabbit', 'duck', 'cat'],
  butterflies: true,
  staff: worldStaff([
    ['Tree Keeper', 66, -22, -1.6, 0x7ade9b],
    ['Cloud Baker', 94, 46, Math.PI, 0xf472b6],
    ['Balloon Pilot', 90, -42, Math.PI / 2, 0x60a5fa],
    ['Sky Gardener', 66, 38, Math.PI, 0xfde68a],
    ['Crystal Sage', -44, 34, 0, 0xa78bfa],
    ['Bridge Watcher', 47, 50, Math.PI, 0xfda4af],
  ]),
  roam: { ...spots('terrace', [[10, -36, Math.PI]]), ...spots('balloon', [[92, -42, Math.PI]]), ...spots('orchard', [[64, 39, Math.PI]]) },
  presets: [...ALWAYS_PRESETS, 'terrace', 'balloon', 'orchard'],
  presetSpots: {
    terrace: preset(10, 14, -14, 10, 2, -40),
    balloon: preset(96, 12, -26, 92, 2, -48),
    orchard: preset(64, 12, 24, 64, 2, 44),
  },
};

const CYBER: WorldContent = {
  items: CYBER_ITEMS,
  fauna: ['cat', 'dog'],
  butterflies: false,
  staff: worldStaff([
    ['Arcade Host', -12, -41, Math.PI / 2, 0x22d3ee],
    ['Skate Coach', -46, 27, 0, 0xe879f9],
    ['Ramen Chef', 53, 35, Math.PI, 0xf59e0b],
    ['Server Op', 88, -27, 0, 0xa3e635],
    ['Sound Engineer', -27, -25, -Math.PI / 2, 0xf472b6],
    ['Drone Marshal', 61, 57, 0, 0x60a5fa],
  ]),
  roam: { ...spots('arcade', [[-14, -41, Math.PI]]), ...spots('ramen', [[53, 37, Math.PI]]), ...spots('stage', [[-24, -25, Math.PI]]) },
  presets: [...ALWAYS_PRESETS, 'arcade', 'stage', 'drones'],
  presetSpots: {
    arcade: preset(-12, 12, -28, -10, 2, -46),
    stage: preset(-24, 12, -14, -24, 3, -30),
    drones: preset(66, 14, 46, 66, 1, 62),
  },
};

const TROPICAL: WorldContent = {
  items: TROPICAL_ITEMS,
  fauna: ['duck', 'turtle', 'capybara'],
  butterflies: true,
  staff: worldStaff([
    ['Volley Ref', 66, -39, Math.PI, 0x22c55e],
    ['Tiki Bartender', 52, 38, Math.PI, 0xf97316],
    ['Surf Guide', 17, 52, -Math.PI / 2, 0x22d3ee],
    ['Pier Fisher', 103, 15, -Math.PI / 2, 0x3b82f6],
    ['Turtle Keeper', 86, 63, 0, 0x4ade80],
    ['Lighthouse Keeper', -44, -34, 0, 0xef4444],
    ['Beach Chief', 48, 64, Math.PI, 0xfde68a],
  ]),
  roam: { ...spots('hammock', [[-40, 26, Math.PI]]), ...spots('tiki', [[52, 39, Math.PI]]), ...spots('volley', [[66, -30, Math.PI]]) },
  presets: [...ALWAYS_PRESETS, 'volley', 'tiki', 'pier', 'lighthouse'],
  presetSpots: {
    volley: preset(66, 12, -20, 66, 1, -34),
    tiki: preset(52, 12, 20, 52, 2, 34),
    pier: preset(96, 10, 28, 96, 1, 12),
    lighthouse: preset(-38, 14, -26, -44, 8, -40),
  },
};

const TOYBOX: WorldContent = {
  items: TOYBOX_ITEMS,
  fauna: ['capybara', 'pig', 'goat', 'rabbit', 'duck'],
  butterflies: true,
  staff: worldStaff([
    ['Conductor', 66, -30, Math.PI, 0xef4444],
    ['Sand Pro', 44, 45, Math.PI, 0xf59e0b],
    ['Puppeteer', -46, -1, Math.PI, 0xa855f7],
    ['Ball Pit Guard', 76, 52, Math.PI, 0x60a5fa],
    ['Swing Attendant', -6, 53, 0, 0x22c55e],
    ['Castle Duke', 96, 58, 0, 0xf472b6],
  ]),
  roam: { ...spots('ballpit', [[76, 52, Math.PI]]), ...spots('sandbox', [[44, 46, Math.PI]]), ...spots('train', [[70, -40, Math.PI]]) },
  presets: [...ALWAYS_PRESETS, 'train', 'ballpit', 'castle', 'wheel'],
  presetSpots: {
    train: preset(64, 16, -8, 64, 2, -36),
    ballpit: preset(76, 12, 30, 76, 1, 47),
    castle: preset(96, 14, 48, 96, 4, 64),
    wheel: preset(98, 14, 6, 100, 8, -10),
  },
};

const SPACE: WorldContent = {
  items: SPACE_ITEMS,
  fauna: ['panda', 'cat'],
  butterflies: false,
  staff: worldStaff([
    ['Dockmaster', 74, -32, -Math.PI / 2, 0xf59e0b],
    ['Hydroponist', 58, 44, Math.PI / 2, 0x4ade80],
    ['Rover Mechanic', 31, 62, Math.PI, 0xf8fafc],
    ['Cryo Tech', -50, 33, Math.PI / 2, 0x38bdf8],
    ['Telescope Op', -48, -60, 0, 0xa78bfa],
    ['Cargo Chief', 84, -61, 0, 0x14b8a6],
  ]),
  roam: { ...spots('biodome', [[58, 44, Math.PI]]), ...spots('rover', [[31, 62, Math.PI]]), ...spots('bay', [[74, -32, Math.PI]]) },
  presets: [...ALWAYS_PRESETS, 'bay', 'biodome', 'rover', 'telescope'],
  presetSpots: {
    bay: preset(66, 16, -18, 66, 3, -42),
    biodome: preset(64, 18, 22, 64, 3, 40),
    rover: preset(26, 12, 44, 26, 2, 58),
    telescope: preset(-44, 12, -50, -44, 3, -64),
  },
};

const FOREST: WorldContent = {
  items: [],
  fauna: ['cat', 'dog', 'duck', 'rabbit', 'capybara', 'panda', 'turtle', 'alpaca', 'goat', 'pig'],
  butterflies: true,
  staff: [],
  roam: {},
  presets: [...ALWAYS_PRESETS, 'pool', 'padel', 'soccer', 'basketball', 'cinema', 'tennis', 'gym', 'village'],
  presetSpots: {},
};

export function worldContent(id: WorldThemeId): WorldContent {
  switch (id) {
    case 'floating':
      return FLOATING;
    case 'cyberpunk':
      return CYBER;
    case 'tropical':
      return TROPICAL;
    case 'toybox':
      return TOYBOX;
    case 'space':
      return SPACE;
    case 'forest':
    default:
      return FOREST;
  }
}
