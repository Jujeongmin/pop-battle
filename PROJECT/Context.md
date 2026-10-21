# Context — POP! BATTLE

귀여운 장난감 3D TPS (PC·모바일 HTML5). React 템플릿을 쓰지 않고 바닐라 TypeScript + Three.js + Rapier로 직접 구성.

## Tech Stack
_정확한 버전은 `package.json`._
- 빌드·언어: Vite, TypeScript (strict)
- 렌더링: Three.js / 물리: Rapier 3D (`@dimforge/rapier3d-compat`)
- 멀티플레이(기술 검증): `@agent8/gameserver` 2.0.1의 `GameServer` 클래스를 React 없이 직접 사용, 서버 `server/src/server.ts`

## Critical Memory
- 프로젝트 규칙·작업 이력은 루트 `CLAUDE.md`, 에셋 점검은 `docs/ASSET_AUDIT.md`, 멀티플레이 검증은 `docs/MULTIPLAYER_TEST.md`.
- `.agent8.lock` / `.env`의 verse 값은 플랫폼 관리 — 수정 금지.
- 원본 아트(`art-src/`)는 저장소에 없음 (로컬 보관).
