/**
 * POP! BATTLE — Verse8 Agent8 GameServer: 2인 실시간 테스트 룸 (기술 검증용 최소 구현)
 *
 * 역할 분담
 *  - 이동: 클라이언트가 50ms마다 상태 패킷('st', throttle 호출)을 보냄 → 룸 사용자 상태(s)에 저장 → SDK가 다른 클라이언트에 푸시.
 *  - 사격 연출: 같은 패킷에 실린 탄(s) → 'fx' 브로드캐스트.
 *  - 피해: 클라이언트는 "맞혔다"는 주장(h)만 보냄. 피해량·체력·사망·킬/데스·리스폰은 서버가 계산·소유 (룸 상태 players).
 *    서버는 물리 월드(맵 콜라이더)가 없어 시야(벽 관통)는 검사하지 못함 → 거리·사거리·연사 속도·생존·보호만 검증.
 *
 * 런타임 제약 (공식 문서): 요청마다 새 인스턴스, 타이머 없음, 모든 메서드가 공개 엔드포인트.
 * 읽기-수정-쓰기는 $lock(`room:<id>`)으로 직렬화.
 */
import {
  NET_CHARACTER_HP,
  NET_DEFAULT_HP,
  NET_MAX_PLAYERS,
  NET_ROOM_PREFIX,
  NET_TIMING,
  NET_VALIDATION,
  NET_WEAPONS,
  netDamage,
  type NetHitClaim,
  type NetHitResult,
  type NetPlayerRecord,
  type NetPlayers,
  type NetRejected,
  type NetShot,
} from '../../src/net/shared/protocol';

const NO_ROOM = '__no_room__';
const ROOM_CODE = /^pb-[a-z0-9]{4,12}$/;
/** 글로벌 상태의 룸 요약 키 (룸 밖 매칭 함수가 참가 인원·진행 상태를 읽음) */
const MIRROR = (roomId: string) => `room_${roomId}`;
/** 요약이 이보다 오래되면 정리 (onRoomDestroy가 best-effort라 남을 수 있음) */
const MIRROR_TTL_MS = 6 * 60 * 60 * 1000;

type RoomPhase = 'lobby' | 'playing';

interface RoomMirror {
  n: number;
  phase: RoomPhase;
  t: number;
}

/** 'ABC123' 또는 'pb-abc123' → 'pb-abc123' */
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

/** 룸 상태(참가자·방장·진행) 저장 + 글로벌 요약 갱신. 룸 락 안에서 호출 */
async function saveRoom(roomId: string, players: NetPlayers, host: string | null, phase: RoomPhase, extra: Record<string, unknown> = {}): Promise<void> {
  await $room.updateRoomState({ players, host, phase, ...extra }, { returnState: false });
  const m: RoomMirror = { n: Object.keys(players).length, phase, t: Date.now() };
  await $global.updateGlobalState({ [MIRROR(roomId)]: m }, { returnState: false });
}

