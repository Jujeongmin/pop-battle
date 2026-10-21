# Requirements — POP! BATTLE

## Coding Patterns
- 모듈 단위 클래스 (`src/core/Game.ts`가 조립·메인 루프). 설정 값은 `src/config/`.
- 3D 에셋은 사용자가 제작한 GLB (`public/assets/models/`). 임의 저품질 모델 생성 금지.
- 네트워크: 게임 로직 / 네트워크 레이어(`src/net/NetClient.ts`·`NetSession.ts`) / 게임 모드(`src/net/NetGameMode.ts`) 분리. `?net=1`이 아니면 싱글플레이 그대로.
- 서버·클라이언트 공용 규칙은 `src/net/shared/protocol.ts` (무기·체력 수치 사본, 서버 import 가능해야 하므로 three.js 등 import 금지).

## Known Issues / Constraints
- Verse8 서버는 물리·타이머 없음 → 벽 관통·시야 검사 불가, 서버는 피해·체력·사망·리스폰과 범위 검증만 담당.
- 일반 원격 호출 함수 이름당 초당 10회 → 사격·명중은 50ms 상태 패킷(throttle)에 묶어 전송.
- 실제 배포 환경 2인 테스트는 아직 미검증.
