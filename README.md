# POP! BATTLE — TPS 프로토타입

```bash
npm install
npm run dev      # http://localhost:5210
npm run build    # 타입 검사 + dist/
```

## 조작 (PC)
| 키 | 동작 |
|---|---|
| 클릭 | 포인터 잠금 (첫 클릭은 사격하지 않음) |
| WASD / Space | 이동 / 점프 |
| W 두 번 | 달리기 (W를 뗀 뒤 0.3초 안에 다시 누르고 유지, W+A·W+D 대각선 가능, W를 떼면 해제. A·S·D 두 번은 달리기 아님) |
| Shift | 슬라이딩 (지상에서 정지·걷기·달리기 중 시작. 달리는 중이면 슬라이딩 후 W를 계속 누르고 있으면 다시 달리기. Ctrl은 쓰지 않음) |
| 좌클릭 / 우클릭 / R | 사격 / ADS 토글 / 재장전 |
| 1 / 2 / 3, 휠 | 주무기 / 권총 / 근접무기 (휠은 세 슬롯 순환, 즉시 교체) |
| K | 사망 테스트 |
| `` ` `` | 무기 장착 디버그 패널 |

모바일(계획): 가상 조이스틱 이동 · 조이스틱을 전방(카메라 기준 ±30°)으로 세기 85% 이상 0.5초 유지하면 달리기(`core/JoystickAutoSprint.ts`, 달리는 중엔 ±42°·70%까지 유지) · 슬라이딩 버튼. 판정 모듈은 있으나 가상 패드(터치 UI)는 아직 없음.

## 구조
```
src/
  config/      gameConfig.ts(이동·카메라·캐릭터), weapons.ts(무기 정의·AimProfile·장착값), combat.ts(진영·체력·히트박스), bots.ts(봇 AI)
  core/        Game.ts(조립·메인 루프·고정 스텝), Input.ts(입력 → InputState)
  assets/      GLB 로딩 (실패 시 대체 모델 없이 오류 표시)
  physics/     Rapier 래퍼, 레이캐스트, 히트박스
  player/      PlayerController(키네마틱 이동), PlayerAvatar(애니메이션·IK·총 장착), ik.ts
  camera/      TpsCamera(오른쪽 어깨, 충돌, ADS 보간, 반동)
  combat/      AimController(공통 우클릭 토글 ADS), Weapon(탄약·연사·탄퍼짐), WeaponSystem(플레이어 히트스캔),
               hitscan.ts(총구 경로 판정·피해 적용, 플레이어·봇 공용), Health, teams.ts(적대 규칙), CharacterHitboxes, WeaponEffects
  match/       Match(매치 상태 WAITING→COUNTDOWN→PLAYING→FINISHED·타이머·종료 판정), MatchStats(킬·데스 집계·순위), config/match.ts(모드 규칙)
  ai/          NavGrid(이동 격자 + A*), BotBrain(상태 기계, 렌더링 무관)
  bots/        Bot(이동·조준·사격·사망/리스폰), BotManager(생성·스폰·감지 대상·디버그)
  world/       TestMap, TestTarget (임시 도형)
  ui/          Hud, DebugPanel
tools/inspect-glb.mjs   GLB 정적 검사
art-src/glb-originals/  원본 GLB (수정 금지)
docs/ASSET_AUDIT.md     에셋 점검 보고
```

## 사망 표정 (X X 눈)
- 사망 확정 순간 흰자는 그대로 두고 검은 눈동자만 X로 교체 (흰자 가운데, 눈동자 지름의 85%), 리스폰 때 복구 (플레이어·봇, 인스턴스별). 입·눈썹·앞머리는 그대로.
- 데이터: `public/assets/models/dead-eyes/<id>_dead_eyes.png|json` (`tools/blender/dead_eyes.py`, 설정 `art-src/characters/dead-eyes/<id>.json`). 런타임 `player/CharacterAppearance.ts`.
- 개발 서버: CHARACTER DEBUG의 Normal / Dead / Reset Eyes, 콘솔 `__game.setExpression('player', 'dead' | 'normal' | null)` (HP·판정·킬로그와 무관).

## 킬로그 (우측 상단)
- `[처치자] [무기 아이콘(+헤드샷)] [사망자]`, 최대 4줄, 새 줄이 위, 5초 유지 후 0.3초 페이드아웃 (`src/ui/KillFeed.ts`, 타이머 없이 HUD 프레임에서 만료 확인).
- 확정된 사망 지점에서만 생성 (`Game.reportDeath`): 봇 `Bot.applyHit` 사망, 플레이어 피격 사망·사망 테스트 키(자멸 아이콘)·낙사(낙사 아이콘). 같은 사망은 리스폰 전까지 한 번만. 무기·헤드샷은 마지막 피해 `HitInfo.weaponId`·`headshot` 그대로.
- 색: 개인전 = 캐릭터 색 (`KILL_FEED_COLORS`), TDM = 팀 색 (`KILL_FEED_TEAM_COLORS`). 내 처치 = 줄 강조, 내 사망 = 사망자 이름 강조 (참가자 id 기준).
- 개발 서버: ` 패널 KILL FEED TEST (표시만, 점수 반영 없음), 콘솔 `__game.testKillFeed('burst')`.

