/**
 * Lightweight 2D collision + navigation for the campus.
 *
 * Characters move on the ground plane, so every obstacle is a rotated box on
 * X/Z. A coarse occupancy grid (expanded by the character radius) powers A*,
 * while a circle-vs-box resolver keeps bodies out of walls and furniture with
 * sliding instead of hard stops.
 */

export interface Point {
  x: number;
  z: number;
}

export interface WorldBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface Box {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  cos: number;
  sin: number;
}

export interface Body {
  x: number;
  z: number;
  rot: number;
  vx: number;
  vz: number;
}

export interface MoveOptions {
  speed: number;
  accel?: number;
  decel?: number;
  radius?: number;
  arriveRadius?: number;
  turnRate?: number;
}

export interface StepResult {
  arrived: boolean;
  moving: boolean;
  blocked: boolean;
}

export interface SeparationBody {
  pose: { x: number; z: number; rot: number };
  radius: number;
  movable: boolean;
}

const SQRT2 = Math.SQRT2;

function makeBox(cx: number, cz: number, w: number, d: number, rot: number): Box {
  return {
    cx,
    cz,
    hx: Math.abs(w) / 2,
    hz: Math.abs(d) / 2,
    cos: Math.cos(rot),
    sin: Math.sin(rot),
  };
}

/** Local-space coordinates of a world point relative to a rotated box. */
function localPoint(box: Box, x: number, z: number): { x: number; z: number } {
  const dx = x - box.cx;
  const dz = z - box.cz;
  return {
    x: dx * box.cos + dz * box.sin,
    z: -dx * box.sin + dz * box.cos,
  };
}

function localToWorld(box: Box, x: number, z: number): { x: number; z: number } {
  return {
    x: box.cx + x * box.cos - z * box.sin,
    z: box.cz + x * box.sin + z * box.cos,
  };
}

/** Circle vs rotated box. Returns the push needed to separate, or null. */
function pushOut(box: Box, x: number, z: number, radius: number): { x: number; z: number } | null {
  const p = localPoint(box, x, z);
  const clampedX = Math.max(-box.hx, Math.min(box.hx, p.x));
  const clampedZ = Math.max(-box.hz, Math.min(box.hz, p.z));
  const inside = Math.abs(p.x) < box.hx && Math.abs(p.z) < box.hz;

  if (!inside) {
    const dx = p.x - clampedX;
    const dz = p.z - clampedZ;
    const distSq = dx * dx + dz * dz;
    if (distSq >= radius * radius) return null;
    const dist = Math.sqrt(distSq);
    if (dist < 1e-6) return null;
    const nx = dx / dist;
    const nz = dz / dist;
    const push = radius - dist;
    return localToWorld(box, nx * push, nz * push);
  }

  // Deep inside: exit through the nearest face.
  const penX = box.hx - Math.abs(p.x) + radius;
  const penZ = box.hz - Math.abs(p.z) + radius;
  if (penX < penZ) {
    return localToWorld(box, Math.sign(p.x || 1) * penX, 0);
  }
  return localToWorld(box, 0, Math.sign(p.z || 1) * penZ);
}

export class CollisionWorld {
  readonly bounds: WorldBounds;
  readonly cell: number;
  private boxes: Box[] = [];
  private dynamicBoxes: Box[] = [];
  private cols: number;
  private rows: number;
  private grid: Uint8Array;
  private built = false;
  private buildRadius = 0.32;

  // Reused A* buffers. `stamp` avoids clearing ~100k cells per request.
  private stamp: Int32Array;
  private gScore: Float32Array;
  private fScore: Float32Array;
  private cameFrom: Int32Array;
  private closed: Int32Array;
  private generation = 0;

  constructor(bounds: WorldBounds, cell = 0.5) {
    this.bounds = bounds;
    this.cell = cell;
    this.cols = Math.ceil((bounds.maxX - bounds.minX) / cell);
    this.rows = Math.ceil((bounds.maxZ - bounds.minZ) / cell);
    const cells = this.cols * this.rows;
    this.grid = new Uint8Array(cells);
    this.stamp = new Int32Array(cells);
    this.gScore = new Float32Array(cells);
    this.fScore = new Float32Array(cells);
    this.cameFrom = new Int32Array(cells);
    this.closed = new Int32Array(cells);
  }

