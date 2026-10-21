// 게임 모드: 2인 네트워크 테스트. 네트워크 레이어(NetSession)와 게임(Game)을 잇는다.
// - 로컬 → 서버: 상태(이동·자세·무기), 쏜 탄(연출), 맞혔다는 주장(피해 계산은 서버)
// - 서버 → 로컬: 원격 플레이어 보간 표시, 원격 탄 연출(기존 ToyBullets 경로 재사용), 확정된 피해·사망·리스폰
// Game은 NET_MODE일 때만 이 객체를 만든다 → 싱글플레이 흐름에는 영향 없음.
import * as THREE from 'three';
import type { BotLabel } from '../bots/BotManager';
import type { ShotResult } from '../combat/hitscan';
import type { MeleeResult } from '../combat/melee';
import type { CharacterId } from '../config/characters';
import type { AttackerInfo, HitInfo, Physics } from '../physics/Physics';
import type { PlayerAvatar } from '../player/PlayerAvatar';
import type { DeathCause } from '../ui/KillFeed';
import { NetSession, type LocalState } from './NetSession';
import { RemotePlayer } from './RemotePlayer';
import { NET_CHARACTER_HP, type NetHitResult, type NetPlayers, type NetShot } from './shared/protocol';

/** Game이 넘겨주는 것 (게임 내부 객체 대신 필요한 동작만) */
export interface NetGameContext {
  readonly localId: string;
  readonly physics: Physics;
  camera(): THREE.Camera;
  /** 이번 프레임 로컬 상태 (패킷용) */
  localState(): LocalState;
  /** 원격 캐릭터 아바타 생성 (GLB 캐시·외형 패치·장면 추가까지) */
  createAvatar(id: string, character: CharacterId): Promise<PlayerAvatar>;
  /** 원격 아바타 해제 (장면 제거·리소스 해제) */
  releaseAvatar(avatar: PlayerAvatar): void;
  /** 원격 참가자 외형 등록 해제 (룸을 나감) */
  forgetParticipant(id: string): void;
  weaponModel(weaponId: string): THREE.Object3D;
  registerParticipant(id: string, name: string): void;
  setDeadLook(id: string, dead: boolean): void;
  /** 탄 1발 연출 (Game.presentShotFx: 플레이어·봇과 같은 경로) */
  shotFx(weaponId: string, from: THREE.Vector3, end: THREE.Vector3, kind: 'none' | 'character' | 'world', normal: THREE.Vector3 | null, shooterId: string, headshot: boolean, killed: boolean): void;
  /** 총구 화염·POP·발사음 */
  muzzleFx(shooterId: string, weaponId: string, muzzle: THREE.Vector3, dir: THREE.Vector3, follow: THREE.Vector3): void;
  /** 로컬 플레이어: 서버 체력 반영 / 피해 표시 / 사망 */
  localHp(hp: number, maxHp: number): void;
  localDamaged(source: THREE.Vector3 | null, amount: number): void;
  localKilled(killer: AttackerInfo | null, hit: HitInfo | null, cause: DeathCause): void;
  isLocalDead(): boolean;
  /** 원격 사망·부활 집계·킬로그 */
  remoteKilled(victimId: string, killer: AttackerInfo | null, hit: HitInfo | null, cause: DeathCause): void;
  remoteRespawned(id: string): void;
  /** 내가 쏜 탄이 서버에서 처치로 확정 */
  confirmedKill(): void;
  /** 룸 정보 변경 (방장·진행 상태·참가자·연결) */
  roomInfo(): void;
  /** 룸에서 나옴 (byUser = 직접 나감) */
  leftRoom(reason: string, byUser: boolean): void;
}

const _from = new THREE.Vector3();
const _end = new THREE.Vector3();
const _n = new THREE.Vector3();

function shortName(account: string): string {
  return account.length > 12 ? `${account.slice(0, 6)}…${account.slice(-4)}` : account;
}

