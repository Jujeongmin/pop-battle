/**
 * POP! BATTLE — Verse8 Agent8 GameServer: 멀티플레이 룸 (최대 4인) + 게임 모드 (TDM 2v2 / FFA 4인 / 자유 테스트)
 *
 * 역할 분담
 *  - 이동: 클라이언트가 50ms마다 상태 패킷('st', throttle 호출)을 보냄 → 룸 사용자 상태(s)에 저장 → SDK가 다른 클라이언트에 푸시.
 *  - 사격 연출: 같은 패킷에 실린 탄(s) → 'fx' 브로드캐스트.
 *  - 피해: 클라이언트는 "맞혔다"는 주장(h)만 보냄. 피해량·체력·사망·킬/데스·팀 점수·리스폰·승패는 서버가 계산·소유 (룸 상태).
 *    서버는 물리 월드(맵 콜라이더)가 없어 시야(벽 관통)는 검사하지 못함 → 거리·사거리·연사 속도·생존·보호·아군만 검증.
 *  - 매치 단계: lobby → countdown(3초) → playing → result → lobby. 시각은 서버 Date.now 기준(startAt·endAt),
 *    단계 전환과 제한 시간 종료는 $roomTick(200ms)이, 목표 킬 달성 종료는 피해 처리 안에서 확정.
 *
 * 런타임 제약 (공식 문서): 요청마다 새 인스턴스, 타이머 없음, 모든 메서드가 공개 엔드포인트.
 * 읽기-수정-쓰기는 $lock(`room:<id>`)으로 직렬화.
 */
import {
  isNetMode,
  NET_CHARACTER_HP,
  NET_DEFAULT_HP,
  NET_MAX_PLAYERS,
  NET_MODE_RULES,
  NET_ROOM_PREFIX,
  NET_TEAM_SIZE,
  NET_TEST_TIME_LIMIT_SEC,
  NET_TIMING,
  NET_VALIDATION,
  NET_WEAPONS,
  netDamage,
  type NetHitClaim,
  type NetHitResult,
  type NetMatchPhase,
  type NetMatchResult,
  type NetMode,
  type NetPlayerRecord,
  type NetPlayers,
  type NetRejected,
  type NetRoomState,
  type NetShot,
  type NetStanding,
  type NetTeam,
} from '../../src/net/shared/protocol';

const NO_ROOM = '__no_room__';
const ROOM_CODE = /^pb-[a-z0-9]{4,12}$/;
/** 글로벌 상태의 룸 요약 키 (룸 밖 매칭 함수가 참가 인원·모드·진행 상태를 읽음) */
const MIRROR = (roomId: string) => `room_${roomId}`;
/** 요약이 이보다 오래되면 정리 (onRoomDestroy가 best-effort라 남을 수 있음) */
const MIRROR_TTL_MS = 6 * 60 * 60 * 1000;
const TEAMS: NetTeam[] = ['BLUE', 'RED'];

interface RoomMirror {
  n: number;
  phase: NetMatchPhase;
  mode: NetMode;
  t: number;
  /** 이번 매치 중 나간 계정 (같은 계정은 진행 중에도 돌아올 수 있음) */
  gone?: string[];
}

/** 서버 로그 (Verse8 서버 콘솔). 이동 패킷은 남기지 않음, 계정은 앞뒤만 */
function slog(event: string, roomId: string, data: Record<string, unknown> = {}): void {
  const short = (a: unknown) => (typeof a === 'string' && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
  const d = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, k === 'account' || k === 'attacker' || k === 'victim' ? short(v) : v]));
  console.log(`[pop] ${new Date().toISOString()} ${event} room=${roomId} ${JSON.stringify(d)}`);
}

/** 'ABC123' 또는 'pb-abc123' → 'pb-abc123' */
/** 호출한 클라이언트의 룸 (룸 밖이면 null — SDK는 룸 밖에서 '__no_room__'을 줌) */
function roomOf(): string | null {
  const r = $sender.roomId;
  return r && r !== NO_ROOM ? r : null;
}

function normalizeCode(code: unknown): string {
  const c = typeof code === 'string' ? code.trim().toLowerCase() : '';
  if (ROOM_CODE.test(c)) return c;
  return /^[a-z0-9]{4,12}$/.test(c) ? NET_ROOM_PREFIX + c : '';
}

/** 방장 = 남은 참가자 중 자리 번호가 가장 작은 사람 */
function pickHost(players: NetPlayers): string | null {
  let best: string | null = null;
  for (const [acc, p] of Object.entries(players)) if (best === null || p.slot < players[best]!.slot) best = acc;
  return best;
}

function teamCount(players: NetPlayers, team: NetTeam): number {
  return Object.values(players).filter((p) => p.team === team).length;
}

