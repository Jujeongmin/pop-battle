import * as THREE from 'three';
import { BOT, type BotDifficulty } from '../config/bots';
import type { NavGrid } from './NavGrid';

export type BotState = 'idle' | 'patrol' | 'chase' | 'attack' | 'reload' | 'dead';

/** 감지 결과 (BotAgent가 일정 간격으로 채움). 렌더링과 무관한 숫자만 */
export interface BotPerception {
  /** 현재 표적이 보이는지 (시야각·거리·장애물 통과) */
  visible: boolean;
  /** 표적 위치 (보일 때 실제 위치, 아니면 마지막으로 본 위치) */
  targetPos: THREE.Vector3;
  targetVelocity: THREE.Vector3;
  /** 마지막으로 본 뒤 경과 (보이면 0) */
  lastSeenAge: number;
  /** 표적이 있는지 (없으면 나머지 무의미) */
  hasTarget: boolean;
  /** 표적까지 거리 (수평) */
  distance: number;
  /** 지금 자리에서 총을 쏘면 표적까지 경로가 열려 있는지 */
  canShoot: boolean;
}

/** 봇 자신의 상태 (무기·위치) */
export interface BotSelf {
  position: THREE.Vector3;
  magazine: number;
  reloading: boolean;
  canReload: boolean;
  alive: boolean;
}

/** 결정 결과: BotAgent가 매 프레임 이를 실행 */
export interface BotIntent {
  state: BotState;
  /** 이동 목표 (null = 정지) */
  moveTo: THREE.Vector3 | null;
  sprint: boolean;
  /** 바라볼 지점 (null = 이동 방향) */
  lookAt: THREE.Vector3 | null;
  /** 방아쇠 */
  fire: boolean;
  /** 재장전 시작 요청 */
  reload: boolean;
  /** 이동 목표가 바뀌어 경로를 다시 계산해야 하는지 */
  moveTargetChanged: boolean;
}

/** 시야 질의 (물리 레이캐스트는 Agent가 제공) */
export interface BotWorld {
  nav: NavGrid;
  /** 바닥 지점 from(발)에서 표적 to(발)로 시야가 열려 있는지 (눈 높이 보정은 구현이 함) */
  lineOfSight(fromFeet: THREE.Vector3, toFeet: THREE.Vector3): boolean;
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * 봇 결정 로직 (순수 상태 기계). 일정 간격(decisionInterval)으로 think()를 부르고 intent를 실행한다.
 * 물리·렌더링을 직접 다루지 않아 서버로 옮길 수 있다.
 */
export class BotBrain {
  state: BotState = 'idle';
  readonly intent: BotIntent = {
    state: 'idle',
    moveTo: null,
    sprint: false,
    lookAt: null,
    fire: false,
    reload: false,
    moveTargetChanged: false,
  };
  private stateTime = 0;
  private idleWait = rand(BOT.patrol.idleMin, BOT.patrol.idleMax);
  private readonly goal = new THREE.Vector3();
  private hasGoal = false;
  /** 적 발견 후 반응 시간 */
  private reaction = 0;
  private burstTimer = 0;
  private burstOn = false;
  private strafeTimer = 0;
  private strafeSide = 1;
  private losLostTime = 0;
  private searchTimer = 0;
  /** 디버그 */
  lastReason = '';

  constructor(
    private readonly world: BotWorld,
    public difficulty: BotDifficulty,
  ) {}

  /** 리스폰·사망 시 */
  reset(dead: boolean): void {
    this.setState(dead ? 'dead' : 'idle');
    this.hasGoal = false;
    this.reaction = this.difficulty.reactionTime;
    this.burstOn = false;
    this.losLostTime = 0;
    this.clearIntent();
  }

  /** 피격당하면 즉시 반응 시간을 줄여 반격 (감지는 Agent가 처리) */
  onDamaged(): void {
    this.reaction = Math.min(this.reaction, this.difficulty.reactionTime * 0.4);
  }

  /** 경로를 못 찾거나 계속 막히면: 목표를 버리고 다음 결정에서 다른 지점을 고른다 */
  onMoveFailed(): void {
    this.hasGoal = false;
    this.lastReason = '이동 실패 → 목표 변경';
    if (this.state === 'patrol') this.setState('idle');
  }

  private clearIntent(): void {
    const i = this.intent;
    i.state = this.state;
    i.moveTo = null;
    i.sprint = false;
    i.lookAt = null;
    i.fire = false;
    i.reload = false;
    i.moveTargetChanged = false;
  }

  private setState(s: BotState): void {
    if (s === this.state) return;
    this.state = s;
    this.stateTime = 0;
    this.hasGoal = false;
    this.intent.moveTargetChanged = true;
    if (s === 'idle') this.idleWait = rand(BOT.patrol.idleMin, BOT.patrol.idleMax);
    if (s === 'attack') {
      this.burstOn = false;
      this.burstTimer = 0;
      this.strafeTimer = 0;
    }
    if (s === 'chase') this.searchTimer = 0;
  }