function r3(v: THREE.Vector3, d = 1000): [number, number, number] {
  return [Math.round(v.x * d) / d, Math.round(v.y * d) / d, Math.round(v.z * d) / d];
}

export class NetGameMode {
  readonly session: NetSession;
  readonly remotes = new Map<string, RemotePlayer>();
  /** 보간 지연 (ms, 디버그 패널에서 조절) */
  interpDelayMs = 120;
  /** 원격 탄 연출을 아바타 보간 시점에 맞춰 늦춤 */
  syncFxToInterp = true;
  /** 디버그: 원격 탄 연출 수, 확정 명중·처치 */
  remoteShotsShown = 0;
  confirmedHits = 0;
  confirmedKills = 0;
  private readonly creating = new Set<string>();
  /** 점프·착지는 패킷 사이 한 프레임에만 생김 → 다음 패킷까지 모아 둠 */
  private pendingFlags = 0;

  constructor(private readonly ctx: NetGameContext) {
    this.session = new NetSession({
      onRemoteJoin: (acc) => void this.ensureRemote(acc),
      onRemoteLeave: (acc) => this.removeRemote(acc),
      onPlayers: (p) => this.applyPlayers(p),
      onRemoteShots: (acc, shots) => this.remoteShots(acc, shots),
      onHits: (r) => this.applyHits(r),
      onSpawn: (acc, hp) => this.remoteSpawn(acc, hp),
      onRemoteDisconnect: () => undefined,
      onLeftRoom: (reason, byUser) => {
        for (const acc of [...this.remotes.keys()]) this.removeRemote(acc);
        this.ctx.leftRoom(reason, byUser);
      },
      onRoomInfo: () => this.ctx.roomInfo(),
    });
  }

  get labels(): BotLabel[] {
    return [...this.remotes.values()].map((r) => r.label);
  }

  avatarOf(id: string): PlayerAvatar | undefined {
    for (const r of this.remotes.values()) if (r.id === id) return r.avatar;
    return undefined;
  }

  /** 원격 플레이어 발·눈 (스폰 선택용) */
  hostiles(): RemotePlayer[] {
    return [...this.remotes.values()].filter((r) => r.alive && r.hasState);
  }

  // ---------------- 매 프레임 ----------------

  /** 물리 스텝 전: 원격 보간 → 아바타·판정 */
  updateRemotes(dt: number): void {
    const renderTime = performance.now() - this.interpDelayMs;
    const cam = this.ctx.camera();
    for (const [acc, r] of this.remotes) {
      // 연결 유실(30초 유예) 중인 상대는 숨김·판정 제외 (상태가 다시 오면 복구, 유예가 끝나면 퇴장으로 제거)
      r.setHidden(this.session.isLost(acc));
      const buf = this.session.remotes.get(acc);
      r.update(dt, buf ? buf.sample(renderTime) : null, cam);
    }
  }

  /** 프레임 끝: 전송 (로컬 상태는 이번 프레임 값) */
  update(dt: number, justJumped: boolean, justLanded: boolean): void {
    if (justJumped) this.pendingFlags |= 16;
    if (justLanded) this.pendingFlags |= 32;
    this.session.update(dt, () => {
      const s = this.ctx.localState();
      s.f |= this.pendingFlags;
      this.pendingFlags = 0;
      return s;
    });
  }

  // ---------------- 로컬 → 서버 ----------------

  /** 로컬 탄 1발 (연출 + 캐릭터 명중이면 서버 판정용 표시) */
  recordShot(r: ShotResult): void {
    if (!this.session.inRoom || !r.weapon) return;
    const hit = r.hit;
    const shot: NetShot = { w: r.weapon.id, f: r3(r.from), e: r3(r.end), h: hit ? (hit.hitbox ? 1 : 2) : 0 };
    if (hit && !hit.hitbox) shot.n = r3(hit.normal, 100);
    this.session.queueShot(shot);
  }

