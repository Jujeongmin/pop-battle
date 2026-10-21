import * as THREE from 'three';
import type { CharacterHitboxes } from '../combat/CharacterHitboxes';
import { CHARACTER_HITBOX } from '../config/combat';
import { CHARACTER } from '../config/gameConfig';
import { CHARACTER_IDS, CHARACTERS, type CharacterId } from '../config/characters';
import type { PlayerAvatar } from '../player/PlayerAvatar';

/** 디버그 표시 대상 1명 (플레이어 또는 봇) */
export interface DebugParticipant {
  id: string;
  label: string;
  avatar: PlayerAvatar;
  hitboxes: CharacterHitboxes;
  alive: boolean;
  hp: number;
  maxHp: number;
  /** 이동 속도 배율 (컨트롤러에 실제 적용된 값) */
  speedScale: number;
  /** 지금 표정, 디버그 고정 여부 */
  expression: 'normal' | 'dead' | 'deadLeft' | 'deadRight';
  /** 표정 렌더 구성 (디버그) */
  expressionInfo?: string;
  expressionLocked: boolean;
}

/**
 * 판정 크기 실측 (YELLOW = 1 기준 비율): 정면 투영 면적 √ 비율.
 * 면적 = 머리 원 + 몸통 캡슐 (머리 구와 겹치는 위쪽 일부 포함, 대략값)
 */
export function hitArea(d: { headRadius: number; bodyRadius: number; bodyHalfHeight: number }): number {
  const capsule = 2 * d.bodyRadius * 2 * d.bodyHalfHeight + Math.PI * d.bodyRadius * d.bodyRadius;
  return Math.PI * d.headRadius * d.headRadius + capsule;
}

/** YELLOW(표준, 키 1.25m) 대기 자세 판정 면적 실측값 (m², 2026-10-21). 판정 크기 % = √(면적 / 이 값) */
export const REFERENCE_HIT_AREA = 0.5168;

const wireMat = (color: number) =>
  new THREE.MeshBasicMaterial({ color, wireframe: true, depthTest: false, transparent: true, opacity: 0.8 });

/** 참가자 1명의 장면 표시물 (판정 구·캡슐, 경계 상자, 총구 방향선) */
class ParticipantGizmo {
  readonly group = new THREE.Group();
  private readonly head: THREE.Mesh;
  private readonly body: THREE.Mesh;
  private readonly box = new THREE.Box3Helper(new THREE.Box3(), 0x33ccff);
  private readonly ray: THREE.Line;
  /** 손 본 위치 (하늘색 = 오른손, 분홍 = 왼손) · 무기 원점 축 · 본 구조 */
  private readonly handR: THREE.Mesh;
  private readonly handL: THREE.Mesh;
  private readonly pivot = new THREE.AxesHelper(0.12);
  private skeleton: THREE.SkeletonHelper | null = null;
  private skeletonOf: THREE.Object3D | null = null;
  private bodyKey = '';

