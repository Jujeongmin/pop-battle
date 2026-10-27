import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { ARENA } from '../config/maps';
import type { Physics } from '../physics/Physics';
import type { GameMap, SpawnPoint } from './GameMap';
import { balloon } from './maps/arenaCity';
import { KitMerger, lighten, trs, type KitModel } from './maps/kit';

const UP = new THREE.Vector3(0, 1, 0);
/**
 * 섬 바닥에 밑면이 닿는 물체는 밑면을 바닥 아래로 이만큼 늘림 (윗면·모양은 그대로).
 * 밑면이 바닥 윗면과 같은 높이면 카메라가 물체 안·가장자리에 들어갈 때 두 면이 겹쳐 바닥이 일렁임
 */
const BASE_SINK = 0.03;
const _box = new THREE.Box3();
const _partBox = new THREE.Box3();
const _sink = new THREE.Matrix4();
/** 섬 윗면 반지름 (m) */
const R = 28;
/** 가장자리 울타리 반지름 */
const FENCE_R = R - 0.6;
/** 북쪽 하늘 탑 (섬 중심 기준 위치, 기둥 반지름, 꼭대기 높이) */
const TOWER = { x: 0, z: -17, r: 2.2, top: 16.5 };
/** 남쪽 다리 끝 작은 섬 (중심 z, 반지름) */
const ISLET = { z: 40, r: 5.5 };

/**
 * 메인 로비 전용 공간 "POP! 스카이 파크": 경기장 위 하늘에 뜬 지름 56m 장난감 놀이섬 + 다리로 이어진 작은 섬.
 * 구역: 가운데 광장(시작 지점·무대) / 북쪽 하늘 탑(나선 발판 → 16.5m 전망대) / 북서쪽 경사로 언덕 /
 * 동쪽 슬라이딩 통로(천장 0.95m)·허들 / 서쪽 징검다리 기둥(→ 4.6m) / 남쪽 좁은 다리 → 작은 섬 / 바깥 산책 구역(나무·풍선).
 * 코스 치수는 이동 설정(MOVEMENT) 기준: 점프 최고 1.14m·걷기 점프 거리 약 2m(가장 느린 캐릭터), 서 있는 캡슐 1.24m·슬라이딩 0.68m
 * → 단 높이차 0.6m 이하, 틈 0.8m 이하, 통로는 슬라이딩으로만 통과. 캡슐 크기는 캐릭터와 무관해 모든 캐릭터가 완주 가능.
 * - 전투 맵과 분리: 충돌체·메시가 이 클래스에만 있고, 첫 매치·멀티 입장 때 dispose()로 통째로 치움
 * - 맵 키트(브릭·깃발 GLB, 장식 머티리얼)를 그대로 재사용, 없으면(테스트 맵) 기본 도형만
 * - 모양은 지오메트리 하나로 합침 (그리기 호출 1회), 충돌은 단순 상자·각기둥·쐐기
 * - 가장자리에 보이지 않는 높은 울타리(이동만 막음, 카메라·사격 쿼리는 통과). 다리에서 떨어지면 시작 지점으로
 */
export class LobbySpace {
  /** 섬 윗면 중심 (발 높이 = y) */
  static readonly CENTER = new THREE.Vector3(0, 36, 0);
  /** 로비 시작 위치: 광장 남쪽에서 북쪽 코스를 바라봄 */
  readonly spawn: SpawnPoint;
  private readonly mesh: THREE.Mesh;
  private readonly ownMaterial: THREE.Material | null;
  private readonly colliders: RAPIER.Collider[] = [];
  private readonly merger = new KitMerger();
  /** 하늘 탑 기둥만 따로 (카메라를 가리면 반투명하게, 모양·색·충돌은 그대로) */
  private readonly pillarMerger = new KitMerger();
  private readonly pillarMesh: THREE.Mesh;
  private readonly pillarMaterial: THREE.Material;
  private pillarAlpha = 1;
  /** 기둥 충돌체 (로비 카메라 가림 검사에서 뺌 → 당기지 않고 기둥을 반투명하게) */
  pillarCollider: RAPIER.Collider | null = null;
  private readonly unit = {
    box: new THREE.BoxGeometry(1, 1, 1),
    cylinder: new THREE.CylinderGeometry(1, 1, 1, 32),
    /** 뚜껑 없는 원통 옆면 (탑 기둥 띠: 띠 사이 뚜껑이 같은 높이에 겹치면 반투명일 때 줄무늬로 일렁임) */
    tube: new THREE.CylinderGeometry(1, 1, 1, 32, 1, true),
    post: new THREE.CylinderGeometry(1, 1, 1, 10),
    sphere: new THREE.SphereGeometry(1, 14, 10),
    cone: new THREE.ConeGeometry(1, 1, 32),
    wedge: wedgeGeometry(),
  };
  private disposed = false;

