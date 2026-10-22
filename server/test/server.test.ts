/**
 * 멀티플레이 룸·게임 모드 서버 로직 (로컬 하네스: npx -y @agent8/gameserver-node test).
 * 매치는 3초 카운트다운 뒤부터 피해가 들어가므로 시작 뒤 spin(COUNTDOWN)으로 기다린다.
 * 하네스는 실제 네트워크 없이 같은 isolated-vm 런타임에서 훅·함수를 호출한다 → 지연·패킷·푸시 동작은 여기서 검증되지 않음.
 */

import { checkNickname } from '../../src/net/shared/nickFilter';

const ROOM = 'pb-test01';

/** 하네스 안에는 타이머가 없어 시간 경과는 바쁜 대기로 */
function spin(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* wait */
  }
}

const COUNTDOWN = 3050;

function state(p: [number, number, number], extra: Record<string, unknown> = {}) {
  return { q: 1, t: 1000, p, v: [0, 0, 0], y: 0, a: [0, 0, 1], pi: 0, m: 0, f: 1, w: 'rifle', c: 'blue', rl: 0, ms: 0, bp: 0, ads: 0, k: 0, ...extra };
}

async function setupPair(server: any) {
  await server.simulateJoin(ROOM, 'alice');
  await server.simulateJoin(ROOM, 'bob');
  server.connect({ account: 'alice', roomId: ROOM });
  await server.hello('blue');
  await server.st(state([0, 0, 0]));
  server.connect({ account: 'bob', roomId: ROOM });
  await server.hello('blue');
  // 방장(alice, 먼저 입장)이 테스트 시작
  server.connect({ account: 'alice', roomId: ROOM });
  expect((await server.startTest()).ok).toBe(true);
  spin(COUNTDOWN);
  server.connect({ account: 'bob', roomId: ROOM });
  await server.st(state([0, 0, 10], { s: [{ w: 'rifle', f: [0, 1, 10], e: [5, 1, 20], h: 0 }] }));
  server.connect({ account: 'alice', roomId: ROOM });
}

async function players(server: any) {
  return (await server.connect({ account: 'alice', roomId: ROOM }), (await server.hello('blue')).players);
}

describe('matching', () => {
  test('createRoom returns prefixed id', async (server) => {
    const r = await server.createRoom();
    expect(r.ok).toBe(true);
    expect(r.roomId).toMatch(/^pb-[a-z0-9]{6}$/);
  });

  test('findRoom: bad code / not found / ok / full', async (server) => {
    expect((await server.findRoom('he!!o')).reason).toBe('bad_code');
    expect((await server.findRoom('ABC123')).reason).toBe('not_found');
    expect((await server.findRoom(ROOM)).reason).toBe('not_found');
    await server.simulateJoin(ROOM, 'alice');
    const one = await server.findRoom(ROOM);
    expect(one.ok).toBe(true);
    expect(one.count).toBe(1);
    await server.simulateJoin(ROOM, 'bob');
    expect((await server.findRoom(ROOM)).count).toBe(2);
    await server.simulateJoin(ROOM, 'carol');
    await server.simulateJoin(ROOM, 'dave');
    expect((await server.findRoom(ROOM)).reason).toBe('full');
  });

  test('quickMatch joins the waiting room', async (server) => {
    await server.simulateJoin(ROOM, 'alice');
    const r = await server.quickMatch();
    expect(r.roomId).toBe(ROOM);
    expect(r.waiting).toBe(true);
  });
});

describe('room lifecycle', () => {
  test('four players get slots 0..3, fifth is spectator (-1)', async (server) => {
    for (const a of ['alice', 'bob', 'carol', 'dave', 'erin']) await server.simulateJoin(ROOM, a);
    server.connect({ account: 'alice', roomId: ROOM });
    expect((await server.hello('blue')).slot).toBe(0);
    server.connect({ account: 'bob', roomId: ROOM });
    expect((await server.hello('black')).slot).toBe(1);
    server.connect({ account: 'carol', roomId: ROOM });
    expect((await server.hello('pink')).slot).toBe(2);
    server.connect({ account: 'dave', roomId: ROOM });
    expect((await server.hello('yellow')).slot).toBe(3);
    server.connect({ account: 'erin', roomId: ROOM });
    const e = await server.hello('blue');
    expect(e.slot).toBe(-1);
    expect(Object.keys(e.players)).toHaveLength(4);
    expect(e.players.bob.max).toBe(130);
    expect(e.players.bob.hp).toBe(130);
  });

  test('three-player room: hits on two victims are judged separately', async (server) => {
    for (const a of ['alice', 'bob', 'carol']) await server.simulateJoin(ROOM, a);
    server.connect({ account: 'alice', roomId: ROOM });
    await server.hello('blue');
    expect((await server.startTest()).ok).toBe(true);
    spin(COUNTDOWN);
    server.connect({ account: 'bob', roomId: ROOM });
    await server.st(state([0, 0, 10], { s: [{ w: 'rifle', f: [0, 1, 10], e: [5, 1, 20], h: 0 }] }));
    server.connect({ account: 'carol', roomId: ROOM });
    await server.st(state([10, 0, 0], { s: [{ w: 'rifle', f: [10, 1, 0], e: [20, 1, 0], h: 0 }] }));
    server.connect({ account: 'alice', roomId: ROOM });
    const shots = [{ w: 'rifle', f: [0, 1, 0], e: [0, 1, 10], h: 1 }, { w: 'rifle', f: [0, 1, 0], e: [10, 1, 0], h: 1 }];
    await server.st(state([0, 0, 0], { s: shots, h: [{ v: 'bob', w: 'rifle', hd: 0, d: 10 }, { v: 'carol', w: 'rifle', hd: 1, d: 10 }] }));
    const p = await players(server);
    expect(p.bob.hp).toBe(88);
    expect(p.carol.hp).toBe(82);
  });

  test('leave frees the slot', async (server) => {
    await server.simulateJoin(ROOM, 'alice');
    await server.simulateJoin(ROOM, 'bob');
    await server.simulateLeave(ROOM, 'alice');
    await server.simulateJoin(ROOM, 'carol');
    server.connect({ account: 'carol', roomId: ROOM });
    expect((await server.hello('blue')).slot).toBe(0);
  });

  test('disconnect keeps the player during grace period', async (server) => {
    await server.simulateJoin(ROOM, 'alice');
    await server.simulateJoin(ROOM, 'bob');
    await server.simulateDisconnect(ROOM, 'bob');
    server.connect({ account: 'alice', roomId: ROOM });
    expect(Object.keys((await server.hello('blue')).players)).toHaveLength(2);
  });

  test('ping echoes client time', async (server) => {
    const r = await server.ping(1234);
    expect(r.t).toBe(1234);
    expect(r.s).toBeGreaterThan(0);
  });
});

