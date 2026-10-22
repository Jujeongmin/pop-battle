// 온라인 로비 (허브) 세션: 로비 인스턴스(lb-N) 배정·입장·퇴장, 내 위치 전송, 같은 로비 사람들의 상태 수신.
// 게임 객체(three.js)는 모른다 → 원격 사람은 HubPeer(보간 버퍼)로 내보내고 그리기는 LobbyPeers가 한다.
// 연결(NetClient)은 매치와 공유 (같은 계정은 SDK 연결·룸이 하나) → 매치에 들어가기 전에 stop()으로 로비 룸을 먼저 나간다.
import { errText, type NetClient } from './NetClient';
import { SnapshotBuffer } from './SnapshotBuffer';
import { HUB_MAX_PLAYERS, HUB_TIMING, isHubRoom, type NetHubPacket, type NetHubUserState, type NetStatePacket } from './shared/protocol';

/**
 * idle = 로비 밖 · offline = 서버 기능 없음(verse 미설정) · connecting = 첫 연결 · online ·
 * disconnected = 끊김·실패 후 다음 시도 대기 · reconnecting = 다시 연결하는 중
 */
export type HubStatus = 'idle' | 'offline' | 'connecting' | 'online' | 'disconnected' | 'reconnecting';

/** 같은 로비의 다른 사람 (계정은 식별용, 화면에는 닉네임만) */
export interface HubPeer {
  readonly account: string;
  nick: string;
  char: string;
  /** 손에 든 주무기 id (보이기만, 로비에서는 쏘지 않음) */
  weapon: string;
  readonly buffer: SnapshotBuffer;
}

export interface HubEvents {
  onPeerJoin(peer: HubPeer): void;
  onPeerLeave(account: string): void;
  /** 닉네임·캐릭터·무기가 바뀜 */
  onPeerChange(peer: HubPeer): void;
}

/** 이번 프레임 내 상태 (발 위치·몸 방향·속도·이동 모드·비트: 1 grounded · 2 sprinting · 16 jumped · 32 landed) */
export interface HubLocal {
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vy: number;
  vz: number;
  m: number;
  f: number;
}

/** 다시 연결 간격 (ms) */
const RETRY_MS = [2000, 4000, 8000, 15000];

/** 로비 위치 패킷 → 보간 버퍼용 상태 (조준·전투 값은 로비에서 쓰지 않는 기본값) */
function toState(p: NetHubPacket, c: string, w: string): NetStatePacket {
  return {
    q: p[0],
    t: p[1],
    p: [p[2], p[3], p[4]],
    v: [p[6], p[7], p[8]],
    y: p[5],
    a: [Math.sin(p[5]), 0, Math.cos(p[5])],
    pi: 0,
    m: p[9],
    f: p[10],
    w,
    c,
    rl: 0,
    ms: 0,
    bp: 0,
    ads: 0,
    k: 0,
  };
}

export class LobbyHub {
  status: HubStatus = 'idle';
  roomId: string | null = null;
  max = HUB_MAX_PLAYERS;
  readonly peers = new Map<string, HubPeer>();
  /** 진단 (개발 로그): 보낸 위치 패킷·안 움직여서 건너뛴 횟수·받은 상태 푸시 */
  readonly stats = { sent: 0, skipped: 0, recv: 0 };
  private wanted = false;
  private token = 0;
  private info = { char: 'blue', nick: '', weapon: 'rifle' };
  /**
   * 순번: 작은 수로 압축 (1부터). 새로고침하면 pagehide의 hubBye로 상대가 나를 지웠다가 새 버퍼로 다시 받으므로
   * 순번이 처음부터 시작해도 버려지지 않음
   */
  private seq = 0;
  private sendTimer = 0;
  private last: NetHubPacket | null = null;
  private pendingFlags = 0;
  private retry = 0;
  private retryAt = 0;
  private readonly listener = {
    onDisconnect: (r: string) => this.dropped(r),
    onRoomDisconnect: (r: string) => this.dropped(r),
  };
  private readonly onPageHide = (): void => {
    if (this.inHubRoom) this.client.fire('hubBye');
  };

  constructor(
    private readonly client: NetClient,
    private readonly events: HubEvents,
  ) {
    client.listeners.add(this.listener);
    addEventListener('pagehide', this.onPageHide);
  }

  /** 로비에 들어가 있기를 원함 (stop 전까지) */
  get active(): boolean {
    return this.wanted;
  }

  /** 같은 로비 인원 (나 포함, 접속 완료 때만) */
  get count(): number | null {
    return this.status === 'online' ? 1 + this.peers.size : null;
  }

  private get inHubRoom(): boolean {
    return this.status === 'online' && isHubRoom(this.client.currentRoomId);
  }

