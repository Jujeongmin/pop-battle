import type RAPIER from '@dimforge/rapier3d-compat';
import type * as THREE from 'three';
import type { Damageable, HitPart } from '../physics/Physics';

/** 전투에 참여하는 캐릭터 (플레이어·봇 공용). 봇 AI는 이 인터페이스로만 상대를 본다. */
export interface Combatant extends Damageable {
  readonly id: string;
  readonly name: string;
  readonly team: string;
  /** 이동 강체 (자기 판정 제외용) */
  readonly rigidBody: RAPIER.RigidBody;
  /** 발 위치 (물리 기준) */
  getFeet(out: THREE.Vector3): THREE.Vector3;
  /** 판정 영역 중심 (물리 기준 = 실제 맞는 위치) */
  getAimPoint(part: HitPart, out: THREE.Vector3): THREE.Vector3;
  /** 눈 높이 (시야 검사 시작점) */
  getEye(out: THREE.Vector3): THREE.Vector3;
  readonly velocity: THREE.Vector3;
  /** AI가 표적으로 삼을 수 있는지 (살아 있고 게임에 참여 중) */
  readonly targetable: boolean;
  /** 리스폰 보호 중 (피해 없음) */
  readonly isProtected: boolean;
  /** 마지막 발사 이후 경과 시간 (총소리 감지) */
  readonly timeSinceShot: number;
}
