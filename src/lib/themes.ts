/**
 * World theme profiles for OpenCode Mansion.
 *
 * A theme changes how the estate LOOKS — sky, fog, lighting, ground, water,
 * vegetation, tower palettes, animals and the world surrounding the campus.
 * It never touches gameplay data: agents, sessions, collision and the camera
 * layout stay identical across themes.
 */

export type WorldThemeId = 'forest' | 'floating' | 'cyberpunk' | 'tropical' | 'toybox' | 'space';

export interface AnimalStyle {
  /** HSL hue rotation applied to every fur material (0..1). */
  hue: number;
  /** Saturation multiplier. */
  satMul: number;
  /** Lightness offset (-0.5..0.5). */
  lightOff: number;
  /** Optional emissive tint for robot/astro critters. */
  emissive?: number;
  emissiveIntensity?: number;
  metalness?: number;
}

export interface TowerSpec {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
}

/**
 * Site plan for a world. Big campus clusters (pool + gym, sports courts,
 * animal village, attractions) and the district skyline move as a unit;
 * office, desks, live screens and agents never move.
 */
export interface WorldLayout {
  /** Offset of the pool + gym wing from its base position. */
  pool: [number, number];
  /** Offset of the padel / soccer / basketball cluster. */
  sports: [number, number];
  /** Offset of the animal village. */
  village: [number, number];
  /** Offset of the attractions cluster (cinema, tennis, koi, parking, ...). */
  attractions: [number, number];
  /** Render the boulevard + sidewalks + bollards. */
  roads: boolean;
  /** Run the campus shuttle (needs roads). */
  shuttle: boolean;
  /**
   * Whole-campus rotation (0/90/180/270) around the campus centre. Rotates
   * every building, road and character together — camera presets follow.
   */
  rotate: 0 | 90 | 180 | 270;
  /** Campus plate treatment. */
  base: 'jungle' | 'cliff' | 'beach' | 'playmat' | 'deck' | 'neon';
  /** Silhouette for the four district towers (command stays a block tower). */
  towerStyle: 'block' | 'spire' | 'hut' | 'stack' | 'pod' | 'tree';
  towers: {
    engineering: TowerSpec;
    research: TowerSpec;
    qa: TowerSpec;
    infrastructure: TowerSpec;
    command: TowerSpec;
  };
}

export interface ThemeProfile {
  id: WorldThemeId;
  label: string;
  emoji: string;
  /** Vertical sky gradient stops, top → horizon. CSS strings. */
  skyDay: [string, string, string];
  skyNight: [string, string, string];
  /** Draw stars into the sky texture (both modes). */
  stars: boolean;
  /** null = no fog (deep space). */
  fogDay: { color: number; density: number } | null;
  fogNight: { color: number; density: number } | null;
  ambientDay: { color: number; intensity: number };
  ambientNight: { color: number; intensity: number };
  dirDay: { color: number; intensity: number };
  dirNight: { color: number; intensity: number };
  exposureDay: number;
  exposureNight: number;
  envDay: number;
  envNight: number;
  /** Campus grass field: fill + two stripe colors (CSS). */
  campusDay: [string, string, string];
  campusNight: [string, string, string];
  /** Tint multiplier over the PBR grass/ground materials. */
  lawnTintDay: number;
  lawnTintNight: number;
  /** Sports field stripes (CSS pairs). */
  turfDay: [string, string];
  turfNight: [string, string];
  /** Vegetation palettes. */
  leafDay: number[];
  leafNight: number[];
  trunkDay: number;
  trunkNight: number;
  /** Pool / pond / river water color. */
  waterDay: number;
  waterNight: number;
  /** Accent for the shuttle, pool-bar neon and signage trims. */
  accent: number;
  /** Glass room wall colors. */
  glassDay: number;
  glassNight: number;
  /** Office wing wall colors. */
  wallDay: number;
  wallNight: number;
  /** [engineering, research, qa, infrastructure, command] */
  towers: [number, number, number, number, number];
  animal: AnimalStyle;
  /** true = render the Amazon rainforest belt + river from jungle.ts. */
  jungle: boolean;
  /** Per-world site plan: where the big campus clusters sit. */
  layout: WorldLayout;
}

