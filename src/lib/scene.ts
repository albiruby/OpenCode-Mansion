import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { AGENTS, AGENT_IDS } from '../data/agents';
import { appState, bus, logStore, sessionStore } from '../store/store';
import { ensureAudio, playTypewriterTick } from './audio';
import {
  addProp,
  createCharacterRig,
  disposeCharacterRig,
  loadRealisticAssets,
  pbrMaterial,
  updateCharacterRig,
  type CharacterRig,
  type RealisticAssets,
} from './realistic';
import {
  CollisionWorld,
  moveTowards,
  separateBodies,
  stepBody,
  type SeparationBody,
} from './physics';
import { buildSurroundings, updateSurroundings, resetSurroundings } from './surroundings';
import { setActiveTheme, activeTheme, type WorldThemeId } from './themes';
import type { AgentDef, AgentId, SessionStatus, SessionSummary } from '../types';

/* --------------------------------------------------------------------------
   Module state
   -------------------------------------------------------------------------- */
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let controls: OrbitControls | null = null;
let contentRoot: THREE.Group | null = null;
/**
 * Inner build group in campus-local coordinates. contentRoot applies the
 * world's site-plan rotation around the campus centre; everything (buildings,
 * roads, characters, the shuttle) is built inside worldRoot, while the physics
 * world and all sim coordinates keep using the unrotated campus frame.
 */
let worldRoot: THREE.Group | null = null;
let realisticAssets: RealisticAssets | null = null;
let realisticLoadStarted = false;

const serverLeds: { mesh: THREE.Mesh; rate: number }[] = [];
const steamParticles: THREE.Mesh[] = [];
const characterGroups: THREE.Group[] = [];
let raycaster: THREE.Raycaster | null = null;
let sceneActive = true;

let container: HTMLElement | null = null;
let bubbleEls: Partial<Record<AgentId, HTMLElement | null>> = {};

const timer = new THREE.Timer();
const mouse = new THREE.Vector2();
const tempVec = new THREE.Vector3();
let tvTexture: THREE.CanvasTexture | null = null;
let tvLastPaint = 0;
let balloonGroup: THREE.Group | null = null;

/* Live data screens */
let liveFeedTexture: THREE.CanvasTexture | null = null;
let liveFeedCanvas: HTMLCanvasElement | null = null;
let commandTexture: THREE.CanvasTexture | null = null;
let commandCanvas: HTMLCanvasElement | null = null;
let boardTexture: THREE.CanvasTexture | null = null;
let boardCanvas: HTMLCanvasElement | null = null;
let serverTexture: THREE.CanvasTexture | null = null;
let serverCanvas: HTMLCanvasElement | null = null;
let screensLastPaint = 0;
let skyTexture: THREE.CanvasTexture | null = null;

/* Generic object inspection */
interface InspectInfo {
  label: string;
  kind: string;
  detail?: string;
  preset?: string;
}

let inspectedObject: THREE.Object3D | null = null;
let inspectedPreset: string | undefined;
let inspectHelper: THREE.BoxHelper | null = null;
let inspectPulse: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> | null = null;
let inspectPulseStart = 0;
let lastHoverRay = 0;
let pointerDownAt: { x: number; y: number } | null = null;
let pointerDragged = false;
let hoverTooltipEl: HTMLElement | null = null;
let inspectCardEl: HTMLElement | null = null;
let inspectKindEl: HTMLElement | null = null;
let inspectTitleEl: HTMLElement | null = null;
let inspectDetailEl: HTMLElement | null = null;
let inspectPresetEl: HTMLButtonElement | null = null;

/* --------------------------------------------------------------------------
   Layout
   -------------------------------------------------------------------------- */
const ROOM = { w: 180, d: 150 };
const FLOOR_CENTER = { x: 30, z: 0 };
const DESK_X = [-17, -11, -5, 1, 7];
const DESK_ROW_Z = [-6, -1];

const BASE_SPOTS: Record<string, { x: number; z: number; rot: number }[]> = {
  coffee: [
    { x: -16.4, z: 8.5, rot: 0 },
    { x: -14.2, z: 8.7, rot: 0 },
  ],
  tv: [
    { x: 19.6, z: 7.4, rot: Math.PI / 2 },
    { x: 19.6, z: 11.6, rot: Math.PI / 2 },
  ],
  whiteboard: [
    { x: -17.3, z: -9.8, rot: -2.1 },
    { x: -14.9, z: -10.2, rot: -1.7 },
  ],
  meeting: [
    { x: -8.8, z: 5.7, rot: Math.PI * 0.8 },
    { x: -5.2, z: 7.2, rot: -Math.PI * 0.2 },
  ],
  server: [{ x: 15.2, z: -9.6, rot: Math.PI / 2 }],
  pool: [
    { x: 76, z: 31.5, rot: Math.PI },
    { x: 86, z: 31.5, rot: Math.PI },
  ],
  padel: [
    { x: 33.4, z: -7, rot: Math.PI / 2 },
    { x: 56.6, z: -7, rot: -Math.PI / 2 },
  ],
  soccer: [
    { x: 73, z: -1.6, rot: Math.PI },
    { x: 61, z: -28, rot: 0 },
  ],
  gym: [
    { x: 47, z: 33, rot: 0 },
    { x: 53, z: 38, rot: Math.PI },
  ],
};

/**
 * Live roam targets: the base layout shifted by the active world's site plan,
 * so agents walk to where the pool / courts actually are in every world.
 */
const SPOTS: Record<string, { x: number; z: number; rot: number }[]> = {};

function rebuildRoamTargets(): void {
  const L = activeTheme().layout;
  const offsets: Record<string, [number, number]> = {
    pool: L.pool,
    gym: L.pool,
    padel: L.sports,
    soccer: L.sports,
  };
  for (const key of Object.keys(BASE_SPOTS)) {
    const off = offsets[key];
    SPOTS[key] = off
      ? BASE_SPOTS[key]!.map((s) => ({ x: s.x + off[0], z: s.z + off[1], rot: s.rot }))
      : BASE_SPOTS[key]!.map((s) => ({ ...s }));
  }
  // Animal village zones follow the village; the loose south/west/north herds
  // stay on the open lawns.
  ANIMAL_SPOTS.village = BASE_ANIMAL_SPOTS.village.map((s) => ({
    x: s.x + L.village[0],
    z: s.z + L.village[1],
  }));
  // Visitors gather around the pool and the village wherever they sit.
  CROWD_SPOTS.length = 0;
  for (const s of BASE_CROWD_SPOTS) {
    const off = s.z > 42 ? L.village : s.x > 58 ? L.pool : null;
    CROWD_SPOTS.push(off ? { x: s.x + off[0], z: s.z + off[1], rot: s.rot } : { ...s });
  }
  rebuildPresets();
}

type SpotKey =
  | 'desk'
  | 'coffee'
  | 'tv'
  | 'whiteboard'
  | 'meeting'
  | 'server'
  | 'pool'
  | 'padel'
  | 'soccer'
  | 'gym';

interface Pt {
  x: number;
  z: number;
}

const AGENT_RADIUS = 0.32;
const CROWD_RADIUS = 0.3;
const VISITOR_RADIUS = 0.3;

/**
 * Characters live on the campus floor, so the collision world only spans the
 * walkable 180 x 150 estate. The rainforest beyond it is decorative.
 */
const collisionWorld = new CollisionWorld(
  { minX: -61, maxX: 121, minZ: -76, maxZ: 76 },
  0.5,
);

/**
 * Static obstacle table for the whole estate. Walls use the same door gaps as
 * the glass-wall builder; furniture keeps the side characters sit/stand on
 * free, so agents can reach their own chair without being pushed away.
 */
function registerCollisionGeometry(): void {
  const w = collisionWorld;
  w.clear();
  const L = activeTheme().layout;
  const [px, pz] = L.pool;
  const [ax, az] = L.attractions;
  const [vx, vz] = L.village;

  // Office back wall (the only solid wall in the open-air wing).
  w.addBox(0, -14.8, 44, 0.5);

  const wallX = (x: number, z1: number, z2: number): void => {
    w.addBox(x, (z1 + z2) / 2, 0.18, Math.abs(z2 - z1));
  };
  const wallZ = (z: number, x1: number, x2: number): void => {
    w.addBox((x1 + x2) / 2, z, Math.abs(x2 - x1), 0.18);
  };

  // Lounge glass walls (door gap on the south side).
  wallX(13, 3.8, 15);
  wallX(22, 3.8, 15);
  wallZ(3.8, 13, 14.2);
  wallZ(3.8, 17.4, 22);
  wallZ(15, 13, 22);

  // Pantry glass walls (door gap at the south-east corner).
  wallX(-20, 8, 13.5);
  wallX(-12.4, 8, 13.5);
  wallZ(8, -20, -14.6);
  wallZ(13.5, -20, -12.4);

  // Meeting room glass walls.
  wallX(-10.8, 3.6, 9.2);
  wallX(-3.2, 3.6, 9.2);
  wallZ(3.6, -10.8, -8.2);
  wallZ(3.6, -5.6, -3.2);
  wallZ(9.2, -10.8, -3.2);

  // Server room keeps only its west glass wall; the rest is open.
  wallX(10.6, -15, -6.9);

  // Desks: block the monitor two-thirds, leave the chair side walkable.
  for (const x of DESK_X) {
    for (const z of DESK_ROW_Z) w.addBox(x, z - 0.175, 3.1, 1.35);
  }

  // Squad loft tables (seats sit 1.15 m in front of each table).
  for (let row = 0; row < 6; row++) {
    w.addBox(-22, 20 + row * 5 - 0.1, 26, 1.2);
  }

  // Office props.
  w.addBox(-19, -11.4, 3.6, 0.35, Math.PI / 4); // whiteboard
  w.addBox(-16, 10.4, 4.9, 1.7); // espresso bar
  w.addBox(-7, 6.4, 2.3, 2.3); // meeting table
  w.addBox(10.5, 2.4, 4.8, 2.5); // ping pong table
  w.addBox(11.4, 5.1, 0.7, 0.7); // water cooler

  // Server racks.
  w.addBox(17.6, -11.4, 1.7, 1.5, -Math.PI / 8);
  w.addBox(19.7, -10.8, 1.7, 1.5, -Math.PI / 8);

  // Poly Haven lounge / pantry props.
  w.addBox(14.6, 9.5, 1.35, 4.4); // sofa, rotated 90 degrees
  w.addBox(17.9, 9.5, 2.4, 2.6); // coffee table
  w.addBox(19.4, 13.6, 1.35, 1.35); // reading armchair
  w.addBox(20.9, 13.2, 0.7, 2.0); // shelf
  w.addBox(-21, 12.2, 1.15, 1.15); // pantry armchair
  w.addBox(-19.2, 6.4, 1.2, 0.95); // coffee cart

  // Sports wing (pool + gym), wherever the world places it.
  w.addBox(80 + px, 16 + pz, 22, 16); // pool water
  for (const x of [72, 78, 84, 90]) w.addBox(x + px, 29.5 + pz, 1.9, 0.75); // loungers
  for (const [x, z] of [
    [66, 4],
    [94, 4],
    [66, 33],
    [94, 33],
  ] as [number, number][]) {
    w.addBox(x + px, z + pz, 0.7, 0.7); // palms
  }
  w.addBox(43 + px, 42 + pz, 2.6, 0.8); // gym bench
  w.addBox(53.4 + px, 42 + pz, 2.8, 0.6); // squat rack
  w.addBox(55 + px, 35 + pz, 0.8, 0.8); // punching bag
  w.addBox(48 + px, 46 + pz, 8, 0.4); // gym mirror wall

  // Command / district buildings.
  const T = L.towers;
  for (const t of [T.engineering, T.research, T.qa, T.infrastructure, T.command]) {
    w.addBox(t.x, t.z, t.w, t.d);
  }
  w.addBox(40, 14, 10.6, 0.7); // session board
  w.addBox(16.4, -14.55, 5.5, 0.4); // server status screen

  // Attractions close to walkable routes.
  w.addBox(26 + ax, -36 + az, 9, 7); // koi pond
  w.addBox(0 + ax, -48 + az, 7, 7); // observatory
  w.addBox(16 + ax, 42 + az, 3.2, 3.2); // fire pit
  w.addBox(62 + ax, 34 + az, 3.2, 2.2); // food truck / cart
  w.addBox(64 + ax, 29 + az, 4, 1.2); // pool bar

  // Boulevard bollards line both sidewalks.
  if (L.roads) {
    for (let z = -44; z <= 46; z += 12) {
      for (const dx of [-6.8, 6.8]) w.addBox(30 + dx, z, 0.34, 0.34);
    }
  }

  // Animal village.
  w.addBox(94 + vx, 55.5 + vz, 6.2, 4.4);
  w.addBox(101.5 + vx, 64.5 + vz, 5.0, 4.0, -Math.PI / 2);
  w.addBox(89.5 + vx, 69.8 + vz, 5.2, 4.0);
  w.addBox(77.5 + vx, 68.3 + vz, 6.4, 6.4); // duck pond
  w.addBox(69.8 + vx, 57.3 + vz, 2.4, 1.6); // hay bales
  w.addBox(71.3 + vx, 64.9 + vz, 2.2, 2.2); // vegetable patch

  w.build(AGENT_RADIUS);
}

interface RoamState {
  phase: 'stay' | 'walk';
  spot: SpotKey;
  waypoints: Pt[];
  targetRot: number;
  timer: number;
  dest: Pt;
  vx: number;
  vz: number;
  repath: number;
  stuck: number;
}

const roamState = new Map<AgentId, RoamState>();
const pose = new Map<AgentId, { x: number; z: number; rot: number }>();
/** Personas currently driven by a running OpenCode session: they hold their desk. */
const assignedPersonas = new Set<AgentId>();

/* ---------------------------------------------------------------- squads */
const SQUAD_PER_SESSION = 8;
const MAX_VISIBLE_SESSIONS = 6;

interface CrowdMember {
  sessionId: string;
  persona: AgentId;
  status: SessionStatus;
  seat: { x: number; z: number };
  group: THREE.Group;
  pose: { x: number; z: number; rot: number };
  phase: 'work' | 'walk' | 'stay';
  target: { x: number; z: number };
  timer: number;
  path: Pt[];
  vx: number;
  vz: number;
  repath: number;
  speed: number;
}

const crowdMembers: CrowdMember[] = [];
const crowdGroups: THREE.Group[] = [];
let crowdRoot: THREE.Group | null = null;
let crowdSignature = '';

const CROWD_NAMES = [
  'Zoe', 'Rex', 'Nina', 'Theo', 'Luna', 'Finn', 'Aya', 'Luca', 'Remy', 'Sora',
  'Milo', 'Ivy', 'Hugo', 'Cleo', 'Arlo', 'Yuna', 'Seth', 'Lila', 'Nico', 'Rhea',
  'Jun', 'Tara', 'Enzo', 'Wren', 'Pixel', 'Mika', 'Rafa', 'Noor', 'Indra', 'Bima',
  'Sinta', 'Dewa', 'Kirana', 'Bayu', 'Laras', 'Gita', 'Raka', 'Nadia', 'Yudha', 'Sari',
  'Tirta', 'Alya', 'Bagas', 'Citra', 'Damar', 'Elsa', 'Fajar', 'Gina',
];
const CROWD_COLORS = [
  0x0ea5e9, 0xf43f5e, 0x84cc16, 0xf59e0b, 0x8b5cf6, 0x14b8a6,
  0xec4899, 0x6366f1, 0x22c55e, 0xef4444, 0x06b6d4, 0xa855f7,
  0xf97316, 0x10b981, 0x3b82f6, 0xd946ef, 0xeab308, 0x2dd4bf,
  0xfb7185, 0x818cf8, 0x4ade80, 0xfacc15, 0x38bdf8, 0xc084fc,
];
const BASE_CROWD_SPOTS: { x: number; z: number; rot: number }[] = [
  { x: 79, z: 31.5, rot: Math.PI },
  { x: 86, z: 31.5, rot: Math.PI },
  { x: 70.5, z: 27.2, rot: Math.PI },
  { x: 91, z: 27.2, rot: Math.PI },
  { x: 47, z: 28.5, rot: 0 },
  { x: 52, z: 38, rot: Math.PI },
  { x: 26, z: 20, rot: 0 },
  { x: 26, z: 34, rot: Math.PI },
  { x: 44, z: 48, rot: Math.PI },
  { x: 68, z: 48, rot: Math.PI },
  { x: 71, z: 40, rot: 0 },
  { x: 22, z: 17, rot: Math.PI },
  { x: 63, z: 31, rot: Math.PI },
  { x: -30, z: -24, rot: Math.PI },
  { x: -32, z: -31, rot: Math.PI },
  { x: -31, z: 2, rot: 0 },
];

/** Visitor gathering spots for the active world (filled by rebuildRoamTargets). */
const CROWD_SPOTS: { x: number; z: number; rot: number }[] = [];

function deskSpot(ag: AgentDef): { x: number; z: number } {
  const row = Math.floor(ag.deskIndex / 5);
  const col = ag.deskIndex % 5;
  return { x: DESK_X[col] ?? 0, z: (DESK_ROW_Z[row] ?? 0) + 0.95 };
}

function spotFor(ag: AgentDef, key: SpotKey): { x: number; z: number; rot: number } {
  if (key === 'desk') {
    const d = deskSpot(ag);
    return { x: d.x, z: d.z, rot: Math.PI };
  }
  const pool = SPOTS[key] ?? SPOTS['coffee']!;
  return pool[ag.deskIndex % pool.length] ?? pool[0]!;
}

function setMood(ag: AgentDef, state: AgentDef['state'], bubble: string): void {
  ag.state = state;
  ag.bubbleText = bubble;
  bus.emit('agent:update', ag.id);
}

function initRoamFor(ag: AgentDef): void {
  const desk = deskSpot(ag);
  pose.set(ag.id, { x: desk.x, z: desk.z, rot: Math.PI });
  roamState.set(ag.id, {
    phase: 'stay',
    spot: 'desk',
    waypoints: [],
    targetRot: Math.PI,
    timer: 4 + (ag.deskIndex % 5) * 2.4 + Math.random() * 3,
    dest: { x: desk.x, z: desk.z },
    vx: 0,
    vz: 0,
    repath: 0,
    stuck: 0,
  });
}

function chooseNextSpot(current: SpotKey): SpotKey {
  const r = Math.random();
  if (current === 'desk') {
    if (r < 0.14) return 'coffee';
    if (r < 0.28) return 'tv';
    if (r < 0.38) return 'meeting';
    if (r < 0.46) return 'server';
    if (r < 0.54) return 'whiteboard';
    if (r < 0.66) return 'pool';
    if (r < 0.76) return 'padel';
    if (r < 0.86) return 'soccer';
    if (r < 0.93) return 'gym';
    return 'desk';
  }
  if (r < 0.34) return 'desk';
  if (r < 0.48) return 'coffee';
  if (r < 0.6) return 'tv';
  if (r < 0.7) return 'meeting';
  if (r < 0.78) return 'server';
  if (r < 0.86) return 'whiteboard';
  if (r < 0.9) return 'pool';
  if (r < 0.94) return 'soccer';
  if (r < 0.97) return 'gym';
  return 'padel';
}

function moodForSpot(
  ag: AgentDef,
  spot: SpotKey,
): { state: AgentDef['state']; bubble: string } {
  switch (spot) {
    case 'coffee':
      return { state: 'COFFEE', bubble: '☕ Coffee break' };
    case 'tv':
      return { state: 'TV', bubble: 'Watching the CI feed' };
    case 'meeting':
      return { state: 'PLANNING', bubble: 'In a sync' };
    case 'server':
      return { state: 'TESTING', bubble: 'Checking the racks' };
    case 'whiteboard':
      return { state: 'PLANNING', bubble: 'Sketching on the whiteboard' };
    case 'pool':
      return { state: 'IDLE', bubble: 'Poolside break' };
    case 'padel':
      return { state: 'IDLE', bubble: 'Padel match' };
    case 'soccer':
      return { state: 'IDLE', bubble: 'Mini soccer' };
    case 'gym':
      return { state: 'IDLE', bubble: 'Gym session' };
    default:
      return { state: 'TYPING', bubble: ag.defaultBubble };
  }
}

function updateRoaming(dt: number): void {
  AGENT_IDS.forEach((id) => {
    const ag = AGENTS[id];
    const st = roamState.get(id);
    const p = pose.get(id);
    if (!st || !p) return;
    // Assigned personas hold their desk — except while walking back to it.
    if (assignedPersonas.has(id) && st.phase !== 'walk') return;

    if (st.phase === 'stay') {
      if (assignedPersonas.has(id)) return;
      st.timer -= dt;
      if (st.timer > 0) return;

      const next = chooseNextSpot(st.spot);
      if (next === 'desk' && st.spot === 'desk') {
        st.timer = 6 + Math.random() * 6;
        return;
      }
      const target = spotFor(ag, next);
      const path = collisionWorld.findPath({ x: p.x, z: p.z }, target, AGENT_RADIUS);
      if (path.length === 0) {
        // No route (e.g. target blocked by new furniture): hold position.
        st.timer = 3 + Math.random() * 3;
        return;
      }
      st.spot = next;
      st.phase = 'walk';
      st.targetRot = target.rot;
      st.dest = { x: target.x, z: target.z };
      st.waypoints = path;
      st.vx = 0;
      st.vz = 0;
      st.repath = 0;
      st.stuck = 0;
      setMood(ag, 'WALKING', 'On the move…');
      return;
    }

    const wp = st.waypoints[0];
    if (!wp) {
      st.phase = 'stay';
      st.timer = 6 + Math.random() * 8;
      const mood = moodForSpot(ag, st.spot);
      setMood(ag, mood.state, mood.bubble);
      return;
    }

    const body = { x: p.x, z: p.z, rot: p.rot, vx: st.vx, vz: st.vz };
    const result = stepBody(collisionWorld, body, wp, dt, {
      speed: 1.55,
      radius: AGENT_RADIUS,
      arriveRadius: 0.34,
      accel: 3.2,
      decel: 5.4,
    });
    p.x = body.x;
    p.z = body.z;
    p.rot = body.rot;
    st.vx = body.vx;
    st.vz = body.vz;

    if (result.arrived) {
      st.waypoints.shift();
      st.repath = 0;
      st.stuck = 0;
      if (st.waypoints.length === 0) {
        p.rot = st.targetRot;
        if (assignedPersonas.has(id)) {
          // Walked back to the desk of a freshly running session.
          p.x = st.dest.x;
          p.z = st.dest.z;
          roamState.delete(id);
          setMood(ag, 'TYPING', ag.defaultBubble);
          return;
        }
        st.phase = 'stay';
        st.timer = 6 + Math.random() * 9;
        const mood = moodForSpot(ag, st.spot);
        setMood(ag, mood.state, mood.bubble);
      }
      return;
    }

    if (result.blocked) {
      st.repath += dt;
      st.stuck += dt;
      if (st.repath > 0.65) {
        st.waypoints = collisionWorld.findPath({ x: p.x, z: p.z }, st.dest, AGENT_RADIUS);
        st.repath = 0;
        if (st.waypoints.length === 0) st.stuck = 99;
      }
      if (st.stuck > 2.6) {
        st.stuck = 0;
        const retry = collisionWorld.findPath({ x: p.x, z: p.z }, st.dest, AGENT_RADIUS);
        if (assignedPersonas.has(id)) {
          // A running session must reach its desk: retry, then teleport.
          if (retry.length > 0) {
            st.waypoints = retry;
          } else {
            p.x = st.dest.x;
            p.z = st.dest.z;
            p.rot = st.targetRot;
            roamState.delete(id);
            setMood(ag, 'TYPING', ag.defaultBubble);
          }
          return;
        }
        // Give up gracefully instead of grinding against a wall forever.
        st.waypoints = [];
        st.phase = 'stay';
        st.timer = 2 + Math.random() * 3;
        setMood(ag, 'IDLE', 'Taking a breather');
      }
    } else {
      st.repath = 0;
      st.stuck = 0;
    }
  });
}

/* --------------------------------------------------------------------------
   Camera tween
   -------------------------------------------------------------------------- */
interface CamTween {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  start: number;
  duration: number;
}
let tween: CamTween | null = null;

function startTween(toPos: THREE.Vector3, toTarget: THREE.Vector3, duration = 900): void {
  if (!camera || !controls) return;
  tween = {
    fromPos: camera.position.clone(),
    toPos: toPos.clone(),
    fromTarget: controls.target.clone(),
    toTarget: toTarget.clone(),
    start: performance.now(),
    duration,
  };
}

function stepTween(now: number): void {
  if (!tween || !camera || !controls) return;
  const t = Math.min(1, (now - tween.start) / tween.duration);
  const e = t * t * (3 - 2 * t);
  camera.position.lerpVectors(tween.fromPos, tween.toPos, e);
  controls.target.lerpVectors(tween.fromTarget, tween.toTarget, e);
  if (t >= 1) tween = null;
}

const BASE_PRESETS: Record<string, { pos: [number, number, number]; look: [number, number, number] }> = {
  overview: { pos: [30, 140, 185], look: [30, 0, 24] },
  office: { pos: [25, 24, 33], look: [3, 0.4, 6] },
  iso: { pos: [25, 24, 33], look: [3, 0.4, 6] },
  dev: { pos: [0, 8.5, 13], look: [0, 1.3, -3.5] },
  server: { pos: [14, 5.5, -3], look: [18.5, 2, -11] },
  top: { pos: [30, 230, 0.01], look: [30, 0, 0] },
  lounge: { pos: [10, 7.2, 16.5], look: [18.6, 1.8, 9.5] },
  coffee: { pos: [-21, 5.5, 17], look: [-16, 1.2, 9.8] },
  pool: { pos: [80, 24, 62], look: [80, 0, 15] },
  padel: { pos: [28, 11, 16], look: [45, 1, -7] },
  soccer: { pos: [50, 16, 24], look: [73, 1, -15] },
  gym: { pos: [30, 12, 52], look: [48, 1, 38] },
  basket: { pos: [58, 14, -28], look: [72, 1, -40] },
  cinema: { pos: [-16, 9, -18], look: [-32, 1.5, -34] },
  tennis: { pos: [-8, 12, -34], look: [-30, 1, -49] },
  command: { pos: [96, 14, -22], look: [96, 6, -38] },
  board: { pos: [40, 8.4, 28.5], look: [40, 3.2, 14] },
  village: { pos: [86, 13, 86], look: [86, 1, 61] },
};

/** Camera presets for the active world (filled by rebuildPresets). */
const PRESETS: Record<string, { pos: [number, number, number]; look: [number, number, number] }> = {};

/**
 * World coordinates for a campus-local point under the active site-plan
 * rotation. The sim and physics run in the local frame; the camera does not.
 */
function worldPoint(x: number, z: number): { x: number; z: number } {
  const deg = activeTheme().layout.rotate;
  if (!deg) return { x, z };
  const rad = (deg * Math.PI) / 180;
  const dx = x - FLOOR_CENTER.x;
  const dz = z - FLOOR_CENTER.z;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: FLOOR_CENTER.x + dx * cos - dz * sin, z: FLOOR_CENTER.z + dx * sin + dz * cos };
}

function rebuildPresets(): void {
  const L = activeTheme().layout;
  const shift = (
    p: { pos: [number, number, number]; look: [number, number, number] },
    [dx, dz]: [number, number],
  ): { pos: [number, number, number]; look: [number, number, number] } => ({
    pos: [p.pos[0] + dx, p.pos[1], p.pos[2] + dz],
    look: [p.look[0] + dx, p.look[1], p.look[2] + dz],
  });
  const rotate = (
    p: { pos: [number, number, number]; look: [number, number, number] },
  ): { pos: [number, number, number]; look: [number, number, number] } => {
    const a = worldPoint(p.pos[0], p.pos[2]);
    const b = worldPoint(p.look[0], p.look[2]);
    return { pos: [a.x, p.pos[1], a.z], look: [b.x, p.look[1], b.z] };
  };
  for (const key of Object.keys(BASE_PRESETS)) PRESETS[key] = rotate(BASE_PRESETS[key]!);
  PRESETS['pool'] = rotate(shift(BASE_PRESETS['pool']!, L.pool));
  PRESETS['gym'] = rotate(shift(BASE_PRESETS['gym']!, L.pool));
  PRESETS['padel'] = rotate(shift(BASE_PRESETS['padel']!, L.sports));
  PRESETS['soccer'] = rotate(shift(BASE_PRESETS['soccer']!, L.sports));
  PRESETS['basket'] = rotate(shift(BASE_PRESETS['basket']!, L.sports));
  PRESETS['cinema'] = rotate(shift(BASE_PRESETS['cinema']!, L.attractions));
  PRESETS['tennis'] = rotate(shift(BASE_PRESETS['tennis']!, L.attractions));
  PRESETS['village'] = rotate(shift(BASE_PRESETS['village']!, L.village));
  const c = L.towers.command;
  PRESETS['command'] = rotate({ pos: [c.x, 14, c.z + 20], look: [c.x, 6, c.z + 4] });
}

export function setCameraPreset(name: string): void {
  const p = PRESETS[name];
  if (!p) return;
  startTween(new THREE.Vector3(...p.pos), new THREE.Vector3(...p.look));
}

function focusCameraOnAgent(id: AgentId): void {
  const p = pose.get(id) ?? { x: AGENTS[id].pos3D.x, z: AGENTS[id].pos3D.z, rot: 0 };
  const w = worldPoint(p.x, p.z);
  const wBehind = worldPoint(p.x, p.z + 8);
  startTween(new THREE.Vector3(wBehind.x, 6.5, wBehind.z), new THREE.Vector3(w.x, 1.3, w.z));
}

/* --------------------------------------------------------------------------
   Materials & furniture
   -------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------
   Live data screens (command center, task board, monitor feed, server status)
   -------------------------------------------------------------------------- */
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function makeScreenTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function statusColor(status: string): string {
  return status === 'running' ? '#34d399' : status === 'failed' ? '#fb7185' : '#94a3b8';
}

function typeColor(type: string): string {
  if (type === 'THOUGHT') return '#a5b4fc';
  if (type === 'TOOL') return '#7dd3fc';
  if (type === 'BASH') return '#fcd34d';
  if (type === 'SUCCESS') return '#6ee7b7';
  if (type === 'ASSISTANT') return '#93c5fd';
  if (type === 'USER') return '#d8b4fe';
  return '#cbd5e1';
}

/**
 * Raycast registry: only these roots are ever tested for hover/click.
 */
const interactiveRoots: THREE.Object3D[] = [];

/**
 * Only these categories stay interactive: the live-data surfaces and the
 * places that matter. Everything decorative (roads, furniture, sports courts,
 * attractions, animals, visitors, staff, towers, the jungle) is invisible to
 * hover/click, so interaction is reserved for agents, live screens and
 * workstations.
 */
const INTERACTIVE_KINDS = new Set(['Workstation', 'Live Screen']);

function tagInspect(
  object: THREE.Object3D,
  label: string,
  kind: string,
  detail?: string,
  preset?: string,
): void {
  const info: InspectInfo = { label, kind, detail, preset };
  object.userData['inspect'] = info;
  if (INTERACTIVE_KINDS.has(kind)) interactiveRoots.push(object);
}

function registerInteractive(object: THREE.Object3D): void {
  interactiveRoots.push(object);
}

function unregisterInteractive(object: THREE.Object3D): void {
  const index = interactiveRoots.indexOf(object);
  if (index >= 0) interactiveRoots.splice(index, 1);
}

function setAssetStatus(text: string, detail?: string): void {
  const el = document.getElementById('assetStatus');
  if (!el) return;
  el.textContent = text;
  if (detail) el.title = detail;
}

