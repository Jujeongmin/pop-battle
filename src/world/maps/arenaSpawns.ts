// POP! ARENA 스폰 데이터 (맵 구조와 분리). 발 위치, yaw = 바라볼 방향 (0 = +z).
// teamA = 남쪽 (지금 모드: 플레이어), teamB = 북쪽 (지금 모드: 봇). PvP에서는 팀별로 그대로 사용.
// 모두 스폰 가림막(z ±18) 뒤 → 스폰 직후 중앙에서 바로 보이지 않음. 서로 3m 이상 떨어짐.
import type { MapSpawns, SpawnPoint } from '../GameMap';
import { ARENA_SIZE, type MapShell } from './arenaLayout';

const SOUTH: SpawnPoint[] = [
  { x: -5.5, y: 0.05, z: -22.5, yaw: 0 },
  { x: 0, y: 0.05, z: -23.5, yaw: 0 },
  { x: 5.5, y: 0.05, z: -22.5, yaw: 0 },
  // 바깥쪽 스폰은 차로 입구 가림(x 12.76~17.24) 뒤에만 (차로를 따라 곧게 보이지 않게)
  { x: -13.5, y: 0.05, z: -23.5, yaw: 0 },
  { x: 13.5, y: 0.05, z: -23.5, yaw: 0 },
  { x: -16.5, y: 0.05, z: -23, yaw: 0 },
  { x: 16.5, y: 0.05, z: -23, yaw: 0 },
];

/** 맵 크기에 맞춘 스폰 (스폰 구역 arenaLayout.spawnNorth와 같이 벽 쪽으로 밀림) */
export function spawnsFor(shell: MapShell): MapSpawns {
  const dz = shell.halfZ - ARENA_SIZE.halfZ;
  const south = SOUTH.map((s) => ({ ...s, z: s.z - dz }));
  return { teamA: south, teamB: south.map((s) => ({ ...s, z: -s.z, yaw: Math.PI })) };
}

export const ARENA_SPAWNS: MapSpawns = spawnsFor(ARENA_SIZE);
