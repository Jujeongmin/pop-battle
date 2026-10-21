# Structure — POP! BATTLE

- `index.html`, `src/main.ts` — 진입점 (`Game` 생성)
- `src/core/` — `Game.ts`(조립·메인 루프), 입력
- `src/player/` — 이동 컨트롤러, 아바타(애니메이션·IK·무기 장착), 외형(팀 색·사망 눈)
- `src/combat/` — 무기·히트스캔·근접·피해·VFX(`ToyBullets.ts`)
- `src/bots/`, `src/ai/` — 봇
- `src/match/` — 매치 규칙·집계 / `src/ui/` — HUD·킬로그·디버그 패널
- `src/world/` — 맵 / `src/physics/` — Rapier 래퍼
- `src/config/` — 캐릭터·무기·VFX·매치 설정
- `src/net/` — 멀티플레이 테스트 (네트워크 레이어·게임 모드·보간·디버그 패널, `shared/protocol.ts`)
- `server/src/server.ts` — Verse8 Agent8 게임 서버, `server/test/` — 서버 테스트
- `public/assets/` — GLB·텍스처·사운드
- `tools/` — GLB 검사·Blender 스크립트 / `docs/` — 점검·검증 문서