async function readRoom(): Promise<{ players: NetPlayers; host: string | null; phase: RoomPhase; startedAt: number }> {
  const st = (await $room.getRoomState(['players', 'host', 'phase', 'startedAt'])) || {};
  return { players: st.players || {}, host: st.host ?? null, phase: st.phase === 'playing' ? 'playing' : 'lobby', startedAt: st.startedAt || 0 };
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

export class Server {
  // ---------------- 매칭 (룸 밖에서 호출) ----------------

  /** 새 테스트 룸 id. 실제 생성은 첫 플레이어가 joinRoom 할 때 (SDK 규칙). 오래된 룸 요약도 정리 */
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
   * 최종 정원 판정은 onRoomJoin(자리 배정)
   */
  async findRoom(code: string): Promise<{ ok: boolean; roomId?: string; reason?: string; count?: number; phase?: RoomPhase }> {
    const id = normalizeCode(code);
    if (!id) return { ok: false, reason: 'bad_code' };
    const m = ((await $global.getGlobalState([MIRROR(id)])) || {})[MIRROR(id)] as RoomMirror | undefined;
    const users = await $global.countRoomUsers(id);
    if (!m || users <= 0 || m.n <= 0) return { ok: false, reason: 'not_found', count: 0 };
    if (m.n >= NET_MAX_PLAYERS) return { ok: false, reason: 'full', count: m.n };
    return { ok: true, roomId: id, count: m.n, phase: m.phase };
  }

  /** 빠른 매칭: 1명이 기다리는 테스트 룸이 있으면 그 룸, 없으면 새 룸 */
  async quickMatch(): Promise<{ ok: true; roomId: string; waiting: boolean }> {
    const all = (await $global.getGlobalState()) || {};
    for (const [k, v] of Object.entries(all)) {
      const m = v as RoomMirror;
      if (!k.startsWith('room_') || !m || m.n !== 1 || Date.now() - m.t > MIRROR_TTL_MS) continue;
      const id = k.slice('room_'.length);
      if ((await $global.countRoomUsers(id)) > 0) return { ok: true, roomId: id, waiting: true };
    }
    return { ok: true, roomId: newRoomId(), waiting: false };
  }

  /** RTT 측정 (룸 안팎 모두) */
  async ping(t: number): Promise<{ t: number; s: number }> {
    return { t: finite(t, 1e13) ? t : 0, s: Date.now() };
  }

  // ---------------- 룸 수명 주기 ----------------

  async onRoomJoin(roomId: string, account: string): Promise<void> {
    const slot = await $lock(`room:${roomId}`, async () => {
      const r = await readRoom();
      if (r.players[account]) return r.players[account]!.slot;
      const s = freeSlot(r.players);
      // 정원 초과: onRoomJoin에서 거절하면 SDK가 재시도만 반복함(문서) → 자리 없이 관전자로 두고 클라이언트가 스스로 나감
      if (s < 0) return -1;
      r.players[account] = newRecord(s, Date.now());
      await saveRoom(roomId, r.players, r.host && r.players[r.host] ? r.host : pickHost(r.players), r.phase);
      return s;
    });
    $room.broadcastToRoom('joined', { account, slot });
  }

  async onRoomDisconnect(roomId: string, account: string): Promise<void> {
    // 30초 유예: 아직 룸 안 (재접속하면 그대로 이어짐)
    $room.broadcastToRoom('dc', { account, roomId });
  }

  async onRoomLeave(roomId: string, account: string): Promise<void> {
    if (await this.removePlayer(roomId, account)) $room.broadcastToRoom('left', { account });
  }

  async onRoomDestroy(roomId: string): Promise<void> {
    await $global.clearGlobalState([MIRROR(roomId)]);
  }

  /** 참가자 기록 제거 (방장이면 남은 사람에게 넘김, 아무도 없으면 대기 상태로). @returns 제거했으면 true */
  private async removePlayer(roomId: string, account: string): Promise<boolean> {
    return $lock(`room:${roomId}`, async () => {
      const r = await readRoom();
      if (!r.players[account]) return false;
      delete r.players[account];
      const host = r.host === account || !r.host ? pickHost(r.players) : r.host;
      await saveRoom(roomId, r.players, host, Object.keys(r.players).length === 0 ? 'lobby' : r.phase);
      return true;
    });
  }

  // ---------------- 룸 안 ----------------

  /** 입장 직후: 캐릭터(최대 체력) 등록. @returns 자리(-1 = 정원 초과 관전자), 서버 시각, 현재 참가자·방장·진행 상태 */
  async hello(char: string): Promise<{ slot: number; now: number; players: NetPlayers; host: string | null; phase: RoomPhase; startedAt: number }> {
    const me = $sender.account;
    if ($sender.roomId === NO_ROOM) throw new Error('not in room');
    const roomId = $sender.roomId;
    return $lock(`room:${roomId}`, async () => {
      const r = await readRoom();
      const players = r.players;
      let p = players[me];
      let host = r.host;
      const out = (slot: number) => ({ slot, now: Date.now(), players, host, phase: r.phase, startedAt: r.startedAt });
      if (!p) {
        // 나가기(bye) 뒤 30초 유예 안에 다시 들어오면 SDK가 onRoomJoin을 다시 부르지 않음(세션 이어짐) → 여기서 빈자리 배정
        const slot = freeSlot(players);
        if (slot < 0) return out(-1);
        p = players[me] = newRecord(slot, Date.now());
        host = host && players[host] ? host : pickHost(players);
        await saveRoom(roomId, players, host, r.phase);
        $room.broadcastToRoom('joined', { account: me, slot });
      }
      if (typeof char === 'string' && char in NET_CHARACTER_HP) {
        const max = NET_CHARACTER_HP[char]!;
        // 다친 상태로 캐릭터만 바꿔 회복하는 것 방지: 가득 찬 상태일 때만 새 최대치로 채움
        const full = !p.dead && p.hp >= p.max;
        p.char = char;
        p.max = max;
        p.hp = full ? max : Math.min(p.hp, max);
        await $room.updateRoomState({ players }, { returnState: false });
      }
      return out(p.slot);
    });
  }

  /** 방장이 테스트 시작: 2명이 모두 있을 때만. 체력·기록 초기화 후 진행 상태 공유 (두 클라이언트가 룸 상태로 동시에 시작) */
  async startTest(): Promise<{ ok: boolean; reason?: string }> {
    if ($sender.roomId === NO_ROOM) return { ok: false, reason: 'not_in_room' };
    const me = $sender.account;
    const roomId = $sender.roomId;
    return $lock(`room:${roomId}`, async () => {
      const r = await readRoom();
      if (r.host !== me) return { ok: false, reason: 'not_host' };
      if (Object.keys(r.players).length < NET_MAX_PLAYERS) return { ok: false, reason: 'need_2_players' };
      const now = Date.now();
      for (const p of Object.values(r.players)) {
        Object.assign(p, { hp: p.max, dead: false, respawnAt: 0, k: 0, d: 0, prot: now + NET_TIMING.startProtectionMs });
        delete p.rb;
      }
      await saveRoom(roomId, r.players, r.host, 'playing', { startedAt: now });
      return { ok: true };
    });
  }

  /** 직접 나가기: 기록을 바로 지우고 알림 (SDK leaveRoom은 끊김과 구분이 안 돼 30초 유예를 기다리므로 먼저 호출) */
  async bye(): Promise<{ ok: boolean }> {
    if ($sender.roomId === NO_ROOM) return { ok: false };
    const me = $sender.account;
    const removed = await this.removePlayer($sender.roomId, me);
    if (removed) $room.broadcastToRoom('left', { account: me });
    return { ok: removed };
  }

  /** 상태 패킷 (throttle, 응답 없음): 이동 저장 + 탄 연출 중계 + 명중 검증·피해 */
  async st(pkt: any): Promise<void> {
    if ($sender.roomId === NO_ROOM) return;
    const state = sanitizeState(pkt);
    if (!state) return;
    const me = $sender.account;
    await $room.updateMyState({ s: state }, { returnState: false });
    const shots = sanitizeShots(pkt.s);
    const hits = sanitizeHits(pkt.h);
    if (shots.length > 0) $room.broadcastToRoom('fx', { a: me, s: shots });
    if (shots.length > 0 || hits.length > 0) await this.combat($sender.roomId, me, state.p as [number, number, number], shots, hits);
  }

  /** 자멸·낙사 (공격자 없는 사망) */
  async selfDeath(cause: string): Promise<{ ok: boolean }> {
    if ($sender.roomId === NO_ROOM) return { ok: false };
    const me = $sender.account;
    const c = cause === 'fall' ? 'fall' : 'suicide';
    const result = await $lock(`room:${$sender.roomId}`, async () => {
      const state = (await $room.getRoomState(['players'])) || {};
      const players: NetPlayers = state.players || {};
      const p = players[me];
      if (!p || p.dead) return null;
      const now = Date.now();
      p.dead = true;
      p.hp = 0;
      p.d++;
      // 낙사는 기존 게임처럼 바로 부활 가능
      p.respawnAt = now + (c === 'fall' ? 0 : NET_TIMING.respawnDelayMs);
      await $room.updateRoomState({ players }, { returnState: false });
      const r: NetHitResult = { a: null, v: me, w: null, dmg: 0, hp: 0, hd: false, kill: true, cause: c };
      return r;
    });
    if (result) $room.broadcastToRoom('hits', { r: [result] });
    return { ok: !!result };
  }

  /** 리스폰 요청: 서버 시각으로 대기 시간이 지났을 때만 */
  async respawn(): Promise<{ ok: boolean; hp?: number; wait?: number }> {
    if ($sender.roomId === NO_ROOM) return { ok: false };
    const me = $sender.account;
    const res = await $lock(`room:${$sender.roomId}`, async () => {
      const state = (await $room.getRoomState(['players'])) || {};
      const players: NetPlayers = state.players || {};
      const p = players[me];
      if (!p) return { ok: false };
      if (!p.dead) return { ok: true, hp: p.hp };
      const now = Date.now();
      // 클라이언트 타이머와 서버 시각 차이 150ms까지 허용
      if (now < p.respawnAt - 150) return { ok: false, wait: p.respawnAt - now };
      p.dead = false;
      p.hp = p.max;
      p.prot = now + NET_TIMING.spawnProtectionMs;
      await $room.updateRoomState({ players }, { returnState: false });
      return { ok: true, hp: p.hp };
    });
    if (res.ok) $room.broadcastToRoom('spawn', { a: me, hp: res.hp });
    return res;
  }

  /** 명중 검증 + 피해 (룸 락 안에서 체력 읽기-수정-쓰기) */
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
      // 대기실(시작 전)에서는 피해 없음
      if (r.phase !== 'playing') {
        hits.forEach((h) => reject(h, 'not_started'));
        return;
      }
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
        const rule = NET_WEAPONS[s.w]!;
        const rate = (rule.rpm / 60) * NET_VALIDATION.rateSlack;
        rb.tokens = Math.min(NET_VALIDATION.burstShots, rb.tokens + ((now - rb.t) / 1000) * rate);
        rb.t = now;
        const cost = 1 / rule.pellets;
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
        if (vic.dead) {
          reject(h, 'victim_dead');
          continue;
        }
        const rule = NET_WEAPONS[h.w]!;
        if (h.d > rule.range + NET_VALIDATION.rangeSlack) {
          reject(h, 'out_of_range');
          continue;
        }
        const vp = posOf.get(h.v);
        if (!vp) {
          reject(h, 'no_victim_pos');
          continue;
        }
        const serverDist = dist(myPos, vp);
        if (Math.abs(serverDist - h.d) > NET_VALIDATION.distanceTolerance || serverDist > rule.range + NET_VALIDATION.rangeSlack + NET_VALIDATION.distanceTolerance) {
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
          vic.dead = true;
          vic.respawnAt = now + NET_TIMING.respawnDelayMs;
          vic.d++;
          att.k++;
        }
        changed = true;
        results.push({ a: me, v: h.v, w: h.w, dmg, hp: vic.hp, hd: h.hd === 1, kill, cause: 'weapon' });
      }
      if (changed) await $room.updateRoomState({ players }, { returnState: false });
    });
    if (results.length > 0) $room.broadcastToRoom('hits', { r: results });
    if (rejected.length > 0) $room.sendMessageToUser('rej', me, { r: rejected });
  }
}