/** TDM 새 참가자 팀: 인원이 적은 팀 (같으면 BLUE). 꽉 차면 null */
function pickTeam(players: NetPlayers): NetTeam | null {
  const b = teamCount(players, 'BLUE');
  const r = teamCount(players, 'RED');
  if (b >= NET_TEAM_SIZE && r >= NET_TEAM_SIZE) return null;
  return b <= r ? 'BLUE' : 'RED';
}

/** 모드에 맞게 팀 다시 배정 (TDM: 기존 팀 유지하되 팀당 2명을 넘으면 옮김, 그 외: 팀 없음) */
function assignTeams(players: NetPlayers, mode: NetMode): void {
  const list = Object.values(players).sort((a, b) => a.slot - b.slot);
  if (!NET_MODE_RULES[mode].teams) {
    for (const p of list) p.team = null;
    return;
  }
  const counts: Record<NetTeam, number> = { BLUE: 0, RED: 0 };
  for (const p of list) {
    if (p.team && counts[p.team] < NET_TEAM_SIZE) counts[p.team]++;
    else p.team = null;
  }
  for (const p of list) {
    if (p.team) continue;
    const t: NetTeam = counts.BLUE <= counts.RED ? 'BLUE' : 'RED';
    p.team = t;
    counts[t]++;
  }
}

function emptyRoom(): NetRoomState {
  return { players: {}, host: null, mode: 'test', phase: 'lobby', startAt: 0, endAt: 0, timeLimitMs: 0, teamScore: { BLUE: 0, RED: 0 }, result: null, gone: {} };
}

async function readRoom(): Promise<NetRoomState> {
  const st = ((await $room.getRoomState(['players', 'host', 'mode', 'phase', 'startAt', 'endAt', 'timeLimitMs', 'teamScore', 'result', 'gone'])) || {}) as Partial<NetRoomState>;
  const r = emptyRoom();
  return {
    players: st.players || r.players,
    host: st.host ?? null,
    mode: isNetMode(st.mode) ? st.mode : r.mode,
    phase: st.phase === 'countdown' || st.phase === 'playing' || st.phase === 'result' ? st.phase : 'lobby',
    startAt: st.startAt || 0,
    endAt: st.endAt || 0,
    timeLimitMs: st.timeLimitMs || 0,
    teamScore: st.teamScore || r.teamScore,
    result: st.result ?? null,
    gone: st.gone || {},
  };
}

/** 룸 상태 전체 저장 + 글로벌 요약 갱신. 룸 락 안에서 호출 */
async function saveRoom(roomId: string, r: NetRoomState): Promise<void> {
  await $room.updateRoomState({ ...r }, { returnState: false });
  const m: RoomMirror = { n: Object.keys(r.players).length, phase: r.phase, mode: r.mode, t: Date.now(), gone: Object.keys(r.gone) };
  await $global.updateGlobalState({ [MIRROR(roomId)]: m });
}

/** 피해가 들어가는 시간인지 (카운트다운 끝 ~ 제한 시간 전). 틱이 늦어도 시각으로 판단 */
function isLive(r: NetRoomState, now: number): boolean {
  if (r.phase !== 'countdown' && r.phase !== 'playing') return false;
  if (now < r.startAt) return false;
  return !(r.endAt > 0 && now >= r.endAt);
}

function standingOf(acc: string, p: NetPlayerRecord): NetStanding {
  return { account: acc, slot: p.slot, char: p.char, team: p.team ?? null, k: p.k, d: p.d };
}

/** 매치 종료 확정 (한 번만): 순위·승자·무승부 → 결과 단계 */
function finishMatch(r: NetRoomState, reason: 'score' | 'time', now: number): void {
  if (r.phase !== 'countdown' && r.phase !== 'playing') return;
  const standings = [...Object.entries(r.players).map(([a, p]) => standingOf(a, p)), ...Object.values(r.gone)].sort(
    (a, b) => b.k - a.k || a.d - b.d || a.slot - b.slot,
  );
  let winners: string[] = [];
  let winnerTeam: NetTeam | null = null;
  let draw = false;
  if (r.mode === 'tdm') {
    const { BLUE, RED } = r.teamScore;
    draw = BLUE === RED;
    winnerTeam = draw ? null : BLUE > RED ? 'BLUE' : 'RED';
    winners = winnerTeam ? standings.filter((s) => s.team === winnerTeam).map((s) => s.account) : [];
  } else {
    const top = standings[0]?.k ?? 0;
    const tops = standings.filter((s) => s.k === top);
    draw = tops.length > 1;
    winners = tops.map((s) => s.account);
  }
  const result: NetMatchResult = { mode: r.mode, reason, teamScore: { ...r.teamScore }, winners, winnerTeam, draw, standings, endedAt: now };
  r.result = result;
  r.phase = 'result';
  // 결과 화면: 모두 살아 있는 상태로 (쓰러진 채 대기하지 않게), 기록은 그대로
  for (const p of Object.values(r.players)) Object.assign(p, { dead: false, hp: p.max, respawnAt: 0 });
}

