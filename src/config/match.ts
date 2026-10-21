// 매치(게임 모드) 규칙. 지금은 FFA만. TDM 등은 같은 형식으로 규칙만 추가한다.
import type { HostilityMode } from './combat';

export interface MatchRules {
  readonly mode: 'ffa';
  /** 화면 표시 이름 */
  readonly label: string;
  /** 참가 인원 (플레이어 + 봇) */
  readonly players: number;
  /** 제한시간 (s) */
  readonly timeLimit: number;
  /** 이 킬 수에 먼저 도달하면 즉시 종료 */
  readonly scoreToWin: number;
  /** 시작 카운트다운 (s) */
  readonly countdown: number;
  /** 적대 규칙 (FFA = 모두 적) */
  readonly hostility: HostilityMode;
  /** 스폰 지점: 'all' = 맵의 모든 스폰을 모두가 공용 (개인전), 'team' = 진영별 */
  readonly spawns: 'all' | 'team';
}

/** 개인전: 4명(플레이어 1 + 봇 3), 3분, 15킬 */
export const FFA_RULES: MatchRules = {
  mode: 'ffa',
  label: '개인전',
  players: 4,
  timeLimit: 180,
  scoreToWin: 15,
  countdown: 3,
  hostility: 'ffa',
  spawns: 'all',
};

/** 2인 네트워크 테스트 (?net=1): 봇 없음, 시간·점수 종료 사실상 없음 (기술 검증용) */
export const NET_TEST_RULES: MatchRules = {
  mode: 'ffa',
  label: '1:1 네트워크 테스트',
  players: 2,
  timeLimit: 1800,
  scoreToWin: 999,
  countdown: 1,
  hostility: 'ffa',
  spawns: 'all',
};
