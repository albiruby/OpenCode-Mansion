import * as THREE from 'three';
import { activeTheme } from './themes';
import { buildAmazonRainforest, animateJungle, resetJungle } from './jungle';

/* --------------------------------------------------------------------------
   Surrounding world per theme

   Everything outside the campus bounds: clouds and floating islands, a neon
   megacity skyline, an ocean with beach and islands, a giant toybox, or open
   space with a planet. All instanced/merged for cheap draw calls; the forest
   theme keeps its own module (jungle.ts). Purely decorative.
   -------------------------------------------------------------------------- */

interface Anim {
  fn: (dt: number, time: number) => void;
}

const animators: Anim[] = [];
let rngState = 0x2545f491;

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

/** Distance from campus centre (30,0) — 0 at the lawn edge rings. */
function ringPoint(minR: number, maxR: number): { x: number; z: number } {
  const angle = rnd() * Math.PI * 2;
  const r = range(minR, maxR);
  return { x: 30 + Math.cos(angle) * r * 1.25, z: Math.sin(angle) * r };
}

function softRadialTexture(inner: string, outer: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(64, 64, 8, 64, 64, 62);
    grad.addColorStop(0, inner);
    grad.addColorStop(1, outer);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function addInstanced(
  root: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  transforms: { pos: [number, number, number]; scale?: [number, number, number]; rotY?: number; rotZ?: number; color?: THREE.Color }[],
  name: string,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
  const dummy = new THREE.Object3D();
  transforms.forEach((t, i) => {
    dummy.position.set(t.pos[0], t.pos[1], t.pos[2]);
    dummy.rotation.set(0, t.rotY ?? 0, t.rotZ ?? 0);
    dummy.scale.setScalar(1);
    if (t.scale) dummy.scale.set(t.scale[0], t.scale[1], t.scale[2]);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    if (t.color) mesh.setColorAt(i, t.color);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.name = name;
  root.add(mesh);
  return mesh;
}

/* ------------------------------------------------------------- floating */

function buildFloating(root: THREE.Group, isDark: boolean): void {
  // Cloud ocean under and around the estate.
  const cloudTex = softRadialTexture('rgba(248,250,255,0.95)', 'rgba(226,240,255,0)');
  for (let i = 0; i < 3; i++) {
    const cloud = new THREE.Mesh(
      new THREE.PlaneGeometry(760, 700),
      new THREE.MeshBasicMaterial({
        map: cloudTex,
        transparent: true,
        opacity: isDark ? 0.5 : 0.85,
        depthWrite: false,
      }),
    );
    cloud.rotation.x = -Math.PI / 2;
    cloud.position.set(30, -26 - i * 9, 0);
    root.add(cloud);
    const drift = i;
    animators.push({
      fn: (_dt, time) => {
        cloud.position.x = 30 + Math.sin(time * 0.05 + drift * 2.1) * 26;
        cloud.position.z = Math.cos(time * 0.04 + drift) * 22;
      },
    });
  }

  // Floating islands: grass-topped rock chunks with little trees.
  const islandGeo = (() => {
    const top = new THREE.CylinderGeometry(1, 1.15, 0.5, 8);
    const grass = new THREE.CylinderGeometry(1.15, 1.15, 0.16, 8);
    grass.translate(0, 0.3, 0);
    const rock = new THREE.ConeGeometry(1.1, 2.4, 8);
    rock.rotateX(Math.PI);
    rock.translate(0, -1.4, 0);
    return [top, grass, rock];
  })();
  const rockMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x3f3a5a : 0xa8a29e, roughness: 1 });
  const grassMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x1f4a3d : 0x7ade9b, roughness: 1 });
  const islandPlacements: { pos: [number, number, number]; scale: [number, number, number]; rotY: number }[] = [];
  const islandCount = 46;
  for (let i = 0; i < islandCount; i++) {
    const p = ringPoint(95, 330);
    const s = range(6, 26);
    islandPlacements.push({ pos: [p.x, range(-14, 48), p.z], scale: [s, s, s], rotY: rnd() * Math.PI * 2 });
  }
  islandGeo.forEach((g, gi) => {
    addInstanced(
      root,
      g,
      gi === 1 ? grassMat : rockMat,
      islandPlacements.map((p) => ({ ...p })),
      `float-island-${gi}`,
    );
  });

  // Pastel balloons drifting around the estate.
  const balloonMat = new THREE.MeshStandardMaterial({ roughness: 0.6 });
  const balloonGeo = new THREE.SphereGeometry(2.6, 10, 8);
  const basketGeo = new THREE.BoxGeometry(1.2, 0.9, 1.2);
  const basketMat = new THREE.MeshStandardMaterial({ color: 0xb45309, roughness: 1 });
  for (let i = 0; i < 5; i++) {
    const g = new THREE.Group();
    const balloon = new THREE.Mesh(balloonGeo, balloonMat.clone());
    (balloon.material as THREE.MeshStandardMaterial).color.setHSL(
      [0.9, 0.12, 0.35, 0.55, 0.75][i % 5] ?? 0.5,
      0.7,
      0.62,
    );
    balloon.scale.set(1, 1.25, 1);
    g.add(balloon);
    const basket = new THREE.Mesh(basketGeo, basketMat);
    basket.position.y = -4.4;
    g.add(basket);
    const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.6), basketMat);
    rope.position.y = -3.3;
    g.add(rope);
    g.position.set(30 + range(-140, 180), range(16, 46), range(-160, 160));
    root.add(g);
    const base = g.position.clone();
    const speed = range(0.05, 0.12);
    const phase = rnd() * Math.PI * 2;
    animators.push({
      fn: (_dt, time) => {
        g.position.x = base.x + Math.sin(time * speed + phase) * 34;
        g.position.z = base.z + Math.cos(time * speed * 0.8 + phase) * 26;
        g.position.y = base.y + Math.sin(time * 0.6 + phase) * 1.6;
      },
    });
  }
}

