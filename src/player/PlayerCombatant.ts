import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CharacterHitboxes } from '../combat/CharacterHitboxes';
import type { Combatant } from '../combat/Combatant';
import { Health } from '../combat/Health';
import { TEAMS } from '../config/combat';
import type { AttackerInfo, HitInfo, HitPart, Physics } from '../physics/Physics';
import type { PlayerAvatar } from './PlayerAvatar';
import type { PlayerController } from './PlayerController';

/** 로컬 플레이어의 전투 상태: 체력·무적·판정 영역. 이동·카메라는 기존 모듈 그대로 */
export class PlayerCombatant implements Combatant {
  readonly id = 'player';
  readonly name = 'PLAYER';
  /** 진영 (싱글플레이 = players, 멀티 TDM = BLUE/RED — Game이 서버 팀으로 바꿈) */
  team: string = TEAMS.player;
  /** 체력: 캐릭터 능력치 최대 체력 (캐릭터를 바꾸면 Game이 setMaxHp) */
  readonly health: Health;
  readonly hitboxes: CharacterHitboxes;
  timeSinceShot = 99;
  /** 게임 시작(첫 클릭) 전에는 봇이 노리지 않음 */
  active = false;
  /** 개발용 무적 (디버그 패널 체크 또는 콘솔 __game.god()). 피해 0, 봇은 그대로 공격함 */
  invincible = false;
  private readonly attackerInfo: { id: string; name: string; team: string; position: THREE.Vector3 };

  constructor(
    physics: Physics,
    private readonly controller: PlayerController,
    avatar: PlayerAvatar,
    private readonly onDamaged: (hit: HitInfo, applied: number) => void,
  ) {
    this.health = new Health(avatar.character.stats.maxHp);
    this.hitboxes = new CharacterHitboxes(physics, controller.body, this, avatar.headRadius);
    this.attackerInfo = { id: this.id, name: this.name, team: this.team, position: new THREE.Vector3() };
  }

  get rigidBody(): RAPIER.RigidBody {
    return this.controller.body;
  }

  get alive(): boolean {
    return this.health.alive;
  }

  get targetable(): boolean {
    return this.active && this.health.alive;
  }

  get isProtected(): boolean {
    return this.health.protected;
  }

  get velocity(): THREE.Vector3 {
    return this.controller.velocity;
  }

  applyHit(hit: HitInfo): number {
    if (this.invincible) return 0;
    const applied = this.health.applyDamage(hit.damage);
    if (applied > 0) this.onDamaged(hit, applied);
    return applied;
  }

  /** 발사 순간 공격자 정보 (같은 객체를 재사용) */
  attacker(muzzle: THREE.Vector3): AttackerInfo {
    this.attackerInfo.position.copy(muzzle);
    this.attackerInfo.team = this.team;
    return this.attackerInfo;
  }

  /** 발사: 리스폰 보호 해제 + 총소리 감지용 시간 */
  notifyFired(): void {
    this.health.breakProtection();
    this.timeSinceShot = 0;
  }

  update(dt: number): void {
    this.health.update(dt);
    this.timeSinceShot += dt;
  }

  getFeet(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.controller.position).setY(this.controller.position.y - this.controller.footOffset);
  }

  getAimPoint(part: HitPart, out: THREE.Vector3): THREE.Vector3 {
    const t = (part === 'head' ? this.hitboxes.head : this.hitboxes.body).translation();
    return out.set(t.x, t.y, t.z);
  }

  getEye(out: THREE.Vector3): THREE.Vector3 {
    return this.getAimPoint('head', out);
  }
}
