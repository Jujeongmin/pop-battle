// 네트워크 레이어 2/2: 2인 테스트 룸 흐름 (만들기·입장·나가기·끊김), 상태 패킷 전송, 원격 상태 보간 버퍼, 서버 이벤트 전달.
// 게임 객체는 모른다 → 결과는 NetSessionEvents 콜백으로만 내보냄 (게임 모드 쪽: NetGameMode).
import { errText, NetClient } from './NetClient';
import { SnapshotBuffer } from './SnapshotBuffer';
import {
  NET_MAX_PLAYERS,
  NET_TIMING,
  type NetHitClaim,
  type NetHitResult,
  type NetPlayers,
  type NetRejected,
  type NetShot,
  type NetStatePacket,
} from './shared/protocol';

export type RoomPhase = 'lobby' | 'joining' | 'in-room';
/** 서버 룸의 테스트 진행 상태 (대기실 / 시작됨) */
export type TestPhase = 'lobby' | 'playing';

/** 룸 코드 표시용 ('pb-abc123' → 'ABC123') */
export function displayCode(roomId: string | null): string {
  return roomId ? roomId.replace(/^pb-/, '').toUpperCase() : '';
}

const JOIN_ERRORS: Record<string, string> = {
  full: '방이 가득 찼어요 (2/2)',
  not_found: '방을 찾을 수 없어요 (코드 확인, 또는 방이 사라짐)',
  bad_code: '방 코드 형식이 올바르지 않아요 (영문·숫자 4~12자)',
};

export interface NetSessionEvents {
  /** 원격 플레이어가 생김 (상태를 처음 받음) / 사라짐 (룸을 나감) */
  onRemoteJoin(account: string): void;
  onRemoteLeave(account: string): void;
  /** 서버가 소유한 참가자 기록 (체력·사망·킬데스) */
  onPlayers(players: NetPlayers): void;
  /** 다른 플레이어의 탄 연출 */
  onRemoteShots(account: string, shots: NetShot[]): void;
  /** 서버가 확정한 명중·사망 */
  onHits(results: NetHitResult[]): void;
  /** 누군가 리스폰 (서버 승인) */
  onSpawn(account: string, hp: number): void;
  /** 원격 플레이어 연결 유실 (30초 유예 중) */
  onRemoteDisconnect(account: string): void;
  /** 내가 룸에서 나옴 (직접 나가기·정원 초과·연결 끊김). byUser = 직접 나감 */
  onLeftRoom(reason: string, byUser: boolean): void;
  /** 룸 정보(방장·진행 상태·참가자·연결) 변경 → UI 갱신 */
  onRoomInfo(): void;
}

/** 이번 프레임 로컬 상태 (q·t·s·h는 세션이 채움) */
export type LocalState = Omit<NetStatePacket, 'q' | 't' | 's' | 'h'>;

export class NetSession {
  readonly client = new NetClient();
  phase: RoomPhase = 'lobby';
  slot = -1;
  /** 원격 계정별 보간 버퍼 */
  readonly remotes = new Map<string, SnapshotBuffer>();
  players: NetPlayers = {};
  rejected = 0;
  lastRejectReason = '';
  /** 마지막 hello 때 서버 시각 - 로컬 시각 (참고용) */
  serverClockOffset = 0;
  /** 서버 룸: 방장 계정·진행 상태·시작 시각 */
  host: string | null = null;
  testPhase: TestPhase = 'lobby';
  startedAt = 0;
  /** 마지막 입장 실패·연결 오류 (UI 표시용, 서버가 준 원인 그대로) */
  lastError = '';
  /** 마지막으로 들어갔던 룸 (재입장용) */
  lastRoomId: string | null = null;
  /** 연결 유실(30초 유예) 중인 원격 계정 → 새 상태가 오면 해제 */
  private readonly lost = new Set<string>();
  private seq = 0;
  private sendTimer = 0;
  private pingTimer = 0;
  private pingInFlight = false;
  private readonly shots: NetShot[] = [];
  private readonly hits: NetHitClaim[] = [];
  private respawnPending = false;
  private characterId = 'blue';

  constructor(private readonly events: NetSessionEvents) {
    this.client.onDisconnect = (r) => this.handleLeft(`게임 서버 연결 끊김${r ? ` (${r})` : ''}`);
    this.client.onRoomDisconnect = (r) => this.handleLeft(`룸 서버 연결 끊김${r ? ` (${r})` : ''}`);
    this.client.onStatus = () => this.events.onRoomInfo();
    // 탭 닫기·새로고침: 바로 퇴장 알림 (응답 기다리지 않음). SDK 소켓도 1001로 닫혀 서버가 즉시 onRoomLeave
    addEventListener('pagehide', () => {
      if (this.inRoom) this.client.fire('bye');
    });
  }

  get isHost(): boolean {
    return this.inRoom && this.host === this.me;
  }

  /** 원격 플레이어가 연결 유실(30초 유예) 중인지 */
  isLost(account: string): boolean {
    return this.lost.has(account);
  }

  get me(): string {
    return this.client.account;
  }

  get inRoom(): boolean {
    return this.phase === 'in-room';
  }

