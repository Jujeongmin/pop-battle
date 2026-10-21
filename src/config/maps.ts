// 맵 선택. 기본 = 첫 정식 맵 POP! ARENA, 테스트 맵은 ?map=test
export type MapId = 'arena' | 'test';

const param = new URLSearchParams(location.search).get('map');
export const MAP_ID: MapId = param === 'test' ? 'test' : 'arena';

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
    /** 경기장 주변 광장 반폭 (x, z) / 순환 도로 바깥 반폭 */
    plazaHalf: [29, 35] as const,
    ringRoadHalf: [36, 42] as const,
    avenueHalfWidth: 4,
  },
};