function finite(n: unknown, lim = 1e4): n is number {
  return typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= lim;
}

function vec3(v: unknown, lim = 1e4): [number, number, number] | null {
  return Array.isArray(v) && v.length === 3 && v.every((x) => finite(x, lim)) ? [v[0], v[1], v[2]] : null;
}

function dist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

function newRoomId(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 36)];
  return NET_ROOM_PREFIX + s;
}

function freeSlot(players: NetPlayers): number {
  const used = new Set(Object.values(players).map((p) => p.slot));
  for (let i = 0; i < NET_MAX_PLAYERS; i++) if (!used.has(i)) return i;
  return -1;
}

function newRecord(slot: number, now: number): NetPlayerRecord {
  return { slot, char: 'blue', hp: NET_DEFAULT_HP, max: NET_DEFAULT_HP, dead: false, respawnAt: 0, prot: now + NET_TIMING.spawnProtectionMs, k: 0, d: 0 };
}

/** 상태 패킷 정리: 숫자·문자열 검사, 탄·명중은 따로 */
function sanitizeState(pkt: any): Record<string, unknown> | null {
  if (!pkt || typeof pkt !== 'object') return null;
  const p = vec3(pkt.p, 2000);
  const v = vec3(pkt.v, 200);
  const a = vec3(pkt.a, 2);
  if (!p || !v || !a || !finite(pkt.q, 1e12) || !finite(pkt.t, 1e13) || !finite(pkt.y, 100) || !finite(pkt.pi, 10)) return null;
  const num = (x: unknown, lim = 10) => (finite(x, lim) ? x : 0);
  return {
    q: pkt.q,
    t: pkt.t,
    p,
    v,
    y: pkt.y,
    a,
    pi: pkt.pi,
    m: num(pkt.m, 4),
    f: num(pkt.f, 1024),
    w: typeof pkt.w === 'string' && pkt.w in NET_WEAPONS ? pkt.w : 'rifle',
    c: typeof pkt.c === 'string' && pkt.c in NET_CHARACTER_HP ? pkt.c : 'blue',
    rl: num(pkt.rl),
    ms: num(pkt.ms),
    bp: num(pkt.bp),
    ads: num(pkt.ads),
    k: num(pkt.k),
  };
}

function sanitizeShots(list: unknown): NetShot[] {
  if (!Array.isArray(list)) return [];
  const out: NetShot[] = [];
  for (const s of list.slice(0, NET_VALIDATION.maxShotsPerPacket)) {
    const f = vec3(s?.f, 2000);
    const e = vec3(s?.e, 2000);
    if (!f || !e || typeof s.w !== 'string' || !(s.w in NET_WEAPONS)) continue;
    const h = s.h === 1 || s.h === 2 ? s.h : 0;
    const n = vec3(s.n, 2);
    out.push(n ? { w: s.w, f, e, h, n } : { w: s.w, f, e, h });
  }
  return out;
}

function sanitizeHits(list: unknown): NetHitClaim[] {
  if (!Array.isArray(list)) return [];
  const out: NetHitClaim[] = [];
  for (const h of list.slice(0, NET_VALIDATION.maxHitsPerPacket)) {
    if (typeof h?.v !== 'string' || typeof h.w !== 'string' || !(h.w in NET_WEAPONS) || !finite(h.d, 1000)) continue;
    out.push({ v: h.v, w: h.w, hd: h.hd === 1 ? 1 : 0, d: Math.max(0, h.d) });
  }
  return out;
}

type HelloResult = {
  slot: number;
  /** slot -1일 때 이유 ('full' | 'in_progress') */
  reason?: string;
  now: number;
} & NetRoomState;

export class Server {
  // ---------------- 매칭 (룸 밖에서 호출) ----------------

  /** 새 룸 id. 실제 생성은 첫 플레이어가 joinRoom 할 때 (SDK 규칙). 오래된 룸 요약도 정리 */
  async createRoom(): Promise<{ ok: true; roomId: string }> {
    const now = Date.now();
    const all = (await $global.getGlobalState()) || {};
    const stale = Object.keys(all).filter((k) => k.startsWith('room_') && !(now - ((all[k] as RoomMirror)?.t ?? 0) < MIRROR_TTL_MS));
    if (stale.length > 0) await $global.clearGlobalState(stale);
    return { ok: true, roomId: newRoomId() };
  }