  /** 근접: 맞힌 대상마다 탄 기록 1건 (서버 연사·명중 수 검증용, 연출 없음) */
  recordMelee(r: MeleeResult, from: THREE.Vector3): void {
    if (!this.session.inRoom) return;
    for (const h of r.hits) this.session.queueShot({ w: 'melee', f: r3(from), e: r3(h.point), h: 1 });
  }

  private claim(target: RemotePlayer, hit: HitInfo): void {
    const from = hit.attacker?.position ?? hit.point;
    this.session.queueHit({ v: target.account, w: hit.weaponId ?? 'rifle', hd: hit.headshot ? 1 : 0, d: Math.round(from.distanceTo(hit.point) * 100) / 100 });
  }

  selfDeath(cause: DeathCause): void {
    if (cause === 'suicide' || cause === 'fall') this.session.selfDeath(cause);
  }

  requestRespawn(): Promise<boolean> {
    return this.session.requestRespawn();
  }

  // ---------------- 서버 → 로컬 ----------------

  private async ensureRemote(account: string): Promise<void> {
    if (this.remotes.has(account) || this.creating.has(account)) return;
    this.creating.add(account);
    try {
      const rec = this.session.players[account];
      const char = this.characterOf(account, rec?.char);
      const id = `net:${account}`;
      const avatar = await this.ctx.createAvatar(id, char);
      // 기다리는 사이 나갔으면 버림
      if (!this.session.remotes.has(account)) {
        this.ctx.releaseAvatar(avatar);
        this.ctx.forgetParticipant(id);
        return;
      }
      const name = shortName(account);
      const remote = new RemotePlayer(this.ctx.physics, account, name, avatar, (w) => this.ctx.weaponModel(w), (t, h) => this.claim(t, h));
      if (rec) remote.setServerState(rec.hp, rec.max, rec.dead);
      this.remotes.set(account, remote);
      this.ctx.registerParticipant(id, name);
      this.ctx.setDeadLook(id, remote.dead);
      this.session.client.addLog('info', `원격 캐릭터 생성 ${name} (${char})`);
    } catch (e) {
      this.session.client.addLog('error', `원격 캐릭터 생성 실패: ${String(e)}`);
    } finally {
      this.creating.delete(account);
    }
  }

  private characterOf(account: string, serverChar?: string): CharacterId {
    const c = serverChar ?? this.session.remotes.get(account)?.latest?.c;
    return (c && c in NET_CHARACTER_HP ? c : 'blue') as CharacterId;
  }

  private removeRemote(account: string): void {
    const r = this.remotes.get(account);
    if (!r) return;
    this.remotes.delete(account);
    this.ctx.releaseAvatar(r.avatar);
    this.ctx.forgetParticipant(r.id);
    r.dispose();
  }

  private applyPlayers(players: NetPlayers): void {
    const me = players[this.session.me];
    if (me && !me.dead && !this.ctx.isLocalDead()) this.ctx.localHp(me.hp, me.max);
    for (const [acc, rec] of Object.entries(players)) {
      if (acc === this.session.me) continue;
      const r = this.remotes.get(acc);
      if (!r) continue;
      const wasDead = r.dead;
      r.setServerState(rec.hp, rec.max, rec.dead);
      if (wasDead !== rec.dead) this.ctx.setDeadLook(r.id, rec.dead);
      // 상대가 캐릭터를 바꿔 들어옴 → 아바타 교체
      if (rec.char !== r.avatar.character.id && rec.char in NET_CHARACTER_HP) void this.swapAvatar(r, rec.char as CharacterId);
    }
  }

  private async swapAvatar(r: RemotePlayer, char: CharacterId): Promise<void> {
    if (this.creating.has(r.account)) return;
    this.creating.add(r.account);
    try {
      const avatar = await this.ctx.createAvatar(r.id, char);
      if (this.remotes.get(r.account) !== r) {
        this.ctx.releaseAvatar(avatar);
        this.ctx.forgetParticipant(r.id);
        return;
      }
      const old = r.avatar;
      r.setAvatar(avatar);
      this.ctx.releaseAvatar(old);
      this.ctx.setDeadLook(r.id, r.dead);
    } finally {
      this.creating.delete(r.account);
    }
  }