  clear(): void {
    this.boxes.length = 0;
    this.dynamicBoxes.length = 0;
    this.grid.fill(0);
    this.built = false;
  }

  addBox(cx: number, cz: number, w: number, d: number, rot = 0): void {
    this.boxes.push(makeBox(cx, cz, w, d, rot));
    this.built = false;
  }

  addCircle(cx: number, cz: number, radius: number): void {
    this.addBox(cx, cz, radius * 2, radius * 2);
  }

  setDynamic(boxes: { cx: number; cz: number; w: number; d: number; rot?: number }[]): void {
    this.dynamicBoxes = boxes.map((b) => makeBox(b.cx, b.cz, b.w, b.d, b.rot ?? 0));
  }

  get obstacleCount(): number {
    return this.boxes.length;
  }

  get blockedCells(): number {
    let count = 0;
    for (let i = 0; i < this.grid.length; i++) if (this.grid[i]) count++;
    return count;
  }

  build(radius = 0.32): void {
    this.buildRadius = radius;
    this.grid.fill(0);
    for (const box of this.boxes) this.rasterize(box, radius);
    this.built = true;
  }

  private rasterize(box: Box, radius: number): void {
    const extentX = Math.abs(box.hx * box.cos) + Math.abs(box.hz * box.sin) + radius;
    const extentZ = Math.abs(box.hx * box.sin) + Math.abs(box.hz * box.cos) + radius;
    const minCol = Math.max(0, Math.floor((box.cx - extentX - this.bounds.minX) / this.cell));
    const maxCol = Math.min(
      this.cols - 1,
      Math.floor((box.cx + extentX - this.bounds.minX) / this.cell),
    );
    const minRow = Math.max(0, Math.floor((box.cz - extentZ - this.bounds.minZ) / this.cell));
    const maxRow = Math.min(
      this.rows - 1,
      Math.floor((box.cz + extentZ - this.bounds.minZ) / this.cell),
    );
    for (let row = minRow; row <= maxRow; row++) {
      const z = this.bounds.minZ + (row + 0.5) * this.cell;
      for (let col = minCol; col <= maxCol; col++) {
        const x = this.bounds.minX + (col + 0.5) * this.cell;
        const p = localPoint(box, x, z);
        if (Math.abs(p.x) <= box.hx + radius && Math.abs(p.z) <= box.hz + radius) {
          this.grid[row * this.cols + col] = 1;
        }
      }
    }
  }

  /** Free space check against every static and dynamic box. */
  isFree(x: number, z: number, radius = this.buildRadius): boolean {
    if (
      x < this.bounds.minX + radius ||
      x > this.bounds.maxX - radius ||
      z < this.bounds.minZ + radius ||
      z > this.bounds.maxZ - radius
    ) {
      return false;
    }
    for (const box of this.boxes) {
      if (pushOut(box, x, z, radius)) return false;
    }
    for (const box of this.dynamicBoxes) {
      if (pushOut(box, x, z, radius)) return false;
    }
    return true;
  }

