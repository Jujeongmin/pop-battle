import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { BotWorld } from '../ai/BotBrain';
import { NavGrid } from '../ai/NavGrid';
import type { Combatant } from '../combat/Combatant';
import { areHostile } from '../combat/teams';
import { BOT, BOT_DIFFICULTY, type BotDifficultyName } from '../config/bots';
import { WEAPONS, type WeaponDef, type WeaponMount } from '../config/weapons';
import type { Physics } from '../physics/Physics';
import type { GameMap, SpawnPoint } from '../world/GameMap';
import { PlayerAvatar } from '../player/PlayerAvatar';
import type { CharacterId } from '../config/characters';
import { Bot, type BotCallbacks, type BotContext } from './Bot';

/** HUD 머리 위 표시용 */
export interface BotLabel {
  name: string;
  hp: number;
  maxHp: number;
  /** 머리 위 월드 위치 */
  world: THREE.Vector3;
  /** 카메라에서 보임 (벽 뒤면 숨김) */
  visible: boolean;
  protected: boolean;
  dead: boolean;
  /** TDM: 플레이어의 아군 (이름표 블루). 개인전은 항상 false (적 = 레드) */
  ally: boolean;
}

/** 봇 캐릭터 모델 (원본 씬은 손대지 않고 복제해서 씀) */
export interface BotCharacterSource {
  id: CharacterId;
  scene: THREE.Object3D;
  clips: THREE.AnimationClip[];
}

export interface BotSources {
  /** 봇별 캐릭터 (봇 순서). 캐릭터 능력치·크기·판정·장착 보정은 id로 정해짐 (플레이어와 같은 규칙) */
  characters: readonly BotCharacterSource[];
  rifle: THREE.Object3D;
}

const LABEL_CHECK_INTERVAL = 0.2;
const LABEL_MAX_DIST = 45;
const PATH_POINTS = 64;
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

/**
 * 봇 생성·리스폰·업데이트. 감지 대상(플레이어 + 봇)을 모아 봇에게 넘기고, 디버그 정보를 만든다.
 */
export class BotManager {
  readonly bots: Bot[] = [];
  readonly nav: NavGrid;
  readonly labels: BotLabel[] = [];
  private readonly combatants: Combatant[] = [];
  private readonly world: BotWorld;
  private readonly ctx: BotContext;
  private labelTimer = 0;
  private readonly pathLines: THREE.Line[] = [];
  private readonly pathMaterial = new THREE.LineBasicMaterial({ color: 0xff3d7f, depthTest: false, transparent: true });
  difficultyName: BotDifficultyName;
  showPaths = false;
  /** 디버그: 마지막 프레임 봇 업데이트 시간 (ms) */
  lastUpdateMs = 0;
  /** 전투 정지 (매치 대기·카운트다운·종료): 봇은 제자리 대기, 감지·사격 없음 */
  hold = false;
  private readonly weapon: WeaponDef;
  private readonly cb: BotCallbacks;
  /** 쓰러진 봇 자동 부활 (매치 종료 후에는 끔) */
  respawnEnabled = true;
  /** 봇이 쓰는 스폰 지점 (기본: 맵의 teamB, 개인전은 모든 스폰 공용) */
  private spawnPool: readonly SpawnPoint[];

