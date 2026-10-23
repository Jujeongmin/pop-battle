// 결과 화면 3D 무대: 경기장 대신 따로 그리는 작은 장면 (하늘 배경·바닥·시상대·캐릭터 최대 4명·색종이). 8인 경기는 무대에 상위 4명(TDM은 팀마다 2명), 전체 기록은 스코어보드.
// 캐릭터는 게임이 이미 불러온 GLB 캐시를 복제하고 대기 클립 위에 본 회전(월드 축 기준)으로 순위별 자세를 얹는다:
// 1위·TDM 승리 = 짧은 점프 등장 → 한 팔 번쩍 + 반대 손 허리, 2위 = 손 들어 두 번 흔든 뒤 유지, 3위 = 양손 허리,
// 꼴찌·TDM 패배 = 고개·어깨 떨굼, 무승부 = 대기. 1~2초 안에 자세를 잡고 숨쉬기 정도만 움직임 (반복 점프·팔 휘젓기 없음).
// 전용 승리/패배 애니메이션 클립은 GLB에 없음 → 클립이 생기면 pose()만 교체.
// 무대가 떠 있는 동안 게임은 경기장 대신 이 장면을 그리고(Game.loop), 닫으면 무대 전용 리소스를 모두 해제한다 (GLB 캐시는 그대로).
import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { LoadedModel } from '../assets/loadAssets';
import { CHARACTERS, type CharacterId } from '../config/characters';
import { CHARACTER } from '../config/gameConfig';
import { CharacterAppearance, loadTeamMask } from '../player/CharacterAppearance';
import { measureBindHeight } from '../player/PlayerAvatar';
import { rotateBoneToward, setWorldQuaternion } from '../player/ik';
import type { ResultData, ResultEntry } from './resultData';

/** champion = 1위·TDM 승리, second = 2위, third = 3위, defeat = 꼴찌·TDM 패배, neutral = 무승부 */
type Pose = 'champion' | 'second' | 'third' | 'defeat' | 'neutral';

interface Slot {
  entry: ResultEntry;
  /** 실제 x (화면이 낮으면 카드가 겹치지 않게 기본 배치 bx보다 넓힘) */
  x: number;
  bx: number;
  z: number;
  scale: number;
  /** 시상대 높이 (m) */
  podium: number;
  color: number;
  pose: Pose;
  /** 등장 순서 지연 (s) */
  delay: number;
  /** 앞줄 (이긴 팀·1~3위) — 카드 크기 */
  front: boolean;
}

interface Figure {
  slot: Slot;
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  bones: Record<'hips' | 'spine' | 'chest' | 'upperArmL' | 'lowerArmL' | 'handL' | 'upperArmR' | 'lowerArmR' | 'handR', THREE.Bone>;
  /** 서 있는 키 (m, 무대 배율 전) */
  height: number;
  phase: number;
  /** 등장 팝 0..1 */
  pop: number;
  hop: number;
  /** 대기 자세 실제 최저점(발바닥)을 시상대 윗면에 맞추는 높이 (m, 자리 배율 1 기준) — 모델마다 발끝 위치가 다름 */
  ground: number;
}

/** 화면 좌표 (px, 무대 캔버스 기준) — DOM 카드·왕관 배치용 */
export interface StageAnchor {
  entry: ResultEntry;
  front: boolean;
  /** 등장 정도 0..1 (카드도 같이 나타남) */
  shown: number;
  headX: number;
  headY: number;
  footX: number;
  footY: number;
}

const UP = new THREE.Vector3(0, 1, 0);
/** 블록 시상대 바닥 크기 (m, 자리 배율 1 기준): 가로 · 앞뒤 */
const BLOCK_W = 1.0;
const BLOCK_D = 0.86;
/** 블록 한 층 목표 높이 (시상대 높이를 이 높이 근처로 나눠 쌓음) */
const BLOCK_LAYER = 0.2;
/** 순위별 시상대 높이 (1~4위) */
const FFA_PODIUM_HEIGHTS = [0.6, 0.42, 0.28, 0.16];
/** 파스텔 노랑(1위) · 하늘 · 코랄 · 민트 */
const FFA_PODIUM_COLORS = [0xffd45e, 0x9cc4ff, 0xff9f8a, 0x8fe0c4];
const TEAM_PODIUM: Record<'BLUE' | 'RED', number> = { BLUE: 0x8fb6ff, RED: 0xff9aa6 };
const INK = '#27325c';
const CONFETTI_COLORS = [0xffd45e, 0xff8fb4, 0x6f9bff, 0x68cfac, 0xffb27a, 0xffffff];
const CONFETTI_COUNT = 70;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _h = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _out = new THREE.Vector3();
const _out2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _dir2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

