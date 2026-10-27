import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Physics } from '../physics/Physics';

export interface NavGridOptions {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  cellSize: number;
  /** 장애물과 유지할 거리 (캐릭터 캡슐 반지름 + 여유) */
  clearance: number;
  /** 검사 높이 범위: 바닥면 위 이 높이부터 (바닥 자체는 장애물 아님) */
  probeBottom: number;
  probeTop: number;
  /** 바닥면을 찾는 아래 방향 레이 시작 높이 (맵에서 가장 높은 걸을 수 있는 면보다 위) */
  ceiling?: number;
  /** 이웃 칸으로 갈 수 있는 경사 (높이 차 / 수평 거리). 캐릭터 최대 경사 46°보다 약간 낮게 */
  maxSlope?: number;
  /** 경사와 별개로 넘을 수 있는 단 높이 (캐릭터 자동 계단 0.28) */
  maxStep?: number;
}

/** 이진 힙 (A* 열린 목록) */
class MinHeap {
  private readonly items: number[] = [];
  private readonly keys: number[] = [];

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
    this.keys.length = 0;
  }

  push(item: number, key: number): void {
    const a = this.items;
    const k = this.keys;
    a.push(item);
    k.push(key);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p]! <= k[i]!) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      [k[p], k[i]] = [k[i]!, k[p]!];
      i = p;
    }
  }

  pop(): number {
    const a = this.items;
    const k = this.keys;
    const top = a[0]!;
    const lastItem = a.pop()!;
    const lastKey = k.pop()!;
    if (a.length > 0) {
      a[0] = lastItem;
      k[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && k[l]! < k[m]!) m = l;
        if (r < a.length && k[r]! < k[m]!) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        [k[m], k[i]] = [k[i]!, k[m]!];
        i = m;
      }
    }
    return top;
  }
}

const SQRT2 = Math.SQRT2;
const DIRS: Array<[number, number, number]> = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

/**
 * 높이 있는 이동 격자(높이맵) + A*. 맵의 고정 콜라이더를 Rapier 쿼리로 미리 구워 둔다
 * (실제 충돌 형상과 같아서 벽 통과·허공 경로가 나오지 않음). 렌더링과 무관 → 서버로 옮길 수 있다.
 * - 칸마다 위에서 아래로 레이를 쏴 걸을 면(바닥·경사로·계단·발판 위)의 높이를 찾고, 그 높이에서 캐릭터 폭 검사
 * - 이웃 칸은 높이 차가 경사·단 높이 안일 때만 연결 → 경사로·계단으로만 오르내림, 발판 가장자리에서 떨어지지 않음
 * - 큰 덩어리(주 영역)와 이어지지 않은 칸(엄폐물 윗면 등)은 걷지 않는 칸으로 처리
 * 주의: Rapier 쿼리 구조는 world.step()에서 갱신되므로 맵 생성 후 1스텝 이상 지난 뒤 만들어야 한다.
 * 한 칸에 걸을 면이 하나라고 가정한다 (발판 아래로 지나가는 통로는 지원 안 함).
 */