  /** 로비 접속 시작 (이미 시작했으면 정보만 갱신) */
  start(char: string, nick: string, weapon: string): void {
    this.info = { char, nick, weapon };
    if (this.wanted) return;
    this.wanted = true;
    this.retry = 0;
    void this.enter();
  }

  /** 로비에서 나감 (매치로 이동·로비 화면을 떠남): 다른 사람 화면에서 바로 숨김 → 로비 룸 퇴장 → 원격 사람 정리 */
  async stop(): Promise<void> {
    if (!this.wanted && this.status === 'idle') return;
    this.wanted = false;
    this.token++;
    if (this.inHubRoom) {
      await Promise.race([this.client.call('hubBye').catch(() => undefined), new Promise((r) => setTimeout(r, 600))]);
    }
    this.leaveHubRoom();
    this.status = 'idle';
    this.roomId = null;
  }

  /**
   * 캐릭터·닉네임·무기 변경 (접속 중이면 서버에 알림). send = false: 이미 서버가 바꿈(nickSet) → 다음 입장용 값만 갱신
   */
  setInfo(info: { char?: string; nick?: string; weapon?: string }, send = true): void {
    if (info.char) this.info.char = info.char;
    if (info.nick) this.info.nick = info.nick;
    if (info.weapon) this.info.weapon = info.weapon;
    if (send && this.inHubRoom) {
      this.client.call('hubInfo', [{ c: info.char, n: info.nick, w: info.weapon }]).catch((e) => this.client.addLog('warn', `hubInfo: ${errText(e)}`));
    }
  }

  /**
   * 매 프레임: 다시 연결 시도 + 내 위치 전송 (최대 8회/초, 안 움직이면 보내지 않음).
   * local = null이면 보내지 않음 (메뉴가 덮고 있는 등)
   */
  update(dt: number, local: HubLocal | null): void {
    if (this.wanted && this.status === 'disconnected' && performance.now() >= this.retryAt) void this.enter();
    if (!local || !this.inHubRoom) return;
    this.pendingFlags |= local.f & 48;
    this.sendTimer += dt * 1000;
    if (this.sendTimer < HUB_TIMING.sendIntervalMs) return;
    this.sendTimer = 0;
    // 압축: 위치·방향 cm·0.01rad, 속도 0.1m/s (보간·애니메이션에 충분, 서버 검사 그대로)
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const f = (local.f & ~48) | this.pendingFlags;
    const pkt: NetHubPacket = [0, Math.round(performance.now()), r2(local.x), r2(local.y), r2(local.z), r2(local.yaw), r1(local.vx), r1(local.vy), r1(local.vz), local.m, f];
    const l = this.last;
    // 멈춰 있고 이전과 같으면 건너뜀 (멈춘 자리는 마지막 패킷이 이미 알림)
    if (l && f === l[10] && local.m === l[9] && Math.abs(pkt[2] - l[2]) < 0.01 && Math.abs(pkt[3] - l[3]) < 0.01 && Math.abs(pkt[4] - l[4]) < 0.01 && Math.abs(pkt[5] - l[5]) < 0.02 && Math.hypot(pkt[6], pkt[7], pkt[8]) < 0.05) {
      this.stats.skipped++;
      return;
    }
    pkt[0] = ++this.seq;
    this.pendingFlags = 0;
    this.last = pkt;
    this.stats.sent++;
    this.client.stream('hubMove', [pkt], HUB_TIMING.throttleMs, false);
  }

  /** 지금 바로 다시 연결 (화면의 다시 시도 버튼) */
  retryNow(): void {
    if (this.wanted && this.status === 'disconnected') this.retryAt = 0;
  }

  /** 마지막 실패 이유 (개발 로그·디버그용, 화면 문구는 상태로) */
  lastError = '';

  dispose(): void {
    void this.stop();
    this.client.listeners.delete(this.listener);
    removeEventListener('pagehide', this.onPageHide);
  }

  // ---------------- 입장·퇴장 ----------------