function easeOutBack(t: number): number {
  const c = 1.9;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/** 배치: FFA = 1위 가운데·2위 왼쪽·3위 오른쪽·4위 오른쪽 바깥, TDM = 이긴 팀 앞 가운데·진 팀 뒤 양옆 (무승부는 팀별 좌우) */
function layout(data: ResultData): Array<Omit<Slot, 'bx'>> {
  const list = data.entries.slice(0, 4);
  if (data.layout === 'ffa') {
    const spots = [
      { x: 0, z: 0.35, scale: 1.12 },
      { x: -1.55, z: 0, scale: 1 },
      { x: 1.55, z: 0, scale: 1 },
      { x: 2.95, z: -0.55, scale: 0.84 },
    ];
    // 무리 전체를 화면 가운데로 (4명이면 4위가 오른쪽에만 있어 1위 기준이면 오른쪽으로 치우침)
    const used = spots.slice(0, list.length).map((s) => s.x);
    const shift = -(Math.min(...used) + Math.max(...used)) / 2;
    return list.map((entry, i) => ({
      entry,
      ...spots[i]!,
      x: spots[i]!.x + shift,
      podium: FFA_PODIUM_HEIGHTS[Math.min(3, entry.rank - 1)]!,
      color: FFA_PODIUM_COLORS[Math.min(3, entry.rank - 1)]!,
      pose: ffaPose(entry.rank, list.length),
      delay: 0.25 + (list.length - 1 - i) * 0.18,
      front: i < 3,
    }));
  }
  // TDM: 팀마다 순위 순서로 2명씩 (상위 4명만 고르면 한 팀만 무대에 오를 수 있음)
  const all = data.entries;
  const team = (e: ResultEntry) => e.team ?? 'BLUE';
  if (data.draw || !data.winnerTeam) {
    const blue = all.filter((e) => team(e) === 'BLUE');
    const red = all.filter((e) => team(e) !== 'BLUE');
    const xs = [-2.15, -0.8, 0.8, 2.15];
    return [...blue.slice(0, 2).map((e, i) => ({ e, x: xs[1 - i]! })), ...red.slice(0, 2).map((e, i) => ({ e, x: xs[2 + i]! }))].map(({ e, x }, i) => ({
      entry: e,
      x,
      z: 0,
      scale: 1,
      podium: 0.28,
      color: TEAM_PODIUM[team(e)],
      pose: 'neutral' as const,
      delay: 0.25 + i * 0.15,
      front: true,
    }));
  }
  const win = all.filter((e) => team(e) === data.winnerTeam);
  const lose = all.filter((e) => team(e) !== data.winnerTeam);
  return [
    ...lose.slice(0, 2).map((entry, i) => ({ entry, x: i === 0 ? -2.6 : 2.6, z: -0.75, scale: 0.82, podium: 0.16, pose: 'defeat' as const, delay: 0.25 + i * 0.15, front: false })),
    ...win.slice(0, 2).map((entry, i) => ({ entry, x: i === 0 ? -0.8 : 0.8, z: 0.35, scale: 1.1, podium: 0.42, pose: 'champion' as const, delay: 0.7 + i * 0.15, front: true })),
  ].map((s) => ({ ...s, color: TEAM_PODIUM[team(s.entry)] }));
}

/** FFA 순위 → 자세 (공동 순위는 같은 자세, 혼자면 1위 자세). 마지막 순위는 2명 이상일 때만 패배 자세 */
function ffaPose(rank: number, count: number): Pose {
  if (rank === 1) return 'champion';
  if (rank >= count && count > 1) return 'defeat';
  return rank === 2 ? 'second' : 'third';
}

/** 머리 위 여유 (m): 이름표가 올린 손·등장 점프에 걸리지 않는 높이. 이름표 위치와 카메라 맞춤이 같이 씀 */
function headClearance(s: Slot): number {
  return ({ champion: 0.34, second: 0.2, third: 0.12, defeat: 0.1, neutral: 0.12 } as const)[s.pose] * s.scale;
}

/** 0..1 부드럽게 (자세 섞기) */
function smooth(t: number): number {
  const u = THREE.MathUtils.clamp(t, 0, 1);
  return u * u * (3 - 2 * u);
}

/** 시상대 앞면 순위 숫자 (흰 글자 + 잉크 외곽선, 투명 바탕) */
function rankTexture(rank: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.font = "400 112px 'POP Jua', sans-serif";
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 16;
  g.strokeStyle = INK;
  g.strokeText(String(rank), 64, 70);
  g.fillStyle = '#ffffff';
  g.fillText(String(rank), 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class ResultStage {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(28, 16 / 9, 0.1, 80);
  private slots: Slot[] = [];
  private figures: Figure[] = [];
  /** 자리별 시상대 묶음 (가로 간격을 바꿀 때 같이 옮김) */
  private podiums = new Map<Slot, THREE.Group>();
  /** 무대 전용 리소스 (닫을 때 해제). 캐릭터 GLB 지오메트리·텍스처는 캐시 공유라 넣지 않음 */
  private disposables: Array<{ dispose(): void }> = [];
  private confetti: THREE.InstancedMesh | null = null;
  /** 시상대 돌기 (자리 간격이 바뀌면 다시 배치) */
  private studs: THREE.InstancedMesh | null = null;
  private studSpots: Array<{ slot: Slot; fx: number; fz: number; y: number }> = [];
  /** 시상대 앞면에 순위 숫자 (FFA만, TDM은 팀 색 시상대) */
  private rankLabels = false;
  private confettiState: Float32Array = new Float32Array(0);
  private time = 0;
  private token = 0;
  private aspect = 16 / 9;
  private readonly camFrom = new THREE.Vector3();
  private readonly camTo = new THREE.Vector3();
  private readonly lookAt = new THREE.Vector3();
  /** 캐릭터가 들어갈 화면 세로 구간 (px, 제목 아래 ~ 카드 위). 없으면 화면 가운데 절반 */
  private band: { top: number; bottom: number; height: number; gap: number } | null = null;

  constructor(private readonly loadCharacter: (id: CharacterId) => Promise<LoadedModel>) {}

  /** 무대 만들기 (캐릭터 불러오기 포함). 도중에 clear·다시 build되면 false */
  async build(data: ResultData): Promise<boolean> {
    this.clear();
    const token = ++this.token;
    const slots = layout(data).map((s) => ({ ...s, bx: s.x }));
    const tdm = data.layout === 'tdm';
    const loaded = await Promise.all(
      slots.map(async (slot) => {
        try {
          const def = CHARACTERS[slot.entry.char];
          const [model, mask] = await Promise.all([this.loadCharacter(slot.entry.char), tdm ? loadTeamMask(def) : Promise.resolve(null)]);
          return { slot, model, mask };
        } catch (err) {
          // 캐릭터 하나가 실패해도 나머지 무대는 그대로 (카드는 표시)
          console.warn('[result] 캐릭터를 불러오지 못함', slot.entry.char, err);
          return null;
        }
      }),
    );
    // 시상대 숫자는 Jua로 캔버스에 그림 → 글꼴이 준비된 뒤 (실패해도 기본 글꼴로 진행)
    await document.fonts?.load("400 112px 'POP Jua'").catch(() => undefined);
    if (token !== this.token) return false;
    this.slots = slots;
    this.rankLabels = !tdm;
    this.buildSet(slots);
    for (const l of loaded) if (l) this.figures.push(this.makeFigure(l.slot, l.model, l.mask, tdm));
    // 1위·이긴 쪽이 있으면 색종이
    if (data.entries.some((e) => e.win)) this.makeConfetti();
    this.time = 0;
    this.fitCamera();
    this.update(0);
    return true;
  }

  /** 무대 비우기: 캐릭터·시상대·배경·색종이 해제 (GLB 캐시는 남김) */
  clear(): void {
    this.token++;
    for (const f of this.figures) {
      f.mixer.stopAllAction();
      f.mixer.uncacheRoot(f.root);
    }
    this.figures = [];
    this.slots = [];
    this.podiums.clear();
    this.confetti = null;
    this.studs = null;
    this.studSpots = [];
    this.scene.clear();
    this.scene.background = null;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  resize(width: number, height: number): void {
    this.aspect = width / Math.max(1, height);
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
    if (this.slots.length > 0) this.fitCamera();
  }

  /** 캐릭터(시상대 바닥 ~ 머리 위 왕관 자리)를 화면의 이 세로 구간에 맞춤 (DOM 제목·카드·버튼 실측값) */
  setBand(top: number, bottom: number, height: number, gap: number): void {
    this.band = { top, bottom: Math.max(top + 40, bottom), height, gap };
    if (this.slots.length > 0) this.fitCamera();
  }

  update(dt: number): void {
    this.time += dt;
    const t = this.time;
    // 카메라: 살짝 멀리·위에서 다가오며 자리 잡기
    const k = easeOutCubic(Math.min(1, t / 1.3));
    this.camera.position.lerpVectors(this.camFrom, this.camTo, k);
    this.camera.lookAt(this.lookAt);
    this.camera.updateMatrixWorld();
    for (const f of this.figures) {
      const s = f.slot;
      const p = THREE.MathUtils.clamp((t - s.delay) / 0.5, 0, 1);
      f.pop = p;
      const pop = p <= 0 ? 0 : easeOutBack(p);
      f.root.visible = p > 0;
      f.root.scale.setScalar(Math.max(0.001, s.scale * pop));
      // 1위: 등장 직후 한 번만 짧게 점프 (0.45초) → 이후 발은 시상대 윗면
      const lt = t - s.delay - 0.35;
      f.hop = s.pose === 'champion' && lt > 0 && lt < 0.45 ? Math.sin((lt / 0.45) * Math.PI) * 0.2 * s.scale : 0;
      f.root.position.y = s.podium + f.ground * s.scale * pop + f.hop;
      f.mixer.update(dt);
      f.root.updateMatrixWorld(true);
      this.pose(f, t - s.delay);
    }
    this.updateConfetti(dt);
  }

  /** 참가자별 화면 좌표 (px). 카드·왕관·MVP 표시용 (캐릭터를 못 불러온 자리도 시상대 기준으로) */
  anchors(width: number, height: number): StageAnchor[] {
    const out: StageAnchor[] = [];
    for (const s of this.slots) {
      const f = this.figures.find((x) => x.slot === s);
      const shown = f ? f.pop : THREE.MathUtils.clamp((this.time - s.delay) / 0.5, 0, 1);
      const pop = shown <= 0 ? 0 : easeOutBack(shown);
      const h = (f?.height ?? CHARACTER.scale) * s.scale * pop;
      // 이름표 기준점: 머리 위 + 자세별 여유 (카메라 맞춤과 같은 값 → 결과판·버튼과 겹치지 않음)
      _a.set(s.x, s.podium + h + headClearance(s) * pop, s.z).project(this.camera);
      _b.set(s.x, 0, s.z + (BLOCK_D / 2) * s.scale).project(this.camera);
      out.push({
        entry: s.entry,
        front: s.front,
        shown,
        headX: ((_a.x + 1) / 2) * width,
        headY: ((1 - _a.y) / 2) * height,
        footX: ((_b.x + 1) / 2) * width,
        footY: ((1 - _b.y) / 2) * height,
      });
    }
    return out;
  }

  render(renderer: THREE.WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.clear();
  }

  // ---------------------------------------------------------------- 무대 만들기

  private own<T extends { dispose(): void }>(x: T): T {
    this.disposables.push(x);
    return x;
  }

  private buildSet(slots: readonly Slot[]): void {
    const scene = this.scene;
    // 하늘 그라데이션 (작은 캔버스 텍스처)
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 256;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#9fd2ff');
    grad.addColorStop(0.55, '#d6ecff');
    grad.addColorStop(1, '#fff3dc');
    g.fillStyle = grad;
    g.fillRect(0, 0, 2, 256);
    const sky = this.own(new THREE.CanvasTexture(c));
    sky.colorSpace = THREE.SRGBColorSpace;
    scene.background = sky;

    scene.add(new THREE.HemisphereLight(0xffffff, 0xb9c2e6, 2.2));
    // 그림자는 키 조명 하나 (작은 맵, 무대 범위만)
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(2.5, 6, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const sc = key.shadow.camera;
    sc.left = -5;
    sc.right = 5;
    sc.top = 4;
    sc.bottom = -3;
    sc.near = 1;
    sc.far = 18;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.02;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xfff1dc, 0.9);
    rim.position.set(-3, 3, -4);
    scene.add(rim);

    // 바닥 원판 + 바깥 고리 (장난감 매트)
    const floor = new THREE.Mesh(this.own(new THREE.CircleGeometry(16, 64)), this.own(new THREE.MeshStandardMaterial({ color: 0xffe6bf, roughness: 0.85 })));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const ring = new THREE.Mesh(this.own(new THREE.RingGeometry(4.4, 4.75, 64)), this.own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 })));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.004;
    scene.add(ring);

    // 뒤쪽 파스텔 풍선 (깊이감, 낮은 분할)
    const ball = this.own(new THREE.SphereGeometry(1, 20, 14));
    const balls: Array<[number, number, number, number, number]> = [
      [-6.4, 1.2, -6, 0.8, 0xffc7dc],
      [-4.6, 2.9, -9, 0.65, 0xffe08a],
      [4.8, 2.6, -8.5, 0.7, 0xc6f0dc],
      [6.6, 1.0, -6.5, 0.85, 0xffd2b0],
    ];
    for (const [x, y, z, r, color] of balls) {
      const m = new THREE.Mesh(ball, this.own(new THREE.MeshStandardMaterial({ color, roughness: 0.5 })));
      m.position.set(x, y, z);
      m.scale.setScalar(r);
      scene.add(m);
    }

    this.buildPodiums(slots);
  }

  /**
   * 조립 블록 시상대: 둥근 모서리 블록을 층층이 쌓고(층마다 밝기 교차) 맨 위 가장자리에 원형 돌기 8개
   * (가운데는 비워 캐릭터 발이 윗면에 닿음), 앞면에 순위 숫자. 메시 수를 줄이려고 돌기는 무대 전체에서 InstancedMesh 하나
   */
  private buildPodiums(slots: readonly Slot[]): void {
    const scene = this.scene;
    const mats = new Map<number, THREE.MeshStandardMaterial>();
    const mat = (color: number) => {
      let m = mats.get(color);
      if (!m) {
        m = this.own(new THREE.MeshStandardMaterial({ color, roughness: 0.42 }));
        mats.set(color, m);
      }
      return m;
    };
    const geos = new Map<string, THREE.BufferGeometry>();
    const block = (w: number, h: number, d: number) => {
      const key = `${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}`;
      let g = geos.get(key);
      if (!g) {
        g = this.own(new RoundedBoxGeometry(w, h, d, 2, Math.min(0.05, h * 0.3)));
        geos.set(key, g);
      }
      return g;
    };
    const studSpots: Array<[number, number]> = [];
    for (const ix of [-1, 0, 1]) for (const iz of [-1, 0, 1]) if (ix || iz) studSpots.push([ix * 0.33, iz * 0.32]);
    const studGeo = this.own(new THREE.CylinderGeometry(0.085, 0.085, 0.07, 14));
    const studMat = this.own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }));
    const studs = new THREE.InstancedMesh(studGeo, studMat, slots.length * studSpots.length);
    this.own({ dispose: () => studs.dispose() });
    studs.castShadow = true;
    studs.receiveShadow = true;
    const color = new THREE.Color();
    const white = new THREE.Color(0xffffff);
    let n = 0;
    for (const s of slots) {
      const S = s.scale;
      const w = BLOCK_W * S;
      const d = BLOCK_D * S;
      const h = Math.max(0.1, s.podium);
      const group = new THREE.Group();
      group.position.set(s.x, 0, s.z);
      const layers = Math.max(1, Math.round(h / BLOCK_LAYER));
      const lh = h / layers;
      // 아래층은 원래 색, 위로 갈수록 한 단계씩 밝게 (층 사이 틈 0.012 → 쌓은 블록처럼 보임)
      for (let i = 0; i < layers; i++) {
        const c = color.setHex(s.color).lerp(white, i % 2 ? 0.22 : 0);
        const m = i % 2 ? mat(c.getHex()) : mat(s.color);
        const mesh = new THREE.Mesh(block(w, lh - 0.012, d), m);
        mesh.position.y = lh * i + lh / 2;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      }
      // 돌기: 맨 위층 색과 같게, 윗면 가장자리
      color.setHex(s.color).lerp(white, (layers - 1) % 2 ? 0.22 : 0);
      for (const [fx, fz] of studSpots) {
        this.studSpots.push({ slot: s, fx: fx * w, fz: fz * d, y: h + 0.025 });
        studs.setColorAt(n, color);
        n++;
      }
      // 앞면 순위 숫자 (FFA)
      if (this.rankLabels) {
        const size = Math.min(0.34, h * 0.78) * S;
        const plate = new THREE.Mesh(this.own(new THREE.PlaneGeometry(size, size)), this.own(new THREE.MeshBasicMaterial({ map: this.own(rankTexture(s.entry.rank)), transparent: true, depthWrite: false })));
        plate.position.set(0, h / 2, d / 2 + 0.004);
        group.add(plate);
      }
      scene.add(group);
      this.podiums.set(s, group);
    }
    studs.count = n;
    if (studs.instanceColor) studs.instanceColor.needsUpdate = true;
    this.studs = studs;
    this.placeStuds();
    scene.add(studs);
  }

  /** 돌기 위치 = 자리 x (가로 간격을 바꾸면 다시) */
  private placeStuds(): void {
    const studs = this.studs;
    if (!studs) return;
    this.studSpots.forEach((p, i) => {
      _m.compose(_a.set(p.slot.x + p.fx, p.y, p.slot.z + p.fz), _q.identity(), _s.setScalar(p.slot.scale));
      studs.setMatrixAt(i, _m);
    });
    studs.instanceMatrix.needsUpdate = true;
  }

  private makeFigure(slot: Slot, model: LoadedModel, mask: THREE.Texture | null, tdm: boolean): Figure {
    const def = CHARACTERS[slot.entry.char];
    const scene = SkeletonUtils.clone(model.scene);
    const meshes: THREE.Mesh[] = [];
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // 공유 지오메트리에 사망 눈 모프가 붙어 있으면 복제 메시에도 영향도 배열 필요 (없으면 렌더러 오류)
      if (!mesh.morphTargetInfluences && mesh.geometry.morphAttributes.position?.length) mesh.updateMorphTargets();
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      if (tdm) {
        // 팀 색 셰이더는 머티리얼에 붙으므로 복제본에만 (캐시 원본·게임 아바타에 영향 없음)
        mesh.material = this.own((mesh.material as THREE.Material).clone());
        meshes.push(mesh);
      }
    });
    if (tdm && mask && slot.entry.team) new CharacterAppearance(meshes, slot.entry.char, mask).apply({ mode: 'TDM', team: slot.entry.team });
    const bodyScale = (CHARACTER.scale * def.body.height) / measureBindHeight(scene);
    scene.scale.setScalar(bodyScale);
    scene.rotation.y = CHARACTER.modelYawOffset;
    const root = new THREE.Group();
    root.add(scene);
    root.position.set(slot.x, slot.podium, slot.z);
    // 카메라 쪽을 보되 가운데로 살짝 돌림
    root.rotation.y = -slot.x * 0.09;
    root.visible = false;
    this.scene.add(root);

    const bone = (name: string) => scene.getObjectByName(name) as THREE.Bone;
    const B = CHARACTER.bones;
    const mixer = new THREE.AnimationMixer(scene);
    const idle = model.clips.find((c) => c.name === CHARACTER.clips.idle);
    if (idle) {
      const a = mixer.clipAction(idle);
      a.time = Math.random() * idle.duration;
      a.timeScale = slot.pose === 'defeat' ? 0.7 : 1;
      a.play();
    }
    // 발 맞춤: 대기 자세 한 프레임에서 스킨 메시 실제 최저점 (정점 일부 표본) → 시상대 윗면에 닿게
    root.scale.setScalar(slot.scale);
    mixer.update(0);
    root.updateMatrixWorld(true);
    let minY = Infinity;
    const v = new THREE.Vector3();
    scene.traverse((o) => {
      const sk = o as THREE.SkinnedMesh;
      if (!sk.isSkinnedMesh) return;
      const pos = sk.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i += 5) minY = Math.min(minY, sk.localToWorld(sk.getVertexPosition(i, v)).y);
    });
    const ground = Number.isFinite(minY) ? (slot.podium - minY) / slot.scale : 0;
    root.scale.setScalar(1);
    return {
      slot,
      root,
      mixer,
      bones: {
        hips: bone(B.hips),
        spine: bone(B.spine),
        chest: bone(B.chest),
        upperArmL: bone(B.upperArmL),
        lowerArmL: bone(B.lowerArmL),
        handL: bone(B.handL),
        upperArmR: bone(B.upperArmR),
        lowerArmR: bone(B.lowerArmR),
        handR: bone(B.handR),
      },
      height: CHARACTER.scale * def.body.height,
      phase: Math.random() * Math.PI,
      pop: 0,
      hop: 0,
      ground,
    };
  }

  private makeConfetti(): void {
    const geo = this.own(new THREE.PlaneGeometry(0.07, 0.11));
    const mat = this.own(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    const mesh = new THREE.InstancedMesh(geo, mat, CONFETTI_COUNT);
    this.own({ dispose: () => mesh.dispose() });
    const color = new THREE.Color();
    // x, y, z, 낙하 속도, 회전 속도, 흔들림 위상
    const st = new Float32Array(CONFETTI_COUNT * 6);
    for (let i = 0; i < CONFETTI_COUNT; i++) {
      st.set([(Math.random() - 0.5) * 7, 2 + Math.random() * 4.5, (Math.random() - 0.5) * 2.5 + 0.4, 0.7 + Math.random() * 0.7, 2 + Math.random() * 5, Math.random() * 6.28], i * 6);
      mesh.setColorAt(i, color.setHex(CONFETTI_COLORS[i % CONFETTI_COLORS.length]!));
    }
    mesh.frustumCulled = false;
    this.confetti = mesh;
    this.confettiState = st;
    this.scene.add(mesh);
  }

  private updateConfetti(dt: number): void {
    const mesh = this.confetti;
    if (!mesh) return;
    const st = this.confettiState;
    const t = this.time;
    // 승자 등장 뒤부터 떨어짐
    const live = t > 0.9;
    for (let i = 0; i < CONFETTI_COUNT; i++) {
      const o = i * 6;
      if (live) st[o + 1] = st[o + 1]! - st[o + 3]! * dt;
      if (st[o + 1]! < -0.1) st[o + 1] = 4.5 + Math.random() * 1.5;
      const y = live ? st[o + 1]! : 99;
      _e.set(t * st[o + 4]!, t * st[o + 4]! * 0.6, st[o + 5]!);
      _q.setFromEuler(_e);
      _a.set(st[o]! + Math.sin(t * 1.7 + st[o + 5]!) * 0.18, y, st[o + 2]!);
      mesh.setMatrixAt(i, _m.compose(_a, _q, _s.set(1, 1, 1)));
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * 등장 인원·화면 비율에 맞춰 카메라: 가로는 양끝 캐릭터, 세로는 캐릭터 무리(바닥~머리+점프)가 band 구간에 들어가게.
   * 둘 중 더 먼 거리를 쓰고, 무리 가운데가 band 가운데에 오도록 바라보는 높이를 옮김
   */
  private fitCamera(): void {
    const top = Math.max(...this.slots.map((s) => s.podium + CHARACTER.scale * 1.1 * s.scale)) + 0.2;
    const vHalf = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const tanH = Math.tan(vHalf) * this.aspect;
    const band = this.band ?? { top: 0.25, bottom: 0.75, height: 1, gap: 0 };
    const frac = THREE.MathUtils.clamp((band.bottom - band.top) / band.height, 0.2, 0.9);
    const halfWidth = (spread: number) => Math.max(2.2, ...this.slots.map((s) => Math.abs(s.bx) * spread + 0.7 * s.scale));
    // 앞줄 시상대 앞면이 더 가까워 아래로 퍼지는 몫 (약 10%) 여유
    const distH = (top * 1.1) / frac / (2 * Math.tan(vHalf));
    // 세로가 기준이면(낮은 화면) 남는 가로 폭만큼 자리 간격을 넓혀 카드(gap px)가 겹치지 않게
    const xs = [...new Set(this.slots.map((s) => s.bx))].sort((a, b) => a - b);
    let minStep = Infinity;
    for (let i = 1; i < xs.length; i++) minStep = Math.min(minStep, xs[i]! - xs[i - 1]!);
    const pxPerM = band.height / (2 * distH * Math.tan(vHalf));
    let spread = Number.isFinite(minStep) && band.gap > 0 ? Math.max(1, band.gap / (minStep * pxPerM)) : 1;
    // 화면 가로를 넘지 않는 만큼만
    spread = Math.min(spread, Math.max(1, (distH * tanH - 0.7) / Math.max(...this.slots.map((s) => Math.abs(s.bx)), 0.01)));
    const minDist = halfWidth(spread) / tanH;
    let dist = Math.max(distH, minDist);
    for (const s of this.slots) {
      s.x = s.bx * spread;
      this.podiums.get(s)?.position.setX(s.x);
    }
    this.placeStuds();
    for (const f of this.figures) {
      f.root.position.x = f.slot.x;
      f.root.rotation.y = -f.slot.x * 0.09;
    }
    let visH = 2 * dist * Math.tan(vHalf);
    const bandCenter = (band.top + band.bottom) / 2 / band.height;
    let lookY = top / 2 + (bandCenter - 0.5) * visH;
    // 실제 투영으로 맞춤: 머리(+손·이름표 기준점)가 구간 위, 앞줄 시상대 앞면 아래끝이 구간 아래(버튼 위)에 들어오게.
    // 넘치면 거리를 늘리고, 들어가면 가운데를 맞춤 (원근 때문에 앞줄은 더 아래로, 뒷줄은 더 위로 보임)
    if (this.band) {
      for (let it = 0; it < 5; it++) {
        this.camera.position.set(0, lookY + dist * 0.08, dist);
        this.camera.lookAt(0, lookY, 0);
        this.camera.updateMatrixWorld();
        let yHead = Infinity;
        let yFoot = -Infinity;
        for (const s of this.slots) {
          const h = this.figures.find((f) => f.slot === s)?.height ?? CHARACTER.scale;
          _a.set(s.x, s.podium + h * s.scale + headClearance(s), s.z).project(this.camera);
          yHead = Math.min(yHead, ((1 - _a.y) / 2) * band.height);
          _a.set(s.x, 0, s.z + (BLOCK_D / 2) * s.scale).project(this.camera);
          yFoot = Math.max(yFoot, ((1 - _a.y) / 2) * band.height);
        }
        const span = yFoot - yHead;
        const want = band.bottom - band.top;
        if (span > want + 1) {
          dist *= (span / want) * 1.02;
          visH = 2 * dist * Math.tan(vHalf);
          continue;
        }
        const off = (yHead + yFoot) / 2 - (band.top + band.bottom) / 2;
        if (Math.abs(off) < 0.5) break;
        lookY -= (off / band.height) * visH;
      }
    }
    this.lookAt.set(0, lookY, 0);
    this.camTo.set(0, lookY + dist * 0.08, dist);
    this.camFrom.set(0, lookY + dist * 0.2, dist * 1.18);
  }

  // ---------------------------------------------------------------- 자세

  /**
   * 대기 클립 위에 자세 덧입히기 (월드 축 기준 → 캐릭터마다 본 축이 달라도 같은 모양). lt = 등장 후 시간 (s).
   * 팔은 몸 바깥·앞쪽으로만 향하게 해 몸통을 뚫지 않음, 몸통은 작은 각도만 (고개는 Spine 가중치라 몸통과 같이 기울어짐)
   */
  private pose(f: Figure, lt: number): void {
    if (lt <= 0) return;
    const b = f.bones;
    const yaw = f.root.rotation.y;
    _fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
    // 앞으로 숙이는 축 (UP × 앞)
    _axis.crossVectors(UP, _fwd).normalize();
    // 화면 바깥쪽 팔 (가운데 1위를 가리지 않게): 화면 왼쪽 자리 = 캐릭터 오른팔
    const outer: 'L' | 'R' = f.slot.x <= 0 ? 'R' : 'L';
    const inner: 'L' | 'R' = outer === 'R' ? 'L' : 'R';
    const lean = outer === 'R' ? 1 : -1;
    // 숨쉬기 (아주 작게)
    const breath = Math.sin((lt + f.phase) * 2.1) * 0.012;
    switch (f.slot.pose) {
      case 'champion': {
        // 점프 착지(0.8초) 무렵 자세 완성: 두 팔 V자로 번쩍 + 가슴 펴기, 이후 고정 (흔들지 않음)
        // 치비 비율(큰 머리·짧은 팔)이라 한 팔만 올리면 머리에 가려 → 양팔을 바깥으로 벌린 V
        const w = smooth((lt - 0.2) / 0.6);
        this.bend(b.spine, _axis, (-0.12 + breath) * w);
        this.bend(b.spine, _fwd, 0.04 * lean * w);
        this.arm(outer, f, [0.95, 1, 0.3], [0.55, 1, 0.3], w);
        this.arm(inner, f, [0.95, 1, 0.3], [0.55, 1, 0.3], w);
        break;
      }
      case 'second': {
        // 손 들어 두 번 흔들기 (1.4초에 멈춤) → 손 든 채 유지, 고개는 손 쪽으로
        const w = smooth(lt / 0.5);
        const wave = Math.sin(lt * 9) * 0.5 * (1 - smooth((lt - 0.4) / 1));
        this.bend(b.spine, _axis, (-0.05 + breath) * w);
        this.bend(b.spine, _fwd, -0.06 * lean * w);
        this.arm(outer, f, [0.8, 0.5, 0.35], [-0.1 + wave, 1, 0.3], w);
        break;
      }
      case 'third': {
        // 양손 허리 + 가슴 펴기
        const w = smooth(lt / 0.6);
        this.bend(b.spine, _axis, (-0.08 + breath) * w);
        this.bend(b.spine, _fwd, 0.05 * lean * w);
        this.hipHand('L', f, w);
        this.hipHand('R', f, w);
        break;
      }
      case 'defeat': {
        // 아쉬움: 고개·몸통 숙이고 어깨 떨굼, 팔은 몸 앞으로 축 (흔들림 없음, 숨쉬기만)
        const w = smooth(lt / 0.9);
        this.bend(b.spine, _axis, (0.2 + breath * 2) * w);
        this.bend(b.chest, _axis, 0.06 * w);
        this.bend(b.spine, _fwd, 0.05 * lean * w);
        for (const side of ['L', 'R'] as const) this.arm(side, f, [0.1, -1, 0.25], [0.05, -1, 0.3], 0.7 * w);
        break;
      }
      case 'neutral':
        // 무승부: 대기 동작 그대로 (숨쉬기만)
        this.bend(b.spine, _axis, breath);
        break;
    }
  }

  /** 한 팔을 [바깥, 위, 앞] 비율 방향으로 (위팔·아래팔 각각, 캐릭터 기준 축) */
  private arm(side: 'L' | 'R', f: Figure, upper: readonly [number, number, number], lower: readonly [number, number, number], w: number): void {
    if (w <= 0) return;
    const b = f.bones;
    this.armOut(side, f);
    _out2.copy(_out);
    _dir.copy(_out2).multiplyScalar(upper[0]).addScaledVector(UP, upper[1]).addScaledVector(_fwd, upper[2]).normalize();
    _dir2.copy(_out2).multiplyScalar(lower[0]).addScaledVector(UP, lower[1]).addScaledVector(_fwd, lower[2]).normalize();
    this.aimArm(side === 'L' ? b.upperArmL : b.upperArmR, side === 'L' ? b.lowerArmL : b.lowerArmR, side === 'L' ? b.handL : b.handR, _dir, _dir2, w);
  }

  /** 손을 허리에: 팔꿈치는 옆으로 벌리고 아래팔은 안쪽 아래로 (몸통 옆면에 손이 닿게) */
  private hipHand(side: 'L' | 'R', f: Figure, w: number): void {
    this.arm(side, f, [0.95, -0.45, -0.05], [-0.55, -0.6, 0.35], w);
  }

  /** 팔 바깥 방향 (가슴 → 위팔, 수평) → _out */
  private armOut(side: 'L' | 'R', f: Figure): void {
    const b = f.bones;
    (side === 'L' ? b.upperArmL : b.upperArmR).getWorldPosition(_a);
    b.chest.getWorldPosition(_b);
    _out.subVectors(_a, _b).setY(0);
    if (_out.lengthSq() < 1e-8) _out.set(side === 'L' ? 1 : -1, 0, 0);
    _out.normalize();
  }

  private bend(bone: THREE.Bone, axis: THREE.Vector3, angle: number): void {
    if (Math.abs(angle) < 1e-5) return;
    bone.getWorldQuaternion(_q);
    _q.premultiply(_qa.setFromAxisAngle(axis, angle));
    setWorldQuaternion(bone, _q);
  }

  /** 위팔·아래팔을 각각 주어진 월드 방향으로 */
  private aimArm(upper: THREE.Bone, lower: THREE.Bone, hand: THREE.Bone, dirUpper: THREE.Vector3, dirLower: THREE.Vector3, w: number): void {
    upper.getWorldPosition(_a);
    lower.getWorldPosition(_b);
    rotateBoneToward(upper, _a, _b, _c.copy(_a).add(dirUpper), w);
    lower.getWorldPosition(_b);
    hand.getWorldPosition(_h);
    rotateBoneToward(lower, _b, _h, _c.copy(_b).add(dirLower), w);
  }
}