function initLiveScreens(): void {
  liveFeedCanvas = makeCanvas(512, 256);
  liveFeedTexture = makeScreenTexture(liveFeedCanvas);
  commandCanvas = makeCanvas(1024, 512);
  commandTexture = makeScreenTexture(commandCanvas);
  boardCanvas = makeCanvas(1024, 512);
  boardTexture = makeScreenTexture(boardCanvas);
  serverCanvas = makeCanvas(512, 256);
  serverTexture = makeScreenTexture(serverCanvas);
  paintScreens(true);
}

interface FeedEntry {
  time: number;
  type: string;
  label: string;
  message: string;
}

function recentFeedEntries(limit: number): FeedEntry[] {
  const logs = logStore.entries.slice(-limit);
  if (logs.length > 0) {
    return logs.map((entry) => ({
      time: entry.time,
      type: entry.type,
      label: entry.sessionTitle ?? (entry.agent === 'system' ? 'SYS' : AGENTS[entry.agent]?.name ?? 'SYS'),
      message: entry.message,
    }));
  }
  return sessionStore.sessions
    .filter((session) => session.activity)
    .sort((a, b) => (b.activity?.at ?? 0) - (a.activity?.at ?? 0))
    .slice(0, limit)
    .map((session) => ({
      time: session.activity?.at ?? session.updated,
      type: session.activity?.type ?? 'INFO',
      label: session.title,
      message: session.activity?.text ?? 'No activity recorded',
    }));
}

function paintLiveFeed(): void {
  if (!liveFeedCanvas || !liveFeedTexture) return;
  const ctx = liveFeedCanvas.getContext('2d');
  if (!ctx) return;
  const w = liveFeedCanvas.width;
  const h = liveFeedCanvas.height;
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, w, h);

  const running = sessionStore.sessions.filter((s) => s.status === 'running').length;
  ctx.fillStyle = '#e2e8f0';
  ctx.font = 'bold 18px monospace';
  ctx.fillText('LIVE AGENT FEED', 16, 28);
  ctx.fillStyle = '#38bdf8';
  ctx.font = '14px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`${sessionStore.sessions.length} sessions · ${running} running`, w - 16, 28);
  ctx.textAlign = 'left';

  const logs = recentFeedEntries(5);
  ctx.font = '13px monospace';
  logs.forEach((entry, i) => {
    const y = 58 + i * 34;
    ctx.fillStyle = '#64748b';
    ctx.fillText(new Date(entry.time).toLocaleTimeString('en-GB'), 16, y);
    ctx.fillStyle = typeColor(entry.type);
    ctx.fillText(entry.type.padEnd(9, ' '), 110, y);
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(truncateText(`${entry.label}: ${entry.message}`, 48), 206, y);
  });

  ctx.strokeStyle = '#1e293b';
  ctx.beginPath();
  ctx.moveTo(0, h - 30);
  ctx.lineTo(w, h - 30);
  ctx.stroke();
  ctx.fillStyle = '#94a3b8';
  ctx.font = '12px monospace';
  ctx.fillText(
    `tokens ${formatTokens(sessionStore.totals.tokens)} · cost $${sessionStore.totals.cost.toFixed(2)} · ${sessionStore.connected ? 'bridge online' : 'bridge offline'}`,
    16,
    h - 10,
  );
  liveFeedTexture.needsUpdate = true;
}

function paintCommand(): void {
  if (!commandCanvas || !commandTexture) return;
  const ctx = commandCanvas.getContext('2d');
  if (!ctx) return;
  const w = commandCanvas.width;
  const h = commandCanvas.height;
  ctx.fillStyle = '#080d18';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 3;
  ctx.strokeRect(6, 6, w - 12, h - 12);

  ctx.fillStyle = '#fbbf24';
  ctx.font = 'bold 28px monospace';
  ctx.fillText('OPENCODE COMMAND CENTER', 28, 44);
  ctx.fillStyle = '#94a3b8';
  ctx.font = '15px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(new Date().toLocaleTimeString('en-GB'), w - 28, 40);
  ctx.textAlign = 'left';

  const running = sessionStore.sessions.filter((s) => s.status === 'running').length;
  ctx.fillStyle = '#e2e8f0';
  ctx.font = 'bold 17px monospace';
  ctx.fillText(`SESSIONS  ${sessionStore.sessions.length}`, 28, 82);
  ctx.fillStyle = '#94a3b8';
  ctx.font = '14px monospace';
  ctx.fillText(`${running} running · ${sessionStore.sessions.length - running} idle / failed`, 28, 104);

  const sessions = sessionStore.sessions.slice(0, 7);
  sessions.forEach((session, i) => {
    const y = 136 + i * 44;
    ctx.fillStyle = statusColor(session.status);
    ctx.beginPath();
    ctx.arc(38, y - 5, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 15px monospace';
    ctx.fillText(truncateText(session.title, 42), 54, y);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px monospace';
    ctx.fillText(
      `${session.status.toUpperCase()} · ${truncateText(session.model?.label ?? '—', 34)} · ${formatTokens(session.tokens)} tok · $${session.cost.toFixed(2)}`,
      54,
      y + 17,
    );
  });
  if (sessions.length === 0) {
    ctx.fillStyle = '#64748b';
    ctx.font = '15px monospace';
    ctx.fillText('No live sessions — start the bridge.', 28, 150);
  }

  ctx.strokeStyle = '#1e293b';
  ctx.beginPath();
  ctx.moveTo(520, 70);
  ctx.lineTo(520, h - 60);
  ctx.stroke();

  ctx.fillStyle = '#e2e8f0';
  ctx.font = 'bold 17px monospace';
  ctx.fillText('LIVE ACTIVITY', 546, 82);
  const logs = recentFeedEntries(7);
  logs.forEach((entry, i) => {
    const y = 114 + i * 36;
    ctx.fillStyle = '#64748b';
    ctx.font = '12px monospace';
    ctx.fillText(new Date(entry.time).toLocaleTimeString('en-GB'), 546, y);
    ctx.fillStyle = typeColor(entry.type);
    ctx.fillText(entry.type.padEnd(9, ' '), 630, y);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '12px monospace';
    ctx.fillText(truncateText(`${entry.label}: ${entry.message}`, 38), 712, y);
  });
  if (logs.length === 0) {
    ctx.fillStyle = '#64748b';
    ctx.font = '14px monospace';
    ctx.fillText('Waiting for live events…', 546, 130);
  }

  ctx.fillStyle = '#94a3b8';
  ctx.font = '13px monospace';
  ctx.fillText(
    `TOTAL ${formatTokens(sessionStore.totals.tokens)} tokens · $${sessionStore.totals.cost.toFixed(2)} · ${sessionStore.connected ? 'BRIDGE ONLINE' : 'BRIDGE OFFLINE'}`,
    28,
    h - 26,
  );
  commandTexture.needsUpdate = true;
}

function paintBoard(): void {
  if (!boardCanvas || !boardTexture) return;
  const ctx = boardCanvas.getContext('2d');
  if (!ctx) return;
  const w = boardCanvas.width;
  const h = boardCanvas.height;
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#e2e8f0';
  ctx.font = 'bold 26px monospace';
  ctx.fillText('SESSION BOARD', 24, 40);

  const columns: { key: SessionStatus; label: string; x: number; color: string }[] = [
    { key: 'running', label: 'RUNNING', x: 24, color: '#34d399' },
    { key: 'idle', label: 'IDLE', x: 352, color: '#94a3b8' },
    { key: 'failed', label: 'FAILED', x: 680, color: '#fb7185' },
  ];
  columns.forEach((column) => {
    ctx.fillStyle = '#111c2e';
    ctx.fillRect(column.x, 62, 310, h - 86);
    ctx.strokeStyle = column.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(column.x, 62, 310, h - 86);
    ctx.fillStyle = column.color;
    ctx.font = 'bold 16px monospace';
    const count = sessionStore.sessions.filter((s) => s.status === column.key).length;
    ctx.fillText(`${column.label} · ${count}`, column.x + 14, 88);

    sessionStore.sessions
      .filter((s) => s.status === column.key)
      .slice(0, 6)
      .forEach((session, i) => {
        const y = 106 + i * 62;
        ctx.fillStyle = '#17243a';
        ctx.fillRect(column.x + 12, y, 286, 52);
        ctx.fillStyle = '#e2e8f0';
        ctx.font = 'bold 13px monospace';
        ctx.fillText(truncateText(session.title, 32), column.x + 22, y + 21);
        ctx.fillStyle = '#94a3b8';
        ctx.font = '11px monospace';
        ctx.fillText(
          `${truncateText(session.model?.label ?? '—', 26)} · ${formatTokens(session.tokens)} tok`,
          column.x + 22,
          y + 40,
        );
      });
  });
  boardTexture.needsUpdate = true;
}

function paintServerScreen(): void {
  if (!serverCanvas || !serverTexture) return;
  const ctx = serverCanvas.getContext('2d');
  if (!ctx) return;
  const w = serverCanvas.width;
  const h = serverCanvas.height;
  ctx.fillStyle = '#050a12';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#0284c7';
  ctx.lineWidth = 2;
  ctx.strokeRect(4, 4, w - 8, h - 8);

  ctx.fillStyle = '#7dd3fc';
  ctx.font = 'bold 20px monospace';
  ctx.fillText('OPENCODE SERVICE', 18, 34);
  ctx.fillStyle = sessionStore.connected ? '#34d399' : '#fb7185';
  ctx.font = 'bold 16px monospace';
  ctx.fillText(sessionStore.connected ? '● ONLINE' : '● OFFLINE', w - 130, 34);

  const running = sessionStore.sessions.filter((s) => s.status === 'running').length;
  ctx.fillStyle = '#e2e8f0';
  ctx.font = '15px monospace';
  ctx.fillText(`bridge   ${appState.bridgeUrl}`, 18, 72);
  ctx.fillText(`sessions ${sessionStore.sessions.length}   running ${running}`, 18, 98);
  ctx.fillText(`tokens   ${formatTokens(sessionStore.totals.tokens)}`, 18, 124);
  ctx.fillText(`cost     $${sessionStore.totals.cost.toFixed(2)}`, 18, 150);
  const last = logStore.entries[logStore.entries.length - 1];
  ctx.fillStyle = '#94a3b8';
  ctx.font = '12px monospace';
  ctx.fillText(
    last ? `last event ${new Date(last.time).toLocaleTimeString('en-GB')} · ${last.type}` : 'waiting for events…',
    18,
    184,
  );
  ctx.fillStyle = '#38bdf8';
  for (let i = 0; i < 16; i++) {
    const bar = 6 + Math.abs(Math.sin(i * 0.9 + Date.now() / 900)) * 22;
    ctx.fillRect(18 + i * 30, 220 - bar, 18, bar);
  }
  ctx.fillStyle = '#475569';
  ctx.font = '11px monospace';
  ctx.fillText('OPENCODE MANSION · INFRASTRUCTURE', 18, 244);
  serverTexture.needsUpdate = true;
}

function paintScreens(force = false): void {
  const now = Date.now();
  if (!force && now - screensLastPaint < 1000) return;
  screensLastPaint = now;
  paintLiveFeed();
  paintCommand();
  paintBoard();
  paintServerScreen();
}

function createSkyTexture(isDark: boolean): THREE.CanvasTexture {
  const P = activeTheme();
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const stops = isDark ? P.skyNight : P.skyDay;
    const gradient = ctx.createLinearGradient(0, 0, 0, 256);
    gradient.addColorStop(0, stops[0]);
    gradient.addColorStop(0.55, stops[1]);
    gradient.addColorStop(1, stops[2]);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 96, 256);
    if (P.stars) {
      const starCount = isDark ? 220 : 120;
      for (let i = 0; i < starCount; i++) {
        const x = (i * 37.7) % 96;
        const y = ((i * 71.3) % 256) * (isDark ? 1 : 0.6);
        const s = (i % 7) === 0 ? 1.6 : 0.9;
        ctx.fillStyle = `rgba(255,255,255,${0.25 + ((i * 13) % 10) / 22})`;
        ctx.fillRect(x, y, s, s);
      }
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function createCampusTexture(isDark: boolean): THREE.CanvasTexture {
  const P = activeTheme();
  const stripes = isDark ? P.campusNight : P.campusDay;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = stripes[0];
    ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 === 0 ? stripes[1] : stripes[2];
      ctx.fillRect(0, (i * 512) / 8, 512, 512 / 8);
    }
    for (let i = 0; i < 140; i++) {
      const x = (i * 83) % 512;
      const y = (i * 149) % 512;
      ctx.fillStyle = i % 3 === 0
        ? isDark ? 'rgba(74,222,128,0.10)' : 'rgba(255,255,255,0.08)'
        : isDark ? 'rgba(0,0,0,0.12)' : 'rgba(20,83,45,0.07)';
      ctx.fillRect(x, y, 3 + (i % 5), 2 + (i % 4));
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(9, 8);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createPlazaTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#c9c3b7';
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = '#b3ac9f';
    ctx.lineWidth = 3;
    for (let i = 0; i <= 256; i += 32) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, 256);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(256, i);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    for (let i = 0; i < 20; i++) {
      ctx.fillRect((i * 53) % 256, (i * 97) % 256, 10, 6);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 2);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createParquetTexture(isDark: boolean): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = isDark ? '#111827' : '#e5cfae';
    ctx.fillRect(0, 0, 512, 512);
    ctx.strokeStyle = isDark ? '#1f2937' : '#d2b88f';
    ctx.lineWidth = 2;
    for (let y = 0; y < 512; y += 32) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(512, y);
      ctx.stroke();
    }
    for (let x = 0; x < 512; x += 64) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 512);
      ctx.stroke();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(7, 5);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createWindowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, '#dbeafe');
    grad.addColorStop(0.55, '#bfdbfe');
    grad.addColorStop(1, '#e0f2fe');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 128);
    ctx.fillStyle = 'rgba(148,163,184,0.35)';
    ctx.fillRect(0, 72, 256, 2);
    ctx.fillRect(40, 20, 60, 40);
    ctx.fillRect(140, 30, 80, 30);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function buildFloorAndWalls(root: THREE.Group, isDark: boolean): void {
  const P = activeTheme();
  const floorMat =
    pbrMaterial(realisticAssets, 'grass', [18, 15], {
      color: isDark ? P.lawnTintNight : P.lawnTintDay,
      roughness: 1,
      normalScale: 0.35,
    }) ??
    new THREE.MeshStandardMaterial({
      map: createCampusTexture(isDark),
      roughness: 0.92,
      metalness: 0.02,
    });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.w, ROOM.d), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(FLOOR_CENTER.x, 0, FLOOR_CENTER.z);
  floor.receiveShadow = true;
  root.add(floor);

  // Office wing keeps a warm parquet floor on top of the campus lawn.
  const officeMat =
    pbrMaterial(realisticAssets, 'wood', [12, 8], {
      color: isDark ? 0x9a9a9a : 0xffffff,
      roughness: 0.7,
      normalScale: 0.45,
    }) ??
    new THREE.MeshStandardMaterial({
      map: createParquetTexture(isDark),
      color: isDark ? 0xffffff : 0xcdae86,
      roughness: 0.75,
      metalness: 0.05,
    });
  const officeFloor = new THREE.Mesh(new THREE.PlaneGeometry(45.6, 30.2), officeMat);
  officeFloor.rotation.x = -Math.PI / 2;
  officeFloor.position.set(0, 0.006, 0.1);
  officeFloor.receiveShadow = true;
  root.add(officeFloor);

  // The campus is open-air; only the office wing keeps a back wall.
  const wallMat = new THREE.MeshStandardMaterial({ color: isDark ? P.wallNight : P.wallDay, roughness: 0.9 });
  const outerLawnMat =
    pbrMaterial(realisticAssets, 'grass', [30, 26], {
      color: isDark ? P.lawnTintNight : P.lawnTintDay,
      roughness: 1,
      normalScale: 0.3,
    }) ??
    new THREE.MeshStandardMaterial({ color: isDark ? 0x0f2b1c : 0x5da94f, roughness: 1 });
  const outerLawn = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.w + 12, ROOM.d + 10), outerLawnMat);
  outerLawn.rotation.x = -Math.PI / 2;
  outerLawn.position.set(FLOOR_CENTER.x, -0.04, FLOOR_CENTER.z);
  outerLawn.receiveShadow = true;
  root.add(outerLawn);

  // Office wing keeps its own back wall + windows at z = -15.
  const officeWall = new THREE.Mesh(new THREE.BoxGeometry(44, 5.6, 0.4), wallMat);
  officeWall.position.set(0, 2.8, -14.8);
  officeWall.receiveShadow = true;
  root.add(officeWall);

  const frameMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x3f3f46 : 0x94a3b8, metalness: 0.3 });
  const glassMat = new THREE.MeshStandardMaterial({
    map: createWindowTexture(),
    emissive: isDark ? P.glassNight : P.glassDay,
    emissiveIntensity: isDark ? 0.35 : 0.15,
    roughness: 0.2,
  });
  const addWindow = (x: number, z: number): void => {
    const frame = new THREE.Mesh(new THREE.BoxGeometry(4.4, 2.6, 0.12), frameMat);
    frame.position.set(x, 3.1, z);
    root.add(frame);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(4.1, 2.3), glassMat);
    glass.position.set(x, 3.1, z + 0.08);
    root.add(glass);
    const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.3, 0.05), frameMat);
    mullion.position.set(x, 3.1, z + 0.1);
    root.add(mullion);
  };
  for (let i = 0; i < 5; i++) addWindow(-16 + i * 8, -14.72);

  // Brand signage
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, 512, 128);
    ctx.fillStyle = isDark ? '#e4e4e7' : '#0f172a';
    ctx.font = 'bold 52px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('OPENCODE MANSION', 256, 82);
  }
  const brandTexture = new THREE.CanvasTexture(canvas);
  brandTexture.colorSpace = THREE.SRGBColorSpace;
  const brand = new THREE.Mesh(
    new THREE.PlaneGeometry(7.2, 1.8),
    new THREE.MeshBasicMaterial({ map: brandTexture, transparent: true }),
  );
  brand.position.set(0, 5.0, -14.62);
  root.add(brand);
}

function createMonitor(
  parent: THREE.Group,
  x: number,
  y: number,
  z: number,
  rotY: number,
  screenColor: number,
): void {
  const standMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.3 });
  const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.4), standMat);
  stand.position.set(x, y + 0.2, z);
  parent.add(stand);

  const base = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.2), standMat);
  base.position.set(x, y + 0.01, z);
  parent.add(base);

  const frame = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.72, 0.05), standMat);
  frame.position.set(x, y + 0.45, z);
  frame.rotation.y = rotY;
  frame.castShadow = true;
  parent.add(frame);

  const screenMat = liveFeedTexture
    ? new THREE.MeshBasicMaterial({ map: liveFeedTexture })
    : new THREE.MeshStandardMaterial({
        color: screenColor,
        emissive: screenColor,
        emissiveIntensity: 0.5,
        roughness: 0.2,
      });
  const screen = new THREE.Mesh(new THREE.BoxGeometry(1.16, 0.63, 0.02), screenMat);
  screen.position.set(0, 0, 0.028);
  frame.add(screen);
}

function buildDesks(root: THREE.Group, isDark: boolean): void {
  const deskMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x27272a : 0xede4d5, roughness: 0.6 });
  const legMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x3f3f46 : 0x64748b, roughness: 0.4 });

  const agentByDesk = new Map<number, AgentDef>();
  Object.values(AGENTS).forEach((a) => agentByDesk.set(a.deskIndex, a));

  for (let i = 0; i < 10; i++) {
    const row = Math.floor(i / 5);
    const x = DESK_X[i % 5] ?? 0;
    const z = DESK_ROW_Z[row] ?? 0;
    const deskGroup = new THREE.Group();
    deskGroup.position.set(x, 0, z);

    const top = new THREE.Mesh(new THREE.BoxGeometry(3.1, 0.1, 1.7), deskMat);
    top.position.y = 1.02;
    top.castShadow = true;
    top.receiveShadow = true;
    deskGroup.add(top);

    const legGeo = new THREE.BoxGeometry(0.07, 1.0, 0.07);
    ([-1.45, 1.45] as number[]).forEach((lx) => {
      ([-0.75, 0.75] as number[]).forEach((lz) => {
        const leg = new THREE.Mesh(legGeo, legMat);
        leg.position.set(lx, 0.5, lz);
        leg.castShadow = true;
        deskGroup.add(leg);
      });
    });

    const ag = agentByDesk.get(i);
    const screenColor = ag?.color ?? 0x64748b;
    createMonitor(deskGroup, -0.55, 1.07, -0.5, 0.08, screenColor);
    createMonitor(deskGroup, 0.55, 1.07, -0.5, -0.08, 0x10b981);
    tagInspect(
      deskGroup,
      `Workstation ${i + 1}`,
      'Workstation',
      ag ? `${ag.name} · ${ag.role} · monitor live feed` : 'Open workstation · live monitor feed',
    );
    root.add(deskGroup);
  }
}

function buildWhiteboard(root: THREE.Group): void {
  const group = new THREE.Group();
  group.position.set(-19, 0, -11.4);
  group.rotation.y = Math.PI / 4;

  const frameMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.3 });
  const boardMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });

  const board = new THREE.Mesh(new THREE.BoxGeometry(3.6, 2.2, 0.08), frameMat);
  board.position.y = 2.3;
  board.castShadow = true;
  group.add(board);

  const surface = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 2.0), boardMat);
  surface.position.set(0, 2.3, 0.045);
  group.add(surface);

  const leg1 = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.3, 0.08), frameMat);
  leg1.position.set(-1.6, 1.15, 0);
  group.add(leg1);
  const leg2 = leg1.clone();
  leg2.position.set(1.6, 1.15, 0);
  group.add(leg2);
  tagInspect(group, 'Planning Whiteboard', 'Office Prop', 'Papan sketsa dan catatan tim.');

  // Sketched notes
  const notes: [number, number, number, number][] = [
    [-0.9, 1.8, 0.5, 0.35],
    [0.1, 2.0, 0.9, 0.28],
    [0.9, 1.6, 0.35, 0.5],
  ];
  notes.forEach(([nx, ny, w, h]) => {
    const note = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: 0xfef08a }),
    );
    note.position.set(nx, ny, 0.05);
    group.add(note);
  });

  root.add(group);
}

function buildServerRack(root: THREE.Group, isDark: boolean, x: number, z: number, rotY: number): void {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.rotation.y = rotY;
  tagInspect(group, 'Server Rack', 'Infrastructure', 'Rack server dengan LED status animasi.');

  const cabinetMat = new THREE.MeshStandardMaterial({
    color: isDark ? 0x09090b : 0x1e293b,
    metalness: 0.6,
    roughness: 0.4,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.7, 4.4, 1.5), cabinetMat);
  body.position.y = 2.2;
  body.castShadow = true;
  group.add(body);

  for (let i = 0; i < 8; i++) {
    const slot = new THREE.Mesh(
      new THREE.BoxGeometry(1.45, 0.3, 0.05),
      new THREE.MeshStandardMaterial({ color: 0x0f172a }),
    );
    slot.position.set(0, 0.7 + i * 0.44, 0.76);
    group.add(slot);

    const led1 = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.05, 0.02),
      new THREE.MeshBasicMaterial({ color: 0x10b981 }),
    );
    led1.position.set(-0.5, 0.7 + i * 0.44, 0.79);
    group.add(led1);
    serverLeds.push({ mesh: led1, rate: 2 + i * 0.7 });

    const led2 = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.05, 0.02),
      new THREE.MeshBasicMaterial({ color: 0x0284c7 }),
    );
    led2.position.set(-0.35, 0.7 + i * 0.44, 0.79);
    group.add(led2);
    serverLeds.push({ mesh: led2, rate: 3 + i * 0.5 });
  }

  root.add(group);
}

function buildCoffeeStation(root: THREE.Group, isDark: boolean): void {
  const group = new THREE.Group();
  group.position.set(-16, 0, 10.4);
  tagInspect(group, 'Espresso Bar', 'Pantry', 'Mesin kopi, mug, dan kursi bar. Klik agent untuk detail sesi.');

  const counterMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x18181b : 0xe2d8c9, roughness: 0.6 });
  const counter = new THREE.Mesh(new THREE.BoxGeometry(4.6, 1.1, 1.5), counterMat);
  counter.position.y = 0.55;
  counter.castShadow = true;
  group.add(counter);

  const top = new THREE.Mesh(
    new THREE.BoxGeometry(4.9, 0.09, 1.7),
    new THREE.MeshStandardMaterial({ color: isDark ? 0x3f3f46 : 0xcdb79e, roughness: 0.4 }),
  );
  top.position.y = 1.14;
  group.add(top);

  const machineMat = new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.7 });
  const machine = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.65, 0.6), machineMat);
  machine.position.set(-0.6, 1.5, 0);
  machine.castShadow = true;
  group.add(machine);

  const panel = new THREE.Mesh(
    new THREE.BoxGeometry(0.55, 0.16, 0.03),
    new THREE.MeshStandardMaterial({ color: 0xcbd5e1, metalness: 0.8, roughness: 0.25 }),
  );
  panel.position.set(-0.6, 1.62, 0.32);
  group.add(panel);

  const wand = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.02, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.9 }),
  );
  wand.position.set(-0.12, 1.38, 0.3);
  wand.rotation.z = 0.3;
  group.add(wand);

  const mugMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2 });
  for (let i = 0; i < 4; i++) {
    const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.12), mugMat);
    mug.position.set(0.8 + i * 0.3, 1.25, 0.25);
    group.add(mug);
  }

  // Stools
  const stoolMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x3f3f46 : 0x94a3b8, metalness: 0.3 });
  [-1.4, 1.4].forEach((sx) => {
    const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.08), stoolMat);
    seat.position.set(sx, 0.72, -1.4);
    group.add(seat);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.72), stoolMat);
    stem.position.set(sx, 0.36, -1.4);
    group.add(stem);
  });

  root.add(group);

  // Steam over the espresso machine
  const steamGeo = new THREE.SphereGeometry(0.035, 4, 4);
  const steamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 });
  for (let p = 0; p < 8; p++) {
    const steam = new THREE.Mesh(steamGeo, steamMat);
    steam.position.set(-16.6 + (Math.random() - 0.5) * 0.12, 1.9 + p * 0.12, 10.4);
    root.add(steam);
    steamParticles.push(steam);
  }
}

function buildLounge(root: THREE.Group, isDark: boolean): void {
  // Rug
  const rug = new THREE.Mesh(
    new THREE.PlaneGeometry(6.5, 11.6),
    new THREE.MeshStandardMaterial({ color: isDark ? 0x3f3f46 : 0xe2e8f0, roughness: 0.95 }),
  );
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(17.5, 0.015, 9.5);
  rug.receiveShadow = true;
  root.add(rug);

  // Sofa (faces +x toward the TV wall; backrest on the -x side)
  const sofa = addProp(root, realisticAssets, 'sofa', {
    x: 14.6,
    z: 9.5,
    rot: Math.PI / 2,
    size: 4.4,
    axis: 'width',
    inspect: {
      label: 'Lounge Sofa',
      kind: 'Furniture',
      detail: 'CC0 Poly Haven sofa in the live lounge.',
      preset: 'lounge',
    },
  });
  if (sofa) {
    tagInspect(sofa, 'Lounge Sofa', 'Furniture', 'CC0 Poly Haven sofa in the live lounge.', 'lounge');
  } else {
    const sofaMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x334155 : 0xa8b8c8, roughness: 0.85 });
    const fallbackSofa = new THREE.Group();
    fallbackSofa.position.set(14.6, 0, 9.5);
    fallbackSofa.rotation.y = Math.PI / 2;
    const base = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.45, 1.5), sofaMat);
    base.position.y = 0.35;
    base.castShadow = true;
    fallbackSofa.add(base);
    const back = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.85, 0.3), sofaMat);
    back.position.set(0, 0.9, -0.62);
    fallbackSofa.add(back);
    [-2.15, 2.15].forEach((ax) => {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.6, 1.5), sofaMat);
      arm.position.set(ax, 0.6, 0);
      fallbackSofa.add(arm);
    });
    const cushionMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x475569 : 0x94a3b8, roughness: 0.9 });
    [-1.3, 0, 1.3].forEach((cx) => {
      const cushion = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.16, 1.2), cushionMat);
      cushion.position.set(cx, 0.62, 0);
      fallbackSofa.add(cushion);
    });
    root.add(fallbackSofa);
  }

  // Coffee table
  const table = addProp(root, realisticAssets, 'coffee-table', {
    x: 17.9,
    z: 9.5,
    rot: 0,
    size: 2.6,
    axis: 'depth',
    inspect: {
      label: 'Coffee Table',
      kind: 'Furniture',
      detail: 'CC0 Poly Haven coffee table.',
      preset: 'lounge',
    },
  });
  if (table) {
    tagInspect(table, 'Coffee Table', 'Furniture', 'CC0 Poly Haven coffee table.', 'lounge');
  } else {
    const tableMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x27272a : 0xb08968, roughness: 0.6 });
    const fallbackTable = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 2.6), tableMat);
    fallbackTable.position.set(17.9, 0.5, 9.5);
    fallbackTable.castShadow = true;
    root.add(fallbackTable);
    [-1.1, 1.1].forEach((lz) => {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.08), tableMat);
      leg.position.set(17.9, 0.25, 9.5 + lz);
      root.add(leg);
    });
  }

  // Reading corner: a second CC0 armchair and shelf when the assets are ready.
  const readingChair = addProp(root, realisticAssets, 'armchair', {
    x: 19.4,
    z: 13.6,
    rot: -Math.PI * 0.75,
    size: 1.35,
    axis: 'width',
    inspect: {
      label: 'Reading Armchair',
      kind: 'Furniture',
      detail: 'CC0 Poly Haven armchair in the lounge reading corner.',
      preset: 'lounge',
    },
  });
  if (readingChair) {
    tagInspect(readingChair, 'Reading Armchair', 'Furniture', 'CC0 Poly Haven armchair in the lounge reading corner.', 'lounge');
  }
  const shelf = addProp(root, realisticAssets, 'shelf', {
    x: 20.9,
    z: 13.2,
    rot: -Math.PI / 2,
    size: 2.1,
    axis: 'height',
    inspect: {
      label: 'Lounge Shelf',
      kind: 'Furniture',
      detail: 'CC0 Poly Haven shelf.',
      preset: 'lounge',
    },
  });
  if (shelf) tagInspect(shelf, 'Lounge Shelf', 'Furniture', 'CC0 Poly Haven shelf.', 'lounge');

  // TV console + screen, mounted on the right wall
  const consoleMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x18181b : 0x334155, roughness: 0.5 });
  const tvConsole = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 5.2), consoleMat);
  tvConsole.position.set(21.2, 0.35, 9.5);
  root.add(tvConsole);

  const tvFrame = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 2.35, 4.2),
    new THREE.MeshStandardMaterial({ color: 0x09090b, roughness: 0.3 }),
  );
  tvFrame.position.set(21.35, 2.0, 9.5);
  root.add(tvFrame);

  // Animated screen (canvas texture repainted in the render loop)
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 288;
  tvTexture = new THREE.CanvasTexture(canvas);
  tvTexture.colorSpace = THREE.SRGBColorSpace;
  paintTvScreen(0);
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(3.95, 2.15),
    new THREE.MeshBasicMaterial({ map: tvTexture }),
  );
  screen.position.set(21.27, 2.0, 9.5);
  screen.rotation.y = -Math.PI / 2;
  root.add(screen);
  tagInspect(
    screen,
    'Lounge TV · CI Feed',
    'Live Screen',
    'Layar TV lounge menampilkan status CI/build nyata dari event OpenCode.',
    'lounge',
  );

  // Rear-facing signage panel (same feed) so the iso view sees a screen too.
  const rearScreen = new THREE.Mesh(
    new THREE.PlaneGeometry(3.95, 2.15),
    new THREE.MeshBasicMaterial({ map: tvTexture }),
  );
  rearScreen.position.set(21.43, 2.0, 9.5);
  rearScreen.rotation.y = Math.PI / 2;
  root.add(rearScreen);

  // Floor lamp
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.5 });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.2), lampMat);
  pole.position.set(19.1, 1.1, 5.9);
  root.add(pole);
  const shade = new THREE.Mesh(
    new THREE.ConeGeometry(0.42, 0.5, 14, 1, true),
    new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      emissive: 0xfef3c7,
      emissiveIntensity: 0.7,
      side: THREE.DoubleSide,
    }),
  );
  shade.position.set(19.1, 2.25, 5.9);
  root.add(shade);
}

