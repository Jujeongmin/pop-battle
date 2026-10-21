/**
 * 멀티플레이 룸·게임 모드 서버 로직 (로컬 하네스: npx -y @agent8/gameserver-node test).
 * 매치는 3초 카운트다운 뒤부터 피해가 들어가므로 시작 뒤 spin(COUNTDOWN)으로 기다린다.
 * 하네스는 실제 네트워크 없이 같은 isolated-vm 런타임에서 훅·함수를 호출한다 → 지연·패킷·푸시 동작은 여기서 검증되지 않음.
 */

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
});
