import * as THREE from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RENDER } from '../../config/gameConfig';
import type { GraphicsPreset } from '../../config/graphics';
import { ARENA, ARENA_MODELS, plain, type ArenaModelKey, type ArenaTheme } from '../../config/maps';
import type { TrackFile } from '../../core/loadProgress';
import type { Physics } from '../../physics/Physics';
import type { GameMap, MapSpawns, NavBounds } from '../GameMap';
import { ArenaBackdrop } from './ArenaBackdrop';
import { buildArenaFloor } from './arenaFloor';
import type { ArenaPiece, BrickPiece, PropPiece, RampPiece, WallPiece, ZonePiece } from './arenaLayout';
import { buildArenaWall, PIECES, rowSequence } from './arenaWall';
import { KitMerger, lighten, type KitModel, type KitModels } from './kit';
import type { ArenaDef } from './mapDefs';

/** 브릭 키트 모델 원본 크기 (스터드 몸체 기준, 원본 단위) */
const BRICK_SIZE: Record<BrickPiece['model'], [number, number]> = {
  brick2x4: [0.32, 0.16],
  brick1x8: [0.64, 0.08],
  brick2x2: [0.16, 0.16],
};
const PLATE_SIZE: [number, number] = [0.64, 0.32];
const CAP_PLATE: Record<BrickPiece['model'], ArenaModelKey> = { brick2x4: 'plate2x4', brick1x8: 'plate1x8', brick2x2: 'plate2x2' };

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

type AddInstance = (model: ArenaModelKey, color: number, textured: boolean, matrix: THREE.Matrix4) => void;

/**
 * 첫 정식 전투 맵 POP! ARENA (40 × 52m, 앞뒤 대칭 장난감 블록 아레나) + 바깥 장난감 도시.
 * - 모양: Kenney Brick Kit(엄폐물·발판 윗면·바깥 담장·도시 건물)·Prototype Kit(구분 벽·경사로·계단·발판 몸체·깃발) GLB
 * - 같은 모델은 InstancedMesh 하나 (색은 인스턴스 색), 브릭은 팔레트 텍스처 머티리얼 하나를 공유
 * - 충돌: 조각마다 단순 상자/쐐기 하나 (보이는 모양과 같은 크기, 브릭 스터드·장식·배경은 충돌 없음)
 * 배치 데이터는 arenaLayout.ts, 스폰 arenaSpawns.ts, 바깥 담장 arenaWall.ts, 바닥 arenaFloor.ts, 바깥 환경 ArenaBackdrop.ts.
 */
export class ArenaMap implements GameMap {
  readonly id: string;
  readonly name: string;
  readonly hasTestTargets = false;
  readonly spawns: MapSpawns;
  readonly navBounds: NavBounds;
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  private readonly backdrop: ArenaBackdrop;
  readonly lobbyKit: { models: KitModels; material: THREE.Material };
  private readonly disposables: Array<{ dispose(): void }> = [];
  /** 원래 그림자를 드리우던 맵 메시 (그래픽 '낮음'에서 끔, 처음 적용할 때 모음) */
  private staticCasters: THREE.Object3D[] | null = null;
  private readonly theme: ArenaTheme;
  /** 해 위치 (그림자 중심에서의 방향, 테마별) */
  private readonly sunOffset: readonly [number, number, number];
  /** 디버그: 그리기 호출 수·인스턴스 수·충돌체 수 */
  stats = { instancedMeshes: 0, instances: 0, colliders: 0, movementOnlyColliders: 0, triangles: 0, decorTriangles: 0, cityTriangles: 0, cloudTriangles: 0 };