  /** Push a circle out of obstacles. Returns the corrected position. */
  resolve(x: number, z: number, radius = this.buildRadius): { x: number; z: number; hit: boolean } {
    let px = x;
    let pz = z;
    let hit = false;
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      const test = (box: Box): void => {
        const push = pushOut(box, px, pz, radius);
        if (!push) return;
        px += push.x;
        pz += push.z;
        moved = true;
        hit = true;
      };
      for (const box of this.boxes) test(box);
      for (const box of this.dynamicBoxes) test(box);
      if (!moved) break;
    }
    const margin = radius + 0.02;
    px = Math.max(this.bounds.minX + margin, Math.min(this.bounds.maxX - margin, px));
    pz = Math.max(this.bounds.minZ + margin, Math.min(this.bounds.maxZ - margin, pz));
    return { x: px, z: pz, hit };
  }

  private cellIndex(x: number, z: number): number {
    const col = Math.floor((x - this.bounds.minX) / this.cell);
    const row = Math.floor((z - this.bounds.minZ) / this.cell);
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return -1;
    return row * this.cols + col;
  }

  private cellCenter(index: number): Point {
    const row = Math.floor(index / this.cols);
    const col = index % this.cols;
    return {
      x: this.bounds.minX + (col + 0.5) * this.cell,
      z: this.bounds.minZ + (row + 0.5) * this.cell,
    };
  }

  private isGridFree(index: number): boolean {
    return index >= 0 && this.grid[index] === 0;
  }

  /** Straight-line walkability, sampled against the expanded grid. */
  lineFree(ax: number, az: number, bx: number, bz: number, radius = this.buildRadius): boolean {
    const dx = bx - ax;
    const dz = bz - az;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-6) return this.isFree(bx, bz, radius);
    // When the radius differs from the baked grid, fall back to exact boxes.
    if (Math.abs(radius - this.buildRadius) > 1e-4 || !this.built) {
      const steps = Math.max(2, Math.ceil(dist / 0.2));
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        if (!this.isFree(ax + dx * t, az + dz * t, radius)) return false;
      }
      return true;
    }
    const steps = Math.max(2, Math.ceil(dist / (this.cell * 0.7)));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const index = this.cellIndex(ax + dx * t, az + dz * t);
      if (!this.isGridFree(index)) return false;
    }
    return true;
  }

  /**
   * Exact box walkability used to validate smoothed shortcut legs. The A* grid
   * is coarser than the character radius, so a leg can look clear on the grid
   * yet still graze a corner; `resolve()` uses exact boxes, so we must too.
   */
  lineFreeExact(ax: number, az: number, bx: number, bz: number, radius = this.buildRadius): boolean {
    const dx = bx - ax;
    const dz = bz - az;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-6) return this.isFree(bx, bz, radius);
    const steps = Math.max(2, Math.ceil(dist / (radius * 0.6)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (!this.isFree(ax + dx * t, az + dz * t, radius)) return false;
    }
    return true;
  }

  private nearestFreeCell(x: number, z: number): number {
    const index = this.cellIndex(x, z);
    if (this.isGridFree(index)) return index;
    const maxRing = Math.ceil(2.2 / this.cell);
    const baseCol = Math.floor((x - this.bounds.minX) / this.cell);
    const baseRow = Math.floor((z - this.bounds.minZ) / this.cell);
    for (let ring = 1; ring <= maxRing; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;
          const col = baseCol + dx;
          const row = baseRow + dz;
          if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) continue;
          const candidate = row * this.cols + col;
          if (this.isGridFree(candidate)) return candidate;
        }
      }
    }
    return -1;
  }

  /**
   * A* over the occupancy grid with octile movement, no corner cutting and a
   * line-of-sight string pull. Returns an empty array when no route exists.
   */
  findPath(from: Point, to: Point, radius = this.buildRadius): Point[] {
    if (!this.built) this.build(radius);
    if (this.lineFreeExact(from.x, from.z, to.x, to.z, radius)) {
      return [{ x: to.x, z: to.z }];
    }

    const start = this.nearestFreeCell(from.x, from.z);
    const goal = this.nearestFreeCell(to.x, to.z);
    if (start < 0 || goal < 0) return [];
    if (start === goal) {
      const p = this.cellCenter(goal);
      return [{ x: p.x, z: p.z }];
    }

    const gen = ++this.generation;
    const heap: number[] = [];
    const g = this.gScore;
    const f = this.fScore;
    const stamp = this.stamp;
    const cameFrom = this.cameFrom;
    const closed = this.closed;

    const push = (node: number): void => {
      heap.push(node);
      let i = heap.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if ((f[heap[parent]!] ?? Infinity) <= (f[heap[i]!] ?? Infinity)) break;
        [heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
        i = parent;
      }
    };
    const pop = (): number => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const left = i * 2 + 1;
          const right = left + 1;
          let smallest = i;
          if (left < heap.length && (f[heap[left]!] ?? Infinity) < (f[heap[smallest]!] ?? Infinity)) {
            smallest = left;
          }
          if (
            right < heap.length &&
            (f[heap[right]!] ?? Infinity) < (f[heap[smallest]!] ?? Infinity)
          ) {
            smallest = right;
          }
          if (smallest === i) break;
          [heap[i], heap[smallest]] = [heap[smallest]!, heap[i]!];
          i = smallest;
        }
      }
      return top;
    };

    const goalPoint = this.cellCenter(goal);
    const heuristic = (node: number): number => {
      const p = this.cellCenter(node);
      const dx = Math.abs(p.x - goalPoint.x) / this.cell;
      const dz = Math.abs(p.z - goalPoint.z) / this.cell;
      return dx + dz + (SQRT2 - 2) * Math.min(dx, dz);
    };

    stamp[start] = gen;
    g[start] = 0;
    f[start] = heuristic(start);
    cameFrom[start] = -1;
    closed[start] = 0;
    push(start);

    let found = false;
    let guard = 0;
    const maxNodes = this.cols * this.rows;
    while (heap.length > 0 && guard++ < maxNodes) {
      const current = pop();
      if (current === goal) {
        found = true;
        break;
      }
      if (closed[current] === gen) continue;
      closed[current] = gen;

      const row = Math.floor(current / this.cols);
      const col = current % this.cols;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nCol = col + dx;
          const nRow = row + dz;
          if (nCol < 0 || nCol >= this.cols || nRow < 0 || nRow >= this.rows) continue;
          const neighbor = nRow * this.cols + nCol;
          if (!this.isGridFree(neighbor)) continue;
          // Diagonal moves must not squeeze through a wall corner.
          if (dx !== 0 && dz !== 0) {
            if (!this.isGridFree(row * this.cols + nCol)) continue;
            if (!this.isGridFree(nRow * this.cols + col)) continue;
          }
          if (closed[neighbor] === gen) continue;
          const stepCost = dx !== 0 && dz !== 0 ? SQRT2 : 1;
          const tentative = (stamp[current] === gen ? g[current]! : Infinity) + stepCost;
          if (stamp[neighbor] !== gen || tentative < g[neighbor]!) {
            stamp[neighbor] = gen;
            g[neighbor] = tentative;
            f[neighbor] = tentative + heuristic(neighbor);
            cameFrom[neighbor] = current;
            closed[neighbor] = 0;
            push(neighbor);
          }
        }
      }
    }

    if (!found) return [];

    const cells: Point[] = [];
    let node = goal;
    let guard2 = 0;
    while (node !== start && node >= 0 && guard2++ < maxNodes) {
      cells.push(this.cellCenter(node));
      node = cameFrom[node]!;
    }
    cells.push({ x: from.x, z: from.z });
    cells.reverse();
    cells.push({ x: to.x, z: to.z });

    // String pull with the exact box test: a shortcut is only kept if a
    // character of this radius can truly walk it. Grid `lineFree` is coarser
    // than the radius and produces corner-grazing legs, so we validate every
    // candidate leg exactly. Blocked candidates fail fast (few samples), so
    // the only real cost is the accepted long legs, proportional to length.
    const out: Point[] = [];
    let cursor = 0;
    let guard3 = 0;
    while (cursor < cells.length - 1 && guard3++ < 512) {
      let furthest = cursor + 1;
      for (let j = cells.length - 1; j > cursor + 1; j--) {
        if (
          this.lineFreeExact(
            cells[cursor]!.x,
            cells[cursor]!.z,
            cells[j]!.x,
            cells[j]!.z,
            radius,
          )
        ) {
          furthest = j;
          break;
        }
      }
      out.push(cells[furthest]!);
      cursor = furthest;
    }
    return out;
  }
}