const base = {
  stars: false,
  exposureDay: 1.05,
  exposureNight: 1.18,
  envDay: 0.85,
  envNight: 0.4,
};

export const WORLD_THEMES: ThemeProfile[] = [
  {
    ...base,
    id: 'forest',
    label: 'Forest Campus',
    emoji: '🌲',
    skyDay: ['#bfe3ff', '#e0f2fe', '#fefce8'],
    skyNight: ['#020617', '#0f172a', '#1e293b'],
    fogDay: { color: 0x9dbfa8, density: 0.0016 },
    fogNight: { color: 0x0b1d15, density: 0.0032 },
    ambientDay: { color: 0xffffff, intensity: 2.5 },
    ambientNight: { color: 0x1e293b, intensity: 2.0 },
    dirDay: { color: 0xfffaed, intensity: 2.9 },
    dirNight: { color: 0x93c5fd, intensity: 2.4 },
    campusDay: ['#7cc576', '#85ce7e', '#73bd6d'],
    campusNight: ['#12301f', '#163a26', '#0f2b1c'],
    lawnTintDay: 0x9fd08b,
    lawnTintNight: 0x6f8f72,
    turfDay: ['#2f9e44', '#37b24d'],
    turfNight: ['#14532d', '#166534'],
    leafDay: [0x15803d, 0x166534, 0x16a34a],
    leafNight: [0x14532d, 0x166534, 0x15803d],
    trunkDay: 0x78350f,
    trunkNight: 0x78350f,
    waterDay: 0x0ea5e9,
    waterNight: 0x0ea5e9,
    accent: 0x0ea5e9,
    glassDay: 0x93c5fd,
    glassNight: 0x1e3a8a,
    wallDay: 0xe2e8f0,
    wallNight: 0x18181b,
    towers: [0x0d9488, 0x7c3aed, 0x059669, 0x2563eb, 0xb45309],
    animal: { hue: 0, satMul: 1, lightOff: 0 },
    jungle: true,
    layout: {
      pool: [0, 0],
      sports: [0, 0],
      village: [0, 0],
      attractions: [0, 0],
      roads: true,
      shuttle: true,
      rotate: 0,
      base: 'jungle',
      towerStyle: 'block',
      towers: {
        engineering: { x: -15, z: -34, w: 12, d: 10, h: 13 },
        research: { x: 44, z: -42, w: 12, d: 10, h: 16 },
        qa: { x: 20, z: -48, w: 10, d: 8, h: 10 },
        infrastructure: { x: 96, z: -10, w: 12, d: 10, h: 14 },
        command: { x: 96, z: -42, w: 16, d: 12, h: 13 },
      },
    },
  },
  {
    ...base,
    id: 'floating',
    label: 'Floating Kingdom',
    emoji: '☁️',
    skyDay: ['#a5f3fc', '#e9d5ff', '#fef3c7'],
    skyNight: ['#1e1b4b', '#4c1d95', '#a78bfa'],
    fogDay: { color: 0xdff1ff, density: 0.0016 },
    fogNight: { color: 0x241b4d, density: 0.0025 },
    ambientDay: { color: 0xffffff, intensity: 2.1 },
    ambientNight: { color: 0x8b5cf6, intensity: 2.2 },
    dirDay: { color: 0xfff7e0, intensity: 2.5 },
    dirNight: { color: 0xc4b5fd, intensity: 2.3 },
    exposureDay: 1.1,
    envDay: 0.35,
    envNight: 0.25,
    campusDay: ['#86efac', '#9bf0b6', '#74e0a0'],
    campusNight: ['#1f2a4a', '#25325c', '#19223c'],
    lawnTintDay: 0xbaf7c9,
    lawnTintNight: 0x7c6fd1,
    turfDay: ['#34d399', '#6ee7b7'],
    turfNight: ['#155e4a', '#1b7a5e'],
    leafDay: [0x86efac, 0x5eead4, 0xa7f3d0, 0xf9a8d4],
    leafNight: [0x34d399, 0x2dd4bf, 0x818cf8, 0xf472b6],
    trunkDay: 0xb45309,
    trunkNight: 0x92400e,
    waterDay: 0x22d3ee,
    waterNight: 0x67e8f9,
    accent: 0xf472b6,
    glassDay: 0xbae6fd,
    glassNight: 0x6d28d9,
    wallDay: 0xf5f3ff,
    wallNight: 0x2e1065,
    towers: [0xfb7bb2, 0x8b9cf5, 0x4adfa9, 0xf5c542, 0x74c0fc],
    animal: { hue: 0.02, satMul: 1.15, lightOff: 0.06 },
    jungle: false,
    layout: {
      pool: [-26, 6],
      sports: [0, 0],
      village: [0, 0],
      attractions: [-6, 8],
      roads: false,
      shuttle: false,
      rotate: 0,
      base: 'cliff',
      towerStyle: 'tree',
      towers: {
        engineering: { x: -46, z: 6, w: 12, d: 10, h: 9 },
        research: { x: -30, z: -58, w: 12, d: 10, h: 11 },
        qa: { x: 8, z: -52, w: 10, d: 8, h: 8 },
        infrastructure: { x: 108, z: 28, w: 12, d: 10, h: 10 },
        command: { x: 84, z: 16, w: 16, d: 12, h: 9 },
      },
    },
  },
  {
    ...base,
    id: 'cyberpunk',
    label: 'Cyber Megacity',
    emoji: '🌆',
    skyDay: ['#1e1b4b', '#312e81', '#4c1d95'],
    skyNight: ['#020617', '#0b0a1f', '#1e1b4b'],
    stars: true,
    fogDay: { color: 0x2b1d63, density: 0.0055 },
    fogNight: { color: 0x0a0618, density: 0.0065 },
    ambientDay: { color: 0x7c3aed, intensity: 2.2 },
    ambientNight: { color: 0x312e81, intensity: 1.9 },
    dirDay: { color: 0x22d3ee, intensity: 2.3 },
    dirNight: { color: 0xe879f9, intensity: 2.1 },
    exposureDay: 1.0,
    exposureNight: 1.06,
    envDay: 0.2,
    envNight: 0.08,
    campusDay: ['#171335', '#1b1740', '#141031'],
    campusNight: ['#0d0a20', '#100d28', '#0b081c'],
    lawnTintDay: 0x4c1d95,
    lawnTintNight: 0x241b4d,
    turfDay: ['#0e7490', '#155e75'],
    turfNight: ['#164e63', '#083344'],
    leafDay: [0x134e4a, 0x0f766e, 0x1e293b],
    leafNight: [0x0f172a, 0x134e4a, 0x1e293b],
    trunkDay: 0x1f2937,
    trunkNight: 0x111827,
    waterDay: 0x0891b2,
    waterNight: 0x155e75,
    accent: 0x22d3ee,
    glassDay: 0x0e7490,
    glassNight: 0x22d3ee,
    wallDay: 0x18181b,
    wallNight: 0x09090b,
    towers: [0x0e7490, 0x7c3aed, 0xbe185d, 0x1d4ed8, 0xf59e0b],
    animal: {
      hue: 0.5,
      satMul: 0.35,
      lightOff: -0.08,
      emissive: 0x22d3ee,
      emissiveIntensity: 0.35,
      metalness: 0.7,
    },
    jungle: false,
    layout: {
      pool: [0, -30],
      sports: [34, -37],
      village: [0, 0],
      attractions: [-8, -4],
      roads: true,
      shuttle: true,
      rotate: 180,
      base: 'neon',
      towerStyle: 'spire',
      towers: {
        engineering: { x: -44, z: -24, w: 12, d: 10, h: 16 },
        research: { x: 112, z: 20, w: 12, d: 10, h: 18 },
        qa: { x: 50, z: -54, w: 10, d: 8, h: 14 },
        infrastructure: { x: 112, z: -8, w: 12, d: 10, h: 20 },
        command: { x: 12, z: -60, w: 16, d: 12, h: 13 },
      },
    },
  },
  {
    ...base,
    id: 'tropical',
    label: 'Tropical Paradise',
    emoji: '🏝️',
    skyDay: ['#67e8f9', '#8fdcc9', '#b9ece2'],
    skyNight: ['#0c4a6e', '#1e3a8a', '#155e75'],
    fogDay: { color: 0xcfeef2, density: 0.00055 },
    fogNight: { color: 0x08303c, density: 0.003 },
    ambientDay: { color: 0xfff4e6, intensity: 0.9 },
    ambientNight: { color: 0x0e7490, intensity: 2.0 },
    dirDay: { color: 0xfffaee, intensity: 2.5 },
    dirNight: { color: 0x67e8f9, intensity: 2.3 },
    exposureDay: 1.05,
    envDay: 0.3,
    envNight: 0.35,
    campusDay: ['#6fc76a', '#7dd478', '#63ba5e'],
    campusNight: ['#14532d', '#166534', '#123f22'],
    lawnTintDay: 0x76cf8e,
    lawnTintNight: 0x3f7a5c,
    turfDay: ['#22c55e', '#4ade80'],
    turfNight: ['#166534', '#15803d'],
    leafDay: [0x16a34a, 0x0d9488, 0x65a30d],
    leafNight: [0x14532d, 0x0f766e, 0x3f6212],
    trunkDay: 0x92400e,
    trunkNight: 0x713f12,
    waterDay: 0x2dd4bf,
    waterNight: 0x0d9488,
    accent: 0xf97316,
    glassDay: 0xa5f3fc,
    glassNight: 0x155e75,
    wallDay: 0xfef3c7,
    wallNight: 0x134e4a,
    towers: [0x0d9488, 0xf59e0b, 0xef4444, 0x0ea5e9, 0x84cc16],
    animal: { hue: 0, satMul: 1.1, lightOff: 0.02 },
    jungle: false,
    layout: {
      pool: [-34, 20],
      sports: [4, -2],
      village: [2, -28],
      attractions: [0, 0],
      roads: false,
      shuttle: false,
      rotate: 90,
      base: 'beach',
      towerStyle: 'hut',
      towers: {
        engineering: { x: 58, z: 58, w: 12, d: 10, h: 8 },
        research: { x: 108, z: 44, w: 12, d: 10, h: 10 },
        qa: { x: 0, z: 64, w: 10, d: 8, h: 7 },
        infrastructure: { x: 112, z: -2, w: 12, d: 10, h: 9 },
        command: { x: 100, z: -38, w: 16, d: 12, h: 10 },
      },
    },
  },
  {
    ...base,
    id: 'toybox',
    label: 'Toybox World',
    emoji: '🧸',
    skyDay: ['#fde68a', '#fbcfe8', '#bfdbfe'],
    skyNight: ['#312e81', '#6d28d9', '#be185d'],
    stars: true,
    fogDay: { color: 0xfdf4d8, density: 0.0012 },
    fogNight: { color: 0x1a1140, density: 0.003 },
    ambientDay: { color: 0xffffff, intensity: 2.8 },
    ambientNight: { color: 0x818cf8, intensity: 2.1 },
    dirDay: { color: 0xfffff0, intensity: 2.8 },
    dirNight: { color: 0xf0abfc, intensity: 2.2 },
    exposureDay: 1.12,
    exposureNight: 1.2,
    envDay: 0.4,
    envNight: 0.2,
    campusDay: ['#95d571', '#a4e07f', '#86ca62'],
    campusNight: ['#1d2e4a', '#243756', '#182743'],
    lawnTintDay: 0xc9f2a6,
    lawnTintNight: 0x5f6fae,
    turfDay: ['#ef4444', '#facc15'],
    turfNight: ['#7f1d1d', '#78350f'],
    leafDay: [0x22c55e, 0x16a34a, 0x4ade80],
    leafNight: [0x15803d, 0x166534, 0x14532d],
    trunkDay: 0xb45309,
    trunkNight: 0x92400e,
    waterDay: 0x38bdf8,
    waterNight: 0x0ea5e9,
    accent: 0xef4444,
    glassDay: 0x93c5fd,
    glassNight: 0x1d4ed8,
    wallDay: 0xfff7ed,
    wallNight: 0x312e81,
    towers: [0xef4444, 0xf59e0b, 0x3b82f6, 0x22c55e, 0xa855f7],
    animal: { hue: 0.01, satMul: 1.25, lightOff: 0.08 },
    jungle: false,
    layout: {
      pool: [0, 28],
      sports: [0, 0],
      village: [-48, -18],
      attractions: [-4, -6],
      roads: false,
      shuttle: false,
      rotate: 180,
      base: 'playmat',
      towerStyle: 'stack',
      towers: {
        engineering: { x: -44, z: 20, w: 12, d: 10, h: 7 },
        research: { x: -40, z: -24, w: 12, d: 10, h: 8 },
        qa: { x: 52, z: 22, w: 10, d: 8, h: 7 },
        infrastructure: { x: 108, z: 18, w: 12, d: 10, h: 9 },
        command: { x: 108, z: -30, w: 16, d: 12, h: 9 },
      },
    },
  },
  {
    ...base,
    id: 'space',
    label: 'Space Colony',
    emoji: '🚀',
    skyDay: ['#0b1026', '#131b3a', '#1e293b'],
    skyNight: ['#020409', '#050a16', '#0a1226'],
    stars: true,
    fogDay: null,
    fogNight: null,
    ambientDay: { color: 0xcbd5e1, intensity: 1.7 },
    ambientNight: { color: 0x1e293b, intensity: 1.4 },
    dirDay: { color: 0xf8fafc, intensity: 2.7 },
    dirNight: { color: 0x93c5fd, intensity: 1.9 },
    exposureDay: 1.0,
    exposureNight: 1.1,
    envDay: 0.15,
    envNight: 0.05,
    campusDay: ['#1f2937', '#233041', '#1b2532'],
    campusNight: ['#0b1220', '#0e1729', '#080f1b'],
    lawnTintDay: 0x475569,
    lawnTintNight: 0x1e293b,
    turfDay: ['#14532d', '#166534'],
    turfNight: ['#052e16', '#0a3d20'],
    leafDay: [0x2dd4bf, 0x34d399, 0x059669],
    leafNight: [0x0f766e, 0x059669, 0x115e59],
    trunkDay: 0x475569,
    trunkNight: 0x334155,
    waterDay: 0x2dd4bf,
    waterNight: 0x14b8a6,
    accent: 0x38bdf8,
    glassDay: 0x7dd3fc,
    glassNight: 0x0c4a6e,
    wallDay: 0xe2e8f0,
    wallNight: 0x0f172a,
    towers: [0x475569, 0x6366f1, 0x0ea5e9, 0x14b8a6, 0xf59e0b],
    animal: {
      hue: 0,
      satMul: 0.5,
      lightOff: 0.12,
      emissive: 0x93c5fd,
      emissiveIntensity: 0.12,
      metalness: 0.35,
    },
    jungle: false,
    layout: {
      pool: [0, 26],
      sports: [0, 0],
      village: [-42, -16],
      attractions: [6, 0],
      roads: false,
      shuttle: false,
      rotate: 0,
      base: 'deck',
      towerStyle: 'pod',
      towers: {
        engineering: { x: -46, z: 0, w: 12, d: 10, h: 7 },
        research: { x: -42, z: -44, w: 12, d: 10, h: 8 },
        qa: { x: 20, z: -56, w: 10, d: 8, h: 7 },
        infrastructure: { x: 106, z: -20, w: 12, d: 10, h: 8 },
        command: { x: 100, z: 10, w: 16, d: 12, h: 8 },
      },
    },
  },
];

export const DEFAULT_THEME_ID: WorldThemeId = 'forest';

export function themeById(id: string | null | undefined): ThemeProfile {
  return WORLD_THEMES.find((t) => t.id === id) ?? WORLD_THEMES[0]!;
}

let active: ThemeProfile = themeById(null);

export function setActiveTheme(id: string | null): void {
  active = themeById(id);
}

export function activeTheme(): ThemeProfile {
  return active;
}
