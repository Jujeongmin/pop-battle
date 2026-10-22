// 원격 플레이어 공통: 보간된 상태(Sampled) → 아바타 자세. 매치(RemotePlayer)와 온라인 로비(LobbyPeers)가 같이 쓴다.
// 위치·몸 방향·이동 모드·달리기·점프·착지·슬라이딩 애니메이션은 여기서만 정하고, 전투(무기 반동·재장전·ADS)는 패킷 값 그대로 —
// 로비 패킷은 그 값이 모두 0이라 전투 동작 없이 이동 애니메이션만 나온다.
import type * as THREE from 'three';
import type { PlayerAvatar } from '../player/PlayerAvatar';
import type { Sampled } from './SnapshotBuffer';
import { NET_MODES } from './shared/protocol';

/**
 * 보간 상태로 아바타 갱신. feet·velocity·aimDir은 호출한 쪽 벡터를 채워서 넘김 (할당 없음).
 * fresh = 이 패킷을 처음 그림 → 점프·착지처럼 한 번만 일어나는 동작을 이때만
 */
export function poseRemoteAvatar(
  avatar: PlayerAvatar,
  s: Sampled,
  dt: number,
  fresh: boolean,
  out: { feet: THREE.Vector3; velocity: THREE.Vector3; aimDir: THREE.Vector3 },
  dead = false,
): void {
  const n = s.near;
  out.feet.set(s.p[0], s.p[1], s.p[2]);
  out.velocity.set(s.v[0], s.v[1], s.v[2]);
  out.aimDir.set(s.aim[0], s.aim[1], s.aim[2]);
  avatar.update({
    dt,
    feet: out.feet,
    bodyYaw: s.yaw,
    aimDir: out.aimDir,
    pitch: s.pitch,
    mode: NET_MODES[n.m] ?? 'ground',
    grounded: (n.f & 1) !== 0,
    sprinting: (n.f & 2) !== 0,
    velocity: out.velocity,
    justJumped: fresh && (n.f & 16) !== 0,
    justLanded: fresh && (n.f & 32) !== 0,
    landedAirTime: 0.4,
    dead,
    strafing: (n.f & 4) !== 0,
    weaponKick: n.k,
    weaponRaise: 1,
    reloadProgress: n.rl,
    adsBlend: n.ads,
    meleeSwing: n.ms,
    boltProgress: n.bp,
  });
}