function paintTvScreen(t: number): void {
  if (!tvTexture) return;
  const canvas = tvTexture.image as HTMLCanvasElement;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#38bdf8';
  ctx.font = 'bold 26px monospace';
  ctx.fillText('CI · LIVE', 24, 40);

  // Bars
  for (let i = 0; i < 9; i++) {
    const h = 40 + (Math.sin(t * 1.6 + i * 0.7) * 0.5 + 0.5) * 120;
    ctx.fillStyle = i % 2 === 0 ? '#22d3ee' : '#818cf8';
    ctx.fillRect(26 + i * 42, 220 - h, 26, h);
  }

  // Sparkline
  ctx.strokeStyle = '#34d399';
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let x = 0; x < 210; x += 6) {
    const y = 120 + Math.sin(t * 2 + x * 0.06) * 26;
    if (x === 0) ctx.moveTo(280 + x, y);
    else ctx.lineTo(280 + x, y);
  }
  ctx.stroke();

  ctx.fillStyle = '#94a3b8';
  ctx.font = '16px monospace';
  ctx.fillText('agents: 10 · swarm healthy', 280, 220);

  tvTexture.needsUpdate = true;
}

function createPottedPlant(root: THREE.Group, x: number, z: number, isDark: boolean): void {
  const variant: 'plant-calathea' | 'plant-fern' = (Math.abs(Math.round(x + z)) % 2 === 0)
    ? 'plant-calathea'
    : 'plant-fern';
  const height = 1.35 + ((Math.abs(Math.round(x * 3 + z * 7)) % 4) * 0.12);
  const planted = addProp(root, realisticAssets, variant, {
    x,
    z,
    rot: ((x * 13 + z * 7) % 360) * (Math.PI / 180),
    size: height,
    axis: 'height',
    inspect: {
      label: 'Potted Plant',
      kind: 'Decor',
      detail: 'CC0 Poly Haven houseplant.',
    },
  });
  if (planted) {
    tagInspect(planted, 'Potted Plant', 'Decor', 'CC0 Poly Haven houseplant.');
    return;
  }

  const group = new THREE.Group();
  group.position.set(x, 0, z);

  const potMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x27272a : 0xf1f5f9, roughness: 0.5 });
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.3, 0.7, 8), potMat);
  pot.position.y = 0.35;
  pot.castShadow = true;
  group.add(pot);

  const soil = new THREE.Mesh(
    new THREE.CylinderGeometry(0.38, 0.38, 0.05, 8),
    new THREE.MeshStandardMaterial({ color: 0x3f2e22 }),
  );
  soil.position.y = 0.68;
  group.add(soil);

  const leafMat = new THREE.MeshStandardMaterial({ color: 0x15803d, roughness: 0.6 });
  const leafGeo = new THREE.DodecahedronGeometry(0.4, 0);
  const leaves: [number, number, number, number][] = [
    [0, 1.0, 0, 1.2],
    [-0.2, 0.8, 0.2, 0.8],
    [0.2, 0.9, -0.2, 0.9],
    [-0.1, 1.2, -0.1, 0.7],
  ];
  leaves.forEach(([lx, ly, lz, s]) => {
    const leaf = new THREE.Mesh(leafGeo, leafMat);
    leaf.position.set(lx, ly, lz);
    leaf.scale.set(s, s * 1.3, s);
    leaf.castShadow = true;
    group.add(leaf);
  });

  root.add(group);
}

function buildPendantLamps(root: THREE.Group): void {
  const cordMat = new THREE.MeshStandardMaterial({ color: 0x334155 });
  const shadeMat = new THREE.MeshStandardMaterial({
    color: 0xf8fafc,
    emissive: 0xfef9c3,
    emissiveIntensity: 0.8,
  });
  const lampSpots: [number, number][] = [
    [-11, -3.5],
    [1, -3.5],
    [17.5, 9.5],
  ];
  lampSpots.forEach(([x, z]) => {
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 2.6), cordMat);
    cord.position.set(x, 5.0, z);
    root.add(cord);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.4, 16, 1, true), shadeMat);
    shade.position.set(x, 3.7, z);
    root.add(shade);
  });
}

/* --------------------------------------------------------------------------
   Extra zones: meeting nook, ping-pong, water cooler, coffee menu, armchair
   -------------------------------------------------------------------------- */
function buildMeetingNook(root: THREE.Group, isDark: boolean): void {
  const cx = -7;
  const cz = 6.4;
  const rug = new THREE.Mesh(
    new THREE.PlaneGeometry(6.4, 5.2),
    new THREE.MeshStandardMaterial({ color: isDark ? 0x27272a : 0xdbeafe, roughness: 0.95 }),
  );
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(cx, 0.014, cz);
  rug.receiveShadow = true;
  root.add(rug);

  const wood = new THREE.MeshStandardMaterial({ color: isDark ? 0x3f3f46 : 0xcdb79e, roughness: 0.55 });
  const table = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.15, 0.09, 28), wood);
  table.position.set(cx, 0.76, cz);
  table.castShadow = true;
  root.add(table);
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.16, 0.76, 16), new THREE.MeshStandardMaterial({ color: 0x334155 }));
  leg.position.set(cx, 0.38, cz);
  root.add(leg);

  const chairMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x52525b : 0x94a3b8, roughness: 0.8 });
  const chairAngles = [0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2];
  chairAngles.forEach((angle) => {
    const x = cx + Math.sin(angle) * 1.75;
    const z = cz + Math.cos(angle) * 1.75;
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = angle + Math.PI;
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.08, 0.62), chairMat);
    seat.position.y = 0.5;
    seat.castShadow = true;
    group.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.58, 0.08), chairMat);
    back.position.set(0, 0.82, -0.3);
    group.add(back);
    [-0.24, 0.24].forEach((lx) => {
      [-0.24, 0.24].forEach((lz) => {
        const l = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.5, 0.05), chairMat);
        l.position.set(lx, 0.25, lz);
        group.add(l);
      });
    });
    root.add(group);
  });

  // Laptop + mug on the table
  const laptop = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.03, 0.36),
    new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.4 }),
  );
  laptop.position.set(cx - 0.2, 0.82, cz);
  laptop.rotation.y = 0.4;
  root.add(laptop);
  const mug = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.06, 0.11),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2 }),
  );
  mug.position.set(cx + 0.35, 0.86, cz + 0.1);
  root.add(mug);
}

function buildPingPongTable(root: THREE.Group, isDark: boolean): void {
  const group = new THREE.Group();
  group.position.set(10.5, 0, 2.4);

  const topMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x14532d : 0x15803d, roughness: 0.6 });
  const top = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.08, 2.5), topMat);
  top.position.y = 0.8;
  top.castShadow = true;
  group.add(top);

  const legMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.4 });
  [-2.2, 2.2].forEach((lx) => {
    [-1.05, 1.05].forEach((lz) => {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.8, 0.08), legMat);
      leg.position.set(lx, 0.4, lz);
      group.add(leg);
    });
  });

  const net = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 0.22, 2.5),
    new THREE.MeshStandardMaterial({ color: 0xe2e8f0 }),
  );
  net.position.set(0, 0.95, 0);
  group.add(net);

  const paddleMat = new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.5 });
  [-1.2, 1.2].forEach((px) => {
    const paddle = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.03, 16), paddleMat);
    paddle.position.set(px, 0.87, 0.4);
    paddle.rotation.z = 0.3;
    group.add(paddle);
  });

  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 }),
  );
  ball.position.set(1.6, 0.95, -0.6);
  group.add(ball);

  root.add(group);
}

function buildWaterCooler(root: THREE.Group, isDark: boolean): void {
  const group = new THREE.Group();
  group.position.set(11.4, 0, 5.1);
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.55, 1.15, 0.55),
    new THREE.MeshStandardMaterial({ color: isDark ? 0x3f3f46 : 0xf1f5f9, roughness: 0.4 }),
  );
  body.position.y = 0.58;
  group.add(body);
  const bottle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.22, 0.6, 16),
    new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.75,
      roughness: 0.15,
    }),
  );
  bottle.position.y = 1.5;
  group.add(bottle);
  const tap = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.1, 0.12),
    new THREE.MeshStandardMaterial({ color: 0x0284c7 }),
  );
  tap.position.set(0, 0.9, 0.32);
  group.add(tap);
  root.add(group);
}

function buildCoffeeMenu(root: THREE.Group): void {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 160;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, 512, 160);
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 34px monospace';
    ctx.fillText('ESPRESSO BAR', 26, 52);
    ctx.fillStyle = '#fbbf24';
    ctx.font = '24px monospace';
    ctx.fillText('espresso 4 · matcha 5 · oat latte 6', 26, 102);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '18px monospace';
    ctx.fillText('swarm fuel, always on', 26, 134);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 1.06),
    new THREE.MeshStandardMaterial({ map: texture, roughness: 0.7 }),
  );
  board.position.set(-16, 3.15, 10.2);
  root.add(board);

  const cableMat = new THREE.MeshStandardMaterial({ color: 0x334155 });
  [-17.2, -14.8].forEach((x) => {
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 2.35), cableMat);
    cable.position.set(x, 4.8, 10.2);
    root.add(cable);
  });
}

function buildArmchair(root: THREE.Group, isDark: boolean): void {
  const chair = addProp(root, realisticAssets, 'armchair', {
    x: -21,
    z: 12.2,
    rot: Math.PI / 2,
    size: 1.15,
    axis: 'width',
    inspect: {
      label: 'Pantry Armchair',
      kind: 'Furniture',
      detail: 'CC0 Poly Haven armchair beside the espresso bar.',
      preset: 'coffee',
    },
  });
  if (chair) {
    tagInspect(chair, 'Pantry Armchair', 'Furniture', 'CC0 Poly Haven armchair beside the espresso bar.', 'coffee');
    return;
  }

  const mat = new THREE.MeshStandardMaterial({ color: isDark ? 0x7c2d12 : 0xc2410c, roughness: 0.85 });
  const group = new THREE.Group();
  group.position.set(-21, 0, 12.2);
  group.rotation.y = Math.PI / 2;
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.5, 0.95), mat);
  seat.position.y = 0.35;
  seat.castShadow = true;
  group.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.7, 0.24), mat);
  back.position.set(0, 0.85, -0.38);
  group.add(back);
  [-0.45, 0.45].forEach((ax) => {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.4, 0.85), mat);
    arm.position.set(ax, 0.6, 0);
    group.add(arm);
  });
  root.add(group);
}

function buildExtras(root: THREE.Group, isDark: boolean): void {
  buildMeetingNook(root, isDark);
  buildPingPongTable(root, isDark);
  buildWaterCooler(root, isDark);
  buildCoffeeMenu(root);
  buildArmchair(root, isDark);

  const cart = addProp(root, realisticAssets, 'coffee-cart', {
    x: -19.2,
    z: 6.4,
    rot: Math.PI / 2,
    size: 1.65,
    axis: 'height',
    inspect: {
      label: 'Coffee Cart',
      kind: 'Pantry',
      detail: 'CC0 Poly Haven coffee cart parked outside the espresso bar.',
      preset: 'coffee',
    },
  });
  if (cart) {
    tagInspect(cart, 'Coffee Cart', 'Pantry', 'CC0 Poly Haven coffee cart parked outside the espresso bar.', 'coffee');
  }
}

/* --------------------------------------------------------------------------
   Glass rooms: partitions, doors, labels and room floors
   -------------------------------------------------------------------------- */
function buildGlassWall(
  root: THREE.Group,
  isDark: boolean,
  axis: 'x' | 'z',
  fixed: number,
  from: number,
  to: number,
  gap?: [number, number],
): void {
  const P = activeTheme();
  const H = 2.6;
  const alongX = axis === 'x';
  const glassMat = new THREE.MeshStandardMaterial({
    color: isDark ? P.glassNight : P.glassDay,
    transparent: true,
    opacity: isDark ? 0.2 : 0.24,
    roughness: 0.08,
    metalness: 0.05,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const frameMat = new THREE.MeshStandardMaterial({
    color: isDark ? 0x52525b : 0x64748b,
    metalness: 0.6,
    roughness: 0.35,
  });

  const bar = (center: number, y: number, length: number, height: number): void => {
    const geo = new THREE.BoxGeometry(alongX ? length : 0.06, height, alongX ? 0.06 : length);
    const mesh = new THREE.Mesh(geo, frameMat);
    mesh.position.set(alongX ? center : fixed, y, alongX ? fixed : center);
    root.add(mesh);
  };

  const segments: [number, number][] = gap
    ? [
        [from, gap[0]],
        [gap[1], to],
      ]
    : [[from, to]];

  segments.forEach(([a, b]) => {
    const len = b - a;
    if (len < 0.12) return;
    const mid = (a + b) / 2;

    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(alongX ? len : 0.035, H - 0.18, alongX ? 0.035 : len),
      glassMat,
    );
    glass.position.set(alongX ? mid : fixed, H / 2, alongX ? fixed : mid);
    root.add(glass);

    bar(mid, 0.06, len, 0.06);
    bar(mid, H, len, 0.06);

    const posts = [a, b];
    for (let d = 2.4; d < len; d += 2.4) posts.push(a + d);
    posts.forEach((p) => bar(p, H / 2, 0.06, H));
  });

  if (gap) {
    bar((gap[0] + gap[1]) / 2, H, gap[1] - gap[0], 0.08);
  }
}

function buildRoomLabel(
  root: THREE.Group,
  x: number,
  y: number,
  z: number,
  text: string,
  width = 1.9,
): void {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, 256, 64);
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, 253, 61);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 26px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 34);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(width, width * 0.25),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true }),
  );
  label.position.set(x, y, z);
  root.add(label);
}

function buildRooms(root: THREE.Group, isDark: boolean): void {
  // Distinct floors
  const pantryFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(7.4, 5.2),
    new THREE.MeshStandardMaterial({ color: isDark ? 0x1f2937 : 0xe2e8f0, roughness: 0.85 }),
  );
  pantryFloor.rotation.x = -Math.PI / 2;
  pantryFloor.position.set(-16.2, 0.02, 10.75);
  pantryFloor.receiveShadow = true;
  root.add(pantryFloor);

  const serverFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(10.8, 9.2),
    new THREE.MeshStandardMaterial({ color: isDark ? 0x111827 : 0x475569, roughness: 0.9 }),
  );
  serverFloor.rotation.x = -Math.PI / 2;
  serverFloor.position.set(16.4, 0.02, -10.2);
  serverFloor.receiveShadow = true;
  root.add(serverFloor);

  // Lounge (door on the north wall)
  buildGlassWall(root, isDark, 'z', 13, 3.8, 15);
  buildGlassWall(root, isDark, 'x', 3.8, 13, 22, [14.2, 17.4]);

  // Pantry / espresso bar
  buildGlassWall(root, isDark, 'z', -20, 8, 13.5);
  buildGlassWall(root, isDark, 'x', 8, -20, -12.4, [-14.6, -12.4]);

  // Meeting room
  buildGlassWall(root, isDark, 'z', -10.8, 3.6, 9.2);
  buildGlassWall(root, isDark, 'x', 3.6, -10.8, -3.2, [-8.2, -5.6]);

  // Server room (west wall with a door at the south end)
  buildGlassWall(root, isDark, 'z', 10.6, -15, -5.2, [-6.9, -5.2]);

  buildRoomLabel(root, 15.8, 3.05, 3.88, 'LOUNGE');
  buildRoomLabel(root, -13.4, 3.05, 8.08, 'PANTRY');
  buildRoomLabel(root, -6.9, 3.05, 3.68, 'MEETING');
  buildRoomLabel(root, 16.4, 4.55, -14.66, 'SERVER ROOM', 2.4);
}

/* --------------------------------------------------------------------------
   Mansion sports wing: pool, padel, mini soccer, gym, atrium, squad loft
   -------------------------------------------------------------------------- */
function createTurfTexture(isDark: boolean): THREE.CanvasTexture {
  const P = activeTheme();
  const stripes = isDark ? P.turfNight : P.turfDay;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 === 0 ? stripes[0] : stripes[1];
      ctx.fillRect(0, (i * 256) / 8, 256, 256 / 8);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 3);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createPalm(root: THREE.Group, x: number, z: number): void {
  const P = activeTheme();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.14, 0.22, 3.4, 8),
    new THREE.MeshStandardMaterial({ color: P.trunkDay, roughness: 0.9 }),
  );
  trunk.position.set(x, 1.7, z);
  trunk.castShadow = true;
  root.add(trunk);
  const leafMat = new THREE.MeshStandardMaterial({ color: P.leafDay[0] ?? 0x15803d, roughness: 0.7, side: THREE.DoubleSide });
  for (let i = 0; i < 7; i++) {
    const angle = (i / 7) * Math.PI * 2;
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.32, 2.2, 4), leafMat);
    leaf.position.set(x + Math.cos(angle) * 1.0, 3.6, z + Math.sin(angle) * 1.0);
    leaf.rotation.z = Math.cos(angle) * 1.05;
    leaf.rotation.x = Math.sin(angle) * 1.05;
    root.add(leaf);
  }
}

function buildPool(root: THREE.Group, isDark: boolean): void {
  const deck = new THREE.Mesh(
    new THREE.PlaneGeometry(34, 32),
    new THREE.MeshStandardMaterial({ color: isDark ? 0x1e293b : 0xe2e8f0, roughness: 0.85 }),
  );
  deck.rotation.x = -Math.PI / 2;
  deck.position.set(80, 0.015, 17);
  deck.receiveShadow = true;
  root.add(deck);

  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(22, 16),
    new THREE.MeshStandardMaterial({
      color: activeTheme().waterDay,
      emissive: activeTheme().waterNight,
      emissiveIntensity: 0.25,
      transparent: true,
      opacity: 0.92,
      roughness: 0.08,
      metalness: 0.25,
    }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(80, 0.04, 16);
  tagInspect(water, 'Swimming Pool', 'Sports Facility', 'Kolam renang dengan 4 lajur dan deck lounger.', 'pool');
  root.add(water);

  const copingMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.4 });
  const coping = (w: number, d: number, x: number, z: number): void => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 0.12, d), copingMat);
    mesh.position.set(x, 0.07, z);
    root.add(mesh);
  };
  coping(23, 0.5, 80, 7.75);
  coping(23, 0.5, 80, 24.25);
  coping(0.5, 17, 68.75, 16);
  coping(0.5, 17, 91.25, 16);

  const laneMat = new THREE.MeshStandardMaterial({ color: 0xe0f2fe });
  [11, 16, 21].forEach((z) => {
    const lane = new THREE.Mesh(new THREE.BoxGeometry(21.5, 0.02, 0.08), laneMat);
    lane.position.set(80, 0.055, z);
    root.add(lane);
  });

  // Loungers
  const loungerMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.6 });
  const towelColors = [0x38bdf8, 0xfbbf24, 0xf472b6, 0x4ade80];
  [72, 78, 84, 90].forEach((x, i) => {
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.22, 0.75), loungerMat);
    base.position.set(x, 0.35, 29.5);
    base.castShadow = true;
    root.add(base);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.22, 0.75), loungerMat);
    back.position.set(x - 0.75, 0.65, 29.5);
    back.rotation.z = -0.5;
    root.add(back);
    const towel = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.04, 0.55),
      new THREE.MeshStandardMaterial({ color: towelColors[i] ?? 0x38bdf8, roughness: 0.9 }),
    );
    towel.position.set(x + 0.2, 0.48, 29.5);
    root.add(towel);
  });

  // Umbrellas
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x475569 });
  const canvasMat = new THREE.MeshStandardMaterial({ color: 0xfef3c7, side: THREE.DoubleSide, roughness: 0.8 });
  [70, 94].forEach((x) => {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.6), poleMat);
    pole.position.set(x, 1.3, 32);
    root.add(pole);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(1.6, 0.6, 12, 1, true), canvasMat);
    shade.position.set(x, 2.7, 32);
    root.add(shade);
  });

  createPalm(root, 66, 4);
  createPalm(root, 94, 4);
  createPalm(root, 66, 33);
  createPalm(root, 94, 33);
  buildRoomLabel(root, 80, 3.2, 34.2, 'POOL', 2.2);
}

function buildPadel(root: THREE.Group, isDark: boolean): void {
  const court = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 20),
    new THREE.MeshStandardMaterial({ color: isDark ? 0x1e3a8a : 0x2563eb, roughness: 0.7 }),
  );
  court.rotation.x = -Math.PI / 2;
  court.position.set(45, 0.02, -7);
  court.receiveShadow = true;
  tagInspect(court, 'Padel Court', 'Sports Facility', 'Lapangan padel kaca dengan net dan paddle.', 'padel');
  root.add(court);

  const lineMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.5 });
  const line = (w: number, d: number, x: number, z: number): void => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 0.03, d), lineMat);
    mesh.position.set(x, 0.05, z);
    root.add(mesh);
  };
  line(12, 0.1, 45, -17);
  line(12, 0.1, 45, 3);
  line(0.1, 20, 39, -7);
  line(0.1, 20, 51, -7);
  line(12, 0.1, 45, -7);

  const netMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, transparent: true, opacity: 0.75, side: THREE.DoubleSide });
  const net = new THREE.Mesh(new THREE.PlaneGeometry(12, 0.6), netMat);
  net.position.set(45, 0.75, -7);
  root.add(net);
  [39, 51].forEach((x) => {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.1), lineMat);
    post.position.set(x, 0.55, -7);
    root.add(post);
  });

  // Glass ends
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x93c5fd,
    transparent: true,
    opacity: 0.22,
    roughness: 0.08,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  [-17, 3].forEach((z) => {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(12, 2.2, 0.03), glassMat);
    panel.position.set(45, 1.1, z);
    root.add(panel);
  });

  // Spectator bench
  const benchMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x3f3f46 : 0x94a3b8 });
  const bench = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.45, 2.4), benchMat);
  bench.position.set(35.4, 0.3, -7);
  root.add(bench);
  buildRoomLabel(root, 45, 3.2, 5.2, 'PADEL', 2.2);
}

function buildSoccer(root: THREE.Group, isDark: boolean): void {
  const pitch = new THREE.Mesh(
    new THREE.PlaneGeometry(34, 22),
    new THREE.MeshStandardMaterial({ map: createTurfTexture(isDark), roughness: 0.9 }),
  );
  pitch.rotation.x = -Math.PI / 2;
  pitch.position.set(73, 0.02, -15);
  pitch.receiveShadow = true;
  tagInspect(pitch, 'Mini Soccer Pitch', 'Sports Facility', 'Lapangan sepak bola mini dengan gawang dan scoreboard.', 'soccer');
  root.add(pitch);

  const lineMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
  const line = (w: number, d: number, x: number, z: number): void => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), lineMat);
    mesh.position.set(x, 0.045, z);
    root.add(mesh);
  };
  line(34, 0.12, 73, -26);
  line(34, 0.12, 73, -4);
  line(0.12, 22, 56, -15);
  line(0.12, 22, 90, -15);
  line(0.12, 22, 73, -15);
  const circle = new THREE.Mesh(new THREE.RingGeometry(2.6, 2.72, 40), lineMat);
  circle.rotation.x = -Math.PI / 2;
  circle.position.set(73, 0.05, -15);
  root.add(circle);

  const goalMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.4 });
  const netMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, transparent: true, opacity: 0.35, side: THREE.DoubleSide });
  [56.4, 89.6].forEach((x) => {
    const w = 4.4;
    const post1 = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.8), goalMat);
    post1.position.set(x, 0.9, -15 - w / 2);
    root.add(post1);
    const post2 = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.8), goalMat);
    post2.position.set(x, 0.9, -15 + w / 2);
    root.add(post2);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, w), goalMat);
    bar.rotation.x = Math.PI / 2;
    bar.position.set(x, 1.8, -15);
    root.add(bar);
    const net = new THREE.Mesh(new THREE.PlaneGeometry(2.2, w), netMat);
    net.rotation.y = Math.PI / 2;
    net.position.set(x + (x < 73 ? -1.1 : 1.1), 0.9, -15);
    root.add(net);
  });

  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }),
  );
  ball.position.set(73, 0.2, -15);
  root.add(ball);
  createPalm(root, 54, -2);
  createPalm(root, 92, -28);
  buildRoomLabel(root, 73, 3.2, -1.4, 'MINI SOCCER', 3.0);

  // Scoreboard
  const boardCanvas = document.createElement('canvas');
  boardCanvas.width = 320;
  boardCanvas.height = 160;
  const bctx = boardCanvas.getContext('2d');
  if (bctx) {
    bctx.fillStyle = '#0b1220';
    bctx.fillRect(0, 0, 320, 160);
    bctx.strokeStyle = '#38bdf8';
    bctx.lineWidth = 4;
    bctx.strokeRect(4, 4, 312, 152);
    bctx.fillStyle = '#e2e8f0';
    bctx.font = 'bold 22px monospace';
    bctx.textAlign = 'center';
    bctx.fillText('OPENCODE CUP', 160, 40);
    bctx.fillStyle = '#fbbf24';
    bctx.font = 'bold 44px monospace';
    bctx.fillText('HOME 0 : 0 AWAY', 160, 100);
    bctx.fillStyle = '#94a3b8';
    bctx.font = '16px monospace';
    bctx.fillText('live · swarm league', 160, 136);
  }
  const boardTexture = new THREE.CanvasTexture(boardCanvas);
  boardTexture.colorSpace = THREE.SRGBColorSpace;
  const boardPost = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.08, 3.2),
    new THREE.MeshStandardMaterial({ color: 0x334155 }),
  );
  boardPost.position.set(86, 1.6, -1.8);
  root.add(boardPost);
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(3.6, 1.8),
    new THREE.MeshBasicMaterial({ map: boardTexture }),
  );
  board.position.set(86, 3.4, -1.7);
  root.add(board);
}

function buildGym(root: THREE.Group, isDark: boolean): void {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 16),
    new THREE.MeshStandardMaterial({ color: isDark ? 0x18181b : 0x334155, roughness: 0.95 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(48, 0.02, 38);
  floor.receiveShadow = true;
  tagInspect(floor, 'Gym & Climbing Wall', 'Sports Facility', 'Bench, rack, punching bag, dan dinding panjat.', 'gym');
  root.add(floor);

  const mirror = new THREE.Mesh(
    new THREE.PlaneGeometry(19.4, 3.2),
    new THREE.MeshStandardMaterial({ color: 0xcbd5e1, metalness: 0.8, roughness: 0.1 }),
  );
  mirror.position.set(48, 1.7, 46);
  root.add(mirror);

  const steel = new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.7, roughness: 0.3 });
  [42, 47].forEach((x) => {
    const base = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.25, 1.0), steel);
    base.position.set(x, 0.25, 34);
    root.add(base);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.9, 0.08), steel);
    rail.position.set(x - 1.0, 0.8, 34);
    root.add(rail);
    const rail2 = rail.clone();
    rail2.position.set(x + 1.0, 0.8, 34);
    root.add(rail2);
  });

  const bench = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.18, 0.8), new THREE.MeshStandardMaterial({ color: 0x7c3aed }));
  bench.position.set(43, 0.55, 42);
  root.add(bench);
  const rack = new THREE.Mesh(new THREE.BoxGeometry(2.8, 1.8, 0.6), steel);
  rack.position.set(53.4, 0.9, 42);
  root.add(rack);

  const bag = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.3, 1.4, 12),
    new THREE.MeshStandardMaterial({ color: 0x991b1b, roughness: 0.7 }),
  );
  bag.position.set(55, 1.6, 35);
  root.add(bag);
  const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.0), steel);
  chain.position.set(55, 2.8, 35);
  root.add(chain);

  buildRoomLabel(root, 48, 3.2, 46.8, 'GYM', 2.0);
}

function buildAtrium(root: THREE.Group, isDark: boolean): void {
  const path = new THREE.Mesh(
    new THREE.PlaneGeometry(16, 92),
    new THREE.MeshStandardMaterial({ color: isDark ? 0x1f2937 : 0xd6d3d1, roughness: 0.9 }),
  );
  path.rotation.x = -Math.PI / 2;
  path.position.set(30, 0.012, 0);
  path.receiveShadow = true;
  tagInspect(path, 'Central Atrium Path', 'Path', 'Jalur pejalan kaki dari entrance ke distrik utara.');
  root.add(path);

  // Fountain
  const basin = new THREE.Mesh(
    new THREE.CylinderGeometry(2.0, 2.2, 0.5, 24),
    new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.5 }),
  );
  basin.position.set(24, 0.25, -26);
  root.add(basin);
  const water = new THREE.Mesh(
    new THREE.CylinderGeometry(1.8, 1.8, 0.1, 24),
    new THREE.MeshStandardMaterial({ color: 0x38bdf8, emissive: 0x0284c7, emissiveIntensity: 0.25 }),
  );
  water.position.set(24, 0.52, -26);
  root.add(water);

  for (let i = 0; i < 6; i++) {
    createPottedPlant(root, 24 + (i % 2) * 12, -40 + i * 14, isDark);
  }
  [22, 38].forEach((x) => {
    const bench = new THREE.Mesh(
      new THREE.BoxGeometry(0.8, 0.4, 3.0),
      new THREE.MeshStandardMaterial({ color: isDark ? 0x3f3f46 : 0x94a3b8 }),
    );
    bench.position.set(x, 0.3, 8);
    root.add(bench);
  });
}

function buildCrowdLoft(root: THREE.Group, isDark: boolean): void {
  const loft = new THREE.Mesh(
    new THREE.PlaneGeometry(28, 32),
    new THREE.MeshStandardMaterial({ color: isDark ? 0x18181b : 0xe7e5e4, roughness: 0.9 }),
  );
  loft.rotation.x = -Math.PI / 2;
  loft.position.set(-22, 0.014, 33);
  loft.receiveShadow = true;
  root.add(loft);

  const tableMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x27272a : 0xede4d5, roughness: 0.6 });
  const monitorMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.3 });
  const screenMat = liveFeedTexture
    ? new THREE.MeshBasicMaterial({ map: liveFeedTexture })
    : new THREE.MeshStandardMaterial({ color: 0x38bdf8, emissive: 0x0284c7, emissiveIntensity: 0.5 });

  for (let row = 0; row < 6; row++) {
    const z = 20 + row * 5;
    const table = new THREE.Mesh(new THREE.BoxGeometry(26, 0.1, 1.4), tableMat);
    table.position.set(-22, 1.0, z);
    table.castShadow = true;
    root.add(table);
    [-12.5, 12.5].forEach((lx) => {
      [-0.6, 0.6].forEach((lz) => {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.0, 0.07), monitorMat);
        leg.position.set(-22 + lx, 0.5, z + lz);
        root.add(leg);
      });
    });
    [-11.9, -8.5, -5.1, -1.7, 1.7, 5.1, 8.5, 11.9].forEach((lx) => {
      const stand = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.35, 0.06), monitorMat);
      stand.position.set(-22 + lx, 1.22, z - 0.4);
      root.add(stand);
      const frame = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.68, 0.05), monitorMat);
      frame.position.set(-22 + lx, 1.6, z - 0.4);
      root.add(frame);
      const screen = new THREE.Mesh(new THREE.BoxGeometry(1.06, 0.58, 0.02), screenMat);
      screen.position.set(0, 0, 0.035);
      frame.add(screen);
    });
  }

  buildRoomLabel(root, -22, 3.2, 18.4, 'SQUAD LOFT', 2.6);
}

