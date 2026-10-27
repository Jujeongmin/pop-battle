// 맵 선택. 기본 = 정식 맵 POP! ARENA, 테스트 맵은 ?map=test.
// 시험 중인 경기장 맵(tower·maze·range)은 개발 서버에서만 ?map=tower / maze / range (멀티 서버·배포 목록에는 아직 없음 → 다른 사람과 맵이 어긋나지 않게)
export type MapId = 'arena' | 'tower' | 'maze' | 'range' | 'test';

const param = new URLSearchParams(location.search).get('map');
export const MAP_ID: MapId =
  param === 'test' ? 'test' : import.meta.env.DEV && (param === 'tower' || param === 'maze' || param === 'range') ? param : 'arena';

const base = import.meta.env.BASE_URL;

/** POP! ARENA에 쓰는 Kenney 키트 모델 (CC0, 원본은 art-src/kenney_*). 모델이 참조하는 Textures/colormap.png도 같은 폴더에 복사 */
export const ARENA_MODELS = {
  brick2x4: `${base}assets/kits/brick/bevel-lq-brick-2x4.glb`,
  brick1x8: `${base}assets/kits/brick/bevel-lq-brick-1x8.glb`,
  brick2x2: `${base}assets/kits/brick/bevel-lq-brick-2x2.glb`,
  brick1x6: `${base}assets/kits/brick/bevel-lq-brick-1x6.glb`,
  brick1x4: `${base}assets/kits/brick/bevel-lq-brick-1x4.glb`,
  brick1x2: `${base}assets/kits/brick/bevel-lq-brick-1x2.glb`,
  round1x1: `${base}assets/kits/brick/bevel-lq-brick-1x1-round.glb`,
  slope2x4: `${base}assets/kits/brick/bevel-lq-brick-slope-2x4.glb`,
  slopeCorner: `${base}assets/kits/brick/bevel-lq-brick-slope-corner-outside-2x2.glb`,
  /** 스터드·모서리 없는 상자 브릭 (원거리 건물용, 삼각형 12개) */
  box2x2: `${base}assets/kits/brick/none-lq-brick-2x2.glb`,
  box2x4: `${base}assets/kits/brick/none-lq-brick-2x4.glb`,
  box1x8: `${base}assets/kits/brick/none-lq-brick-1x8.glb`,
  box1x6: `${base}assets/kits/brick/none-lq-brick-1x6.glb`,
  box1x4: `${base}assets/kits/brick/none-lq-brick-1x4.glb`,
  box1x2: `${base}assets/kits/brick/none-lq-brick-1x2.glb`,
  boxRound: `${base}assets/kits/brick/none-lq-brick-1x1-round.glb`,
  flat2x4: `${base}assets/kits/brick/none-lq-plate-2x4.glb`,
  flat1x8: `${base}assets/kits/brick/none-lq-plate-1x8.glb`,
  flat2x2: `${base}assets/kits/brick/none-lq-plate-2x2.glb`,
  plate4x8: `${base}assets/kits/brick/bevel-lq-plate-4x8.glb`,
  plate2x4: `${base}assets/kits/brick/bevel-lq-plate-2x4.glb`,
  plate1x8: `${base}assets/kits/brick/bevel-lq-plate-1x8.glb`,
  plate2x2: `${base}assets/kits/brick/bevel-lq-plate-2x2.glb`,
  plate1x6: `${base}assets/kits/brick/bevel-lq-plate-1x6.glb`,
  plate1x4: `${base}assets/kits/brick/bevel-lq-plate-1x4.glb`,
  plate1x2: `${base}assets/kits/brick/bevel-lq-plate-1x2.glb`,
  slope: `${base}assets/kits/prototype/shape-slope.glb`,
  stairs: `${base}assets/kits/prototype/stairs.glb`,
  cube: `${base}assets/kits/prototype/shape-cube.glb`,
  flag: `${base}assets/kits/prototype/flag.glb`,
  // 둥근 장난감 도형 (Prototype Kit, 놀이터 테마 맵의 벽·엄폐물·장식). 원본 크기 1 × 1 × 1 (벽은 두께 0.2, 상자 0.5)
  pWall: `${base}assets/kits/prototype/wall.glb`,
  pCylinder: `${base}assets/kits/prototype/shape-cylinder.glb`,
  pHexagon: `${base}assets/kits/prototype/shape-hexagon.glb`,
  pCubeRounded: `${base}assets/kits/prototype/shape-cube-rounded.glb`,
  pCrate: `${base}assets/kits/prototype/crate-color.glb`,
} as const;