/* ------------------------------------------------------------- cyberpunk */

function buildCyberpunk(root: THREE.Group, isDark: boolean): void {
  // Neon-lit plate with glowing grid lines.
  const gridCanvas = document.createElement('canvas');
  gridCanvas.width = 256;
  gridCanvas.height = 256;
  const gctx = gridCanvas.getContext('2d');
  if (gctx) {
    gctx.fillStyle = '#0a0716';
    gctx.fillRect(0, 0, 256, 256);
    gctx.strokeStyle = isDark ? 'rgba(34,211,238,0.5)' : 'rgba(124,58,237,0.55)';
    gctx.lineWidth = 2;
    for (let i = 0; i <= 256; i += 32) {
      gctx.beginPath();
      gctx.moveTo(i, 0);
      gctx.lineTo(i, 256);
      gctx.stroke();
      gctx.beginPath();
      gctx.moveTo(0, i);
      gctx.lineTo(256, i);
      gctx.stroke();
    }
  }
  const gridTex = new THREE.CanvasTexture(gridCanvas);
  gridTex.wrapS = THREE.RepeatWrapping;
  gridTex.wrapT = THREE.RepeatWrapping;
  gridTex.repeat.set(34, 30);
  gridTex.colorSpace = THREE.SRGBColorSpace;
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(760, 700),
    new THREE.MeshBasicMaterial({ map: gridTex }),
  );
  plate.rotation.x = -Math.PI / 2;
  plate.position.set(30, -0.07, 0);
  root.add(plate);

  // Window texture for skyline towers.
  const winCanvas = document.createElement('canvas');
  winCanvas.width = 64;
  winCanvas.height = 128;
  const wctx = winCanvas.getContext('2d');
  if (wctx) {
    wctx.fillStyle = '#120f2e';
    wctx.fillRect(0, 0, 64, 128);
    for (let y = 6; y < 124; y += 10) {
      for (let x = 5; x < 60; x += 12) {
        const lit = Math.random() < 0.5;
        wctx.fillStyle = lit
          ? (['#22d3ee', '#e879f9', '#f59e0b', '#a3e635'][Math.floor(Math.random() * 4)] ?? '#22d3ee')
          : '#1c1742';
        wctx.fillRect(x, y, 7, 6);
      }
    }
  }
  const winTex = new THREE.CanvasTexture(winCanvas);
  winTex.colorSpace = THREE.SRGBColorSpace;
  const towerMat = new THREE.MeshBasicMaterial({ map: winTex });

  const towers: { pos: [number, number, number]; scale: [number, number, number]; color: THREE.Color }[] = [];
  for (let i = 0; i < 150; i++) {
    const p = ringPoint(90, 330);
    const h = range(16, 110);
    const w = range(5, 15);
    const c = new THREE.Color().setHSL(range(0.6, 0.85), 0.4, isDark ? range(0.14, 0.3) : range(0.2, 0.4));
    towers.push({ pos: [p.x, h / 2 - 1, p.z], scale: [w, h, w], color: c });
  }
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  unitBox.translate(0, 0.5, 0);
  addInstanced(root, unitBox, towerMat, towers, 'city-towers');

  // Neon billboards: thin glowing slabs floating near towers.
  const billboards: { pos: [number, number, number]; scale: [number, number, number]; rotY: number; color: THREE.Color }[] = [];
  for (let i = 0; i < 30; i++) {
    const p = ringPoint(95, 250);
    billboards.push({
      pos: [p.x, range(14, 60), p.z],
      scale: [range(8, 22), range(3, 7), 0.4],
      rotY: Math.atan2(p.x - 30, p.z) + range(-0.4, 0.4),
      color: new THREE.Color(['#22d3ee', '#e879f9', '#a3e635', '#f59e0b', '#60a5fa'][i % 5] ?? '#22d3ee'),
    });
  }
  const bbMesh = addInstanced(root, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), billboards, 'city-billboards');
  const flickerBase = billboards.map((b) => b.color.clone());
  animators.push({
    fn: (_dt, time) => {
      const m = new THREE.Matrix4();
      for (let i = 0; i < billboards.length; i++) {
        bbMesh.getMatrixAt(i, m);
        const blink = Math.sin(time * (2 + (i % 5)) + i * 1.7) > -0.85 ? 1 : 0.15;
        bbMesh.setColorAt(i, flickerBase[i]!.clone().multiplyScalar(blink));
      }
      if (bbMesh.instanceColor) bbMesh.instanceColor.needsUpdate = true;
    },
  });

  // Delivery drones circling with glowing eyes.
  const droneMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee });
  const drones: THREE.Group[] = [];
  for (let i = 0; i < 6; i++) {
    const d = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 2.4), new THREE.MeshStandardMaterial({ color: 0x0f172a, metalness: 0.7, roughness: 0.4 }));
    d.add(body);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.18, 6, 6), droneMat);
    eye.position.set(0, 0.1, 1.3);
    d.add(eye);
    d.position.set(30, range(20, 55), range(-120, 120));
    root.add(d);
    drones.push(d);
  }
  animators.push({
    fn: (dt, time) => {
      drones.forEach((d, i) => {
        const speed = 12 + i * 3;
        d.position.x += Math.cos(time * 0.12 + i) * speed * dt;
        d.position.z += Math.sin(time * 0.09 + i * 2) * speed * dt;
        if (d.position.x > 260) d.position.x = -180;
        if (d.position.x < -180) d.position.x = 260;
        if (d.position.z > 200) d.position.z = -200;
        if (d.position.z < -200) d.position.z = 200;
        d.rotation.y = Math.atan2(Math.sin(time * 0.09 + i * 2), Math.cos(time * 0.12 + i));
        d.position.y += Math.sin(time * 1.4 + i) * 0.012;
      });
    },
  });
}