  constructor() {
    this.head = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), wireMat(0xff3355));
    this.body = new THREE.Mesh(new THREE.CapsuleGeometry(1, 1, 4, 12), wireMat(0xffaa00));
    const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 1)]);
    this.ray = new THREE.Line(rayGeo, new THREE.LineBasicMaterial({ color: 0xffee00, depthTest: false, transparent: true }));
    const dot = (color: number) => new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 6), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }));
    this.handR = dot(0x33ddff);
    this.handL = dot(0xff66cc);
    (this.pivot.material as THREE.LineBasicMaterial).depthTest = false;
    for (const o of [this.head, this.body, this.box, this.ray, this.handR, this.handL, this.pivot]) {
      o.renderOrder = 40;
      o.frustumCulled = false;
      this.group.add(o);
    }
    (this.box.material as THREE.LineBasicMaterial).depthTest = false;
  }

  update(p: DebugParticipant, show: { hitbox: boolean; bounds: boolean; muzzle: boolean; rig: boolean }): void {
    const vis = p.alive;
    const d = p.hitboxes.dimensions;
    this.head.visible = this.body.visible = vis && show.hitbox;
    if (this.head.visible) {
      const h = p.hitboxes.head.translation();
      this.head.position.set(h.x, h.y, h.z);
      this.head.scale.setScalar(d.headRadius);
      const key = `${d.bodyRadius.toFixed(4)}:${d.bodyHalfHeight.toFixed(4)}`;
      if (key !== this.bodyKey) {
        this.bodyKey = key;
        this.body.geometry.dispose();
        this.body.geometry = new THREE.CapsuleGeometry(d.bodyRadius, d.bodyHalfHeight * 2, 4, 12);
      }
      const b = p.hitboxes.body.translation();
      this.body.position.set(b.x, b.y, b.z);
    }
    this.box.visible = vis && show.bounds;
    if (this.box.visible) this.box.box.copy(p.avatar.bodyBounds);
    // 손 본·무기 원점·본 구조
    this.handR.visible = this.handL.visible = this.pivot.visible = show.rig;
    if (show.rig) {
      p.avatar.getHandPositions(this.handR.position, this.handL.position);
      p.avatar.rifle.updateWorldMatrix(true, false);
      p.avatar.rifle.matrixWorld.decompose(this.pivot.position, this.pivot.quaternion, new THREE.Vector3());
    }
    const model = p.avatar.debugModel;
    if (show.rig && this.skeletonOf !== model) {
      this.disposeSkeleton();
      this.skeleton = new THREE.SkeletonHelper(model);
      (this.skeleton.material as THREE.LineBasicMaterial).depthTest = false;
      this.skeleton.renderOrder = 40;
      this.skeletonOf = model;
      this.group.add(this.skeleton);
    }
    if (this.skeleton) this.skeleton.visible = show.rig;
    this.ray.visible = vis && show.muzzle;
    if (this.ray.visible) {
      const pos = new THREE.Vector3();
      const dir = new THREE.Vector3();
      p.avatar.getMuzzle(pos, dir);
      const attr = this.ray.geometry.getAttribute('position') as THREE.BufferAttribute;
      attr.setXYZ(0, pos.x, pos.y, pos.z);
      attr.setXYZ(1, pos.x + dir.x * 3, pos.y + dir.y * 3, pos.z + dir.z * 3);
      attr.needsUpdate = true;
    }
  }

  private disposeSkeleton(): void {
    if (!this.skeleton) return;
    this.skeleton.removeFromParent();
    this.skeleton.geometry.dispose();
    (this.skeleton.material as THREE.Material).dispose();
    this.skeleton = null;
    this.skeletonOf = null;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.disposeSkeleton();
    this.pivot.dispose();
    for (const o of [this.head, this.body, this.ray, this.handR, this.handL]) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    this.box.geometry.dispose();
    (this.box.material as THREE.Material).dispose();
  }
}

export interface CharacterDebugHooks {
  participants(): DebugParticipant[];
  /** 캐릭터 교체 (참가자 id, 캐릭터 id). 로드가 끝나면 resolve */
  select(who: string, id: CharacterId): Promise<boolean>;
  /** 표정 미리보기: 'normal' / 'dead' 고정, null = 원래대로 (HP·판정·킬로그와 무관) */
  setExpression(who: string, e: 'normal' | 'dead' | 'deadLeft' | 'deadRight' | null): boolean;
}

/**
 * 개발용 CHARACTER DEBUG (` 디버그 패널 안, 접을 수 있음). 개발 서버에서만 생성 → 배포 빌드에는 없음.
 * - 대상(플레이어·봇) × 캐릭터 8종 즉시 교체 (GLB·능력치·크기·판정·장착 보정 함께)
 * - 이름·체력·속도 배율·판정 크기(목표/실측)·체형 실측(키·어깨·몸통 폭·두께)·판정 크기 이전/이후
 * - 판정·경계 상자·장착점(그립/총구 마커)·총구 방향선 표시 (모든 참가자)
 */
