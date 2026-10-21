// 게임 모드: 원격 플레이어 1명 (상대 화면에 보이는 캐릭터).
// 움직임은 SnapshotBuffer 보간 결과를 그대로 그리고(물리 이동 없음, 운동학 강체로 위치만 맞춤),
// 판정 영역(CharacterHitboxes)은 봇·로컬과 같은 코드라 로컬 히트스캔이 그대로 맞힐 수 있다.
// 맞아도 체력은 여기서 깎지 않는다 → onClaim으로 서버에 "맞혔다"만 알리고, 체력·사망은 서버 결과(setServerState)로만 바뀜.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { BotLabel } from '../bots/BotManager';
import { CharacterHitboxes } from '../combat/CharacterHitboxes';
import { MOVEMENT } from '../config/gameConfig';
import { WEAPONS } from '../config/weapons';
import type { Damageable, HitInfo, Physics } from '../physics/Physics';
import type { PlayerAvatar } from '../player/PlayerAvatar';
import { CONTROLLER_OFFSET } from '../player/PlayerController';
import type { Sampled } from './SnapshotBuffer';
import { NET_MODES } from './shared/protocol';

const LABEL_MAX_DIST = 45;
const _head = new THREE.Vector3();

export class RemotePlayer implements Damageable {
  readonly id: string;
  readonly team = 'remote';
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly hitboxes: CharacterHitboxes;
  hp: number;
  maxHp: number;
  dead = false;
  /** 연결 유실 (30초 유예 중): 숨김·판정 제외 */
  hidden = false;
  readonly renderFeet = new THREE.Vector3();
  readonly aimDir = new THREE.Vector3(0, 0, 1);
  readonly velocity = new THREE.Vector3();
  readonly muzzle = new THREE.Vector3();
  readonly muzzleDir = new THREE.Vector3(0, 0, 1);
  readonly label: BotLabel;
  /** 디버그: 이번 프레임 외삽 중 / 받은 상태가 아직 없음 */
  extrapolating = false;
  hasState = false;
  private weaponId = '';
  private readonly weaponClones = new Map<string, THREE.Object3D>();
  private lastFlagsSeq = -1;
  private labelTimer = 0;
  private readonly centerAboveFeet = MOVEMENT.capsuleHalfHeight + MOVEMENT.capsuleRadius + CONTROLLER_OFFSET;