/* ------------------------------------------------------------- tropical */

function buildTropical(root: THREE.Group, isDark: boolean): void {
  // Ocean out to the horizon.
  const ocean = new THREE.Mesh(
    new THREE.PlaneGeometry(900, 820),
    new THREE.MeshStandardMaterial({
      color: isDark ? 0x0a3a4a : 0x0a6c8a,
      roughness: 0.42,
      metalness: 0.1,
      transparent: true,
      opacity: 0.96,
    }),
  );
  ocean.rotation.x = -Math.PI / 2;
  ocean.position.set(30, -0.65, 0);
  root.add(ocean);

  // Sandy shallows ring blending lawn → beach → water.
  const shallow = new THREE.Mesh(
    new THREE.PlaneGeometry(560, 520),
    new THREE.MeshStandardMaterial({ color: isDark ? 0x0e5a63 : 0x18869c, roughness: 0.5, metalness: 0, transparent: true, opacity: 0.8 }),
  );
  shallow.rotation.x = -Math.PI / 2;
  shallow.position.set(30, -0.4, 0);
  root.add(shallow);
  const sand = new THREE.Mesh(
    new THREE.PlaneGeometry(360, 330),
    new THREE.MeshStandardMaterial({ color: isDark ? 0x6b5a3e : 0xc9a86f, roughness: 1 }),
  );
  sand.rotation.x = -Math.PI / 2;
  sand.position.set(30, -0.25, 0);
  root.add(sand);

  // Outer palm belt on the beach ring.
  const palmTrunk = new THREE.CylinderGeometry(0.14, 0.22, 4.6, 7);
  palmTrunk.translate(0, 2.3, 0);
  const palmLeaf = new THREE.ConeGeometry(0.5, 3, 4);
  palmLeaf.rotateX(Math.PI / 2 + 0.5);
  palmLeaf.translate(0.6, 4.6, 0.9);
  const trunkMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x4a3521 : 0x7c571f, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x14532d : 0x0f8e3f, roughness: 0.8, side: THREE.DoubleSide });
  const palmSpots: { pos: [number, number, number]; scale: [number, number, number]; rotY: number }[] = [];
  for (let i = 0; i < 40; i++) {
    const p = ringPoint(92, 190);
    palmSpots.push({ pos: [p.x, -0.2, p.z], scale: [1, range(0.8, 1.35), 1], rotY: rnd() * Math.PI * 2 });
  }
  addInstanced(root, palmTrunk, trunkMat, palmSpots, 'beach-palm-trunk');
  const leafTransforms: typeof palmSpots = [];
  palmSpots.forEach((s) => {
    for (let k = 0; k < 6; k++) {
      leafTransforms.push({ pos: s.pos, scale: s.scale, rotY: s.rotY + (k / 6) * Math.PI * 2 });
    }
  });
  addInstanced(root, palmLeaf, leafMat, leafTransforms, 'beach-palm-leaf');

  // Distant islands.
  const isleGeo = new THREE.ConeGeometry(1, 1, 9);
  isleGeo.translate(0, 0.5, 0);
  const isles: { pos: [number, number, number]; scale: [number, number, number]; color: THREE.Color }[] = [];
  for (let i = 0; i < 9; i++) {
    const p = ringPoint(260, 360);
    const h = range(10, 30);
    isles.push({
      pos: [p.x, -0.6, p.z],
      scale: [range(26, 60), h, range(20, 40)],
      color: new THREE.Color(isDark ? 0x0e2431 : 0x2f6b4f).offsetHSL(0, 0, range(-0.05, 0.05)),
    });
  }
  addInstanced(root, isleGeo, new THREE.MeshStandardMaterial({ roughness: 1 }), isles, 'distant-islands');

  // Sailboat bobbing offshore with wake drift.
  const boat = new THREE.Group();
  const hull = new THREE.Mesh(
    new THREE.BoxGeometry(3, 0.9, 6),
    new THREE.MeshStandardMaterial({ color: isDark ? 0x78350f : 0xcdb79e, roughness: 0.7 }),
  );
  hull.position.y = 0.2;
  boat.add(hull);
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.07, 4.6, 6),
    new THREE.MeshStandardMaterial({ color: 0x44403c }),
  );
  mast.position.y = 2.6;
  boat.add(mast);
  const sail = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 3.4),
    new THREE.MeshStandardMaterial({ color: 0xf8fafc, side: THREE.DoubleSide, roughness: 0.85 }),
  );
  sail.position.set(1, 2.7, 0);
  boat.add(sail);
  boat.position.set(64, -0.4, 150);
  root.add(boat);
  animators.push({
    fn: (_dt, time) => {
      boat.position.y = -0.4 + Math.sin(time * 1.1) * 0.16;
      boat.rotation.z = Math.sin(time * 0.9) * 0.05;
      boat.rotation.y = Math.sin(time * 0.13) * 0.25;
      const om = ocean.material as THREE.MeshStandardMaterial;
      om.roughness = 0.4 + Math.sin(time * 0.5) * 0.05;
    },
  });
}