  /**
   * 코드로 입장 전 확인: 있는 룸이고 자리가 남았는지 (글로벌 요약 = 실제 참가자 기록 수).
   * 나가기(bye) 직후에도 SDK는 30초 동안 그 사람을 룸 사용자로 세므로 사용자 수 대신 참가자 기록을 본다.
   * TDM·FFA 매치 진행 중에는 새로 들어올 수 없음 (중도 입장 정책 미정). 최종 판정은 hello(자리 배정)
   */
  async findRoom(code: string): Promise<{ ok: boolean; roomId?: string; reason?: string; count?: number; phase?: NetMatchPhase; mode?: NetMode }> {
    const id = normalizeCode(code);
    if (!id) return { ok: false, reason: 'bad_code' };
    const m = ((await $global.getGlobalState([MIRROR(id)])) || {})[MIRROR(id)] as RoomMirror | undefined;
    const users = await $global.countRoomUsers(id);
    if (!m || users <= 0 || m.n <= 0) return { ok: false, reason: 'not_found', count: 0 };
    if (m.n >= NET_MAX_PLAYERS) return { ok: false, reason: 'full', count: m.n, mode: m.mode };
    // 진행 중인 TDM·FFA: 이번 매치에서 나갔던 같은 계정(새로고침·끊김)만 돌아올 수 있음
    const returning = !!m.gone?.includes($sender.account);
    if (m.mode !== 'test' && (m.phase === 'countdown' || m.phase === 'playing') && !returning) return { ok: false, reason: 'in_progress', count: m.n, mode: m.mode };
    return { ok: true, roomId: id, count: m.n, phase: m.phase, mode: m.mode };
  }

  /** 빠른 매칭: 자리가 남은 대기실(또는 자유 테스트) 룸이 있으면 그 룸, 없으면 새 룸 */
  async quickMatch(): Promise<{ ok: true; roomId: string; waiting: boolean }> {
    const all = (await $global.getGlobalState()) || {};
    for (const [k, v] of Object.entries(all)) {
      const m = v as RoomMirror;
      if (!k.startsWith('room_') || !m || m.n <= 0 || m.n >= NET_MAX_PLAYERS || Date.now() - m.t > MIRROR_TTL_MS) continue;
      if (m.mode !== 'test' && (m.phase === 'countdown' || m.phase === 'playing')) continue;
      const id = k.slice('room_'.length);
      if ((await $global.countRoomUsers(id)) > 0) return { ok: true, roomId: id, waiting: true };
    }
    return { ok: true, roomId: newRoomId(), waiting: false };
  }

  /** RTT 측정·서버 시각 (룸 안팎 모두) */
  async ping(t: number): Promise<{ t: number; s: number }> {
    return { t: finite(t, 1e13) ? t : 0, s: Date.now() };
  }

  // ---------------- 룸 수명 주기 ----------------

  async onRoomJoin(roomId: string, account: string): Promise<void> {
    const slot = await $lock(`room:${roomId}`, async () => {
      const r = await readRoom();
      if (r.players[account]) return r.players[account]!.slot;
      const s = this.admit(r, account);
      if (s < 0) return -1;
      await saveRoom(roomId, r);
      return s;
    });
    if (slot >= 0) $room.broadcastToRoom('joined', { account, slot });
    slog('join', roomId, { account, slot });
  }

  async onRoomDisconnect(roomId: string, account: string): Promise<void> {
    // 30초 유예: 아직 룸 안 (재접속하면 그대로 이어짐)
    $room.broadcastToRoom('dc', { account, roomId });
    slog('disconnect', roomId, { account });
  }

  async onRoomLeave(roomId: string, account: string): Promise<void> {
    if (await this.removePlayer(roomId, account)) $room.broadcastToRoom('left', { account });
    slog('leave', roomId, { account });
  }

  async onRoomDestroy(roomId: string): Promise<void> {
    await $global.clearGlobalState([MIRROR(roomId)]);
  }

  /**
   * 매치 단계 진행 (활성 룸마다 200ms, 공식 문서): 카운트다운 끝 → playing, 제한 시간 끝 → 결과.
   * 대부분의 틱은 단계·시각만 읽고 끝남 (락·쓰기 없음)
   */
  async $roomTick(_delta: number, roomId: string): Promise<void> {
    const st = ((await $room.getRoomState(['phase', 'startAt', 'endAt'])) || {}) as Partial<NetRoomState>;
    if (st.phase !== 'countdown' && st.phase !== 'playing') return;
    const now = Date.now();
    const toPlaying = st.phase === 'countdown' && now >= (st.startAt ?? 0);
    const timeUp = (st.endAt ?? 0) > 0 && now >= st.endAt!;
    if (!toPlaying && !timeUp) return;
    await $lock(`room:${roomId}`, async () => {
      const r = await readRoom();
      const t = Date.now();
      if (r.endAt > 0 && t >= r.endAt) finishMatch(r, 'time', t);
      else if (r.phase === 'countdown' && t >= r.startAt) r.phase = 'playing';
      else return;
      await saveRoom(roomId, r);
      if (r.phase === 'result') slog('match_end', roomId, { reason: 'time', mode: r.mode, teamScore: r.teamScore, winners: r.result?.winners.length, draw: r.result?.draw });
    });
  }

