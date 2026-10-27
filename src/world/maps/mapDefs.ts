// 경기장 맵 정의: 같은 빌더(ArenaMap)·같은 장난감 키트로 크기·안쪽 배치만 다른 맵들.
// POP! ARENA = 정식 맵. 나머지는 시험 중 (개발 서버 ?map=<id>, 배포·멀티 목록에는 아직 없음)
import { ARENA_THEME, CANDY_THEME, PLAYGROUND_THEME, type ArenaTheme } from '../../config/maps';
import type { MapSpawns } from '../GameMap';
import { ARENA_LAYOUT, ARENA_SIZE, type ArenaPiece, type MapShell } from './arenaLayout';
import { ARENA_SPAWNS, spawnsFor } from './arenaSpawns';
import { MAZE_LAYOUT, MAZE_SIZE } from './mazeLayout';
import { TOWER_LAYOUT, TOWER_SIZE } from './towerLayout';

export interface ArenaDef {
  id: string;
  /** 표시 이름 (남쪽 간판 글자) */
  name: string;
  shell: MapShell;
  layout: readonly ArenaPiece[];
  spawns: MapSpawns;
  /** 동·서 벽 가운데를 높게 (벽 가까이 발판이 있는 맵) */
  raisedWalls: boolean;
  /** 분위기 (하늘·빛·바닥·담장 색과 모양) */
  theme: ArenaTheme;
}

export const ARENA_DEFS = {
  arena: { id: 'arena', name: 'POP! ARENA', shell: ARENA_SIZE, layout: ARENA_LAYOUT, spawns: ARENA_SPAWNS, raisedWalls: true, theme: ARENA_THEME },
  tower: { id: 'tower', name: 'CANDY TOWER', shell: TOWER_SIZE, layout: TOWER_LAYOUT, spawns: spawnsFor(TOWER_SIZE), raisedWalls: false, theme: CANDY_THEME },
  maze: { id: 'maze', name: 'TOY PLAYGROUND', shell: MAZE_SIZE, layout: MAZE_LAYOUT, spawns: spawnsFor(MAZE_SIZE), raisedWalls: false, theme: PLAYGROUND_THEME },
} satisfies Record<string, ArenaDef>;

export type ArenaDefId = keyof typeof ARENA_DEFS;