  /** 배정(hubFind) → 입장 → 구독 → 등록(hubHello). 정원 초과면 다시 배정 (최대 3번) */
  private async enter(): Promise<void> {
    const token = ++this.token;
    this.status = this.retry > 0 ? 'reconnecting' : 'connecting';
    try {
      if (!(await this.client.connect())) {
        if (token !== this.token) return;
        if (this.client.status === 'no-verse') {
          this.status = 'offline';
          return;
        }
        throw new Error(this.client.statusReason || '연결 실패');
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const found = await this.client.call<{ roomId: string; max: number }>('hubFind');
        if (token !== this.token) return;
        // 매치 룸에 있는 중이면 로비 룸에 들어가지 않음 (같은 계정 룸은 하나)
        if (this.client.currentRoomId && !isHubRoom(this.client.currentRoomId)) throw new Error('매치 룸에 있음');
        await this.client.joinRoom(found.roomId);
        if (token !== this.token) {
          this.leaveHubRoom();
          return;
        }
        this.subscribe();
        const hello = await this.client.call<{ ok: boolean; reason?: string; max: number; count: number }>('hubHello', [{ c: this.info.char, n: this.info.nick || undefined, w: this.info.weapon }]);
        if (token !== this.token) {
          this.leaveHubRoom();
          return;
        }
        if (hello.ok) {
          this.roomId = found.roomId;
          this.max = hello.max;
          this.status = 'online';
          this.retry = 0;
          this.last = null;
          this.sendTimer = HUB_TIMING.sendIntervalMs;
          this.lastError = '';
          this.client.addLog('info', `로비 입장 ${found.roomId} (${hello.count}/${hello.max})`);
          // 이미 있던 사람들 (구독 첫 푸시를 기다리지 않고 바로 표시)
          const st = await this.client.call<{ ok: boolean; users: Array<NetHubUserState & { account: string }> }>('hubState').catch(() => null);
          if (token === this.token && st?.ok) this.applyStates(st.users);
          return;
        }
        this.leaveHubRoom();
        if (hello.reason !== 'full') throw new Error(hello.reason ?? '입장 거절');
      }
      throw new Error('로비가 모두 가득 참');
    } catch (e) {
      if (token !== this.token) return;
      this.lastError = errText(e);
      this.client.addLog('warn', `로비 입장 실패: ${this.lastError}`);
      this.leaveHubRoom();
      this.status = 'disconnected';
      this.scheduleRetry();
    }
  }

  /** 같은 로비 사용자 상태 구독: 나타남·바뀜·사라짐 (x = 1은 나감·끊김 → 숨김) */
  private subscribe(): void {
    this.client.subscribeUsers((states) => {
      this.stats.recv++;
      this.applyStates(states);
    });
  }

  /** 같은 로비 전체 상태 반영 (구독 푸시·입장 직후 목록 공용): 나타남·바뀜·사라짐 */
  private applyStates(states: ReadonlyArray<{ account: string }>): void {
    {
      const now = performance.now();
      const me = this.client.account;
      const seen = new Set<string>();
      for (const st of states) {
        if (st.account === me) continue;
        const u = st as NetHubUserState & { account: string };
        if (u.x === 1 || !Array.isArray(u.p) || typeof u.c !== 'string') continue;
        seen.add(u.account);
        let peer = this.peers.get(u.account);
        const w = typeof u.w === 'string' ? u.w : 'rifle';
        if (!peer) {
          peer = { account: u.account, nick: u.n ?? '', char: u.c, weapon: w, buffer: new SnapshotBuffer() };
          peer.buffer.maxExtrapolateMs = 150;
          this.peers.set(u.account, peer);
          peer.buffer.push(toState(u.p, u.c, w), now);
          this.events.onPeerJoin(peer);
          continue;
        }
        if ((u.n ?? '') !== peer.nick || u.c !== peer.char || w !== peer.weapon) {
          peer.nick = u.n ?? '';
          peer.char = u.c;
          peer.weapon = w;
          this.events.onPeerChange(peer);
        }
        if (u.p[0] !== peer.buffer.latest?.q) peer.buffer.push(toState(u.p, u.c, w), now);
      }
      for (const acc of [...this.peers.keys()]) if (!seen.has(acc)) this.removePeer(acc);
    }
  }

  /** 실제 끊김 (SDK 알림, 의도적인 퇴장은 오지 않음) → 로비 정리 후 다시 시도 */
  private dropped(reason: string): void {
    if (!this.wanted || this.status !== 'online') return;
    if (this.client.currentRoomId && !isHubRoom(this.client.currentRoomId)) return;
    this.client.addLog('warn', `로비 연결 끊김 (${reason || '-'}) → 다시 연결`);
    this.client.dropRoom();
    this.clearPeers();
    this.status = 'disconnected';
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    this.retryAt = performance.now() + RETRY_MS[Math.min(this.retry, RETRY_MS.length - 1)]!;
    this.retry++;
  }

  /** 로비 룸에 있으면 나감 (매치 룸이면 건드리지 않음) + 원격 사람 정리 */
  private leaveHubRoom(): void {
    if (isHubRoom(this.client.currentRoomId)) this.client.leaveRoom();
    this.clearPeers();
  }

  private clearPeers(): void {
    for (const acc of [...this.peers.keys()]) this.removePeer(acc);
  }

  private removePeer(account: string): void {
    if (!this.peers.delete(account)) return;
    this.events.onPeerLeave(account);
  }
}
