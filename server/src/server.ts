/**
 * POP! BATTLE — Verse8 Agent8 GameServer: 멀티플레이 룸 (최대 8인) + 게임 모드 (TDM 최대 4v4 / FFA 최대 8인 / 자유 테스트)
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
  HUB_MAX_PLAYERS,
  HUB_MAX_SPEED,
  HUB_TIMING,
  HUB_WORLD,
  isHubRoom,
  isNetMode,
  checkNickname,
  sanitizeNick,
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
  ROOM_TITLE_COUNT,
  netDamage,
  teamSeats,
  type NetHitClaim,
  type NetHitResult,
  type NetMatchPhase,
  type NetMatchResult,
  type NetMode,
  type NetPlayerRecord,
  type NetPlayers,
  type NetRejected,
  type NetHubPacket,
  type NetRoomState,
  type NetRoomSummary,
  type NetShot,
  type NetStanding,
  type NetTeam,
} from '../../src/net/shared/protocol';
import { levelInfo, MATCH_XP, matchXp, MAX_XP, standingRanks, type StoredProgress, type XpAward } from '../../src/net/shared/progression';
import { addMatch, RANK_COLLECTION, RANK_KEY_FIELD, RANK_PAGE, rankKey, readStats, type RankingResult, type RankRow, type RankStats } from '../../src/net/shared/ranking';

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
  /** 방 제목 번호 (방 목록 표시용) */
  ti?: number;
  t: number;
  /** 이번 매치 중 끊겨서 나간 계정 (같은 계정은 진행 중에도 돌아올 수 있음) */
  gone?: string[];
  /** 이번 매치 중 Leave Room으로 직접 나간 계정 (이 매치에는 다시 못 들어옴) */
  quit?: string[];
  /** 지금 룸 기록에 있는 계정 (30초 유예 중인 사람 포함) */
  in?: string[];
}

/** 서버 로그 (Verse8 서버 콘솔). 이동 패킷은 남기지 않음, 계정은 앞뒤만 */
function slog(event: string, roomId: string, data: Record<string, unknown> = {}): void {
  const short = (a: unknown) => (typeof a === 'string' && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
  const d = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, k === 'account' || k === 'attacker' || k === 'victim' ? short(v) : v]));
  console.log(`[pop] ${new Date().toISOString()} ${event} room=${roomId} ${JSON.stringify(d)}`);
}

/** 'ABC123' 또는 'pb-abc123' → 'pb-abc123' */
/**
 * 호출한 클라이언트의 매치 룸 (룸 밖이면 null — SDK는 룸 밖에서 '__no_room__'을 줌).
 * 로비 룸(lb-)도 null → 매치 함수(hello·st·startMatch·respawn …)는 로비 룸에서 모두 거절됨
 */
function roomOf(): string | null {
  const r = $sender.roomId;
  return r && r !== NO_ROOM && !isHubRoom(r) ? r : null;
}

/** 호출한 클라이언트의 로비 룸 (아니면 null) */
function hubOf(): string | null {
  const r = $sender.roomId;
  return isHubRoom(r) ? r : null;
}

/**
 * 로비 인원 장부 (글로벌 상태 하나, 'hub:match' 락 안에서만 읽고 씀): 룸 → 계정 → 기록.
 * - a: 실제 접속 시각 (hubHello 뒤). 정상 퇴장(hubBye·onRoomLeave)·매치로 이동하면 즉시 지움 → 바로 빈자리
 * - d: 연결 끊김 시각. 30초 재접속 대기 자리 (정원에는 넣고, 실제 접속 인원에서는 뺌)
 * - r: 배정 예약 시각 (hubFind 뒤 20초 안에 들어와야 함, 동시 입장 정원 초과 방지)
 * SDK 룸 사용자 목록은 나간 사람도 30초 동안 남아 있어 인원 계산에 쓰지 않고, 서버가 놓친 퇴장(유령) 정리에만 씀
 */
const HUB_BOOK = 'hub_book';
type HubEntry = { a?: number; d?: number; r?: number };
type HubBook = Record<string, Record<string, HubEntry>>;
/** 연결 끊김 재접속 대기 (SDK 유예와 같은 30초) */
const HUB_GRACE_MS = 30_000;

async function readBook(): Promise<HubBook> {
  const g = ((await $global.getGlobalState([HUB_BOOK])) || {}) as Record<string, unknown>;
  const v = g[HUB_BOOK];
  return v && typeof v === 'object' ? (v as HubBook) : {};
}

/** 끝난 예약·재접속 대기를 지움 (빈 룸 키도) */
function pruneBook(book: HubBook, now: number): void {
  for (const [id, accs] of Object.entries(book)) {
    for (const [acc, e] of Object.entries(accs)) {
      if (e.d !== undefined && !(now - e.d < HUB_GRACE_MS)) delete accs[acc];
      else if (e.a === undefined && e.d === undefined && !(now - (e.r ?? 0) < HUB_TIMING.reserveMs)) delete accs[acc];
    }
    if (Object.keys(accs).length === 0) delete book[id];
  }
}

/** 자리 수 (실제 접속 + 재접속 대기 + 예약), except = 셈에서 뺄 계정 */
function hubSeats(accs: Record<string, HubEntry> | undefined, except?: string): number {
  return accs ? Object.keys(accs).filter((a) => a !== except).length : 0;
}

/** 실제 접속 인원 (재접속 대기·예약 제외) */
function hubActive(accs: Record<string, HubEntry> | undefined): number {
  return accs ? Object.values(accs).filter((e) => e.a !== undefined && e.d === undefined).length : 0;
}

/** 장부 고치기 ('hub:match' 락 안에서 읽고 씀). fn이 false를 돌려주면 쓰지 않음 */
async function editBook(fn: (book: HubBook, now: number) => boolean | void): Promise<void> {
  await $lock('hub:match', async () => {
    const now = Date.now();
    const book = await readBook();
    if (fn(book, now) === false) return;
    pruneBook(book, now);
    await $global.updateGlobalState({ [HUB_BOOK]: book });
  });
}

/** 로비에서 들고 보이는 무기 id (주무기만, 잘못된 값은 라이플) */
function hubWeapon(w: unknown): string {
  return typeof w === 'string' && w in NET_WEAPONS && w !== 'pistol' && w !== 'melee' ? w : 'rifle';
}

// ---------------- 닉네임 (계정별 글로벌 사용자 상태, 계정·로그인 시스템 없이 Verse8 계정에 붙음) ----------------

/** 닉네임 변경 간격 (첫 설정은 제한 없음) */
const NICK_CHANGE_MS = 10_000;