  /** 화면을 가릴 수 있는 로비 모습 (기둥 제외, 충돌체 없는 장식 포함) — 쇼케이스 카메라 각도 고르기 */
  get viewBlocker(): THREE.Object3D {
    return this.mesh;
  }

  constructor(
    scene: THREE.Scene,
    private readonly physics: Physics,
    private readonly kit: GameMap['lobbyKit'] | null,
  ) {
    const c = LobbySpace.CENTER;
    this.spawn = { x: c.x, y: c.y, z: c.z + 5, yaw: Math.PI };
    this.buildIsland();
    this.buildFence();
    this.buildPlaza();
    this.buildSkyTower();
    this.buildRampHill();
    this.buildSlideZone();
    this.buildSteppingStones();
    this.buildBridgeAndIslet();
    this.buildOuterRing();

    const geo = this.merger.build()!;
    for (const g of Object.values(this.unit)) g.dispose();
    this.ownMaterial = kit ? null : new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.5, metalness: 0 });
    this.mesh = new THREE.Mesh(geo, kit?.material ?? this.ownMaterial!);
    this.mesh.name = 'lobby-sky-park';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.matrixAutoUpdate = false;
    scene.add(this.mesh);

    // 탑 기둥: 같은 재질의 복제본 (투명도만 바꿈, 원본 키트 재질은 경기장과 공유라 건드리지 않음)
    this.pillarMaterial = (kit?.material ?? this.ownMaterial!).clone();
    this.pillarMesh = new THREE.Mesh(this.pillarMerger.build()!, this.pillarMaterial);
    this.pillarMesh.name = 'lobby-sky-tower-pillar';
    this.pillarMesh.castShadow = true;
    this.pillarMesh.receiveShadow = true;
    this.pillarMesh.matrixAutoUpdate = false;
    scene.add(this.pillarMesh);
  }

  /** 그래픽 '낮음': 섬·탑 기둥(합친 큰 메시)이 그림자를 드리우지 않음 (캐릭터 그림자는 그대로 받음) */
  setStaticShadows(on: boolean): void {
    this.mesh.castShadow = on;
    this.pillarMesh.castShadow = on;
  }

  /**
   * 선분(카메라 → 캐릭터)이 탑 기둥을 지나는지 (가로 원 + 높이 범위). margin = 기둥 반지름에 더할 여유 (m)
   */
  pillarBetween(a: THREE.Vector3, b: THREE.Vector3, margin = 0): boolean {
    const cx = LobbySpace.CENTER.x + TOWER.x;
    const cz = LobbySpace.CENTER.z + TOWER.z;
    const y0 = LobbySpace.CENTER.y;
    const y1 = y0 + TOWER.top;
    const r = TOWER.r + margin;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    // 선분 위에서 기둥 중심과 가장 가까운 점
    const t = len2 > 1e-9 ? Math.min(1, Math.max(0, ((cx - a.x) * dx + (cz - a.z) * dz) / len2)) : 0;
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    if ((px - cx) ** 2 + (pz - cz) ** 2 > r * r) return false;
    const py = a.y + (b.y - a.y) * t;
    return py > y0 && py < y1;
  }

  /** 탑 기둥 투명도로 부드럽게 (1 = 불투명). 매 프레임 로비 카메라가 부름 */
  fadePillar(target: number, dt: number): void {
    this.pillarAlpha += (target - this.pillarAlpha) * (1 - Math.exp(-10 * dt));
    if (Math.abs(this.pillarAlpha - target) < 0.005) this.pillarAlpha = target;
    const m = this.pillarMaterial;
    const see = this.pillarAlpha < 0.995;
    if (m.transparent !== see) {
      m.transparent = see;
      m.depthWrite = !see;
      m.needsUpdate = true;
    }
    m.opacity = see ? this.pillarAlpha : 1;
  }

  /** 섬·다리에서 떨어졌는지 (시작 지점으로 되돌림) */
  isBelow(y: number): boolean {
    return y < LobbySpace.CENTER.y - 6;
  }

  /** 메시·충돌체 제거 (키트 모델·장식 머티리얼은 맵 소유라 그대로) */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.pillarMesh.removeFromParent();
    this.pillarMesh.geometry.dispose();
    this.pillarMaterial.dispose();
    this.ownMaterial?.dispose();
    for (const col of this.colliders) this.physics.removeCollider(col);
    this.colliders.length = 0;
  }

  // ---------------- 섬 몸체·울타리 ----------------

  /** 윗면(크림색 원판) + 아래로 갈수록 좁아지는 파스텔 층 + 뾰족한 밑동. 충돌은 윗면 원판만 */
  private buildIsland(): void {
    const { x, y, z } = LobbySpace.CENTER;
    const p = ARENA.palette;
    this.cylinder(x, y - 0.3, z, R, 0.6, 0xf6efe4);
    this.cylinder(x, y - 0.8, z, R + 0.2, 0.4, lighten(p.blue, 0.25));
    this.cylinder(x, y - 1.8, z, R - 3, 1.6, lighten(p.yellow, 0.15));
    this.cylinder(x, y - 3.4, z, R - 8, 1.6, lighten(p.pink, 0.2));
    this.cylinder(x, y - 5.0, z, R - 14, 1.6, lighten(p.mint, 0.1));
    this.coneDown(x, y - 9.3, z, R - 18, 7, lighten(p.lavender, 0.15));
    this.prism(x, z, R, y - 0.6, y, 40, '로비 바닥');

    // 바닥 무늬: 광장 둘레 점선 + 바깥 산책로 경계 점선 (얇은 원판, 충돌 없음)
    const dots = [p.pink, p.yellow, p.blue, p.mint, p.orange, p.lavender];
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      this.cylinder(x + Math.sin(a) * 8, y + 0.015, z + Math.cos(a) * 8, 0.4, 0.03, lighten(dots[i % dots.length]!, 0.35));
    }
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      this.cylinder(x + Math.sin(a) * 20, y + 0.015, z + Math.cos(a) * 20, 0.3, 0.03, lighten(dots[i % dots.length]!, 0.45));
    }
  }

  /** 가장자리 기둥 + 난간 고리 + 보이지 않는 높은 울타리 (남쪽 다리 입구만 열림) */
  private buildFence(): void {
    const { x, z } = LobbySpace.CENTER;
    const p = ARENA.palette;
    this.ringFence(x, z, FENCE_R, 96, 72, [p.pink, p.yellow, p.blue, p.mint, p.orange], 0);
  }

  /**
   * 원형 울타리: 기둥(보이는 높이 0.67m) + 난간 고리 + 접하는 높은 상자 충돌(이동만 막음, 카메라·사격 쿼리 제외).
   * gapAngle 방향(rad, atan2(x, z) 기준)은 다리 입구로 비워 둠
   */
  private ringFence(cx: number, cz: number, r: number, posts: number, segs: number, colors: number[], gapAngle: number): void {
    const y = LobbySpace.CENTER.y;
    const gapHalf = 1.3 / r;
    const inGap = (a: number) => Math.abs(Math.atan2(Math.sin(a - gapAngle), Math.cos(a - gapAngle))) < gapHalf;
    for (let i = 0; i < posts; i++) {
      const a = (i / posts) * Math.PI * 2;
      if (inGap(a)) continue;
      const px = cx + Math.sin(a) * r;
      const pz = cz + Math.cos(a) * r;
      const color = colors[i % colors.length]!;
      if (this.kit) this.addKit(this.kit.models.round1x1, trs(px, y, pz, a, ARENA.brickScale), color);
      else this.cylinder(px, y + 0.34, pz, 0.28, 0.67, color, this.unit.post);
    }
    // 난간: 짧은 원기둥 조각을 이어 붙임 (입구는 비움)
    const railSegs = Math.round(posts * 1.5);
    for (let i = 0; i < railSegs; i++) {
      const a = ((i + 0.5) / railSegs) * Math.PI * 2;
      if (inGap(a)) continue;
      const len = 2 * r * Math.sin(Math.PI / railSegs) * 1.02;
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(cx + Math.sin(a) * r, y + 0.55, cz + Math.cos(a) * r),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, a, Math.PI / 2, 'YXZ')),
        new THREE.Vector3(0.09, len, 0.09),
      );
      this.add(this.unit.post, m, ARENA.palette.white);
    }
    const rr = r + 0.3;
    const half = new THREE.Vector3(rr * Math.tan(Math.PI / segs) * 1.15, 3, 0.25);
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      if (inGap(a)) continue;
      this.box(new THREE.Vector3(cx + Math.sin(a) * rr, y + 3, cz + Math.cos(a) * rr), half, a, '로비 울타리', true);
    }
  }

  // ---------------- 구역 ----------------

  /** 가운데 광장: 둥근 무대(0.48m) + 깃발 + 시작 지점 표시 + 풍선 기둥 */
  private buildPlaza(): void {
    const { x: cx, y, z: cz } = LobbySpace.CENTER;
    const p = ARENA.palette;
    this.cylinder(cx, y + 0.2, cz, 2.7, 0.4, p.yellow);
    this.cylinder(cx, y + 0.44, cz, 2.76, 0.08, p.white);
    this.cylinder(cx, y + 0.485, cz, 2.1, 0.02, lighten(p.orange, 0.35));
    this.prism(cx, cz, 2.76, y, y + 0.48, 16, '로비 무대');
    this.flag(cx, y + 0.48, cz, p.pink, 2.2);
    this.cylinder(this.spawn.x, y + 0.015, this.spawn.z, 1.1, 0.03, lighten(p.blue, 0.45));
    this.balloonPost(cx + 5.5, cz + 2.5, 0);
    this.balloonPost(cx - 5.5, cz + 2.5, 3);
    // 선물 상자 (광장 가장자리)
    this.gift(cx + 4.6, cz - 4.2, 1.1, p.lavender, p.white);
    this.gift(cx + 5.9, cz - 5.0, 0.8, lighten(p.orange, 0.15), p.white);
  }

  /**
   * 북쪽 "하늘 탑": 가운데 기둥(반지름 2.2m)을 감고 올라가는 떠 있는 둥근 발판 23개 (한 칸 0.7m씩, 틈 약 0.45m)
   * → 꼭대기 전망대(16.5m). 발판 사이 높이차·틈은 가장 느린 캐릭터의 걷기 점프로도 넘을 수 있는 값.
   * 떨어지면 아래 발판이나 바닥으로 (낙하 피해 없음)
   */
  private buildSkyTower(): void {
    const { x: cx, y, z: cz } = LobbySpace.CENTER;
    const p = ARENA.palette;
    const tx = cx + TOWER.x;
    const tz = cz + TOWER.z;
    // 가운데 기둥: 층마다 색이 바뀌는 원통 + 꼭대기 넓은 전망대
    const bands = [p.blue, p.yellow, p.pink, p.mint, p.lavender, p.orange];
    const bandH = TOWER.top / bands.length;
    // 기둥 띠는 따로 합침 (카메라를 가리면 반투명). 옆면만: 아래는 섬 바닥, 위는 전망대가 덮음
    bands.forEach((color, i) => this.pillarMerger.addBasic(this.unit.tube, trs(tx, y + bandH * (i + 0.5), tz, 0, [TOWER.r, bandH, TOWER.r]), lighten(color, 0.1)));
    this.prism(tx, tz, TOWER.r, y, y + TOWER.top, 20, '하늘 탑 기둥');
    this.pillarCollider = this.colliders[this.colliders.length - 1]!;
    this.cylinder(tx, y + TOWER.top - 0.175, tz, 3.2, 0.35, p.white);
    this.cylinder(tx, y + TOWER.top + 0.01, tz, 2.6, 0.02, lighten(p.yellow, 0.3));
    this.prism(tx, tz, 3.2, y + TOWER.top - 0.35, y + TOWER.top, 20, '하늘 탑 전망대');
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      this.cylinder(tx + Math.sin(a) * 3.05, y + TOWER.top + 0.25, tz + Math.cos(a) * 3.05, 0.07, 0.5, bands[i % bands.length]!, this.unit.post);
    }
    this.flag(tx, y + TOWER.top, tz, p.pink, 3);
    // 나선 발판 (남쪽에서 시작, 시계 반대 방향)
    const steps = 23;
    const ring = 4.2;
    const turn = THREE.MathUtils.degToRad(34);
    for (let i = 0; i < steps; i++) {
      const a = i * turn;
      const h = 0.6 + i * 0.7;
      const big = i % 6 === 5;
      const r = big ? 1.35 : 1.0;
      const px = tx + Math.sin(a) * ring;
      const pz = tz + Math.cos(a) * ring;
      const color = bands[i % bands.length]!;
      this.cylinder(px, y + h - 0.2, pz, r, 0.4, color);
      // 흰 원판은 윗면보다 살짝 위 (같은 높이면 면이 겹쳐 깜빡임)
      this.cylinder(px, y + h + 0.012, pz, r * 0.82, 0.024, p.white);
      this.prism(px, pz, r, y + h - 0.4, y + h, 14, '하늘 탑 발판');
      // 기둥과 잇는 팔 (장식, 충돌 없음)
      const armLen = ring - r - TOWER.r + 0.2;
      const armMid = TOWER.r + armLen / 2 - 0.1;
      this.boxMesh(tx + Math.sin(a) * armMid, y + h - 0.32, tz + Math.cos(a) * armMid, 0.22, 0.16, armLen, a, p.white);
    }
  }

  /** 북서쪽 언덕: 긴 경사로(26°)로 올라가는 2.4m 발판 + 낮은 블록 계단 */
  private buildRampHill(): void {
    const { x: cx, y, z: cz } = LobbySpace.CENTER;
    const p = ARENA.palette;
    this.block(cx - 12, cz - 13, 5, 5, 2.4, p.orange);
    this.ramp(cx - 7, cz - 13, 5, 2.4, 2.4, -Math.PI / 2, lighten(p.orange, 0.3));
    this.block(cx - 12, cz - 8.6, 2.2, 2.2, 0.6, p.blue);
    this.block(cx - 12, cz - 6.2, 2.2, 2.2, 1.2, p.mint);
    this.flag(cx - 13.5, y + 2.4, cz - 14.5, p.yellow, 1.8);
  }

  /** 동쪽: 슬라이딩 통로(안쪽 폭 1.8m, 천장 0.95m, 길이 6m) + 앞쪽 허들 2개(0.45m) */
  private buildSlideZone(): void {
    const { x: cx, y, z: cz } = LobbySpace.CENTER;
    const p = ARENA.palette;
    const tx = cx + 13;
    const tz = cz;
    const len = 6;
    const wallC = lighten(p.lavender, 0.05);
    for (const s of [-1, 1]) {
      // 벽은 천장 아래까지만 (천장 판과 면이 겹치면 깜빡임)
      this.boxMesh(tx + s * 1.15, y + 0.475, tz, 0.5, 0.95, len, 0, wallC);
      this.box(new THREE.Vector3(tx + s * 1.15, y + 0.625, tz), new THREE.Vector3(0.25, 0.625, len / 2), 0, '슬라이딩 통로 벽');
    }
    // 천장: 노랑·흰 줄무늬 판 (0.95~1.25m)
    for (let i = 0; i < 6; i++) {
      this.boxMesh(tx, y + 1.1, tz - len / 2 + (i + 0.5) * (len / 6), 2.96, 0.3, len / 6, 0, i % 2 ? p.white : p.yellow);
    }
    this.box(new THREE.Vector3(tx, y + 1.1, tz), new THREE.Vector3(1.4, 0.15, len / 2), 0, '슬라이딩 통로 천장');
    // 입구 표시 (바닥 화살표 대신 얇은 줄무늬)
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) this.boxMesh(tx, y + 0.015, tz + s * (len / 2 + 0.6 + i * 0.7), 1.6, 0.03, 0.3, 0, lighten(p.orange, 0.2));
    }
    this.lowBrick(tx, tz + 6.8, 0, p.pink);
    this.lowBrick(tx, tz + 9.4, 0, p.yellow);
    this.flag(tx + 2.2, y, tz - len / 2 - 0.6, p.mint, 1.6);
  }

  /** 서쪽 징검다리: 한 칸 0.6~0.7m씩 높아지는 둥근 기둥(0.6~4.0m, 틈 0.6~0.8m) → 목표 발판(4.6m) */
  private buildSteppingStones(): void {
    const { x: cx, y, z: cz } = LobbySpace.CENTER;
    const p = ARENA.palette;
    const stones: Array<[number, number, number, number]> = [
      [-9.0, 3.0, 0.6, p.blue],
      [-11.4, 4.6, 1.3, p.yellow],
      [-13.8, 3.2, 2.0, p.pink],
      [-16.2, 4.8, 2.7, p.mint],
      [-18.4, 3.0, 3.4, p.orange],
      [-19.6, 0.9, 4.0, p.lavender],
    ];
    for (const [x, z, h, color] of stones) {
      this.cylinder(cx + x, y + (h - 0.06) / 2, cz + z, 0.9, h - 0.06, color, this.unit.cylinder);
      this.cylinder(cx + x, y + h - 0.03, cz + z, 0.95, 0.06, p.white, this.unit.cylinder);
      this.prism(cx + x, cz + z, 0.95, y, y + h, 12, '징검다리 기둥');
    }
    this.block(cx - 21, cz - 1.6, 3, 3, 4.6, lighten(p.pink, 0.1));
    this.flag(cx - 21.8, y + 4.6, cz - 2.4, p.blue, 2.0);
  }

  /** 남쪽 좁은 다리(폭 1.2m, 바닥 높이) → 작은 섬 (나무·깃발). 다리 양옆은 막지 않음 (떨어지면 시작 지점) */
  private buildBridgeAndIslet(): void {
    const { x: cx, y, z: cz } = LobbySpace.CENTER;
    const p = ARENA.palette;
    const z0 = cz + R - 0.5;
    const z1 = cz + ISLET.z - ISLET.r + 0.5;
    const len = z1 - z0;
    const mid = (z0 + z1) / 2;
    for (let i = 0; i < Math.round(len / 0.8); i++) {
      const z = z0 + (i + 0.5) * (len / Math.round(len / 0.8));
      // 다리 판 윗면은 섬 바닥보다 1.2cm 위 (양 끝이 섬 위에 0.5m 걸쳐 있어 같은 높이면 면이 겹쳐 깜빡임)
      this.boxMesh(cx, y - 0.15 + 0.012, z, 1.2, 0.3, len / Math.round(len / 0.8) - 0.06, 0, i % 2 ? 0xf4e2c8 : 0xe9d1b0);
    }
    this.box(new THREE.Vector3(cx, y - 0.15, mid), new THREE.Vector3(0.6, 0.15, len / 2 + 0.5), 0, '로비 다리');
    for (const s of [-1, 1]) {
      for (let i = 0; i <= 4; i++) this.cylinder(cx + s * 0.7, y + 0.3, z0 + (i / 4) * len, 0.07, 0.6, p.white, this.unit.post);
    }
    // 작은 섬
    const iz = cz + ISLET.z;
    this.cylinder(cx, y - 0.3, iz, ISLET.r, 0.6, 0xf6efe4);
    this.cylinder(cx, y - 0.9, iz, ISLET.r - 0.6, 0.6, lighten(p.mint, 0.2));
    this.coneDown(cx, y - 2.6, iz, ISLET.r - 1.2, 2.8, lighten(p.lavender, 0.15));
    this.prism(cx, iz, ISLET.r, y - 0.6, y, 20, '작은 섬 바닥');
    this.ringFence(cx, iz, ISLET.r - 0.5, 20, 18, [p.mint, p.yellow, p.pink], Math.PI);
    this.tree(cx + 1.8, iz + 1.2, 3.2, p.pink);
    this.tree(cx - 2.0, iz + 0.4, 2.6, p.yellow);
    this.flag(cx, y, iz + 2.6, p.orange, 2.4);
  }

  /** 바깥 산책 구역 (반지름 20~27m): 막대사탕 나무·풍선 기둥. 코스·다리 방향은 비움 */
  private buildOuterRing(): void {
    const { x: cx, z: cz } = LobbySpace.CENTER;
    const p = ARENA.palette;
    const leaves = [p.pink, p.mint, p.yellow, p.lavender, p.orange, p.blue];
    const clear = (a: number, c: number, w: number) => Math.abs(Math.atan2(Math.sin(a - c), Math.cos(a - c))) < w;
    let li = 0;
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2 + 0.08;
      // 비울 방향: 남쪽 다리(0), 북쪽 코스(π), 서쪽 징검다리(-π/2), 동쪽 통로(π/2)
      if (clear(a, 0, 0.2) || clear(a, Math.PI, 0.55) || clear(a, -Math.PI / 2, 0.35) || clear(a, Math.PI / 2, 0.3)) continue;
      this.tree(cx + Math.sin(a) * 24.5, cz + Math.cos(a) * 24.5, 2.6 + (i % 3) * 0.5, leaves[li++ % leaves.length]!);
    }
    this.balloonPost(cx + Math.sin(2.4) * 23, cz + Math.cos(2.4) * 23, 1);
    this.balloonPost(cx + Math.sin(-2.4) * 23, cz + Math.cos(-2.4) * 23, 4);
    this.balloonPost(cx + Math.sin(0.6) * 23, cz + Math.cos(0.6) * 23, 2);
  }

  // ---------------- 조각 ----------------

  /** 상자 블록: 몸체 + 흰 덮개 (충돌 = 전체 높이) */
  private block(x: number, z: number, w: number, d: number, h: number, color: number): void {
    const y = LobbySpace.CENTER.y;
    this.boxMesh(x, y + (h - 0.08) / 2, z, w, h - 0.08, d, 0, color);
    this.boxMesh(x, y + h - 0.04, z, w + 0.06, 0.08, d + 0.06, 0, ARENA.palette.white);
    this.box(new THREE.Vector3(x, y + h / 2, z), new THREE.Vector3(w / 2 + 0.03, h / 2, d / 2 + 0.03), 0, '로비 블록');
  }

  /** 낮은 브릭 (경기장 낮은 엄폐물과 같은 2x4 플레이트 2장, 0.448m) */
  private lowBrick(x: number, z: number, rot: number, color: number): void {
    const y = LobbySpace.CENTER.y;
    const S = ARENA.brickScale;
    const plateH = ARENA.plateBodyHeight * S;
    if (this.kit) {
      this.addKit(this.kit.models.flat2x4, trs(x, y, z, rot, S), color);
      this.addKit(this.kit.models.plate2x4, trs(x, y + plateH, z, rot, S), color);
    } else {
      this.boxMesh(x, y + plateH, z, 0.32 * S, plateH * 2, 0.16 * S, rot, color);
    }
    this.box(new THREE.Vector3(x, y + plateH, z), new THREE.Vector3(0.16 * S, plateH, 0.08 * S), rot, '로비 낮은 브릭');
  }

  /** 경사로: dir = 올라가는 방향 (rad, atan2(x, z) 기준), base = 시작 높이(섬 바닥 기준). 충돌 = 매끈한 쐐기 */
  private ramp(x: number, z: number, length: number, width: number, h: number, dir: number, color: number, base = 0): void {
    const y = LobbySpace.CENTER.y + base;
    // 쐐기 지오메트리는 로컬 +x로 올라감 → yaw = dir − 90°
    const yaw = dir - Math.PI / 2;
    this.add(this.unit.wedge, trs(x, y, z, yaw, [length, h, width]), color);
    const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    const L = length / 2;
    const W = width / 2;
    const local = [[-L, 0, -W], [-L, 0, W], [L, 0, -W], [L, 0, W], [L, h, -W], [L, h, W]];
    const pts = new Float32Array(local.length * 3);
    const v = new THREE.Vector3();
    local.forEach(([lx, ly, lz], i) => {
      v.set(lx!, ly!, lz!).applyQuaternion(q);
      pts[i * 3] = v.x + x;
      pts[i * 3 + 1] = v.y + y;
      pts[i * 3 + 2] = v.z + z;
    });
    this.track(this.physics.addFixedConvex(pts), '로비 경사로');
  }

  /** 선물 상자: 정육면체 + 십자 리본 + 리본 매듭 */
  private gift(x: number, z: number, s: number, color: number, ribbon: number): void {
    const y = LobbySpace.CENTER.y;
    this.boxMesh(x, y + s / 2, z, s, s, s, 0.3, color);
    this.boxMesh(x, y + s / 2, z, s + 0.05, s + 0.05, s * 0.18, 0.3, ribbon);
    this.boxMesh(x, y + s / 2, z, s * 0.18, s + 0.05, s + 0.05, 0.3, ribbon);
    for (const sx of [-1, 1]) this.add(this.unit.sphere, trs(x + sx * s * 0.16, y + s + s * 0.1, z, 0.3, [s * 0.18, s * 0.12, s * 0.12]), ribbon);
    this.box(new THREE.Vector3(x, y + s / 2, z), new THREE.Vector3(s / 2, s / 2, s / 2), 0.3, '로비 선물 상자');
  }

  /** 막대사탕 나무 (줄기 충돌만) */
  private tree(x: number, z: number, h: number, leaf: number): void {
    const y = LobbySpace.CENTER.y;
    this.cylinder(x, y + h / 2, z, 0.14, h, 0xfffaf2, this.unit.post);
    this.add(this.unit.sphere, trs(x, y + h + 0.5, z, 0, 0.95), leaf);
    this.add(this.unit.sphere, trs(x, y + h + 0.5, z, 0, [0.6, 0.6, 1.02]), lighten(leaf, 0.4));
    this.box(new THREE.Vector3(x, y + h / 2, z), new THREE.Vector3(0.18, h / 2, 0.18), 0, '로비 나무');
  }

  /** 풍선 기둥 (3.2m 기둥 + 풍선 3개) */
  private balloonPost(x: number, z: number, colorStart: number): void {
    const y = LobbySpace.CENTER.y;
    const p = ARENA.palette;
    const colors = [p.pink, p.yellow, p.blue, p.mint, p.orange];
    this.cylinder(x, y + 1.6, z, 0.22, 3.2, 0xfffaf2, this.unit.post);
    this.box(new THREE.Vector3(x, y + 1.6, z), new THREE.Vector3(0.25, 1.6, 0.25), 0, '로비 풍선 기둥');
    const anchor = new THREE.Vector3(x, y + 3.2, z);
    for (let i = 0; i < 3; i++) {
      const b = (i / 3) * Math.PI * 2 + colorStart;
      balloon(this.merger, x + Math.sin(b) * 0.8, y + 5.4 + i * 0.5, z + Math.cos(b) * 0.8, 0.5, colors[(colorStart + i) % colors.length]!, anchor);
    }
  }

  /** 깃발 (키트 깃발 모델, 테스트 맵은 생략). 깃대는 얇은 충돌 상자 */
  private flag(x: number, y: number, z: number, color: number, scale: number): void {
    if (!this.kit) return;
    this.addKit(this.kit.models.flag, trs(x, y, z, Math.PI / 2, scale), color, true);
    this.box(new THREE.Vector3(x, y + scale / 2, z), new THREE.Vector3(0.08, scale / 2, 0.08), 0, '로비 깃대');
  }

  // ---------------- 도우미 ----------------

  private add(geo: THREE.BufferGeometry, matrix: THREE.Matrix4, color: number): void {
    if (!geo.boundingBox) geo.computeBoundingBox();
    this.merger.addBasic(geo, this.sinkBase(matrix, geo.boundingBox!), color);
  }

  private addKit(model: KitModel, matrix: THREE.Matrix4, color: number, swatch = false): void {
    _box.makeEmpty();
    for (const part of model.parts) {
      if (!part.geometry.boundingBox) part.geometry.computeBoundingBox();
      _box.union(_partBox.copy(part.geometry.boundingBox!).applyMatrix4(part.local));
    }
    this.merger.addKit(model, this.sinkBase(matrix, _box.clone()), color, swatch);
  }

  /** 밑면이 섬 바닥 높이(±3mm)인 물체: 윗면을 고정하고 세로로 늘려 밑면을 바닥 아래로 (BASE_SINK). 얇은 바닥 무늬는 그대로 */
  private sinkBase(matrix: THREE.Matrix4, localBox: THREE.Box3): THREE.Matrix4 {
    _box.copy(localBox).applyMatrix4(matrix);
    const floor = LobbySpace.CENTER.y;
    const h = _box.max.y - floor;
    if (Math.abs(_box.min.y - floor) > 0.003 || h < 0.05) return matrix;
    const top = _box.max.y;
    _sink.makeScale(1, (h + BASE_SINK) / h, 1).setPosition(0, top - (top * (h + BASE_SINK)) / h, 0);
    return _sink.clone().multiply(matrix);
  }

  /** 원기둥 (y = 가운데 높이) */
  private cylinder(x: number, y: number, z: number, r: number, h: number, color: number, geo = this.unit.cylinder): void {
    this.add(geo, trs(x, y, z, 0, [r, h, r]), color);
  }

  /** 아래를 향한 원뿔 (y = 가운데 높이) */
  private coneDown(x: number, y: number, z: number, r: number, h: number, color: number): void {
    this.add(this.unit.cone, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI), new THREE.Vector3(r, h, r)), color);
  }

  /** 상자 (y = 가운데 높이) */
  private boxMesh(x: number, y: number, z: number, w: number, h: number, d: number, rot: number, color: number): void {
    this.add(this.unit.box, trs(x, y, z, rot, [w, h, d]), color);
  }

  private box(center: THREE.Vector3, half: THREE.Vector3, rotY: number, label: string, movementOnly = false): void {
    const q = rotY ? new THREE.Quaternion().setFromAxisAngle(UP, rotY) : undefined;
    const col = this.track(this.physics.addFixedBox(center, half, q), label);
    if (movementOnly) this.physics.ignoreForQueries(col);
  }

  /** 세로 각기둥 충돌체 (원판·무대·기둥) */
  private prism(x: number, z: number, r: number, y0: number, y1: number, segs: number, label: string): void {
    const pts = new Float32Array(segs * 2 * 3);
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const px = x + Math.sin(a) * r;
      const pz = z + Math.cos(a) * r;
      pts.set([px, y0, pz, px, y1, pz], i * 6);
    }
    this.track(this.physics.addFixedConvex(pts), label);
  }

  private track(col: RAPIER.Collider, label: string): RAPIER.Collider {
    this.physics.setLabel(col, label);
    this.colliders.push(col);
    return col;
  }
}

/** 단위 쐐기 (1×1×1, 바닥 가운데 원점, 로컬 +x로 올라감) */
function wedgeGeometry(): THREE.BufferGeometry {
  const L = 0.5;
  const W = 0.5;
  const v = {
    a: [-L, 0, -W], b: [-L, 0, W], c: [L, 0, -W], d: [L, 0, W], e: [L, 1, -W], f: [L, 1, W],
  } as const;
  const tris: Array<readonly (readonly number[])[]> = [
    [v.a, v.c, v.b], [v.b, v.c, v.d], // 바닥
    [v.a, v.b, v.f], [v.a, v.f, v.e], // 경사면
    [v.c, v.e, v.f], [v.c, v.f, v.d], // 높은 쪽 벽
    [v.a, v.e, v.c], // 옆면
    [v.b, v.d, v.f],
  ];
  const pos = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => t.forEach((p, j) => pos.set(p, i * 9 + j * 3)));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
