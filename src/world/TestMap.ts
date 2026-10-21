import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { BOT } from '../config/bots';
import { MOVEMENT, RENDER } from '../config/gameConfig';
import type { GameMap, MapSpawns, NavBounds } from './GameMap';
import type { Physics } from '../physics/Physics';

/**
 * 임시 테스트 맵 (기본 도형). 바닥·벽·엄폐물·경사로·발판.
 * 최종 맵은 별도 에셋(장난감 마을)으로 교체한다.
 */

const PALETTE = {
  floorA: 0xf3eee6,
  floorB: 0xe9e2f2,
  wall: 0xbfd7ff,
  blue: 0x6fa8ff,
  yellow: 0xffd45e,
  orange: 0xff9c5b,
  pink: 0xff9ec7,
  mint: 0x8fe3c8,
  white: 0xfaf7f2,
};

interface BoxSpec {
  pos: [number, number, number];
  size: [number, number, number];
  color: number;
  rotY?: number;
  rotX?: number;
}

const BOXES: BoxSpec[] = [
  // 외곽 벽
  { pos: [0, 1.5, -30], size: [60, 3, 1], color: PALETTE.wall },
  { pos: [0, 1.5, 30], size: [60, 3, 1], color: PALETTE.wall },
  { pos: [-30, 1.5, 0], size: [1, 3, 60], color: PALETTE.wall },
  { pos: [30, 1.5, 0], size: [1, 3, 60], color: PALETTE.wall },
  // 엄폐물 (상자)
  { pos: [-4, 0.6, 2], size: [1.2, 1.2, 1.2], color: PALETTE.orange },
  { pos: [-2.7, 0.45, 2.2], size: [0.9, 0.9, 0.9], color: PALETTE.yellow, rotY: 0.3 },
  { pos: [4, 0.75, 4], size: [3, 1.5, 0.6], color: PALETTE.blue },
  { pos: [0, 0.4, 8], size: [4, 0.8, 0.6], color: PALETTE.pink },
  { pos: [-7, 1.25, 10], size: [1.2, 2.5, 4], color: PALETTE.mint },
  { pos: [8, 0.6, 12], size: [1.2, 1.2, 1.2], color: PALETTE.yellow, rotY: 0.6 },
  { pos: [9.2, 0.6, 12.4], size: [1.2, 1.2, 1.2], color: PALETTE.orange },
  { pos: [8.6, 1.8, 12.2], size: [1.2, 1.2, 1.2], color: PALETTE.blue, rotY: 0.2 },
  // 슬라이딩으로만 통과하는 낮은 터널 (바닥에서 0.9m, 서 있는 캡슐 1.24m / 슬라이딩 0.68m)
  { pos: [-12, 1.25, -2], size: [3, 0.7, 3], color: PALETTE.pink },
  { pos: [-13.7, 0.8, -2], size: [0.4, 1.6, 3], color: PALETTE.white },
  { pos: [-10.3, 0.8, -2], size: [0.4, 1.6, 3], color: PALETTE.white },
  // 점프 발판 + 경사로
  { pos: [12, 0.5, -6], size: [4, 1, 4], color: PALETTE.white },
  { pos: [12, 1.25, -11], size: [4, 0.5, 4], color: PALETTE.yellow },
  { pos: [12, 0.38, -0.5], size: [4, 0.25, 7.1], color: PALETTE.mint, rotX: 0.143 },
  // 장애물 관통 테스트 벽 (표적 앞)
  { pos: [3, 1.2, 15], size: [2.5, 2.4, 0.4], color: PALETTE.blue },
];

export class TestMap implements GameMap {
  readonly id = 'test';
  readonly name = '테스트 맵';
  readonly hasTestTargets = true;
  /** 기존 스폰 값 그대로: 플레이어 MOVEMENT.spawn(캡슐 중심 → 발), 봇 BOT.spawns */
  readonly spawns: MapSpawns = {
    teamA: [{ x: MOVEMENT.spawn.x, y: 0.05, z: MOVEMENT.spawn.z, yaw: 0 }],
    teamB: BOT.spawns.map((s) => ({ x: s.x, y: s.y, z: s.z, yaw: Math.atan2(-s.x, -s.z) })),
  };
  readonly navBounds: NavBounds = { minX: BOT.nav.minX, maxX: BOT.nav.maxX, minZ: BOT.nav.minZ, maxZ: BOT.nav.maxZ, ceiling: 6 };
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(scene: THREE.Scene, physics: Physics) {
    scene.background = new THREE.Color(0xbfe3ff);
    scene.fog = new THREE.Fog(0xbfe3ff, 40, 110);

    const hemi = new THREE.HemisphereLight(0xeaf4ff, 0xf2d9c4, 1.6);
    this.sun = new THREE.DirectionalLight(0xfff3e0, 2.4);
    this.sun.position.set(12, 20, 8);
    this.sun.castShadow = true;
    const ext = RENDER.shadowExtent;
    const cam = this.sun.shadow.camera;
    cam.left = -ext;
    cam.right = ext;
    cam.top = ext;
    cam.bottom = -ext;
    cam.near = 1;
    cam.far = 60;
    this.sun.shadow.mapSize.set(RENDER.shadowMapSize, RENDER.shadowMapSize);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 3;
    this.group.add(hemi, this.sun, this.sun.target);

    this.buildFloor(physics);
    for (const b of BOXES) this.addBox(b, physics);
    scene.add(this.group);
  }

  /** 그림자 카메라를 플레이어 주변으로 이동 */
  followShadow(focus: THREE.Vector3): void {
    this.sun.target.position.copy(focus);
    this.sun.position.set(focus.x + 12, focus.y + 20, focus.z + 8);
  }

  private buildFloor(physics: Physics): void {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
    ctx.fillStyle = hex(PALETTE.floorA);
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = hex(PALETTE.floorB);
    ctx.fillRect(0, 0, size / 2, size / 2);
    ctx.fillRect(size / 2, size / 2, size / 2, size / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(30, 30);
    tex.anisotropy = 4;
    const geo = new THREE.PlaneGeometry(60, 60);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 });
    const floor = new THREE.Mesh(geo, mat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.group.add(floor);
    this.disposables.push(tex, geo, mat);
    physics.setLabel(physics.addFixedBox(new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(30, 0.5, 30)), '바닥');
  }

  private addBox(b: BoxSpec, physics: Physics): void {
    const [w, h, d] = b.size;
    const radius = Math.min(0.12, Math.min(w, h, d) * 0.25);
    const geo = new RoundedBoxGeometry(w, h, d, 3, radius);
    const mat = new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.45, metalness: 0 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(...b.pos);
    mesh.rotation.set(b.rotX ?? 0, b.rotY ?? 0, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.disposables.push(geo, mat);
    const c = physics.addFixedBox(mesh.position, new THREE.Vector3(w / 2, h / 2, d / 2), mesh.quaternion);
    physics.setLabel(c, `상자 ${w}×${h}×${d}`);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.disposables.forEach((d) => d.dispose());
  }
}