/** 저장된 내 닉네임 (지금 규칙으로 다시 검사, 금칙어 목록이 바뀌어 걸리면 없는 것으로) */
// ---------------- 닉네임 중복 방지 (서버 기준) ----------------
// 닉네임 등록부: 컬렉션 pb_nick 한 줄 = { key: 비교용 닉네임, acc: 주인 계정 }. 비교는 앞뒤 공백 제거 + 대소문자 무시 (NFC 정규화).
// 같은 이름 동시 요청은 이름별 락으로 한 명만 차지. 바꾸면 새 이름을 먼저 차지한 뒤 예전 이름을 놓음.
// 이 기능 전에 정한 기존 닉네임은 바꾸지 않고, 그 계정이 접속할 때(nickGet) 비어 있으면 등록 (먼저 온 사람이 주인).
const NICK_COLLECTION = 'pb_nick';

function nickKey(nick: string): string {
  return nick.normalize('NFC').trim().toLowerCase();
}

async function nickOwner(key: string): Promise<{ id: string; acc: string } | null> {
  const items = await $global.getCollectionItems(NICK_COLLECTION, { filters: [{ field: 'key', operator: '==', value: key }], limit: 1 });
  const it = items[0];
  return it ? { id: it.__id, acc: String(it.acc) } : null;
}

/** 이 계정이 이 닉네임을 차지 (이미 내 것이면 그대로). 다른 계정 것이면 false */
async function claimNick(account: string, nick: string): Promise<boolean> {
  const key = nickKey(nick);
  return $lock(`nick:${key}`, async () => {
    const owner = await nickOwner(key);
    if (owner) return owner.acc === account;
    await $global.addCollectionItem(NICK_COLLECTION, { key, acc: account, t: Date.now() });
    return true;
  });
}

/** 내 것인 닉네임 등록을 놓음 (바꾼 뒤 예전 이름) */
async function releaseNick(account: string, nick: string): Promise<void> {
  const key = nickKey(nick);
  await $lock(`nick:${key}`, async () => {
    const owner = await nickOwner(key);
    if (owner && owner.acc === account) await $global.deleteCollectionItem(NICK_COLLECTION, owner.id);
  });
}

async function storedNick(): Promise<string | null> {
  const st = ((await $global.getMyState()) || {}) as { nick?: unknown };
  const r = checkNickname(st.nick);
  return r.ok ? r.value : null;
}

/** 화면에 쓸 닉네임: 서버에 저장된 값 먼저, 없으면 클라이언트가 보낸 값(검사 통과한 것만) */
async function displayNick(fromClient: unknown): Promise<string | null> {
  try {
    const n = await storedNick();
    if (n) return n;
  } catch {
    // 글로벌 상태를 못 읽어도 입장은 막지 않음
  }
  return sanitizeNick(fromClient);
}

/** 로비 위치 패킷 검사: 길이·숫자·로비 범위. 통과하면 반올림한 사본 */
function sanitizeHubPacket(pkt: unknown): NetHubPacket | null {
  if (!Array.isArray(pkt) || pkt.length !== 11 || !pkt.every((v) => finite(v, 1e13))) return null;
  const [q, t, x, y, z, yaw, vx, vy, vz, m, f] = pkt as number[];
  if (Math.hypot(x! - HUB_WORLD.cx, z! - HUB_WORLD.cz) > HUB_WORLD.radius) return null;
  if (y! < HUB_WORLD.minY || y! > HUB_WORLD.maxY || Math.abs(yaw!) > 100) return null;
  if (Math.hypot(vx!, vz!) > 40 || Math.abs(vy!) > 60) return null;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return [q!, t!, r3(x!), r3(y!), r3(z!), r3(yaw!), r2(vx!), r2(vy!), r2(vz!), m! >= 0 && m! <= 2 ? Math.round(m!) : 0, Math.round(f!) & 0xff];
}

/**
 * 로비 이동 검사 (물리 없음): 직전에 받아들인 위치에서 시간당 갈 수 있는 거리 안인지.
 * 수평은 최대 속도 × 경과 시간 + 여유, 수직은 범위만 (낙하·점프). 시작 지점 근처로의 순간이동(R·낙하 복귀)은 허용
 */
function hubMoveOk(prev: NetHubPacket | undefined, prevT: number, next: NetHubPacket, now: number): boolean {
  if (!prev) return true;
  const s = HUB_WORLD.spawn;
  if (Math.hypot(next[2] - s[0], next[3] - s[1], next[4] - s[2]) < 2) return true;
  const dt = Math.min(3, Math.max(0.05, (now - prevT) / 1000));
  return Math.hypot(next[2] - prev[2], next[4] - prev[4]) <= HUB_MAX_SPEED * dt * 1.3 + 1.2;
}

