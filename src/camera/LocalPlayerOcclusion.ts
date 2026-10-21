import * as THREE from 'three';
import { CAMERA } from '../config/gameConfig';
import type { AimProfile } from '../config/weapons';
import type { PlayerAvatar } from '../player/PlayerAvatar';
import { MeshFader } from '../render/MeshFader';

export interface OcclusionFrame {
  dt: number;
  /** 충돌 처리까지 끝난 최종 카메라 */
  camera: THREE.Camera;
  /** ADS 활성 (우클릭 토글 상태). 켜져 있고 무기 설정이 숨김이면 로컬 캐릭터 몸을 그리지 않는다 */
  adsActive: boolean;
  /** 현재 무기 ADS 설정 (hideBodyInAds: 권총 false) */
  aimProfile?: AimProfile | null;
  /** 원형 스코프 화면 표시 중: 무기도 그리지 않음 (렌즈 안으로 총이 보이지 않게) */
  hideWeapon?: boolean;
}

interface Thresholds {
  /** 이 거리보다 가까우면 숨김 */
  hide: number;
  /** 숨긴 뒤에는 이 거리 이상 멀어져야 다시 표시 시작 (히스테리시스) */
  reveal: number;
  /** 이 거리 이상이면 완전히 불투명 */
  full: number;
}

const _box = new THREE.Box3();

/** 카메라 위치에서 near 평면 모서리까지의 거리. 메시가 이보다 가까우면 near 평면에 잘려 안쪽이 보인다 */
function nearPlaneReach(camera: THREE.Camera): number {
  const cam = camera as THREE.PerspectiveCamera;
  if (!cam.isPerspectiveCamera) return 0;
  const tanY = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
  return cam.near * Math.sqrt(1 + tanY * tanY * (1 + cam.aspect * cam.aspect));
}

/**
 * 부위 하나(몸 / 무기)의 표시 상태. 카메라 최종 위치와 메시 경계 사이 거리만으로 결정한다.
 * - 숨김: 메시를 그리지 않음 (visible=false)
 * - 표시: reveal~full 구간에서 깊이 사전 패스 알파로 페이드 인 (안쪽 면이 비치지 않음)
 * 가까워질 때는 즉시 숨기고, 멀어질 때는 reveal 거리를 넘은 뒤에만 서서히 나타난다.
 */
class PartVisibility {
  private shown = true;
  private opacity = 1;

  constructor(private fader: MeshFader) {}

  /** 무기 교체: 이전 메시는 원래 상태로 되돌리고, 새 메시에 현재 표시 상태를 이어서 적용 */
  setFader(fader: MeshFader): void {
    if (fader === this.fader) return;
    this.fader.setVisible(true);
    this.fader.setOpacity(1);
    this.fader = fader;
    this.fader.setVisible(this.shown);
    this.fader.setOpacity(this.shown ? this.opacity : 0);
  }

  /** margin: 카메라 near 평면 모서리까지의 거리 (모든 임계값에 더함) */
  update(distance: number, forceHidden: boolean, t: Thresholds, margin: number, dt: number): void {
    const hide = t.hide + margin;
    const reveal = t.reveal + margin;
    const full = t.full + margin;
    if (forceHidden || distance < hide) {
      this.shown = false;
      this.opacity = 0;
    } else if (!this.shown && distance >= reveal) {
      this.shown = true; // 투명도 0에서 시작
    }
    if (this.shown) {
      const target = THREE.MathUtils.smoothstep(distance, reveal, full);
      this.opacity =
        target < this.opacity
          ? target
          : THREE.MathUtils.lerp(this.opacity, target, 1 - Math.exp(-CAMERA.occlusion.revealSharpness * dt));
    }
    this.fader.setVisible(this.shown);
    this.fader.setOpacity(this.shown ? this.opacity : 0);
  }
}

/**
 * 로컬 플레이어 전용 가림 처리 (다른 플레이어 아바타에는 쓰지 않음). 캐릭터·카메라 위치는 바꾸지 않는다.
 * - ADS 중: 캐릭터 몸 전체를 그리지 않음 (머리·몸통·팔·손·다리). 무기는 따로 판단해 계속 표시
 * - ADS 해제 후: ADS 상태가 아니라 실제 카메라 위치 기준. 카메라가 몸 경계에서 reveal 거리(+ near 평면 여유) 이상 멀어진 뒤에만
 *   다시 나타남 → 복귀 중 머리·모자 안쪽이 보이지 않음
 * - 일반 TPS(벽 밀착 등)도 같은 규칙
 */
export class LocalPlayerOcclusion {
  private readonly body: PartVisibility;
  private readonly weapon: PartVisibility;
  /** 로컬 플레이어 아바타에만 만든다 (봇·다른 플레이어 아바타에는 페이더 자체가 없음) */
  private readonly bodyFader: MeshFader;
  /** 무기 모델별 페이더 (교체할 때마다 새로 만들지 않음) */
  private readonly weaponFaders = new Map<THREE.Object3D, MeshFader>();
  private weaponModel: THREE.Object3D;

  constructor(private readonly avatar: PlayerAvatar) {
    this.bodyFader = new MeshFader(avatar.bodyMeshes);
    this.body = new PartVisibility(this.bodyFader);
    this.weaponModel = avatar.rifle;
    this.weapon = new PartVisibility(this.faderFor(avatar.rifle));
  }

  private faderFor(model: THREE.Object3D): MeshFader {
    let f = this.weaponFaders.get(model);
    if (!f) {
      f = new MeshFader(this.avatar.rifleMeshes);
      this.weaponFaders.set(model, f);
    }
    return f;
  }

  dispose(): void {
    this.bodyFader.dispose();
    for (const f of this.weaponFaders.values()) f.dispose();
    this.weaponFaders.clear();
  }

  update(f: OcclusionFrame): void {
    const o = CAMERA.occlusion;
    const camPos = f.camera.position;
    const margin = nearPlaneReach(f.camera);
    const bodyDist = this.avatar.bodyBounds.distanceToPoint(camPos);
    // 무기별 설정 우선 (권총 ADS는 몸 표시), 없으면 공통 설정
    const hideInAds = f.aimProfile?.hideBodyInAds ?? o.hideBodyInAds;
    this.body.update(bodyDist, f.adsActive && hideInAds, o.body, margin, f.dt);
    if (this.avatar.rifle !== this.weaponModel) {
      this.weaponModel = this.avatar.rifle;
      this.weapon.setFader(this.faderFor(this.weaponModel));
    }
    const weaponDist = this.avatar.getWeaponBounds(_box).distanceToPoint(camPos);
    this.weapon.update(weaponDist, f.hideWeapon ?? false, o.weapon, margin, f.dt);
  }
}