function buildBasketball(root: THREE.Group, isDark: boolean): void {
  const court = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 14),
    new THREE.MeshStandardMaterial({ color: isDark ? 0x7c2d12 : 0xb45309, roughness: 0.8 }),
  );
  court.rotation.x = -Math.PI / 2;
  court.position.set(72, 0.02, -40);
  court.receiveShadow = true;
  tagInspect(court, 'Basketball Half-Court', 'Sports Facility', 'Ring, backboard, dan bola basket.', 'basketball');
  root.add(court);

  const lineMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.5 });
  const line = (w: number, d: number, x: number, z: number): void => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), lineMat);
    mesh.position.set(x, 0.04, z);
    root.add(mesh);
  };
  line(20, 0.1, 72, -47);
  line(20, 0.1, 72, -33);
  line(0.1, 14, 62, -40);
  line(0.1, 14, 82, -40);

  const hoopX = 63.4;
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.12, 3.2),
    new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.6 }),
  );
  pole.position.set(hoopX - 0.6, 1.6, -40);
  root.add(pole);
  const backboard = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 1.1, 1.8),
    new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.4 }),
  );
  backboard.position.set(hoopX, 3.0, -40);
  root.add(backboard);
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.42, 0.05, 8, 20),
    new THREE.MeshStandardMaterial({ color: 0xef4444, metalness: 0.4 }),
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.set(hoopX + 0.5, 2.55, -40);
  root.add(rim);

  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.17, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0xf97316, roughness: 0.6 }),
  );
  ball.position.set(73, 0.2, -38);
  root.add(ball);
  buildRoomLabel(root, 72, 3.2, -30.5, 'BASKETBALL', 2.8);
}

function buildGarden(root: THREE.Group, isDark: boolean): void {
  const pathMat = new THREE.MeshStandardMaterial({
    color: isDark ? 0x3f3f46 : 0xc7b299,
    roughness: 0.95,
  });
  const lawnMat = new THREE.MeshStandardMaterial({
    color: isDark ? 0x14532d : 0x86c06c,
    roughness: 1,
  });
  const strip = (w: number, d: number, x: number, z: number, mat: THREE.Material): void => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.012, z);
    mesh.receiveShadow = true;
    root.add(mesh);
  };
  strip(40, 4, -10, -34, pathMat);
  strip(4, 36, -28, -28, pathMat);
  strip(34, 4, 60, -51, pathMat);

  // Campus lawns
  strip(40, 10, 0, -48, lawnMat);
  strip(10, 90, -38, 0, lawnMat);
  strip(90, 8, 40, 51, lawnMat);

  for (let i = 0; i < 8; i++) {
    createPottedPlant(root, -40 + i * 9, -44, isDark);
  }
  createPalm(root, 18, -46);
  createPalm(root, 44, -46);
  createPalm(root, 88, -46);
  createPalm(root, 10, 50);
  createPalm(root, -38, 44);
  createPalm(root, 94, 46);
  createPalm(root, -38, -20);
  createPalm(root, -38, 20);

  [22, 44, 68].forEach((x) => {
    const bench = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 0.4, 0.7),
      new THREE.MeshStandardMaterial({ color: isDark ? 0x3f3f46 : 0x94a3b8 }),
    );
    bench.position.set(x, 0.3, 48);
    root.add(bench);
  });
}

function createCampusTree(
  root: THREE.Group,
  x: number,
  z: number,
  scale = 1,
  tint = 0x15803d,
): void {
  const P = activeTheme();
  const leafColor = P.leafDay[Math.floor(Math.random() * P.leafDay.length)] ?? tint;
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16 * scale, 0.24 * scale, 2.8 * scale, 7),
    new THREE.MeshStandardMaterial({ color: P.trunkDay, roughness: 1 }),
  );
  trunk.position.set(x, 1.4 * scale, z);
  root.add(trunk);
  const leaves = new THREE.MeshStandardMaterial({ color: leafColor, roughness: 0.85 });
  const crownParts: [number, number, number, number][] = [
    [0, 3.2, 0, 1.35],
    [-0.55, 2.85, 0.3, 0.95],
    [0.6, 2.95, -0.25, 0.9],
    [0.1, 3.7, 0.1, 0.75],
  ];
  crownParts.forEach(([dx, y, dz, r]) => {
    const crown = new THREE.Mesh(new THREE.SphereGeometry(r * scale, 9, 7), leaves);
    crown.position.set(x + dx * scale, y * scale, z + dz * scale);
    root.add(crown);
  });
}

function buildCampusLandscaping(root: THREE.Group, isDark: boolean): void {
  const pathMat = new THREE.MeshStandardMaterial({
    color: isDark ? 0x3f3f46 : 0xd6c3a1,
    roughness: 0.95,
  });
  const benchMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x3f3f46 : 0x94a3b8 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x475569 });
  const glowMat = new THREE.MeshStandardMaterial({
    color: 0xfff7ed,
    emissive: 0xfde68a,
    emissiveIntensity: 1.1,
  });

  const strip = (w: number, d: number, x: number, z: number): void => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), pathMat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.014, z);
    mesh.receiveShadow = true;
    root.add(mesh);
  };

  // Perimeter promenades
  strip(3.2, 128, -50, 2);
  strip(116, 3.2, 8, 66);
  strip(5.2, 3.2, 65.5, 59.4);
  strip(140, 3.2, 30, -60);
  strip(3.2, 60, 110, 30);

  const bench = (x: number, z: number, rot: number): void => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rot;
    const seat = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.22, 0.7), benchMat);
    seat.position.y = 0.45;
    g.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.7, 0.16), benchMat);
    back.position.set(0, 0.85, -0.3);
    g.add(back);
    [-0.9, 0.9].forEach((dx) => {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.45, 0.5), lampMat);
      leg.position.set(dx, 0.22, 0);
      g.add(leg);
    });
    root.add(g);
  };

  const lamp = (x: number, z: number): void => {
    const placed = addProp(root, realisticAssets, 'street-lamp', {
      x,
      z,
      rot: Math.PI,
      size: 4.2,
      axis: 'height',
      inspect: {
        label: 'Campus Street Lamp',
        kind: 'Landscaping',
        detail: 'CC0 Poly Haven street lamp along the promenade.',
      },
    });
    if (placed) {
      tagInspect(placed, 'Campus Street Lamp', 'Landscaping', 'CC0 Poly Haven street lamp along the promenade.');
      return;
    }
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 4.0, 6), lampMat);
    pole.position.set(x, 2.0, z);
    root.add(pole);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), glowMat);
    bulb.position.set(x, 4.05, z);
    root.add(bulb);
  };

  [-46, -28, -10, 8, 26, 44, 62].forEach((z, i) => {
    if (i % 2 === 0) bench(-46.5, z, Math.PI / 2);
    lamp(-53.5, z + 7);
  });
  [-32, -10, 12, 34, 56].forEach((x, i) => {
    if (i % 2 === 0) bench(x, 69.5, Math.PI);
    lamp(x + 8, 70.5);
  });
  [-36, -18, 0, 18, 36, 54, 72, 90].forEach((x, i) => {
    createCampusTree(root, x, -64.5, 0.9 + (i % 3) * 0.08, i % 2 === 0 ? 0x15803d : 0x166534);
  });
  [-46, -28, -10, 8, 26, 44, 58].forEach((x, i) => {
    createCampusTree(root, x, 63.5, 0.85 + (i % 4) * 0.06, i % 2 === 0 ? 0x15803d : 0x166534);
  });
  [-48, -30, -12, 6, 24, 42, 60].forEach((z, i) => {
    createCampusTree(root, -54.5, z, 0.9 + (i % 3) * 0.06, i % 2 === 0 ? 0x166534 : 0x15803d);
  });
  [8, 26, 44, 56].forEach((z, i) => {
    createCampusTree(root, 114, z, 0.8 + (i % 2) * 0.1, 0x15803d);
  });

  // Flower islands around the lawns
  const flowerSpots: { x: number; z: number; color: number }[] = [
    { x: -44, z: 12, color: 0xf472b6 },
    { x: -44, z: -22, color: 0xfacc15 },
    { x: -20, z: 56, color: 0xa78bfa },
    { x: 6, z: 58, color: 0xfb7185 },
    { x: 40, z: 62, color: 0x38bdf8 },
    { x: 58, z: -58, color: 0xf472b6 },
    { x: 82, z: 6, color: 0xfacc15 },
    { x: 108, z: 12, color: 0xfb7185 },
  ];
  flowerSpots.forEach(({ x, z, color }) => {
    for (let i = 0; i < 5; i++) {
      const dx = Math.cos((i / 5) * Math.PI * 2) * 0.8;
      const dz = Math.sin((i / 5) * Math.PI * 2) * 0.8;
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.02, 0.025, 0.45, 5),
        new THREE.MeshStandardMaterial({ color: 0x22c55e }),
      );
      stem.position.set(x + dx, 0.22, z + dz);
      root.add(stem);
      const bloom = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 7, 6),
        new THREE.MeshStandardMaterial({ color, roughness: 0.7 }),
      );
      bloom.position.set(x + dx, 0.46, z + dz);
      root.add(bloom);
    }
  });
}

function buildSportsWing(root: THREE.Group, isDark: boolean): void {
  const L = activeTheme().layout;
  // Courts and the pool wing are separate site-plan blocks: every world puts
  // them somewhere else, so agents and collision follow the same offsets.
  const courts = new THREE.Group();
  courts.position.set(L.sports[0], 0, L.sports[1]);
  root.add(courts);
  buildPadel(courts, isDark);
  buildSoccer(courts, isDark);
  buildBasketball(courts, isDark);

  const poolWing = new THREE.Group();
  poolWing.position.set(L.pool[0], 0, L.pool[1]);
  root.add(poolWing);
  buildPool(poolWing, isDark);
  buildGym(poolWing, isDark);

  buildAtrium(root, isDark);
  buildCrowdLoft(root, isDark);
  buildGarden(root, isDark);
}

/* --------------------------------------------------------------------------
   Extra attractions: cinema, arcade, library, pool bar, yoga, helipad,
   parking, koi pond, entrance arch, flags, lamps, sculpture
   -------------------------------------------------------------------------- */
function buildAttractions(root: THREE.Group, isDark: boolean): void {
  const P = activeTheme();
  const darkMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x111827 : 0x1f2937, roughness: 0.95 });
  const woodMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x3f3f46 : 0xcdb79e, roughness: 0.6 });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.4 });
  const screenMat = new THREE.MeshBasicMaterial({ color: 0x0ea5e9 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.6, roughness: 0.3 });

  const box = (
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    mat: THREE.Material,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    root.add(mesh);
    return mesh;
  };

  // Cinema
  const cineFloor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), darkMat);
  cineFloor.rotation.x = -Math.PI / 2;
  cineFloor.position.set(-32, 0.02, -34);
  root.add(cineFloor);
  box(8.4, 3.6, 0.2, -32, 2.2, -39.7, new THREE.MeshStandardMaterial({ color: 0x09090b }));
  const cineScreen = new THREE.Mesh(new THREE.PlaneGeometry(7.8, 3.1), screenMat);
  cineScreen.position.set(-32, 2.2, -39.55);
  tagInspect(cineScreen, 'Cinema Screen', 'Attraction', 'Layar bioskop mini dengan kursi teater.', 'cinema');
  root.add(cineScreen);
  [-35, -32, -29].forEach((x) => {
    [-35.4, -32.4].forEach((z) => {
      const seat = box(1.5, 0.5, 1.0, x, 0.3, z, new THREE.MeshStandardMaterial({ color: 0x7f1d1d }));
      seat.castShadow = true;
      box(1.5, 0.8, 0.2, x, 0.75, z + 0.45, new THREE.MeshStandardMaterial({ color: 0x991b1b }));
    });
  });
  buildRoomLabel(root, -32, 3.3, -27.5, 'CINEMA', 2.0);

  // Arcade
  const arcadeMat = new THREE.MeshStandardMaterial({ color: 0x312e81, roughness: 0.5 });
  [-35, -31.4, -27.8, -24.2].forEach((x) => {
    box(1.6, 2.0, 0.9, x, 1.0, -21, arcadeMat);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.7), new THREE.MeshBasicMaterial({ color: 0x22d3ee }));
    screen.position.set(x, 1.5, -20.52);
    root.add(screen);
    box(1.4, 0.15, 0.5, x, 1.0, -20.35, steelMat);
  });
  buildRoomLabel(root, -30, 3.3, -15.5, 'ARCADE', 2.0);

  // Library
  const shelfMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x3f3f46 : 0x8b5e34, roughness: 0.7 });
  [-5, 5].forEach((z) => {
    box(11, 2.6, 0.6, -30, 1.3, z, shelfMat);
    for (let i = 0; i < 14; i++) {
      box(0.3, 0.5, 0.5, -35 + i * 0.75, 1.2, z, new THREE.MeshStandardMaterial({
        color: [0xef4444, 0x3b82f6, 0x22c55e, 0xf59e0b][i % 4] ?? 0x64748b,
      }));
    }
  });
  box(3.2, 0.12, 1.6, -30, 0.8, 0, woodMat);
  [-1.2, 1.2].forEach((lx) => box(0.1, 0.8, 1.2, -30 + lx, 0.4, 0, woodMat));
  buildRoomLabel(root, -30, 3.3, 6.8, 'LIBRARY', 2.0);

  // Pool bar
  box(6.4, 1.1, 1.5, 63, 0.55, 28, woodMat);
  box(6.8, 0.1, 1.8, 63, 1.15, 28, whiteMat);
  [-2, 0, 2].forEach((x) => {
    const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.08), steelMat);
    stool.position.set(63 + x, 0.72, 29.6);
    root.add(stool);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.72), steelMat);
    stem.position.set(63 + x, 0.36, 29.6);
    root.add(stem);
  });
  box(6.2, 0.5, 0.2, 63, 3.0, 27.4, new THREE.MeshStandardMaterial({ color: 0x0f172a }));
  const neon = new THREE.Mesh(
    new THREE.PlaneGeometry(4.6, 0.7),
    new THREE.MeshBasicMaterial({ color: P.accent }),
  );
  neon.position.set(63, 3.0, 27.5);
  root.add(neon);
  buildRoomLabel(root, 63, 3.7, 27.3, 'POOL BAR', 2.0);

  // Yoga deck
  const yogaFloor = new THREE.Mesh(new THREE.PlaneGeometry(12, 10), woodMat);
  yogaFloor.rotation.x = -Math.PI / 2;
  yogaFloor.position.set(71, 0.02, 39);
  root.add(yogaFloor);
  [[68, 36, 0x38bdf8], [71, 36, 0xf472b6], [74, 36, 0x4ade80], [71, 41, 0xfacc15]].forEach(
    ([x, z, color]) => {
      const mat = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 0.9), new THREE.MeshStandardMaterial({ color }));
      mat.rotation.x = -Math.PI / 2;
      mat.position.set(x ?? 71, 0.04, z ?? 39);
      root.add(mat);
    },
  );
  buildRoomLabel(root, 71, 3.3, 44.4, 'YOGA DECK', 2.4);

  // Helipad + helicopter
  const pad = new THREE.Mesh(
    new THREE.CylinderGeometry(9, 9, 0.1, 32),
    new THREE.MeshStandardMaterial({ color: isDark ? 0x1e293b : 0x64748b, roughness: 0.9 }),
  );
  pad.position.set(96, 0.06, 42);
  tagInspect(pad, 'Helipad', 'Attraction', 'Landing pad dengan helikopter dekoratif.');
  root.add(pad);
  const hMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.6 });
  box(5.5, 0.05, 1.1, 96, 0.14, 42, hMat);
  box(1.1, 0.05, 5.5, 96, 0.14, 42, hMat);
  box(1.1, 0.05, 2.2, 93.5, 0.14, 40.9, hMat);
  box(1.1, 0.05, 2.2, 98.5, 0.14, 43.1, hMat);
  // Helicopter
  const heliMat = new THREE.MeshStandardMaterial({ color: 0x0ea5e9, metalness: 0.5, roughness: 0.3 });
  box(4.4, 1.4, 1.8, 96, 1.5, 46, heliMat);
  box(3.2, 0.7, 0.6, 96.4, 1.5, 43.9, heliMat);
  const rotor = new THREE.Mesh(
    new THREE.BoxGeometry(9, 0.08, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x1e293b }),
  );
  rotor.position.set(96, 2.5, 46);
  root.add(rotor);
  const tailRotor = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 1.4, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x1e293b }),
  );
  tailRotor.position.set(98.2, 1.7, 42.7);
  root.add(tailRotor);
  buildRoomLabel(root, 96, 3.2, 32.2, 'HELIPAD', 2.2);

  // Parking + cars
  const parkPad = new THREE.Mesh(
    new THREE.PlaneGeometry(18, 8),
    new THREE.MeshStandardMaterial({ color: isDark ? 0x1f2937 : 0x64748b, roughness: 0.9 }),
  );
  parkPad.rotation.x = -Math.PI / 2;
  parkPad.position.set(4, 0.02, 50);
  tagInspect(parkPad, 'Parking Lot', 'Attraction', 'Area parkir dengan mobil dekoratif.');
  root.add(parkPad);
  [0, 7].forEach((x, i) => {
    const carMat = new THREE.MeshStandardMaterial({ color: i === 0 ? 0xef4444 : 0xfacc15, metalness: 0.4, roughness: 0.3 });
    box(3.4, 0.8, 1.6, x, 0.6, 50, carMat);
    box(1.8, 0.6, 1.4, x, 1.25, 50, new THREE.MeshStandardMaterial({ color: 0x0f172a, metalness: 0.3 }));
    [-1.1, 1.1].forEach((wx) => {
      [-0.7, 0.7].forEach((wz) => {
        const wheel = new THREE.Mesh(
          new THREE.CylinderGeometry(0.28, 0.28, 0.2, 12),
          new THREE.MeshStandardMaterial({ color: 0x111827 }),
        );
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(x + wx, 0.28, 50 + wz);
        root.add(wheel);
      });
    });
  });
  buildRoomLabel(root, 4, 3.0, 45.6, 'PARKING', 2.0);

  // Koi pond
  const pond = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 5),
    new THREE.MeshStandardMaterial({ color: P.waterDay, emissive: P.waterNight, emissiveIntensity: 0.2, roughness: 0.1 }),
  );
  pond.rotation.x = -Math.PI / 2;
  pond.position.set(26, 0.05, -36);
  tagInspect(pond, 'Koi Pond', 'Attraction', 'Kolam koi dengan capybara dan kura-kura di sekitarnya.');
  root.add(pond);
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(4.4, 0.25, 6, 24),
    new THREE.MeshStandardMaterial({ color: 0x78716c, roughness: 0.9 }),
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.set(26, 0.12, -36);
  root.add(rim);

  // Entrance arch
  [24, 36].forEach((x) => box(0.7, 5.2, 0.7, x, 2.6, 52, whiteMat));
  box(12.7, 0.8, 0.7, 30, 5.1, 52, whiteMat);
  buildRoomLabel(root, 30, 4.4, 51.6, 'OPENCODE ESTATE', 3.4);

  // Flags
  const flagColors = [0x38bdf8, 0xf472b6, 0xfacc15, 0x4ade80];
  [[24, -12], [24, 12], [36, -12], [36, 12]].forEach(([x, z], i) => {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 5.5), steelMat);
    pole.position.set(x ?? 24, 2.75, z ?? 0);
    root.add(pole);
    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 0.8),
      new THREE.MeshStandardMaterial({ color: flagColors[i] ?? 0x38bdf8, side: THREE.DoubleSide }),
    );
    flag.position.set((x ?? 24) + 0.8, 5.0, z ?? 0);
    root.add(flag);
  });

  // Sculpture
  box(2.4, 0.6, 2.4, 40, 0.3, 40, whiteMat);
  const art = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.9, 0.22, 64, 8),
    new THREE.MeshStandardMaterial({ color: 0x8b5cf6, metalness: 0.6, roughness: 0.2 }),
  );
  art.position.set(40, 2.1, 40);
  art.castShadow = true;
  root.add(art);

  // Street lamps along the atrium
  [[20, -34], [40, -34], [20, 34], [40, 34], [60, 34], [80, 34]].forEach(([x, z]) => {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 4.2), steelMat);
    pole.position.set(x ?? 0, 2.1, z ?? 0);
    root.add(pole);
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0xfff7ed, emissive: 0xfde68a, emissiveIntensity: 1 }),
    );
    bulb.position.set(x ?? 0, 4.2, z ?? 0);
    root.add(bulb);
  });

  // Tennis court (north-west)
  const tennis = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 10),
    new THREE.MeshStandardMaterial({ color: isDark ? 0x14532d : 0x2f9e44, roughness: 0.8 }),
  );
  tennis.rotation.x = -Math.PI / 2;
  tennis.position.set(-30, 0.02, -49.4);
  tagInspect(tennis, 'Tennis Court', 'Sports Facility', 'Lapangan tenis dengan net dan garis putih.', 'tennis');
  root.add(tennis);
  const tennisLine = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.5 });
  const tLine = (w: number, d: number, x: number, z: number): void => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), tennisLine);
    mesh.position.set(x, 0.04, z);
    root.add(mesh);
  };
  tLine(20, 0.1, -30, -54.4);
  tLine(20, 0.1, -30, -44.4);
  tLine(0.1, 10, -40, -49.4);
  tLine(0.1, 10, -20, -49.4);
  const tNet = new THREE.Mesh(new THREE.PlaneGeometry(10, 0.8), new THREE.MeshBasicMaterial({ color: 0xe2e8f0, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
  tNet.rotation.y = Math.PI / 2;
  tNet.position.set(-30, 0.55, -49.4);
  root.add(tNet);
  buildRoomLabel(root, -30, 3.2, -43.4, 'TENNIS', 2.2);

  // Bowling lane (west)
  const lane = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 5),
    new THREE.MeshStandardMaterial({ color: isDark ? 0x3f3f46 : 0x78350f, roughness: 0.4 }),
  );
  lane.rotation.x = -Math.PI / 2;
  lane.position.set(-30, 0.03, -11);
  tagInspect(lane, 'Bowling Lane', 'Attraction', 'Lajur bowling dengan pin dan bola.');
  root.add(lane);
  for (let i = 0; i < 6; i++) {
    const pin = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.12, 0.5, 8),
      new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.3 }),
    );
    pin.position.set(-32 + (i % 3) * 0.5, 0.3, -13 + Math.floor(i / 3) * 0.5);
    root.add(pin);
  }
  const bowlBall = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0x7c3aed, roughness: 0.4 }),
  );
  bowlBall.position.set(-28, 0.25, -9.5);
  root.add(bowlBall);
  buildRoomLabel(root, -30, 3.2, -5.8, 'BOWLING', 2.2);

  // Climbing wall (gym east wall)
  box(0.3, 4.2, 7, 58.2, 2.1, 38, new THREE.MeshStandardMaterial({ color: isDark ? 0x334155 : 0x64748b }));
  const holdColors = [0xf43f5e, 0xfacc15, 0x38bdf8, 0x4ade80];
  for (let i = 0; i < 14; i++) {
    box(0.25, 0.18, 0.4, 58.0, 0.7 + (i % 7) * 0.5, 35 + Math.floor(i / 7) * 4 + (i % 3) * 0.5, new THREE.MeshStandardMaterial({ color: holdColors[i % 4] ?? 0xf43f5e }));
  }
  buildRoomLabel(root, 58, 4.6, 34.2, 'CLIMBING', 2.0);

  // Observatory (north lawn)
  box(8, 0.8, 8, 0, 0.4, -48, new THREE.MeshStandardMaterial({ color: isDark ? 0x1e293b : 0x94a3b8 }));
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(4, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x64748b, metalness: 0.4, roughness: 0.4 }),
  );
  dome.position.set(0, 0.8, -48);
  root.add(dome);
  const scope = new THREE.Mesh(
    new THREE.CylinderGeometry(0.25, 0.35, 3.2, 12),
    new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.6 }),
  );
  scope.rotation.z = Math.PI / 2.4;
  scope.position.set(1.6, 3.4, -47.4);
  root.add(scope);
  buildRoomLabel(root, 0, 4.8, -43.2, 'OBSERVATORY', 2.8);

  // Mini golf on the south lawn
  const greenMat = new THREE.MeshStandardMaterial({ color: 0x16a34a, roughness: 0.9 });
  [[54, 50], [62, 52], [70, 50]].forEach(([x, z], i) => {
    const green = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 0.08, 18), greenMat);
    green.position.set(x ?? 54, 0.06, z ?? 50);
    root.add(green);
    const hole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.18, 0.06, 12),
      new THREE.MeshStandardMaterial({ color: 0x0f172a }),
    );
    hole.position.set(x ?? 54, 0.11, z ?? 50);
    root.add(hole);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.8), new THREE.MeshStandardMaterial({ color: 0xf8fafc }));
    pole.position.set((x ?? 54) + 1.1, 0.95, (z ?? 50) + 0.6);
    root.add(pole);
    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(0.7, 0.4),
      new THREE.MeshStandardMaterial({ color: [0xef4444, 0x38bdf8, 0xfacc15][i] ?? 0xef4444, side: THREE.DoubleSide }),
    );
    flag.position.set((x ?? 54) + 1.45, 1.55, (z ?? 50) + 0.6);
    root.add(flag);
  });
  buildRoomLabel(root, 62, 3.0, 55.0, 'MINI GOLF', 2.2);

  // Food truck
  const truck = box(4.4, 2.2, 2.2, 16, 1.1, 49, new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.4 }));
  truck.castShadow = true;
  box(1.8, 0.9, 2.0, 18.2, 1.5, 49, new THREE.MeshStandardMaterial({ color: 0x0f172a, metalness: 0.3 }));
  [-1.3, 1.3].forEach((wx) => {
    [-0.8, 0.8].forEach((wz) => {
      const wheel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.35, 0.35, 0.25, 12),
        new THREE.MeshStandardMaterial({ color: 0x111827 }),
      );
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(16 + wx, 0.35, 49 + wz);
      root.add(wheel);
    });
  });
  buildRoomLabel(root, 16, 2.8, 46.6, 'TACOS', 1.6);

  // Hot-air balloon
  balloonGroup = new THREE.Group();
  const envelope = new THREE.Mesh(
    new THREE.SphereGeometry(2.6, 20, 16),
    new THREE.MeshStandardMaterial({ color: 0xf472b6, roughness: 0.5, metalness: 0.1 }),
  );
  envelope.scale.y = 1.25;
  balloonGroup.add(envelope);
  const basket = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 0.8, 1.0),
    new THREE.MeshStandardMaterial({ color: 0x8b5e34, roughness: 0.9 }),
  );
  basket.position.y = -4.2;
  balloonGroup.add(basket);
  for (let i = 0; i < 4; i++) {
    const rope = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.02, 2.6),
      new THREE.MeshStandardMaterial({ color: 0x334155 }),
    );
    const angle = (i / 4) * Math.PI * 2;
    rope.position.set(Math.cos(angle) * 0.7, -2.6, Math.sin(angle) * 0.7);
    rope.rotation.z = Math.cos(angle) * 0.3;
    rope.rotation.x = Math.sin(angle) * 0.3;
    balloonGroup.add(rope);
  }
  balloonGroup.position.set(-8, 18, -20);
  root.add(balloonGroup);

  // Dance floor + DJ booth
  const dance = new THREE.Mesh(new THREE.PlaneGeometry(12, 6), darkMat);
  dance.rotation.x = -Math.PI / 2;
  dance.position.set(50, 0.03, 27);
  tagInspect(dance, 'Dance Floor', 'Attraction', 'Lantai dansa dengan DJ booth dan disco ball.');
  root.add(dance);
  const tileColors = [0xf472b6, 0x38bdf8, 0xfacc15, 0x4ade80];
  for (let gx = 0; gx < 6; gx++) {
    for (let gz = 0; gz < 3; gz++) {
      const tile = new THREE.Mesh(
        new THREE.PlaneGeometry(1.7, 1.7),
        new THREE.MeshStandardMaterial({
          color: tileColors[(gx + gz) % 4] ?? 0x38bdf8,
          emissive: tileColors[(gx + gz) % 4] ?? 0x38bdf8,
          emissiveIntensity: 0.35,
        }),
      );
      tile.rotation.x = -Math.PI / 2;
      tile.position.set(45.6 + gx * 1.8, 0.05, 25.6 + gz * 1.8);
      root.add(tile);
    }
  }
  box(5.4, 0.9, 1.1, 50, 0.55, 23.7, new THREE.MeshStandardMaterial({ color: 0x0f172a }));
  [47.4, 52.6].forEach((x) => box(0.8, 2.0, 0.8, x, 1.0, 23.6, new THREE.MeshStandardMaterial({ color: 0x111827 })));
  const disco = new THREE.Mesh(
    new THREE.SphereGeometry(0.7, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.9, roughness: 0.1 }),
  );
  disco.position.set(50, 4.4, 27);
  root.add(disco);
  buildRoomLabel(root, 50, 3.3, 30.4, 'DANCE FLOOR', 2.4);

  // Fire pit
  const pit = new THREE.Mesh(
    new THREE.CylinderGeometry(1.6, 1.8, 0.35, 16),
    new THREE.MeshStandardMaterial({ color: 0x57534e, roughness: 0.9 }),
  );
  pit.position.set(16, 0.2, 42);
  tagInspect(pit, 'Fire Pit', 'Attraction', 'Api unggun dengan kursi log di sekelilingnya.');
  root.add(pit);
  const fire = new THREE.Mesh(
    new THREE.CylinderGeometry(1.1, 1.2, 0.2, 16),
    new THREE.MeshStandardMaterial({ color: 0xf97316, emissive: 0xea580c, emissiveIntensity: 1 }),
  );
  fire.position.set(16, 0.42, 42);
  root.add(fire);
  [0, 1, 2].forEach((i) => {
    const log = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.22, 1.6, 8),
      new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 1 }),
    );
    log.rotation.z = Math.PI / 2;
    log.rotation.y = (i / 3) * Math.PI;
    log.position.set(16 + Math.cos((i / 3) * Math.PI * 2) * 2.6, 0.35, 42 + Math.sin((i / 3) * Math.PI * 2) * 2.6);
    root.add(log);
  });
  buildRoomLabel(root, 16, 2.6, 37.8, 'FIRE PIT', 1.8);

  // Pet corner
  buildRoomLabel(root, 11.5, 2.4, 42.4, 'PET CORNER', 2.0);

  // Ice cream cart
  box(2.4, 1.4, 1.2, 62, 0.8, 34, new THREE.MeshStandardMaterial({ color: 0xfef3c7, roughness: 0.5 }));
  box(2.4, 0.1, 1.2, 62, 1.55, 34, whiteMat);
  const cartUmbrella = new THREE.Mesh(
    new THREE.ConeGeometry(1.8, 0.5, 12, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xf472b6, side: THREE.DoubleSide }),
  );
  cartUmbrella.position.set(62, 2.8, 34);
  root.add(cartUmbrella);
  const cartPole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.2), steelMat);
  cartPole.position.set(62, 1.6, 34);
  root.add(cartPole);
  buildRoomLabel(root, 62, 2.4, 31.8, 'ICE CREAM', 1.8);

  // Aquarium ring (north atrium)
  const aquarium = new THREE.Mesh(
    new THREE.TorusGeometry(3.4, 0.9, 12, 28),
    new THREE.MeshStandardMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.55, roughness: 0.1, metalness: 0.2 }),
  );
  aquarium.position.set(30, 2.6, -46);
  aquarium.rotation.x = Math.PI / 2;
  root.add(aquarium);
  buildRoomLabel(root, 30, 6.6, -41.4, 'AQUARIUM', 2.2);
}