describe('server-authoritative damage', () => {
  test('rifle body 12, head 18', async (server) => {
    await setupPair(server);
    await server.st(state([0, 0, 0], { s: [{ w: 'rifle', f: [0, 1, 0], e: [0, 1, 10], h: 1 }], h: [{ v: 'bob', w: 'rifle', hd: 0, d: 10 }] }));
    expect((await players(server)).bob.hp).toBe(88);
    await server.st(state([0, 0, 0], { s: [{ w: 'rifle', f: [0, 1, 0], e: [0, 1, 10], h: 1 }], h: [{ v: 'bob', w: 'rifle', hd: 1, d: 10 }] }));
    expect((await players(server)).bob.hp).toBe(70);
  });

  test('client-sent damage is ignored (server computes)', async (server) => {
    await setupPair(server);
    await server.st(state([0, 0, 0], { s: [{ w: 'rifle', f: [0, 1, 0], e: [0, 1, 10], h: 1 }], h: [{ v: 'bob', w: 'rifle', hd: 0, d: 10, dmg: 999 }] }));
    expect((await players(server)).bob.hp).toBe(88);
  });

  test('sniper headshot kills, k/d counted, then respawn after delay', async (server) => {
    await setupPair(server);
    await server.st(state([0, 0, 0], { w: 'sniper', s: [{ w: 'sniper', f: [0, 1, 0], e: [0, 1, 10], h: 1 }], h: [{ v: 'bob', w: 'sniper', hd: 1, d: 10 }] }));
    const p = await players(server);
    expect(p.bob.dead).toBe(true);
    expect(p.bob.hp).toBe(0);
    expect(p.bob.d).toBe(1);
    expect(p.alice.k).toBe(1);
    server.connect({ account: 'bob', roomId: ROOM });
    const early = await server.respawn();
    expect(early.ok).toBe(false);
    expect(early.wait).toBeGreaterThan(1000);
    spin(2500);
    const ok = await server.respawn();
    expect(ok.ok).toBe(true);
    expect(ok.hp).toBe(100);
  });

  test('shotgun falloff: 15 → 7.5 at 7m', async (server) => {
    await setupPair(server);
    await server.st(state([0, 0, 3], { w: 'shotgun', s: [{ w: 'shotgun', f: [0, 1, 3], e: [0, 1, 10], h: 1 }], h: [{ v: 'bob', w: 'shotgun', hd: 0, d: 7 }] }));
    expect((await players(server)).bob.hp).toBe(92.5);
  });

  test('rejects distance mismatch and out of range', async (server) => {
    await setupPair(server);
    // bob은 10m 앞인데 1m라고 주장
    await server.st(state([0, 0, 0], { w: 'shotgun', s: [{ w: 'shotgun', f: [0, 1, 0], e: [0, 1, 1], h: 1 }], h: [{ v: 'bob', w: 'shotgun', hd: 0, d: 1 }] }));
    expect((await players(server)).bob.hp).toBe(100);
    // 근접(사거리 1.6m)으로 10m
    await server.st(state([0, 0, 0], { w: 'melee', s: [{ w: 'melee', f: [0, 1, 0], e: [0, 1, 10], h: 1 }], h: [{ v: 'bob', w: 'melee', hd: 0, d: 10 }] }));
    expect((await players(server)).bob.hp).toBe(100);
  });

  test('rejects hits without matching shots and beyond fire rate', async (server) => {
    await setupPair(server);
    await server.st(state([0, 0, 0], { h: [{ v: 'bob', w: 'rifle', hd: 0, d: 10 }] }));
    expect((await players(server)).bob.hp).toBe(100);
    // 한 패킷에 라이플 10발 몰아넣기 → 순간 허용 3발만
    const shots = Array.from({ length: 10 }, () => ({ w: 'rifle', f: [0, 1, 0], e: [0, 1, 10], h: 1 }));
    const hits = Array.from({ length: 10 }, () => ({ v: 'bob', w: 'rifle', hd: 0, d: 10 }));
    await server.st(state([0, 0, 0], { s: shots, h: hits }));
    expect((await players(server)).bob.hp).toBe(64);
  });

  test('during countdown and right after respawn (2s protection) no damage', async (server) => {
    await server.simulateJoin(ROOM, 'alice');
    await server.simulateJoin(ROOM, 'bob');
    server.connect({ account: 'bob', roomId: ROOM });
    await server.st(state([0, 0, 10]));
    server.connect({ account: 'alice', roomId: ROOM });
    await server.startTest();
    // 카운트다운 중
    await server.st(state([0, 0, 0], { s: [{ w: 'rifle', f: [0, 1, 0], e: [0, 1, 10], h: 1 }], h: [{ v: 'bob', w: 'rifle', hd: 0, d: 10 }] }));
    expect((await players(server)).bob.hp).toBe(100);
    spin(COUNTDOWN);
    await server.st(state([0, 0, 0], { w: 'sniper', s: [{ w: 'sniper', f: [0, 1, 0], e: [0, 1, 10], h: 1 }], h: [{ v: 'bob', w: 'sniper', hd: 1, d: 10 }] }));
    expect((await players(server)).bob.dead).toBe(true);
    spin(2600);
    server.connect({ account: 'bob', roomId: ROOM });
    expect((await server.respawn()).ok).toBe(true);
    server.connect({ account: 'alice', roomId: ROOM });
    await server.st(state([0, 0, 0], { s: [{ w: 'rifle', f: [0, 1, 0], e: [0, 1, 10], h: 1 }], h: [{ v: 'bob', w: 'rifle', hd: 0, d: 10 }] }));
    expect((await players(server)).bob.hp).toBe(100);
  });

  test('respawn response carries the authoritative protection end; damage blocked until it, applied right after', async (server) => {
    await setupPair(server);
    await server.st(state([0, 0, 0], { w: 'sniper', s: [{ w: 'sniper', f: [0, 1, 0], e: [0, 1, 10], h: 1 }], h: [{ v: 'bob', w: 'sniper', hd: 1, d: 10 }] }));
    expect((await players(server)).bob.dead).toBe(true);
    spin(2600);
    server.connect({ account: 'bob', roomId: ROOM });
    const before = Date.now();
    const res = await server.respawn();
    const after = Date.now();
    expect(res.ok).toBe(true);
    // 응답의 prot = 룸 기록 prot = 승인 시각 + 2000ms (클라이언트 보호 방울이 이 시각에 끝남)
    expect(typeof res.prot).toBe('number');
    expect(res.prot).toBe((await players(server)).bob.prot);
    expect(res.prot).toBeGreaterThanOrEqual(before + 2000);
    expect(res.prot).toBeLessThanOrEqual(after + 2000);
    // 이미 살아 있으면 지금 기록 그대로 (players()가 alice로 바꿔 접속하므로 다시 bob)
    server.connect({ account: 'bob', roomId: ROOM });
    expect((await server.respawn()).prot).toBe(res.prot);
    // 보호 중: 피해 없음
    server.connect({ account: 'alice', roomId: ROOM });
    await server.st(state([0, 0, 0], { s: [{ w: 'rifle', f: [0, 1, 0], e: [0, 1, 10], h: 1 }], h: [{ v: 'bob', w: 'rifle', hd: 0, d: 10 }] }));
    expect((await players(server)).bob.hp).toBe(100);
    // 보호 끝 직후: 바로 피해
    while (Date.now() <= res.prot) spin(5);
    await server.st(state([0, 0, 0], { s: [{ w: 'rifle', f: [0, 1, 0], e: [0, 1, 10], h: 1 }], h: [{ v: 'bob', w: 'rifle', hd: 0, d: 10 }] }));
    expect((await players(server)).bob.hp).toBe(88);
  });

  test('dead attacker cannot damage; self fall death respawns at once', async (server) => {
    await setupPair(server);
    expect((await server.selfDeath('fall')).ok).toBe(true);
    await server.st(state([0, 0, 0], { s: [{ w: 'rifle', f: [0, 1, 0], e: [0, 1, 10], h: 1 }], h: [{ v: 'bob', w: 'rifle', hd: 0, d: 10 }] }));
    const p = await players(server);
    expect(p.bob.hp).toBe(100);
    expect(p.alice.d).toBe(1);
    server.connect({ account: 'alice', roomId: ROOM });
    expect((await server.respawn()).ok).toBe(true);
  });

  test('state outside room is ignored', async (server) => {
    server.connect({ account: 'alice', roomId: '__no_room__' });
    await server.st(state([0, 0, 0]));
    expect((await server.selfDeath('fall')).ok).toBe(false);
  });
});

