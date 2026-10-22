// 멀티: 로컬 리스폰 보호(보호 방울·HUD)를 서버 보호 끝 시각에 맞추는 계산 (순수 함수, 테스트용으로 분리).
// 피해는 서버가 prot로만 판정하고 로컬 체력은 서버 값을 쓰므로, 여기서는 "보이는 보호"가 서버와 같이 끝나게만 한다.

/**
 * @param local 지금 로컬 보호 남은 시간 (초). 0 = 없음 또는 공격으로 해제됨 → 다시 켜지 않음
 * @param recordProt 룸 상태의 내 기록 prot (서버 ms, 재접속·중간 입장 포함). 리스폰 응답보다 늦게 오면 이전 생의 값
 * @param respawnProt 마지막 리스폰 응답의 prot (서버 ms, 없으면 0)
 * @param serverNow 서버 시각 추정 (ms)
 * @param maxSec 보호 시간 (초, 2)
 * @param atRespawn 리스폰 응답 직후 → 로컬 기본 보호를 서버 남은 시간으로 바로 맞춤. 아니면 줄이기만
 * @returns 새 로컬 보호 남은 시간 (초)
 */
export function syncedProtection(local: number, recordProt: number, respawnProt: number, serverNow: number, maxSec: number, atRespawn: boolean): number {
  if (local <= 0) return 0;
  const end = Math.max(recordProt, respawnProt);
  const remaining = Math.min(maxSec, Math.max(0, (end - serverNow) / 1000));
  return atRespawn ? remaining : Math.min(local, remaining);
}
