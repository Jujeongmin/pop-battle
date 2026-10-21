# POP! BATTLE

귀여운 장난감 3D TPS (Vite + TypeScript strict + Three.js + Rapier 3D). 최종 목표는 Verse8에서 도는 PC·모바일 HTML5 게임.

- 사용자에게는 한국어로 말한다.
- 개발 서버 포트 5210 (`npm run dev`). 빌드 `npm run build`.
- 아트 방향: 2~2.5등신, 둥근 플라스틱 장난감 질감, 파스텔 블루·옐로·오렌지·핑크, 밝은 장난감 마을. 사실적인 군사 분위기 금지.
- 지금 범위 밖: 정식 멀티플레이 서버(2인 기술 검증 룸만 있음), 정식 매칭, 랭킹, 봇 무기 선택 AI (봇은 라이플만). 무기 5종(라이플·샷건·스나이퍼·권총·근접)과 봇 AI는 구현됨.
- 무기 모델: 5종 모두 GLB. 게임 기본은 Blender 최적화본(`*_lod0.glb`, 7000 삼각형·Color/Normal 1024²·ORM 512²), `?rifle=original`·`?guns=original`로 원본 사본. `pop_battle_*`는 사용자 지정 파일명. 임시 도형 코드(`src/assets/weaponModels.ts`)는 새 무기 GLB가 오기 전 대체용으로만 남김. 새 GLB는 `config/weapons.ts`의 `model.glb` 경로와 `*_MOUNT` 장착값만 바꾼다.
- 캐릭터 최종 6종(BLUE·WHITE·YELLOW·RED·PINK·BLACK — RED = 옛 character_6, GLB 파일명 character_6.glb 그대로; 옛 RED는 red_v2·C7과 함께 보존만): `src/config/characters.ts`에 능력치·키·장착 보정. 체형은 `tools/blender/shape_character.py` + `art-src/characters/shape/<id>.json`(메시+레스트 본). 개발용 CHARACTER DEBUG(` 패널). 폴리곤 비교 렌더 `tools/blender/render_poly_compare.py`. 일지 `docs/devlog/`.
- 캐릭터 기준 장착값은 블루. 비율 조정 도구 `tools/blender/adjust_character.py`(메시+레스트 본 동시 변형), 측정 `measure_character.py`·`tools/measure_eyes.py`, 비교 렌더 `render_lineup.py`. 클립 리타깃 `retarget_clips.py`(레스트 축이 다른 캐릭터 간). 결과·한계는 `art-src/characters/REPORT.md`. 개발 서버 확인 `?char=<id>`, 봇 `?botchars=a,b,c` (배포 빌드는 시작 화면 선택·저장값만, BLACK·WHITE 잠김). 킬로그 `ui/KillFeed.ts`(확정 사망만, `Game.reportDeath`). 팀 컬러: 마스크 `tools/blender/team_mask.py` → `public/assets/models/team-masks/`, 런타임 `player/CharacterAppearance.ts`, 설정 `config/characters.ts`, 미리보기 `?teams=tdm`.
- 멀티플레이 기술 검증(2인 테스트 룸, Verse8 Agent8 SDK): `?net=1`(봇 없음), 서버 `server/src/server.ts`(`npm run server:test`), 클라이언트 `src/net/`(공용 규칙 `src/net/shared/protocol.ts` = 무기·체력 사본), 패널 F9. 배포는 사용자가 직접. 절차·결과: [docs/MULTIPLAYER_TEST.md](docs/MULTIPLAYER_TEST.md)
- 디버그 패널(` 키): 뿅망치 자세 실시간 조절·손목 자동 맞춤·자세 보기 카메라, 무적(콘솔 `__game.god()`), 사격 경로 디버그(콘솔 `__game.setShotDebug(true)`: 카메라 조준 레이·총구·실제 탄 경로·충돌 물체).

## 에셋 워크플로 (사용자 지침, 2026-10-20)
- 3D 에셋은 사용자가 만든다: Codex로 2D 레퍼런스 → Verse8 2D to 3D MCP → GLB. 완성도 낮은 3D 모델을 임의로 만들지 말고, 필요한 에셋과 권장 레퍼런스 구도를 먼저 알린다. 충돌·기능 테스트용 임시 도형은 써도 된다.
- 새 GLB는 로드된다고 정상이라 판단하지 않는다. `node tools/inspect-glb.mjs <file> --bones`로 정적 검사 후, 실제 장면(디버그 패널 `` ` ``, 콘솔 `__game.inspectOrbit`)에서 애니메이션·장착·게임 카메라 외형을 확인한다.
- 원본 GLB는 `art-src/glb-originals/`에 그대로 보관. 게임용 사본·수정본은 `public/assets/models/`에 `<분류>_<이름>.glb` 규칙(`character_…`, `weapon_…`)으로 둔다.
- 무기 위치 문제는 장착 설정(`src/config/weapons.ts` WeaponMount)부터, 팔 자세는 본 회전·IK, 스키닝·비율 문제는 모델 수정 필요 여부를 판단해 보고한다. Blender Python 자동화는 결과를 반드시 장면에서 검증.
- 에셋 문제와 게임 로직 문제를 구분해 보고하고, 모델 결함을 임시방편으로 숨기지 않는다. 검증하지 않은 것은 정상이라 단정하지 않는다.
- 현재 점검 결과: [docs/ASSET_AUDIT.md](docs/ASSET_AUDIT.md)