describe('test room flow', () => {
  test('host (first joiner) starts with 2+ players; guest cannot', async (server) => {
    await server.simulateJoin(ROOM, 'alice');
    server.connect({ account: 'alice', roomId: ROOM });
    const h = await server.hello('blue');
    expect(h.host).toBe('alice');
    expect(h.phase).toBe('lobby');
    expect((await server.startTest()).reason).toBe('need_2_players');
    await server.simulateJoin(ROOM, 'bob');
    server.connect({ account: 'bob', roomId: ROOM });
    expect((await server.startTest()).reason).toBe('not_host');
    server.connect({ account: 'alice', roomId: ROOM });
    expect((await server.startTest()).ok).toBe(true);
    const after = await server.hello('blue');
    expect(after.phase).toBe('countdown');
    expect(after.startAt).toBeGreaterThan(Date.now());
    expect(after.endAt).toBe(0);
    // 카운트다운이 지나면 틱이 playing으로
    spin(COUNTDOWN);
    await server.simulateTick(ROOM, 200);
    expect((await server.hello('blue')).phase).toBe('playing');
  });

  test('no damage before start (lobby)', async (server) => {
    await server.simulateJoin(ROOM, 'alice');
    await server.simulateJoin(ROOM, 'bob');
    server.connect({ account: 'bob', roomId: ROOM });
    await server.st(state([0, 0, 10]));
    server.connect({ account: 'alice', roomId: ROOM });
    await server.st(state([0, 0, 0], { s: [{ w: 'rifle', f: [0, 1, 0], e: [0, 1, 10], h: 1 }], h: [{ v: 'bob', w: 'rifle', hd: 0, d: 10 }] }));
    expect((await players(server)).bob.hp).toBe(100);
  });

  test('bye removes at once, hands host over, frees the slot for findRoom', async (server) => {
    await server.simulateJoin(ROOM, 'alice');
    await server.simulateJoin(ROOM, 'bob');
    expect((await server.findRoom(ROOM)).count).toBe(2);
    server.connect({ account: 'alice', roomId: ROOM });
    expect((await server.bye()).ok).toBe(true);
    server.connect({ account: 'bob', roomId: ROOM });
    const h = await server.hello('blue');
    expect(Object.keys(h.players)).toEqual(['bob']);
    expect(h.host).toBe('bob');
    const f = await server.findRoom('PB-TEST01'.replace('PB-', ''));
    expect(f.ok).toBe(true);
    expect(f.count).toBe(1);
  });

  test('room summary is cleared when the room is destroyed', async (server) => {
    await server.simulateJoin(ROOM, 'alice');
    expect((await server.findRoom(ROOM)).ok).toBe(true);
    await server.simulateLeave(ROOM, 'alice');
    expect((await server.findRoom(ROOM)).reason).toBe('not_found');
  });

  test('rejoin during grace (no new onRoomJoin) gets a slot again via hello', async (server) => {
    await server.simulateJoin(ROOM, 'alice');
    await server.simulateJoin(ROOM, 'bob');
    server.connect({ account: 'bob', roomId: ROOM });
    await server.bye();
    // 같은 계정이 유예 중 재입장: 훅 없이 hello만
    const h = await server.hello('pink');
    expect(h.slot).toBe(1);
    expect(h.players.bob.max).toBe(115);
    expect(h.host).toBe('alice');
  });

  test('fifth account cannot take a slot through hello', async (server) => {
    for (const a of ['alice', 'bob', 'carol', 'dave']) await server.simulateJoin(ROOM, a);
    server.connect({ account: 'erin', roomId: ROOM });
    expect((await server.hello('blue')).slot).toBe(-1);
  });
});

// ---------------- 게임 모드 (TDM 2v2 / FFA 4인) ----------------

const POS: Record<string, [number, number, number]> = { alice: [0, 0, 0], bob: [2, 0, 0], carol: [0, 0, 2], dave: [2, 0, 2] };

/** 4명 입장·위치 등록 후 방장(alice)이 모드 지정 */
async function room4(server: any, mode: string) {
  for (const a of ['alice', 'bob', 'carol', 'dave']) await server.simulateJoin(ROOM, a);
  for (const a of ['alice', 'bob', 'carol', 'dave']) {
    server.connect({ account: a, roomId: ROOM });
    await server.hello('blue');
    await server.st(state(POS[a]!));
  }
  server.connect({ account: 'alice', roomId: ROOM });
  return server.setMode(mode);
}

function dist2(a: string, b: string): number {
  const p = POS[a]!;
  const q = POS[b]!;
  return Math.round(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) * 100) / 100;
}

/** 샷건 한 번(펠릿 8발 × 15 = 120)으로 처치 (모두 BLUE 100HP) */
async function shotgunKill(server: any, att: string, vic: string) {
  server.connect({ account: att, roomId: ROOM });
  const p = POS[att]!;
  const q = POS[vic]!;
  const s = Array.from({ length: 8 }, () => ({ w: 'shotgun', f: [p[0], 1, p[2]], e: [q[0], 1, q[2]], h: 1 }));
  const h = Array.from({ length: 8 }, () => ({ v: vic, w: 'shotgun', hd: 0, d: dist2(att, vic) }));
  await server.st(state(p, { w: 'shotgun', s, h }));
}

/** 죽은 사람들 리스폰 + 빗나간 한 발로 리스폰 보호 해제 */
async function respawnAll(server: any, who: string[]) {
  spin(2600);
  for (const a of who) {
    server.connect({ account: a, roomId: ROOM });
    expect((await server.respawn()).ok).toBe(true);
    const p = POS[a]!;
    await server.st(state(p, { s: [{ w: 'rifle', f: [p[0], 1, p[2]], e: [p[0] + 5, 1, p[2] + 30], h: 0 }] }));
  }
}

async function roomState(server: any) {
  server.connect({ account: 'alice', roomId: ROOM });
  return server.hello('blue');
}