function angleDelta(target: number, current: number): number {
  return Math.atan2(Math.sin(target - current), Math.cos(target - current));
}

function moveTowards(value: number, target: number, maxDelta: number): number {
  if (Math.abs(target - value) <= maxDelta) return target;
  return value + Math.sign(target - value) * maxDelta;
}

/**
 * Velocity-based steering: accelerate toward the waypoint, brake on approach,
 * integrate in small substeps and slide along whatever the world pushes back.
 */
export function stepBody(
  world: CollisionWorld,
  body: Body,
  target: Point,
  dt: number,
  options: MoveOptions,
): StepResult {
  const speed = options.speed;
  const accel = options.accel ?? 3.4;
  const decel = options.decel ?? 5.2;
  const radius = options.radius ?? 0.32;
  const arriveRadius = options.arriveRadius ?? 0.3;
  const turnRate = options.turnRate ?? 7.5;

  const dx = target.x - body.x;
  const dz = target.z - body.z;
  const dist = Math.hypot(dx, dz);

  let desiredVx = 0;
  let desiredVz = 0;
  if (dist > arriveRadius) {
    const brakingSpeed = Math.sqrt(2 * decel * Math.max(0, dist - arriveRadius * 0.6));
    const targetSpeed = Math.min(speed, brakingSpeed);
    desiredVx = (dx / dist) * targetSpeed;
    desiredVz = (dz / dist) * targetSpeed;
  }

  const dvx = desiredVx - body.vx;
  const dvz = desiredVz - body.vz;
  const dv = Math.hypot(dvx, dvz);
  if (dv > 1e-6) {
    const slowing = desiredVx === 0 && desiredVz === 0;
    const maxDv = (slowing ? decel : accel) * dt;
    const applied = Math.min(dv, maxDv);
    body.vx += (dvx / dv) * applied;
    body.vz += (dvz / dv) * applied;
  }

  const planarSpeed = Math.hypot(body.vx, body.vz);
  const steps = Math.max(1, Math.ceil((planarSpeed * dt) / 0.07));
  let hit = false;
  for (let i = 0; i < steps; i++) {
    body.x += (body.vx * dt) / steps;
    body.z += (body.vz * dt) / steps;
    const resolved = world.resolve(body.x, body.z, radius);
    if (resolved.hit) {
      body.x = resolved.x;
      body.z = resolved.z;
      hit = true;
    }
  }

  if (hit) {
    // Bleed the component that ran into the wall so the body slides along it.
    body.vx *= 0.28;
    body.vz *= 0.28;
  }

  if (planarSpeed > 0.08) {
    const desiredRot = Math.atan2(body.vx, body.vz);
    body.rot += angleDelta(desiredRot, body.rot) * Math.min(1, dt * turnRate);
  }

  const arrived = dist <= arriveRadius && Math.hypot(body.vx, body.vz) < 0.22;
  if (arrived) {
    body.vx = 0;
    body.vz = 0;
  }

  return {
    arrived,
    moving: planarSpeed > 0.12,
    blocked: hit,
  };
}