  /** 참가자 기록 제거 (매치 중이면 기록을 결과용으로 보존, 방장이면 남은 사람에게 넘김). @returns 제거했으면 true */
  private async removePlayer(roomId: string, account: string): Promise<boolean> {
    return $lock(`room:${roomId}`, async () => {
      const r = await readRoom();
      const p = r.players[account];
      if (!p) return false;
      if (r.phase === 'countdown' || r.phase === 'playing') r.gone[account] = { ...standingOf(account, p), left: true };
      delete r.players[account];
      if (r.host === account || !r.host || !r.players[r.host]) r.host = pickHost(r.players);
      if (Object.keys(r.players).length === 0) Object.assign(r, { phase: 'lobby', result: null, gone: {}, startAt: 0, endAt: 0 });
      await saveRoom(roomId, r);
      return true;
    });
  }

  /** 새 참가자 자리·팀 배정 (락 안). @returns 자리, 못 들어오면 -1 */
  private admit(r: NetRoomState, account: string): number {
    const inMatch = r.phase === 'countdown' || r.phase === 'playing';
    // 이번 매치에서 나갔던 같은 계정(새로고침·30초 넘는 끊김): 기록(자리·팀·킬/데스)을 되살려 복귀
    const back = inMatch ? r.gone[account] : undefined;
    if (back) {
      const used = new Set(Object.values(r.players).map((p) => p.slot));
      const slot = used.has(back.slot) ? freeSlot(r.players) : back.slot;
      if (slot < 0) return -1;
      const rec = newRecord(slot, Date.now());
      const team = back.team && teamCount(r.players, back.team) < NET_TEAM_SIZE ? back.team : NET_MODE_RULES[r.mode].teams ? pickTeam(r.players) : null;
      Object.assign(rec, { char: back.char, k: back.k, d: back.d, team });
      r.players[account] = rec;
      delete r.gone[account];
      if (!r.host || !r.players[r.host]) r.host = pickHost(r.players);
      return slot;
    }
    // TDM·FFA 매치 중 새 참가자는 받지 않음 (자유 테스트는 중간 입장 허용)
    if (r.mode !== 'test' && inMatch) return -1;
    const slot = freeSlot(r.players);
    // 정원 초과: onRoomJoin에서 거절하면 SDK가 재시도만 반복함(문서) → 자리 없이 두고 클라이언트가 스스로 나감
    if (slot < 0) return -1;
    const rec = newRecord(slot, Date.now());
    rec.team = NET_MODE_RULES[r.mode].teams ? pickTeam(r.players) : null;
    r.players[account] = rec;
    if (!r.host || !r.players[r.host]) r.host = pickHost(r.players);
    return slot;
  }

  // ---------------- 룸 안 ----------------

  /** 입장 직후: 캐릭터(최대 체력) 등록. @returns 자리(-1 = 못 들어옴, reason), 서버 시각, 룸 전체 상태 */
  async hello(char: string): Promise<HelloResult> {
    const me = $sender.account;
    if (!roomOf()) throw new Error('not in room');
    const roomId = roomOf()!;
    return $lock(`room:${roomId}`, async () => {
      const r = await readRoom();
      let p = r.players[me];
      if (!p) {
        // 나가기(bye) 뒤 30초 유예 안에 다시 들어오면 SDK가 onRoomJoin을 다시 부르지 않음(세션 이어짐) → 여기서 자리 배정
        const inProgress = r.mode !== 'test' && (r.phase === 'countdown' || r.phase === 'playing');
        const slot = this.admit(r, me);
        if (slot < 0) return { ...r, slot: -1, reason: inProgress ? 'in_progress' : 'full', now: Date.now() };
        p = r.players[me]!;
        await saveRoom(roomId, r);
        $room.broadcastToRoom('joined', { account: me, slot });
      }
      if (typeof char === 'string' && char in NET_CHARACTER_HP && (char !== p.char || p.max !== NET_CHARACTER_HP[char])) {
        const max = NET_CHARACTER_HP[char]!;
        // 다친 상태로 캐릭터만 바꿔 회복하는 것 방지: 가득 찬 상태일 때만 새 최대치로 채움
        const full = !p.dead && p.hp >= p.max;
        p.char = char;
        p.max = max;
        p.hp = full ? max : Math.min(p.hp, max);
        await $room.updateRoomState({ players: r.players }, { returnState: false });
      }
      return { ...r, slot: p.slot, now: Date.now() };
    });
  }