## 캐릭터 · 팀 컬러
- 최종 6종: blue · white · yellow · red · pink · black (red = 옛 character_6, GLB character_6.glb; 저장값 character_6은 red로 자동 변환) (`src/config/characters.ts`, 능력치·키·체형·캐릭터별 무기 장착 보정 포함). 제외된 red·c7은 `RETIRED_CHARACTERS`에 보존(GLB 삭제 안 함).
- 개발 서버에서만: 플레이어 `?char=<id>`, 봇 `?botchars=<id>,<id>,<id>` (기본은 플레이어와 같은 캐릭터), ` 디버그 패널 CHARACTER DEBUG(즉시 교체·판정 표시), 콘솔 `__game.setCharacter('player'|'bot1', id)`. 시작 화면 캐릭터 선택(게임 시작 전에만, 마지막 선택은 브라우저에 저장 `popbattle.character`, 제외·잠긴·모르는 저장값은 BLUE). BLACK·WHITE는 상위 캐릭터로 잠김 표시 → 배포 빌드에서 선택 불가, 해금 조건은 아직 없음 (`CHARACTER_SELECT` in `config/characters.ts`).
- 능력치: HP는 캐릭터 최대 체력(리스폰 시 회복), 속도 배율은 걷기·달리기·슬라이딩 기본값에 한 번만, 판정은 모델 정점 실측(머리 구·몸통 캡슐). 무기는 캐릭터 크기와 무관하게 같은 크기.
- FFA는 원래 색. TDM(규칙은 아직 없음)은 비니·상의 주요 색만 팀 색(BLUE `#2878FF`, RED `#FF4545`, `TEAM_COLORS`). 팀은 캐릭터 원래 색과 무관.
- 미리보기: `?teams=tdm` (플레이어·BOT 1 = BLUE, BOT 2·3 = RED, 아군 이름표 파랑). 콘솔 `__game.setTeamPreview(true|false)`, `__game.setTeam('bot2', 'BLUE')`, `__game.appearanceState`.
- 외형은 (characterId, teamId)만으로 결정 → 멀티플레이에서는 팀 배정이 바뀔 때 이 두 값만 동기화.

## 매치 (개인전 FFA)
- 4명 (플레이어 1 + 봇 3), 모두 서로 적, 3분, 15킬 먼저 달성하면 즉시 종료. 규칙은 `src/config/match.ts` `FFA_RULES`.
- 흐름: 시작 화면(WAITING) → 첫 클릭 → 모두 겹치지 않는 스폰에 배치·초기화 → 3초 카운트다운(이동·사격·봇 정지) → 전투(PLAYING) → 종료(FINISHED, 전투 정지·리스폰 없음) → 결과 화면 → 다시 플레이.
- 집계: 처치하면 공격자 킬 +1, 쓰러진 쪽 데스 +1. 공격자 없는 사망(K 자살·낙사)·자기 자신은 데스만. 한 번 쓰러지면 리스폰 전까지 추가 집계 없음. PLAYING에서만 집계.
- 순위: 킬 내림차순 → 데스 오름차순 (킬·데스가 같으면 같은 순위). 승패는 킬만: 플레이어 단독 최다 킬 승리, 공동 최다 킬 무승부, 그 외 패배.
- 스폰: 개인전은 맵의 모든 스폰(남·북 14곳)을 모두 공용 (`rules.spawns = 'all'`).
- TDM·네트워크는 아직 없음. `MatchStats`는 사망 이벤트(피해자, 공격자)만 받으므로 서버 판정으로 옮겨도 같은 단위로 쓸 수 있다.

## 무기 (3단계)

