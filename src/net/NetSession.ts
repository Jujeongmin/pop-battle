// 네트워크 레이어 2/2: 최대 8인 룸 흐름 (만들기·입장·나가기·끊김), 상태 패킷 전송, 원격 상태 보간 버퍼, 서버 이벤트 전달.
// 게임 객체는 모른다 → 결과는 NetSessionEvents 콜백으로만 내보냄 (게임 모드 쪽: NetGameMode).
import { safeDisplayNick } from './shared/nickFilter';
import { errText, NetClient } from './NetClient';
import { SnapshotBuffer } from './SnapshotBuffer';
import {
  NET_MAX_PLAYERS,
  NET_TIMING,
  type NetMatchPhase,
  type NetMatchResult,
  type NetMode,
  type NetRoomState,
  type NetStanding,
  type NetTeam,
  type NetHitClaim,
  type NetHitResult,
  type NetPlayers,
  type NetRejected,
  type NetShot,
  type NetStatePacket,
} from './shared/protocol';

export type RoomPhase = 'lobby' | 'joining' | 'in-room';

/** 룸 코드 표시용 ('pb-abc123' → 'ABC123') */
export function displayCode(roomId: string | null): string {
  return roomId ? roomId.replace(/^pb-/, '').toUpperCase() : '';
}

/** 방 만들기·빠른 시작 응답: 방 id, 거절이면 이유 문구로 실패 */
function roomOrThrow(r: { roomId?: string; reason?: string }): string {
  if (r.roomId) return r.roomId;
  throw new Error(JOIN_ERRORS[r.reason ?? ''] ?? `입장 불가 (${r.reason ?? '알 수 없음'})`);
}

/** 마지막 룸 (새로고침 뒤 "다시 입장"용, 탭 단위) */
const LAST_ROOM_KEY = 'popbattle.lastRoom';

function readLastRoom(): string | null {
  try {
    return sessionStorage.getItem(LAST_ROOM_KEY);
  } catch {
    return null;
  }
}

function writeLastRoom(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(LAST_ROOM_KEY, id);
    else sessionStorage.removeItem(LAST_ROOM_KEY);
  } catch {
    /* 저장소를 못 쓰면 새로고침 뒤 복귀 버튼만 안 뜸 */
  }
}

const JOIN_ERRORS: Record<string, string> = {
  full: `방이 가득 찼어요 (${NET_MAX_PLAYERS}/${NET_MAX_PLAYERS})`,
  not_found: '방을 찾을 수 없어요 (코드 확인, 또는 방이 사라짐)',
  bad_code: '방 코드 형식이 올바르지 않아요 (영문·숫자 4~12자)',
  in_progress: '매치가 진행 중이라 지금은 들어갈 수 없어요 (끝나고 다시 시도)',
  left_match: 'Leave Room으로 나간 매치에는 다시 들어갈 수 없어요 (매치가 끝나면 입장 가능)',
  team_full: '원래 팀에 자리가 없어 복귀할 수 없어요',
  nick_required: '닉네임 변경이 필요해요 (운영 정책) — 새 닉네임을 정한 뒤 들어갈 수 있어요',
};