describe('team deathmatch', () => {
  test('teams 2/2, start rules, no team switch into a full team', async (server) => {
    for (const a of ['alice', 'bob', 'carol']) await server.simulateJoin(ROOM, a);
    server.connect({ account: 'alice', roomId: ROOM });
    expect((await server.setMode('tdm')).ok).toBe(true);
    expect((await server.startMatch()).reason).toBe('need_4_players');
    await server.simulateJoin(ROOM, 'dave');
    const r = await roomState(server);
    expect(r.mode).toBe('tdm');
    expect(r.players.alice.team).toBe('BLUE');
    expect(r.players.bob.team).toBe('RED');
    expect(r.players.carol.team).toBe('BLUE');
    expect(r.players.dave.team).toBe('RED');
    expect((await server.switchTeam()).reason).toBe('team_full');
    server.connect({ account: 'bob', roomId: ROOM });
    expect((await server.setMode('ffa')).reason).toBe('not_host');
  });

  test('friendly fire blocked, team score, 20 team kills ends with BLUE win; then back to lobby', async (server) => {
    expect((await room4(server, 'tdm')).ok).toBe(true);
    expect((await server.startMatch()).ok).toBe(true);
    const c = await roomState(server);
    expect(c.phase).toBe('countdown');
    expect(c.endAt - c.startAt).toBe(180000);
    spin(COUNTDOWN);
    // 아군(carol) 공격 → 거부
    server.connect({ account: 'alice', roomId: ROOM });
    await server.st(state(POS.alice!, { s: [{ w: 'rifle', f: [0, 1, 0], e: [0, 1, 2], h: 1 }], h: [{ v: 'carol', w: 'rifle', hd: 0, d: 2 }] }));
    expect((await roomState(server)).players.carol.hp).toBe(100);
    for (let round = 0; round < 10; round++) {
      await shotgunKill(server, 'alice', 'bob');
      await shotgunKill(server, 'carol', 'dave');
      const st = await roomState(server);
      expect(st.teamScore.BLUE).toBe((round + 1) * 2);
      if (round < 9) {
        expect(st.phase === 'result').toBe(false);
        await respawnAll(server, ['bob', 'dave']);
      }
    }
    const end = await roomState(server);
    expect(end.phase).toBe('result');
    expect(end.result.mode).toBe('tdm');
    expect(end.result.reason).toBe('score');
    expect(end.result.winnerTeam).toBe('BLUE');
    expect(end.result.draw).toBe(false);
    expect(end.result.teamScore).toEqual({ BLUE: 20, RED: 0 });
    expect(end.result.winners.sort()).toEqual(['alice', 'carol']);
    expect(end.players.alice.k).toBe(10);
    expect(end.players.bob.d).toBe(10);
    // 결과 뒤에는 피해 없음
    await respawnAll(server, ['bob']);
    await shotgunKill(server, 'alice', 'bob');
    expect((await roomState(server)).players.bob.hp).toBe(100);
    expect((await server.toLobby()).ok).toBe(true);
    expect((await roomState(server)).phase).toBe('lobby');
  });
});

describe('free for all', () => {
  test('15 kills ends; leaver kept in result; joining mid-match blocked', async (server) => {
    expect((await room4(server, 'ffa')).ok).toBe(true);
    const r = await roomState(server);
    expect(r.players.bob.team).toBe(null);
    expect((await server.startMatch()).ok).toBe(true);
    spin(COUNTDOWN);
    let kills = 0;
    // 1라운드: 3명 처치 후 dave 퇴장 (킬·데스 보존)
    for (const v of ['bob', 'carol', 'dave']) await shotgunKill(server, 'alice', v);
    kills += 3;
    server.connect({ account: 'dave', roomId: ROOM });
    expect((await server.bye()).ok).toBe(true);
    // 진행 중 매치: 새 계정은 거부 (나간 dave 자신은 돌아올 수 있음 — reconnection 테스트)
    server.connect({ account: 'erin', roomId: '__no_room__' });
    expect((await server.findRoom(ROOM)).reason).toBe('in_progress');
    while (kills < 15) {
      await respawnAll(server, ['bob', 'carol']);
      for (const v of ['bob', 'carol']) {
        if (kills >= 15) break;
        await shotgunKill(server, 'alice', v);
        kills++;
      }
    }
    const end = await roomState(server);
    expect(end.phase).toBe('result');
    expect(end.result.mode).toBe('ffa');
    expect(end.result.winners).toEqual(['alice']);
    expect(end.result.draw).toBe(false);
    expect(end.result.standings[0].account).toBe('alice');
    expect(end.result.standings[0].k).toBe(15);
    const dave = end.result.standings.find((s: any) => s.account === 'dave');
    expect(dave.left).toBe(true);
    expect(dave.d).toBe(1);
  });

  test('self death counts a death only, no kill or score', async (server) => {
    expect((await room4(server, 'ffa')).ok).toBe(true);
    await server.startMatch();
    spin(COUNTDOWN);
    server.connect({ account: 'bob', roomId: ROOM });
    expect((await server.selfDeath('fall')).ok).toBe(true);
    const st = await roomState(server);
    expect(st.players.bob.d).toBe(1);
    expect(Object.values(st.players).reduce((n: number, p: any) => n + p.k, 0)).toBe(0);
  });
});