/* --------------------------------------------------------------------------
   Campus visitors, butterflies, and the shuttle
   -------------------------------------------------------------------------- */
interface VisitorState {
  group: THREE.Group;
  waypoints: { x: number; z: number }[];
  index: number;
  dir: 1 | -1;
  pingPong: boolean;
  pose: { x: number; z: number; rot: number };
  wait: number;
  speed: number;
  path: Pt[];
  vx: number;
  vz: number;
  groundSpeed: number;
}

const VISITOR_DEFS: {
  name: string;
  color: number;
  path: { x: number; z: number }[];
  speed: number;
  pingPong?: boolean;
}[] = [
  {
    name: 'Tourist',
    color: 0xf97316,
    path: [
      { x: 20, z: 46 },
      { x: 23, z: 46 },
      { x: 23, z: 36 },
      { x: 20, z: 36 },
    ],
    speed: 1.2,
  },
  {
    name: 'Photographer',
    color: 0x8b5cf6,
    path: [
      { x: 38, z: 58 },
      { x: 50, z: 58 },
      { x: 62, z: 58 },
      { x: 70, z: 59.6 },
      { x: 76, z: 60 },
      { x: 82, z: 60 },
    ],
    speed: 1.05,
    pingPong: true,
  },
  {
    name: 'Village Guest',
    color: 0x10b981,
    path: [
      { x: 74, z: 61.5 },
      { x: 80, z: 61.5 },
      { x: 86, z: 61.5 },
      { x: 92, z: 61.5 },
      { x: 97, z: 61.5 },
      { x: 100, z: 60.2 },
      { x: 94, z: 60.5 },
      { x: 88, z: 60.5 },
      { x: 80, z: 60.5 },
    ],
    speed: 0.95,
  },
  {
    name: 'Courier',
    color: 0x3b82f6,
    path: [
      { x: 24.3, z: 44 },
      { x: 24.3, z: 10 },
    ],
    speed: 1.5,
    pingPong: true,
  },
];
const visitorStates: VisitorState[] = [];

function buildVisitors(root: THREE.Group, isDark: boolean): void {
  visitorStates.length = 0;
  VISITOR_DEFS.forEach((def, i) => {
    const base = AGENTS[AGENT_IDS[(i + 5) % AGENT_IDS.length] ?? 'max'];
    const start = def.path[0] ?? { x: 0, z: 0 };
    const look: AgentDef = {
      ...base,
      id: base.id,
      name: def.name,
      color: def.color,
      pos3D: { x: start.x, y: 0, z: start.z },
      deskIndex: 70 + i,
      ambient: true,
      state: 'IDLE',
      bubbleText: '',
      currentTask: '',
    };
    const group = buildCharacter(look, isDark);
    group.position.set(start.x, 0, start.z);
    group.rotation.y = 0;
    tagInspect(group, def.name, 'Campus Visitor', 'Visitor dekoratif dengan rute jalan tetap.');
    delete group.userData.agentId;
    const ring = group.userData.ring as THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> | undefined;
    if (ring) ring.visible = false;
    group.traverse((obj) => {
      obj.castShadow = false;
      obj.receiveShadow = false;
    });
    root.add(group);
    visitorStates.push({
      group,
      waypoints: def.path,
      index: def.path.length > 1 ? 1 : 0,
      dir: 1,
      pingPong: !!def.pingPong,
      pose: { x: start.x, z: start.z, rot: 0 },
      wait: 0.4 + Math.random() * 1.5,
      speed: def.speed,
      path: [],
      vx: 0,
      vz: 0,
      groundSpeed: 0,
    });
  });
}

function advanceVisitorWaypoint(visitor: VisitorState): void {
  if (visitor.pingPong) {
    if (visitor.index >= visitor.waypoints.length - 1) visitor.dir = -1;
    else if (visitor.index <= 0) visitor.dir = 1;
    visitor.index = Math.max(
      0,
      Math.min(visitor.waypoints.length - 1, visitor.index + visitor.dir),
    );
  } else {
    visitor.index = (visitor.index + 1) % visitor.waypoints.length;
  }
  visitor.wait = 1.4 + Math.random() * 3.6;
  visitor.path = [];
  visitor.vx = 0;
  visitor.vz = 0;
}

function animateVisitors(dt: number, time: number): void {
  visitorStates.forEach((visitor, index) => {
    const g = visitor.group;
    let walking = false;
    visitor.groundSpeed = 0;

    if (visitor.wait > 0) {
      visitor.wait -= dt;
    } else if (visitor.waypoints.length > 1) {
      const target = visitor.waypoints[visitor.index];
      if (target) {
        if (visitor.path.length === 0) {
          const planned = collisionWorld.findPath(
            { x: visitor.pose.x, z: visitor.pose.z },
            target,
            VISITOR_RADIUS,
          );
          visitor.path = planned.length > 0 ? planned : [{ x: target.x, z: target.z }];
        }
        const wp = visitor.path[0] ?? target;
        const isLast = visitor.path.length === 1;
        const body = {
          x: visitor.pose.x,
          z: visitor.pose.z,
          rot: visitor.pose.rot,
          vx: visitor.vx,
          vz: visitor.vz,
        };
        const result = stepBody(collisionWorld, body, wp, dt, {
          speed: visitor.speed,
          radius: VISITOR_RADIUS,
          arriveRadius: isLast ? 0.28 : 0.42,
          accel: 2.6,
          decel: 4.4,
        });
        visitor.pose.x = body.x;
        visitor.pose.z = body.z;
        visitor.pose.rot = body.rot;
        visitor.vx = body.vx;
        visitor.vz = body.vz;
        visitor.groundSpeed = Math.hypot(body.vx, body.vz);
        walking = result.moving;

        if (result.arrived) {
          visitor.path.shift();
          if (visitor.path.length === 0) advanceVisitorWaypoint(visitor);
        }
      }
    }

    const rig = g.userData['rig'] as CharacterRig | undefined;
    g.position.x = visitor.pose.x;
    g.position.z = visitor.pose.z;
    g.rotation.y = visitor.pose.rot;
    g.position.y = rig ? 0 : walking ? Math.abs(Math.sin(time * 7 + index)) * 0.04 : 0;

    if (rig) {
      updateCharacterRig(rig, dt, walking ? 'walk' : 'idle', time, visitor.groundSpeed);
      return;
    }

    const head = g.userData['headMesh'] as THREE.Mesh | undefined;
    if (head) head.position.y = 1.92 + Math.sin(time * 2.1 + index) * 0.02;
    const leftArm = g.userData['leftArm'] as THREE.Mesh | undefined;
    const rightArm = g.userData['rightArm'] as THREE.Mesh | undefined;
    const legL = g.userData['legLeft'] as THREE.Mesh | undefined;
    const legR = g.userData['legRight'] as THREE.Mesh | undefined;
    if (walking) {
      if (leftArm) leftArm.rotation.x = Math.sin(time * 7 + index) * 0.5;
      if (rightArm) rightArm.rotation.x = -Math.sin(time * 7 + index) * 0.5;
      if (legL) legL.rotation.x = -Math.sin(time * 7 + index) * 0.45;
      if (legR) legR.rotation.x = Math.sin(time * 7 + index) * 0.45;
    } else {
      if (leftArm) leftArm.rotation.x = Math.sin(time * 1.4 + index) * 0.06;
      if (rightArm) rightArm.rotation.x = -Math.sin(time * 1.4 + index) * 0.06;
      if (legL) legL.rotation.x = 0;
      if (legR) legR.rotation.x = 0;
    }
  });
}

interface Butterfly {
  group: THREE.Group;
  wingL: THREE.Group;
  wingR: THREE.Group;
  cx: number;
  cz: number;
  radius: number;
  speed: number;
  offset: number;
  baseY: number;
}

const butterflies: Butterfly[] = [];

function buildButterflies(root: THREE.Group): void {
  butterflies.length = 0;
  const anchors = [
    { x: 74.2, z: 59.2 },
    { x: 87.8, z: 66.4 },
    { x: 97.6, z: 67.2 },
    { x: 80.4, z: 70.8 },
    { x: 63, z: 34 },
  ];
  const colors = [0xf472b6, 0xfacc15, 0x7dd3fc, 0xa78bfa, 0xfb7185];
  anchors.forEach((anchor, anchorIndex) => {
    for (let i = 0; i < 2; i++) {
      const group = new THREE.Group();
      const wingMat = new THREE.MeshBasicMaterial({
        color: colors[(anchorIndex + i) % colors.length] ?? 0xf472b6,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.92,
      });
      const makeWing = (side: number): THREE.Group => {
        const pivot = new THREE.Group();
        const wing = new THREE.Mesh(new THREE.CircleGeometry(0.16, 8), wingMat);
        wing.rotation.x = -Math.PI / 2;
        wing.scale.set(1.15, 1.6, 1);
        wing.position.x = side * 0.15;
        pivot.add(wing);
        group.add(pivot);
        return pivot;
      };
      const wingL = makeWing(-1);
      const wingR = makeWing(1);
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.022, 0.03, 0.22, 6),
        new THREE.MeshBasicMaterial({ color: 0x1f2937 }),
      );
      body.rotation.x = Math.PI / 2;
      group.add(body);
      tagInspect(group, 'Butterfly', 'Campus Wildlife', 'Kupu-kupu dekoratif di flower bed.');
      root.add(group);
      butterflies.push({
        group,
        wingL,
        wingR,
        cx: anchor.x,
        cz: anchor.z,
        radius: 1.4 + Math.random() * 1.3,
        speed: 0.55 + Math.random() * 0.5,
        offset: Math.random() * Math.PI * 2,
        baseY: 1.2 + Math.random() * 1.2,
      });
    }
  });
}

function animateButterflies(time: number): void {
  butterflies.forEach((butterfly, i) => {
    const t = time * butterfly.speed + butterfly.offset;
    butterfly.group.position.set(
      butterfly.cx + Math.cos(t) * butterfly.radius,
      butterfly.baseY + Math.sin(t * 1.9) * 0.35,
      butterfly.cz + Math.sin(t * 0.85) * butterfly.radius * 0.75,
    );
    butterfly.group.rotation.y = -t * 0.9;
    const flap = 0.55 + Math.sin(time * 16 + i) * 0.65;
    butterfly.wingL.rotation.z = flap;
    butterfly.wingR.rotation.z = -flap;
  });
}

let shuttleGroup: THREE.Group | null = null;
const shuttleWheels: THREE.Mesh[] = [];
const shuttleState = {
  x: 32.4,
  z: -42,
  dir: 1 as 1 | -1,
  wait: 0,
  stopDone: false,
  speed: 0,
  accel: 0,
};

function buildShuttle(root: THREE.Group): void {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: activeTheme().accent, metalness: 0.45, roughness: 0.3 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x0f172a,
    metalness: 0.7,
    roughness: 0.12,
  });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.4 });
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.9 });

  const addBox = (
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    mat: THREE.Material,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    g.add(mesh);
    return mesh;
  };

  addBox(2.2, 1.7, 5.6, 0, 1.22, 0, bodyMat);
  addBox(2.3, 0.18, 5.75, 0, 2.16, 0, trimMat);
  addBox(1.9, 0.7, 0.06, 0, 1.55, 2.83, glassMat);
  addBox(1.7, 0.6, 0.06, 0, 1.55, -2.83, glassMat);
  [-1.11, 1.11].forEach((x) => {
    [-1.65, 0, 1.65].forEach((z) => addBox(0.06, 0.7, 1.08, x, 1.6, z, glassMat));
  });
  shuttleWheels.length = 0;
  [-1.05, 1.05].forEach((x) => {
    [-1.75, 1.75].forEach((z) => {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.24, 14), wheelMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, 0.4, z);
      g.add(wheel);
      shuttleWheels.push(wheel);
    });
  });
  [-0.7, 0.7].forEach((x) => {
    const light = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xfef08a }),
    );
    light.position.set(x, 0.85, 2.86);
    g.add(light);
  });
  const signCanvas = makeCanvas(256, 64);
  const ctx = signCanvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#082f49';
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#7dd3fc';
    ctx.font = 'bold 30px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CAMPUS SHUTTLE', 128, 34);
  }
  const signTexture = new THREE.CanvasTexture(signCanvas);
  signTexture.colorSpace = THREE.SRGBColorSpace;
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(1.8, 0.45),
    new THREE.MeshBasicMaterial({ map: signTexture }),
  );
  sign.position.set(0, 2.0, 2.82);
  g.add(sign);

  g.position.set(shuttleState.x, 0, shuttleState.z);
  g.rotation.y = 0;
  tagInspect(g, 'Campus Shuttle', 'Vehicle', 'Shuttle kampus yang berhenti di halte dan berbalik di ujung jalan.');
  root.add(g);
  shuttleGroup = g;
}

/** True when a character is standing in the shuttle's lane right ahead. */
function personAheadOfShuttle(): boolean {
  const lane = shuttleState.x;
  const dir = shuttleState.dir;
  const inLane = (x: number, z: number, radius: number): boolean => {
    if (Math.abs(x - lane) > 1.4 + radius) return false;
    const ahead = (z - shuttleState.z) * dir;
    return ahead > -1.0 && ahead < 7.5;
  };
  for (const entry of pose.values()) {
    if (inLane(entry.x, entry.z, AGENT_RADIUS)) return true;
  }
  for (const member of crowdMembers) {
    if (inLane(member.pose.x, member.pose.z, CROWD_RADIUS)) return true;
  }
  for (const visitor of visitorStates) {
    if (inLane(visitor.pose.x, visitor.pose.z, VISITOR_RADIUS)) return true;
  }
  return false;
}

const SHUTTLE_MAX = 6.5;
const SHUTTLE_ACCEL = 2.2;
const SHUTTLE_BRAKE = 4.6;

function animateShuttle(dt: number, time: number): void {
  if (!shuttleGroup) return;

  // Where the shuttle wants to be next: bus stop, then the turnaround ends.
  const distToStop = (40 - shuttleState.z) * shuttleState.dir;
  const distToEnd = ((shuttleState.dir > 0 ? 46 : -42) - shuttleState.z) * shuttleState.dir;
  let desired = SHUTTLE_MAX;
  if (shuttleState.wait > 0) {
    shuttleState.wait -= dt;
    desired = 0;
  } else {
    if (shuttleState.dir > 0 && !shuttleState.stopDone && distToStop < 0.25) {
      shuttleState.z = 40;
      shuttleState.speed = 0;
      shuttleState.wait = 3.2;
      shuttleState.stopDone = true;
      desired = 0;
    } else if (distToEnd < 0.25) {
      shuttleState.z = shuttleState.dir > 0 ? 46 : -42;
      shuttleState.speed = 0;
      shuttleState.dir = shuttleState.dir > 0 ? -1 : 1;
      shuttleState.x = shuttleState.dir > 0 ? 32.4 : 27.4;
      shuttleState.wait = 1.2;
      if (shuttleState.dir < 0) shuttleState.stopDone = false;
      desired = 0;
    } else if (personAheadOfShuttle()) {
      // Yield to pedestrians crossing the boulevard.
      desired = 0;
    }
  }

  if (desired > 0) {
    // Ease the brake distance so it slows smoothly before every stop.
    let brakeDistance = Math.min(6, Math.max(0, distToEnd));
    if (shuttleState.dir > 0 && !shuttleState.stopDone) {
      brakeDistance = Math.min(brakeDistance, Math.max(0, distToStop));
    }
    desired = Math.min(desired, Math.sqrt(2 * SHUTTLE_BRAKE * brakeDistance));
  }

  const previous = shuttleState.speed;
  shuttleState.speed = moveTowards(
    shuttleState.speed,
    desired,
    (desired > shuttleState.speed ? SHUTTLE_ACCEL : SHUTTLE_BRAKE) * dt,
  );
  if (shuttleState.speed < 0.02 && desired === 0) shuttleState.speed = 0;
  shuttleState.accel = dt > 0 ? (shuttleState.speed - previous) / dt : 0;

  shuttleState.z += shuttleState.dir * shuttleState.speed * dt;

  // Publish the vehicle as a moving obstacle and spin its wheels.
  collisionWorld.setDynamic([
    { cx: shuttleState.x, cz: shuttleState.z, w: 2.5, d: 6.0 },
  ]);
  const roll = (shuttleState.speed * dt) / 0.4;
  shuttleWheels.forEach((wheel) => {
    wheel.rotation.x += roll;
  });

  shuttleGroup.position.set(shuttleState.x, 0, shuttleState.z);
  shuttleGroup.rotation.y = shuttleState.dir > 0 ? 0 : Math.PI;
  // Nose lifts under acceleration and dives under braking.
  shuttleGroup.rotation.x = THREE.MathUtils.clamp(-shuttleState.accel * 0.012, -0.035, 0.035);
  if (shuttleState.speed > 0.4) {
    shuttleGroup.position.y = Math.sin(time * 11) * 0.012;
  }
}

/* --------------------------------------------------------------------------
   Characters (standing low-poly)
   -------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------
   Campus staff (static life in the attractions)
   -------------------------------------------------------------------------- */
const STAFF_DEFS: {
  name: string;
  x: number;
  z: number;
  rot: number;
  color: number;
  zone: 'pool' | 'sports' | 'attractions';
}[] = [
  { name: 'Lifeguard', x: 94.5, z: 18, rot: -Math.PI / 2, color: 0xef4444, zone: 'pool' },
  { name: 'Bartender', x: 63, z: 26.2, rot: 0, color: 0xf472b6, zone: 'attractions' },
  { name: 'Soccer Coach', x: 73, z: -2.8, rot: Math.PI, color: 0x22c55e, zone: 'sports' },
  { name: 'Hoops Coach', x: 60.5, z: -40, rot: Math.PI / 2, color: 0xfacc15, zone: 'sports' },
  { name: 'Gym Trainer', x: 44, z: 36, rot: 0, color: 0x8b5cf6, zone: 'pool' },
  { name: 'Librarian', x: -31.5, z: 1.2, rot: 0, color: 0x3b82f6, zone: 'attractions' },
  { name: 'Cinema Host', x: -32, z: -28.6, rot: 0, color: 0xef4444, zone: 'attractions' },
  { name: 'Gardener', x: 26, z: -31.5, rot: 0, color: 0x4ade80, zone: 'attractions' },
  { name: 'Yoga Instructor', x: 71, z: 36.5, rot: 0, color: 0xf472b6, zone: 'attractions' },
  { name: 'DJ', x: 50, z: 25.2, rot: 0, color: 0x8b5cf6, zone: 'attractions' },
  { name: 'Ice Cream', x: 62, z: 35.6, rot: 0, color: 0xfbbf24, zone: 'attractions' },
];
const staffGroups: THREE.Group[] = [];

function buildStaff(root: THREE.Group, isDark: boolean): void {
  staffGroups.length = 0;
  const L = activeTheme().layout;
  STAFF_DEFS.forEach((def, i) => {
    const base = AGENTS[AGENT_IDS[(i + 3) % AGENT_IDS.length] ?? 'max'];
    const off = def.zone === 'pool' ? L.pool : def.zone === 'sports' ? L.sports : L.attractions;
    const sx = def.x + off[0];
    const sz = def.z + off[1];
    const look: AgentDef = {
      ...base,
      id: base.id,
      name: def.name,
      color: def.color,
      pos3D: { x: sx, y: 0, z: sz },
      deskIndex: i,
      ambient: true,
      state: 'IDLE',
      bubbleText: '',
      currentTask: '',
    };
    const group = buildCharacter(look, isDark);
    group.position.set(sx, 0, sz);
    group.rotation.y = def.rot;
    tagInspect(group, def.name, 'Campus Staff', 'Staff dekoratif kampus, bukan sesi OpenCode.');
    delete group.userData.agentId;
    const ring = group.userData.ring as THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> | undefined;
    if (ring) ring.visible = false;
    group.traverse((obj) => {
      obj.castShadow = false;
      obj.receiveShadow = false;
    });
    root.add(group);
    staffGroups.push(group);
  });
}

function animateStaff(dt: number, time: number): void {
  staffGroups.forEach((g, i) => {
    const rig = g.userData['rig'] as CharacterRig | undefined;
    if (rig) {
      updateCharacterRig(rig, dt, 'idle', time);
      return;
    }
    const head = g.userData['headMesh'] as THREE.Mesh | undefined;
    if (head) head.position.y = 1.92 + Math.sin(time * 1.8 + i) * 0.02;
    const leftArm = g.userData['leftArm'] as THREE.Mesh | undefined;
    const rightArm = g.userData['rightArm'] as THREE.Mesh | undefined;
    if (leftArm) leftArm.rotation.x = Math.sin(time * 1.4 + i) * 0.08;
    if (rightArm) rightArm.rotation.x = -Math.sin(time * 1.4 + i) * 0.08;
  });
}

/* --------------------------------------------------------------------------
   District buildings, command center, task board, roads
   -------------------------------------------------------------------------- */
function buildTowerBlock(
  root: THREE.Group,
  isDark: boolean,
  opts: { x: number; z: number; w: number; d: number; h: number; color: number; label: string },
): void {
  const bodyMat = new THREE.MeshStandardMaterial({ color: opts.color, roughness: 0.65 });
  const floorMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x18181b : 0xe2e8f0, roughness: 0.8 });
  const windowMat = new THREE.MeshStandardMaterial({
    color: 0xbfdbfe,
    emissive: 0x93c5fd,
    emissiveIntensity: 0.5,
    roughness: 0.2,
  });

  const plazaColor = new THREE.Color(opts.color).lerp(
    new THREE.Color(isDark ? 0x111827 : 0xffffff),
    isDark ? 0.7 : 0.66,
  );
  const plaza = new THREE.Mesh(
    new THREE.PlaneGeometry(opts.w + 8, opts.d + 8),
    new THREE.MeshStandardMaterial({ color: plazaColor, roughness: 0.9 }),
  );
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.set(opts.x, 0.018, opts.z);
  plaza.receiveShadow = true;
  root.add(plaza);

  const body = new THREE.Mesh(new THREE.BoxGeometry(opts.w, opts.h, opts.d), bodyMat);
  body.position.set(opts.x, opts.h / 2, opts.z);
  body.castShadow = true;
  body.receiveShadow = true;
  tagInspect(
    body,
    opts.label,
    'District Building',
    `Live campus district · ${opts.h} m tower`,
    opts.label === 'COMMAND CENTER' ? 'command' : undefined,
  );
  root.add(body);

  for (let floor = 0; floor < Math.max(2, Math.round(opts.h / 4)); floor++) {
    const y = 2.2 + floor * 3.8;
    if (y > opts.h - 1) break;
    const band = new THREE.Mesh(new THREE.BoxGeometry(opts.w + 0.4, 0.25, opts.d + 0.4), floorMat);
    band.position.set(opts.x, y + 1.1, opts.z);
    root.add(band);
    const cols = Math.max(2, Math.floor(opts.w / 3.2));
    for (let c = 0; c < cols; c++) {
      const wx = opts.x - opts.w / 2 + 2 + c * (opts.w - 4) / Math.max(1, cols - 1);
      const win = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.2, 0.1), windowMat);
      win.position.set(wx, y, opts.z + opts.d / 2 + 0.02);
      root.add(win);
      const winSide = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.2, 1.5), windowMat);
      winSide.position.set(opts.x + opts.w / 2 + 0.02, y, opts.z - opts.d / 2 + 2 + c * 2.4);
      root.add(winSide);
    }
  }

  const roof = new THREE.Mesh(new THREE.BoxGeometry(opts.w + 1, 0.5, opts.d + 1), floorMat);
  roof.position.set(opts.x, opts.h + 0.25, opts.z);
  root.add(roof);
  const antenna = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.12, 4, 6),
    new THREE.MeshStandardMaterial({ color: 0x475569 }),
  );
  antenna.position.set(opts.x + opts.w * 0.25, opts.h + 2.4, opts.z - opts.d * 0.2);
  root.add(antenna);
  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xef4444 }),
  );
  beacon.position.set(opts.x + opts.w * 0.25, opts.h + 4.4, opts.z - opts.d * 0.2);
  root.add(beacon);

  buildRoomLabel(root, opts.x, 3.4, opts.z + opts.d / 2 + 0.15, opts.label, 3.0);
}

function buildCommandCenter(root: THREE.Group, isDark: boolean): void {
  const c = activeTheme().layout.towers.command;
  buildTowerBlock(root, isDark, { ...c, color: activeTheme().towers[4], label: 'COMMAND CENTER' });
  if (!commandTexture) return;
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(13, 6.6, 0.4),
    new THREE.MeshStandardMaterial({ color: 0x09090b, roughness: 0.4 }),
  );
  frame.position.set(c.x, 7.2, c.z + 6.3);
  root.add(frame);
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(12.4, 6.0),
    new THREE.MeshBasicMaterial({ map: commandTexture }),
  );
  screen.position.set(c.x, 7.2, c.z + 6.55);
  tagInspect(
    screen,
    'Command Center Screen',
    'Live Screen',
    'Sesi, status, model, token, biaya, dan event nyata dari bridge OpenCode.',
    'command',
  );
  root.add(screen);
}

function buildTaskBoard(root: THREE.Group, isDark: boolean): void {
  if (!boardTexture) return;
  const plazaMat =
    pbrMaterial(realisticAssets, 'concrete', [3, 2], {
      color: isDark ? 0x8a8a8a : 0xffffff,
      roughness: 0.9,
      normalScale: 0.5,
    }) ??
    new THREE.MeshStandardMaterial({
      map: createPlazaTexture(),
      color: isDark ? 0x64748b : 0xffffff,
      roughness: 0.9,
    });
  const plaza = new THREE.Mesh(new THREE.PlaneGeometry(15, 10), plazaMat);
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.set(40, 0.025, 15.6);
  plaza.receiveShadow = true;
  root.add(plaza);
  const plazaEdgeMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x334155 : 0x78716c, roughness: 0.8 });
  [
    [15.4, 0.3, 40, 10.65],
    [15.4, 0.3, 40, 20.55],
  ].forEach(([w, d, x, z]) => {
    const edge = new THREE.Mesh(new THREE.BoxGeometry(w ?? 15, 0.06, d ?? 0.3), plazaEdgeMat);
    edge.position.set(x ?? 40, 0.04, z ?? 15.6);
    root.add(edge);
  });
  [33.5, 46.5].forEach((x) => {
    const pot = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 0.55, 0.7, 10),
      new THREE.MeshStandardMaterial({ color: 0xb45309, roughness: 0.8 }),
    );
    pot.position.set(x, 0.35, 19.5);
    root.add(pot);
    const bush = new THREE.Mesh(
      new THREE.SphereGeometry(0.65, 9, 7),
      new THREE.MeshStandardMaterial({ color: 0x22c55e, roughness: 0.85 }),
    );
    bush.position.set(x, 0.95, 19.5);
    root.add(bush);
    const lampPole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.06, 3.0, 6),
      new THREE.MeshStandardMaterial({ color: 0x475569 }),
    );
    lampPole.position.set(x, 1.5, 16.5);
    root.add(lampPole);
    const lampBulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.14, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0xfff7ed, emissive: 0xfde68a, emissiveIntensity: 1.1 }),
    );
    lampBulb.position.set(x, 3.05, 16.5);
    root.add(lampBulb);
  });
  const frameMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x18181b : 0x334155, roughness: 0.5 });
  const frame = new THREE.Mesh(new THREE.BoxGeometry(10.6, 5.6, 0.3), frameMat);
  frame.position.set(40, 3.6, 14);
  root.add(frame);
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(10.1, 5.1),
    new THREE.MeshBasicMaterial({ map: boardTexture }),
  );
  screen.position.set(40, 3.6, 14.17);
  tagInspect(
    screen,
    'Session Board',
    'Live Screen',
    'Kolom RUNNING / IDLE / FAILED berisi sesi OpenCode nyata dan metrik token.',
    'board',
  );
  root.add(screen);
  [-3.8, 3.8].forEach((dx) => {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.25, 2.1, 0.25), frameMat);
    leg.position.set(40 + dx, 1.05, 14);
    root.add(leg);
  });
  buildRoomLabel(root, 40, 6.8, 14.2, 'SESSION BOARD', 3.2);
}

function buildServerStatusScreen(root: THREE.Group): void {
  if (!serverTexture) return;
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(5.2, 2.6),
    new THREE.MeshBasicMaterial({ map: serverTexture }),
  );
  screen.position.set(16.4, 2.7, -14.55);
  tagInspect(
    screen,
    'Server Status Screen',
    'Live Screen',
    'Status bridge, jumlah sesi, token, biaya, dan event terakhir.',
    'server',
  );
  root.add(screen);
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(5.5, 2.9, 0.15),
    new THREE.MeshStandardMaterial({ color: 0x09090b }),
  );
  frame.position.set(16.4, 2.7, -14.64);
  root.add(frame);
}

function buildDistricts(root: THREE.Group, isDark: boolean): void {
  const P = activeTheme();
  const L = P.layout;
  buildCommandCenter(root, isDark);
  const T = L.towers;
  buildTowerBlock(root, isDark, { ...T.engineering, color: P.towers[0], label: 'ENGINEERING' });
  buildTowerBlock(root, isDark, { ...T.research, color: P.towers[1], label: 'RESEARCH' });
  buildTowerBlock(root, isDark, { ...T.qa, color: P.towers[2], label: 'QA LAB' });
  buildTowerBlock(root, isDark, { ...T.infrastructure, color: P.towers[3], label: 'INFRASTRUCTURE' });
  buildTaskBoard(root, isDark);
  buildServerStatusScreen(root);
}