| 슬롯 | 무기 | 피해 | 탄창/예비 | 연사 | ADS |
|---|---|---|---|---|---|
| 1 주무기(택1) | POP 라이플 | 12 | 30/120 | 600RPM 자동 | 어깨 1.4배 |
| 1 주무기(택1) | 팡팡 샷건 | 15 × 펠릿 8 = 120 (3m까지 100% → 7m 50% → 15m 20%) | 6/30 (1발 = 펠릿 8) | 80RPM 반자동 | 어깨 1.15배, 퍼짐 3.3° → ADS 1.98° |
| 1 주무기(택1) | 뿅뿅 스나이퍼 | 80 | 5/20 | 45RPM 볼트액션 | 원형 스코프 4배, 쏘면 자동 해제 |
| 2 보조 | 뽁뽁 권총 | 15 (헤드 22.5) | 12/48 | 300RPM 반자동 | 어깨 1.2배 |
| 3 근접 | 뿅망치 | 40 (헤드샷 배율 없음) | - | 0.7초 간격 | 없음 |

- 이동속도: 무기별 `WeaponDef.moveSpeedMultiplier` (주무기 1.0, 권총·뿅망치 1.2). 걷기·달리기 수평 속도에만 곱하고(ADS 감속과 곱), 점프·중력·슬라이딩은 그대로.
- 총기 헤드샷 1.5배. 수치·사거리·반동·퍼짐·재장전·이펙트 배율은 전부 `src/config/weapons.ts` (`WeaponDef`)에서 조정.
- 로드아웃: 시작 화면 카드에서 주무기 선택(기본 라이플). 첫 클릭(게임 시작) 후 고정, 리스폰해도 유지(1번 슬롯으로 들고 전 무기 탄약 보충).
- 교체: 즉시 (`WEAPON_SWITCH_TIME = 0`). 무기마다 `Weapon` 상태를 따로 가져 탄약 유지. 교체 시 이전 무기 재장전 취소·ADS 해제(자동 재진입 없음), 빈 탄창 무기를 꺼내면 예비 탄약이 있을 때 자동 재장전.
- 재장전: 마지막 탄을 쏘면 자동 시작(예비 탄약 없으면 안 함), R 수동 유지. 재장전이 시작되면 ADS 즉시 해제·재장전 중 진입 불가, 끝나도 자동으로 켜지지 않음 (모든 총기 `keepAimWhileReloading: false`).
- 샷건 거리별 펠릿당 피해: 0~3m 15, 3~7m 15→7.5 직선 감소, 7~15m 7.5→3, 15m 이후 3 (`falloff.farDistance/farMultiplier` 2단계). 거리 = 총구→탄착. 0~3m 몸통 중앙 조준 시 지향·ADS·이동 모두 8발 명중(시뮬레이션 500회) → 100HP 한 방. 점프 사격은 기존 공중 퍼짐(+3°)으로 3m 8발 보장 안 됨. 플레이어·봇 같은 `applyShotDamage`.
- 샷건: 펠릿마다 개별 판정, 히트마커·피해 숫자는 방아쇠 1회에 한 번(대상별 합계). 펠릿 분포는 `hitscan.pelletInCone`: 중앙 1발 + 원을 7등분한 부채꼴마다 1발(각도·반지름 무작위, 발사마다 회전) → 한쪽 몰림 없음.
- 스나이퍼: ADS 시 기존 HUD 원형 스코프(바깥 어둡게, 중앙 조준점), 스코프 중 무기 모델 숨김. 카메라 충돌·총구 장애물 판정 그대로.
- 근접: 가슴에서 1.6m·정면 55° 안의 판정 영역, 가슴→대상 레이가 벽에 막히면 실패, 휘두르기 1회당 대상별 1회. 휘두르기 0.17초에 판정(프레임과 무관), 대상이 없고 벽이면 벽 타격 연출.
- 모델: 5종 모두 GLB (Blender 최적화본 기본). 임시 도형(`src/assets/weaponModels.ts`)은 GLB가 없는 새 무기용 대체. 새 GLB는 `model.glb` 경로 + `*_MOUNT` 장착값만 조정. 근접 휘두르기는 전용 클립이 없어 팔 IK 절차 연출(`MELEE_MOUNT.swing`).
- 스나이퍼 볼트액션: 쏘면 ADS·스코프가 즉시 해제(`aim.releaseAfterShot`), 후딜레이(60/45 = 1.33초) 동안 총을 살짝 눕히는 절차 연출(`SNIPER_MOUNT.bolt`, 전용 클립 없음). 볼트 중 다시 조준은 되지만 발사는 막힘.
- 볼트 후 자동 재조준: ADS 상태로 쐈고 탄창이 남아 있으면 볼트가 끝나는 순간(1.33초) 자동으로 스코프 복귀. 비조준 사격·마지막 탄(자동 재장전)은 복귀 없음. 예약은 무기 교체(퀵스왑 포함)·재장전 시작·사망/리스폰·달리기/점프/슬라이딩·볼트 중 우클릭(예약 취소만, 조준 안 함)으로 취소되고 나중에 실행되지 않음 (`WeaponSystem.reaimFor`).
- 스나이퍼 퀵스왑: 후딜레이와 최소 발사 간격(0.8초, `SNIPER.quickSwap`)을 분리. 권총·근접무기가 실제로 장착된 순간 후딜레이 취소가 확정되고(즉시 교체라 키 입력 프레임), 스나이퍼로 돌아오면 마지막 발사 후 0.8초가 지났을 때 바로 발사. 같은 프레임 2→1·휠 ±1(순 0칸)·1번 연타로는 취소 안 됨. 퀵스왑 후 ADS 자동 활성화 없음. 리스폰 시 발사 상태 초기화. 개발 HUD에 마지막 발사·후딜레이·다음 발사까지·실제 간격 표시.
- 봇은 라이플만 (`config/bots.ts` `primaryWeapons`에 봇별 무기 id 데이터만 준비, 무기 선택 AI 없음).