  private constructor(
    scene: THREE.Scene,
    private readonly physics: Physics,
    private readonly models: KitModels,
    anisotropy: number,
    def: ArenaDef,
  ) {
    const shell = def.shell;
    this.id = def.id;
    this.name = def.name;
    this.spawns = def.spawns;
    this.navBounds = { minX: -shell.halfX + 0.5, maxX: shell.halfX - 0.5, minZ: -shell.halfZ + 0.5, maxZ: shell.halfZ - 0.5, ceiling: 6 };
    const theme = def.theme;
    this.theme = theme;
    this.sunOffset = theme.light.sunOffset;
    // 하늘 반구가 배경을 덮음. 배경색·안개색 = 수평선 색 (먼 건물·땅이 수평선에 녹음, 전투 구역 대각선 안은 안개 없음 — 큰 맵은 그만큼 멀리서 시작)
    scene.background = new THREE.Color(theme.sky.horizon);
    const fogNear = Math.max(ARENA.sky.fogNear, Math.hypot(shell.halfX * 2, shell.halfZ * 2) + 5);
    scene.fog = new THREE.Fog(theme.sky.horizon, fogNear, ARENA.sky.fogFar);
    // 밝고 부드러운 조명: 하늘·바닥 반사광 + 그림자 있는 해 (색·세기·방향은 맵 테마)
    const L = theme.light;
    const hemi = new THREE.HemisphereLight(L.hemiSky, L.hemiGround, L.hemi);
    this.sun = new THREE.DirectionalLight(L.sun, L.sunIntensity);
    this.sun.position.set(...L.sunOffset);
    this.sun.castShadow = true;
    const ext = RENDER.shadowExtent;
    const cam = this.sun.shadow.camera;
    cam.left = -ext;
    cam.right = ext;
    cam.top = ext;
    cam.bottom = -ext;
    cam.near = 1;
    cam.far = 60;
    this.sun.shadow.mapSize.set(RENDER.shadowMapSize, RENDER.shadowMapSize);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 3;
    this.group.add(hemi, this.sun, this.sun.target);

    // 브릭 공용 머티리얼: 팔레트 텍스처의 흰 그라데이션 칸 × 색 (텍스처는 한 장만 GPU에 올라감)
    const brickSrc = models.brick2x4.parts[0]!.material;
    if (brickSrc.map) brickSrc.map.anisotropy = anisotropy;
    const brickMat = brickSrc.clone();
    brickMat.color.setHex(0xffffff);
    brickMat.roughness = 0.45;
    brickMat.metalness = 0;
    // 구조물(Prototype Kit): 텍스처 대신 단색 (인스턴스 색)
    const flatMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0 });
    // 정점 색으로 합친 장식·도시용 (같은 텍스처·광택)
    const decorMat = brickMat.clone();
    decorMat.vertexColors = true;
    this.disposables.push(brickMat, flatMat, decorMat);
    this.lobbyKit = { models, material: decorMat };

    const allSpawns = [...def.spawns.teamA, ...def.spawns.teamB];
    const floor = buildArenaFloor(
      def.layout.filter((p): p is ZonePiece => p.kind === 'zone'),
      allSpawns,
      { halfX: shell.halfX + 1, halfZ: shell.halfZ + 1 },
      anisotropy,
      theme,
      def.pit,
    );
    this.group.add(floor.mesh);
    this.disposables.push(...floor.disposables);
    if (def.pit) this.buildPit(def.pit, shell.halfX, shell.halfZ, theme);
    else this.addBox(new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(shell.halfX + 1, 0.5, shell.halfZ + 1), undefined, '바닥');

    // 조각 + 바깥 담장 (같은 인스턴스 배치, 그림자 있음)
    const decor = new KitMerger();
    const wall = buildArenaWall(models, decor, shell, def.raisedWalls, theme);
    this.buildPieces(def.layout, wall.instances, brickMat, flatMat);
    for (const c of wall.colliders) {
      const collider = this.addBox(c.center, c.half, undefined, c.label);
      if (c.movementOnly) {
        // 보이는 벽 위 공간: 이동만 막고 사격·카메라·시야·봇 이동 격자 판정에서는 없는 것으로
        physics.ignoreForQueries(collider);
        this.stats.movementOnlyColliders++;
      }
    }
    // 담장 장식 (기둥 꼭대기·모서리 지붕·깃발 줄): 지오메트리 하나, 그림자 있음, 충돌 없음
    const decorGeo = decor.build();
    if (decorGeo) {
      this.stats.decorTriangles = decor.triangles;
      const mesh = new THREE.Mesh(decorGeo, decorMat);
      mesh.name = 'arena-wall-decor';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.disposables.push(decorGeo);
    }

    // 바깥 환경 (하늘·구름·도시·간판·랜드마크): 그림자 없음, 충돌 없음
    this.backdrop = new ArenaBackdrop(models, decorMat, anisotropy, shell, def.name, theme, def.pit);
    this.stats.cityTriangles = this.backdrop.stats.cityTriangles;
    this.stats.cloudTriangles = this.backdrop.stats.cloudTriangles;
    this.group.add(this.backdrop.group);
    scene.add(this.group);
  }

  /** 키트 GLB를 불러온 뒤 맵 생성. 모델 파일이 없거나 손상되면 오류를 그대로 올린다 (대체 도형 없음) */
  static async create(def: ArenaDef, scene: THREE.Scene, physics: Physics, loader: GLTFLoader, anisotropy: number, track?: TrackFile): Promise<ArenaMap> {
    const entries = await Promise.all(
      (Object.keys(ARENA_MODELS) as ArenaModelKey[]).map(async (key) => {
        const url = ARENA_MODELS[key];
        const t = track?.(url);
        let gltf;
        try {
          gltf = await loader.loadAsync(url, t ? (e) => t.progress(e) : undefined);
          t?.done();
        } catch (err) {
          throw new Error(`맵 모델 로드 실패 (${url}): ${err instanceof Error ? err.message : String(err)}`);
        }
        const root = gltf.scene;
        root.updateMatrixWorld(true);
        const parts: KitModel['parts'] = [];
        root.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
          parts.push({ geometry: mesh.geometry, material, local: mesh.matrixWorld.clone() });
        });
        return [key, { parts }] as const;
      }),
    );
    return new ArenaMap(scene, physics, Object.fromEntries(entries) as KitModels, anisotropy, def);
  }

  followShadow(focus: THREE.Vector3): void {
    this.sun.target.position.copy(focus);
    const [ox, oy, oz] = this.sunOffset;
    this.sun.position.set(focus.x + ox, focus.y + oy, focus.z + oz);
  }

  update(dt: number): void {
    this.backdrop.update(dt);
  }

  /** 그래픽 품질: 그림자 맵 크기·구조물 그림자·배경 도시 재질 */
  setGraphics(p: GraphicsPreset): void {
    const shadow = this.sun.shadow;
    if (shadow.mapSize.x !== p.shadowMapSize) {
      shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize);
      // 그림자 맵은 다음 그리기에서 새 크기로 다시 만들어짐
      shadow.map?.dispose();
      shadow.map = null;
    }
    // 흐림 폭을 그림자 맵 칸 수로 주므로 맵이 작아지면 같은 비율로 줄여 실제 흐림 폭(약 5cm)을 유지
    shadow.radius = Math.max(1, (3 * p.shadowMapSize) / RENDER.shadowMapSize);
    if (!this.staticCasters) {
      this.staticCasters = [];
      this.group.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && o.castShadow) this.staticCasters!.push(o);
      });
    }
    for (const o of this.staticCasters) o.castShadow = p.staticShadows;
    this.backdrop.setSimple(p.simpleBackdrop);
  }

  // ---------------- 조각 ----------------

  private buildPieces(
    pieces: readonly ArenaPiece[],
    extra: ReadonlyArray<{ model: ArenaModelKey; color: number; matrix: THREE.Matrix4; textured?: boolean }>,
    brickMat: THREE.MeshStandardMaterial,
    flatMat: THREE.MeshStandardMaterial,
  ): void {
    // (모델, 텍스처 사용) → 인스턴스 (행렬, 색) 목록
    const batches = new Map<string, { model: ArenaModelKey; textured: boolean; items: Array<{ matrix: THREE.Matrix4; color: number }> }>();
    const add: AddInstance = (model, color, textured, matrix) => {
      const key = `${model}|${textured}`;
      let b = batches.get(key);
      if (!b) batches.set(key, (b = { model, textured, items: [] }));
      b.items.push({ matrix, color });
    };
    const S = ARENA.brickScale;
    const levelH = ARENA.brickBodyHeight * S;

    const lifts = this.topLifts(pieces);
    for (const p of pieces) {
      switch (p.kind) {
        case 'brick': {
          const [sx, sz] = BRICK_SIZE[p.model];
          const rot = THREE.MathUtils.degToRad(p.rotDeg);
          const base = (p.baseY ?? 0) + (lifts.get(p) ?? 0);
          let h: number;
          if (p.levels === 0) {
            // 턱: 플레이트 1장
            add(CAP_PLATE[p.model], p.color, true, new THREE.Matrix4().compose(_p.set(p.x, base, p.z), _q.setFromAxisAngle(UP, rot), _s.setScalar(S)));
            h = ARENA.plateBodyHeight * S;
          } else if (p.levels === 1) {
            // 낮은 엄폐물: 같은 크기 플레이트 2장 (0.448m). 총구 높이(발 위 0.51~0.59m)보다 낮아 엄폐물 뒤에서 넘겨 쏠 수 있고,
            // 다리·아랫배는 가리고 상체·머리는 드러남. (브릭 1단 0.672m는 총구보다 높아 자기 총알만 막혔음)
            const plateH = ARENA.plateBodyHeight * S;
            for (let i = 0; i < 2; i++) {
              // 아래 장은 위 장에 덮여 스터드가 안 보임 → 스터드 없는 같은 크기
              add(i === 0 ? plain(CAP_PLATE[p.model]) : CAP_PLATE[p.model], p.color, true, new THREE.Matrix4().compose(_p.set(p.x, base + i * plateH, p.z), _q.setFromAxisAngle(UP, rot), _s.setScalar(S)));
            }
            h = plateH * 2;
          } else {
            for (let i = 0; i < p.levels; i++) {
              // 덮개 플레이트가 위를 덮으므로 스터드 없는 같은 크기 브릭
              add(plain(p.model), p.color, true, new THREE.Matrix4().compose(_p.set(p.x, base + i * levelH, p.z), _q.setFromAxisAngle(UP, rot), _s.setScalar(S)));
            }
            h = levelH * p.levels;
          }
          if (p.levels >= 2) {
            // 높은 엄폐물 덮개 플레이트 (같은 크기, 흰색)
            add(CAP_PLATE[p.model], this.theme.palette.white, true, new THREE.Matrix4().compose(_p.set(p.x, base + h, p.z), _q.setFromAxisAngle(UP, rot), _s.setScalar(S)));
            h += ARENA.plateBodyHeight * S;
          }
          const label = p.levels === 0 ? '발판 턱' : p.levels === 1 ? '낮은 엄폐물' : base > 0 ? '발판 기둥' : '높은 엄폐물';
          this.addBox(new THREE.Vector3(p.x, base + h / 2, p.z), new THREE.Vector3((sx * S) / 2, h / 2, (sz * S) / 2), _q.setFromAxisAngle(UP, rot), label);
          break;
        }
        case 'wall':
          this.buildWall(p, add);
          break;
        case 'platform': {
          const plateH = ARENA.plateBodyHeight * S;
          const bodyH = p.h - plateH;
          // 몸체: Prototype Kit 정육면체 (1×1×1, 바닥 중심 원점)
          add('cube', p.color, false, new THREE.Matrix4().compose(_p.set(p.x, 0, p.z), _q.identity(), _s.set(p.w, bodyH, p.d)));
          // 윗면: 4x8 플레이트를 빈틈없이 깔기 (긴 변 x)
          const pw = PLATE_SIZE[0] * S;
          const pd = PLATE_SIZE[1] * S;
          const nx = Math.round(p.w / pw);
          const nz = Math.round(p.d / pd);
          for (let ix = 0; ix < nx; ix++) {
            for (let iz = 0; iz < nz; iz++) {
              const x = p.x - p.w / 2 + pw * (ix + 0.5);
              const z = p.z - p.d / 2 + pd * (iz + 0.5);
              add('plate4x8', p.topColor, true, new THREE.Matrix4().compose(_p.set(x, bodyH, z), _q.identity(), _s.setScalar(S)));
            }
          }
          this.addBox(new THREE.Vector3(p.x, p.h / 2, p.z), new THREE.Vector3(p.w / 2, p.h / 2, p.d / 2), undefined, '발판');
          break;
        }
        case 'ramp':
        case 'stairs':
          this.buildRamp(p, add);
          break;
        case 'flag': {
          add('flag', p.color, false, new THREE.Matrix4().compose(_p.set(p.x, 0, p.z), _q.identity(), _s.setScalar(p.scale)));
          break;
        }
        case 'zone':
          // 바닥 색 구역은 바닥 메시(arenaFloor)에서 칸 색으로 그림
          break;
        case 'prop':
          this.buildProp(p, add, lifts.get(p) ?? 0);
          break;
      }
    }
    for (const w of extra) add(w.model, w.color, w.textured ?? true, w.matrix);

    // 인스턴스 메시: 모델 파트마다 하나, 색은 인스턴스 색 (머티리얼은 브릭 공용 / 구조물 공용)
    for (const b of batches.values()) {
      for (const part of this.models[b.model].parts) {
        const inst = new THREE.InstancedMesh(part.geometry, b.textured ? brickMat : flatMat, b.items.length);
        b.items.forEach((it, i) => {
          inst.setMatrixAt(i, _m.multiplyMatrices(it.matrix, part.local));
          inst.setColorAt(i, _c.setHex(it.color));
        });
        inst.instanceMatrix.needsUpdate = true;
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
        inst.castShadow = true;
        inst.receiveShadow = true;
        inst.computeBoundingSphere();
        this.group.add(inst);
        this.stats.instancedMeshes++;
        this.stats.instances += b.items.length;
        this.stats.triangles += ((part.geometry.index?.count ?? part.geometry.getAttribute('position').count) / 3) * b.items.length;
      }
    }
  }

  /**
   * 겹친 조각의 윗면이 같은 높이면 두 면이 번갈아 그려져 일렁임(z-fighting) → 뒤에 오는 조각을 1.5cm씩 높임.
   * 겹침은 바닥 사각형(회전 포함 외접 상자)으로 넉넉하게 판정 (괜히 높아져도 1.5cm라 눈에 띄지 않음)
   */
  private topLifts(pieces: readonly ArenaPiece[]): Map<ArenaPiece, number> {
    const S = ARENA.brickScale;
    const placed: Array<{ x0: number; x1: number; z0: number; z1: number; top: number }> = [];
    const lifts = new Map<ArenaPiece, number>();
    for (const p of pieces) {
      let w: number;
      let d: number;
      let h: number;
      if (p.kind === 'brick') {
        [w, d] = BRICK_SIZE[p.model].map((v) => v * S) as [number, number];
        const plate = ARENA.plateBodyHeight * S;
        h = p.levels === 0 ? plate : p.levels === 1 ? plate * 2 : p.levels * ARENA.brickBodyHeight * S + plate;
      } else if (p.kind === 'prop') {
        const b = this.modelBounds(p.model);
        w = (b.max.x - b.min.x) * p.sx;
        d = (b.max.z - b.min.z) * p.sz;
        h = (b.max.y - b.min.y) * p.sy;
      } else continue;
      const r = THREE.MathUtils.degToRad(p.rotDeg);
      const hx = (Math.abs(Math.cos(r)) * w + Math.abs(Math.sin(r)) * d) / 2;
      const hz = (Math.abs(Math.sin(r)) * w + Math.abs(Math.cos(r)) * d) / 2;
      const box = { x0: p.x - hx, x1: p.x + hx, z0: p.z - hz, z1: p.z + hz, top: (p.baseY ?? 0) + h };
      let lift = 0;
      const clash = () => placed.some((q) => q.x0 < box.x1 && box.x0 < q.x1 && q.z0 < box.z1 && box.z0 < q.z1 && Math.abs(q.top - (box.top + lift)) < 0.01);
      while (clash()) lift += 0.015;
      if (lift > 0) lifts.set(p, lift);
      placed.push({ ...box, top: box.top + lift });
    }
    return lifts;
  }

  /** 장난감 도형: 단색 인스턴스 + 늘린 모델 상자 충돌 (둥근 도형은 안쪽으로 8% 줄인 상자). lift = 겹침 일렁임 방지로 윗면만 올림 (바닥은 그대로, 높이를 늘림) */
  private buildProp(p: PropPiece, add: AddInstance, lift = 0): void {
    const rot = THREE.MathUtils.degToRad(p.rotDeg);
    const base = p.baseY ?? 0;
    if (lift > 0) {
      const mh = this.modelBounds(p.model).max.y - this.modelBounds(p.model).min.y;
      p = { ...p, sy: p.sy + lift / mh };
    }
    add(p.model, p.color, false, new THREE.Matrix4().compose(_p.set(p.x, base, p.z), _q.setFromAxisAngle(UP, rot), _s.set(p.sx, p.sy, p.sz)));
    if (p.collide === false) return;
    const b = this.modelBounds(p.model);
    const k = p.round ? 0.92 : 1;
    const half = new THREE.Vector3(((b.max.x - b.min.x) * p.sx * k) / 2, ((b.max.y - b.min.y) * p.sy) / 2, ((b.max.z - b.min.z) * p.sz * k) / 2);
    const local = new THREE.Vector3(((b.max.x + b.min.x) * p.sx) / 2, ((b.max.y + b.min.y) * p.sy) / 2, ((b.max.z + b.min.z) * p.sz) / 2).applyAxisAngle(UP, rot);
    this.addBox(new THREE.Vector3(p.x + local.x, base + local.y, p.z + local.z), half, _q.setFromAxisAngle(UP, rot), '도형');
  }

  /**
   * 낙사 구역: 바닥 충돌은 양쪽 땅 두 판, 구역 가장자리에 아래로 내려가는 절벽 면(충돌 있음), 밑에는 장난감 바다.
   * 떨어지면 MOVEMENT.killPlaneY(-20m)에서 낙사. 바깥 도시 바닥도 이 구역은 뚫림 (ArenaBackdrop)
   */
  private buildPit(pit: { z0: number; z1: number }, halfX: number, halfZ: number, theme: ArenaTheme): void {
    const hx = halfX + 1;
    const north = halfZ + 1 - pit.z1;
    const south = pit.z0 + halfZ + 1;
    this.addBox(new THREE.Vector3(0, -0.5, pit.z1 + north / 2), new THREE.Vector3(hx, 0.5, north / 2), undefined, '바닥 (북)');
    this.addBox(new THREE.Vector3(0, -0.5, pit.z0 - south / 2), new THREE.Vector3(hx, 0.5, south / 2), undefined, '바닥 (남)');
    const depth = 16;
    const cliffMat = new THREE.MeshStandardMaterial({ color: lighten(theme.palette.orange, 0.15), roughness: 0.85, metalness: 0 });
    const stripeMat = new THREE.MeshStandardMaterial({ color: theme.palette.yellow, roughness: 0.6, metalness: 0 });
    const seaMat = new THREE.MeshStandardMaterial({ color: 0x5fb6ff, roughness: 0.3, metalness: 0, emissive: 0x2a6fd0, emissiveIntensity: 0.25 });
    const box = new THREE.BoxGeometry(1, 1, 1);
    const sea = new THREE.PlaneGeometry(1, 1);
    this.disposables.push(cliffMat, stripeMat, seaMat, box, sea);
    for (const [z, s] of [[pit.z1, 1], [pit.z0, -1]] as const) {
      // 절벽 면 (땅 쪽으로 0.5m 들어간 두께 1m 판) + 가장자리 노란 띠 (낭떠러지 표시)
      const cliff = new THREE.Mesh(box, cliffMat);
      cliff.scale.set(hx * 2, depth, 1);
      cliff.position.set(0, -depth / 2 - 0.02, z + s * 0.5);
      cliff.receiveShadow = true;
      const stripe = new THREE.Mesh(box, stripeMat);
      stripe.scale.set(hx * 2, 0.3, 1.04);
      stripe.position.set(0, -0.17, z + s * 0.5);
      this.group.add(cliff, stripe);
      this.addBox(new THREE.Vector3(0, -depth / 2, z + s * 0.5), new THREE.Vector3(hx, depth / 2, 0.5), undefined, '절벽');
    }
    // 양옆 막음 (바깥 담장 아래)
    for (const sx of [-1, 1]) {
      const side = new THREE.Mesh(box, cliffMat);
      side.scale.set(1, depth, pit.z1 - pit.z0);
      side.position.set(sx * (hx - 0.5), -depth / 2 - 0.02, (pit.z0 + pit.z1) / 2);
      this.group.add(side);
    }
    const water = new THREE.Mesh(sea, seaMat);
    water.rotation.x = -Math.PI / 2;
    water.scale.set(hx * 2, pit.z1 - pit.z0, 1);
    water.position.set(0, -11, (pit.z0 + pit.z1) / 2);
    this.group.add(water);
  }

  private readonly boundsCache = new Map<ArenaModelKey, THREE.Box3>();
  /** 모델 원래 크기 상자 (파트 전체, 한 번만 계산) */
  private modelBounds(model: ArenaModelKey): THREE.Box3 {
    let b = this.boundsCache.get(model);
    if (!b) {
      b = new THREE.Box3();
      for (const part of this.models[model].parts) {
        part.geometry.computeBoundingBox();
        b.union(part.geometry.boundingBox!.clone().applyMatrix4(part.local));
      }
      this.boundsCache.set(model, b);
    }
    return b;
  }

  /**
   * 구분 벽: 브릭을 엇갈려 쌓은 담장 (바깥 담장과 같은 모양). 충돌 상자는 이전과 같음 (두께·높이·길이).
   * 브릭 줄 수는 높이에 가장 가깝게, 남는 차이는 브릭을 세로·두께·길이로 조금 늘리거나 줄여 충돌 상자와 정확히 맞춤
   */
  private buildWall(p: WallPiece, add: AddInstance): void {
    const dx = p.x2 - p.x1;
    const dz = p.z2 - p.z1;
    const len = Math.hypot(dx, dz);
    const yaw = Math.atan2(dx, dz);
    const cx = (p.x1 + p.x2) / 2;
    const cz = (p.z1 + p.z2) / 2;
    const S = ARENA.brickScale;
    const stud = 0.08 * S;
    const level = ARENA.brickBodyHeight * S;
    const plate = ARENA.plateBodyHeight * S;
    const rows = Math.max(1, Math.round((p.height - plate) / level));
    const fy = p.height / (rows * level + plate);
    let n = Math.round(len / stud);
    if (n % 2) n++;
    const fl = len / (n * stud);
    const fz = p.thickness / stud;
    const ux = dx / len;
    const uz = dz / len;
    // 브릭 길이 방향(로컬 x)을 벽 방향으로
    const rot = Math.atan2(-uz, ux);
    for (let r = 0; r <= rows; r++) {
      const cap = r === rows;
      let a = -len / 2;
      rowSequence(n, (cap ? rows - 1 : r) % 2 === 1).forEach((studs, k) => {
        const l = studs * stud * fl;
        const mid = a + l / 2;
        const [brick, platePiece] = PIECES[studs]!;
        const base = r % 2 === 0 ? lighten(p.color, 0.2) : this.theme.wallCream;
        const color = cap ? this.theme.palette.white : k % 2 === 0 ? base : lighten(base, 0.22);
        add(cap ? platePiece : plain(brick), color, true, new THREE.Matrix4().compose(
          _p.set(cx + ux * mid, (cap ? rows * level : r * level) * fy, cz + uz * mid),
          _q.setFromAxisAngle(UP, rot),
          _s.set(S * fl, S * fy, S * fz),
        ));
        a += l;
      });
    }
    const ch = p.colliderHeight ?? p.height;
    this.addBox(new THREE.Vector3(cx, ch / 2, cz), new THREE.Vector3(p.thickness / 2, ch / 2, len / 2), _q.setFromAxisAngle(UP, yaw), '구분 벽');
  }

  /**
   * 경사로·계단: 모델은 로컬 +x로 올라감 (1×1×1). dirDeg 방향으로 올라가게 회전.
   * 충돌은 둘 다 매끈한 쐐기 (계단 한 단 0.4m는 자동 계단 0.28m보다 높아 쐐기로 오름)
   */
  private buildRamp(p: RampPiece, add: AddInstance): void {
    const dir = THREE.MathUtils.degToRad(p.dirDeg);
    // 로컬 +x → 월드 (sin dir, cos dir): yaw = dir − 90°
    const yaw = dir - Math.PI / 2;
    _q.setFromAxisAngle(UP, yaw);
    add(p.kind === 'stairs' ? 'stairs' : 'slope', p.color, false, new THREE.Matrix4().compose(_p.set(p.x, 0, p.z), _q, _s.set(p.length, p.h, p.width)));
    // 쐐기 꼭짓점 (로컬: x 낮은 쪽 -L/2 → 높은 쪽 +L/2, z 폭)
    const L = p.length / 2;
    const W = p.width / 2;
    const local = [
      [-L, 0, -W], [-L, 0, W], [L, 0, -W], [L, 0, W],
      [L, p.h, -W], [L, p.h, W],
    ];
    const pts = new Float32Array(local.length * 3);
    local.forEach(([x, y, z], i) => {
      _p.set(x!, y!, z!).applyQuaternion(_q);
      pts[i * 3] = _p.x + p.x;
      pts[i * 3 + 1] = _p.y;
      pts[i * 3 + 2] = _p.z + p.z;
    });
    this.physics.setLabel(this.physics.addFixedConvex(pts), p.kind === 'stairs' ? '계단' : '경사로');
    this.stats.colliders++;
  }

  private addBox(center: THREE.Vector3, half: THREE.Vector3, rotation?: THREE.Quaternion, label?: string) {
    this.stats.colliders++;
    const collider = this.physics.addFixedBox(center, half, rotation ? rotation.clone() : undefined);
    if (label) this.physics.setLabel(collider, label);
    return collider;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.backdrop.dispose();
    this.disposables.forEach((d) => d.dispose());
    for (const m of Object.values(this.models)) {
      for (const part of m.parts) {
        part.geometry.dispose();
        part.material.map?.dispose();
        part.material.dispose();
      }
    }
  }
}