  constructor(
    private readonly physics: Physics,
    readonly account: string,
    readonly name: string,
    public avatar: PlayerAvatar,
    private readonly weaponModel: (id: string) => THREE.Object3D,
    private readonly onClaim: (target: RemotePlayer, hit: HitInfo) => void,
  ) {
    this.id = `net:${account}`;
    this.hp = this.maxHp = avatar.character.stats.maxHp;
    const world = physics.world;
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -100, 0));
    // 이동 캡슐: 서로 밀리고 막히게 (사격·카메라 쿼리는 히트박스만)
    this.collider = world.createCollider(RAPIER.ColliderDesc.capsule(MOVEMENT.capsuleHalfHeight, MOVEMENT.capsuleRadius), this.body);
    physics.ignoreForQueries(this.collider);
    this.hitboxes = new CharacterHitboxes(physics, this.body, this, avatar.headRadius);
    this.hitboxes.setEnabled(false);
    this.avatar.root.visible = false;
    this.label = { name, hp: this.hp, maxHp: this.maxHp, world: new THREE.Vector3(), visible: false, protected: false, dead: false, ally: false };
  }

  get alive(): boolean {
    return !this.dead;
  }

  /** 로컬 히트스캔·근접이 맞힘: 서버에 명중 주장만 보내고, 화면 피해 숫자는 예상값 (실제 체력은 서버 결과) */
  applyHit(hit: HitInfo): number {
    if (this.dead || !this.hasState) return 0;
    this.onClaim(this, hit);
    return hit.damage;
  }

  /** 서버 기록 반영 (체력·최대 체력·사망) */
  setServerState(hp: number, maxHp: number, dead: boolean): void {
    this.hp = hp;
    this.maxHp = maxHp;
    if (dead !== this.dead) this.setDead(dead);
  }

  setDead(dead: boolean): void {
    this.dead = dead;
    if (dead) this.hp = 0;
    this.applyActive();
  }

  /** 연결 유실 중 숨김 (캐릭터·이름표·판정·충돌 모두) */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.applyActive();
  }

  private applyActive(): void {
    const present = this.hasState && !this.hidden;
    this.avatar.root.visible = present;
    this.hitboxes.setEnabled(present && !this.dead);
    this.collider.setEnabled(present && !this.dead);
    if (!present) this.label.visible = false;
  }

  /** 캐릭터 교체 (상대가 다른 캐릭터로 들어옴). 이전 아바타는 호출한 쪽이 해제 */
  setAvatar(avatar: PlayerAvatar): void {
    this.avatar = avatar;
    this.weaponId = '';
    this.weaponClones.clear();
    this.applyActive();
  }

  /** 보간된 상태로 아바타·강체·판정 갱신 (물리 스텝 전에 호출 → 이번 프레임 히트스캔에 반영) */
  update(dt: number, s: Sampled | null, camera: THREE.Camera): void {
    if (!s) return;
    if (!this.hasState) {
      this.hasState = true;
      this.applyActive();
    }
    if (this.hidden) return;
    const n = s.near;
    this.extrapolating = s.extrapolating;
    this.renderFeet.set(s.p[0], s.p[1], s.p[2]);
    this.velocity.set(s.v[0], s.v[1], s.v[2]);
    this.aimDir.set(s.aim[0], s.aim[1], s.aim[2]);
    this.body.setTranslation({ x: s.p[0], y: s.p[1] + this.centerAboveFeet, z: s.p[2] }, true);
    if (n.w !== this.weaponId && WEAPONS[n.w]) this.equip(n.w);
    // 한 번만 일어나는 동작(점프·착지)은 그 패킷을 처음 그릴 때만
    const fresh = n.q !== this.lastFlagsSeq;
    this.lastFlagsSeq = n.q;
    this.avatar.update({
      dt,
      feet: this.renderFeet,
      bodyYaw: s.yaw,
      aimDir: this.aimDir,
      pitch: s.pitch,
      mode: NET_MODES[n.m] ?? 'ground',
      grounded: (n.f & 1) !== 0,
      sprinting: (n.f & 2) !== 0,
      velocity: this.velocity,
      justJumped: fresh && (n.f & 16) !== 0,
      justLanded: fresh && (n.f & 32) !== 0,
      landedAirTime: 0.4,
      dead: this.dead,
      strafing: (n.f & 4) !== 0,
      weaponKick: n.k,
      weaponRaise: 1,
      reloadProgress: n.rl,
      adsBlend: n.ads,
      meleeSwing: n.ms,
      boltProgress: n.bp,
    });
    this.avatar.getMuzzle(this.muzzle, this.muzzleDir);
    if (!this.dead) this.hitboxes.update(this.avatar, this.renderFeet, this.centerAboveFeet);
    this.updateLabel(dt, camera);
  }

  private equip(id: string): void {
    const def = WEAPONS[id]!;
    let model = this.weaponClones.get(id);
    if (!model) {
      model = this.weaponModel(id).clone(true);
      this.weaponClones.set(id, model);
    }
    this.avatar.setWeapon(model, def.mount);
    this.weaponId = id;
  }

  private updateLabel(dt: number, camera: THREE.Camera): void {
    const l = this.label;
    const a = this.avatar;
    l.hp = this.hp;
    l.maxHp = this.maxHp;
    l.dead = this.dead;
    l.name = this.name;
    l.world.copy(a.headCenter).setY(a.headCenter.y + a.headRadius + 0.25);
    this.labelTimer -= dt;
    if (this.labelTimer <= 0) {
      this.labelTimer = 0.2;
      _head.copy(a.headCenter);
      l.visible = camera.position.distanceTo(l.world) < LABEL_MAX_DIST && this.physics.lineClear(camera.position, _head);
    }
  }

  /** 강체·판정 해제 (아바타는 만든 쪽이 해제: NetGameContext.releaseAvatar) */
  dispose(): void {
    this.hitboxes.dispose();
    this.physics.unignoreForQueries(this.collider);
    this.physics.world.removeCollider(this.collider, false);
    this.physics.world.removeRigidBody(this.body);
  }
}
