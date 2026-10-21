/**
 * 2인 테스트 룸 서버 로직 (로컬 하네스: npx -y @agent8/gameserver-node test).
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
  server.connect({ account: 'bob', roomId: ROOM });
  // bob이 한 발 쏴서 보호 해제 (테스트가 기다리지 않게)
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
  test('two players get slots 0/1, third is spectator (-1)', async (server) => {
    await server.simulateJoin(ROOM, 'alice');
    await server.simulateJoin(ROOM, 'bob');
    await server.simulateJoin(ROOM, 'carol');
    server.connect({ account: 'alice', roomId: ROOM });
    expect((await server.hello('blue')).slot).toBe(0);
    server.connect({ account: 'bob', roomId: ROOM });
    expect((await server.hello('black')).slot).toBe(1);
    server.connect({ account: 'carol', roomId: ROOM });
    const c = await server.hello('blue');
    expect(c.slot).toBe(-1);
    expect(Object.keys(c.players)).toHaveLength(2);
    expect(c.players.bob.max).toBe(130);
    expect(c.players.bob.hp).toBe(130);
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

  test('protected victim takes no damage', async (server) => {
    await server.simulateJoin(ROOM, 'alice');
    await server.simulateJoin(ROOM, 'bob');
    server.connect({ account: 'alice', roomId: ROOM });
    await server.startTest();
    server.connect({ account: 'bob', roomId: ROOM });
    await server.st(state([0, 0, 10]));
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
  test('host (first joiner) starts only with 2 players; guest cannot', async (server) => {
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
    expect(after.phase).toBe('playing');
    expect(after.startedAt).toBeGreaterThan(0);
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
    expect((await server.findRoom(ROOM)).reason).toBe('full');
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

  test('third account cannot take a slot through hello', async (server) => {
    await server.simulateJoin(ROOM, 'alice');
    await server.simulateJoin(ROOM, 'bob');
    server.connect({ account: 'carol', roomId: ROOM });
    expect((await server.hello('blue')).slot).toBe(-1);
  });
});