  private setGoal(p: THREE.Vector3): void {
    if (!this.hasGoal || this.goal.distanceToSquared(p) > 0.25) {
      this.goal.copy(p);
      this.hasGoal = true;
      this.intent.moveTargetChanged = true;
    }
  }

  /**
   * @param dt 마지막 think 이후 경과 시간
   */
  think(dt: number, self: BotSelf, p: BotPerception): BotIntent {
    this.stateTime += dt;
    const i = this.intent;
    i.fire = false;
    i.reload = false;
    i.moveTargetChanged = false;
    i.sprint = false;
    i.lookAt = null;

    if (!self.alive) {
      this.setState('dead');
      i.state = 'dead';
      i.moveTo = null;
      return i;
    }
    if (this.state === 'dead') this.setState('idle');

    const d = this.difficulty;
    const c = BOT.combat;
    const seen = p.hasTarget && p.visible;
    const tracking = p.hasTarget && p.lastSeenAge < BOT.detection.loseSightTime;

    // 반응 시간: 보이지 않으면 서서히 다시 쌓임
    if (seen) this.reaction = Math.max(0, this.reaction - dt);
    else this.reaction = Math.min(d.reactionTime, this.reaction + dt * 0.5);

    // 탄창이 비었거나 (무기 쪽 자동 재장전이 이미 시작됐어도) 재장전 중이면 어디서든 재장전 상태 우선
    if ((self.reloading || (self.magazine === 0 && self.canReload)) && this.state !== 'reload') {
      this.setState('reload');
      this.lastReason = '재장전 → 엄폐';
    }

    switch (this.state) {
      case 'idle':
        if (tracking) {
          this.setState('chase');
          break;
        }
        i.moveTo = null;
        if (this.stateTime >= this.idleWait) this.setState('patrol');
        break;

      case 'patrol': {
        if (tracking) {
          this.setState('chase');
          break;
        }
        if (!this.hasGoal) {
          const g = this.world.nav.randomPoint(self.position, BOT.patrol.minDist, BOT.patrol.maxDist, _v);
          if (!g) {
            this.setState('idle');
            break;
          }
          this.setGoal(g);
        }
        i.moveTo = this.goal;
        if (this.flatDist(self.position, this.goal) < BOT.movement.arriveRadius * 1.5) this.setState('idle');
        break;
      }

      case 'chase': {
        if (!tracking) {
          this.lastReason = '표적 놓침';
          this.setState('idle');
          break;
        }
        if (seen && p.canShoot && p.distance <= c.preferredMax + 3) {
          this.setState('attack');
          break;
        }
        // 보이면 사격 위치(시야 열린 지점)로, 안 보이면 마지막 위치로
        if (seen) {
          const fp = this.findFiringPosition(self.position, p.targetPos);
          this.setGoal(fp ?? p.targetPos);
          i.lookAt = p.targetPos;
        } else {
          this.setGoal(p.targetPos);
          if (this.flatDist(self.position, p.targetPos) < 1.5) {
            this.searchTimer += dt;
            if (this.searchTimer > BOT.detection.searchTime) {
              this.lastReason = '수색 종료';
              this.setState('idle');
              break;
            }
          }
        }
        i.moveTo = this.goal;
        i.sprint = this.flatDist(self.position, this.goal) > c.sprintBeyond;
        break;
      }

      case 'attack': {
        if (!p.hasTarget) {
          this.setState('idle');
          break;
        }
        i.lookAt = p.targetPos;
        if (!seen || !p.canShoot) {
          this.losLostTime += dt;
          if (this.losLostTime > c.losLostGrace || !tracking) {
            this.losLostTime = 0;
            this.lastReason = seen ? '총구 막힘 → 위치 변경' : '시야 잃음 → 추격';
            this.setState('chase');
            break;
          }
        } else {
          this.losLostTime = 0;
        }
        // 사격: 반응 시간 뒤 연사/휴식 반복
        if (seen && p.canShoot && this.reaction <= 0) {
          this.burstTimer -= dt;
          if (this.burstTimer <= 0) {
            this.burstOn = !this.burstOn;
            this.burstTimer = this.burstOn ? d.burstTime * rand(0.7, 1.3) : d.burstPause * rand(0.7, 1.3);
          }
          i.fire = this.burstOn;
        } else {
          this.burstOn = false;
          this.burstTimer = 0;
        }
        // 이동: 거리 유지 + 옆걸음
        this.strafeTimer -= dt;
        if (this.strafeTimer <= 0 || !this.hasGoal) {
          this.strafeTimer = rand(c.strafeMin, c.strafeMax);
          if (Math.random() < 0.6) this.strafeSide = -this.strafeSide;
          const g = this.pickCombatMove(self.position, p.targetPos, p.distance);
          if (g) this.setGoal(g);
          else this.hasGoal = false;
        }
        i.moveTo = this.hasGoal ? this.goal : null;
        if (i.moveTo && this.flatDist(self.position, i.moveTo) < BOT.movement.arriveRadius) {
          i.moveTo = null;
          this.hasGoal = false;
        }
        break;
      }

      case 'reload': {
        if (!self.reloading && self.magazine > 0) {
          this.setState(tracking ? 'attack' : 'idle');
          break;
        }
        if (!self.reloading) i.reload = true;
        if (p.hasTarget) i.lookAt = p.targetPos;
        // 엄폐: 표적 시야가 막힌 가까운 지점으로
        if (!this.hasGoal && tracking) {
          const cover = this.findCover(self.position, p.targetPos);
          if (cover) {
            this.setGoal(cover);
            this.lastReason = '재장전 엄폐 이동';
          } else {
            this.lastReason = '엄폐 지점 없음';
          }
        }
        i.moveTo = this.hasGoal ? this.goal : null;
        if (i.moveTo && this.flatDist(self.position, i.moveTo) < BOT.movement.arriveRadius) i.moveTo = null;
        // 엄폐로 달려가는 동안은 이동 방향을 보고, 도착하면 표적 쪽을 본다
        if (i.moveTo) {
          i.sprint = true;
          i.lookAt = null;
        }
        break;
      }

      case 'dead':
        break;
    }
    i.state = this.state;
    return i;
  }