export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  /** 1 = 걸을 수 있음 (주 영역과 이어진 칸) */
  readonly walkable: Uint8Array;
  /** 칸 중심의 걸을 면 높이 (없으면 NaN) */
  readonly height: Float32Array;
  /** 1 = 평평한 면 (바닥·발판·엄폐물 윗면), 0 = 경사면 (경사로·계단 쐐기) */
  readonly flat: Uint8Array;
  private readonly g: Float32Array;
  private readonly parent: Int32Array;
  private readonly closed: Uint8Array;
  private readonly stamp: Uint32Array;
  private search = 0;
  private readonly heap = new MinHeap();
  private readonly maxSlope: number;
  private readonly maxStep: number;
  /** 디버그: 마지막 탐색 노드 수, 주 영역에서 빠진 칸 수 */
  lastExpanded = 0;
  islandCells = 0;
  /** 걸을 수 있는 칸의 덩어리 번호 (-1 = 못 걷는 칸). 낙사 구역으로 끊긴 맵은 덩어리가 여럿 */
  readonly region: Int32Array;

  constructor(
    physics: Physics,
    readonly opts: NavGridOptions,
    /** true인 콜라이더만 장애물 (캐릭터 캡슐·판정 전용 히트박스 제외) */
    isObstacle: (c: RAPIER.Collider) => boolean,
  ) {
    const o = opts;
    this.cols = Math.floor((o.maxX - o.minX) / o.cellSize);
    this.rows = Math.floor((o.maxZ - o.minZ) / o.cellSize);
    this.maxSlope = o.maxSlope ?? 0.84;
    this.maxStep = o.maxStep ?? 0.28;
    const n = this.cols * this.rows;
    this.walkable = new Uint8Array(n);
    this.height = new Float32Array(n).fill(NaN);
    this.flat = new Uint8Array(n);
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.closed = new Uint8Array(n);
    this.stamp = new Uint32Array(n);

    const probeH = o.probeTop - o.probeBottom;
    const half = Math.max(0.01, probeH / 2 - o.clearance);
    const shape = new RAPIER.Capsule(half, o.clearance);
    const rot = { x: 0, y: 0, z: 0, w: 1 };
    const filter = (c: RAPIER.Collider) => !c.isSensor() && isObstacle(c);
    const ceiling = o.ceiling ?? 10;
    const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    // 걸을 면의 최소 법선 y (경사 46°보다 약간 여유)
    const minNormalY = Math.cos(THREE.MathUtils.degToRad(47));
    const raw = new Uint8Array(n);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const i = r * this.cols + c;
        const p = this.cellCenter(c, r, _p);
        ray.origin = { x: p.x, y: ceiling, z: p.z };
        const hit = physics.world.castRayAndGetNormal(ray, ceiling + 5, true, undefined, undefined, undefined, undefined, filter);
        if (!hit || hit.normal.y < minNormalY) continue;
        const h = ceiling - hit.timeOfImpact;
        this.height[i] = h;
        this.flat[i] = hit.normal.y > 0.995 ? 1 : 0;
        const blocked = physics.world.intersectionWithShape(
          { x: p.x, y: h + o.probeBottom + probeH / 2, z: p.z }, rot, shape, undefined, undefined, undefined, undefined, filter,
        );
        raw[i] = blocked ? 0 : 1;
      }
    }
    // 큰 연결 덩어리(가장 큰 것의 25% 이상)만 남김 → 엄폐물 윗면 같은 섬은 경로·순찰 목표에서 제외,
    // 낙사 구역으로 끊긴 맵(양쪽 땅이 비슷한 크기)은 양쪽 모두 남김
    const label = new Int32Array(n).fill(-1);
    const sizes: number[] = [];
    let bestSize = 0;
    let comp = 0;
    const stack: number[] = [];
    for (let s = 0; s < n; s++) {
      if (!raw[s] || label[s] >= 0) continue;
      let size = 0;
      stack.push(s);
      label[s] = comp;
      while (stack.length) {
        const cur = stack.pop()!;
        size++;
        const cc = cur % this.cols;
        const cr = Math.floor(cur / this.cols);
        for (const [dc, dr, cost] of DIRS) {
          const nc = cc + dc;
          const nr = cr + dr;
          if (nc < 0 || nr < 0 || nc >= this.cols || nr >= this.rows) continue;
          const ni = nr * this.cols + nc;
          if (!raw[ni] || label[ni] >= 0) continue;
          if (dc !== 0 && dr !== 0 && (!raw[cr * this.cols + nc] || !raw[nr * this.cols + cc])) continue;
          if (!this.stepOk(cur, ni, cost * o.cellSize)) continue;
          label[ni] = comp;
          stack.push(ni);
        }
      }
      sizes.push(size);
      if (size > bestSize) bestSize = size;
      comp++;
    }
    this.region = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      if (raw[i] && label[i] >= 0 && sizes[label[i]!]! >= bestSize * 0.25) {
        this.walkable[i] = 1;
        this.region[i] = label[i]!;
      } else if (raw[i]) this.islandCells++;
    }
  }

  /**
   * 두 칸 사이를 오르내릴 수 있는지. 평평한 면끼리는 자동 계단 높이까지만 (낮은 엄폐물 윗면 0.45m는 단으로 못 오름),
   * 경사면이 끼면 경사 한도까지 (경사로·계단)
   */
  private stepOk(a: number, b: number, dist: number): boolean {
    const dh = Math.abs(this.height[b]! - this.height[a]!);
    if (this.flat[a] && this.flat[b]) return dh <= this.maxStep;
    return dh <= Math.max(this.maxStep, dist * this.maxSlope);
  }

  get walkableCount(): number {
    let n = 0;
    for (const w of this.walkable) n += w;
    return n;
  }

  cellCenter(c: number, r: number, out: THREE.Vector3): THREE.Vector3 {
    const o = this.opts;
    const h = this.height[r * this.cols + c];
    return out.set(o.minX + (c + 0.5) * o.cellSize, h !== undefined && Number.isFinite(h) ? h : 0, o.minZ + (r + 0.5) * o.cellSize);
  }

  cellOf(x: number, z: number): number {
    const o = this.opts;
    const c = Math.floor((x - o.minX) / o.cellSize);
    const r = Math.floor((z - o.minZ) / o.cellSize);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return -1;
    return r * this.cols + c;
  }

  isWalkableAt(x: number, z: number): boolean {
    const i = this.cellOf(x, z);
    return i >= 0 && this.walkable[i] === 1;
  }

  /** 걸을 면 높이 (없으면 NaN) */
  heightAt(x: number, z: number): number {
    const i = this.cellOf(x, z);
    return i >= 0 ? this.height[i]! : NaN;
  }

  /**
   * 가장 가까운 걸을 수 있는 칸 중심 (maxRadius 칸 안). 높이 차도 거리로 쳐서
   * 발판 위·아래가 겹치는 곳에서 엉뚱한 층을 고르지 않게 한다 (refY 생략 시 수평 거리만)
   */
  nearestWalkable(x: number, z: number, out: THREE.Vector3, maxRadius = 8, refY?: number): THREE.Vector3 | null {
    const o = this.opts;
    const c0 = Math.floor((x - o.minX) / o.cellSize);
    const r0 = Math.floor((z - o.minZ) / o.cellSize);
    let best = -1;
    let bestD = Infinity;
    for (let rad = 0; rad <= maxRadius && best < 0; rad++) {
      for (let dr = -rad; dr <= rad; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
          const c = c0 + dc;
          const r = r0 + dr;
          if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) continue;
          const i = r * this.cols + c;
          if (!this.walkable[i]) continue;
          const p = this.cellCenter(c, r, _p);
          const dy = refY === undefined ? 0 : (p.y - refY) * 2;
          const d = (p.x - x) ** 2 + (p.z - z) ** 2 + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    if (best < 0) return null;
    if (best === this.cellOf(x, z)) return out.set(x, this.height[best]!, z);
    return this.cellCenter(best % this.cols, Math.floor(best / this.cols), out);
  }

  /**
   * 두 점 사이 직선이 걸을 수 있는 칸만, 오르내릴 수 있는 높이 차로 지나는지 (경로 다듬기·옆걸음 검사).
   * 캐릭터 폭만큼 양옆 평행선도 검사 → 장애물 모서리를 스치는 직선을 거른다.
   */
  lineWalkable(ax: number, az: number, bx: number, bz: number): boolean {
    const len = Math.hypot(bx - ax, bz - az);
    const step = this.opts.cellSize * 0.35;
    const n = Math.max(1, Math.ceil(len / step));
    const side = len > 1e-4 ? LINE_SIDE / len : 0;
    const sx = -(bz - az) * side;
    const sz = (bx - ax) * side;
    let lastCell = this.cellOf(ax, az);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      if (!this.isWalkableAt(x, z)) return false;
      const cell = this.cellOf(x, z);
      if (lastCell >= 0 && cell !== lastCell && !this.stepOk(lastCell, cell, len / n)) return false;
      lastCell = cell;
      // 양 끝점은 칸 경계에 걸칠 수 있어 중앙선만
      if (i > 0 && i < n && (!this.isWalkableAt(x + sx, z + sz) || !this.isWalkableAt(x - sx, z - sz))) return false;
    }
    return true;
  }

  /**
   * A* 경로 (8방향, 모서리 끼어 지나가기 금지, 높이 차 제한) → 직선으로 이어지는 점은 생략해 다듬은 경로.
   * @returns 웨이포인트 (시작점 제외, 목표 포함, y = 걸을 면 높이). 못 찾으면 null
   */
  findPath(from: THREE.Vector3, to: THREE.Vector3, maxExpand = 8000): THREE.Vector3[] | null {
    const start = this.nearestWalkable(from.x, from.z, new THREE.Vector3(), 3, from.y);
    const goal = this.nearestWalkable(to.x, to.z, new THREE.Vector3(), 6, to.y);
    if (!start || !goal) return null;
    const s = this.cellOf(start.x, start.z);
    const t = this.cellOf(goal.x, goal.z);
    if (s < 0 || t < 0) return null;
    if (s === t || this.lineWalkable(from.x, from.z, goal.x, goal.z)) return [goal];

    const cols = this.cols;
    const tc = t % cols;
    const tr = Math.floor(t / cols);
    const h = (i: number) => {
      const dx = Math.abs((i % cols) - tc);
      const dz = Math.abs(Math.floor(i / cols) - tr);
      return Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz);
    };
    const stampId = ++this.search;
    const heap = this.heap;
    heap.clear();
    this.stamp[s] = stampId;
    this.g[s] = 0;
    this.parent[s] = -1;
    this.closed[s] = 0;
    heap.push(s, h(s));
    let expanded = 0;
    let found = false;
    const cell = this.opts.cellSize;
    while (heap.size > 0 && expanded < maxExpand) {
      const cur = heap.pop();
      if (this.closed[cur] && this.stamp[cur] === stampId) continue;
      this.closed[cur] = 1;
      expanded++;
      if (cur === t) {
        found = true;
        break;
      }
      const cc = cur % cols;
      const cr = Math.floor(cur / cols);
      for (const [dc, dr, cost] of DIRS) {
        const nc = cc + dc;
        const nr = cr + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= this.rows) continue;
        const ni = nr * cols + nc;
        if (!this.walkable[ni]) continue;
        // 대각선은 양옆 칸이 모두 비어 있어야 (벽 모서리 끼임 방지)
        if (dc !== 0 && dr !== 0 && (!this.walkable[cr * cols + nc] || !this.walkable[nr * cols + cc])) continue;
        if (!this.stepOk(cur, ni, cost * cell)) continue;
        const ng = this.g[cur]! + cost;
        if (this.stamp[ni] !== stampId) {
          this.stamp[ni] = stampId;
          this.closed[ni] = 0;
          this.g[ni] = Infinity;
        }
        if (this.closed[ni] || ng >= this.g[ni]!) continue;
        this.g[ni] = ng;
        this.parent[ni] = cur;
        heap.push(ni, ng + h(ni));
      }
    }
    this.lastExpanded = expanded;
    if (!found) return null;

    const cells: number[] = [];
    for (let i = t; i !== -1; i = this.parent[i]!) cells.push(i);
    cells.reverse();
    const pts = cells.map((i) => this.cellCenter(i % cols, Math.floor(i / cols), new THREE.Vector3()));
    pts[pts.length - 1] = goal;
    // 끈 당기기: 현재 점에서 직선으로 갈 수 있는 가장 먼 점까지 건너뜀
    const out: THREE.Vector3[] = [];
    let ax = from.x;
    let az = from.z;
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !this.lineWalkable(ax, az, pts[j]!.x, pts[j]!.z)) j--;
      out.push(pts[j]!);
      ax = pts[j]!.x;
      az = pts[j]!.z;
      i = j;
    }
    if (out.length === 0) out.push(goal);
    return out;
  }

  /** 무작위 걸을 수 있는 지점 (center에서 minDist~maxDist, y = 걸을 면 높이) */
  randomPoint(center: THREE.Vector3, minDist: number, maxDist: number, out: THREE.Vector3, tries = 24): THREE.Vector3 | null {
    // 같은 덩어리 안에서만 (낙사 구역 건너편은 갈 길이 없음)
    const from = this.cellOf(center.x, center.z);
    const home = from >= 0 ? this.region[from]! : -1;
    for (let k = 0; k < tries; k++) {
      const a = Math.random() * Math.PI * 2;
      const d = minDist + Math.random() * (maxDist - minDist);
      const x = center.x + Math.cos(a) * d;
      const z = center.z + Math.sin(a) * d;
      if (!this.isWalkableAt(x, z)) continue;
      if (home >= 0 && this.region[this.cellOf(x, z)] !== home) continue;
      return out.set(x, this.heightAt(x, z), z);
    }
    return null;
  }
}

const _p = new THREE.Vector3();
/** 직선 검사 양옆 간격 (m) */
const LINE_SIDE = 0.25;