function buildRoads(root: THREE.Group, isDark: boolean): void {
  if (!activeTheme().layout.roads) return;
  const asphalt =
    pbrMaterial(realisticAssets, 'asphalt', [2, 24], {
      color: isDark ? 0x707070 : 0xffffff,
      roughness: 0.95,
      normalScale: 0.7,
    }) ??
    new THREE.MeshStandardMaterial({ color: isDark ? 0x27272a : 0x52525b, roughness: 0.95 });
  const sidewalk =
    pbrMaterial(realisticAssets, 'concrete', [1, 40], {
      color: isDark ? 0x7f7f7f : 0xffffff,
      roughness: 0.9,
      normalScale: 0.5,
    }) ??
    new THREE.MeshStandardMaterial({ color: isDark ? 0x3f3f46 : 0xd6d3d1, roughness: 0.9 });
  const line = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.6 });

  const road = new THREE.Mesh(new THREE.PlaneGeometry(10, 130), asphalt);
  road.rotation.x = -Math.PI / 2;
  road.position.set(30, 0.02, 0);
  road.receiveShadow = true;
  tagInspect(road, 'Main Boulevard', 'Road', 'Jalan utama kampus dengan dua lajur dan halte shuttle.');
  root.add(road);

  [-5.5, 5.5].forEach((dx) => {
    const walk = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 130), sidewalk);
    walk.rotation.x = -Math.PI / 2;
    walk.position.set(30 + dx, 0.022, 0);
    root.add(walk);
  });

  for (let z = -56; z < 56; z += 6) {
    const dash = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.02, 2.4), line);
    dash.position.set(30, 0.035, z);
    root.add(dash);
  }

  [18, -16].forEach((z) => {
    for (let i = 0; i < 6; i++) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.02, 0.55), line);
      stripe.position.set(26 + i * 1.6, 0.036, z);
      root.add(stripe);
    }
  });

  // Bollards and planters
  for (let z = -44; z <= 46; z += 12) {
    [-6.8, 6.8].forEach((dx) => {
      const bollard = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.14, 0.9, 8),
        new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.5 }),
      );
      bollard.position.set(30 + dx, 0.45, z);
      root.add(bollard);
    });
  }

  // Plaza at the entrance
  const plaza = new THREE.Mesh(
    new THREE.PlaneGeometry(18, 10),
    new THREE.MeshStandardMaterial({ color: isDark ? 0x1e293b : 0xd6d3d1, roughness: 0.9 }),
  );
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.set(30, 0.024, 50);
  root.add(plaza);

  // Branch road to the animal village
  const branch = new THREE.Mesh(new THREE.PlaneGeometry(38, 7), asphalt);
  branch.rotation.x = -Math.PI / 2;
  branch.position.set(50, 0.023, 58);
  branch.receiveShadow = true;
  tagInspect(branch, 'Animal Village Road', 'Road', 'Cabang jalan dari boulevard utama menuju Animal Village.');
  root.add(branch);
  [55.2, 60.8].forEach((z) => {
    const walk = new THREE.Mesh(new THREE.PlaneGeometry(38, 1.1), sidewalk);
    walk.rotation.x = -Math.PI / 2;
    walk.position.set(50, 0.026, z);
    root.add(walk);
  });
  for (let x = 38; x < 66; x += 5) {
    const dash = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.02, 0.22), line);
    dash.position.set(x, 0.037, 58);
    root.add(dash);
  }

  // Shuttle stop
  const stopMat = new THREE.MeshStandardMaterial({ color: 0x0ea5e9, metalness: 0.4, roughness: 0.4 });
  const post1 = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.6), stopMat);
  post1.position.set(37.4, 1.3, 37);
  root.add(post1);
  const post2 = post1.clone();
  post2.position.set(37.4, 1.3, 43);
  root.add(post2);
  const stopRoof = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.2, 7.2), stopMat);
  stopRoof.position.set(37.4, 2.7, 40);
  root.add(stopRoof);
  buildRoomLabel(root, 38.2, 2.0, 40, 'SHUTTLE', 1.8);
}
function buildAnimalVillage(root: THREE.Group, isDark: boolean): void {
  const P = activeTheme();
  const lawn = new THREE.MeshStandardMaterial({ color: isDark ? 0x14532d : 0x86c06c, roughness: 1 });
  const pathMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x3f3f46 : 0xd6c3a1, roughness: 0.95 });
  const wood = new THREE.MeshStandardMaterial({ color: isDark ? 0x78350f : 0xa16207, roughness: 0.85 });
  const darkRoof = new THREE.MeshStandardMaterial({ color: isDark ? 0x1e293b : 0x334155, roughness: 0.7 });

  const box = (
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    mat: THREE.Material,
    parent: THREE.Object3D = root,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };

  const flat = (w: number, d: number, x: number, z: number, mat: THREE.Material, y = 0.014): void => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    root.add(mesh);
  };

  // Village grounds and paths
  flat(41, 23, 87, 62.5, lawn, 0.013);
  flat(29, 3.2, 81.5, 58, pathMat, 0.02);
  flat(3.0, 13, 86, 63.5, pathMat, 0.021);
  flat(5.5, 2.6, 96, 62, pathMat, 0.022);
  flat(3.6, 2.2, 73.5, 62, pathMat, 0.022);

  // Fence around the village, with a gap on the west side for the path
  const post = (x: number, z: number, h = 1.15): void => {
    box(0.16, h, 0.16, x, h / 2, z, wood);
  };
  for (let x = 69; x <= 105; x += 3) {
    post(x, 52.8);
    post(x, 72.6);
  }
  for (let z = 54; z <= 71; z += 3) {
    if (z < 56.4 || z > 62.6) post(68, z);
    post(106, z);
  }
  for (const y of [0.52, 0.9]) {
    box(37, 0.09, 0.09, 87, y, 52.8, wood);
    box(37, 0.09, 0.09, 87, y, 72.6, wood);
    box(0.09, 0.09, 3.6, 68, y, 54.6, wood);
    box(0.09, 0.09, 10.0, 68, y, 67.6, wood);
    box(0.09, 0.09, 17.8, 106, y, 62.7, wood);
  }

  // Entrance gate
  [56.4, 62.4].forEach((z) => box(0.3, 3.0, 0.3, 68, 1.5, z, wood));
  box(0.5, 0.4, 6.4, 68, 3.05, 59.4, wood);
  buildRoomLabel(root, 68.25, 3.75, 59.4, 'ANIMAL VILLAGE', 4.4);

  // Big sign on the north fence
  box(6.2, 1.3, 0.16, 87, 4.25, 52.65, new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.6 }));
  buildRoomLabel(root, 87, 4.25, 52.55, 'ANIMAL VILLAGE', 5.6);
  [84.2, 89.8].forEach((x) => box(0.12, 2.6, 0.12, x, 1.3, 52.7, wood));

  const cottage = (
    cx: number,
    cz: number,
    w: number,
    d: number,
    h: number,
    wallColor: number,
    roofColor: number,
    rot: number,
  ): void => {
    const g = new THREE.Group();
    g.position.set(cx, 0, cz);
    g.rotation.y = rot;
    tagInspect(g, 'Animal Village Cottage', 'Animal Village', 'Cottage hewan dengan pintu, jendela, dan cerobong.', 'village');
    root.add(g);
    const walls = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.8 }),
    );
    walls.position.y = h / 2;
    walls.castShadow = true;
    walls.receiveShadow = true;
    g.add(walls);
    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(Math.hypot(w, d) * 0.54, 1.5, 4),
      new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.65 }),
    );
    roof.position.y = h + 0.7;
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    g.add(roof);
    box(0.8, 1.5, 0.1, 0, 0.75, d / 2 + 0.04, new THREE.MeshStandardMaterial({ color: 0x422006 }), g);
    box(0.26, 0.9, 0.26, w * 0.26, h + 1.1, -d * 0.16, darkRoof, g);
    [-1, 1].forEach((side) => {
      const window = new THREE.Mesh(
        new THREE.BoxGeometry(0.72, 0.6, 0.08),
        new THREE.MeshStandardMaterial({
          color: 0xfef3c7,
          emissive: 0xfde68a,
          emissiveIntensity: 0.55,
          roughness: 0.2,
        }),
      );
      window.position.set(side * w * 0.28, h * 0.62, d / 2 + 0.05);
      g.add(window);
    });
  };

  cottage(94, 55.5, 6.2, 4.4, 2.9, 0xfef3c7, 0x0d9488, 0);
  cottage(101.5, 64.5, 5.0, 4.0, 2.6, 0xffedd5, 0xf472b6, -Math.PI / 2);
  cottage(89.5, 69.8, 5.2, 4.0, 2.7, 0xf5f5f4, 0xf59e0b, Math.PI);

  // Duck pond
  const pond = new THREE.Mesh(
    new THREE.PlaneGeometry(9.2, 5.0),
    new THREE.MeshStandardMaterial({
      color: P.waterDay,
      emissive: P.waterNight,
      emissiveIntensity: 0.22,
      roughness: 0.1,
    }),
  );
  pond.rotation.x = -Math.PI / 2;
  pond.position.set(77.5, 0.045, 68.3);
  tagInspect(pond, 'Village Duck Pond', 'Animal Village', 'Kolam bebek dengan lily pad dan reed.', 'village');
  root.add(pond);
  const pondRim = new THREE.Mesh(
    new THREE.TorusGeometry(4.6, 0.2, 6, 22),
    new THREE.MeshStandardMaterial({ color: 0x78716c, roughness: 0.9 }),
  );
  pondRim.rotation.x = -Math.PI / 2;
  pondRim.scale.z = 0.57;
  pondRim.position.set(77.5, 0.06, 68.3);
  root.add(pondRim);
  [74.8, 79.8, 76.6].forEach((x, i) => {
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32, 0.32, 0.03, 10),
      new THREE.MeshStandardMaterial({ color: 0x22c55e, roughness: 0.8 }),
    );
    pad.position.set(x, 0.075, 68.1 + (i === 2 ? 0.8 : 0));
    root.add(pad);
  });
  for (let i = 0; i < 7; i++) {
    const reed = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.035, 1.1, 5),
      new THREE.MeshStandardMaterial({ color: 0x15803d }),
    );
    reed.position.set(72.9 + (i % 2) * 0.3, 0.55, 65.9 + i * 0.45);
    root.add(reed);
  }

  // Playground
  flat(6.4, 4.4, 82, 56.4, new THREE.MeshStandardMaterial({ color: 0xfde68a, roughness: 1 }), 0.03);
  [-1, 1].forEach((side) => {
    box(0.18, 2.6, 0.18, 80.2, 1.3, 55.4 + side * 1.4, wood);
    box(0.18, 2.6, 0.18, 83.4, 1.3, 55.4 + side * 1.4, wood);
  });
  box(3.4, 0.18, 0.18, 81.8, 2.55, 55.4, wood);
  [-0.85, 0.85].forEach((dx) => {
    const chain = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.02, 1.6),
      new THREE.MeshStandardMaterial({ color: 0x64748b }),
    );
    chain.position.set(81.8 + dx, 1.7, 55.4);
    root.add(chain);
    box(0.5, 0.08, 0.3, 81.8 + dx, 0.9, 55.4, new THREE.MeshStandardMaterial({ color: 0xef4444 }));
  });
  const slideRamp = box(0.9, 0.12, 2.6, 84.4, 0.8, 57.0, new THREE.MeshStandardMaterial({ color: 0x38bdf8 }));
  slideRamp.rotation.x = 0.5;
  [84.4].forEach((x) => {
    box(0.12, 1.7, 0.12, x, 0.85, 55.9, new THREE.MeshStandardMaterial({ color: 0x64748b }));
    box(0.12, 1.7, 0.12, x, 0.85, 57.3, new THREE.MeshStandardMaterial({ color: 0x64748b }));
  });
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.26, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xf43f5e, roughness: 0.6 }),
  );
  ball.position.set(82, 0.3, 58.0);
  root.add(ball);

  // Vegetable garden
  flat(4.8, 3.6, 71.3, 66.2, new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 1 }), 0.032);
  [-1.3, 0, 1.3].forEach((dx) => {
    for (let i = 0; i < 4; i++) {
      const veg = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 8, 6),
        new THREE.MeshStandardMaterial({ color: i % 2 === 0 ? 0x22c55e : 0x84cc16, roughness: 0.8 }),
      );
      veg.position.set(71.3 + dx, 0.2, 64.9 + i * 0.8);
      root.add(veg);
    }
  });

  // Cat tree
  box(0.24, 2.4, 0.24, 104, 1.2, 58.5, new THREE.MeshStandardMaterial({ color: 0x8b5e34 }));
  [1.0, 1.9].forEach((y, i) => {
    const platform = new THREE.Mesh(
      new THREE.CylinderGeometry(0.65 - i * 0.12, 0.65 - i * 0.12, 0.12, 12),
      new THREE.MeshStandardMaterial({ color: 0xa16207, roughness: 0.9 }),
    );
    platform.position.set(104, y, 58.5);
    root.add(platform);
  });

  // Hay bales and trough
  [0, 1.2].forEach((dx, i) => {
    const hay = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.55, 1.15, 12),
      new THREE.MeshStandardMaterial({ color: 0xfbbf24, roughness: 1 }),
    );
    hay.rotation.z = Math.PI / 2;
    hay.position.set(69.8 + dx, 0.55 + i * 0.15, 57.3);
    root.add(hay);
  });
  box(2.2, 0.55, 0.8, 91.5, 0.28, 62.0, new THREE.MeshStandardMaterial({ color: 0x78716c, roughness: 0.9 }));
  box(2.0, 0.08, 0.6, 91.5, 0.54, 62.0, new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.2 }));

  // Trees
  const tree = (x: number, z: number, scale = 1): void => {
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16 * scale, 0.24 * scale, 2.6 * scale, 7),
      new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 1 }),
    );
    trunk.position.set(x, 1.3 * scale, z);
    root.add(trunk);
    const leaves = new THREE.MeshStandardMaterial({ color: 0x15803d, roughness: 0.85 });
    const crownParts: [number, number, number, number][] = [
      [0, 3.0, 0, 1.3],
      [-0.5, 2.7, 0.25, 0.9],
      [0.55, 2.8, -0.2, 0.85],
    ];
    crownParts.forEach(([dx, y, dz, r]) => {
      const crown = new THREE.Mesh(new THREE.SphereGeometry(r * scale, 9, 7), leaves);
      crown.position.set(x + dx * scale, y * scale, z + dz * scale);
      root.add(crown);
    });
  };
  tree(72, 54.5, 0.95);
  tree(104.6, 71.5, 1.05);
  tree(69.8, 71.0, 0.9);
  tree(103.6, 54.2, 0.85);

  // Flower beds
  const flowerBed = (cx: number, cz: number, color: number): void => {
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      const x = cx + Math.cos(angle) * 0.7;
      const z = cz + Math.sin(angle) * 0.5;
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.018, 0.022, 0.4, 5),
        new THREE.MeshStandardMaterial({ color: 0x22c55e }),
      );
      stem.position.set(x, 0.2, z);
      root.add(stem);
      const bloom = new THREE.Mesh(
        new THREE.SphereGeometry(0.085, 8, 6),
        new THREE.MeshStandardMaterial({ color, roughness: 0.7 }),
      );
      bloom.position.set(x, 0.42, z);
      root.add(bloom);
    }
  };
  flowerBed(74.2, 59.2, 0xf472b6);
  flowerBed(87.8, 66.4, 0xfacc15);
  flowerBed(97.6, 67.2, 0xa78bfa);
  flowerBed(80.4, 70.8, 0xfb7185);

  // String lights across the plaza
  [73.2, 99.2].forEach((x) => {
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.08, 4.2, 6),
      new THREE.MeshStandardMaterial({ color: 0x334155 }),
    );
    pole.position.set(x, 2.1, 63.4);
    root.add(pole);
  });
  const wire = new THREE.Mesh(
    new THREE.CylinderGeometry(0.015, 0.015, 26, 4),
    new THREE.MeshStandardMaterial({ color: 0x1e293b }),
  );
  wire.rotation.z = Math.PI / 2;
  wire.position.set(86.2, 4.05, 63.4);
  root.add(wire);
  const bulbColors = [0xfde68a, 0xf472b6, 0x7dd3fc, 0xa7f3d0];
  for (let i = 0; i < 13; i++) {
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 6, 6),
      new THREE.MeshBasicMaterial({ color: bulbColors[i % bulbColors.length] ?? 0xfde68a }),
    );
    bulb.position.set(73.6 + i * 2.1, 3.95, 63.4);
    root.add(bulb);
  }

  const catStatue = addProp(root, realisticAssets, 'cat-statue', {
    x: 72.6,
    z: 60.7,
    rot: Math.PI * 0.18,
    size: 1.5,
    axis: 'height',
    inspect: {
      label: 'Cat Statue',
      kind: 'Animal Village',
      detail: 'CC0 Poly Haven concrete cat statue guarding the village gate.',
      preset: 'village',
    },
  });
  if (catStatue) {
    tagInspect(catStatue, 'Cat Statue', 'Animal Village', 'CC0 Poly Haven concrete cat statue guarding the village gate.', 'village');
  }
}

type AnimalKind =
  | 'cat'
  | 'dog'
  | 'duck'
  | 'rabbit'
  | 'capybara'
  | 'panda'
  | 'turtle'
  | 'alpaca'
  | 'goat'
  | 'pig';
type AnimalZone = 'south' | 'west' | 'north' | 'pool' | 'pond' | 'village';

const ANIMAL_LABELS: Record<AnimalKind, string> = {
  cat: 'Cat',
  dog: 'Dog',
  duck: 'Duck',
  rabbit: 'Rabbit',
  capybara: 'Capybara',
  panda: 'Panda',
  turtle: 'Turtle',
  alpaca: 'Alpaca',
  goat: 'Goat',
  pig: 'Pig',
};

interface AnimalParts {
  head?: THREE.Object3D;
  legs: THREE.Object3D[];
  tail?: THREE.Object3D;
  ears: THREE.Object3D[];
  wings: THREE.Object3D[];
}

interface Animal {
  kind: AnimalKind;
  zone: AnimalZone;
  group: THREE.Group;
  parts: AnimalParts;
  pose: { x: number; z: number; rot: number };
  target: { x: number; z: number };
  phase: 'walk' | 'stay';
  timer: number;
  speed: number;
  swim: boolean;
  isStatic: boolean;
  baseY: number;
}

const animals: Animal[] = [];

const BASE_ANIMAL_SPOTS: Record<'south' | 'west' | 'north' | 'village', { x: number; z: number }[]> = {
  south: [
    { x: 22, z: 48 }, { x: 30, z: 46 }, { x: 44, z: 50 }, { x: 58, z: 47 },
    { x: 72, z: 51 }, { x: 80, z: 48 }, { x: 64, z: 45 }, { x: 36, z: 43 },
    { x: 50, z: 46 }, { x: 76, z: 45 },
  ],
  west: [
    { x: -38, z: 10 }, { x: -38, z: 30 }, { x: -36, z: -22 },
    { x: -38, z: -38 }, { x: -33, z: 38 }, { x: -40, z: -2 }, { x: -33, z: 22 },
  ],
  north: [
    { x: -14, z: -46 }, { x: 12, z: -46 }, { x: -20, z: -44 },
    { x: 18, z: -44 }, { x: 2, z: -52 }, { x: 20, z: -50 },
  ],
  village: [
    { x: 75, z: 57 }, { x: 79, z: 62 }, { x: 83, z: 64 }, { x: 87, z: 59 },
    { x: 90, z: 64 }, { x: 96, z: 61 }, { x: 100, z: 58 }, { x: 73, z: 62 },
    { x: 86, z: 68 }, { x: 98, z: 70 }, { x: 76, z: 60 },
  ],
};

/** Live animal zones for the active world (village follows the site plan). */
const ANIMAL_SPOTS: Record<'south' | 'west' | 'north' | 'village', { x: number; z: number }[]> = {
  south: BASE_ANIMAL_SPOTS.south,
  west: BASE_ANIMAL_SPOTS.west,
  north: BASE_ANIMAL_SPOTS.north,
  village: BASE_ANIMAL_SPOTS.village,
};

function animalMesh(
  parent: THREE.Object3D,
  geo: THREE.BufferGeometry,
  color: number,
  x: number,
  y: number,
  z: number,
  scale?: [number, number, number],
): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.75 }));
  mesh.position.set(x, y, z);
  if (scale) mesh.scale.set(scale[0], scale[1], scale[2]);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  parent.add(mesh);
  return mesh;
}

function animalHead(
  group: THREE.Group,
  parent: THREE.Object3D,
  radius: number,
  color: number,
  y: number,
  z: number,
): { head: THREE.Group; eyes: THREE.Mesh[] } {
  const head = new THREE.Group();
  head.position.set(0, y, z);
  const skull = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 12, 10),
    new THREE.MeshStandardMaterial({ color, roughness: 0.75 }),
  );
  head.add(skull);
  const eyeGeo = new THREE.SphereGeometry(radius * 0.14, 6, 6);
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x111827 });
  const eyes: THREE.Mesh[] = [];
  [-1, 1].forEach((side) => {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(side * radius * 0.4, radius * 0.18, radius * 0.82);
    head.add(eye);
    eyes.push(eye);
  });
  parent.add(head);
  void group;
  return { head, eyes };
}

function buildAnimalModel(kind: AnimalKind): { group: THREE.Group; parts: AnimalParts } {
  const group = new THREE.Group();
  const parts: AnimalParts = { legs: [], ears: [], wings: [] };

  if (kind === 'cat') {
    animalMesh(group, new THREE.SphereGeometry(0.26, 12, 10), 0xf59e0b, 0, 0.3, 0, [1.15, 0.8, 0.95]);
    animalMesh(group, new THREE.SphereGeometry(0.16, 10, 8), 0xfef3c7, 0, 0.32, 0.18, [0.8, 0.7, 0.6]);
    const { head } = animalHead(group, group, 0.2, 0xfbbf24, 0.52, 0.18);
    parts.head = head;
    [-1, 1].forEach((side) => {
      const ear = animalMesh(group, new THREE.ConeGeometry(0.07, 0.16, 6), 0xf59e0b, side * 0.11, 0.7, 0.16);
      ear.rotation.z = side * 0.25;
      parts.ears.push(ear);
    });
    const tail = animalMesh(group, new THREE.CylinderGeometry(0.03, 0.02, 0.4, 6), 0xf59e0b, 0, 0.42, -0.28);
    tail.rotation.x = -0.7;
    parts.tail = tail;
    [-0.14, 0.14].forEach((x) => [-0.12, 0.12].forEach((z) => parts.legs.push(animalMesh(group, new THREE.CylinderGeometry(0.035, 0.035, 0.22, 6), 0xf59e0b, x, 0.11, z))));
  } else if (kind === 'dog') {
    animalMesh(group, new THREE.SphereGeometry(0.3, 12, 10), 0xb45309, 0, 0.38, 0, [1.35, 0.9, 1]);
    animalMesh(group, new THREE.SphereGeometry(0.17, 10, 8), 0xfef3c7, 0, 0.4, 0.22, [0.9, 0.8, 0.7]);
    const { head } = animalHead(group, group, 0.24, 0xb45309, 0.62, 0.3);
    parts.head = head;
    [-1, 1].forEach((side) => {
      const ear = animalMesh(group, new THREE.BoxGeometry(0.1, 0.2, 0.05), 0x78350f, side * 0.2, 0.66, 0.27);
      ear.rotation.z = side * 0.3;
      parts.ears.push(ear);
    });
    const tail = animalMesh(group, new THREE.CylinderGeometry(0.03, 0.02, 0.35, 6), 0xb45309, 0, 0.55, -0.32);
    tail.rotation.x = -0.8;
    parts.tail = tail;
    [-0.16, 0.16].forEach((x) => [-0.14, 0.14].forEach((z) => parts.legs.push(animalMesh(group, new THREE.CylinderGeometry(0.04, 0.04, 0.26, 6), 0xb45309, x, 0.13, z))));
  } else if (kind === 'duck') {
    animalMesh(group, new THREE.SphereGeometry(0.22, 12, 10), 0xfacc15, 0, 0.24, 0, [1.25, 0.8, 1]);
    const { head } = animalHead(group, group, 0.16, 0xfde047, 0.42, 0.18);
    parts.head = head;
    const beak = animalMesh(group, new THREE.ConeGeometry(0.07, 0.16, 8), 0xf97316, 0, 0.4, 0.37);
    beak.rotation.x = Math.PI / 2;
    [-1, 1].forEach((side) => {
      const wing = animalMesh(group, new THREE.SphereGeometry(0.16, 8, 6), 0xeab308, side * 0.2, 0.26, -0.02, [0.35, 0.7, 1]);
      parts.wings.push(wing);
    });
    const tail = animalMesh(group, new THREE.ConeGeometry(0.09, 0.18, 6), 0xfacc15, 0, 0.3, -0.24);
    tail.rotation.x = -1.2;
    parts.tail = tail;
  } else if (kind === 'rabbit') {
    animalMesh(group, new THREE.SphereGeometry(0.22, 12, 10), 0xf8fafc, 0, 0.28, 0, [1.1, 0.85, 1]);
    const { head } = animalHead(group, group, 0.17, 0xf8fafc, 0.45, 0.17);
    parts.head = head;
    [-1, 1].forEach((side) => {
      const ear = animalMesh(group, new THREE.BoxGeometry(0.07, 0.32, 0.045), 0xf8fafc, side * 0.08, 0.68, 0.14);
      ear.rotation.z = side * 0.15;
      parts.ears.push(ear);
      const inner = animalMesh(group, new THREE.BoxGeometry(0.035, 0.22, 0.02), 0xf9a8d4, side * 0.08, 0.68, 0.17);
      inner.rotation.z = side * 0.15;
    });
    const tail = animalMesh(group, new THREE.SphereGeometry(0.09, 8, 6), 0xf8fafc, 0, 0.4, -0.26);
    parts.tail = tail;
    [-0.13, 0.13].forEach((x) => [-0.1, 0.1].forEach((z) => parts.legs.push(animalMesh(group, new THREE.CylinderGeometry(0.035, 0.035, 0.2, 6), 0xf8fafc, x, 0.1, z))));
  } else if (kind === 'capybara') {
    animalMesh(group, new THREE.SphereGeometry(0.42, 14, 10), 0x92400e, 0, 0.4, 0, [1.35, 0.95, 1.05]);
    const { head } = animalHead(group, group, 0.26, 0x92400e, 0.62, 0.38);
    parts.head = head;
    [-1, 1].forEach((side) => parts.ears.push(animalMesh(group, new THREE.SphereGeometry(0.05, 6, 6), 0x78350f, side * 0.17, 0.74, 0.34)));
    const tail = animalMesh(group, new THREE.SphereGeometry(0.06, 6, 6), 0x78350f, 0, 0.5, -0.4);
    parts.tail = tail;
    [-0.2, 0.2].forEach((x) => [-0.18, 0.18].forEach((z) => parts.legs.push(animalMesh(group, new THREE.CylinderGeometry(0.055, 0.055, 0.22, 6), 0x78350f, x, 0.11, z))));
  } else if (kind === 'panda') {
    animalMesh(group, new THREE.SphereGeometry(0.32, 14, 10), 0xf8fafc, 0, 0.36, 0, [1.2, 0.9, 1]);
    const { head } = animalHead(group, group, 0.25, 0xf8fafc, 0.6, 0.2);
    parts.head = head;
    [-1, 1].forEach((side) => {
      parts.ears.push(animalMesh(group, new THREE.SphereGeometry(0.09, 8, 6), 0x111827, side * 0.18, 0.8, 0.18));
      const patch = animalMesh(group, new THREE.SphereGeometry(0.07, 8, 6), 0x111827, side * 0.1, 0.63, 0.39, [1, 1.3, 0.4]);
      void patch;
    });
    animalMesh(group, new THREE.SphereGeometry(0.05, 6, 6), 0x111827, 0, 0.55, 0.44);
    [-0.24, 0.24].forEach((x) => {
      parts.legs.push(animalMesh(group, new THREE.CylinderGeometry(0.07, 0.07, 0.24, 6), 0x111827, x, 0.12, 0.1));
      parts.legs.push(animalMesh(group, new THREE.CylinderGeometry(0.07, 0.07, 0.24, 6), 0x111827, x, 0.12, -0.12));
    });
    const tail = animalMesh(group, new THREE.SphereGeometry(0.07, 6, 6), 0xf8fafc, 0, 0.4, -0.38);
    parts.tail = tail;
  } else if (kind === 'alpaca') {
    animalMesh(group, new THREE.SphereGeometry(0.34, 14, 10), 0xf5f0e6, 0, 0.58, 0, [1.05, 1.15, 1.45]);
    animalMesh(group, new THREE.SphereGeometry(0.24, 10, 8), 0xfaf6ec, 0, 0.78, -0.12);
    animalMesh(group, new THREE.CylinderGeometry(0.11, 0.13, 0.55, 8), 0xe7dcc8, 0, 0.97, 0.3);
    const { head } = animalHead(group, group, 0.17, 0xfaf6ec, 1.28, 0.34);
    parts.head = head;
    [-1, 1].forEach((side) => {
      const ear = animalMesh(group, new THREE.ConeGeometry(0.05, 0.16, 6), 0xf5f0e6, side * 0.09, 1.46, 0.3);
      ear.rotation.z = side * 0.28;
      parts.ears.push(ear);
    });
    animalMesh(group, new THREE.SphereGeometry(0.055, 6, 6), 0xd6cbb8, 0, 1.23, 0.48);
    const tail = animalMesh(group, new THREE.SphereGeometry(0.1, 8, 6), 0xf5f0e6, 0, 0.72, -0.45);
    parts.tail = tail;
    [-0.16, 0.16].forEach((x) =>
      [-0.22, 0.2].forEach((z) =>
        parts.legs.push(animalMesh(group, new THREE.CylinderGeometry(0.045, 0.045, 0.46, 6), 0xe7dcc8, x, 0.23, z)),
      ),
    );
  } else if (kind === 'goat') {
    animalMesh(group, new THREE.SphereGeometry(0.3, 12, 10), 0xe5e7eb, 0, 0.46, 0, [1.2, 0.9, 1.05]);
    const { head } = animalHead(group, group, 0.19, 0xf3f4f6, 0.7, 0.3);
    parts.head = head;
    [-1, 1].forEach((side) => {
      const horn = animalMesh(group, new THREE.ConeGeometry(0.045, 0.24, 6), 0x78716c, side * 0.07, 0.92, 0.26);
      horn.rotation.z = side * 0.45;
      parts.ears.push(animalMesh(group, new THREE.ConeGeometry(0.055, 0.13, 6), 0xd1d5db, side * 0.16, 0.74, 0.28));
    });
    const beard = animalMesh(group, new THREE.ConeGeometry(0.05, 0.17, 6), 0xd1d5db, 0, 0.51, 0.46);
    beard.rotation.x = Math.PI;
    const tail = animalMesh(group, new THREE.ConeGeometry(0.06, 0.18, 6), 0xe5e7eb, 0, 0.58, -0.36);
    tail.rotation.x = -1.1;
    parts.tail = tail;
    [-0.14, 0.14].forEach((x) =>
      [-0.16, 0.16].forEach((z) =>
        parts.legs.push(animalMesh(group, new THREE.CylinderGeometry(0.038, 0.038, 0.3, 6), 0xd1d5db, x, 0.15, z)),
      ),
    );
  } else if (kind === 'pig') {
    animalMesh(group, new THREE.SphereGeometry(0.31, 12, 10), 0xf9a8d4, 0, 0.44, 0, [1.3, 0.95, 1.05]);
    const { head } = animalHead(group, group, 0.2, 0xfbcfe8, 0.58, 0.3);
    parts.head = head;
    const snout = animalMesh(group, new THREE.CylinderGeometry(0.085, 0.085, 0.12, 10), 0xf472b6, 0, 0.54, 0.48);
    snout.rotation.x = Math.PI / 2;
    [-1, 1].forEach((side) => {
      const ear = animalMesh(group, new THREE.ConeGeometry(0.07, 0.14, 4), 0xf472b6, side * 0.13, 0.74, 0.28);
      ear.rotation.z = side * 0.3;
      parts.ears.push(ear);
    });
    const tail = animalMesh(
      group,
      new THREE.TorusGeometry(0.075, 0.022, 6, 10, Math.PI * 1.6),
      0xf472b6,
      0,
      0.52,
      -0.36,
    );
    tail.rotation.y = Math.PI / 2;
    parts.tail = tail;
    [-0.15, 0.15].forEach((x) =>
      [-0.15, 0.15].forEach((z) =>
        parts.legs.push(animalMesh(group, new THREE.CylinderGeometry(0.04, 0.04, 0.24, 6), 0xf9a8d4, x, 0.12, z)),
      ),
    );
  } else {
    const shell = animalMesh(group, new THREE.SphereGeometry(0.26, 12, 8), 0x15803d, 0, 0.2, 0, [1.2, 0.6, 1]);
    void shell;
    animalMesh(group, new THREE.SphereGeometry(0.2, 10, 8), 0x4ade80, 0, 0.13, 0, [1, 0.4, 0.9]);
    const { head } = animalHead(group, group, 0.12, 0x22c55e, 0.22, 0.3);
    parts.head = head;
    [-0.2, 0.2].forEach((x) => [-0.15, 0.15].forEach((z) => parts.legs.push(animalMesh(group, new THREE.CylinderGeometry(0.03, 0.03, 0.12, 6), 0x22c55e, x, 0.06, z))));
    const tail = animalMesh(group, new THREE.ConeGeometry(0.05, 0.12, 6), 0x22c55e, 0, 0.12, -0.32);
    parts.tail = tail;
  }

  styleAnimal(group);
  return { group, parts };
}

/**
 * Re-dress an animal model for the active theme: pastel fur, chrome robot
 * pets with glowing eyes, astronauts in soft white — palette only, the
 * behaviour and zones stay identical.
 */