  constructor(
    private readonly physics: Physics,
    private readonly scene: THREE.Scene,
    private readonly sources: BotSources,
    private readonly mount: WeaponMount,
    weapon: WeaponDef,
    player: Combatant,
    cb: BotCallbacks,
    /** 맵: 봇 스폰(teamB)·이동 격자 범위 */
    map: GameMap,
    /** 봇 수 (기본 3, 네트워크 테스트는 0) */
    count = 3,
  ) {
    const urlDiff = new URLSearchParams(location.search).get('bots');
    this.difficultyName = urlDiff && urlDiff in BOT_DIFFICULTY ? (urlDiff as BotDifficultyName) : BOT.difficulty;

    this.spawnPool = map.spawns.teamB;
    const n = BOT.nav;
    const t0 = performance.now();
    this.nav = new NavGrid(
      physics,
      {
        ...map.navBounds,
        cellSize: n.cellSize,
        clearance: n.clearance,
        probeBottom: n.probeBottom,
        probeTop: n.probeTop,
      },
      (c) => !physics.isQueryIgnored(c) && !physics.isHitboxOnly(c),
    );
    this.navBuildMs = performance.now() - t0;
    if (this.nav.walkableCount === this.nav.cols * this.nav.rows) {
      // 장애물이 하나도 없으면 쿼리 구조가 비어 있던 것 (physics.step 전에 생성) → 경로가 벽을 통과함
      console.warn('[bots] 이동 격자에 장애물이 없습니다. 물리 스텝 이후에 생성했는지 확인하세요.');
    }
    this.world = {
      nav: this.nav,
      lineOfSight: (from, to) => physics.lineClear(_v.set(from.x, from.y + 1.0, from.z), _w.set(to.x, to.y + 0.8, to.z)),
    };
    this.combatants.push(player);
    this.ctx = {
      combatants: this.combatants,
      findById: (id) => this.combatants.find((c) => c.id === id),
    };

    this.weapon = weapon;
    this.cb = cb;
    this.spawnBots(count);
  }

  /** 매치 끝난 뒤 새로 만들기 (멀티 입장 때 removeAll로 지운 봇을 연습전에서 다시): 이동 격자·스폰 규칙은 그대로 */
  recreate(count = 3): void {
    this.removeAll();
    this.spawnBots(count);
  }