  get roomId(): string | null {
    return this.client.currentRoomId;
  }

  get playerCount(): number {
    return Object.keys(this.players).length;
  }

  // ---------------- 룸 흐름 ----------------

  async createRoom(characterId: string): Promise<boolean> {
    return this.enter(characterId, async () => (await this.client.call<{ roomId: string }>('createRoom')).roomId);
  }

  async joinByCode(characterId: string, code: string): Promise<boolean> {
    return this.enter(characterId, async () => {
      const r = await this.client.call<{ ok: boolean; roomId?: string; reason?: string; count?: number }>('findRoom', [code]);
      if (!r.ok || !r.roomId) throw new Error(JOIN_ERRORS[r.reason ?? ''] ?? `입장 불가 (${r.reason ?? '알 수 없음'})`);
      return r.roomId;
    });
  }

  async quickMatch(characterId: string): Promise<boolean> {
    return this.enter(characterId, async () => (await this.client.call<{ roomId: string }>('quickMatch')).roomId);
  }

  /** 방장만: 테스트 시작 (서버가 2명 확인 후 진행 상태를 룸에 공유) */
  async startTest(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const r = await this.client.call<{ ok: boolean; reason?: string }>('startTest');
      if (!r.ok) this.client.addLog('warn', `시작 거부: ${r.reason}`);
      return r;
    } catch (e) {
      this.client.addLog('error', `startTest: ${errText(e)}`);
      return { ok: false, reason: errText(e) };
    }
  }

  /** 직접 나가기: 서버에 먼저 알려 상대 화면에서 바로 사라지게 (SDK leaveRoom만 쓰면 30초 유예) */
  async leave(reason = '사용자가 나감'): Promise<void> {
    if (this.phase === 'lobby') return;
    if (this.inRoom) {
      await Promise.race([this.client.call('bye').catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
    }
    this.client.leaveRoom();
    this.handleLeft(reason, true);
  }

  private async enter(characterId: string, pickRoom: () => Promise<string>): Promise<boolean> {
    if (this.phase !== 'lobby') return false;
    this.characterId = characterId;
    this.phase = 'joining';
    this.lastError = '';
    this.events.onRoomInfo();
    try {
      if (!(await this.client.connect())) throw new Error(this.client.statusReason || '연결 실패');
      const roomId = await pickRoom();
      await this.client.joinRoom(roomId);
      this.subscribe();
      const hello = await this.client.call<{ slot: number; now: number; players: NetPlayers; host: string | null; phase: TestPhase; startedAt: number }>('hello', [characterId]);
      this.serverClockOffset = hello.now - Date.now();
      if (hello.slot < 0) {
        this.client.addLog('warn', `정원 ${NET_MAX_PLAYERS}명 초과 → 관전자 자리라 나감`);
        this.client.leaveRoom();
        this.lastError = JOIN_ERRORS.full!;
        this.handleLeft('정원 초과');
        return false;
      }
      this.slot = hello.slot;
      this.phase = 'in-room';
      this.lastRoomId = roomId;
      this.applyRoom(hello);
      this.applyPlayers(hello.players);
      this.client.addLog('info', `자리 ${hello.slot} · 참가자 ${Object.keys(hello.players).length}명 · 방장 ${hello.host ?? '-'} · ${hello.phase}`);
      this.events.onRoomInfo();
      return true;
    } catch (e) {
      this.lastError = errText(e);
      this.client.addLog('error', `입장 실패: ${this.lastError}`);
      this.client.leaveRoom();
      this.phase = 'lobby';
      this.events.onRoomInfo();
      return false;
    }
  }

  private subscribe(): void {
    const c = this.client;
    c.subscribeUsers((states) => {
      const now = performance.now();
      const seen = new Set<string>();
      for (const st of states) {
        if (st.account === this.me) continue;
        seen.add(st.account);
        const pkt = st.s as NetStatePacket | undefined;
        if (!pkt) continue;
        if (this.lost.delete(st.account)) this.events.onRoomInfo();
        let buf = this.remotes.get(st.account);
        if (!buf) {
          buf = new SnapshotBuffer();
          this.remotes.set(st.account, buf);
          c.addLog('info', `원격 플레이어 상태 수신 시작 ${st.account}`);
          this.events.onRemoteJoin(st.account);
        }
        buf.push(pkt, now);
      }
    });
    c.subscribeRoom((state) => {
      this.applyRoom(state);
      if (state.players) this.applyPlayers(state.players as NetPlayers);
      this.events.onRoomInfo();
    });
    c.onRoomMessage<{ a: string; s: NetShot[] }>('fx', (m) => {
      if (m.a !== this.me) this.events.onRemoteShots(m.a, m.s);
    }, true);
    c.onRoomMessage<{ r: NetHitResult[] }>('hits', (m) => this.events.onHits(m.r));
    c.onRoomMessage<{ a: string; hp: number }>('spawn', (m) => this.events.onSpawn(m.a, m.hp));
    c.onRoomMessage<{ account: string; slot: number }>('joined', (m) => c.addLog('info', `입장: ${m.account} (자리 ${m.slot})`));
    c.onRoomMessage<{ account: string }>('left', (m) => {
      c.addLog('info', `퇴장: ${m.account}`);
      this.dropRemote(m.account);
    });
    c.onRoomMessage<{ account: string }>('dc', (m) => {
      if (m.account === this.me) return;
      c.addLog('warn', `연결 유실(30초 유예): ${m.account}`);
      this.lost.add(m.account);
      this.events.onRemoteDisconnect(m.account);
      this.events.onRoomInfo();
    });
    c.onRoomMessage<{ r: NetRejected[] }>('rej', (m) => {
      this.rejected += m.r.length;
      this.lastRejectReason = m.r.map((x) => `${x.w}→${x.reason}`).join(', ');
      c.addLog('warn', `서버가 명중 거부: ${this.lastRejectReason}`);
    });
  }

  private applyRoom(state: { host?: string | null; phase?: string; startedAt?: number }): void {
    if (state.host !== undefined) this.host = state.host;
    if (state.phase) this.testPhase = state.phase === 'playing' ? 'playing' : 'lobby';
    if (state.startedAt !== undefined) this.startedAt = state.startedAt;
  }

  private applyPlayers(players: NetPlayers): void {
    this.players = players;
    // 서버 기록에서 빠진 원격 = 나감 (left 메시지를 놓쳐도 정리)
    for (const acc of [...this.remotes.keys()]) if (!players[acc]) this.dropRemote(acc);
    this.events.onPlayers(players);
  }

  private dropRemote(account: string): void {
    this.lost.delete(account);
    if (!this.remotes.delete(account)) return;
    this.events.onRemoteLeave(account);
    this.events.onRoomInfo();
  }

  private handleLeft(reason: string, byUser = false): void {
    if (this.phase === 'lobby') return;
    this.phase = 'lobby';
    this.slot = -1;
    this.host = null;
    this.testPhase = 'lobby';
    this.lost.clear();
    if (!byUser && !this.lastError) this.lastError = reason;
    for (const acc of [...this.remotes.keys()]) this.dropRemote(acc);
    this.players = {};
    this.shots.length = 0;
    this.hits.length = 0;
    this.respawnPending = false;
    this.client.addLog(byUser ? 'info' : 'warn', `룸에서 나옴: ${reason}`);
    this.events.onLeftRoom(reason, byUser);
    this.events.onRoomInfo();
  }

  // ---------------- 전송 ----------------

  queueShot(shot: NetShot): void {
    if (this.inRoom && this.shots.length < 64) this.shots.push(shot);
  }

  queueHit(hit: NetHitClaim): void {
    if (this.inRoom && this.hits.length < 64) this.hits.push(hit);
  }

  /** 매 프레임: 50ms마다 상태 패킷, 1초마다 RTT */
  update(dt: number, state: () => LocalState): void {
    this.client.update();
    if (!this.inRoom) return;
    this.sendTimer += dt * 1000;
    if (this.sendTimer >= NET_TIMING.sendIntervalMs) {
      // 밀린 시간을 이어 붙이지 않음 (throttle 창보다 짧은 간격으로 연달아 보내면 SDK가 버림)
      this.sendTimer = 0;
      const pkt: NetStatePacket = { ...state(), q: ++this.seq, t: Math.round(performance.now()) };
      const reliable = this.shots.length > 0 || this.hits.length > 0;
      if (this.shots.length) pkt.s = this.shots.splice(0);
      if (this.hits.length) pkt.h = this.hits.splice(0);
      this.client.stream('st', [pkt], NET_TIMING.throttleMs, reliable);
    }
    this.pingTimer += dt * 1000;
    if (this.pingTimer >= NET_TIMING.pingIntervalMs && !this.pingInFlight) {
      this.pingTimer = 0;
      this.pingInFlight = true;
      const t0 = performance.now();
      this.client
        .call<{ t: number; s: number }>('ping', [t0])
        .then(() => this.client.counters.addRtt(performance.now() - t0))
        .catch((e) => this.client.addLog('error', `ping: ${errText(e)}`))
        .finally(() => (this.pingInFlight = false));
    }
  }

  // ---------------- 사망·리스폰 (서버 판정) ----------------

  selfDeath(cause: 'suicide' | 'fall'): void {
    if (!this.inRoom) return;
    this.client.call('selfDeath', [cause]).catch((e) => this.client.addLog('error', `selfDeath: ${errText(e)}`));
  }

  /** 리스폰 요청. 서버가 승인하면 true, 아직이면 false (중복 요청은 false) */
  async requestRespawn(): Promise<boolean> {
    if (!this.inRoom || this.respawnPending) return false;
    this.respawnPending = true;
    try {
      const r = await this.client.call<{ ok: boolean; wait?: number }>('respawn');
      if (!r.ok) this.client.addLog('info', `리스폰 대기 ${Math.round(r.wait ?? 0)}ms (서버 시각)`);
      return r.ok;
    } catch (e) {
      this.client.addLog('error', `respawn: ${errText(e)}`);
      return false;
    } finally {
      this.respawnPending = false;
    }
  }

  get character(): string {
    return this.characterId;
  }
}