describe('match timer and reconnection', () => {
  test('test time limit outside 20..180 s falls back to the 3 min rule', async (server) => {
    expect((await room4(server, 'tdm')).ok).toBe(true);
    expect((await server.startMatch({ timeLimitSec: 5 })).ok).toBe(true);
    const r = await roomState(server);
    expect(r.timeLimitMs).toBe(180000);
    expect(r.endAt - r.startAt).toBe(180000);
  });

  test('TDM time up at 20 s: tie → DRAW, players can no longer be damaged', async (server) => {
    expect((await room4(server, 'tdm')).ok).toBe(true);
    expect((await server.startMatch({ timeLimitSec: 20 })).ok).toBe(true);
    const r = await roomState(server);
    expect(r.timeLimitMs).toBe(20000);
    expect(r.endAt - r.startAt).toBe(20000);
    spin(r.endAt - Date.now() + 50);
    await server.simulateTick(ROOM, 200);
    const end = await roomState(server);
    expect(end.phase).toBe('result');
    expect(end.result.reason).toBe('time');
    expect(end.result.draw).toBe(true);
    expect(end.result.winnerTeam).toBe(null);
  });

  test('FFA time up with tied leaders → DRAW, winners are both leaders', async (server) => {
    expect((await room4(server, 'ffa')).ok).toBe(true);
    expect((await server.startMatch({ timeLimitSec: 20 })).ok).toBe(true);
    spin(COUNTDOWN);
    await shotgunKill(server, 'alice', 'bob');
    await shotgunKill(server, 'carol', 'dave');
    const r = await roomState(server);
    spin(r.endAt - Date.now() + 50);
    await server.simulateTick(ROOM, 200);
    const end = await roomState(server);
    expect(end.result.reason).toBe('time');
    expect(end.result.draw).toBe(true);
    expect(end.result.winners.sort()).toEqual(['alice', 'carol']);
  });

  test('same account returns into a running TDM after leaving (refresh): slot, team, K/D restored; others still blocked', async (server) => {
    expect((await room4(server, 'tdm')).ok).toBe(true);
    await server.startMatch();
    spin(COUNTDOWN);
    await shotgunKill(server, 'alice', 'bob');
    // bob 새로고침 → 즉시 퇴장
    await server.simulateLeave(ROOM, 'bob');
    let r = await roomState(server);
    expect(r.players.bob).toBe(undefined);
    expect(r.gone.bob.d).toBe(1);
    // 같은 계정은 찾기 허용, 다른 계정은 진행 중이라 거부
    server.connect({ account: 'bob', roomId: '__no_room__' });
    expect((await server.findRoom(ROOM)).ok).toBe(true);
    server.connect({ account: 'erin', roomId: '__no_room__' });
    expect((await server.findRoom(ROOM)).reason).toBe('in_progress');
    await server.simulateJoin(ROOM, 'bob');
    r = await roomState(server);
    expect(r.players.bob.slot).toBe(1);
    expect(r.players.bob.team).toBe('RED');
    expect(r.players.bob.d).toBe(1);
    expect(r.gone.bob).toBe(undefined);
    expect(r.teamScore.BLUE).toBe(1);
  });

  test('short drop in a full room: the dropped account (still in the 30 s grace) can find the room, others get full', async (server) => {
    expect((await room4(server, 'tdm')).ok).toBe(true);
    await server.startMatch();
    spin(COUNTDOWN);
    // 끊김 유예 중: 서버 기록에는 아직 4명
    server.connect({ account: 'carol', roomId: '__no_room__' });
    const f = await server.findRoom(ROOM);
    expect(f.ok).toBe(true);
    expect(f.count).toBe(4);
    server.connect({ account: 'erin', roomId: '__no_room__' });
    expect((await server.findRoom(ROOM)).reason).toBe('full');
  });

  test('Leave Room (quit) blocks this match only; refresh-style bye still returns; next match accepts the quitter', async (server) => {
    expect((await room4(server, 'tdm')).ok).toBe(true);
    expect((await server.startMatch({ timeLimitSec: 20 })).ok).toBe(true);
    spin(COUNTDOWN);
    // carol: Leave Room 버튼 / dave: 새로고침 (pagehide → bye)
    server.connect({ account: 'carol', roomId: ROOM });
    expect((await server.bye({ quit: true })).ok).toBe(true);
    await server.simulateLeave(ROOM, 'carol');
    server.connect({ account: 'dave', roomId: ROOM });
    expect((await server.bye()).ok).toBe(true);
    await server.simulateLeave(ROOM, 'dave');
    let r = await roomState(server);
    expect(r.gone.carol.quit).toBe(true);
    expect(r.gone.dave.quit).toBe(false);
    server.connect({ account: 'carol', roomId: '__no_room__' });
    expect((await server.findRoom(ROOM)).reason).toBe('left_match');
    server.connect({ account: 'carol', roomId: ROOM });
    const h = await server.hello('blue');
    expect(h.slot).toBe(-1);
    expect(h.reason).toBe('left_match');
    server.connect({ account: 'dave', roomId: '__no_room__' });
    expect((await server.findRoom(ROOM)).ok).toBe(true);
    await server.simulateJoin(ROOM, 'dave');
    r = await roomState(server);
    expect(r.players.dave.team).toBe('RED');
    expect(r.players.carol).toBe(undefined);
    // 2v1 + 복귀한 dave = BLUE 1 : RED 2 → 매치는 그대로 진행, 시간 종료로 끝남
    await server.simulateTick(ROOM, 200);
    r = await roomState(server);
    expect(r.phase).toBe('playing');
    spin(r.endAt - Date.now() + 50);
    await server.simulateTick(ROOM, 200);
    r = await roomState(server);
    expect(r.phase).toBe('result');
    expect(r.result.standings.find((s: any) => s.account === 'carol').left).toBe(true);
    // 다음 매치: 대기실로 → carol 다시 입장 가능
    expect((await server.toLobby()).ok).toBe(true);
    server.connect({ account: 'carol', roomId: '__no_room__' });
    expect((await server.findRoom(ROOM)).ok).toBe(true);
    await server.simulateJoin(ROOM, 'carol');
    r = await roomState(server);
    expect(r.players.carol.team).toBe('BLUE');
    expect(Object.keys(r.players).length).toBe(4);
  });

  test('returning player keeps the original team, character, K/D and HP (dead on leave → full HP)', async (server) => {
    expect((await room4(server, 'tdm')).ok).toBe(true);
    server.connect({ account: 'bob', roomId: ROOM });
    await server.hello('red');
    server.connect({ account: 'alice', roomId: ROOM });
    expect((await server.startMatch()).ok).toBe(true);
    spin(COUNTDOWN);
    // alice(BLUE) → bob(RED) 라이플 1발 (12)
    server.connect({ account: 'alice', roomId: ROOM });
    await server.st(state(POS.alice!, { s: [{ w: 'rifle', f: [0, 1, 0], e: [2, 1, 0], h: 1 }], h: [{ v: 'bob', w: 'rifle', hd: 0, d: dist2('alice', 'bob') }] }));
    let r = await roomState(server);
    const hurt = r.players.bob.hp;
    expect(hurt).toBe(r.players.bob.max - 12);
    server.connect({ account: 'bob', roomId: ROOM });
    await server.bye();
    await server.simulateLeave(ROOM, 'bob');
    await server.simulateJoin(ROOM, 'bob');
    r = await roomState(server);
    expect(r.players.bob.team).toBe('RED');
    expect(r.players.bob.char).toBe('red');
    expect(r.players.bob.hp).toBe(hurt);
    expect(r.players.bob.slot).toBe(1);
    // 쓰러진 채 나갔다 오면 가득 찬 체력, 데스는 그대로
    await shotgunKill(server, 'carol', 'dave');
    server.connect({ account: 'dave', roomId: ROOM });
    await server.bye();
    await server.simulateLeave(ROOM, 'dave');
    await server.simulateJoin(ROOM, 'dave');
    r = await roomState(server);
    expect(r.players.dave.dead).toBe(false);
    expect(r.players.dave.hp).toBe(r.players.dave.max);
    expect(r.players.dave.d).toBe(1);
    expect(r.players.dave.team).toBe('RED');
    expect(r.teamScore.BLUE).toBe(1);
  });

  test('joining again while still in the room (grace) keeps one record, no duplicate slot', async (server) => {
    expect((await room4(server, 'ffa')).ok).toBe(true);
    expect((await server.startMatch()).ok).toBe(true);
    await server.simulateJoin(ROOM, 'bob');
    server.connect({ account: 'bob', roomId: ROOM });
    const h = await server.hello('blue');
    expect(h.slot).toBe(1);
    const slots = Object.values(h.players).map((p: any) => p.slot).sort();
    expect(slots).toEqual([0, 1, 2, 3]);
  });
});

// ---------------- 온라인 로비 (lb- 룸) · 방 목록 · 닉네임 ----------------

const HUB = 'lb-1';

/** 로비 위치 패킷: [순번, 시각, x, y, z, 방향, vx, vy, vz, 모드, 비트] */
function hubPkt(q: number, x: number, y: number, z: number): number[] {
  return [q, q * 125, x, y, z, 0, 0, 0, 0, 0, 1];
}

/** 로비에 들어와 hubHello까지 한 계정들 */
async function fillHub(server: any, roomId: string, accounts: string[]): Promise<void> {
  for (const a of accounts) {
    await server.simulateJoin(roomId, a);
    server.connect({ account: a, roomId });
    expect((await server.hubHello({ c: 'blue', n: 'P' + a })).ok).toBe(true);
  }
}