/* ------------------------------------------------------------- toybox */

function buildToybox(root: THREE.Group, isDark: boolean): void {
  // Big playmat ground.
  const mat = new THREE.Mesh(
    new THREE.PlaneGeometry(760, 700),
    new THREE.MeshStandardMaterial({ color: isDark ? 0x1a1140 : 0xf3e3bb, roughness: 1 }),
  );
  mat.rotation.x = -Math.PI / 2;
  mat.position.set(30, -0.08, 0);
  root.add(mat);
  // Polka dots on the mat.
  const dots: { pos: [number, number, number]; scale: [number, number, number]; color: THREE.Color }[] = [];
  for (let i = 0; i < 70; i++) {
    const p = ringPoint(60, 320);
    dots.push({
      pos: [p.x, 0, p.z],
      scale: [range(3, 9), range(3, 9), 1],
      color: new THREE.Color(['#fca5a5', '#fcd34d', '#93c5fd', '#86efac', '#f0abfc'][i % 5] ?? '#fca5a5'),
    });
  }
  const dotGeo = new THREE.CircleGeometry(1, 12);
  dotGeo.rotateX(-Math.PI / 2);
  addInstanced(root, dotGeo, new THREE.MeshBasicMaterial(), dots, 'toy-mat-dots');

  // Giant building blocks, some stacked.
  const blockMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
  const blocks: { pos: [number, number, number]; scale: [number, number, number]; rotY: number; color: THREE.Color }[] = [];
  const candy = ['#ef4444', '#f59e0b', '#facc15', '#22c55e', '#3b82f6', '#a855f7', '#f472b6'];
  for (let i = 0; i < 150; i++) {
    const p = ringPoint(75, 300);
    const size = range(4, 16);
    const stack = 1 + Math.floor(rnd() * 3);
    for (let s = 0; s < stack; s++) {
      blocks.push({
        pos: [p.x + range(-1.5, 1.5), size / 2 + s * size, p.z + range(-1.5, 1.5)],
        scale: [size, size, size],
        rotY: rnd() * Math.PI * 2,
        color: new THREE.Color(candy[Math.floor(rnd() * candy.length)] ?? '#ef4444'),
      });
    }
  }
  addInstanced(root, new THREE.BoxGeometry(1, 1, 1), blockMat, blocks, 'toy-blocks');

  // Marbles.
  const marbles: { pos: [number, number, number]; scale: [number, number, number]; color: THREE.Color }[] = [];
  for (let i = 0; i < 22; i++) {
    const p = ringPoint(80, 290);
    const r = range(1.6, 5);
    marbles.push({
      pos: [p.x, r * 0.9, p.z],
      scale: [r, r, r],
      color: new THREE.Color(candy[Math.floor(rnd() * candy.length)] ?? '#38bdf8').offsetHSL(0, 0.1, 0.15),
    });
  }
  addInstanced(
    root,
    new THREE.SphereGeometry(1, 14, 10),
    new THREE.MeshStandardMaterial({ roughness: 0.15, metalness: 0.35 }),
    marbles,
    'toy-marbles',
  );

  // Crayons lying around.
  const crayonBody = new THREE.CylinderGeometry(0.7, 0.7, 9, 8);
  const crayonTip = new THREE.ConeGeometry(0.7, 1.8, 8);
  const crayonMat = new THREE.MeshStandardMaterial({ roughness: 0.7 });
  for (let i = 0; i < 12; i++) {
    const p = ringPoint(85, 280);
    const g = new THREE.Group();
    const body = new THREE.Mesh(crayonBody, (crayonMat as THREE.MeshStandardMaterial).clone());
    (body.material as THREE.MeshStandardMaterial).color.set(
      candy[Math.floor(rnd() * candy.length)] ?? '#ef4444',
    );
    g.add(body);
    const tip = new THREE.Mesh(crayonTip, body.material as THREE.Material);
    tip.position.y = 5.4;
    g.add(tip);
    g.position.set(p.x, 0.8, p.z);
    g.rotation.z = Math.PI / 2 + range(-0.12, 0.12);
    g.rotation.y = rnd() * Math.PI * 2;
    root.add(g);
  }

  // Confetti drifting down.
  const count = 160;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const speeds = new Float32Array(count);
  const tmpColor = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const p = ringPoint(40, 280);
    positions[i * 3] = p.x;
    positions[i * 3 + 1] = range(4, 70);
    positions[i * 3 + 2] = p.z;
    tmpColor.set(candy[i % candy.length] ?? '#f472b6');
    colors[i * 3] = tmpColor.r;
    colors[i * 3 + 1] = tmpColor.g;
    colors[i * 3 + 2] = tmpColor.b;
    speeds[i] = range(0.6, 1.8);
  }
  const confettiGeo = new THREE.BufferGeometry();
  confettiGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  confettiGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const confetti = new THREE.Points(
    confettiGeo,
    new THREE.PointsMaterial({ size: 0.5, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false }),
  );
  root.add(confetti);
  animators.push({
    fn: (dt) => {
      const attr = confetti.geometry.attributes['position'] as THREE.BufferAttribute;
      for (let i = 0; i < attr.count; i++) {
        let y = attr.getY(i) - speeds[i]! * dt * 4;
        if (y < 0.2) y = 64;
        attr.setY(i, y);
        attr.setX(i, attr.getX(i) + Math.sin((y + i) * 0.35) * dt * 0.9);
      }
      attr.needsUpdate = true;
    },
  });
}

