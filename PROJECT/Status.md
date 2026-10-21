# Status — POP! BATTLE

## Implemented
- 싱글플레이 개인전(플레이어 + 봇 3), 무기 5종(라이플·샷건·스나이퍼·권총·뿅망치), ADS, 슬라이드·점프 이동
- 캐릭터 6종(BLUE·WHITE·YELLOW·RED·PINK·BLACK) 선택·능력치, 사망 X눈, 킬로그, 장난감 탄환·POP VFX
- 2인 네트워크 테스트 룸 (`?net=1`): 룸 만들기/코드 입장/빠른 매칭, 이동 보간, 사격 연출 동기화, 서버 판정 피해·사망·리스폰, NETWORK TEST 패널(F9)
- 서버 로직 로컬 테스트 16개 (`npm run server:test`)

## Not yet verified
- Verse8 배포 환경에서 실제 2인 접속 (지연·끊김·RTT)