  /** 방장: 게임 모드 변경 (대기실·결과 화면에서만, 매치 중 변경 불가). 팀은 모드에 맞게 다시 배정 */
  async setMode(mode: string): Promise<{ ok: boolean; reason?: string }> {
    if (!roomOf()) return { ok: false, reason: 'not_in_room' };
    if (!isNetMode(mode)) return { ok: false, reason: 'bad_mode' };
    const me = $sender.account;
    const roomId = roomOf()!;
    return $lock(`room:${roomId}`, async () => {
      const r = await readRoom();
      if (r.host !== me) return { ok: false, reason: 'not_host' };
      if (r.phase === 'countdown' || r.phase === 'playing') return { ok: false, reason: 'in_progress' };
      r.mode = mode;
      assignTeams(r.players, mode);
      await saveRoom(roomId, r);
      return { ok: true };
    });
  }

  /** TDM 대기실: 자기 팀 바꾸기 (상대 팀에 자리가 있을 때만) */
  async switchTeam(): Promise<{ ok: boolean; reason?: string }> {
    if (!roomOf()) return { ok: false, reason: 'not_in_room' };
    const me = $sender.account;
    const roomId = roomOf()!;
    return $lock(`room:${roomId}`, async () => {
      const r = await readRoom();
      const p = r.players[me];
      if (!p || r.mode !== 'tdm') return { ok: false, reason: 'not_tdm' };
      if (r.phase === 'countdown' || r.phase === 'playing') return { ok: false, reason: 'in_progress' };
      const to = TEAMS.find((t) => t !== p.team)!;
      if (teamCount(r.players, to) >= NET_TEAM_SIZE) return { ok: false, reason: 'team_full' };
      p.team = to;
      await saveRoom(roomId, r);
      return { ok: true };
    });
  }

  /**
   * 방장: 매치 시작. TDM = 4명·팀 2/2, FFA = 4명, 자유 테스트 = 2명 이상.
   * 기록·체력 초기화 → 3초 카운트다운(startAt)·제한 시간(endAt)을 서버 시각으로 공유 → 모든 클라이언트가 같은 시점에 시작.
   * opts.timeLimitSec: 테스트용 제한 시간 (20~180초, 클라이언트는 개발 빌드에서만 보냄). 없으면 모드 규칙(3분)
   */
  async startMatch(opts?: { timeLimitSec?: number }): Promise<{ ok: boolean; reason?: string }> {
    if (!roomOf()) return { ok: false, reason: 'not_in_room' };
    const me = $sender.account;
    const roomId = roomOf()!;
    return $lock(`room:${roomId}`, async () => {
      const r = await readRoom();
      if (r.host !== me) return { ok: false, reason: 'not_host' };
      if (r.phase === 'countdown' || r.phase === 'playing') return { ok: false, reason: 'in_progress' };
      const rule = NET_MODE_RULES[r.mode];
      const n = Object.keys(r.players).length;
      if (n < rule.requiredPlayers) return { ok: false, reason: `need_${rule.requiredPlayers}_players` };
      if (rule.teams && (teamCount(r.players, 'BLUE') !== NET_TEAM_SIZE || teamCount(r.players, 'RED') !== NET_TEAM_SIZE)) return { ok: false, reason: 'teams_unbalanced' };
      const now = Date.now();
      const startAt = now + NET_TIMING.countdownMs;
      const t = opts?.timeLimitSec;
      const custom = typeof t === 'number' && Number.isFinite(t) && t >= NET_TEST_TIME_LIMIT_SEC.min && t <= NET_TEST_TIME_LIMIT_SEC.max && rule.timeLimitMs > 0;
      const limit = custom ? Math.round(t) * 1000 : rule.timeLimitMs;
      for (const p of Object.values(r.players)) {
        Object.assign(p, { hp: p.max, dead: false, respawnAt: 0, k: 0, d: 0, prot: startAt });
        delete p.rb;
      }
      Object.assign(r, { phase: 'countdown', startAt, endAt: limit > 0 ? startAt + limit : 0, timeLimitMs: limit, teamScore: { BLUE: 0, RED: 0 }, result: null, gone: {} });
      await saveRoom(roomId, r);
      slog('match_start', roomId, { mode: r.mode, players: Object.keys(r.players).length, timeLimitMs: limit, custom });
      return { ok: true };
    });
  }

  /** 이전 이름 (2인 테스트 클라이언트 호환) */
  async startTest(): Promise<{ ok: boolean; reason?: string }> {
    return this.startMatch();
  }

  /** 결과 화면 → 대기실 (누구나, 결과 단계에서만) */
  async toLobby(): Promise<{ ok: boolean }> {
    if (!roomOf()) return { ok: false };
    const roomId = roomOf()!;
    return $lock(`room:${roomId}`, async () => {
      const r = await readRoom();
      if (r.phase !== 'result') return { ok: r.phase === 'lobby' };
      Object.assign(r, { phase: 'lobby', gone: {} });
      await saveRoom(roomId, r);
      return { ok: true };
    });
  }

