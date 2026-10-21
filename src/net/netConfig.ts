// ?net=1: 시작할 때 Multiplayer Test 메뉴를 바로 엶 (개발 편의). 없으면 시작 화면 버튼으로 엶.
// 배포 빌드에서도 켤 수 있어야 함 (Verse8 배포 환경 테스트용).
export const NET_MODE = typeof location !== 'undefined' && new URLSearchParams(location.search).get('net') === '1';
