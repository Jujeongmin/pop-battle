// 네트워크 테스트 모드 스위치. ?net=1 일 때만 2인 테스트 룸(봇 없음)으로 시작하고, 아니면 기존 싱글플레이 그대로.
// 배포 빌드에서도 켤 수 있어야 함 (Verse8 배포 환경 테스트용).
export const NET_MODE = typeof location !== 'undefined' && new URLSearchParams(location.search).get('net') === '1';