  private remoteShots(account: string, shots: NetShot[]): void {
    const r = this.remotes.get(account);
    if (!r) return;
    const play = () => {
      if (!this.remotes.has(account)) return;
      let flashed = '';
      for (const s of shots) {
        _from.set(s.f[0], s.f[1], s.f[2]);
        _end.set(s.e[0], s.e[1], s.e[2]);
        if (s.w === 'melee') continue;
        // 방아쇠 1회(샷건 펠릿 여러 발)에 총구 화염은 한 번
        const key = `${s.w}:${s.f.join(',')}`;
        if (key !== flashed) {
          flashed = key;
          const dir = _n.subVectors(_end, _from).normalize();
          this.ctx.muzzleFx(r.id, s.w, _from, dir.clone(), r.muzzle);
        }
        const kind = s.h === 1 ? 'character' : s.h === 2 ? 'world' : 'none';
        const normal = s.n ? new THREE.Vector3(s.n[0], s.n[1], s.n[2]) : null;
        this.ctx.shotFx(s.w, _from.clone(), _end.clone(), kind, normal, r.id, false, false);
        this.remoteShotsShown++;
      }
    };
    if (this.syncFxToInterp && this.interpDelayMs > 0) setTimeout(play, this.interpDelayMs);
    else play();
  }

  private attackerInfo(account: string | null): AttackerInfo | null {
    if (!account) return null;
    if (account === this.session.me) return { id: this.ctx.localId, name: '나', team: 'player', position: new THREE.Vector3() };
    const r = this.remotes.get(account);
    if (!r) return { id: `net:${account}`, name: shortName(account), team: 'remote', position: new THREE.Vector3() };
    return { id: r.id, name: r.name, team: r.team, position: r.muzzle.clone() };
  }

  private applyHits(results: NetHitResult[]): void {
    const me = this.session.me;
    for (const res of results) {
      const killer = this.attackerInfo(res.a);
      const cause: DeathCause = res.cause === 'fall' ? 'fall' : res.cause === 'suicide' ? 'suicide' : 'weapon';
      const hit: HitInfo | null = res.w
        ? { damage: res.dmg, part: res.hd ? 'head' : 'body', point: new THREE.Vector3(), direction: new THREE.Vector3(), attacker: killer ?? undefined, weaponId: res.w, headshot: res.hd }
        : null;
      if (res.a === me && res.v !== me) {
        this.confirmedHits++;
        if (res.kill) {
          this.confirmedKills++;
          this.ctx.confirmedKill();
        }
      }
      if (res.v === me) {
        // 내 자멸·낙사는 이미 로컬에서 처리함
        if (cause !== 'weapon') continue;
        this.ctx.localDamaged(killer?.position ?? null, res.dmg);
        if (res.kill) this.ctx.localKilled(killer, hit, 'weapon');
        else this.ctx.localHp(res.hp, this.session.players[me]?.max ?? res.hp);
        continue;
      }
      const r = this.remotes.get(res.v);
      if (!r) continue;
      r.hp = res.hp;
      if (res.kill && !r.dead) {
        r.setDead(true);
        this.ctx.setDeadLook(r.id, true);
        this.ctx.remoteKilled(r.id, killer, hit, cause);
      }
    }
  }

  private remoteSpawn(account: string, hp: number): void {
    if (account === this.session.me) return;
    const r = this.remotes.get(account);
    if (!r) return;
    r.hp = hp;
    if (r.dead) {
      r.setDead(false);
      this.ctx.setDeadLook(r.id, false);
      this.ctx.remoteRespawned(r.id);
    }
  }

  dispose(): void {
    this.session.leave('게임 종료');
    void this.session.client.disconnect();
  }
}