/**
 * Soft body separation so characters queue and step around each other instead
 * of occupying the same spot. Static bodies push without being moved.
 */
export function separateBodies(
  world: CollisionWorld,
  bodies: SeparationBody[],
  strength = 0.55,
): void {
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i]!;
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j]!;
      const dx = b.pose.x - a.pose.x;
      const dz = b.pose.z - a.pose.z;
      const dist = Math.hypot(dx, dz);
      const minDist = a.radius + b.radius + 0.14;
      if (dist >= minDist) continue;
      if (dist < 1e-5) {
        // Deterministic tie-break for exactly overlapping bodies.
        const angle = (i * 2.399963 + j * 0.7) % (Math.PI * 2);
        const push = minDist * 0.5 * strength;
        if (a.movable) {
          a.pose.x -= Math.cos(angle) * push;
          a.pose.z -= Math.sin(angle) * push;
        }
        if (b.movable) {
          b.pose.x += Math.cos(angle) * push;
          b.pose.z += Math.sin(angle) * push;
        }
        continue;
      }
      const overlap = (minDist - dist) * strength;
      const nx = dx / dist;
      const nz = dz / dist;
      if (a.movable && b.movable) {
        a.pose.x -= nx * overlap * 0.5;
        a.pose.z -= nz * overlap * 0.5;
        b.pose.x += nx * overlap * 0.5;
        b.pose.z += nz * overlap * 0.5;
      } else if (a.movable) {
        a.pose.x -= nx * overlap;
        a.pose.z -= nz * overlap;
      } else if (b.movable) {
        b.pose.x += nx * overlap;
        b.pose.z += nz * overlap;
      }
    }
  }

  for (const body of bodies) {
    if (!body.movable) continue;
    const resolved = world.resolve(body.pose.x, body.pose.z, body.radius);
    body.pose.x = resolved.x;
    body.pose.z = resolved.z;
  }
}

export { moveTowards };