ADS 방식은 무기별 `aim.style`로 고른다 (모두 우클릭 토글):
| style | 화면 | 쓸 무기 |
|---|---|---|
| `shoulder` | TPS형 ADS: 오른쪽 어깨 카메라에서 캐릭터 뒤 거의 중앙으로 이동하며 확대, 로컬 캐릭터 메시는 숨기고 무기만 화면 아래에 표시, 화면 중앙 조준선. 해제 후 캐릭터는 카메라가 안전 거리로 물러난 뒤에만 다시 나타남 (좌우 엄폐 시야 차이 최소화). `magnification`, `cameraDistance/shoulderOffset/heightOffset`로 무기별 조정 | 라이플 1.4배, 샷건 1.15배, 권총 1.2배 |
| `scopeOverlay` | 같은 어깨 확대 + 총을 숨기고 원형 스코프 화면 | 스나이퍼 4배 |
| 없음 (`aim: null`) | 우클릭 무시 | 근접무기 |

조준선 색: 기본(ADS 노랑·일반 흰색), 지금 쏘면 살아 있는 적 피격 부위에 실제로 맞을 때만 빨강. 총구 경로가 장애물에 막히면 조준선 색은 그대로 두고 실제 탄착 지점에 표시. 개발 모드에서는 화면 왼쪽 위에 조준 대상·충돌 지점·총구 막힘·판정 이유 표시.

사격 연출: `WeaponSystem`은 판정 결과(`ShotResult`)만 내보내고, `Game.presentShot`이 이펙트·사운드·HUD로 나눠 보낸다 (멀티플레이에서도 같은 결과로 연출 가능).
- `WeaponEffects`: 만화풍 총구 화염(총구를 따라감), 총구→실제 탄착점 얇은 궤적, 벽·바닥 먼지/파편, 적 POP(별·링, 헤드샷 강조). 전부 풀 재사용.
- HUD: 실제 피해가 들어간 경우만 히트마커(흰색 / 헤드샷 노란색 / 처치 빨간색 + KO!), 피해 숫자(헤드샷 노란색 + !, 연속 명중은 엇갈려 배치).
- `AudioManager` + `src/config/audio.ts`: 발사·명중(헤드샷 동일)·벽 충돌·처치·재장전 시작/완료. 지금은 Web Audio 임시 합성음, `SOUND_FILES`에 WAV/OGG 경로를 넣으면 그 파일을 재생(실패하면 합성음).

ADS 해제·진입 규칙은 모든 무기 공통으로 `AimController`가 처리한다:
- 달리기(W 더블 탭), 점프, 슬라이딩, 재장전이 시작되면 즉시 해제. 걷기·정지·사격은 유지.
- 위 행동이 진행 중(달리는 중·공중·슬라이딩 중·재장전 중)이면 우클릭해도 켜지지 않음.
- 행동이 끝나도 자동으로 다시 켜지지 않음 (우클릭을 새로 눌러야 함).
- 이동·재장전 시스템은 매 프레임 상태만 넘기고(`aim.updateActions`) ADS·카메라를 직접 바꾸지 않는다.


## 전투 봇 (2단계)