function styleAnimal(group: THREE.Group): void {
  const style = activeTheme().animal;
  const neutral = style.hue === 0 && style.satMul === 1 && style.lightOff === 0 && !style.emissive && style.metalness === undefined;
  if (neutral) return;
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    mats.forEach((m) => {
      const std = m as THREE.MeshStandardMaterial;
      if (!std.isMeshStandardMaterial) return;
      const hsl = { h: 0, s: 0, l: 0 };
      std.color.getHSL(hsl);
      std.color.setHSL(
        (hsl.h + style.hue + 1) % 1,
        THREE.MathUtils.clamp(hsl.s * style.satMul, 0, 1),
        THREE.MathUtils.clamp(hsl.l + style.lightOff, 0.04, 0.98),
      );
      if (style.emissive !== undefined) {
        std.emissive.setHex(style.emissive);
        std.emissiveIntensity = style.emissiveIntensity ?? 0.3;
      }
      if (style.metalness !== undefined) std.metalness = style.metalness;
    });
  });
}

function buildAnimals(root: THREE.Group): void {
  animals.length = 0;
  const spawns: { kind: AnimalKind; zone: AnimalZone; x: number; z: number; static?: boolean; y?: number }[] = [
    { kind: 'cat', zone: 'south', x: 22, z: 48 },
    { kind: 'cat', zone: 'west', x: -38, z: 26 },
    { kind: 'cat', zone: 'south', x: 78, z: 50 },
    { kind: 'cat', zone: 'south', x: 15.2, z: 9.2, static: true, y: 0.7 },
    { kind: 'dog', zone: 'south', x: 34, z: 46 },
    { kind: 'dog', zone: 'south', x: 12, z: 44.5 },
    { kind: 'dog', zone: 'west', x: -35, z: 18 },
    { kind: 'dog', zone: 'south', x: 66, z: 46 },
    { kind: 'duck', zone: 'pool', x: 76, z: 16, y: 0.06 },
    { kind: 'duck', zone: 'pool', x: 82, z: 12, y: 0.06 },
    { kind: 'duck', zone: 'pool', x: 86, z: 20, y: 0.06 },
    { kind: 'duck', zone: 'pool', x: 71, z: 19, y: 0.06 },
    { kind: 'rabbit', zone: 'south', x: 42, z: 51 },
    { kind: 'rabbit', zone: 'west', x: -38, z: 36 },
    { kind: 'rabbit', zone: 'north', x: -12, z: -46 },
    { kind: 'rabbit', zone: 'north', x: 6, z: -50 },
    { kind: 'capybara', zone: 'pond', x: 28, z: -32.5 },
    { kind: 'turtle', zone: 'pond', x: 23, z: -39 },
    { kind: 'panda', zone: 'north', x: 10, z: -47 },
    { kind: 'panda', zone: 'north', x: -8, z: -51 },
    { kind: 'alpaca', zone: 'village', x: 78, z: 60 },
    { kind: 'alpaca', zone: 'village', x: 96, z: 68 },
    { kind: 'goat', zone: 'village', x: 93, z: 56 },
    { kind: 'goat', zone: 'village', x: 74, z: 64 },
    { kind: 'pig', zone: 'village', x: 84, z: 69 },
    { kind: 'pig', zone: 'village', x: 100, z: 62 },
    { kind: 'rabbit', zone: 'village', x: 72, z: 58 },
    { kind: 'duck', zone: 'village', x: 77, z: 68, y: 0.06 },
    { kind: 'duck', zone: 'village', x: 79, z: 69, y: 0.06 },
    { kind: 'cat', zone: 'village', x: 104, z: 58 },
    { kind: 'dog', zone: 'village', x: 86, z: 55 },
  ];

  spawns.forEach((spawn) => {
    const model = buildAnimalModel(spawn.kind);
    const scale =
      spawn.kind === 'cat'
        ? 1.35
        : spawn.kind === 'dog'
          ? 1.3
          : spawn.kind === 'duck'
            ? 1.8
            : spawn.kind === 'rabbit'
              ? 1.4
              : spawn.kind === 'capybara'
                ? 1.15
                : spawn.kind === 'panda'
                  ? 1.4
                  : spawn.kind === 'alpaca'
                    ? 1.5
                    : spawn.kind === 'goat'
                      ? 1.35
                      : spawn.kind === 'pig'
                        ? 1.4
                        : 1.6;
    model.group.scale.setScalar(scale);
    const baseY = spawn.y ?? 0;
    model.group.position.set(spawn.x, baseY, spawn.z);
    const rot = Math.random() * Math.PI * 2;
    model.group.rotation.y = rot;
    tagInspect(
      model.group,
      ANIMAL_LABELS[spawn.kind],
      'Campus Animal',
      spawn.zone === 'village' ? 'Animal Village resident' : `Roaming the ${spawn.zone} lawn`,
    );
    root.add(model.group);
    animals.push({
      kind: spawn.kind,
      zone: spawn.zone,
      group: model.group,
      parts: model.parts,
      pose: { x: spawn.x, z: spawn.z, rot },
      target: { x: spawn.x, z: spawn.z },
      phase: 'stay',
      timer: 1 + Math.random() * 4,
      speed: 0.6 + Math.random() * 0.7,
      swim: spawn.zone === 'pool',
      isStatic: !!spawn.static,
      baseY,
    });
  });
}

function chooseAnimalTarget(animal: Animal): { x: number; z: number } {
  if (animal.zone === 'pool') {
    return { x: 71 + Math.random() * 18, z: 10 + Math.random() * 12 };
  }
  if (animal.zone === 'pond') {
    return { x: 22 + Math.random() * 8, z: -40 + Math.random() * 8 };
  }
  const list = ANIMAL_SPOTS[animal.zone];
  const spot = list[Math.floor(Math.random() * list.length)] ?? list[0]!;
  return { x: spot.x + (Math.random() - 0.5) * 3, z: spot.z + (Math.random() - 0.5) * 3 };
}

function animateAnimals(dt: number, time: number): void {
  animals.forEach((animal, index) => {
    if (!animal.isStatic) {
      if (animal.phase === 'stay') {
        animal.timer -= dt;
        if (animal.timer <= 0) {
          animal.target = chooseAnimalTarget(animal);
          animal.phase = 'walk';
        }
      } else {
        const dx = animal.target.x - animal.pose.x;
        const dz = animal.target.z - animal.pose.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.25) {
          animal.phase = 'stay';
          animal.timer = (animal.swim ? 2 : 3) + Math.random() * 6;
        } else {
          const step = Math.min(animal.speed * dt, dist);
          animal.pose.x += (dx / dist) * step;
          animal.pose.z += (dz / dist) * step;
          // Land animals bump into village props instead of pacing through them.
          if (!animal.swim) {
            const solved = collisionWorld.resolve(animal.pose.x, animal.pose.z, 0.24);
            if (solved.hit) {
              animal.pose.x = solved.x;
              animal.pose.z = solved.z;
              animal.phase = 'stay';
              animal.timer = 0.5 + Math.random() * 1.5;
            }
          }
          const rot = Math.atan2(dx, dz);
          animal.pose.rot += angleDelta(rot - animal.pose.rot) * Math.min(1, dt * 5);
        }
      }
    }

    animal.group.position.x = animal.pose.x;
    animal.group.position.z = animal.pose.z;
    animal.group.rotation.y = animal.pose.rot;

    const moving = !animal.isStatic && animal.phase === 'walk';
    const hop = animal.kind === 'rabbit' ? 0.18 : animal.kind === 'duck' ? 0.02 : 0.04;
    const bob = moving
      ? Math.abs(Math.sin(time * (animal.kind === 'rabbit' ? 8 : 6) + index)) * hop
      : Math.sin(time * 1.6 + index) * 0.012;
    animal.group.position.y = animal.baseY + (animal.swim ? Math.sin(time * 2 + index) * 0.025 : bob);

    animal.parts.legs.forEach((leg, legIndex) => {
      leg.rotation.x = moving ? Math.sin(time * 7 + index + (legIndex % 2) * Math.PI) * 0.45 : 0;
    });
    if (animal.parts.tail) {
      animal.parts.tail.rotation.z = Math.sin(time * 4 + index) * 0.3;
      animal.parts.tail.rotation.x += Math.sin(time * 5 + index) * 0.002;
    }
    if (animal.parts.head) {
      animal.parts.head.rotation.x = Math.sin(time * 2 + index) * 0.06;
    }
    animal.parts.ears.forEach((ear, earIndex) => {
      const base = earIndex === 0 ? 0.15 : -0.15;
      ear.rotation.z = base + Math.sin(time * 3 + index) * (animal.isStatic ? 0.02 : 0.08);
    });
    animal.parts.wings.forEach((wing, wingIndex) => {
      wing.rotation.z = (wingIndex === 0 ? 1 : -1) * (0.1 + Math.sin(time * 5 + index) * 0.08);
    });
  });
}

function buildAnimalProps(root: THREE.Group, isDark: boolean): void {
  // Doghouse
  const wood = new THREE.MeshStandardMaterial({ color: isDark ? 0x78350f : 0xb45309, roughness: 0.8 });
  const house = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.5, 1.8), wood);
  house.position.set(10, 0.75, 45.2);
  house.castShadow = true;
  root.add(house);
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(1.7, 0.9, 4),
    new THREE.MeshStandardMaterial({ color: 0xb91c1c, roughness: 0.7 }),
  );
  roof.position.set(10, 1.9, 45.2);
  roof.rotation.y = Math.PI / 4;
  root.add(roof);
  const door = new THREE.Mesh(
    new THREE.PlaneGeometry(0.7, 0.9),
    new THREE.MeshBasicMaterial({ color: 0x1c1917 }),
  );
  door.position.set(10, 0.5, 46.12);
  root.add(door);

  // Rabbit hutch
  const hutch = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.0, 1.3), wood);
  hutch.position.set(46, 0.5, 45.4);
  root.add(hutch);
  const hutchRoof = new THREE.Mesh(
    new THREE.ConeGeometry(1.5, 0.6, 4),
    new THREE.MeshStandardMaterial({ color: isDark ? 0x3f3f46 : 0x78716c }),
  );
  hutchRoof.position.set(46, 1.25, 45.4);
  hutchRoof.rotation.y = Math.PI / 4;
  root.add(hutchRoof);

  // Bamboo for the pandas
  const bambooMat = new THREE.MeshStandardMaterial({ color: 0x65a30d, roughness: 0.8 });
  for (let i = 0; i < 9; i++) {
    const x = 6 + (i % 3) * 1.4;
    const z = -50 + Math.floor(i / 3) * 1.2;
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 3.2, 6), bambooMat);
    stalk.position.set(x, 1.6, z);
    root.add(stalk);
    for (let leaf = 0; leaf < 3; leaf++) {
      const l = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.8, 4), bambooMat);
      l.position.set(x + (leaf - 1) * 0.25, 2.4 + leaf * 0.35, z);
      l.rotation.z = (leaf - 1) * 0.8;
      root.add(l);
    }
  }
}

/* --------------------------------------------------------------------------
   Characters (Quaternius CC0 rigs with a procedural fallback)
   -------------------------------------------------------------------------- */
const FEMALE_PERSONAS = new Set<AgentId>(['ada', 'mia', 'nova', 'iris']);
const SKIN_TONES = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0xd9a066, 0xa86b3c, 0x6f4e37];
const PANTS_TONES = [0x1f2937, 0x334155, 0x3f3f46, 0x4b5563, 0x1e3a8a];

function isFemaleCharacter(ag: AgentDef): boolean {
  if (!ag.ambient) return FEMALE_PERSONAS.has(ag.id);
  return (ag.deskIndex + ag.name.length) % 2 === 0;
}

function buildCharacter(ag: AgentDef, isDark: boolean): THREE.Group {
  const p = pose.get(ag.id) ?? { x: ag.pos3D.x, z: ag.pos3D.z, rot: Math.PI };
  const female = isFemaleCharacter(ag);
  const source =
    realisticAssets?.characters[female ? 'female' : 'male'] ??
    realisticAssets?.characters[female ? 'male' : 'female'];
  if (source) {
    const skin = SKIN_TONES[(ag.deskIndex * 3 + ag.name.length) % SKIN_TONES.length] ?? 0xf1c27d;
    const pants = PANTS_TONES[ag.deskIndex % PANTS_TONES.length] ?? 0x334155;
    const rig = createCharacterRig(source, {
      height: ag.ambient ? 2.0 : 2.15,
      shirt: ag.color,
      pants,
      hair: ag.hairColor,
      skin,
      seed: ag.deskIndex * 1.7 + ag.name.length,
    });
    const g = rig.group;
    g.position.set(p.x, 0, p.z);
    g.rotation.y = p.rot;
    g.userData['agentId'] = ag.id;
    const ring = g.userData['ring'] as
      | THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
      | undefined;
    if (ring) ring.material.opacity = ag.id === appState.selectedAgent ? 0.85 : 0;
    return g;
  }

  const g = new THREE.Group();
  g.position.set(p.x, 0, p.z);
  g.rotation.y = p.rot;
  g.userData['agentId'] = ag.id;

  const skinMat = new THREE.MeshStandardMaterial({ color: 0xfbd0b0, roughness: 0.6 });
  const shirtMat = new THREE.MeshStandardMaterial({ color: ag.color, roughness: 0.7 });
  const pantsMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x27272a : 0x334155, roughness: 0.8 });
  const hairMat = new THREE.MeshStandardMaterial({ color: ag.hairColor, roughness: 0.8 });

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.82, 0.44), shirtMat);
  torso.position.y = 1.28;
  torso.castShadow = true;
  g.add(torso);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.48, 0.44), skinMat);
  head.position.y = 1.92;
  head.castShadow = true;
  g.add(head);
  g.userData['headMesh'] = head;

  const glassesMat = new THREE.MeshBasicMaterial({ color: 0x1e1b4b });
  const darkHair = hairMat;
  const addBox = (
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    mat: THREE.Material,
  ): void => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    g.add(mesh);
  };

  switch (ag.id) {
    case 'ada':
    case 'mia':
      addBox(0.52, 0.2, 0.5, 0, 2.16, -0.02, darkHair);
      addBox(0.26, 0.24, 0.24, 0, 2.34, -0.2, darkHair);
      addBox(0.36, 0.07, 0.04, 0, 1.94, 0.23, glassesMat);
      break;
    case 'dylan':
    case 'max':
      addBox(0.54, 0.18, 0.5, 0, 2.16, 0, darkHair);
      addBox(0.6, 0.06, 0.1, 0, 2.18, 0, new THREE.MeshStandardMaterial({ color: 0xef4444 }));
      addBox(0.1, 0.24, 0.1, -0.28, 1.92, 0, new THREE.MeshStandardMaterial({ color: 0xef4444 }));
      addBox(0.1, 0.24, 0.1, 0.28, 1.92, 0, new THREE.MeshStandardMaterial({ color: 0xef4444 }));
      break;
    case 'quinn':
    case 'kai':
      addBox(0.54, 0.26, 0.52, 0, 2.2, 0, new THREE.MeshStandardMaterial({ color: ag.hairColor }));
      break;
    case 'otto':
      addBox(0.54, 0.16, 0.52, 0, 2.16, 0, new THREE.MeshStandardMaterial({ color: 0xd97706 }));
      addBox(0.5, 0.04, 0.24, 0, 2.1, 0.32, new THREE.MeshStandardMaterial({ color: 0xd97706 }));
      break;
    case 'nova':
      addBox(0.54, 0.2, 0.5, 0, 2.14, 0, darkHair);
      addBox(0.16, 0.72, 0.16, 0, 1.75, -0.28, darkHair);
      break;
    case 'leo':
      addBox(0.54, 0.18, 0.5, 0, 2.14, 0, darkHair);
      addBox(0.36, 0.07, 0.04, 0, 1.94, 0.23, glassesMat);
      break;
    case 'iris':
      addBox(0.54, 0.2, 0.5, 0, 2.14, 0, darkHair);
      addBox(0.16, 0.55, 0.16, 0, 1.85, -0.26, darkHair);
      break;
    default:
      addBox(0.54, 0.2, 0.5, 0, 2.14, 0, darkHair);
      break;
  }

  // Arms
  const armGeo = new THREE.BoxGeometry(0.16, 0.66, 0.16);
  const leftArm = new THREE.Mesh(armGeo, shirtMat);
  leftArm.position.set(-0.46, 1.2, 0.02);
  leftArm.castShadow = true;
  g.add(leftArm);
  g.userData['leftArm'] = leftArm;

  const rightArm = new THREE.Mesh(armGeo, shirtMat);
  rightArm.position.set(0.46, 1.2, 0.02);
  rightArm.castShadow = true;
  g.add(rightArm);
  g.userData['rightArm'] = rightArm;

  // Legs
  const legGeo = new THREE.BoxGeometry(0.22, 0.72, 0.24);
  const legL = new THREE.Mesh(legGeo, pantsMat);
  legL.position.set(-0.17, 0.37, 0);
  legL.castShadow = true;
  g.add(legL);
  g.userData['legLeft'] = legL;

  const legR = new THREE.Mesh(legGeo, pantsMat);
  legR.position.set(0.17, 0.37, 0);
  legR.castShadow = true;
  g.add(legR);
  g.userData['legRight'] = legR;

  // Shoes
  addBox(0.24, 0.1, 0.34, -0.17, 0.05, 0.05, new THREE.MeshStandardMaterial({ color: 0x111827 }));
  addBox(0.24, 0.1, 0.34, 0.17, 0.05, 0.05, new THREE.MeshStandardMaterial({ color: 0x111827 }));

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.65, 32),
    new THREE.MeshBasicMaterial({
      color: ag.color,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: ag.id === appState.selectedAgent ? 0.85 : 0.0,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  g.add(ring);
  g.userData['ring'] = ring;

  return g;
}

/* --------------------------------------------------------------------------
   Squad crowd: 4 extra coworkers per visible session (5 agents per session)
   -------------------------------------------------------------------------- */
function angleDelta(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function crowdSeat(sessionIndex: number, memberIndex: number): { x: number; z: number } {
  return {
    x: -33.9 + memberIndex * 3.4,
    z: 20 + sessionIndex * 5 + 1.15,
  };
}

function clearCrowd(): void {
  if (crowdRoot) {
    crowdRoot.traverse(disposeNode);
    crowdRoot.parent?.remove(crowdRoot);
    crowdRoot = null;
  }
  crowdGroups.forEach(unregisterInteractive);
  crowdMembers.length = 0;
  crowdGroups.length = 0;
  crowdSignature = '';
}

function rebuildCrowd(isDark: boolean): void {
  if (!contentRoot) return;
  clearCrowd();
  const sessions = sessionStore.sessions.slice(0, MAX_VISIBLE_SESSIONS);
  const groupRoot = new THREE.Group();
  crowdRoot = groupRoot;

  sessions.forEach((session, row) => {
    for (let i = 0; i < SQUAD_PER_SESSION; i++) {
      const index = row * SQUAD_PER_SESSION + i;
      const seat = crowdSeat(row, i);
      const lookId = AGENT_IDS[(index + 2) % AGENT_IDS.length] ?? 'max';
      const base = AGENTS[lookId];
      const look: AgentDef = {
        ...base,
        id: lookId,
        name: CROWD_NAMES[index % CROWD_NAMES.length] ?? 'Crew',
        color: CROWD_COLORS[index % CROWD_COLORS.length] ?? 0x64748b,
        pos3D: { x: seat.x, y: 0, z: seat.z },
        deskIndex: index,
        ambient: true,
        state: 'IDLE',
        currentTask: '',
        bubbleText: '',
      };
      const group = buildCharacter(look, isDark);
      group.traverse((obj) => {
        obj.castShadow = false;
        obj.receiveShadow = false;
      });
      group.userData.agentId = session.persona;
      group.position.set(seat.x, 0, seat.z);
      group.rotation.y = Math.PI;
      const ring = group.userData.ring as
        | THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
        | undefined;
      if (ring) ring.material.opacity = 0;
      groupRoot.add(group);
      crowdGroups.push(group);
      registerInteractive(group);
      crowdMembers.push({
        sessionId: session.id,
        persona: session.persona,
        status: session.status,
        seat,
        group,
        pose: { x: seat.x, z: seat.z, rot: Math.PI },
        phase: session.status === 'running' ? 'work' : 'stay',
        target: { x: seat.x, z: seat.z },
        timer: 1 + Math.random() * 5,
        path: [],
        vx: 0,
        vz: 0,
        repath: 0,
        speed: 0,
      });
    }
  });

  (worldRoot ?? contentRoot).add(groupRoot);
  crowdSignature = sessions.map((s) => s.id).join('|');
}

function syncCrowd(): void {
  const sessions = sessionStore.sessions.slice(0, MAX_VISIBLE_SESSIONS);
  const signature = sessions.map((s) => s.id).join('|');
  if (signature !== crowdSignature || !crowdRoot) {
    rebuildCrowd(appState.officeDark);
    return;
  }
  sessions.forEach((session) => {
    crowdMembers.forEach((member) => {
      if (member.sessionId === session.id) member.status = session.status;
    });
  });
}

/**
 * Advance a body along its waypoint list with collision-aware steering. Pops
 * finished waypoints and repaths when it grinds against an obstacle. `onArrive`
 * runs once the whole path (and the final target) is complete.
 */
function followPath(
  member: CrowdMember,
  dt: number,
  finalTarget: Pt,
  speed: number,
  finalRot: number | undefined,
  onArrive: () => void,
): void {
  if (member.path.length === 0) {
    member.path = collisionWorld.findPath(
      { x: member.pose.x, z: member.pose.z },
      finalTarget,
      CROWD_RADIUS,
    );
    if (member.path.length === 0) {
      member.path = [{ x: finalTarget.x, z: finalTarget.z }];
    }
  }
  const wp = member.path[0] ?? finalTarget;
  const isLast = member.path.length === 1;
  const body = { x: member.pose.x, z: member.pose.z, rot: member.pose.rot, vx: member.vx, vz: member.vz };
  const result = stepBody(collisionWorld, body, wp, dt, {
    speed,
    radius: CROWD_RADIUS,
    arriveRadius: isLast ? 0.3 : 0.45,
    accel: 3.0,
    decel: 5.0,
  });
  member.pose.x = body.x;
  member.pose.z = body.z;
  member.pose.rot = body.rot;
  member.vx = body.vx;
  member.vz = body.vz;
  member.speed = Math.hypot(body.vx, body.vz);

  if (result.arrived) {
    member.path.shift();
    member.repath = 0;
    if (member.path.length === 0) {
      member.vx = 0;
      member.vz = 0;
      if (finalRot !== undefined) member.pose.rot = finalRot;
      onArrive();
    }
    return;
  }

  if (result.blocked) {
    member.repath += dt;
    if (member.repath > 0.7) {
      const repath = collisionWorld.findPath(
        { x: member.pose.x, z: member.pose.z },
        finalTarget,
        CROWD_RADIUS,
      );
      if (repath.length > 0) member.path = repath;
      member.repath = 0;
    }
  } else {
    member.repath = 0;
  }
}

function animateCrowd(dt: number, time: number): void {
  crowdMembers.forEach((member, index) => {
    const g = member.group;
    member.speed = 0;

    if (member.status === 'running') {
      if (member.phase === 'work') {
        member.vx = 0;
        member.vz = 0;
      } else {
        followPath(member, dt, member.seat, 1.6, Math.PI, () => {
          member.pose.x = member.seat.x;
          member.pose.z = member.seat.z;
          member.pose.rot = Math.PI;
          member.phase = 'work';
        });
      }
    } else {
      if (member.phase === 'work' || member.phase === 'walk') {
        if (member.phase === 'work') {
          member.phase = 'stay';
          member.timer = 0.4;
          member.path = [];
        } else if (member.phase === 'walk' && !collisionWorld.isFree(member.target.x, member.target.z, CROWD_RADIUS)) {
          member.path = [];
          member.phase = 'stay';
          member.timer = 0.2;
        }
      }
      if (member.phase === 'stay') {
        member.vx = 0;
        member.vz = 0;
        member.timer -= dt;
        if (member.timer <= 0) {
          const spot = CROWD_SPOTS[Math.floor(Math.random() * CROWD_SPOTS.length)] ?? CROWD_SPOTS[0]!;
          const jittered = {
            x: spot.x + (Math.random() - 0.5) * 2.4,
            z: spot.z + (Math.random() - 0.5) * 2.4,
          };
          const path = collisionWorld.findPath(
            { x: member.pose.x, z: member.pose.z },
            jittered,
            CROWD_RADIUS,
          );
          if (path.length === 0) {
            member.timer = 1.5 + Math.random() * 2;
            return;
          }
          member.target = jittered;
          member.path = path;
          member.phase = 'walk';
          member.repath = 0;
        }
      } else {
        followPath(member, dt, member.target, 1.5, undefined, () => {
          member.phase = 'stay';
          member.timer = 6 + Math.random() * 9;
        });
      }
    }

    g.position.x = member.pose.x;
    g.position.z = member.pose.z;
    g.rotation.y = member.pose.rot;

    const walking = member.phase === 'walk';
    const rig = g.userData['rig'] as CharacterRig | undefined;
    g.position.y = rig ? 0 : walking ? Math.abs(Math.sin(time * 8 + index)) * 0.04 : 0;

    if (rig) {
      updateCharacterRig(
        rig,
        dt,
        walking ? 'walk' : member.status === 'running' ? 'type' : 'idle',
        time,
        member.speed,
      );
      return;
    }

    const head = g.userData['headMesh'] as THREE.Mesh | undefined;
    if (head) head.position.y = 1.92 + Math.sin(time * 2.2 + index) * 0.02;

    const leftArm = g.userData['leftArm'] as THREE.Mesh | undefined;
    const rightArm = g.userData['rightArm'] as THREE.Mesh | undefined;
    const legL = g.userData['legLeft'] as THREE.Mesh | undefined;
    const legR = g.userData['legRight'] as THREE.Mesh | undefined;

    if (walking) {
      if (leftArm) leftArm.rotation.x = Math.sin(time * 8 + index) * 0.55;
      if (rightArm) rightArm.rotation.x = -Math.sin(time * 8 + index) * 0.55;
      if (legL) legL.rotation.x = -Math.sin(time * 8 + index) * 0.5;
      if (legR) legR.rotation.x = Math.sin(time * 8 + index) * 0.5;
    } else if (member.status === 'running') {
      if (leftArm) leftArm.rotation.x = -0.9 + Math.sin(time * 9 + index) * 0.16;
      if (rightArm) rightArm.rotation.x = -0.9 + Math.cos(time * 9 + index) * 0.16;
      if (legL) legL.rotation.x = 0;
      if (legR) legR.rotation.x = 0;
    } else {
      if (leftArm) leftArm.rotation.x = Math.sin(time * 1.5 + index) * 0.06;
      if (rightArm) rightArm.rotation.x = -Math.sin(time * 1.5 + index) * 0.06;
      if (legL) legL.rotation.x = 0;
      if (legR) legR.rotation.x = 0;
    }
  });
}

/* --------------------------------------------------------------------------
   Build / dispose
   -------------------------------------------------------------------------- */
const MATERIAL_MAP_KEYS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
  'alphaMap',
] as const;

function disposeNode(node: THREE.Object3D): void {
  const rig = node.userData['rig'] as CharacterRig | undefined;
  if (rig) disposeCharacterRig(rig);

  const mesh = node as THREE.Mesh;
  // External GLBs are cloned per placement: their geometry and source
  // materials are shared between every clone, so only owned resources go.
  if (mesh.geometry && !mesh.geometry.userData['shared']) {
    mesh.geometry.dispose();
  }
  const mats = Array.isArray(mesh.material)
    ? mesh.material
    : mesh.material
      ? [mesh.material]
      : [];
  mats.forEach((m) => {
    if (!m || m.userData['shared']) return;
    const withMaps = m as unknown as Record<string, THREE.Texture | null | undefined>;
    for (const key of MATERIAL_MAP_KEYS) {
      const texture = withMaps[key];
      if (texture && !texture.userData['shared']) texture.dispose();
    }
    m.dispose();
  });
}

function clearContent(): void {
  if (!contentRoot || !scene) return;
  closeInspector();
  if (camera && controls) {
    // Persist live positions across rebuilds.
    characterGroups.forEach((g) => {
      const id = g.userData['agentId'] as AgentId | undefined;
      if (!id) return;
      pose.set(id, { x: g.position.x, z: g.position.z, rot: g.rotation.y });
    });
  }
  contentRoot.traverse(disposeNode);
  scene.remove(contentRoot);
  contentRoot = null;
  worldRoot = null;
  interactiveRoots.length = 0;
  crowdMembers.length = 0;
  crowdGroups.length = 0;
  crowdRoot = null;
  crowdSignature = '';
  staffGroups.length = 0;
  animals.length = 0;
  visitorStates.length = 0;
  butterflies.length = 0;
  shuttleWheels.length = 0;
  shuttleGroup = null;
  shuttleState.x = 32.4;
  shuttleState.z = -42;
  shuttleState.dir = 1;
  shuttleState.wait = 0;
  shuttleState.stopDone = false;
  shuttleState.speed = 0;
  shuttleState.accel = 0;
  resetSurroundings();
  liveFeedTexture = null;
  liveFeedCanvas = null;
  commandTexture = null;
  commandCanvas = null;
  boardTexture = null;
  boardCanvas = null;
  serverTexture = null;
  serverCanvas = null;
  balloonGroup = null;
  serverLeds.length = 0;
  steamParticles.length = 0;
  characterGroups.length = 0;
  tvTexture = null;
}

/* --------------------------------------------------------------------------
   Campus plate treatment per world: floating cliff, orbital pedestal,
   toy playmat border, neon edge. Forest and beach keep the plain lawn.
   -------------------------------------------------------------------------- */
function buildCampusBase(root: THREE.Group, isDark: boolean): void {
  const P = activeTheme();
  const base = P.layout.base;
  if (base === 'jungle' || base === 'beach') return;
  const cx = FLOOR_CENTER.x;
  const hw = ROOM.w / 2;
  const hd = ROOM.d / 2;

  if (base === 'cliff') {
    const rockMat = new THREE.MeshStandardMaterial({
      color: isDark ? 0x3f3a5a : 0x8d7f74,
      roughness: 1,
      flatShading: true,
    });
    const shelf = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.7, 1, 12), rockMat);
    shelf.scale.set(hw * 1.01, 18, hd * 1.01);
    shelf.position.set(cx, -9.5, 0);
    root.add(shelf);
    // Boulders under the rim, visible past the lawn edge from above.
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const h = 5 + ((i * 13) % 8);
      const rock = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 7), rockMat);
      rock.scale.set(7 + (i % 4) * 4, h, 7 + (i % 3) * 5);
      rock.rotation.x = Math.PI;
      rock.position.set(
        cx + Math.cos(a) * (hw * 1.06 + (i % 3) * 5),
        -0.6 - h / 2,
        Math.sin(a) * (hd * 1.08 + (i % 4) * 4),
      );
      root.add(rock);
    }
    // Free-floating boulders around the island — the classic sky-island read.
    const floatMat = new THREE.MeshStandardMaterial({
      color: isDark ? 0x4a4363 : 0x9c8f83,
      roughness: 1,
      flatShading: true,
    });
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + 0.3;
      const size = 3 + (i % 4) * 2.2;
      const chunk = new THREE.Mesh(new THREE.DodecahedronGeometry(size, 0), floatMat);
      chunk.position.set(
        cx + Math.cos(a) * (hw * 1.16 + (i % 3) * 9),
        3 + ((i * 7) % 11),
        Math.sin(a) * (hd * 1.2 + (i % 4) * 7),
      );
      chunk.rotation.set(i * 0.7, i * 1.3, i * 0.4);
      root.add(chunk);
    }
    // Cloud sea under the island.
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const grad = ctx.createRadialGradient(64, 64, 8, 64, 64, 62);
      grad.addColorStop(0, 'rgba(248,250,255,0.95)');
      grad.addColorStop(1, 'rgba(226,240,255,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 128, 128);
    }
    const cloudTex = new THREE.CanvasTexture(canvas);
    cloudTex.colorSpace = THREE.SRGBColorSpace;
    const cloud = new THREE.Mesh(
      new THREE.PlaneGeometry(900, 820),
      new THREE.MeshBasicMaterial({ map: cloudTex, transparent: true, opacity: isDark ? 0.45 : 0.9, depthWrite: false }),
    );
    cloud.rotation.x = -Math.PI / 2;
    cloud.position.set(cx, -13, 0);
    root.add(cloud);
    for (let i = 0; i < 4; i++) {
      const puff = new THREE.Mesh(
        new THREE.PlaneGeometry(260, 200),
        new THREE.MeshBasicMaterial({ map: cloudTex, transparent: true, opacity: isDark ? 0.32 : 0.7, depthWrite: false }),
      );
      puff.rotation.x = -Math.PI / 2;
      puff.position.set(cx + [-140, 120, -60, 150][i]!, -4 - i * 2.2, [-90, 70, 130, -110][i]!);
      root.add(puff);
    }
  }

  if (base === 'deck') {
    const deckMat = new THREE.MeshStandardMaterial({
      color: isDark ? 0x1e293b : 0x475569,
      metalness: 0.6,
      roughness: 0.4,
    });
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.94, 1, 48), deckMat);
    pedestal.scale.set(hw * 0.995, 8, hd * 0.995);
    pedestal.position.set(cx, -4, 0);
    root.add(pedestal);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.011, 8, 96),
      new THREE.MeshBasicMaterial({ color: P.accent }),
    );
    rim.scale.set(hw * 0.97, hd * 0.97, 1);
    rim.rotation.x = Math.PI / 2;
    rim.position.set(cx, 0.07, 0);
    root.add(rim);
    const beaconMat = new THREE.MeshBasicMaterial({ color: P.accent });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const post = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.55, 1.4), beaconMat);
      post.position.set(cx + Math.cos(a) * hw * 0.95, 0.27, Math.sin(a) * hd * 0.95);
      root.add(post);
    }
  }

  if (base === 'playmat') {
    const candy = [0xef4444, 0xf59e0b, 0xfacc15, 0x22c55e, 0x3b82f6, 0xa855f7];
    const seg = 16;
    const segW = (ROOM.w + 8) / seg;
    const segD = (ROOM.d + 8) / seg;
    for (let i = 0; i < seg; i++) {
      const color = candy[i % candy.length]!;
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
      const north = new THREE.Mesh(new THREE.BoxGeometry(segW, 0.5, 2.4), mat);
      north.position.set(cx - hw - 4 + segW * (i + 0.5), 0.22, -hd - 4.2);
      root.add(north);
      const south = north.clone();
      south.position.z = hd + 4.2;
      root.add(south);
      const west = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.5, segD), mat);
      west.position.set(cx - hw - 4.2, 0.22, -hd - 4 + segD * (i + 0.5));
      root.add(west);
      const east = west.clone();
      east.position.x = cx + hw + 4.2;
      root.add(east);
    }
  }

  if (base === 'neon') {
    const glow = new THREE.MeshBasicMaterial({ color: P.accent });
    const strip = (w: number, d: number, x: number, z: number): void => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), glow);
      m.position.set(x, 0.055, z);
      root.add(m);
    };
    strip(ROOM.w + 7, 0.55, cx, -hd - 2.6);
    strip(ROOM.w + 7, 0.55, cx, hd + 2.6);
    strip(0.55, ROOM.d + 7, cx - hw - 2.6, 0);
    strip(0.55, ROOM.d + 7, cx + hw + 2.6, 0);
    const pylonMat = new THREE.MeshStandardMaterial({
      color: isDark ? 0x111827 : 0x1f2937,
      metalness: 0.7,
      roughness: 0.35,
    });
    for (const [x, z] of [
      [cx - hw - 2.6, -hd - 2.6],
      [cx + hw + 2.6, -hd - 2.6],
      [cx - hw - 2.6, hd + 2.6],
      [cx + hw + 2.6, hd + 2.6],
    ] as [number, number][]) {
      const pylon = new THREE.Mesh(new THREE.BoxGeometry(3, 7, 3), pylonMat);
      pylon.position.set(x, 3.5, z);
      root.add(pylon);
      const tip = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.3, 3.2), glow);
      tip.position.set(x, 7.1, z);
      root.add(tip);
    }
  }
}