export type ArenaModelKey = keyof typeof ARENA_MODELS;

/**
 * 스터드 없는 같은 크기 모델 (몸체 치수·UV 동일, 삼각형 12~60개).
 * 위에 다른 브릭이 얹혀 스터드가 안 보이는 칸에만 써서 겉모습은 그대로, 삼각형만 줄인다.
 */
export const PLAIN_VARIANT: Partial<Record<ArenaModelKey, ArenaModelKey>> = {
  brick1x8: 'box1x8',
  brick1x6: 'box1x6',
  brick1x4: 'box1x4',
  brick1x2: 'box1x2',
  brick2x2: 'box2x2',
  brick2x4: 'box2x4',
  round1x1: 'boxRound',
  plate2x4: 'flat2x4',
  plate1x8: 'flat1x8',
  plate2x2: 'flat2x2',
};
/** 덮인 칸용 모델 (스터드 없는 변형이 없으면 원래 모델) */
export const plain = (m: ArenaModelKey): ArenaModelKey => PLAIN_VARIANT[m] ?? m;

export const ARENA = {
  /**
   * 장난감 블록 배율: 브릭 키트 1스터드 0.08 → 0.56m. 낮은 엄폐물 = 플레이트 2장 0.448m,
   * 높은 엄폐물 = 브릭 2단 1.344m + 덮개 플레이트 0.224m = 1.568m (점프로 못 올라감)
   */
  brickScale: 7,
  /** 브릭 몸체 높이(스터드 제외, 원본 단위). 충돌체는 몸체까지 (스터드 0.018은 장식) */
  brickBodyHeight: 0.096,
  plateBodyHeight: 0.032,
  /**
   * 바깥 벽 (장난감 브릭 담장). 안쪽 면 = 플레이 영역 경계 (x ±19.5, z ±25.5, 이전과 같음).
   * 보이는 높이: 브릭 3단 + 덮개 = 2.24m (땅 점프 발 최고 1.14m, 낮은 엄폐물 위 점프 1.59m보다 높음).
   * 동·서 벽의 발판 옆 구간(|z| < raisedHalfZ)은 5단 + 덮개 = 3.58m (발판 위 점프 발 최고 2.68m보다 높음).
   * 보이는 벽 위로는 이동만 막는 보이지 않는 충돌체(colliderHeight까지): 사격·카메라·시야 판정은 통과.
   * 어디서도 발이 보이는 벽 꼭대기에 닿지 않아 보이지 않는 벽에 막히는 순간이 없다.
   */
  wall: { rows: 3, raisedRows: 5, raisedHalfZ: 9.4, colliderHeight: 10 },
  palette: {
    blue: 0x6fa8ff,
    yellow: 0xffd45e,
    orange: 0xff9c5b,
    pink: 0xff9ec7,
    mint: 0x8fe3c8,
    lavender: 0xc8b6ff,
    white: 0xfaf7f2,
    floorA: 0xf3eee6,
    floorB: 0xe9e2f2,
  },
  /** 하늘·안개·배경 (전투 구역 대각선 65m 안은 안개 없음) */
  sky: {
    zenith: 0x86c3ff,
    upper: 0xb5dcff,
    horizon: 0xfff1de,
    fogNear: 70,
    fogFar: 300,
    /** 구름이 천천히 도는 속도 (rad/s) */
    cloudDrift: 0.004,
  },
  /** 바깥 도시 바닥 */
  ground: {
    grass: 0xc8eab4,
    plaza: 0xf4ebdd,
    road: 0xdcd6ea,
    roadLine: 0xfffaf0,
    /** 경기장 담장(반폭) 바깥 광장·순환 도로 바깥 반폭까지 여유 (m). POP! ARENA = 광장 29×35, 도로 36×42 */
    plazaMargin: 9,
    ringRoadMargin: 16,
    avenueHalfWidth: 4,
  },
};

/**
 * 맵 분위기 (색·하늘·빛·바깥 바닥·바깥 담장 모양). 배치 조각 색은 각 맵 배치 파일이 자기 테마 palette로 칠함.
 * 진영 색(북 분홍·남 파랑: 스폰 가림막·깃발·모서리 탑)은 모든 맵에서 POP! ARENA 색 그대로 → 어느 맵이든 진영을 바로 알아봄
 */