async function hubUser(server: any, account: string): Promise<any> {
  server.connect({ account, roomId: HUB });
  const st = await server.hubState();
  return st.users.find((u: any) => u.account === account);
}

describe('online lobby (hub)', () => {
  test('hubFind: same lobby for the same account, 8 per lobby, 9th goes to lb-2', async (server) => {
    const accs = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8'];
    for (const a of accs) {
      server.connect({ account: a, roomId: '__no_room__' });
      expect((await server.hubFind()).roomId).toBe('lb-1');
    }
    // 같은 계정이 다시 찾으면 같은 로비 (중복 입장·재접속)
    server.connect({ account: 'h3', roomId: '__no_room__' });
    expect((await server.hubFind()).roomId).toBe('lb-1');
    server.connect({ account: 'h9', roomId: '__no_room__' });
    expect((await server.hubFind()).roomId).toBe('lb-2');
  });

  test('hubFind counts users who said hubHello; same account stays in its lobby', async (server) => {
    await fillHub(server, HUB, ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']);
    server.connect({ account: 'r9', roomId: '__no_room__' });
    expect((await server.hubFind()).roomId).toBe('lb-2');
    // 이미 lb-1에 있는 계정은 그대로 lb-1
    server.connect({ account: 'r2', roomId: '__no_room__' });
    expect((await server.hubFind()).roomId).toBe('lb-1');
  });

  test('normal leave (hubBye) frees the seat at once even while the SDK still lists the user', async (server) => {
    await fillHub(server, HUB, ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8']);
    server.connect({ account: 'q3', roomId: HUB });
    expect((await server.hubBye()).ok).toBe(true);
    // q3는 하네스 룸 사용자 목록에 그대로 (실서버의 30초 유예와 같은 상황)
    server.connect({ account: 'new1', roomId: '__no_room__' });
    expect((await server.hubFind()).roomId).toBe('lb-1');
    await server.simulateJoin(HUB, 'new1');
    server.connect({ account: 'new1', roomId: HUB });
    const h = await server.hubHello({ c: 'blue', n: 'New' });
    expect(h.ok).toBe(true);
    expect(h.count).toBe(8);
  });

  test('leave through onRoomLeave also frees the seat; a 9th reservation is not counted as a member', async (server) => {
    await fillHub(server, HUB, ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8']);
    await server.simulateLeave(HUB, 'l5');
    server.connect({ account: 'l9', roomId: '__no_room__' });
    expect((await server.hubFind()).roomId).toBe('lb-1');
    // 예약만 한 사람은 실제 접속 인원(count)에 들어가지 않음
    server.connect({ account: 'l1', roomId: HUB });
    expect((await server.hubHello({ c: 'blue', n: 'One' })).count).toBe(7);
  });

  test('disconnect keeps the seat for reconnect (grace), the same account gets the same lobby; leave after grace frees it', async (server) => {
    await fillHub(server, HUB, ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8']);
    await server.simulateDisconnect(HUB, 'g4');
    // 재접속 대기 자리는 정원에 들어감 → 다른 사람은 lb-2
    server.connect({ account: 'other', roomId: '__no_room__' });
    expect((await server.hubFind()).roomId).toBe('lb-2');
    // 같은 계정은 같은 로비로 돌아옴, 다시 hubHello 하면 실제 접속으로
    server.connect({ account: 'g4', roomId: '__no_room__' });
    expect((await server.hubFind()).roomId).toBe('lb-1');
    server.connect({ account: 'g4', roomId: HUB });
    const back = await server.hubHello({ c: 'red', n: 'Back' });
    expect(back.ok).toBe(true);
    expect(back.count).toBe(8);
    // 다시 끊겼다가 유예가 끝나면(onRoomLeave) 자리 반환
    await server.simulateDisconnect(HUB, 'g4');
    await server.simulateLeave(HUB, 'g4');
    server.connect({ account: 'later', roomId: '__no_room__' });
    expect((await server.hubFind()).roomId).toBe('lb-1');
  });

  test('20 reservations in a row (as $lock serializes concurrent calls) never put more than 8 seats in one lobby', async (server) => {
    // 하네스의 $lock은 동시 호출 대기를 지원하지 않아(대기 중 멈춤) 실서버의 직렬화 결과와 같은 순차 호출로 검사
    const count: Record<string, number> = {};
    for (let i = 0; i < 20; i++) {
      server.connect({ account: `c${i}`, roomId: '__no_room__' });
      const id = (await server.hubFind()).roomId as string;
      count[id] = (count[id] ?? 0) + 1;
    }
    expect(count['lb-1']).toBe(8);
    expect(count['lb-2']).toBe(8);
    expect(count['lb-3']).toBe(4);
  });

  test('one account in two lobbies (duplicate session) keeps only the newest seat', async (server) => {
    await fillHub(server, HUB, ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'dup']);
    await server.simulateJoin('lb-2', 'dup');
    server.connect({ account: 'dup', roomId: 'lb-2' });
    expect((await server.hubHello({ c: 'blue', n: 'Dup' })).ok).toBe(true);
    server.connect({ account: 'fresh', roomId: '__no_room__' });
    expect((await server.hubFind()).roomId).toBe('lb-1');
  });

  test('empty lobby destroy clears its seats', async (server) => {
    await fillHub(server, 'lb-3', ['e1']);
    await server.simulateLeave('lb-3', 'e1');
    server.connect({ account: 'e2', roomId: '__no_room__' });
    expect((await server.hubFind()).roomId).toBe('lb-1');
  });

  test('lobby weapon: primary id stored and synced, invalid or side weapons fall back to rifle', async (server) => {
    await server.simulateJoin(HUB, 'w1');
    server.connect({ account: 'w1', roomId: HUB });
    await server.hubHello({ c: 'blue', n: 'Gun', w: 'shotgun' });
    expect((await hubUser(server, 'w1')).w).toBe('shotgun');
    server.connect({ account: 'w1', roomId: HUB });
    expect((await server.hubInfo({ w: 'sniper' })).ok).toBe(true);
    expect((await hubUser(server, 'w1')).w).toBe('sniper');
    server.connect({ account: 'w1', roomId: HUB });
    await server.hubInfo({ w: 'pistol' });
    expect((await hubUser(server, 'w1')).w).toBe('rifle');
    server.connect({ account: 'w1', roomId: HUB });
    await server.hubInfo({ w: '<img>' });
    expect((await hubUser(server, 'w1')).w).toBe('rifle');
  });

  test('hubHello: character id checked, nickname sanitized, spawn state stored', async (server) => {
    await server.simulateJoin(HUB, 'alice');
    server.connect({ account: 'alice', roomId: HUB });
    expect((await server.hubHello({ c: 'nope', n: 'Alice' })).reason).toBe('bad_char');
    const ok = await server.hubHello({ c: 'pink', n: '  앨리스  짱 ' });
    expect(ok.ok).toBe(true);
    const u = await hubUser(server, 'alice');
    expect(u.c).toBe('pink');
    expect(u.n).toBe('앨리스 짱');
    expect(u.p[2]).toBe(0);
    expect(u.p[3]).toBe(36);
    // HTML·제어 문자·너무 긴 이름은 저장하지 않음
    server.connect({ account: 'alice', roomId: HUB });
    expect((await server.hubInfo({ n: '<b>x</b>' })).reason).toBe('bad_nick');
    expect((await server.hubInfo({ n: 'abc' + String.fromCharCode(7) + 'def' })).reason).toBe('bad_nick');
    expect((await server.hubInfo({ n: 'a'.repeat(13) })).reason).toBe('bad_nick');
    expect((await server.hubInfo({ c: 'black' })).ok).toBe(true);
    expect((await hubUser(server, 'alice')).c).toBe('black');
  });

  test('hubHello rejects the 9th user in one lobby; a member saying hello again is not rejected', async (server) => {
    await fillHub(server, HUB, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']);
    await server.simulateJoin(HUB, 'a9');
    server.connect({ account: 'a9', roomId: HUB });
    expect((await server.hubHello({ c: 'blue', n: 'nine' })).reason).toBe('full');
    server.connect({ account: 'a2', roomId: HUB });
    expect((await server.hubHello({ c: 'blue', n: 'two' })).ok).toBe(true);
  });

  test('hubMove: normal moves accepted; too fast, too frequent, out of bounds rejected; return to spawn allowed', async (server) => {
    await server.simulateJoin(HUB, 'bob');
    server.connect({ account: 'bob', roomId: HUB });
    await server.hubHello({ c: 'blue', n: 'Bob' });
    spin(80);
    await server.hubMove(hubPkt(1, 0, 36, 4));
    expect((await hubUser(server, 'bob')).p[4]).toBe(4);
    // 바로 다시 보내면(최소 간격 안) 버림
    server.connect({ account: 'bob', roomId: HUB });
    await server.hubMove(hubPkt(2, 0, 36, 3.9));
    expect((await hubUser(server, 'bob')).p[4]).toBe(4);
    // 0.1초에 20m = 순간이동 → 버림
    spin(100);
    server.connect({ account: 'bob', roomId: HUB });
    await server.hubMove(hubPkt(3, 0, 36, -16));
    expect((await hubUser(server, 'bob')).p[4]).toBe(4);
    // 정상 속도 (0.1초에 0.8m, 점프 높이)
    spin(100);
    server.connect({ account: 'bob', roomId: HUB });
    await server.hubMove(hubPkt(4, 0, 37, 3.2));
    expect((await hubUser(server, 'bob')).p[4]).toBe(3.2);
    // 로비 밖 좌표 → 버림
    spin(100);
    server.connect({ account: 'bob', roomId: HUB });
    await server.hubMove(hubPkt(5, 80, 36, 0));
    expect((await hubUser(server, 'bob')).p[2]).toBe(0);
    // 높은 곳에서 시작 지점으로 복귀 (R·낙하) → 허용
    spin(100);
    server.connect({ account: 'bob', roomId: HUB });
    await server.hubMove(hubPkt(6, 0, 36, 5));
    expect((await hubUser(server, 'bob')).p[4]).toBe(5);
    // 잘못된 형식
    spin(100);
    server.connect({ account: 'bob', roomId: HUB });
    await server.hubMove([1, 2, 3]);
    await server.hubMove(['a', 1, 0, 36, 0, 0, 0, 0, 0, 0, 1]);
    expect((await hubUser(server, 'bob')).p[4]).toBe(5);
  });

  test('match functions are rejected inside a lobby room', async (server) => {
    await server.simulateJoin(HUB, 'carol');
    server.connect({ account: 'carol', roomId: HUB });
    let threw = false;
    try {
      await server.hello('blue');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect((await server.startMatch()).reason).toBe('not_in_room');
    expect((await server.setMode('tdm')).reason).toBe('not_in_room');
    expect((await server.selfDeath('fall')).ok).toBe(false);
    expect((await server.respawn()).ok).toBe(false);
    expect((await server.bye()).ok).toBe(false);
  });

  test('lobby functions are rejected inside a match room', async (server) => {
    await server.simulateJoin(ROOM, 'dave');
    server.connect({ account: 'dave', roomId: ROOM });
    expect((await server.hubHello({ c: 'blue' })).reason).toBe('not_in_hub');
    expect((await server.hubState()).ok).toBe(false);
  });

  test('disconnect hides the user (x = 1); next move shows again; hubBye hides at once', async (server) => {
    await server.simulateJoin(HUB, 'erin');
    await server.simulateJoin(HUB, 'finn');
    server.connect({ account: 'erin', roomId: HUB });
    await server.hubHello({ c: 'yellow', n: 'Erin' });
    await server.simulateDisconnect(HUB, 'erin');
    expect((await hubUser(server, 'erin')).x).toBe(1);
    spin(80);
    server.connect({ account: 'erin', roomId: HUB });
    await server.hubMove(hubPkt(1, 0, 36, 4.5));
    expect((await hubUser(server, 'erin')).x).toBe(0);
    server.connect({ account: 'erin', roomId: HUB });
    expect((await server.hubBye()).ok).toBe(true);
    expect((await hubUser(server, 'erin')).x).toBe(1);
  });
});

describe('room list and nicknames', () => {
  test('listRooms shows match rooms with players, mode, phase and joinability; lobby rooms are not listed', async (server) => {
    await server.simulateJoin(ROOM, 'alice');
    await server.simulateJoin(ROOM, 'bob');
    for (const a of ['c1', 'c2', 'c3', 'c4']) await server.simulateJoin('pb-full01', a);
    await server.simulateJoin(HUB, 'lobbyguy');
    server.connect({ account: 'zed', roomId: '__no_room__' });
    const r = await server.listRooms();
    expect(r.ok).toBe(true);
    const ids = r.rooms.map((x: any) => x.roomId);
    expect(ids.includes(ROOM)).toBe(true);
    expect(ids.includes('pb-full01')).toBe(true);
    expect(ids.some((id: string) => id.startsWith('lb-'))).toBe(false);
    const open = r.rooms.find((x: any) => x.roomId === ROOM);
    expect(open.players).toBe(2);
    expect(open.max).toBe(4);
    expect(open.phase).toBe('lobby');
    expect(open.joinable).toBe(true);
    const full = r.rooms.find((x: any) => x.roomId === 'pb-full01');
    expect(full.joinable).toBe(false);
    expect(full.reason).toBe('full');
    // 들어갈 수 있는 방이 먼저
    expect(r.rooms[0].roomId).toBe(ROOM);
  });

  test('room list works from inside a lobby room (no need to leave the lobby to browse)', async (server) => {
    await server.simulateJoin(ROOM, 'alice');
    await server.simulateJoin(HUB, 'walker');
    server.connect({ account: 'walker', roomId: HUB });
    const r = await server.listRooms();
    expect(r.ok).toBe(true);
    expect(r.rooms.length).toBe(1);
    expect(r.rooms[0].roomId).toBe(ROOM);
    expect(r.rooms[0].joinable).toBe(true);
    // 코드 확인(findRoom)도 로비 룸 안에서 가능
    expect((await server.findRoom(ROOM)).ok).toBe(true);
  });

  test('empty server lists no rooms', async (server) => {
    server.connect({ account: 'zed', roomId: '__no_room__' });
    expect((await server.listRooms()).rooms.length).toBe(0);
  });

  test('hello stores a sanitized nickname; invalid nickname is ignored', async (server) => {
    await server.simulateJoin(ROOM, 'alice');
    await server.simulateJoin(ROOM, 'bob');
    server.connect({ account: 'alice', roomId: ROOM });
    await server.hello('blue', ' 뽀삐  ');
    server.connect({ account: 'bob', roomId: ROOM });
    const h = await server.hello('pink', '<script>');
    expect(h.players.alice.nick).toBe('뽀삐');
    expect(h.players.bob.nick).toBe(undefined);
  });
});

describe('nickname storage (server final check)', () => {
  test('nickGet empty at first; nickSet validates format and profanity, keeps the old nickname on failure', async (server) => {
    server.connect({ account: 'nk', roomId: '__no_room__' });
    expect((await server.nickGet()).nick).toBe(null);
    expect((await server.nickSet('뽀야')).ok).toBe(true);
    expect((await server.nickGet()).nick).toBe('뽀야');
    expect((await server.nickSet('a')).reason).toBe('length');
    expect((await server.nickSet('   ')).reason).toBe('empty');
    expect((await server.nickSet('a<b>c')).reason).toBe('chars');
    expect((await server.nickSet('씨1발')).reason).toBe('blocked');
    expect((await server.nickSet('F u c k')).reason).toBe('blocked');
    expect((await server.nickGet()).nick).toBe('뽀야');
  });

  test('nickSet rate limit (first set free, change again within 10 s refused, same name fine)', async (server) => {
    server.connect({ account: 'nr', roomId: '__no_room__' });
    expect((await server.nickSet('First')).ok).toBe(true);
    const rate = await server.nickSet('Second');
    expect(rate.reason).toBe('rate');
    // 남은 시간 (서버 시각 기준, 0 < 남은 시간 <= 10초)
    expect(rate.retryMs > 0 && rate.retryMs <= 10_000).toBe(true);
    expect((await server.nickSet('First')).ok).toBe(true);
    expect((await server.nickGet()).nick).toBe('First');
  });

  test('nickSet inside a lobby updates the name others see; hubHello and hello prefer the stored nickname', async (server) => {
    server.connect({ account: 'ns', roomId: '__no_room__' });
    await server.nickSet('저장된이름');
    await server.simulateJoin(HUB, 'ns');
    server.connect({ account: 'ns', roomId: HUB });
    await server.hubHello({ c: 'blue', n: 'ClientName' });
    expect((await hubUser(server, 'ns')).n).toBe('저장된이름');
    await server.simulateJoin(ROOM, 'ns');
    server.connect({ account: 'ns', roomId: ROOM });
    expect((await server.hello('blue', 'ClientName')).players.ns.nick).toBe('저장된이름');
    // 로비 안에서 바꾸면 로비 사용자 상태도 바뀜 (간격 제한 지난 뒤)
    await server.simulateJoin(HUB, 'nt');
    server.connect({ account: 'nt', roomId: HUB });
    await server.hubHello({ c: 'blue', n: 'Before' });
    expect((await server.nickSet('After')).ok).toBe(true);
    expect((await hubUser(server, 'nt')).n).toBe('After');
  });
});

describe('nickname filter (shared client/server check)', () => {
  const ok = (raw: string, value = raw) => {
    const r = checkNickname(raw);
    if (!r.ok) throw new Error(`expected ok: ${JSON.stringify(raw)} → ${r.reason}`);
    expect(r.value).toBe(value);
  };
  const bad = (raw: unknown, reason: string) => {
    const r = checkNickname(raw);
    if (r.ok) throw new Error(`expected ${reason}: ${JSON.stringify(raw)} passed as ${JSON.stringify(r.value)}`);
    expect(r.reason).toBe(reason);
  };

  test('normal names: Korean, English, digits, mixed, inner space, trimmed', async () => {
    for (const n of ['뽀삐', '버블파이터', 'Popi', 'player1', '뽀삐123', 'Mochi 짱', 'ab', '가나다라마바사아자차카타', 'A1B2C3D4E5F6']) ok(n);
    ok('  앨리스  짱 ', '앨리스 짱');
    ok('뽀\t삐', '뽀 삐');
  });

  test('length (2..12, counted after trim) and empty', async () => {
    bad('', 'empty');
    bad('     ', 'empty');
    bad(undefined, 'empty');
    bad(42, 'empty');
    bad('a', 'length');
    bad('가', 'length');
    bad('a'.repeat(13), 'length');
    bad('가나다라마바사아자차카타파', 'length');
    ok(' a b ', 'a b');
  });

  test('characters: no symbols, emoji, control characters or HTML', async () => {
    for (const n of ['a<b>c', '<script>', 'na_me', 'name!', 'hi@there', 'abc' + String.fromCharCode(7) + 'd', '뽀삐😀', 'ｆｕｌｌ', 'a.b', '이름#1']) bad(n, 'chars');
  });

  test('Korean profanity incl. evasion (spaces, digits, elongation, jamo split, initials)', async () => {
    for (const n of ['씨발', '시발놈', '씨 발', '씨1발', '씨이발', '시ㅂ알', 'ㅅㅂ', 'ㅅ ㅂ', 'ㅂㅅ아', '병신', '병 신 아', '븅신', '개새끼', '개 새 끼', '존나', '지랄', '좆밥', '니애미', '느금마', '섹스', '한남충', '김치녀', '틀딱', 'ㅅ1발놈', 'ㅅ발', 'ㅆ발', '시ㅂ', 'ㅂ신', 'ㅄ아', 'ㅈ랄'])
      bad(n, 'blocked');
  });

  test('English profanity incl. case, spaces, repeats, leetspeak', async () => {
    for (const n of ['fuck', 'FUCK', 'Fuck You', 'f u c k', 'fuuuuck', 'fvck', 'sh1t', 'B1TCH', 'b i t c h', 'a55hole', 'n1gger', 'p0rn', 'ass', 'ASS', 'dick', 'Big Dick', 'sexy', 'wtf', 'nazi', 'h1tler', 'sibal', 'SSIBAL', 'tlqkf', 'qudtls', 'rotoRl'])
      bad(n, 'blocked');
  });

  test('false positives: normal words that contain a blocked piece stay allowed', async () => {
    for (const n of ['class', 'Classic', 'bass', 'assassin', 'passion', 'grass', 'Dickens', 'cocktail', 'peacock', 'cockpit', 'Essex', 'sussex', 'Scunthorpe', 'shitake', 'therapist', 'Hancock', 'title', 'analyst'])
      ok(n);
    for (const n of ['시발점', '시바견', '새끼손가락', '자지러지다', '보지마', '조지', '곳바', '시바이누', '지하철'])
      ok(n);
    for (const n of ['스시바', '미친듯이', '병아리', '신발', '시계', '새우깡', '개구리', '닥터', '꺼벙이', '조심해']) ok(n);
    // 홀로 쓴 자음이 섞여도 줄임말 구간에 걸치지 않으면 허용 (사방 → ㅅㅂ 뼈대지만 홀로 쓴 자음 없음)
    for (const n of ['사방', 'ㅋㅋ사방', 'ㅎㅎ신발', '바보ㅋ', '수박ㅋㅋ', 'ㅇㅇ지수']) ok(n);
  });
});