  private flatDist(a: THREE.Vector3, b: THREE.Vector3): number {
    return Math.hypot(a.x - b.x, a.z - b.z);
  }

  /** 표적 주위 선호 거리에서 시야가 열린 지점. 현재 위치에서 가까운 것 우선 */
  private findFiringPosition(self: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 | null {
    const c = BOT.combat;
    const nav = this.world.nav;
    let best: THREE.Vector3 | null = null;
    let bestScore = Infinity;
    const baseAngle = Math.atan2(self.x - target.x, self.z - target.z);
    for (let k = 0; k < c.firingPositionSamples; k++) {
      // 자기 쪽 반원 위주로 샘플 (멀리 돌아가지 않게)
      const a = baseAngle + rand(-Math.PI * 0.75, Math.PI * 0.75);
      const r = rand(c.preferredMin, c.preferredMax);
      _w.set(target.x + Math.sin(a) * r, 0, target.z + Math.cos(a) * r);
      if (!nav.isWalkableAt(_w.x, _w.z)) continue;
      // 발판·경사로 위 후보는 그 높이에서 시야 검사
      _w.y = nav.heightAt(_w.x, _w.z);
      if (!this.world.lineOfSight(_w, target)) continue;
      const score = this.flatDist(self, _w);
      if (score < bestScore) {
        bestScore = score;
        best = _w.clone();
      }
    }
    return best;
  }

  /** 교전 중 이동 지점: 너무 가까우면 뒤로, 멀면 앞으로, 아니면 옆걸음. 시야 유지되는 곳만 */
  private pickCombatMove(self: THREE.Vector3, target: THREE.Vector3, dist: number): THREE.Vector3 | null {
    const c = BOT.combat;
    const nav = this.world.nav;
    const toT = _v.set(target.x - self.x, 0, target.z - self.z);
    if (toT.lengthSq() < 1e-4) toT.set(0, 0, 1);
    toT.normalize();
    const side = _w.set(toT.z, 0, -toT.x).multiplyScalar(this.strafeSide);
    const candidates: THREE.Vector3[] = [];
    const add = (fwd: number, lat: number) =>
      candidates.push(new THREE.Vector3(self.x + toT.x * fwd + side.x * lat, 0, self.z + toT.z * fwd + side.z * lat));
    if (dist < c.preferredMin) {
      add(-c.strafeDistance, c.strafeDistance * 0.6);
      add(-c.strafeDistance, -c.strafeDistance * 0.6);
      add(0, c.strafeDistance);
    } else if (dist > c.preferredMax) {
      add(c.strafeDistance, c.strafeDistance * 0.5);
      add(c.strafeDistance, -c.strafeDistance * 0.5);
      add(c.strafeDistance * 1.5, 0);
    } else {
      add(0, c.strafeDistance);
      add(0, -c.strafeDistance);
      add(c.strafeDistance * 0.4, c.strafeDistance);
    }
    for (const p of candidates) {
      if (!nav.isWalkableAt(p.x, p.z)) continue;
      p.y = nav.heightAt(p.x, p.z);
      if (!nav.lineWalkable(self.x, self.z, p.x, p.z)) continue;
      if (!this.world.lineOfSight(p, target)) continue;
      return p;
    }
    return null;
  }

  /** 표적에서 보이지 않는 가까운 지점 */
  private findCover(self: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 | null {
    const c = BOT.combat;
    const nav = this.world.nav;
    let best: THREE.Vector3 | null = null;
    let bestD = Infinity;
    for (let k = 0; k < c.coverSamples; k++) {
      const g = nav.randomPoint(self, c.coverSearchMin, c.coverSearchMax, _w);
      if (!g) continue;
      if (this.world.lineOfSight(g, target)) continue;
      const d = this.flatDist(self, g);
      if (d < bestD) {
        bestD = d;
        best = g.clone();
      }
    }
    return best;
  }
}
