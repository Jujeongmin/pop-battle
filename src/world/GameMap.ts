import type * as THREE from 'three';
import type { KitModels } from './maps/kit';

/** 스폰 지점 (발 위치, yaw = 바라볼 방향 atan2(x, z) 기준). 맵 구조와 분리된 데이터 */
export interface SpawnPoint {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * 맵별 스폰 데이터. 지금 모드(플레이어 vs 봇)는 a = 플레이어 쪽, b = 봇 쪽.
 * 추후 PvP 모드는 같은 데이터를 팀별로 그대로 쓴다.
 */
export interface MapSpawns {
  teamA: readonly SpawnPoint[];
  teamB: readonly SpawnPoint[];
}

/** 봇 이동 격자 범위 (바깥 벽 안쪽) */
export interface NavBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** 걸을 면을 찾는 레이 시작 높이 (가장 높은 걸을 면보다 위) */
  ceiling: number;
}

/** 게임이 쓰는 맵 공통 기능 (테스트 맵·POP! ARENA) */
export interface GameMap {
  readonly id: string;
  readonly name: string;
  readonly spawns: MapSpawns;
  readonly navBounds: NavBounds;
  /** 테스트 표적(기본 도형)을 배치할지 */
  readonly hasTestTargets: boolean;
  /** 그림자 카메라를 플레이어 주변으로 이동 */
  followShadow(focus: THREE.Vector3): void;
  /** 매 프레임 배경 연출 (구름 흐름 등). 전투 판정과 무관 */
  update?(dt: number): void;
  /** 로비 공간이 같이 쓰는 키트 모델·장식 머티리얼 (맵이 소유, 로비는 해제하지 않음). 없으면 로비는 기본 도형만 */
  readonly lobbyKit?: { models: KitModels; material: THREE.Material };
  dispose(): void;
}