  /** 봇 count명 생성 (아바타·이름표·경로 표시선 포함) */
  private spawnBots(count: number): void {
    const weapon = this.weapon;
    const cb = this.cb;
    const used = new Set<number>();
    for (let i = 0; i < count; i++) {
      const avatar = this.createAvatar(this.sources.characters[i] ?? this.sources.characters[0]!);
      const spawnIdx = this.pickSpawn(null, used);
      used.add(spawnIdx);
      const spawn = this.spawnPoint(spawnIdx, new THREE.Vector3());
      // 봇별 주무기 (데이터만 확장, 지금은 라이플만 지원)
      let def = WEAPONS[BOT.primaryWeapons[i] ?? weapon.id] ?? weapon;
      if (def.id !== weapon.id) {
        console.warn(`[bots] ${def.id}는 아직 봇 무기로 지원하지 않아 ${weapon.id} 사용`);
        def = weapon;
      }
      const bot = new Bot(`bot${i + 1}`, `BOT ${i + 1}`, this.physics, avatar, def, this.world, this.difficulty, spawn, {
        ...cb,
        onDamaged: (b, hit, applied) => {
          if (hit.attacker) b.noticeAttacker(this.ctx.findById(hit.attacker.id), hit.attacker.position);
          cb.onDamaged?.(b, hit, applied);
        },
      }, i);
      this.bots.push(bot);
      this.combatants.push(bot);
      this.labels.push({ name: bot.name, hp: 0, maxHp: bot.health.maxHp, world: new THREE.Vector3(), visible: false, protected: false, dead: false, ally: false });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PATH_POINTS * 3), 3));
      const line = new THREE.Line(geo, this.pathMaterial);
      line.frustumCulled = false;
      line.renderOrder = 30;
      line.visible = false;
      this.scene.add(line);
      this.pathLines.push(line);
    }
  }

  /** 봇 아바타 1개: 캐릭터 GLB 복제 + 라이플 복제 */
  private createAvatar(src: BotCharacterSource): PlayerAvatar {
    const avatar = new PlayerAvatar(SkeletonUtils.clone(src.scene), src.clips, this.sources.rifle.clone(true), this.mount, src.id);
    this.scene.add(avatar.root);
    return avatar;
  }

  /**
   * 개발용: 봇 캐릭터 교체 (CHARACTER DEBUG). 이전 아바타는 해제(애니메이션·머티리얼·장면에서 제거),
   * 새 캐릭터의 크기·판정·장착·체력·속도 적용. AI·난이도·무기는 그대로
   */
  setBotCharacter(index: number, src: BotCharacterSource): PlayerAvatar | null {
    const bot = this.bots[index];
    if (!bot) return null;
    const avatar = this.createAvatar(src);
    bot.setAvatar(avatar);
    this.labels[index]!.maxHp = bot.health.maxHp;
    return avatar;
  }

  /** 디버그: 이동 격자 생성 시간 (ms) */
  readonly navBuildMs: number;

  get difficulty() {
    return BOT_DIFFICULTY[this.difficultyName];
  }

  /** 스폰 지점 목록 바꾸기 (매치 규칙: 진영별 / 모두 공용) */
  setSpawnPool(list: readonly SpawnPoint[]): void {
    if (list.length > 0) this.spawnPool = list;
  }

  /**
   * 새 매치: 모든 봇을 서로 겹치지 않는 스폰에서 부활 (체력·탄약·결정·사망 상태 초기화, 시작 보호 없음).
   * 플레이어를 먼저 배치한 뒤 호출 (플레이어 위치를 피해서 고름)
   */
  resetForMatch(): void {
    const used = new Set<number>();
    const center = new THREE.Vector3();
    for (const b of this.bots) {
      const idx = this.pickSpawn(b, used);
      used.add(idx);
      b.respawn(this.spawnPoint(idx, new THREE.Vector3()), center);
      b.health.protection = 0;
    }
  }

  private spawnPoint(index: number, out: THREE.Vector3): THREE.Vector3 {
    const s = this.spawnPool[index]!;
    const p = this.nav.nearestWalkable(s.x, s.z, out, 8, s.y) ?? out.set(s.x, s.y, s.z);
    p.y = Math.max(p.y, s.y);
    return p;
  }

  /**
   * 스폰 선택: 다른 캐릭터와 겹치지 않는 지점 중, 적에게서 멀고 적 시야 밖인 곳 우선.
   * @param used 이번에 이미 고른 지점 (동시에 여러 봇 생성 시 중복 방지)
   */
  private pickSpawn(self: Bot | null, used: Set<number>): number {
    let best = 0;
    let bestScore = -Infinity;
    const p = _v;
    for (let i = 0; i < this.spawnPool.length; i++) {
      if (used.has(i)) continue;
      this.spawnPoint(i, p);
      let score = 0;
      let minHostile = Infinity;
      let blocked = false;
      for (const c of this.combatants) {
        if (c === self || !c.alive) continue;
        const f = c.getFeet(_w);
        const d = Math.hypot(f.x - p.x, f.z - p.z);
        if (d < BOT.spawnClearance) blocked = true;
        if (self ? areHostile(self, c) : c.team !== 'bots') {
          minHostile = Math.min(minHostile, d);
          const eye = c.getEye(_w);
          if (this.physics.lineClear(eye, _v.clone().setY(p.y + 1))) score -= 15;
        }
      }
      if (blocked) continue;
      score += Math.min(minHostile, 40) + Math.random() * 3;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  /** 고정 스텝 이동 (physics.step 직전) */
  fixedStep(dt: number): void {
    for (const b of this.bots) b.fixedStep(dt, b.brain.intent, this.hold);
  }

  update(dt: number, alpha: number, camera: THREE.Camera): void {
    const t0 = performance.now();
    const diff = this.difficulty;
    for (const b of this.bots) {
      b.update(dt, alpha, this.ctx, diff, this.hold);
      if (!b.alive && b.deathTimer <= 0 && this.respawnEnabled) {
        const idx = this.pickSpawn(b, new Set());
        const p = this.spawnPoint(idx, new THREE.Vector3());
        b.respawn(p, this.combatants[0]!.getFeet(new THREE.Vector3()));
      }
    }
    this.updateLabels(dt, camera);
    this.updatePathLines();
    this.lastUpdateMs = performance.now() - t0;
  }

  private updateLabels(dt: number, camera: THREE.Camera): void {
    this.labelTimer -= dt;
    const check = this.labelTimer <= 0;
    if (check) this.labelTimer = LABEL_CHECK_INTERVAL;
    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i]!;
      const l = this.labels[i]!;
      l.hp = b.health.hp;
      l.dead = !b.alive;
      l.protected = b.isProtected;
      const a = b.avatar;
      l.world.copy(a.headCenter).setY(a.headCenter.y + a.headRadius + 0.25);
      if (check) {
        // 벽 뒤 봇의 이름표는 숨김 (이름표 위치가 아니라 머리 중심 기준 → 벽 위로 이름표만 보이는 정보 노출 방지)
        const d = camera.position.distanceTo(l.world);
        l.visible = d < LABEL_MAX_DIST && this.physics.lineClear(camera.position, a.headCenter);
      }
    }
  }

  private updatePathLines(): void {
    for (let i = 0; i < this.bots.length; i++) {
      const line = this.pathLines[i]!;
      const b = this.bots[i]!;
      line.visible = this.showPaths && b.alive && b.path.length > 0;
      if (!line.visible) continue;
      const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      const feet = b.renderFeet;
      attr.setXYZ(0, feet.x, 0.08, feet.z);
      let n = 1;
      for (let k = b.pathIndex; k < b.path.length && n < PATH_POINTS; k++, n++) {
        const p = b.path[k]!;
        attr.setXYZ(n, p.x, 0.08, p.z);
      }
      attr.needsUpdate = true;
      line.geometry.setDrawRange(0, n);
    }
  }

  /** 개발용 상태 줄 */
  debugLines(): string[] {
    const lines = [`봇 ${this.difficultyName}  AI ${this.lastUpdateMs.toFixed(2)}ms  격자 ${this.nav.cols}×${this.nav.rows} 이동가능 ${this.nav.walkableCount}`];
    for (const b of this.bots) {
      const p = b.perception;
      const target = b.target ? b.target.name : '-';
      const path = b.path.length ? `${Math.min(b.pathIndex, b.path.length)}/${b.path.length}` : '-';
      lines.push(
        `${b.name} [${b.state}] HP ${b.health.hp.toFixed(0)}${b.isProtected ? '(보호)' : ''} 탄 ${b.weapon.magazine}${b.weapon.reloading ? 'R' : ''}` +
          `  표적 ${target} 감지 ${p.visible ? 'O' : p.hasTarget ? `기억 ${p.lastSeenAge.toFixed(1)}s` : 'X'}` +
          ` 사격가능 ${p.canShoot ? 'O' : 'X'}${b.firing ? '(발사)' : ''} 거리 ${p.hasTarget ? p.distance.toFixed(1) : '-'} 경로 ${path}` +
          (b.brain.lastReason ? `  · ${b.brain.lastReason}` : ''),
      );
    }
    return lines;
  }

  /** 봇 전부 제거 (멀티플레이 테스트로 전환할 때). 플레이어는 그대로, 이후 봇 업데이트는 빈 목록 */
  removeAll(): void {
    for (const b of this.bots) b.dispose();
    this.bots.length = 0;
    this.labels.length = 0;
    this.combatants.length = 1;
    for (const l of this.pathLines) {
      l.geometry.dispose();
      this.scene.remove(l);
    }
    this.pathLines.length = 0;
  }

  dispose(): void {
    for (const b of this.bots) b.dispose();
    for (const l of this.pathLines) {
      l.geometry.dispose();
      this.scene.remove(l);
    }
    this.pathMaterial.dispose();
  }
}