export class CharacterDebug {
  readonly element: HTMLDetailsElement;
  readonly show = { hitbox: false, bounds: false, muzzle: false, markers: false, rig: false };
  private readonly gizmos = new Map<string, ParticipantGizmo>();
  private readonly info: HTMLPreElement;
  private readonly status: HTMLDivElement;
  private target: string;
  private infoTimer = 0;
  private busy = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly hooks: CharacterDebugHooks,
  ) {
    const d = document.createElement('details');
    d.className = 'dp-section';
    d.open = true;
    const s = document.createElement('summary');
    s.textContent = 'CHARACTER DEBUG';
    d.appendChild(s);

    const parts = hooks.participants();
    this.target = parts[0]?.id ?? 'player';
    const who = document.createElement('select');
    who.className = 'dp-select';
    for (const p of parts) who.add(new Option(p.label, p.id));
    who.onchange = () => {
      this.target = who.value;
      this.refreshInfo();
    };
    const whoRow = document.createElement('div');
    whoRow.className = 'dp-row';
    whoRow.append(Object.assign(document.createElement('span'), { textContent: '대상' }), who);
    d.appendChild(whoRow);

    const grid = document.createElement('div');
    grid.className = 'dp-char-grid';
    for (const id of CHARACTER_IDS) {
      const b = document.createElement('button');
      b.textContent = CHARACTERS[id].name;
      b.dataset.id = id;
      b.onclick = () => void this.pick(id);
      grid.appendChild(b);
    }
    d.appendChild(grid);
    this.status = document.createElement('div');
    this.status.className = 'dp-hint';
    d.appendChild(this.status);

    // 표정 미리보기 (사망 X X 눈)
    const expr = document.createElement('div');
    expr.className = 'dp-char-grid';
    for (const [label, e] of [
      ['Normal Eyes', 'normal'],
      ['Dead Eyes', 'dead'],
      ['Reset Eyes', null],
      ['Dead 왼쪽 눈만', 'deadLeft'],
      ['Dead 오른쪽 눈만', 'deadRight'],
    ] as const) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => {
        this.hooks.setExpression(this.target, e);
        this.refreshInfo();
      };
      expr.appendChild(b);
    }
    d.appendChild(expr);

    for (const [key, label] of [
      ['hitbox', '판정 영역 보기 (머리 구·몸통 캡슐)'],
      ['bounds', '경계 상자 보기 (스킨 정점)'],
      ['markers', '장착점 보기 (오른손 그립·왼손 지지점·총구)'],
      ['muzzle', '총구·발사 방향 보기'],
      ['rig', '손 본·무기 원점(축)·본 구조 보기 (하늘색 오른손, 분홍 왼손)'],
    ] as const) {
      const row = document.createElement('label');
      row.className = 'dp-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.onchange = () => {
        this.show[key] = input.checked;
      };
      row.append(input, document.createTextNode(` ${label}`));
      d.appendChild(row);
    }
    this.info = document.createElement('pre');
    this.info.className = 'dp-status';
    d.appendChild(this.info);
    this.element = d;
    this.refreshInfo();
  }

  private async pick(id: CharacterId): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.status.textContent = `${CHARACTERS[id].name} 불러오는 중…`;
    try {
      const ok = await this.hooks.select(this.target, id);
      this.status.textContent = ok ? `${CHARACTERS[id].name} 적용` : '교체 실패';
    } catch (err) {
      this.status.textContent = `교체 실패: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.busy = false;
      this.refreshInfo();
    }
  }

  /** 매 프레임 (패널이 닫혀 있어도 장면 표시는 갱신) */
  update(dt: number, panelVisible: boolean): void {
    const parts = this.hooks.participants();
    const any = this.show.hitbox || this.show.bounds || this.show.muzzle || this.show.rig;
    const seen = new Set<string>();
    for (const p of parts) {
      seen.add(p.id);
      p.avatar.showMarkers = this.show.markers;
      let g = this.gizmos.get(p.id);
      if (!g && any) {
        g = new ParticipantGizmo();
        this.scene.add(g.group);
        this.gizmos.set(p.id, g);
      }
      g?.update(p, this.show);
    }
    for (const [id, g] of this.gizmos) {
      if (!seen.has(id)) {
        g.dispose();
        this.gizmos.delete(id);
      }
    }
    this.infoTimer -= dt;
    if (panelVisible && this.infoTimer <= 0) {
      this.infoTimer = 0.25;
      this.refreshInfo();
    }
  }

  private refreshInfo(): void {
    const p = this.hooks.participants().find((x) => x.id === this.target);
    if (!p) return;
    const a = p.avatar;
    const c = a.character;
    const dims = p.hitboxes.dimensions;
    const f2 = (v: number) => v.toFixed(2);
    const cm = (v: number) => `${(v * 100).toFixed(1)}cm`;
    const measured = Math.sqrt(hitArea(dims) / REFERENCE_HIT_AREA);
    // 이전 방식: 모든 캐릭터 고정 크기 1.25 + 몸통 반지름 0.22 (같은 GLB 머리 정점 기준)
    const oldHead = (dims.headRadius / a.bodyScale) * CHARACTER.scale;
    const old = { headRadius: oldHead, bodyRadius: CHARACTER_HITBOX.bodyRadius, bodyHalfHeight: dims.bodyHalfHeight / a.sizeRatio };
    const oldSize = Math.sqrt(hitArea(old) / REFERENCE_HIT_AREA);
    const fit = a.weaponFit;
    for (const b of this.element.querySelectorAll<HTMLButtonElement>('.dp-char-grid button')) {
      b.classList.toggle('active', b.dataset.id === c.id);
    }
    this.info.textContent = [
      `${p.label}: ${c.name}  (${c.id})`,
      `체력 ${p.hp.toFixed(0)} / ${p.maxHp}  (설정 ${c.stats.maxHp})`,
      `속도 배율 ×${f2(p.speedScale)}  (설정 ×${f2(c.stats.speed)}, 걷기 ${f2(3.4 * p.speedScale)} 달리기 ${f2(5.8 * p.speedScale)} m/s)`,
      `판정 크기 목표 ${(c.stats.hitSize * 100).toFixed(0)}%  실측 ${(measured * 100).toFixed(0)}%  (YELLOW 기준)`,
      `  이후: 머리 r ${cm(dims.headRadius)}  몸통 r ${cm(dims.bodyRadius)}  캡슐 길이 ${cm(dims.bodyHalfHeight * 2 + dims.bodyRadius * 2)}`,
      `  이전: 머리 r ${cm(old.headRadius)}  몸통 r ${cm(old.bodyRadius)}  (모두 1.25m·몸통 고정, 크기 ${(oldSize * 100).toFixed(0)}%)`,
      `키 ${cm(a.measure.height)} (배율 ${f2(c.body.height)}, 모델 크기 ${a.bodyScale.toFixed(3)})`,
      `어깨 폭 ${cm(a.measure.shoulderWidth)}  몸통 폭 ${cm(a.measure.torsoWidth)}  앞 두께×2 ${cm(a.measure.torsoDepth)}`,
      `체형: ${c.body.shape}`,
      `장착 보정(현재 무기): 위치 [${fit.weaponPositionOffset.join(', ')}] 재장전 [${fit.reloadPositionOffset.join(', ')}] 시각 반동 ×${fit.recoilPullScale} 회전 [${fit.weaponRotationOffset.join(', ')}] 크기 ×${fit.weaponScale}`,
      `  왼손 [${fit.leftHandIKOffset.join(', ')}] 오른손 [${fit.rightHandIKOffset.join(', ')}] 총구 [${fit.muzzleOffset.join(', ')}]`,
      `IK 미도달 R ${cm(a.reachError.right)}  L ${cm(a.reachError.left)}`,
      `표정 ${p.expression === 'normal' ? '평소' : p.expression === 'dead' ? 'X X (사망)' : p.expression === 'deadLeft' ? '왼쪽 눈만 X' : '오른쪽 눈만 X'}${p.expressionLocked ? ' [디버그 고정]' : ''}`,
      `  ${p.expressionInfo ?? ''}`,
    ].join('\n');
  }

  dispose(): void {
    for (const g of this.gizmos.values()) g.dispose();
    this.gizmos.clear();
    this.element.remove();
  }
}
