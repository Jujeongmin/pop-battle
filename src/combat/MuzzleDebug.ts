import * as THREE from 'three';

/**
 * 개발용 총구 디버그 표시 (기본 꺼짐, 개발 서버에서만 켤 수 있음):
 * - 초록 점: 이번 프레임 총구 기준점 (장착값 mount.muzzle → 월드)
 * - 노란 선: 총구 방향 (정렬 공간 +Z, 0.5m)
 * - 분홍 점: 마지막 발사 이펙트가 생긴 위치 (0.6초 유지, 생긴 순간 총구 기준점과 같은지 확인용)
 * 깊이 무시로 총 모델 안쪽이어도 보인다.
 */
export class MuzzleDebug {
  private readonly group = new THREE.Group();
  private readonly dot: THREE.Mesh;
  private readonly flash: THREE.Mesh;
  private readonly line: THREE.Line;
  private readonly linePos: THREE.BufferAttribute;
  private flashLife = 0;
  /** 마지막 발사 이펙트 위치와 그 순간 총구 기준점 사이 거리 (m, 디버그 줄 표시용) */
  lastFlashError = 0;

  constructor(private readonly scene: THREE.Scene) {
    const mat = (color: number) => new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
    this.dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), mat(0x22dd66));
    this.flash = new THREE.Mesh(new THREE.SphereGeometry(0.02, 10, 8), mat(0xff3cc8));
    const geo = new THREE.BufferGeometry();
    this.linePos = new THREE.BufferAttribute(new Float32Array(6), 3);
    geo.setAttribute('position', this.linePos);
    this.line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffdd00, depthTest: false, transparent: true }));
    this.line.frustumCulled = false;
    for (const o of [this.dot, this.flash, this.line]) {
      o.renderOrder = 30;
      this.group.add(o);
    }
    this.flash.visible = false;
    this.group.visible = false;
    scene.add(this.group);
  }

  get enabled(): boolean {
    return this.group.visible;
  }

  set enabled(v: boolean) {
    this.group.visible = v;
  }

  /** 매 프레임: 총구 기준점·방향 */
  update(dt: number, muzzle: THREE.Vector3, dir: THREE.Vector3): void {
    if (!this.group.visible) return;
    this.dot.position.copy(muzzle);
    this.linePos.setXYZ(0, muzzle.x, muzzle.y, muzzle.z);
    this.linePos.setXYZ(1, muzzle.x + dir.x * 0.5, muzzle.y + dir.y * 0.5, muzzle.z + dir.z * 0.5);
    this.linePos.needsUpdate = true;
    this.line.geometry.computeBoundingSphere();
    if (this.flashLife > 0) {
      this.flashLife -= dt;
      this.flash.visible = this.flashLife > 0;
    }
  }

  /** 발사 이펙트가 생긴 위치 기록 (muzzleNow = 그 순간 총구 기준점) */
  onFlash(pos: THREE.Vector3, muzzleNow: THREE.Vector3): void {
    this.lastFlashError = pos.distanceTo(muzzleNow);
    if (!this.group.visible) return;
    this.flash.position.copy(pos);
    this.flash.visible = true;
    this.flashLife = 0.6;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
  }
}