- 3명 (`BOT 1~3`), 플레이어와 같은 캐릭터·라이플 GLB를 복제해 사용. 머리 위 이름·체력 막대 (벽 뒤면 숨김), 로컬 플레이어 ADS 숨김 처리는 적용되지 않음.
- 상태: Idle → Patrol → Chase → Attack ↔ Reload, Dead. 결정은 `BotBrain`(0.1초 간격), 감지는 0.15초 간격(봇마다 어긋나게), 이동은 고정 스텝, 애니메이션·조준 회전은 렌더 프레임.
- 감지: 거리 30m, 시야각 130°, 장애물 레이 검사, 총소리 24m. 놓치면 마지막 위치를 4초 추적 + 도착 후 2.5초 수색 → 순찰. 맞으면 공격자를 인지.
- 이동: 플레이어와 같은 Rapier 캐릭터 컨트롤러. 맵 콜라이더를 Rapier 형상 검사로 구운 0.5m 격자 + A* + 직선 다듬기, 막히면 재탐색 → 반복되면 목표 변경.
- 사격: 같은 `Weapon` 규칙(12 피해, 30발, 600RPM, 헤드샷 1.5배, 재장전 1.8초). 가슴에서 조준 방향 레이 → 실제 총구에서 같은 장애물 검사(`hitscan.ts`). 조준 각도 안 + 총구 경로가 열려 있을 때만 발사, 반응 시간·조준 오차·연사 길이는 난이도(`?bots=easy|normal|hard`).
- 교전: 선호 거리 6~15m 유지(가까우면 물러남, 멀면 접근) + 옆걸음, 총구가 막히면 시야 열린 사격 위치로 이동, 재장전 중엔 표적 시야 밖 지점으로 달려감.
- 피격·사망: 플레이어와 같은 히트마커·피해 숫자·이펙트, Death 클립, 사망 즉시 이동 캡슐·판정 영역 비활성화(통과·조준 제외), 3초 뒤 적과 멀고 겹치지 않는 스폰에서 부활(체력·탄약 초기화, 2초 보호, 발사하면 해제). 봇 예비 탄약은 다 떨어지면 채워짐(봇 전용).
- 플레이어: 체력 100, 피격 시 화면 가장자리 섬광 + 공격 방향 호 표시, 사망 시 "BOT n에게 쓰러짐!", 리스폰 시 체력·탄약 초기화 + 2초 보호(발사하면 해제). 첫 클릭(게임 시작) 전에는 봇이 플레이어를 노리지 않음.
- 진영: `config/combat.ts`의 `hostility`('teams' = 플레이어 vs 봇, 'ffa' = 모두 적)와 `friendlyFire`. 봇 표적 선택과 피해 적용이 같은 `areHostile/canDamage`를 씀.
- 판정 영역: 이동 캡슐과 별도로 머리 구 + 몸통 캡슐(판정 전용). 머리 범위는 GLB 바인드 포즈 정점 분석(원본 높이의 위쪽 절반, 반지름 0.33m). 이동 캡슐은 사격·카메라 쿼리에서 제외.
- 개발 정보(개발 모드 HUD): 봇별 상태·HP·보호·탄약·표적·감지/기억·사격 가능·거리·경로 진행·마지막 판단 이유, AI 갱신 시간. 디버그 패널(`)의 "봇 경로 표시"로 경로선 표시.

## 맵

- 기본: **POP! ARENA** (40 × 52m 앞뒤 대칭 장난감 블록 아레나, Kenney Brick/Prototype Kit CC0). `?map=test` 이면 기존 테스트 맵.
- 배치 데이터 `src/world/maps/arenaLayout.ts`, 스폰 데이터 `arenaSpawns.ts` (팀 A 남쪽 / 팀 B 북쪽, PvP에서도 그대로), 빌더 `ArenaMap.ts`, 공통 인터페이스 `src/world/GameMap.ts`.
- 봇 이동 격자(`src/ai/NavGrid.ts`)는 높이맵: 경사로·계단으로 발판에 오르고, 단차·엄폐물 윗면으로는 가지 않는다.
- 외곽: 브릭 담장(`arenaWall.ts`, 보이는 높이 2.24m / 발판 옆 3.58m + 위로 이동만 막는 충돌체), 타일 바닥(`arenaFloor.ts`), 장난감 도시·간판·랜드마크 탑·하늘·구름(`ArenaBackdrop.ts`, `arenaCity.ts`). 배경은 충돌·그림자 없음, 도시 전체가 그리기 호출 1회.
- 상세 측정: `docs/ASSET_AUDIT.md` "전투 맵 POP! ARENA".