  /** 직접 나가기: 기록을 바로 지우고 알림 (SDK leaveRoom은 끊김과 구분이 안 돼 30초 유예를 기다리므로 먼저 호출) */
  async bye(): Promise<{ ok: boolean }> {
    if (!roomOf()) return { ok: false };
    const me = $sender.account;
    const removed = await this.removePlayer(roomOf()!, me);
    if (removed) $room.broadcastToRoom('left', { account: me });
    return { ok: removed };
  }

  /** 상태 패킷 (throttle, 응답 없음): 이동 저장 + 탄 연출 중계 + 명중 검증·피해 */
  async st(pkt: any): Promise<void> {
    if (!roomOf()) return;
    const state = sanitizeState(pkt);
    if (!state) return;
    const me = $sender.account;
    await $room.updateMyState({ s: state }, { returnState: false });
    const shots = sanitizeShots(pkt.s);
    const hits = sanitizeHits(pkt.h);
    if (shots.length > 0) $room.broadcastToRoom('fx', { a: me, s: shots });
    if (shots.length > 0 || hits.length > 0) await this.combat(roomOf()!, me, state.p as [number, number, number], shots, hits);
  }

  /** 자멸·낙사 (공격자 없는 사망): 데스만 +1, 킬·팀 점수 변화 없음 (기존 싱글플레이 규칙과 같음). 매치 진행 중에만 */
  async selfDeath(cause: string): Promise<{ ok: boolean }> {
    if (!roomOf()) return { ok: false };
    const me = $sender.account;
    const c = cause === 'fall' ? 'fall' : 'suicide';
    const result = await $lock(`room:${roomOf()!}`, async () => {
      const r = await readRoom();
      const p = r.players[me];
      const now = Date.now();
      if (!p || p.dead || !isLive(r, now)) return null;
      p.dead = true;
      p.hp = 0;
      p.d++;
      // 낙사는 기존 게임처럼 바로 부활 가능
      p.respawnAt = now + (c === 'fall' ? 0 : NET_TIMING.respawnDelayMs);
      await $room.updateRoomState({ players: r.players }, { returnState: false });
      const res: NetHitResult = { a: null, v: me, w: null, dmg: 0, hp: 0, hd: false, kill: true, cause: c };
      return res;
    });
    if (result) $room.broadcastToRoom('hits', { r: [result] });
    return { ok: !!result };
  }

  /** 리스폰 요청: 서버 시각으로 대기 시간이 지났을 때만. 보호 2초 */
  async respawn(): Promise<{ ok: boolean; hp?: number; wait?: number }> {
    if (!roomOf()) return { ok: false };
    const me = $sender.account;
    const res = await $lock(`room:${roomOf()!}`, async () => {
      const r = await readRoom();
      const p = r.players[me];
      if (!p) return { ok: false };
      if (!p.dead) return { ok: true, hp: p.hp };
      const now = Date.now();
      // 클라이언트 타이머와 서버 시각 차이 150ms까지 허용
      if (now < p.respawnAt - 150) return { ok: false, wait: p.respawnAt - now };
      p.dead = false;
      p.hp = p.max;
      p.prot = now + NET_TIMING.spawnProtectionMs;
      await $room.updateRoomState({ players: r.players }, { returnState: false });
      return { ok: true, hp: p.hp };
    });
    if (res.ok) $room.broadcastToRoom('spawn', { a: me, hp: res.hp });
    return res;
  }

