import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console] ${m.text()}`.slice(0, 300));
});

await page.goto('http://localhost:5180/', { waitUntil: 'networkidle' });
await page.waitForTimeout(6500);

const report = await page.evaluate(() => {
  const physics = window.__hqPhysics;
  if (!physics) return { missing: true };
  const world = physics.world;

  const checks = [];
  const assertPath = (name, from, to) => {
    const path = world.findPath(from, to, 0.32);
    const ok = path.length > 0;
    let clean = ok;
    let cursor = from;
    for (const node of ok ? [...path] : []) {
      if (!world.isFree(node.x, node.z, 0.3)) clean = false;
      const steps = Math.max(2, Math.ceil(Math.hypot(node.x - cursor.x, node.z - cursor.z) / 0.12));
      for (let i = 0; i <= steps; i++) {
        const x = cursor.x + ((node.x - cursor.x) * i) / steps;
        const z = cursor.z + ((node.z - cursor.z) * i) / steps;
        if (!world.isFree(x, z, 0.2)) clean = false;
      }
      cursor = node;
    }
    checks.push({ name, ok, clean, nodes: path.length });
  };

  assertPath('office -> lounge TV spot', { x: 4, z: 2 }, { x: 19.6, z: 7.4 });
  assertPath('office -> server room', { x: 4, z: -4 }, { x: 15.2, z: -9.6 });
  assertPath('office -> pantry coffee', { x: -10, z: 2 }, { x: -16.4, z: 8.5 });
  assertPath('desk -> pool deck', { x: -11, z: -4.05 }, { x: 76, z: 31.5 });
  assertPath('desk -> padel', { x: -5, z: -5.05 }, { x: 33.4, z: -7 });
  assertPath('desk -> gym', { x: 1, z: -5.05 }, { x: 47, z: 33 });
  assertPath('desk -> village crowd spot', { x: 7, z: -0.05 }, { x: 68, z: 48 });
  assertPath('desk -> squad loft west', { x: -17, z: -5.05 }, { x: -31, z: 2 });

  return {
    obstacles: world.obstacleCount,
    blockedCells: world.blockedCells,
    checks,
    wallBlocked: !world.lineFree(19, 1.5, 19, 7, 0.32),
    doorOpen: world.lineFree(15.8, 1.5, 15.8, 7, 0.32),
    poolBlocked: !world.lineFree(80, 2, 80, 20, 0.32),
  };
});

// Track every body for ~14 s: nobody may sit inside an obstacle, and the
// shuttle must stay in its lane while its speed remains continuous.
const track = await page.evaluate(async () => {
  const physics = window.__hqPhysics;
  if (!physics) return { missing: true };
  const world = physics.world;
  let inside = 0;
  let minPair = Infinity;
  let shuttleOffLane = 0;
  let frames = 0;
  let prevShuttleZ = null;
  let maxShuttleJump = 0;
  const deadline = performance.now() + 14000;
  while (performance.now() < deadline) {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    frames++;
    const bodies = physics.bodies();
    const walkers = bodies.slice(0, -1);
    const shuttle = bodies[bodies.length - 1];
    for (const b of walkers) {
      if (!world.isFree(b.x, b.z, 0.24)) inside++;
    }
    for (let i = 0; i < walkers.length; i++) {
      for (let j = i + 1; j < walkers.length; j++) {
        const d = Math.hypot(walkers[i].x - walkers[j].x, walkers[i].z - walkers[j].z);
        if (d < minPair) minPair = d;
      }
    }
    if (shuttle) {
      if (Math.abs(shuttle.x - 32.4) > 2.6 && Math.abs(shuttle.x - 27.4) > 2.6) shuttleOffLane++;
      if (prevShuttleZ !== null) {
        maxShuttleJump = Math.max(maxShuttleJump, Math.abs(shuttle.z - prevShuttleZ));
      }
      prevShuttleZ = shuttle.z;
    }
  }
  return { frames, inside, minPair: +minPair.toFixed(2), shuttleOffLane, maxShuttleJump: +maxShuttleJump.toFixed(2) };
});

console.log(JSON.stringify({ report, track, errors }, null, 2));
await browser.close();