/** 방 입장 가능 여부 (findRoom·listRooms 공용): 정원·진행 중 매치·직접 나간 매치 */
function joinCheck(m: RoomMirror, account: string): { ok: boolean; reason?: string } {
  // 짧게 끊긴 사람(30초 유예 중, 자리가 아직 있음)은 정원이 차 있어도 자기 자리로 돌아옴
  const present = !!m.in?.includes(account);
  if (m.n >= NET_MAX_PLAYERS && !present) return { ok: false, reason: 'full' };
  // 진행 중인 TDM·FFA: 이번 매치에서 끊겨 나갔던 같은 계정(새로고침·끊김)만 돌아올 수 있음. Leave Room으로 나간 계정은 이 매치에 다시 못 들어옴
  const inMatch = m.mode !== 'test' && (m.phase === 'countdown' || m.phase === 'playing');
  if (inMatch && !present && m.quit?.includes(account)) return { ok: false, reason: 'left_match' };
  const returning = present || !!m.gone?.includes(account);
  if (inMatch && !returning) return { ok: false, reason: 'in_progress' };
  return { ok: true };
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

/** 모드에 맞게 팀 다시 배정 (TDM: 기존 팀 유지하되 팀당 정원을 넘으면 옮기고 인원 차이 1명 이하로, 그 외: 팀 없음) */
function assignTeams(players: NetPlayers, mode: NetMode): void {
  const list = Object.values(players).sort((a, b) => a.slot - b.slot);
  if (!NET_MODE_RULES[mode].teams) {
    for (const p of list) {
      p.team = null;
      delete p.seat;
    }
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
    delete p.seat;
    counts[t]++;
  }
  balanceTeams(players);
}

/**
 * TDM 팀 인원 차이를 1명 이하로 (2명 1v1, 3명 2v1 … 8명 4v4): 많은 팀에서 자리 번호가 가장 큰 사람(늦게 들어온 사람)부터
 * 적은 팀으로 옮김. 이미 맞으면 그대로 (고른 팀 유지)
 */
function balanceTeams(players: NetPlayers): void {
  for (;;) {
    const b = teamCount(players, 'BLUE');
    const r = teamCount(players, 'RED');
    if (Math.abs(b - r) <= 1) return;
    const from: NetTeam = b > r ? 'BLUE' : 'RED';
    let mover: NetPlayerRecord | null = null;
    for (const p of Object.values(players)) if (p.team === from && (!mover || p.slot > mover.slot)) mover = p;
    if (!mover) return;
    mover.team = from === 'BLUE' ? 'RED' : 'BLUE';
    delete mover.seat;
  }
}

function emptyRoom(): NetRoomState {
  return { players: {}, host: null, mode: 'test', title: 0, phase: 'lobby', startAt: 0, endAt: 0, timeLimitMs: 0, teamScore: { BLUE: 0, RED: 0 }, result: null, gone: {} };
}

async function readRoom(): Promise<NetRoomState> {
  const st = ((await $room.getRoomState(['players', 'host', 'mode', 'title', 'phase', 'startAt', 'endAt', 'timeLimitMs', 'teamScore', 'result', 'gone'])) || {}) as Partial<NetRoomState>;
  const r = emptyRoom();
  return {
    players: st.players || r.players,
    host: st.host ?? null,
    mode: isNetMode(st.mode) ? st.mode : r.mode,
    title: isRoomTitle(st.title) ? st.title : 0,
    phase: st.phase === 'countdown' || st.phase === 'playing' || st.phase === 'result' ? st.phase : 'lobby',
    startAt: st.startAt || 0,
    endAt: st.endAt || 0,
    timeLimitMs: st.timeLimitMs || 0,
    teamScore: st.teamScore || r.teamScore,
    result: st.result ?? null,
    gone: st.gone || {},
  };
}

function isRoomTitle(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= ROOM_TITLE_COUNT;
}

/** 룸 상태 전체 저장 + 글로벌 요약 갱신. 룸 락 안에서 호출. 제목 번호는 처음 저장할 때 한 번만 무작위로 (예전 방도 다음 저장 때 생김) */
async function saveRoom(roomId: string, r: NetRoomState): Promise<void> {
  if (!isRoomTitle(r.title)) r.title = 1 + Math.floor(Math.random() * ROOM_TITLE_COUNT);
  await $room.updateRoomState({ ...r }, { returnState: false });
  const m: RoomMirror = { n: Object.keys(r.players).length, phase: r.phase, mode: r.mode, ti: r.title, t: Date.now(), gone: Object.keys(r.gone).filter((a) => !r.gone[a]!.quit), quit: Object.keys(r.gone).filter((a) => r.gone[a]!.quit), in: Object.keys(r.players) };
  await $global.updateGlobalState({ [MIRROR(roomId)]: m });
}

/** 피해가 들어가는 시간인지 (카운트다운 끝 ~ 제한 시간 전). 틱이 늦어도 시각으로 판단 */
function isLive(r: NetRoomState, now: number): boolean {
  if (r.phase !== 'countdown' && r.phase !== 'playing') return false;
  if (now < r.startAt) return false;
  return !(r.endAt > 0 && now >= r.endAt);
}

function standingOf(acc: string, p: NetPlayerRecord): NetStanding {
  return { account: acc, slot: p.slot, char: p.char, team: p.team ?? null, k: p.k, d: p.d, ...(p.nick ? { nick: p.nick } : {}), ...(p.lv ? { lv: p.lv } : {}) };
}

// ---------------- 경험치 (계정별 글로벌 사용자 상태에 영구 저장) ----------------

/** 저장된 경험치 읽기 (없거나 이상하면 Lv.1 · 0 XP) — 다른 키(닉네임 등)는 건드리지 않음 */
function progressOf(st: Record<string, unknown> | null | undefined): StoredProgress {
  const xp = typeof st?.xp === 'number' && Number.isFinite(st.xp) ? Math.max(0, Math.min(MAX_XP, Math.floor(st.xp))) : 0;
  const xpm = Array.isArray(st?.xpm) ? (st!.xpm as unknown[]).filter((x): x is string => typeof x === 'string').slice(-20) : [];
  return { xp, lv: levelInfo(xp).level, xpAt: typeof st?.xpAt === 'number' ? st.xpAt : 0, xpm };
}

/**
 * 랭킹 컬렉션 한 줄 갱신 (계정마다 한 줄, id는 계정 상태 rid에 보관, 닉네임이 바뀌어도 같은 줄). 정렬 키 kx(경험치·ID)로
 * 서버가 상위만 읽음. 줄이 지워졌거나 처음이면 새로 만듦 → 새 id 반환
 */
async function upsertRankRow(rid: unknown, account: string, nick: string, xp: number, stats: RankStats): Promise<string> {
  const row = { acc: account, nick, lv: levelInfo(xp).level, xp, [RANK_KEY_FIELD]: rankKey(xp, account, stats), s: stats, t: Date.now() };
  if (typeof rid === 'string' && rid) {
    try {
      await $global.updateCollectionItem(RANK_COLLECTION, { __id: rid, ...row });
      return rid;
    } catch {
      // 줄이 없으면 아래에서 새로
    }
  }
  return (await $global.addCollectionItem(RANK_COLLECTION, row)).__id;
}

/**
 * 매치 종료 경험치·공식 전적 반영 (룸 락 안, finishMatch 직후 한 번): 서버가 확정한 결과(standings·킬 기록·경기 시간)로만 계산.
 * TEST 모드·개발용 제한 시간 경기는 둘 다 없음, 20초 미만 경기는 전적에도 넣지 않음. 중도 이탈은 경험치 없이 전적만 (TDM 패배).
 * 계정마다 xp 락 안에서 읽고-더하고-쓰기 → 동시 요청에도 유실·중복 없음, 경기 id(룸:종료 시각)를 계정 기록에 남겨
 * 같은 경기는 두 번 반영하지 않음. 경험치 결과는 result.xp에 실어 결과 화면이 표시, 전적은 랭킹 컬렉션에도 복사
 */
async function awardMatchXp(roomId: string, r: NetRoomState): Promise<void> {
  const res = r.result;
  if (!res || r.mode === 'test' || r.timeLimitMs !== NET_MODE_RULES[r.mode].timeLimitMs) return;
  const key = `${roomId}:${res.endedAt}`;
  const playedMs = res.endedAt - r.startAt;
  const ranks = standingRanks(res.standings);
  const awards: Record<string, XpAward> = {};
  for (let i = 0; i < res.standings.length; i++) {
    const s = res.standings[i]!;
    const live = r.players[s.account];
    const xp = matchXp({
      mode: r.mode,
      playedMs,
      left: !!s.left || !live,
      win: !res.draw && (r.mode === 'tdm' ? !!s.team && s.team === res.winnerTeam : res.winners.includes(s.account)),
      killsByVictim: Object.values(live?.kv ?? {}),
      rank: ranks[i]!,
      players: res.standings.length,
    });
    const left = !!s.left || !live;
    const counted = playedMs >= MATCH_XP.minMatchMs && (r.mode === 'tdm' || r.mode === 'ffa');
    try {
      await $lock(`xp:${s.account}`, async () => {
        const raw = ((await $global.getUserState(s.account)) || {}) as Record<string, unknown>;
        const st = progressOf(raw);
        if (st.xpm.includes(key)) return;
        const after = Math.min(MAX_XP, st.xp + xp.total);
        const lv = levelInfo(after).level;
        const update: Record<string, unknown> = { xp: after, lv, xpAt: xp.total > 0 ? Date.now() : st.xpAt, xpm: [...st.xpm, key].slice(-20) };
        if (counted) {
          const stats = addMatch(readStats(raw.st), {
            mode: r.mode as 'tdm' | 'ffa',
            k: s.k,
            d: s.d,
            left,
            outcome: res.draw && r.mode === 'tdm' ? 'draw' : !res.draw && (r.mode === 'tdm' ? s.team === res.winnerTeam : res.winners.includes(s.account)) ? 'win' : 'lose',
            rank: ranks[i]!,
            players: res.standings.length,
          });
          const nick = checkNickname(raw.nick);
          update.st = stats;
          try {
            update.rid = await upsertRankRow(raw.rid, s.account, nick.ok ? nick.value : (s.nick ?? `P${s.slot + 1}`), after, stats);
          } catch (err) {
            slog('rank_error', roomId, { account: s.account, err: String(err) });
          }
        }
        await $global.updateUserState(s.account, update);
        if (live) live.lv = lv;
        awards[s.account] = { ...xp, before: st.xp, after };
      });
    } catch (err) {
      slog('xp_error', roomId, { account: s.account, err: String(err) });
    }
  }
  res.xp = awards;
  slog('xp', roomId, { key, playedMs, awards: Object.fromEntries(Object.entries(awards).map(([a, x]) => [a, x.total])) });
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
    const check = joinCheck(m, $sender.account);
    if (!check.ok) return { ok: false, reason: check.reason, count: m.n, mode: m.mode };
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

  /**
   * 방 목록 (룸 밖·로비 룸에서 호출): 글로벌 룸 요약 중 실제 접속자가 있는 매치 룸만. 서버가 아는 값만 돌려줌
   * (방 이름은 없음 → 코드). 최대 30개, 들어갈 수 있는 방·인원 많은 방 먼저
   */
  async listRooms(): Promise<{ ok: true; rooms: NetRoomSummary[] }> {
    const all = (await $global.getGlobalState()) || {};
    const now = Date.now();
    const rooms: NetRoomSummary[] = [];
    for (const [k, v] of Object.entries(all)) {
      const m = v as RoomMirror;
      if (!k.startsWith('room_') || !m || m.n <= 0 || !(now - m.t < MIRROR_TTL_MS)) continue;
      const id = k.slice('room_'.length);
      if (!id.startsWith(NET_ROOM_PREFIX)) continue;
      if ((await $global.countRoomUsers(id)) <= 0) continue;
      const check = joinCheck(m, $sender.account);
      rooms.push({ roomId: id, mode: m.mode, ...(isRoomTitle(m.ti) ? { title: m.ti } : {}), players: m.n, max: NET_MAX_PLAYERS, phase: m.phase, joinable: check.ok, ...(check.reason ? { reason: check.reason } : {}) });
      if (rooms.length >= 30) break;
    }
    rooms.sort((a, b) => Number(b.joinable) - Number(a.joinable) || b.players - a.players);
    return { ok: true, rooms };
  }

  // ---------------- 온라인 로비 (lb- 룸) ----------------

  /**
   * 로비 인스턴스 배정 (룸 밖에서 호출, 클라이언트가 결과 룸에 joinRoom):
   * 이미 들어가 있는 로비(30초 유예 포함)가 있으면 그 로비 → 중복 입장 방지·재접속은 같은 로비.
   * 아니면 정원(HUB_MAX_PLAYERS)이 남은 로비 중 가장 많이 찬 곳 (적은 수의 로비에 모음), 모두 차면 새 번호.
   * 실제 접속자 + 아직 들어오지 않은 예약을 함께 셈 (동시에 여러 명이 배정받아도 정원을 넘지 않게)
   */
  async hubFind(): Promise<{ ok: true; roomId: string; max: number }> {
    const me = $sender.account;
    return $lock('hub:match', async () => {
      const now = Date.now();
      const book = await readBook();
      pruneBook(book, now);
      // 유령 정리: 실제 접속으로 적혀 있는데 SDK 룸에도 없는 계정 (서버가 퇴장 알림을 놓친 경우)
      for (const [id, accs] of Object.entries(book)) {
        const inRoom = new Set(await $global.getRoomUserAccounts(id));
        for (const [acc, e] of Object.entries(accs)) if (e.a !== undefined && !inRoom.has(acc)) delete accs[acc];
      }
      pruneBook(book, now);
      // 이미 자리가 있으면(접속 중·재접속 대기·예약) 그 로비 → 중복 입장 방지, 재접속은 같은 로비
      let pick: string | null = null;
      for (const [id, accs] of Object.entries(book)) if (accs[me]) pick = id;
      // 아니면 빈자리가 있는 로비 중 가장 많이 찬 곳 (사람을 적은 수의 로비에 모음), 모두 차면 새 번호
      if (!pick) {
        for (const [id, accs] of Object.entries(book)) if (hubSeats(accs) < HUB_MAX_PLAYERS && (!pick || hubSeats(accs) > hubSeats(book[pick]))) pick = id;
      }
      if (!pick) {
        let n = 1;
        while (book[`lb-${n}`]) n++;
        pick = `lb-${n}`;
      }
      const accs = (book[pick] ??= {});
      accs[me] = { ...accs[me], r: now };
      await $global.updateGlobalState({ [HUB_BOOK]: book });
      return { ok: true as const, roomId: pick, max: HUB_MAX_PLAYERS };
    });
  }

  /**
   * 로비 입장 직후: 캐릭터·닉네임 등록 + 시작 위치. 정원 초과면 거절 (클라이언트가 나가서 다시 배정받음).
   * 잘못된 캐릭터 id는 거절, 닉네임은 검사 통과 못 하면 빈 값(화면은 기본 이름)
   */
  async hubHello(info: { c?: unknown; n?: unknown; w?: unknown }): Promise<{ ok: boolean; reason?: string; max: number; count: number }> {
    const roomId = hubOf();
    if (!roomId) return { ok: false, reason: 'not_in_hub', max: HUB_MAX_PLAYERS, count: 0 };
    const c = typeof info?.c === 'string' && info.c in NET_CHARACTER_HP ? info.c : null;
    if (!c) return { ok: false, reason: 'bad_char', max: HUB_MAX_PLAYERS, count: 0 };
    const me = $sender.account;
    // 장부에 실제 접속으로 등록 (나를 뺀 자리 수가 정원이면 거절 → 클라이언트가 나가서 다시 배정받음).
    // 같은 계정의 다른 로비 기록은 지움 (중복 세션·유령 방지)
    let count = 0;
    let full = false;
    await editBook((book, now) => {
      if (hubSeats(book[roomId], me) >= HUB_MAX_PLAYERS) {
        full = true;
        count = hubSeats(book[roomId], me);
        return false;
      }
      for (const [id, accs] of Object.entries(book)) if (id !== roomId) delete accs[me];
      (book[roomId] ??= {})[me] = { a: now };
      count = hubActive(book[roomId]);
    });
    if (full) return { ok: false, reason: 'full', max: HUB_MAX_PLAYERS, count };
    const s = HUB_WORLD.spawn;
    const pkt: NetHubPacket = [0, 0, s[0], s[1], s[2], Math.PI, 0, 0, 0, 0, 1];
    const n = (await displayNick(info?.n)) ?? '';
    await $room.updateMyState({ c, n, w: hubWeapon(info?.w), p: pkt, t: Date.now(), x: 0 }, { returnState: false });
    slog('hub_hello', roomId, { account: me, count });
    return { ok: true, max: HUB_MAX_PLAYERS, count };
  }

  /** 로비 캐릭터·무기·닉네임 변경 (장착을 바꿀 때, 닉네임은 보통 nickSet이 같이 바꿈) */
  async hubInfo(info: { c?: unknown; n?: unknown; w?: unknown }): Promise<{ ok: boolean; reason?: string }> {
    if (!hubOf()) return { ok: false, reason: 'not_in_hub' };
    const patch: Record<string, unknown> = {};
    if (info?.c !== undefined) {
      if (typeof info.c !== 'string' || !(info.c in NET_CHARACTER_HP)) return { ok: false, reason: 'bad_char' };
      patch.c = info.c;
    }
    if (info?.w !== undefined) patch.w = hubWeapon(info.w);
    if (info?.n !== undefined) {
      const n = sanitizeNick(info.n);
      if (!n) return { ok: false, reason: 'bad_nick' };
      patch.n = n;
    }
    if (Object.keys(patch).length) await $room.updateMyState(patch, { returnState: false });
    return { ok: true };
  }

  /**
   * 로비 위치 (throttle 호출, 응답 없음): 형식·범위·전송 빈도·이동 속도 검사 후 내 사용자 상태에 저장 → SDK가 같은 로비에 푸시.
   * 너무 잦으면 버림, 너무 멀리 갔으면 버림(직전 위치 유지) — 단 3초 넘게 버려졌으면 다시 맞춤 (정상 이동이 계속 막히지 않게)
   */
  async hubMove(raw: unknown): Promise<void> {
    if (!hubOf()) return;
    const pkt = sanitizeHubPacket(raw);
    if (!pkt) return;
    const now = Date.now();
    const st = ((await $room.getMyState()) || {}) as { p?: NetHubPacket; t?: number; x?: number };
    const lastT = st.t ?? 0;
    if (now - lastT < HUB_TIMING.minAcceptMs) return;
    if (!hubMoveOk(st.p, lastT, pkt, now) && now - lastT < 3000) return;
    await $room.updateMyState({ p: pkt, t: now, ...(st.x ? { x: 0 } : {}) }, { returnState: false });
  }

  /** 같은 로비의 사용자 상태 (구독으로 받는 것과 같은 값: 닉네임·캐릭터·위치·숨김). 입장 직후 한 번·테스트용 */
  async hubState(): Promise<{ ok: boolean; users: Array<{ account: string } & Record<string, unknown>> }> {
    if (!hubOf()) return { ok: false, users: [] };
    const all = await $room.getAllUserStates();
    return { ok: true, users: all.map((u) => ({ account: u.account, n: u.n, c: u.c, w: u.w, p: u.p, x: u.x })) };
  }

  /**
   * 로비에서 나감 (정상 퇴장·매치로 이동): 다른 사람 화면에서 바로 숨기고 장부에서 바로 지움 → 그 자리는 곧바로 빈자리.
   * SDK는 나간 사람도 30초 동안 룸 사용자로 세지만 장부는 그 목록을 쓰지 않음
   */
  async hubBye(): Promise<{ ok: boolean }> {
    const roomId = hubOf();
    if (!roomId) return { ok: false };
    const me = $sender.account;
    await $room.updateMyState({ x: 1 }, { returnState: false });
    await editBook((book) => {
      if (!book[roomId]?.[me]) return false;
      delete book[roomId]![me];
    });
    slog('hub_bye', roomId, { account: me });
    return { ok: true };
  }

  // ---------------- 닉네임 (룸 안팎 모두) ----------------

  /** 저장된 내 닉네임 (없으면 null → 클라이언트가 첫 설정 화면) */
  /**
   * 레벨 랭킹 조회 (통합 하나): 서버가 랭킹 컬렉션을 정렬 키(경험치·ID) 내림차순으로 상위 100명만 읽음 (전체 사용자를 내려보내지 않음).
   * 내 순위 = 내 키보다 큰 사람 수 + 1 (100위 밖이어도). 공식 경기 기록이 없으면 순위 없음(rank 0).
   * 화면에 계정 id는 보내지 않음 (내 줄 표시는 me)
   */
  async rankingGet(): Promise<RankingResult> {
    const field = RANK_KEY_FIELD;
    const me = $sender.account;
    const has = [{ field, operator: '>' as const, value: 0 }];
    try {
      const [items, total, mineRaw] = await Promise.all([
        $global.getCollectionItems(RANK_COLLECTION, { filters: has, orderBy: [{ field, direction: 'desc' }], limit: RANK_PAGE }),
        $global.countCollectionItems(RANK_COLLECTION, { filters: has }),
        $global.getMyState(),
      ]);
      // 키가 계정마다 달라 같은 순위 없음 (같은 경험치는 ID 고정 순서)
      const rows: RankRow[] = items.map((it, i) => ({
        rank: i + 1,
        nick: typeof it.nick === 'string' ? it.nick : '플레이어',
        lv: levelInfo(Number(it.xp) || 0).level,
        me: it.acc === me,
        s: readStats(it.s),
      }));
      const raw = (mineRaw || {}) as Record<string, unknown>;
      const stats = readStats(raw.st);
      const myKey = rankKey(progressOf(raw).xp, me, stats);
      const nick = checkNickname(raw.nick);
      const mine: RankRow = {
        rank: myKey > 0 ? (await $global.countCollectionItems(RANK_COLLECTION, { filters: [{ field, operator: '>', value: myKey }] })) + 1 : 0,
        nick: nick.ok ? nick.value : '',
        lv: progressOf(raw).lv,
        me: true,
        s: stats,
      };
      return { ok: true, rows, mine, total };
    } catch (err) {
      slog('rank_error', '-', { err: String(err) });
      return { ok: false, reason: 'error', rows: [], mine: null, total: 0 };
    }
  }

  /** 내 경험치 (로비 표시용, 원본은 서버 저장값) */
  async progressGet(): Promise<{ ok: true; xp: number; lv: number }> {
    const p = progressOf((await $global.getMyState()) as Record<string, unknown>);
    return { ok: true, xp: p.xp, lv: p.lv };
  }

  async nickGet(): Promise<{ ok: true; nick: string | null }> {
    const nick = await storedNick();
    // 기존 닉네임(중복 방지 전에 정한 이름)은 그대로 두고, 등록부에 비어 있으면 이 계정 것으로 등록
    if (nick) {
      const st = ((await $global.getMyState()) || {}) as { nickReg?: unknown };
      if (st.nickReg !== nickKey(nick)) {
        try {
          if (await claimNick($sender.account, nick)) await $global.updateMyState({ nickReg: nickKey(nick) });
          else slog('nick_shared_legacy', '-', { account: $sender.account });
        } catch {
          // 등록부를 못 써도 접속은 그대로
        }
      }
    }
    return { ok: true, nick };
  }

  /**
   * 닉네임 저장 (최종 검사): 형식·금칙어 통과 + 다른 계정이 쓰지 않는 이름만 저장(대소문자·앞뒤 공백 무시, 'taken'),
   * 실패하면 이전 값 그대로. 바꾸는 간격 제한 (첫 설정 제외).
   * 로비 안이면 로비 사용자 상태도 바꿈 → 다른 사람 머리 위 이름이 바로 바뀜. 실패 이유는 형식·금칙어를 구분해 돌려줌
   */
  async nickSet(raw: unknown): Promise<{ ok: boolean; nick?: string; reason?: string; retryMs?: number }> {
    const r = checkNickname(raw);
    if (!r.ok) return { ok: false, reason: r.reason };
    const now = Date.now();
    const st = ((await $global.getMyState()) || {}) as { nick?: unknown; nickAt?: unknown };
    if (st.nick !== r.value) {
      const last = typeof st.nickAt === 'number' ? st.nickAt : 0;
      if (typeof st.nick === 'string' && st.nick && now - last < NICK_CHANGE_MS) return { ok: false, reason: 'rate', retryMs: NICK_CHANGE_MS - (now - last) };
      if (!(await claimNick($sender.account, r.value))) return { ok: false, reason: 'taken' };
      await $global.updateMyState({ nick: r.value, nickAt: now, nickReg: nickKey(r.value) });
      // 예전 이름은 놓음 (대소문자만 바꾼 경우는 같은 등록이라 그대로)
      if (typeof st.nick === 'string' && st.nick && nickKey(st.nick) !== nickKey(r.value)) await releaseNick($sender.account, st.nick).catch(() => undefined);
      const rid = (st as { rid?: unknown }).rid;
      if (typeof rid === 'string' && rid) await $global.updateCollectionItem(RANK_COLLECTION, { __id: rid, nick: r.value }).catch(() => undefined);
    }
    if (hubOf()) await $room.updateMyState({ n: r.value }, { returnState: false });
    return { ok: true, nick: r.value };
  }

  /** RTT 측정·서버 시각 (룸 안팎 모두) */
  async ping(t: number): Promise<{ t: number; s: number }> {
    return { t: finite(t, 1e13) ? t : 0, s: Date.now() };
  }

  // ---------------- 룸 수명 주기 ----------------

  async onRoomJoin(roomId: string, account: string): Promise<void> {
    // 로비 룸: 매치 기록·자리 배정 없음 (등록은 hubHello)
    if (isHubRoom(roomId)) return;
    const slot = await $lock(`room:${roomId}`, async () => {
      const r = await readRoom();
      if (r.players[account]) return r.players[account]!.slot;
      const s = this.admit(r, account).slot;
      if (s < 0) return -1;
      await saveRoom(roomId, r);
      return s;
    });
    if (slot >= 0) $room.broadcastToRoom('joined', { account, slot });
    slog('join', roomId, { account, slot });
  }

  async onRoomDisconnect(roomId: string, account: string): Promise<void> {
    if (isHubRoom(roomId)) {
      // 30초 유예 동안 다른 사람 화면에서 숨김 (다시 들어오면 hubHello·hubMove가 x: 0).
      // 장부: 실제 접속 → 재접속 대기 (자리는 30초 동안 지킴, 같은 계정이 다시 오면 hubFind가 같은 로비로)
      await $room.updateUserState(account, { x: 1 }, { returnState: false });
      await editBook((book, now) => {
        const e = book[roomId]?.[account];
        if (!e || e.a === undefined) return false;
        e.d = now;
      });
      return;
    }
    // 30초 유예: 아직 룸 안 (재접속하면 그대로 이어짐)
    $room.broadcastToRoom('dc', { account, roomId });
    slog('disconnect', roomId, { account });
  }

  async onRoomLeave(roomId: string, account: string): Promise<void> {
    if (isHubRoom(roomId)) {
      // 나감(leaveRoom)·재접속 대기 끝: 장부에서 지움. 단 그 사이 다시 배정받은 예약(r만 있음)은 남김
      await editBook((book) => {
        const e = book[roomId]?.[account];
        if (!e || (e.a === undefined && e.d === undefined)) return false;
        delete book[roomId]![account];
      });
      slog('hub_leave', roomId, { account });
      return;
    }
    if (await this.removePlayer(roomId, account)) $room.broadcastToRoom('left', { account });
    slog('leave', roomId, { account });
  }

  async onRoomDestroy(roomId: string): Promise<void> {
    if (isHubRoom(roomId)) {
      // 빈 로비: 남은 장부 정리 (방금 배정받아 들어오는 중인 예약은 남김)
      await editBook((book) => {
        const accs = book[roomId];
        if (!accs) return false;
        for (const [acc, e] of Object.entries(accs)) if (e.a !== undefined || e.d !== undefined) delete accs[acc];
      });
      return;
    }
    await $global.clearGlobalState([MIRROR(roomId)]);
  }

  /**
   * 매치 단계 진행 (활성 룸마다 200ms, 공식 문서): 카운트다운 끝 → playing, 제한 시간 끝 → 결과.
   * 대부분의 틱은 단계·시각만 읽고 끝남 (락·쓰기 없음)
   */
  async $roomTick(_delta: number, roomId: string): Promise<void> {
    // 로비 룸: 매치 단계·타이머 없음 (상태도 읽지 않음)
    if (isHubRoom(roomId)) return;
    const st = ((await $room.getRoomState(['phase', 'startAt', 'endAt'])) || {}) as Partial<NetRoomState>;
    if (st.phase !== 'countdown' && st.phase !== 'playing') return;
    const now = Date.now();
    const toPlaying = st.phase === 'countdown' && now >= (st.startAt ?? 0);
    const timeUp = (st.endAt ?? 0) > 0 && now >= st.endAt!;
    if (!toPlaying && !timeUp) return;
    await $lock(`room:${roomId}`, async () => {
      const r = await readRoom();
      const t = Date.now();
      if (r.endAt > 0 && t >= r.endAt) {
        finishMatch(r, 'time', t);
        await awardMatchXp(roomId, r);
      } else if (r.phase === 'countdown' && t >= r.startAt) r.phase = 'playing';
      else return;
      await saveRoom(roomId, r);
      if (r.phase === 'result') slog('match_end', roomId, { reason: 'time', mode: r.mode, teamScore: r.teamScore, winners: r.result?.winners.length, draw: r.result?.draw });
    });
  }

  /**
   * 참가자 기록 제거 (매치 중이면 기록을 결과·복귀용으로 보존, 방장이면 남은 사람에게 넘김).
   * quit = Leave Room (이 매치 재입장 불가) / false = 끊김·새로고침·탭 닫기 (같은 계정 복귀 가능). @returns 제거했으면 true
   */
  private async removePlayer(roomId: string, account: string, quit = false): Promise<boolean> {
    return $lock(`room:${roomId}`, async () => {
      const r = await readRoom();
      const p = r.players[account];
      if (!p) return false;
      if (r.phase === 'countdown' || r.phase === 'playing') r.gone[account] = { ...standingOf(account, p), left: true, quit, hp: p.dead ? 0 : p.hp };
      delete r.players[account];
      if (r.host === account || !r.host || !r.players[r.host]) r.host = pickHost(r.players);
      if (Object.keys(r.players).length === 0) Object.assign(r, { phase: 'lobby', result: null, gone: {}, startAt: 0, endAt: 0 });
      await saveRoom(roomId, r);
      return true;
    });
  }

  /**
   * 새 참가자 자리·팀 배정 (락 안). @returns 자리 (못 들어오면 -1 + 이유: full | in_progress | left_match | team_full)
   *
   * 매치 중 복귀 (이번 매치 기록이 gone에 있는 같은 계정 — 새로고침·30초 넘는 끊김):
   * - 팀·캐릭터·킬/데스·체력(나갈 때 값, 쓰러져 나갔으면 가득)을 되살림
   * - 팀은 반드시 원래 팀. 원래 팀이 이미 꽉 찼으면 다른 팀으로 보내지 않고 거절 (팀 인원 제한 우회 없음)
   * - Leave Room으로 나간 계정(quit)은 이번 매치에 다시 못 들어옴
   * 30초 유예 중(아직 players에 있음)은 여기까지 오지 않고 기존 자리 그대로 (onRoomJoin·hello)
   */
  private admit(r: NetRoomState, account: string): { slot: number; reason?: string } {
    const inMatch = r.phase === 'countdown' || r.phase === 'playing';
    const back = inMatch ? r.gone[account] : undefined;
    if (back?.quit && r.mode !== 'test') return { slot: -1, reason: 'left_match' };
    if (back && !back.quit) {
      const used = new Set(Object.values(r.players).map((p) => p.slot));
      const slot = used.has(back.slot) ? freeSlot(r.players) : back.slot;
      if (slot < 0) return { slot: -1, reason: 'full' };
      const teams = NET_MODE_RULES[r.mode].teams;
      if (teams && (!back.team || teamCount(r.players, back.team) >= NET_TEAM_SIZE)) return { slot: -1, reason: 'team_full' };
      const rec = newRecord(slot, Date.now());
      const max = NET_CHARACTER_HP[back.char] ?? NET_DEFAULT_HP;
      const hp = typeof back.hp === 'number' && back.hp > 0 ? Math.min(back.hp, max) : max;
      Object.assign(rec, { char: back.char, max, hp, k: back.k, d: back.d, team: teams ? back.team : null });
      r.players[account] = rec;
      delete r.gone[account];
      if (!r.host || !r.players[r.host]) r.host = pickHost(r.players);
      return { slot };
    }
    // TDM·FFA 매치 중 새 참가자는 받지 않음 (자유 테스트는 중간 입장 허용)
    if (r.mode !== 'test' && inMatch) return { slot: -1, reason: 'in_progress' };
    const slot = freeSlot(r.players);
    // 정원 초과: onRoomJoin에서 거절하면 SDK가 재시도만 반복함(문서) → 자리 없이 두고 클라이언트가 스스로 나감
    if (slot < 0) return { slot: -1, reason: 'full' };
    if (back) delete r.gone[account];
    const rec = newRecord(slot, Date.now());
    rec.team = NET_MODE_RULES[r.mode].teams ? pickTeam(r.players) : null;
    r.players[account] = rec;
    if (!r.host || !r.players[r.host]) r.host = pickHost(r.players);
    return { slot };
  }

  // ---------------- 룸 안 ----------------

  /** 입장 직후: 캐릭터(최대 체력) 등록. @returns 자리(-1 = 못 들어옴, reason), 서버 시각, 룸 전체 상태 */
  async hello(char: string, nick?: unknown): Promise<HelloResult> {
    const me = $sender.account;
    if (!roomOf()) throw new Error('not in room');
    const roomId = roomOf()!;
    return $lock(`room:${roomId}`, async () => {
      const r = await readRoom();
      let p = r.players[me];
      if (!p) {
        // 나가기(bye) 뒤 30초 유예 안에 다시 들어오면 SDK가 onRoomJoin을 다시 부르지 않음(세션 이어짐) → 여기서 자리 배정
        const { slot, reason } = this.admit(r, me);
        if (slot < 0) return { ...r, slot: -1, reason: reason ?? 'full', now: Date.now() };
        p = r.players[me]!;
        await saveRoom(roomId, r);
        $room.broadcastToRoom('joined', { account: me, slot });
      }
      // 표시 닉네임 (서버에 저장된 값 먼저, 검사 통과한 값만, 바뀔 때만 저장) + 레벨 (서버 저장 경험치)
      const n = await displayNick(nick);
      let lv = p.lv ?? 1;
      try {
        lv = progressOf((await $global.getMyState()) as Record<string, unknown>).lv;
      } catch {
        // 글로벌 상태를 못 읽어도 입장은 막지 않음
      }
      if ((n && n !== p.nick) || lv !== p.lv) {
        if (n) p.nick = n;
        p.lv = lv;
        await $room.updateRoomState({ players: r.players }, { returnState: false });
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

  /** TDM 대기실: 자기 팀 바꾸기 (상대 팀이 더 적을 때만 → 팀 인원 차이 1명 이하 유지) */
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
      if (p.team && teamCount(r.players, to) >= teamCount(r.players, p.team)) return { ok: false, reason: 'teams_unbalanced' };
      p.team = to;
      await saveRoom(roomId, r);
      return { ok: true };
    });
  }

  /**
   * TDM 대기실: 빈 칸 클릭 → 그 팀·그 칸으로 옮기기 (어느 팀이든, 팀 인원 차이는 시작할 때 서버가 1명 이하로 맞춤).
   * 다른 사람은 지금 보이는 칸 그대로 고정
   */
  async moveSeat(team: string, seat: number): Promise<{ ok: boolean; reason?: string }> {
    if (!roomOf()) return { ok: false, reason: 'not_in_room' };
    const to = TEAMS.find((t) => t === team);
    if (!to || !Number.isInteger(seat) || seat < 0 || seat >= NET_TEAM_SIZE) return { ok: false, reason: 'bad_seat' };
    const me = $sender.account;
    const roomId = roomOf()!;
    return $lock(`room:${roomId}`, async () => {
      const r = await readRoom();
      const p = r.players[me];
      if (!p || r.mode !== 'tdm') return { ok: false, reason: 'not_tdm' };
      if (r.phase === 'countdown' || r.phase === 'playing') return { ok: false, reason: 'in_progress' };
      const target = teamSeats(r.players, to)[seat];
      if (target === me) return { ok: true };
      if (target) return { ok: false, reason: 'seat_taken' };
      for (const t of TEAMS) teamSeats(r.players, t).forEach((acc, i) => acc && (r.players[acc]!.seat = i));
      p.team = to;
      p.seat = seat;
      await saveRoom(roomId, r);
      return { ok: true };
    });
  }

  /**
   * 방장: 매치 시작. 모든 모드 2~8명. TDM은 시작할 때 팀 인원 차이를 1명 이하로 맞춤 (1v1 … 4v4).
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
      if (rule.teams) assignTeams(r.players, r.mode);
      const now = Date.now();
      const startAt = now + NET_TIMING.countdownMs;
      const t = opts?.timeLimitSec;
      const custom = typeof t === 'number' && Number.isFinite(t) && t >= NET_TEST_TIME_LIMIT_SEC.min && t <= NET_TEST_TIME_LIMIT_SEC.max && rule.timeLimitMs > 0;
      const limit = custom ? Math.round(t) * 1000 : rule.timeLimitMs;
      for (const p of Object.values(r.players)) {
        Object.assign(p, { hp: p.max, dead: false, respawnAt: 0, k: 0, d: 0, prot: startAt, kv: {} });
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

  /**
   * 나가기 알림: 기록을 바로 지우고 알림 (SDK leaveRoom은 끊김과 구분이 안 돼 30초 유예를 기다리므로 먼저 호출).
   * opts.quit = true: Leave Room 버튼 (이번 매치 재입장 불가). 없거나 false: 새로고침·탭 닫기 (같은 계정 복귀 가능)
   */
  async bye(opts?: { quit?: boolean }): Promise<{ ok: boolean }> {
    if (!roomOf()) return { ok: false };
    const me = $sender.account;
    const quit = opts?.quit === true;
    const removed = await this.removePlayer(roomOf()!, me, quit);
    if (removed) $room.broadcastToRoom('left', { account: me, quit });
    slog(quit ? 'quit' : 'bye', roomOf()!, { account: me });
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

  /** 리스폰 요청: 서버 시각으로 대기 시간이 지났을 때만. 보호 2초 (prot = 보호 끝 서버 시각 → 클라이언트 보호 표시를 서버에 맞춤) */
  async respawn(): Promise<{ ok: boolean; hp?: number; wait?: number; prot?: number }> {
    if (!roomOf()) return { ok: false };
    const me = $sender.account;
    const res = await $lock(`room:${roomOf()!}`, async () => {
      const r = await readRoom();
      const p = r.players[me];
      if (!p) return { ok: false };
      if (!p.dead) return { ok: true, hp: p.hp, prot: p.prot };
      const now = Date.now();
      // 클라이언트 타이머와 서버 시각 차이 150ms까지 허용
      if (now < p.respawnAt - 150) return { ok: false, wait: p.respawnAt - now };
      p.dead = false;
      p.hp = p.max;
      p.prot = now + NET_TIMING.spawnProtectionMs;
      await $room.updateRoomState({ players: r.players }, { returnState: false });
      return { ok: true, hp: p.hp, prot: p.prot };
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
          (att.kv ??= {})[h.v] = (att.kv[h.v] ?? 0) + 1;
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
        await awardMatchXp(roomId, r);
        await saveRoom(roomId, r);
        slog('match_end', roomId, { reason: 'score', mode: r.mode, teamScore: r.teamScore, winners: r.result?.winners.length, draw: r.result?.draw });
      } else if (changed) await $room.updateRoomState({ players, teamScore: r.teamScore }, { returnState: false });
    });
    for (const k of results.filter((x) => x.kill)) slog('kill', roomId, { attacker: k.a, victim: k.v, weapon: k.w, headshot: k.hd });
    if (results.length > 0) $room.broadcastToRoom('hits', { r: results });
    if (rejected.length > 0) $room.sendMessageToUser('rej', me, { r: rejected });
  }
}
