// 네트워크 레이어 1/2: Verse8 Agent8 SDK(@agent8/gameserver) 래퍼. 게임 객체(three.js·물리)는 모른다.
// SDK의 React 훅(useGameServer 등)은 쓰지 않고, 같은 패키지가 export 하는 GameServer 클래스를 직접 쓴다
// (패키지 index는 React 훅까지 끌어오므로 클래스 파일만 import).
// 시뮬레이션 지연·손실은 실제 네트워크와 별개로 이 파일 안에서만 더해지며, 통계에서 "SIM"으로 따로 표시한다.
import { GameServer } from '@agent8/gameserver/dist/src/server/GameServer.js';

export type NetStatus = 'idle' | 'no-verse' | 'connecting' | 'connected' | 'disconnected' | 'error';

/** 시뮬레이션 (진짜 네트워크 아님): 보낼 때·받을 때 각각 latency/2 + 무작위 jitter, 위치 패킷만 손실 */
export interface NetSimulation {
  latencyMs: number;
  jitterMs: number;
  lossPct: number;
}

export interface NetLogEntry {
  t: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface RttStats {
  last: number;
  avg: number;
  min: number;
  max: number;
  samples: number;
}

/** 통계 (누적). bytes는 JSON 문자열 길이 추정 (SDK 실제 전송 형식은 msgpack 등으로 다를 수 있음) */
export class NetCounters {
  sentCalls = 0;
  sentStates = 0;
  sentBytes = 0;
  recvStates = 0;
  recvMessages = 0;
  recvBytes = 0;
  errors = 0;
  lastError = '';
  simDroppedOut = 0;
  simDroppedIn = 0;
  readonly rtt: RttStats = { last: 0, avg: 0, min: Infinity, max: 0, samples: 0 };
  /** 최근 1초 전송·수신 횟수 (rate) */
  sendHz = 0;
  recvHz = 0;
  private sendWindow: number[] = [];
  private recvWindow: number[] = [];

  markSend(now: number): void {
    this.sendWindow.push(now);
  }

  markRecv(now: number): void {
    this.recvWindow.push(now);
  }

  addRtt(ms: number): void {
    const r = this.rtt;
    r.last = ms;
    r.samples++;
    r.avg = r.samples === 1 ? ms : r.avg * 0.85 + ms * 0.15;
    r.min = Math.min(r.min, ms);
    r.max = Math.max(r.max, ms);
  }

  update(now: number): void {
    const cut = now - 1000;
    while (this.sendWindow.length && this.sendWindow[0]! < cut) this.sendWindow.shift();
    while (this.recvWindow.length && this.recvWindow[0]! < cut) this.recvWindow.shift();
    this.sendHz = this.sendWindow.length;
    this.recvHz = this.recvWindow.length;
  }