export interface ArenaTheme {
  palette: { blue: number; yellow: number; orange: number; pink: number; mint: number; lavender: number; white: number; floorA: number; floorB: number };
  /** 바닥 가운데 원형 띠 */
  floorRing: number;
  sky: { zenith: number; upper: number; horizon: number; cloud: readonly [number, number]; cloudGlow: number };
  light: { hemiSky: number; hemiGround: number; hemi: number; sun: number; sunIntensity: number; sunOffset: readonly [number, number, number] };
  ground: { grass: number; plaza: number; road: number; roadLine: number };
  /** 바깥 담장: brick = 장난감 브릭 엇갈려 쌓기, soft = 둥근 장난감 벽판 + 원기둥 기둥 */
  wallStyle: 'brick' | 'soft';
  wallCream: number;
}

/** POP! ARENA: 맑은 낮 파스텔 */
export const ARENA_THEME: ArenaTheme = {
  palette: ARENA.palette,
  floorRing: 0xffe2a0,
  sky: { zenith: ARENA.sky.zenith, upper: ARENA.sky.upper, horizon: ARENA.sky.horizon, cloud: [0xffffff, 0xfff6e8], cloudGlow: 0xfff4e4 },
  light: { hemiSky: 0xe6f2ff, hemiGround: 0xf6e6d4, hemi: 1.75, sun: 0xfff1dc, sunIntensity: 2.2, sunOffset: [12, 20, 8] },
  ground: { grass: ARENA.ground.grass, plaza: ARENA.ground.plaza, road: ARENA.ground.road, roadLine: ARENA.ground.roadLine },
  wallStyle: 'brick',
  wallCream: 0xfff3e2,
};

/** 사탕 마을: 하늘·빛·바깥 바닥은 POP! ARENA와 같고, 블록·경기장 바닥·담장만 진한 사탕·마카롱 색 (딸기 분홍·민트·라일락·체리·크림) */
export const CANDY_THEME: ArenaTheme = {
  palette: { blue: 0x8e8cf2, yellow: 0xffc96b, orange: 0xff7f72, pink: 0xff5fa8, mint: 0x52d6b5, lavender: 0xb07cf0, white: 0xfff0f6, floorA: 0xf9dfea, floorB: 0xeedcf7 },
  floorRing: 0xff9fc8,
  sky: ARENA_THEME.sky,
  light: ARENA_THEME.light,
  ground: ARENA_THEME.ground,
  wallStyle: 'brick',
  wallCream: 0xffe4ef,
};

/** 장난감 놀이터: 맑고 시원한 아침, 둥근 놀이 도형(Prototype Kit), 민트·하늘·노랑 */
export const PLAYGROUND_THEME: ArenaTheme = {
  palette: { blue: 0x6ec2ff, yellow: 0xffdf5e, orange: 0xff8b5e, pink: 0xff8fb4, mint: 0x5fd8bc, lavender: 0x9ea8ff, white: 0xf4fbff, floorA: 0xe6f5ef, floorB: 0xd9ecf6 },
  floorRing: 0xbfeee0,
  sky: { zenith: 0x4fb2ff, upper: 0x97dcff, horizon: 0xe6fbff, cloud: [0xffffff, 0xf0fbff], cloudGlow: 0xeaf8ff },
  light: { hemiSky: 0xe0f4ff, hemiGround: 0xd6efe2, hemi: 1.8, sun: 0xfffaf0, sunIntensity: 2.25, sunOffset: [-10, 21, 9] },
  ground: { grass: 0xa6e29b, plaza: 0xe6f3ec, road: 0xcdd9e6, roadLine: 0xffffff },
  wallStyle: 'soft',
  wallCream: 0xf4fbff,
};

/** 장난감 사막 협곡 (스나이퍼 맵): 하늘·빛은 POP! ARENA와 같고, 모래·테라코타·선인장 색 블록과 모래 바닥 */
export const RANGE_THEME: ArenaTheme = {
  palette: { blue: 0x6f9fd6, yellow: 0xf2c46b, orange: 0xe8875a, pink: 0xf0928f, mint: 0x8fc9a0, lavender: 0xb59ccf, white: 0xfdf3e3, floorA: 0xf3e2c2, floorB: 0xead6b2 },
  floorRing: 0xf2c48a,
  sky: ARENA_THEME.sky,
  light: ARENA_THEME.light,
  ground: { grass: 0xe2d29e, plaza: 0xf4e6cb, road: 0xd8c8aa, roadLine: 0xfff8ea },
  wallStyle: 'brick',
  wallCream: 0xfdf0dc,
};
