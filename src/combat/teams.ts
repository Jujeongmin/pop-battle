import { COMBAT } from '../config/combat';

interface Side {
  readonly id?: string;
  readonly team?: string;
}

/**
 * 두 대상이 서로 적인지. 공격 대상 선택(봇 AI)과 피해 적용 양쪽에서 같은 규칙을 쓴다.
 * - 'teams': 다른 진영끼리만 적
 * - 'ffa': 자기 자신 빼고 모두 적 (추후 개인전)
 */
export function areHostile(a: Side, b: Side): boolean {
  if (a.id !== undefined && a.id === b.id) return false;
  if (COMBAT.hostility === 'ffa') return true;
  return a.team !== b.team;
}

/** 공격자가 대상에게 피해를 줄 수 있는지. 진영 없는 대상(테스트 표적)은 항상 가능 */
export function canDamage(attacker: Side | undefined, target: Side): boolean {
  if (!attacker || target.team === undefined) return true;
  if (attacker.id !== undefined && attacker.id === target.id) return false;
  return COMBAT.friendlyFire || areHostile(attacker, target);
}