/** 자동 재접속 간격 (ms): 1·2·3·5·8·10초 → 약 29초 (서버 30초 유예 안 + 지난 뒤에도 기록 복구) */
const RECONNECT_DELAYS_MS = [1000, 2000, 3000, 5000, 8000, 10000];
/** 다시 시도해도 결과가 같은 거절 (자동 재접속 중단) */
const NO_RETRY = new Set(['not_found', 'left_match', 'team_full', 'in_progress', 'bad_code']);

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
  phase: RoomPhase = 'lobby';
  /** 표시 닉네임 (방 입장 hello 때 서버에 보냄, 서버가 다시 검사) */
  nick: string | null = null;
  slot = -1;
  /** 원격 계정별 보간 버퍼 */
  readonly remotes = new Map<string, SnapshotBuffer>();
  players: NetPlayers = {};
  rejected = 0;
  lastRejectReason = '';
  /** 디버그: 서버가 거부한 명중 사유별 수 */
  readonly rejectCounts: Record<string, number> = {};
  /** 서버 시각 - 로컬 Date.now (hello·ping 때 갱신, 카운트다운·남은 시간 계산용) */
  serverClockOffset = 0;
  /** 서버 룸: 방장·게임 모드·매치 단계·GO 시각·종료 시각·팀 점수·결과·나간 사람 기록 */
  host: string | null = null;
  mode: NetMode = 'test';
  matchPhase: NetMatchPhase = 'lobby';
  startAt = 0;
  endAt = 0;
  teamScore: Record<NetTeam, number> = { BLUE: 0, RED: 0 };
  result: NetMatchResult | null = null;
  gone: Record<string, NetStanding> = {};
  /** 마지막 입장 실패·연결 오류 (UI 표시용, 서버가 준 원인 그대로) */
  lastError = '';
  /** 마지막으로 들어갔던 룸 (재입장용) */
  lastRoomId: string | null = readLastRoom();
  /** 이번 매치 제한 시간 (서버, ms) */
  timeLimitMs = 0;
  /** 다른 플레이어 입장·퇴장·끊김 알림 (화면 토스트) */
  onNotice: ((text: string) => void) | null = null;
  /** 자동 재접속 중 (시도 번호 1부터, 0 = 다음 시도 대기) */
  reconnecting = false;
  reconnectAttempt = 0;
  readonly reconnectMax = RECONNECT_DELAYS_MS.length;
  /** 자동 재접속 성공 → 게임으로 복귀 (Game이 연결) */
  onReconnected: (() => void) | null = null;
  /** 마지막 입장 거절 이유 코드 (서버 reason) */
  lastErrorCode = '';
  private reconnectToken = 0;
  /** 직접 나간 계정 (나가기 뒤 SDK가 보내는 연결 끊김 알림은 무시) */
  private readonly departed = new Set<string>();
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

  /** client: 온라인 로비와 공유하는 연결 (같은 계정은 SDK 연결이 하나) */
  constructor(
    private readonly events: NetSessionEvents,
    readonly client: NetClient = new NetClient(),
  ) {
    this.client.onDisconnect = (r) => this.handleLeft(`게임 서버 연결 끊김${r ? ` (${r})` : ''}`);
    this.client.onRoomDisconnect = (r) => this.handleLeft(`룸 서버 연결 끊김${r ? ` (${r})` : ''}`);
    this.client.onStatus = () => this.events.onRoomInfo();
    // 탭 닫기·새로고침: 바로 퇴장 알림 (응답 기다리지 않음). SDK 소켓도 1001로 닫혀 서버가 즉시 onRoomLeave.
    // Leave Room과 달리 quit 아님 → 같은 계정은 진행 중인 매치에 다시 들어올 수 있음
    addEventListener('pagehide', () => {
      if (this.inRoom) this.client.fire('bye', [{ quit: false }]);
    });
  }

  /**
   * 테스트 이벤트 로그: 시간·룸·나·이벤트·상태값. 패널 로그에는 모두, 브라우저 콘솔에는 console이 true인 것만 (이동 패킷은 남기지 않음).
   * 계정은 앞뒤만, 인증 토큰은 다루지 않음
   */
  logEvent(event: string, data: Record<string, unknown> = {}, console_ = true): void {
    const short = (v: unknown) => (typeof v === 'string' && v.length > 14 && v.startsWith('0x') ? `${v.slice(0, 6)}…${v.slice(-4)}` : v);
    const body = Object.entries(data)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : short(v)}`)
      .join(' ');
    const line = `[${event}] room=${this.roomId ?? this.lastRoomId ?? '-'} me=${short(this.me) || '-'} ${body}`;
    this.client.addLog('info', line);
    if (console_) console.info(`[net] ${new Date().toISOString()} ${line}`);
  }

  /**
   * 화면 표시 이름 (킬로그·이름표·알림·결과): 서버가 검사해 저장한 표시 닉네임, 없으면 자리 번호.
   * 계정(account)·캐릭터 id는 식별에만 쓰고 화면에 보이지 않음. 닉네임이 겹쳐도 서버·게임은 계정으로 구분
   */
  displayName(account: string): string {
    if (account === this.me) return '나';
    return this.nickOf(account) ?? this.slotName(account);
  }

  /** 서버에 저장된 표시 닉네임 (없으면 null) */
  nickOf(account: string): string | null {
    const p = this.players[account] ?? this.gone[account] ?? this.result?.standings.find((s) => s.account === account);
    // 예전 규칙으로 저장된 이름이 지금 규칙에 걸리면 '닉네임 변경 필요' (계정·전적은 그대로)
    return safeDisplayNick(p?.nick);
  }

  /** 닉네임이 없을 때 쓰는 자리 이름 (P1~P8) */
  slotName(account: string): string {
    const p = this.players[account] ?? this.gone[account] ?? this.result?.standings.find((s) => s.account === account);
    return p ? `P${p.slot + 1}` : '플레이어';
  }

  /** 서버 시각 추정 (ms) */
  serverNow(): number {
    return Date.now() + this.serverClockOffset;
  }

  /** 매치가 돌아가는 중 (카운트다운·진행) */
  get inMatch(): boolean {
    return this.matchPhase === 'countdown' || this.matchPhase === 'playing';
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

  /** 방 만들기 + 방장으로 모드 지정 (서버가 모드·팀을 확정해 룸 상태로 알려 줌) */
  async createRoom(characterId: string, mode: NetMode = 'test'): Promise<boolean> {
    const ok = await this.enter(characterId, async () => roomOrThrow(await this.client.call<{ roomId?: string; reason?: string }>('createRoom')));
    if (ok && this.mode !== mode) await this.setMode(mode);
    if (ok) this.logEvent('Room Created', { mode });
    return ok;
  }

  /** 방장: 모드 변경 (대기실·결과에서만) */
  async setMode(mode: NetMode): Promise<{ ok: boolean; reason?: string }> {
    return this.hostCall('setMode', [mode]);
  }

  /** TDM 대기실: 빈 칸으로 옮기기 (어느 팀이든) */
  async moveSeat(team: NetTeam, seat: number): Promise<{ ok: boolean; reason?: string }> {
    return this.hostCall('moveSeat', [team, seat]);
  }

  /** TDM 대기실: 내 팀 바꾸기 */
  async switchTeam(): Promise<{ ok: boolean; reason?: string }> {
    return this.hostCall('switchTeam', []);
  }

  /** 결과 화면 → 모두 대기실로 */
  async toLobby(): Promise<{ ok: boolean; reason?: string }> {
    return this.hostCall('toLobby', []);
  }

  private async hostCall(name: string, args: unknown[]): Promise<{ ok: boolean; reason?: string }> {
    try {
      const r = await this.client.call<{ ok: boolean; reason?: string }>(name, args);
      if (!r.ok) this.client.addLog('warn', `${name} 거부: ${r.reason}`);
      return r;
    } catch (e) {
      this.client.addLog('error', `${name}: ${errText(e)}`);
      return { ok: false, reason: errText(e) };
    }
  }

  async joinByCode(characterId: string, code: string): Promise<boolean> {
    return this.enter(characterId, async () => {
      const r = await this.client.call<{ ok: boolean; roomId?: string; reason?: string; count?: number }>('findRoom', [code]);
      if (!r.ok || !r.roomId) {
        this.lastErrorCode = r.reason ?? '';
        throw new Error(JOIN_ERRORS[r.reason ?? ''] ?? `입장 불가 (${r.reason ?? '알 수 없음'})`);
      }
      return r.roomId;
    });
  }

  async quickMatch(characterId: string): Promise<boolean> {
    const ok = await this.enter(characterId, async () => roomOrThrow(await this.client.call<{ roomId?: string; reason?: string }>('quickMatch')));
    // 기다리는 방이 없어 새 방을 만든 경우(내가 방장): 서버 새 방 기본값이 자유 테스트라 개인전으로 (자유 테스트 방이 생기지 않게)
    if (ok && this.isHost && this.mode === 'test') await this.setMode('ffa');
    return ok;
  }

  /** 방장만: 매치 시작 (서버가 모드별 인원·팀 확인 후 카운트다운·종료 시각을 룸에 공유) */
  async startMatch(timeLimitSec?: number): Promise<{ ok: boolean; reason?: string }> {
    return this.hostCall('startMatch', timeLimitSec ? [{ timeLimitSec }] : []);
  }

  /** 끊긴 뒤 같은 룸으로 다시 입장 (같은 계정이면 서버가 자리·팀·기록을 되살림) */
  async rejoin(characterId: string): Promise<boolean> {
    const id = this.lastRoomId;
    if (!id) return false;
    this.logEvent('Reconnection Attempted');
    const ok = await this.joinByCode(characterId, id);
    this.logEvent(ok ? 'Reconnected' : 'Reconnection Failed', ok ? { slot: this.slot, phase: this.matchPhase } : { reason: this.lastError });
    // 방이 이미 사라졌으면 복귀 버튼을 지움
    if (!ok && this.lastError === JOIN_ERRORS.not_found) {
      this.lastRoomId = null;
      writeLastRoom(null);
    }
    return ok;
  }

  /**
   * 자동 재접속 (예상치 못한 끊김 뒤): 1·2·3·5·8·10초 간격으로 최대 6번 같은 룸에 다시 입장.
   * 성공하면 onReconnected (서버가 자리·팀·기록을 되살림), 같은 결과가 나올 거절(방 없음·직접 나감 등)이면 중단 → 수동 "다시 입장"
   */
  private async autoReconnect(): Promise<void> {
    const token = ++this.reconnectToken;
    this.reconnecting = true;
    this.reconnectAttempt = 0;
    this.events.onRoomInfo();
    for (const delay of RECONNECT_DELAYS_MS) {
      await new Promise((r) => setTimeout(r, delay));
      // 사용자가 취소했거나 다른 방에 들어감
      if (token !== this.reconnectToken || this.phase !== 'lobby') return;
      this.reconnectAttempt++;
      this.events.onRoomInfo();
      const ok = await this.rejoin(this.characterId);
      if (token !== this.reconnectToken) return;
      if (ok) {
        this.reconnecting = false;
        this.onReconnected?.();
        this.events.onRoomInfo();
        return;
      }
      if (NO_RETRY.has(this.lastErrorCode)) break;
    }
    if (token !== this.reconnectToken) return;
    this.reconnecting = false;
    this.lastError = `자동 재접속 실패 — ${this.lastError || '서버 응답 없음'}`;
    this.logEvent('Reconnection Gave Up', { attempts: this.reconnectAttempt, reason: this.lastErrorCode || this.lastError });
    this.events.onRoomInfo();
  }

  /** 자동 재접속 취소 (사용자가 직접 다른 동작을 고름) */
  cancelReconnect(): void {
    if (!this.reconnecting) return;
    this.reconnectToken++;
    this.reconnecting = false;
    this.events.onRoomInfo();
  }

  /**
   * Leave Room: 서버에 먼저 알려 상대 화면에서 바로 사라지게 (SDK leaveRoom만 쓰면 30초 유예).
   * quit → 진행 중인 이 매치에는 다시 못 들어옴 (새로고침·끊김과 구분)
   */
  async leave(reason = '사용자가 나감'): Promise<void> {
    this.cancelReconnect();
    if (this.phase === 'lobby') return;
    if (this.inRoom) {
      await Promise.race([this.client.call('bye', [{ quit: true }]).catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
    }
    this.client.leaveRoom();
    this.handleLeft(reason, true);
  }

  private async enter(characterId: string, pickRoom: () => Promise<string>): Promise<boolean> {
    if (this.phase !== 'lobby') return false;
    this.characterId = characterId;
    this.phase = 'joining';
    this.lastError = '';
    this.lastErrorCode = '';
    this.events.onRoomInfo();
    try {
      if (!(await this.client.connect())) throw new Error(this.client.statusReason || '연결 실패');
      const roomId = await pickRoom();
      await this.client.joinRoom(roomId);
      this.subscribe();
      const t0 = Date.now();
      const hello = await this.client.call<NetRoomState & { slot: number; now: number; reason?: string }>('hello', [characterId, this.nick ?? undefined]);
      this.serverClockOffset = hello.now - (t0 + Date.now()) / 2;
      if (hello.slot < 0) {
        const why = hello.reason && JOIN_ERRORS[hello.reason] ? hello.reason : 'full';
        this.client.addLog('warn', `입장 거절 (${why}) → 나감${why === 'full' ? ` (정원 ${NET_MAX_PLAYERS}명)` : ''}`);
        this.client.leaveRoom();
        this.lastErrorCode = why;
        this.lastError = JOIN_ERRORS[why]!;
        this.handleLeft(this.lastError);
        return false;
      }
      this.slot = hello.slot;
      this.phase = 'in-room';
      this.lastRoomId = roomId;
      writeLastRoom(roomId);
      this.applyRoom(hello);
      this.applyPlayers(hello.players);
      this.logEvent('Room Joined', { slot: hello.slot, players: Object.keys(hello.players).length, host: hello.host, mode: hello.mode, phase: hello.phase, k: hello.players[this.me]?.k, d: hello.players[this.me]?.d });
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
        // 서버 참가자 기록에 없는 계정 = 나갔거나(나가기 뒤 30초 유예 동안 SDK가 상태를 계속 보냄) 정원 밖 관전자 → 무시
        if (!this.players[st.account]) continue;
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
    c.onRoomMessage<{ r: NetHitResult[] }>('hits', (m) => {
      for (const h of m.r) {
        // 피해는 패널 로그만 (연사 중 콘솔이 넘치지 않게), 처치는 콘솔에도
        if (h.kill) this.logEvent('Player Killed', { attacker: h.a ?? h.cause, victim: h.v, weapon: h.w, headshot: h.hd });
        else this.logEvent('Damage Applied', { attacker: h.a, victim: h.v, weapon: h.w, dmg: h.dmg, hp: h.hp, headshot: h.hd }, false);
      }
      this.events.onHits(m.r);
    });
    c.onRoomMessage<{ a: string; hp: number }>('spawn', (m) => {
      this.logEvent('Player Respawned', { account: m.a, hp: m.hp });
      this.events.onSpawn(m.a, m.hp);
    });
    c.onRoomMessage<{ account: string; slot: number }>('joined', (m) => {
      this.logEvent('Player Joined', { account: m.account, slot: m.slot });
      this.departed.delete(m.account);
      if (m.account !== this.me) this.onNotice?.(`${this.displayName(m.account)} 입장`);
    });
    c.onRoomMessage<{ account: string; quit?: boolean }>('left', (m) => {
      this.logEvent('Player Left', { account: m.account, inMatch: this.inMatch, quit: m.quit === true });
      this.departed.add(m.account);
      if (m.account !== this.me) this.onNotice?.(`${this.displayName(m.account)} 나감${this.inMatch ? (m.quit ? ' — 기록은 결과에 남아요' : ' — 다시 돌아올 수 있어요') : ''}`);
      this.dropRemote(m.account);
    });
    c.onRoomMessage<{ account: string }>('dc', (m) => {
      if (m.account === this.me || this.departed.has(m.account)) return;
      this.logEvent('Connection Lost', { account: m.account, grace: '30s' });
      this.lost.add(m.account);
      this.onNotice?.(`${this.displayName(m.account)} 연결 끊김 — 재접속 대기 중`);
      this.events.onRemoteDisconnect(m.account);
      this.events.onRoomInfo();
    });
    c.onRoomMessage<{ r: NetRejected[] }>('rej', (m) => {
      this.rejected += m.r.length;
      for (const x of m.r) this.rejectCounts[x.reason] = (this.rejectCounts[x.reason] ?? 0) + 1;
      this.lastRejectReason = m.r.map((x) => `${x.w}→${x.reason}`).join(', ');
      c.addLog('warn', `서버가 명중 거부: ${this.lastRejectReason}`);
    });
  }

  private applyRoom(state: Partial<NetRoomState>): void {
    if (state.host !== undefined) this.host = state.host;
    if (state.mode) this.mode = state.mode;
    if (state.phase && state.phase !== this.matchPhase && this.inRoom) {
      if (state.phase === 'countdown') this.logEvent('Match Started', { mode: state.mode ?? this.mode, startAt: state.startAt, endAt: state.endAt, timeLimitMs: state.timeLimitMs });
      if (state.phase === 'result') this.logEvent('Match Ended', { reason: state.result?.reason, teamScore: state.result?.teamScore, winners: state.result?.winners.length, draw: state.result?.draw });
    }
    if (state.phase) this.matchPhase = state.phase;
    if (state.timeLimitMs !== undefined) this.timeLimitMs = state.timeLimitMs;
    if (state.startAt !== undefined) this.startAt = state.startAt;
    if (state.endAt !== undefined) this.endAt = state.endAt;
    if (state.teamScore) this.teamScore = state.teamScore;
    if (state.result !== undefined) this.result = state.result;
    if (state.gone) this.gone = state.gone;
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
    const wasInRoom = this.phase === 'in-room';
    // 연결이 끊겨 나온 경우에도 룸 구독을 정리 (안 하면 다시 들어갈 때 구독이 겹쳐 탄 연출·명중 이벤트가 두 번 처리됨)
    this.client.dropRoom();
    if (byUser) writeLastRoom(null);
    else if (this.phase === 'in-room') this.logEvent('Connection Lost', { reason, self: true });
    this.phase = 'lobby';
    this.slot = -1;
    this.host = null;
    this.matchPhase = 'lobby';
    this.result = null;
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
    // 룸 안에 있다가 예상치 못하게 끊김 → 자동 재접속 (입장 실패·직접 나감은 제외)
    if (!byUser && wasInRoom && this.lastRoomId) void this.autoReconnect();
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
      const d0 = Date.now();
      this.client
        .call<{ t: number; s: number }>('ping', [t0])
        .then((r) => {
          this.client.counters.addRtt(performance.now() - t0);
          // 서버 시각 추정 (왕복의 가운데). 시뮬 지연이 켜져 있으면 그만큼 흔들림
          if (r && typeof r.s === 'number') this.serverClockOffset = r.s - (d0 + Date.now()) / 2;
        })
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
  /**
   * 리스폰 요청. prot = 서버가 정한 보호 끝 시각 (서버 ms). 예전 서버는 안 보냄 → undefined
   */
  async requestRespawn(): Promise<{ ok: boolean; prot?: number }> {
    if (!this.inRoom || this.respawnPending) return { ok: false };
    this.respawnPending = true;
    try {
      const r = await this.client.call<{ ok: boolean; wait?: number; prot?: number }>('respawn');
      if (!r.ok) this.client.addLog('info', `리스폰 대기 ${Math.round(r.wait ?? 0)}ms (서버 시각)`);
      return { ok: r.ok, prot: r.ok && typeof r.prot === 'number' ? r.prot : undefined };
    } catch (e) {
      this.client.addLog('error', `respawn: ${errText(e)}`);
      return { ok: false };
    } finally {
      this.respawnPending = false;
    }
  }

  get character(): string {
    return this.characterId;
  }
}