  reset(): void {
    Object.assign(this, { sentCalls: 0, sentStates: 0, sentBytes: 0, recvStates: 0, recvMessages: 0, recvBytes: 0, errors: 0, lastError: '', simDroppedOut: 0, simDroppedIn: 0 });
    Object.assign(this.rtt, { last: 0, avg: 0, min: Infinity, max: 0, samples: 0 });
    this.sendWindow = [];
    this.recvWindow = [];
  }
}

function approxBytes(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Verse8 verse id: 배포 도구가 .env에 쓰는 VITE_AGENT8_VERSE, 또는 ?verse= (개발 서버에서만) */
export function resolveVerse(): string | null {
  const q = import.meta.env.DEV ? new URLSearchParams(location.search).get('verse') : null;
  const v = q || (import.meta.env.VITE_AGENT8_VERSE as string | undefined) || '';
  return v.trim() || null;
}

export class NetClient {
  readonly sim: NetSimulation = { latencyMs: 0, jitterMs: 0, lossPct: 0 };
  readonly counters = new NetCounters();
  readonly log: NetLogEntry[] = [];
  status: NetStatus = 'idle';
  statusReason = '';
  readonly verse: string | null;
  private server: GameServer | null = null;
  private roomId: string | null = null;
  private readonly offs: Array<() => void> = [];
  /** 상태가 바뀔 때 (디버그 UI) */
  onStatus: (() => void) | null = null;
  /** 연결이 끊김 (서버·네트워크) */
  onDisconnect: ((reason: string) => void) | null = null;
  onRoomDisconnect: ((reason: string) => void) | null = null;

  constructor() {
    this.verse = resolveVerse();
    if (!this.verse) {
      this.status = 'no-verse';
      this.statusReason = 'VITE_AGENT8_VERSE 없음 (배포 전)';
    }
  }

  get account(): string {
    return this.server?.account ?? '';
  }

  get currentRoomId(): string | null {
    return this.roomId;
  }

  get connected(): boolean {
    return this.status === 'connected' && !!this.server?.connected;
  }

  get rsConnected(): boolean {
    return !!this.server?.rsConnected;
  }

  addLog(level: NetLogEntry['level'], text: string): void {
    this.log.push({ t: performance.now(), level, text });
    if (this.log.length > 80) this.log.shift();
    if (level === 'error') {
      this.counters.errors++;
      this.counters.lastError = text;
      console.warn('[net]', text);
    }
  }

  private setStatus(s: NetStatus, reason = ''): void {
    this.status = s;
    this.statusReason = reason;
    this.addLog(s === 'error' ? 'error' : 'info', `연결 상태 ${s}${reason ? ` (${reason})` : ''}`);
    this.onStatus?.();
  }

  /** 게임 서버 연결 (verse가 없으면 시도하지 않음 — 공용 'default' verse에 붙지 않게) */
  async connect(): Promise<boolean> {
    if (!this.verse) {
      this.setStatus('no-verse', 'VITE_AGENT8_VERSE 없음 — 배포 후 생성되는 .env 필요 (docs/MULTIPLAYER_TEST.md)');
      return false;
    }
    if (this.connected) return true;
    this.setStatus('connecting');
    try {
      // 계정: SDK가 ?account= 를 읽음 (인증 토큰이 없을 때만). 같은 브라우저 두 탭은 계정을 따로 줘야 함 (공식 문서)
      this.server = new GameServer({
        verse: this.verse,
        onDisconnect: (code, reason) => {
          this.setStatus('disconnected', `code ${code ?? '-'} ${reason ?? ''}`.trim());
          this.onDisconnect?.(reason ?? String(code ?? ''));
        },
        onError: (e) => this.addLog('error', `GS 오류: ${errText(e)}`),
        onRsDisconnect: (code, reason) => {
          this.addLog('warn', `룸 서버 연결 끊김 code ${code ?? '-'} ${reason ?? ''}`);
          this.onRoomDisconnect?.(reason ?? String(code ?? ''));
        },
        onRsError: (e) => this.addLog('error', `RS 오류: ${errText(e)}`),
      });
      const ok = await this.server.connect();
      if (!ok) throw new Error('connect() false');
      this.setStatus('connected', `verse ${this.server.verse} · account ${this.server.account}`);
      return true;
    } catch (e) {
      this.setStatus('error', errText(e));
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.leaveRoom();
    try {
      await this.server?.disconnect();
    } catch (e) {
      this.addLog('warn', `disconnect: ${errText(e)}`);
    }
    this.server = null;
    this.setStatus('idle', '사용자가 연결 해제');
  }

  async joinRoom(roomId: string): Promise<void> {
    const s = this.requireServer();
    await s.joinRoom(roomId);
    this.roomId = roomId;
    this.addLog('info', `룸 입장 ${roomId}`);
  }

  leaveRoom(): void {
    for (const off of this.offs.splice(0)) off();
    if (this.roomId && this.server) {
      this.server.leaveRoom();
      this.addLog('info', `룸 퇴장 ${this.roomId}`);
    }
    this.roomId = null;
  }

  /** 일반 호출 (응답 있음, 함수 이름당 초당 10회 — SDK가 클라이언트에서 셈) */
  async call<T>(name: string, args: unknown[] = []): Promise<T> {
    const s = this.requireServer();
    this.counters.sentCalls++;
    this.counters.sentBytes += approxBytes(args);
    await this.simDelay();
    const r = (await s.remoteFunction(name, args)) as T;
    await this.simDelay();
    this.counters.recvBytes += approxBytes(r);
    return r;
  }

  /**
   * 상태 스트림 (throttle 호출, 응답 없음). 호출 간격이 throttle 창보다 길어야 버려지지 않는다.
   * 시뮬 손실: reliable=false(위치만)면 버림, true(사격·명중 포함)면 TCP 재전송처럼 지연만 더함
   */
  stream(name: string, args: unknown[], throttleMs: number, reliable: boolean): void {
    const s = this.server;
    if (!s?.rsConnected) return;
    const lost = this.sim.lossPct > 0 && Math.random() * 100 < this.sim.lossPct;
    if (lost && !reliable) {
      this.counters.simDroppedOut++;
      return;
    }
    const send = () => {
      if (!this.server?.rsConnected) return;
      this.counters.sentStates++;
      this.counters.sentBytes += approxBytes(args);
      this.counters.markSend(performance.now());
      this.server.remoteFunction(name, args, { throttle: throttleMs }).catch((e) => this.addLog('error', `${name}: ${errText(e)}`));
    };
    const extra = lost ? this.sim.latencyMs + 40 : 0;
    const d = this.simDelayMs() + extra;
    if (d > 0) setTimeout(send, d);
    else send();
  }

  /** 룸 메시지 구독 (시뮬 지연 적용, droppable이면 시뮬 손실도) */
  onRoomMessage<T>(type: string, cb: (msg: T) => void, droppable = false): void {
    const s = this.requireServer();
    const roomId = this.requireRoom();
    this.offs.push(
      s.onRoomMessage(roomId, type, (msg: T) => {
        this.counters.recvMessages++;
        this.counters.recvBytes += approxBytes(msg);
        this.deliver(() => cb(msg), droppable);
      }),
    );
  }

  /** 룸 전체 사용자 상태 (SDK가 바뀔 때마다 전체 목록 푸시, 바뀐 항목은 __updated) */
  subscribeUsers(cb: (states: Array<Record<string, any> & { account: string; __updated?: boolean }>) => void): void {
    const s = this.requireServer();
    const roomId = this.requireRoom();
    this.offs.push(
      s.subscribeRoomAllUserStates(roomId, (states: Array<Record<string, any> & { account: string }>) => {
        this.counters.recvStates++;
        this.counters.recvBytes += approxBytes(states);
        this.counters.markRecv(performance.now());
        this.deliver(() => cb(states), true);
      }),
    );
  }

  /** 룸 공용 상태 (서버가 소유하는 체력·킬데스) */
  subscribeRoom(cb: (state: Record<string, any>) => void): void {
    const s = this.requireServer();
    const roomId = this.requireRoom();
    this.offs.push(
      s.subscribeRoomState(roomId, (state: Record<string, any>) => {
        this.counters.recvMessages++;
        this.counters.recvBytes += approxBytes(state);
        this.deliver(() => cb(state), false);
      }),
    );
  }

  /** 매 프레임 (rate 창) */
  update(): void {
    this.counters.update(performance.now());
  }

  private deliver(fn: () => void, droppable: boolean): void {
    if (droppable && this.sim.lossPct > 0 && Math.random() * 100 < this.sim.lossPct) {
      this.counters.simDroppedIn++;
      return;
    }
    const d = this.simDelayMs();
    if (d > 0) setTimeout(fn, d);
    else fn();
  }

  private simDelayMs(): number {
    const s = this.sim;
    if (s.latencyMs <= 0 && s.jitterMs <= 0) return 0;
    return Math.max(0, s.latencyMs / 2 + Math.random() * s.jitterMs);
  }

  private simDelay(): Promise<void> {
    const d = this.simDelayMs();
    return d > 0 ? new Promise((r) => setTimeout(r, d)) : Promise.resolve();
  }

  private requireServer(): GameServer {
    if (!this.server) throw new Error('서버에 연결되지 않음');
    return this.server;
  }

  private requireRoom(): string {
    if (!this.roomId) throw new Error('룸에 들어가 있지 않음');
    return this.roomId;
  }
}

export function errText(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as Error & { code?: string }).code;
    return code ? `${code}: ${e.message}` : e.message;
  }
  return typeof e === 'string' ? e : JSON.stringify(e);
}