/* ------------------------------------------------------------- space */

function buildSpace(root: THREE.Group, isDark: boolean): void {
  // Starfield shell.
  const count = 1100;
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const theta = rnd() * Math.PI * 2;
    const phi = Math.acos(range(-1, 1));
    const r = range(240, 560);
    positions[i * 3] = 30 + r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi) * (rnd() < 0.55 ? 1 : 0.4) + 60;
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    sizes[i] = range(0.6, 2.2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const stars = new THREE.Points(
    geo,
    new THREE.PointsMaterial({
      color: 0xe8f2ff,
      size: 1.7,
      sizeAttenuation: true,
      transparent: true,
      opacity: isDark ? 1 : 0.75,
      depthWrite: false,
    }),
  );
  root.add(stars);

  // Home planet with rings, seen from orbit.
  const planetCanvas = document.createElement('canvas');
  planetCanvas.width = 256;
  planetCanvas.height = 128;
  const pctx = planetCanvas.getContext('2d');
  if (pctx) {
    pctx.fillStyle = '#1d4e89';
    pctx.fillRect(0, 0, 256, 128);
    for (let i = 0; i < 26; i++) {
      pctx.fillStyle = ['#2c6e49', '#3a7ca5', '#74a5df', '#1b4332'][i % 4] ?? '#2c6e49';
      pctx.beginPath();
      pctx.ellipse(range(0, 256), range(0, 128), range(14, 48), range(6, 22), rnd(), 0, Math.PI * 2);
      pctx.fill();
    }
    for (let i = 0; i < 14; i++) {
      pctx.fillStyle = 'rgba(255,255,255,0.28)';
      pctx.beginPath();
      pctx.ellipse(range(0, 256), range(0, 128), range(16, 40), range(3, 8), 0, 0, Math.PI * 2);
      pctx.fill();
    }
  }
  const planetTex = new THREE.CanvasTexture(planetCanvas);
  planetTex.colorSpace = THREE.SRGBColorSpace;
  const planet = new THREE.Mesh(
    new THREE.SphereGeometry(170, 32, 20),
    new THREE.MeshStandardMaterial({ map: planetTex, roughness: 0.9, metalness: 0, emissive: 0x0a2540, emissiveIntensity: 0.25 }),
  );
  planet.position.set(-330, -190, -520);
  root.add(planet);
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(178, 32, 20),
    new THREE.MeshBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.12, side: THREE.BackSide }),
  );
  atmosphere.position.copy(planet.position);
  root.add(atmosphere);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(255, 14, 2, 64),
    new THREE.MeshStandardMaterial({ color: 0xb08968, roughness: 0.9, transparent: true, opacity: 0.65 }),
  );
  ring.position.copy(planet.position);
  ring.rotation.x = 1.15;
  root.add(ring);

  // Moon.
  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(26, 20, 14),
    new THREE.MeshStandardMaterial({ color: 0xa8a29e, roughness: 1, emissive: 0x334155, emissiveIntensity: 0.15 }),
  );
  moon.position.set(290, 150, -320);
  root.add(moon);

  // Structural orbital rings around the estate.
  const deckMat = new THREE.MeshStandardMaterial({ color: isDark ? 0x1e293b : 0x94a3b8, metalness: 0.8, roughness: 0.35 });
  const ringA = new THREE.Mesh(new THREE.TorusGeometry(250, 2.2, 3, 90), deckMat);
  ringA.position.set(30, -14, 0);
  ringA.rotation.x = Math.PI / 2 - 0.24;
  root.add(ringA);
  const ringB = new THREE.Mesh(new THREE.TorusGeometry(210, 1.6, 3, 90), deckMat);
  ringB.position.set(30, 26, 0);
  ringB.rotation.x = Math.PI / 2 + 0.18;
  root.add(ringB);
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
  const beacons: THREE.Mesh[] = [];
  for (let i = 0; i < 10; i++) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(1.4, 6, 6), beaconMat);
    const a = (i / 10) * Math.PI * 2;
    b.position.set(30 + Math.cos(a) * 250, -14 + Math.sin(a) * 250 * 0.24, Math.sin(a) * 250);
    root.add(b);
    beacons.push(b);
  }
  animators.push({
    fn: (dt, time) => {
      ringA.rotation.z += dt * 0.01;
      ringB.rotation.z -= dt * 0.014;
      planet.rotation.y += dt * 0.006;
      beacons.forEach((b, i) => {
        (b.material as THREE.MeshBasicMaterial).color.setScalar(0.55 + Math.sin(time * 2 + i) * 0.45);
      });
    },
  });
}

/* ------------------------------------------------------------- router */

export function buildSurroundings(root: THREE.Group, isDark: boolean): void {
  resetSurroundings();
  rngState = 0x2545f491 ^ (isDark ? 0x11 : 0x77);
  const theme = activeTheme();
  switch (theme.id) {
    case 'forest':
      buildAmazonRainforest(root, isDark);
      break;
    case 'floating':
      buildFloating(root, isDark);
      break;
    case 'cyberpunk':
      buildCyberpunk(root, isDark);
      break;
    case 'tropical':
      buildTropical(root, isDark);
      break;
    case 'toybox':
      buildToybox(root, isDark);
      break;
    case 'space':
      buildSpace(root, isDark);
      break;
  }
}

export function updateSurroundings(dt: number, time: number): void {
  if (activeTheme().jungle) animateJungle(dt, time);
  for (const a of animators) a.fn(dt, time);
}

export function resetSurroundings(): void {
  animators.length = 0;
  resetJungle();
}