  /** 명중 검증 + 피해 + 킬/데스·팀 점수 + 목표 달성 종료 (룸 락 안에서 읽기-수정-쓰기) */
  private async combat(roomId: string, me: string, myPos: [number, number, number], shots: NetShot[], hits: NetHitClaim[]): Promise<void> {
    const victims = [...new Set(hits.map((h) => h.v))].filter((v) => v !== me);
    const posOf = new Map<string, number[]>();
    if (victims.length > 0) {
      for (const st of await $room.getUserStates(victims, ['s'])) {
        const p = st.s?.p;
        if (Array.isArray(p)) posOf.set(st.account, p);
      }
    }
    const results: NetHitResult[] = [];
    const rejected: NetRejected[] = [];
    await $lock(`room:${roomId}`, async () => {
      const r = await readRoom();
      const players = r.players;
      const att = players[me];
      const now = Date.now();
      const reject = (h: NetHitClaim, reason: string) => rejected.push({ v: h.v, w: h.w, reason });
      if (!att) {
        hits.forEach((h) => reject(h, 'not_player'));
        return;
      }
      // 대기실·카운트다운·결과 화면에서는 피해 없음
      if (!isLive(r, now)) {
        hits.forEach((h) => reject(h, r.phase === 'result' || (r.endAt > 0 && now >= r.endAt) ? 'match_over' : 'not_started'));
        return;
      }
      const rule = NET_MODE_RULES[r.mode];
      let changed = false;
      if (shots.length > 0 && att.prot > now) {
        // 공격하면 리스폰 보호 해제 (기존 게임 규칙)
        att.prot = 0;
        changed = true;
      }
      // 연사 속도: 무기별 토큰 (펠릿 무기는 탄 1발 = 1/펠릿 토큰)
      const rb = (att.rb ??= { tokens: NET_VALIDATION.burstShots, t: now });
      let allowedShots = 0;
      for (const s of shots) {
        const wr = NET_WEAPONS[s.w]!;
        const rate = (wr.rpm / 60) * NET_VALIDATION.rateSlack;
        rb.tokens = Math.min(NET_VALIDATION.burstShots, rb.tokens + ((now - rb.t) / 1000) * rate);
        rb.t = now;
        const cost = 1 / wr.pellets;
        if (rb.tokens + 1e-6 >= cost) {
          rb.tokens -= cost;
          allowedShots++;
        }
      }
      changed ||= shots.length > 0;
      // 명중 주장 수 ≤ 이번 패킷에서 허용된 캐릭터 명중 탄 수 (+근접은 탄 기록이 1발)
      const charShots = Math.min(allowedShots, shots.filter((s) => s.h === 1).length);
      let budget = charShots;
      for (const h of hits) {
        if (r.phase === 'result') {
          reject(h, 'match_over');
          continue;
        }
        if (att.dead) {
          reject(h, 'attacker_dead');
          continue;
        }
        if (budget <= 0) {
          reject(h, shots.length > allowedShots ? 'fire_rate' : 'no_shot');
          continue;
        }
        const vic = players[h.v];
        if (!vic || h.v === me) {
          reject(h, 'bad_target');
          continue;
        }
        // TDM: 아군 피해 없음
        if (rule.teams && vic.team && vic.team === att.team) {
          reject(h, 'friendly');
          continue;
        }
        if (vic.dead) {
          reject(h, 'victim_dead');
          continue;
        }
        const wr = NET_WEAPONS[h.w]!;
        if (h.d > wr.range + NET_VALIDATION.rangeSlack) {
          reject(h, 'out_of_range');
          continue;
        }
        const vp = posOf.get(h.v);
        if (!vp) {
          reject(h, 'no_victim_pos');
          continue;
        }
        const serverDist = dist(myPos, vp);
        if (Math.abs(serverDist - h.d) > NET_VALIDATION.distanceTolerance || serverDist > wr.range + NET_VALIDATION.rangeSlack + NET_VALIDATION.distanceTolerance) {
          reject(h, 'distance_mismatch');
          continue;
        }
        budget--;
        if (vic.prot > now) {
          reject(h, 'protected');
          continue;
        }
        const dmg = Math.round(netDamage(h.w, h.hd === 1, h.d) * 100) / 100;
        vic.hp = Math.max(0, Math.round((vic.hp - dmg) * 100) / 100);
        const kill = vic.hp <= 0;
        if (kill) {
          // 한 번의 사망에 한 번만 집계: dead 표시 → 같은 대상의 다음 명중은 victim_dead로 거부
          vic.dead = true;
          vic.respawnAt = now + NET_TIMING.respawnDelayMs;
          vic.d++;
          att.k++;
          if (rule.teams && att.team) r.teamScore[att.team]++;
        }
        changed = true;
        results.push({ a: me, v: h.v, w: h.w, dmg, hp: vic.hp, hd: h.hd === 1, kill, cause: 'weapon' });
        // 목표 달성 → 즉시 종료 (같은 패킷의 남은 명중은 match_over)
        if (kill && rule.scoreToWin > 0) {
          const score = rule.teams && att.team ? r.teamScore[att.team] : att.k;
          if (score >= rule.scoreToWin) finishMatch(r, 'score', now);
        }
      }
      // 피해 처리는 자주 일어나므로 룸 상태만 쓰고, 종료(단계 변경) 때만 글로벌 요약까지
      if (r.phase === 'result') {
        await saveRoom(roomId, r);
        slog('match_end', roomId, { reason: 'score', mode: r.mode, teamScore: r.teamScore, winners: r.result?.winners.length, draw: r.result?.draw });
      } else if (changed) await $room.updateRoomState({ players, teamScore: r.teamScore }, { returnState: false });
    });
    for (const k of results.filter((x) => x.kill)) slog('kill', roomId, { attacker: k.a, victim: k.v, weapon: k.w, headshot: k.hd });
    if (results.length > 0) $room.broadcastToRoom('hits', { r: results });
    if (rejected.length > 0) $room.sendMessageToUser('rej', me, { r: rejected });
  }
}