function buildContent(isDark: boolean): void {
  if (!scene) return;
  initLiveScreens();
  rebuildRoamTargets();
  registerCollisionGeometry();
  // The whole estate is built in local campus coordinates inside worldRoot;
  // contentRoot only carries the per-world rotation around the campus centre.
  contentRoot = new THREE.Group();
  const rotY = (activeTheme().layout.rotate * Math.PI) / 180;
  contentRoot.position.set(FLOOR_CENTER.x, 0, FLOOR_CENTER.z);
  contentRoot.rotation.y = rotY;
  worldRoot = new THREE.Group();
  worldRoot.position.set(-FLOOR_CENTER.x, 0, -FLOOR_CENTER.z);
  contentRoot.add(worldRoot);
  const root = worldRoot;
  const L = activeTheme().layout;

  buildSurroundings(root, isDark);
  buildFloorAndWalls(root, isDark);
  buildCampusBase(root, isDark);
  buildDesks(root, isDark);
  buildWhiteboard(root);
  buildServerRack(root, isDark, 17.6, -11.4, -Math.PI / 8);
  buildServerRack(root, isDark, 19.7, -10.8, -Math.PI / 8);
  buildCoffeeStation(root, isDark);
  buildLounge(root, isDark);
  buildExtras(root, isDark);
  buildRooms(root, isDark);
  buildRoads(root, isDark);
  buildCampusLandscaping(root, isDark);
  buildSportsWing(root, isDark);
  buildDistricts(root, isDark);

  const attractions = new THREE.Group();
  attractions.position.set(L.attractions[0], 0, L.attractions[1]);
  root.add(attractions);
  buildAttractions(attractions, isDark);

  const village = new THREE.Group();
  village.position.set(L.village[0], 0, L.village[1]);
  root.add(village);
  buildAnimalVillage(village, isDark);

  buildStaff(root, isDark);
  buildAnimals(root);
  buildAnimalProps(root, isDark);
  buildVisitors(root, isDark);
  buildButterflies(root);
  if (L.shuttle) buildShuttle(root);
  buildPendantLamps(root);

  createPottedPlant(root, -7, -13.2, isDark);
  createPottedPlant(root, 21, -8.5, isDark);
  createPottedPlant(root, 20.6, 2.5, isDark);
  createPottedPlant(root, -21, 3.2, isDark);
  createPottedPlant(root, 2.5, -13.1, isDark);
  createPottedPlant(root, -21, 12.5, isDark);
  createPottedPlant(root, 3.2, 5.4, isDark);

  AGENT_IDS.forEach((id) => {
    const ag = AGENTS[id];
    if (!pose.has(id)) initRoamFor(ag);
    const g = buildCharacter(ag, isDark);
    ag.meshGroup = g;
    characterGroups.push(g);
    registerInteractive(g);
    root.add(g);
  });

  scene.add(contentRoot);

  // Squad coworkers for every visible session (4 per session + the lead = 5).
  syncCrowd();
}

let ambient: THREE.AmbientLight | null = null;
let dirLight: THREE.DirectionalLight | null = null;

function applyLighting(isDark: boolean): void {
  if (!scene || !ambient || !dirLight) return;
  const P = activeTheme();
  skyTexture?.dispose();
  skyTexture = createSkyTexture(isDark);
  scene.background = skyTexture;
  scene.environment = realisticAssets?.envMap ?? null;
  scene.environmentIntensity = realisticAssets?.envMap ? (isDark ? P.envNight : P.envDay) : 0;
  // Atmosphere per theme: humus haze, cloud glow, neon smog, sea sparkle or
  // none at all in open space.
  const fog = isDark ? P.fogNight : P.fogDay;
  scene.fog = fog ? new THREE.FogExp2(fog.color, fog.density) : null;
  const amb = isDark ? P.ambientNight : P.ambientDay;
  ambient.color.setHex(amb.color);
  ambient.intensity = amb.intensity;
  const dir = isDark ? P.dirNight : P.dirDay;
  dirLight.color.setHex(dir.color);
  dirLight.intensity = dir.intensity;
  if (renderer) renderer.toneMappingExposure = isDark ? P.exposureNight : P.exposureDay;
}

async function startRealisticAssets(): Promise<void> {
  if (realisticLoadStarted || !renderer) return;
  realisticLoadStarted = true;
  setAssetStatus('CC0 art: loading…');
  try {
    const loaded = await loadRealisticAssets(renderer, (done, total, label) => {
      setAssetStatus(`CC0 art: ${done}/${total} · ${label}`);
    });
    realisticAssets = loaded;
    if (loaded.failed.length > 0) {
      setAssetStatus(
        `CC0 art: ${loaded.failed.length} unavailable · procedural fallback`,
        loaded.failed.join('\n'),
      );
      console.warn('[scene] some CC0 assets failed, procedural stand-ins stay active', loaded.failed);
    } else {
      setAssetStatus('CC0 art: all loaded');
    }
    if (!scene || !renderer) return;
    // Rebuild once so floors, props and characters switch from their
    // procedural stand-ins to the external GLBs in a single pass.
    applyLighting(appState.officeDark);
    rebuildForTheme(appState.officeDark);
  } catch (error) {
    setAssetStatus('CC0 art: procedural fallback', String(error));
    console.warn('[scene] external assets unavailable, keeping procedural art', error);
  }
}

export function initScene(): boolean {
  container = document.getElementById('threeContainer');
  if (!container) return false;

  bubbleEls = {};
  AGENT_IDS.forEach((id) => {
    bubbleEls[id] = document.getElementById(`speech-${id}`);
  });

  const isDark = appState.officeDark;

  try {
    scene = new THREE.Scene();
    const w = container.clientWidth || 900;
    const h = container.clientHeight || 450;
    camera = new THREE.PerspectiveCamera(38, w / h, 0.1, 520);
    camera.position.set(30, 140, 185);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = isDark ? 1.18 : 1.05;
    container.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('aria-hidden', 'true');

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.target.set(30, 0, 24);
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.minDistance = 6;
    controls.maxDistance = 340;
    controls.addEventListener('start', () => {
      tween = null;
    });

    ambient = new THREE.AmbientLight(0xffffff, 2.7);
    scene.add(ambient);
    dirLight = new THREE.DirectionalLight(0xfffaed, 3.0);
    dirLight.position.set(40, 60, 40);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(2048, 2048);
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 200;
    dirLight.shadow.camera.left = -110;
    dirLight.shadow.camera.right = 110;
    dirLight.shadow.camera.top = 110;
    dirLight.shadow.camera.bottom = -110;
    dirLight.shadow.bias = -0.0005;
    scene.add(dirLight);

    const fill = new THREE.DirectionalLight(0xe0e7ff, 1.1);
    fill.position.set(-16, 14, -16);
    scene.add(fill);

    raycaster = new THREE.Raycaster();

    initWorldTheme();
    // Start the camera on the (possibly rotated) overview for this world.
    rebuildPresets();
    const ov = PRESETS['overview'];
    if (ov) {
      camera.position.set(ov.pos[0], ov.pos[1], ov.pos[2]);
      controls.target.set(ov.look[0], ov.look[1], ov.look[2]);
    }
    applyLighting(isDark);
    buildContent(isDark);
    const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
    if (env?.DEV) {
      // Exposed for the verification scripts: navigation, collision, bodies.
      const debug: Record<string, unknown> = {
        world: collisionWorld,
        assigned: () => [...assignedPersonas],
        agents: () =>
          AGENT_IDS.map((id) => ({
            id,
            bubble: AGENTS[id].bubbleText,
            state: AGENTS[id].state,
            mesh: !!AGENTS[id].meshGroup,
          })),
        bodies: () => [
          ...Array.from(pose.values()).map((p) => ({ x: p.x, z: p.z })),
          ...crowdMembers.map((m) => ({ x: m.pose.x, z: m.pose.z })),
          ...visitorStates.map((v) => ({ x: v.pose.x, z: v.pose.z })),
          { x: shuttleState.x, z: shuttleState.z },
        ],
        // Screenshots for public docs: temporarily hide the live-data screens
        // so real session names never end up in README images.
        hideLiveScreens: (hide: boolean): void => {
          const textures: (THREE.Texture | null)[] = [
            liveFeedTexture,
            commandTexture,
            boardTexture,
            serverTexture,
            tvTexture,
          ];
          contentRoot?.traverse((o) => {
            const mesh = o as THREE.Mesh;
            const material = mesh.material as THREE.MeshBasicMaterial | undefined;
            if (material && textures.includes(material.map ?? null)) mesh.visible = !hide;
          });
        },
      };
      (window as unknown as Record<string, unknown>)['__hqPhysics'] = debug;
      (window as unknown as Record<string, unknown>)['__hqScene'] = scene;
      (window as unknown as Record<string, unknown>)['__hqCam'] = camera;
    }
    // Let the first frame and splash fade finish before pulling ~25 MB of art.
    window.setTimeout(() => {
      void startRealisticAssets();
    }, 450);

    bindInspectUI();
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);
    renderer.domElement.addEventListener('click', onCanvasClick);
    const ro = new ResizeObserver(() => onResize());
    ro.observe(container);

    timer.reset();
    window.requestAnimationFrame(loop);
    return true;
  } catch (err) {
    console.error('[scene] WebGL unavailable', err);
    scene = null;
    showFallback(container);
    return false;
  }
}

function onResize(): void {
  if (!container || !renderer || !camera) return;
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w === 0 || h === 0) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function showFallback(el: HTMLElement): void {
  const msg = document.createElement('div');
  msg.className = 'absolute inset-0 flex items-center justify-center text-sm text-slate-500 dark:text-zinc-400';
  msg.textContent = '3D viewport unavailable (WebGL disabled). Live telemetry continues below.';
  el.appendChild(msg);
}

export function rebuildForTheme(isDark: boolean): void {
  if (!scene || !renderer || !camera || !controls) return;
  const pos = camera.position.clone();
  const look = controls.target.clone();
  clearContent();
  applyLighting(isDark);
  buildContent(isDark);
  camera.position.copy(pos);
  controls.target.copy(look);
}

/* ---------------------------------------------------------------- world theme */

const WORLD_THEME_KEY = 'hq-wor…heme';

/** Read the persisted world theme before the first build. */
export function initWorldTheme(): void {
  setActiveTheme(window.localStorage.getItem(WORLD_THEME_KEY));
}

export function getWorldThemeId(): WorldThemeId {
  return activeTheme().id;
}

/**
 * Switch the whole estate to another world. Data, collision and layout stay
 * untouched; only how everything looks (and what surrounds it) changes.
 */
export function setWorldTheme(id: WorldThemeId): void {
  if (activeTheme().id === id) return;
  setActiveTheme(id);
  window.localStorage.setItem(WORLD_THEME_KEY, id);
  if (scene) rebuildForTheme(appState.officeDark);
}

export function setSceneActive(active: boolean): void {
  sceneActive = active;
  if (!active) hideHoverTooltip();
}

/* --------------------------------------------------------------------------
   Interaction / projection / loop
   -------------------------------------------------------------------------- */
/**
 * Resolve a raycast hit to its registered interactive root. Returns null for
 * anything decorative, so hover and click stay quiet on unimportant meshes.
 */
function resolveInspect(object: THREE.Object3D): {
  info: InspectInfo;
  node: THREE.Object3D;
  agentId?: AgentId;
} | null {
  let node: THREE.Object3D | null = object;
  while (node) {
    const id = node.userData['agentId'] as AgentId | undefined;
    if (id) {
      return {
        info: { label: AGENTS[id]?.name ?? id, kind: 'Agent' },
        node,
        agentId: id,
      };
    }
    const info = node.userData['inspect'] as InspectInfo | undefined;
    if (info) return { info, node };
    node = node.parent;
  }
  return null;
}

function updateMouse(e: { clientX: number; clientY: number }): void {
  if (!container) return;
  const rect = container.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

function raycastContent(): THREE.Intersection[] {
  if (!raycaster || !camera || interactiveRoots.length === 0) return [];
  raycaster.setFromCamera(mouse, camera);
  return raycaster.intersectObjects(interactiveRoots, true);
}

function hideHoverTooltip(): void {
  hoverTooltipEl?.classList.add('hidden');
}

function showHoverTooltip(label: string, e: { clientX: number; clientY: number }): void {
  if (!hoverTooltipEl || !container) return;
  const rect = container.getBoundingClientRect();
  const left = Math.max(8, Math.min(e.clientX - rect.left + 14, rect.width - 258));
  const top = Math.max(8, Math.min(e.clientY - rect.top + 14, rect.height - 36));
  hoverTooltipEl.style.left = `${left}px`;
  hoverTooltipEl.style.top = `${top}px`;
  hoverTooltipEl.textContent = label;
  hoverTooltipEl.classList.remove('hidden');
}

function clearInspectVisuals(): void {
  if (inspectHelper) {
    scene?.remove(inspectHelper);
    inspectHelper.geometry.dispose();
    inspectHelper.material.dispose();
    inspectHelper = null;
  }
  if (inspectPulse) {
    scene?.remove(inspectPulse);
    inspectPulse.geometry.dispose();
    inspectPulse.material.dispose();
    inspectPulse = null;
  }
}

function closeInspector(): void {
  inspectCardEl?.classList.add('hidden');
  inspectedObject = null;
  inspectedPreset = undefined;
  clearInspectVisuals();
}

function focusInspectedObject(): void {
  if (!inspectedObject || !camera || !controls) return;
  const box = new THREE.Box3().setFromObject(inspectedObject);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1);
  const distance = Math.min(90, Math.max(4.5, maxDim * 1.45));
  const direction = new THREE.Vector3(0.75, 0.55, 0.9).normalize();
  startTween(center.clone().add(direction.multiplyScalar(distance)), center, 800);
}

function showInspector(info: InspectInfo, node: THREE.Object3D): void {
  inspectedObject = node;
  inspectedPreset = info.preset;
  if (inspectKindEl) inspectKindEl.textContent = info.kind.toUpperCase();
  if (inspectTitleEl) inspectTitleEl.textContent = info.label;
  if (inspectDetailEl) {
    inspectDetailEl.textContent = info.detail ?? 'Klik Focus camera untuk mendekat.';
  }
  if (inspectPresetEl) {
    inspectPresetEl.classList.toggle('hidden', !info.preset);
  }
  inspectCardEl?.classList.remove('hidden');

  clearInspectVisuals();
  const box = new THREE.Box3().setFromObject(node);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim < 120) {
    inspectHelper = new THREE.BoxHelper(node, 0xfbbf24);
    const material = inspectHelper.material as THREE.LineBasicMaterial;
    material.depthTest = false;
    material.transparent = true;
    material.opacity = 0.9;
    inspectHelper.renderOrder = 999;
    scene?.add(inspectHelper);
  }
  const center = box.getCenter(new THREE.Vector3());
  const pulseMaterial = new THREE.MeshBasicMaterial({
    color: 0xfbbf24,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const pulse = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.05, 32), pulseMaterial);
  pulse.rotation.x = -Math.PI / 2;
  pulse.position.set(center.x, 0.07, center.z);
  pulse.renderOrder = 999;
  scene?.add(pulse);
  inspectPulse = pulse;
  inspectPulseStart = performance.now();
}

function bindInspectUI(): void {
  hoverTooltipEl = document.getElementById('hoverTooltip');
  inspectCardEl = document.getElementById('inspectCard');
  inspectKindEl = document.getElementById('inspectKind');
  inspectTitleEl = document.getElementById('inspectTitle');
  inspectDetailEl = document.getElementById('inspectDetail');
  inspectPresetEl = document.getElementById('inspectPreset') as HTMLButtonElement | null;
  const focusButton = document.getElementById('inspectFocus');
  const closeButton = document.getElementById('inspectClose');
  focusButton?.addEventListener('click', focusInspectedObject);
  closeButton?.addEventListener('click', closeInspector);
  inspectPresetEl?.addEventListener('click', () => {
    if (inspectedPreset) setCameraPreset(inspectedPreset);
  });
  inspectCardEl?.addEventListener('pointerenter', hideHoverTooltip);
  document.getElementById('quickDossier')?.addEventListener('pointerenter', hideHoverTooltip);
}

function onPointerDown(e: PointerEvent): void {
  pointerDownAt = { x: e.clientX, y: e.clientY };
  pointerDragged = false;
}

function onPointerUp(): void {
  pointerDownAt = null;
  window.setTimeout(() => {
    pointerDragged = false;
  }, 0);
}

function onPointerLeave(): void {
  pointerDownAt = null;
  hideHoverTooltip();
  if (container) container.style.cursor = 'grab';
}

function onPointerMove(e: PointerEvent): void {
  if (!container || !raycaster || !camera) return;
  updateMouse(e);
  if (
    pointerDownAt &&
    (e.buttons & 1) !== 0 &&
    Math.hypot(e.clientX - pointerDownAt.x, e.clientY - pointerDownAt.y) > 6
  ) {
    pointerDragged = true;
  }
  if (pointerDragged) {
    hideHoverTooltip();
    return;
  }
  const now = performance.now();
  if (now - lastHoverRay < 70) return;
  lastHoverRay = now;
  const hit = raycastContent()[0];
  const resolved = hit ? resolveInspect(hit.object) : null;
  if (!resolved) {
    hideHoverTooltip();
    container.style.cursor = 'grab';
    return;
  }
  container.style.cursor = 'pointer';
  const kind = resolved.agentId ? 'Agent' : resolved.info.kind;
  const tooltip = resolved.info.label.includes(kind)
    ? resolved.info.label
    : `${resolved.info.label} · ${kind}`;
  showHoverTooltip(tooltip, e);
}

function onCanvasClick(e: MouseEvent): void {
  if (pointerDragged) {
    pointerDragged = false;
    return;
  }
  ensureAudio();
  updateMouse(e);
  const hit = raycastContent()[0];
  const resolved = hit ? resolveInspect(hit.object) : null;
  if (!resolved) {
    closeInspector();
    return;
  }
  if (resolved.agentId) {
    closeInspector();
    selectAgent(resolved.agentId, true);
    playTypewriterTick();
    return;
  }
  showInspector(resolved.info, resolved.node);
  hideHoverTooltip();
  playTypewriterTick();
}

function selectAgent(id: AgentId, moveCamera: boolean): void {
  appState.selectedAgent = id;
  [...characterGroups, ...crowdGroups].forEach((g) => {
    const ring = g.userData['ring'] as THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> | undefined;
    if (ring) ring.material.opacity = g.userData['agentId'] === id ? 0.85 : 0;
  });
  if (moveCamera) focusCameraOnAgent(id);
  bus.emit('selection:change', id);
}

function bubbleVisible(ag: AgentDef): boolean {
  if (assignedPersonas.has(ag.id)) return true;
  return ag.id === appState.selectedAgent || ag.state === 'COFFEE' || ag.state === 'TV';
}

function updateSpeechProjection(): void {
  if (!container || !camera) return;
  const cam = camera;
  const w = container.clientWidth;
  const h = container.clientHeight;

  AGENT_IDS.forEach((id) => {
    const ag = AGENTS[id];
    const bubble = bubbleEls[id];
    if (!bubble || !ag.meshGroup) return;
    if (!ag.bubbleText || !bubbleVisible(ag)) {
      bubble.style.opacity = '0';
      return;
    }
    const head = ag.meshGroup.userData['headMesh'] as THREE.Object3D | undefined;
    if (head) {
      head.getWorldPosition(tempVec);
      tempVec.y += 0.7;
    } else {
      ag.meshGroup.getWorldPosition(tempVec);
      tempVec.y += 2.8;
    }
    tempVec.project(cam);
    if (tempVec.z > 1 || tempVec.z < -1) {
      bubble.style.opacity = '0';
      return;
    }
    const x = (tempVec.x * 0.5 + 0.5) * w;
    const y = (-tempVec.y * 0.5 + 0.5) * h;
    bubble.style.left = `${x}px`;
    bubble.style.top = `${y}px`;
    bubble.style.opacity = '1';

    const textEl = document.getElementById(`speechText-${id}`);
    if (textEl) textEl.textContent = ag.bubbleText;
  });
}

function animateCharacters(dt: number, time: number): void {
  characterGroups.forEach((g) => {
    const id = g.userData['agentId'] as AgentId;
    const ag = AGENTS[id];
    const p = pose.get(id);
    if (!p) return;

    g.position.x = p.x;
    g.position.z = p.z;
    g.rotation.y = p.rot;

    const roam = roamState.get(id);
    const walkSpeed = roam ? Math.hypot(roam.vx, roam.vz) : 0;
    const walking = ag.state === 'WALKING' || roam?.phase === 'walk';
    const typingMode = ag.state === 'TYPING' || ag.state === 'TESTING' || ag.state === 'PLANNING';
    const rig = g.userData['rig'] as CharacterRig | undefined;
    if (rig) {
      g.position.y = 0;
      updateCharacterRig(
        rig,
        dt,
        walking ? 'walk' : typingMode ? 'type' : 'idle',
        time,
        walkSpeed,
      );
      return;
    }

    const head = g.userData['headMesh'] as THREE.Mesh | undefined;
    if (head) head.position.y = 1.92 + Math.sin(time * 2.2 + ag.deskIndex) * 0.02;

    const leftArm = g.userData['leftArm'] as THREE.Mesh | undefined;
    const rightArm = g.userData['rightArm'] as THREE.Mesh | undefined;
    const legL = g.userData['legLeft'] as THREE.Mesh | undefined;
    const legR = g.userData['legRight'] as THREE.Mesh | undefined;

    if (walking) {
      g.position.y = Math.abs(Math.sin(time * 8 + ag.deskIndex)) * 0.045;
      if (leftArm && rightArm) {
        leftArm.rotation.x = Math.sin(time * 8) * 0.6;
        rightArm.rotation.x = -Math.sin(time * 8) * 0.6;
      }
      if (legL && legR) {
        legL.rotation.x = -Math.sin(time * 8) * 0.55;
        legR.rotation.x = Math.sin(time * 8) * 0.55;
        legL.position.y = 0.37;
        legR.position.y = 0.37;
      }
      return;
    }

    g.position.y = 0;
    if (legL && legR) {
      legL.rotation.x = 0;
      legR.rotation.x = 0;
    }

    if (leftArm && rightArm) {
      if (typingMode && !ag.ambient) {
        leftArm.rotation.x = -0.95 + Math.sin(time * 10 + ag.deskIndex) * 0.16;
        rightArm.rotation.x = -0.95 + Math.cos(time * 10 + ag.deskIndex) * 0.16;
      } else if (typingMode) {
        leftArm.rotation.x = -0.75 + Math.sin(time * 6 + ag.deskIndex) * 0.1;
        rightArm.rotation.x = -0.75 + Math.cos(time * 6 + ag.deskIndex) * 0.1;
      } else {
        leftArm.rotation.x = Math.sin(time * 1.6 + ag.deskIndex) * 0.06;
        rightArm.rotation.x = -Math.sin(time * 1.6 + ag.deskIndex) * 0.06;
      }
    }
  });
}

/**
 * Soft collision between all characters (agents, squad, visitors, staff) so
 * they queue and step around each other instead of standing inside one
 * another. Runs before the movement update each frame.
 */
function applySeparation(): void {
  const bodies: SeparationBody[] = [];
  AGENT_IDS.forEach((id) => {
    const p = pose.get(id);
    if (!p) return;
    bodies.push({ pose: p, radius: AGENT_RADIUS, movable: !assignedPersonas.has(id) });
  });
  crowdMembers.forEach((member) => {
    bodies.push({
      pose: member.pose,
      radius: CROWD_RADIUS,
      movable: !(member.status === 'running' && member.phase === 'work'),
    });
  });
  visitorStates.forEach((visitor) => {
    bodies.push({ pose: visitor.pose, radius: VISITOR_RADIUS, movable: true });
  });
  staffGroups.forEach((g) => {
    bodies.push({
      pose: { x: g.position.x, z: g.position.z, rot: 0 },
      radius: 0.42,
      movable: false,
    });
  });
  separateBodies(collisionWorld, bodies);
}

function loop(): void {
  window.requestAnimationFrame(loop);
  if (!sceneActive || !scene || !camera || !renderer || !controls) return;

  timer.update();
  const time = timer.getElapsed();
  const dt = Math.min(timer.getDelta(), 0.05);

  stepTween(performance.now());
  controls.update();

  applySeparation();
  updateRoaming(dt);
  animateCharacters(dt, time);
  animateCrowd(dt, time);
  animateStaff(dt, time);
  animateAnimals(dt, time);
  animateVisitors(dt, time);
  animateButterflies(time);
  animateShuttle(dt, time);
  updateSurroundings(dt, time);

  serverLeds.forEach((led) => {
    led.mesh.visible = Math.sin(time * led.rate) > 0.3;
  });
  steamParticles.forEach((p, i) => {
    p.position.y += 0.004;
    if (p.position.y > 3.25) p.position.y = 1.9 + (i % 8) * 0.02;
  });

  if (time - tvLastPaint > 0.4) {
    tvLastPaint = time;
    paintTvScreen(time);
  }

  if (balloonGroup) {
    balloonGroup.position.y = 18 + Math.sin(time * 0.4) * 0.8;
    balloonGroup.rotation.y = time * 0.05;
  }

  paintScreens();

  inspectHelper?.update();

  if (inspectPulse) {
    const age = (performance.now() - inspectPulseStart) / 1000;
    if (age > 1.25) {
      scene.remove(inspectPulse);
      inspectPulse.geometry.dispose();
      inspectPulse.material.dispose();
      inspectPulse = null;
    } else {
      const t = age / 1.25;
      inspectPulse.scale.setScalar(1 + t * 2.6);
      inspectPulse.material.opacity = 0.9 * (1 - t);
    }
  }

  updateSpeechProjection();
  renderer.render(scene, camera);
}

/* Bus wiring */
bus.on('focus:agent', (payload) => selectAgent(payload as AgentId, appState.autoFollow));
bus.on('selection:set', (payload) => selectAgent(payload as AgentId, true));

/* Live session ↔ agent assignment: session personas work at their desk,
   unassigned employees keep roaming the office. */
bus.on('sessions:update', (payload) => {
  const data = payload as { sessions: SessionSummary[] };
  const next = new Set(
    data.sessions.filter((s) => s.status === 'running').map((s) => s.persona),
  );

  next.forEach((id) => {
    if (assignedPersonas.has(id)) return;
    const ag = AGENTS[id];
    const desk = deskSpot(ag);
    const from = pose.get(id) ?? { x: desk.x, z: desk.z, rot: Math.PI };
    const path = collisionWorld.findPath({ x: from.x, z: from.z }, desk, AGENT_RADIUS);
    if (path.length === 0) {
      // No route (shouldn't happen): snap to the desk like before.
      pose.set(id, { x: desk.x, z: desk.z, rot: Math.PI });
      roamState.delete(id);
      return;
    }
    pose.set(id, from);
    roamState.set(id, {
      phase: 'walk',
      spot: 'desk',
      waypoints: path,
      targetRot: Math.PI,
      timer: 0,
      dest: { x: desk.x, z: desk.z },
      vx: 0,
      vz: 0,
      repath: 0,
      stuck: 0,
    });
    setMood(ag, 'WALKING', 'Heading back to my desk…');
  });

  assignedPersonas.forEach((id) => {
    if (next.has(id)) return;
    const ag = AGENTS[id];
    initRoamFor(ag);
  });

  assignedPersonas.clear();
  next.forEach((id) => assignedPersonas.add(id));

  syncCrowd();
});
