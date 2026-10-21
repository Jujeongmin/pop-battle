import * as THREE from 'three';
import { ARENA } from '../../config/maps';
import type { SpawnPoint } from '../GameMap';
import type { ZonePiece } from './arenaLayout';

/**
 * 경기장 바닥: 1m 장난감 타일 (모서리 둥근 판 + 이음 홈) × 칸별 색.
 * - 구역 색은 레이아웃의 zone 조각에서 (중앙 노랑, 서쪽 민트, 동쪽 라벤더, 스폰 분홍/파랑)
 * - 구역 가장자리 1칸은 조금 진한 띠, 2m마다 아주 옅은 체크 (거리 가늠), 중앙 원형 띠, 스폰 자리 표시
 * - 칸마다 정점 색 + 반복 타일 텍스처 하나 → 그리기 호출 1회. 높이·충돌은 그대로 (평면 y=0)
 */
export function buildArenaFloor(
  zones: readonly ZonePiece[],
  spawns: readonly SpawnPoint[],
  extent: { halfX: number; halfZ: number },
  anisotropy: number,
): { mesh: THREE.Mesh; disposables: Array<{ dispose(): void }> } {
  const minX = -Math.ceil(extent.halfX);
  const maxX = Math.ceil(extent.halfX);
  const minZ = -Math.ceil(extent.halfZ);
  const maxZ = Math.ceil(extent.halfZ);
  const nx = maxX - minX;
  const nz = maxZ - minZ;

  // 칸 중심에서 구역 찾기 (뒤에 나온 구역 우선)
  const zoneAt = (x: number, z: number): ZonePiece | null => {
    for (let i = zones.length - 1; i >= 0; i--) {
      const zn = zones[i]!;
      if (Math.abs(x - zn.x) < zn.w / 2 && Math.abs(z - zn.z) < zn.d / 2) return zn;
    }
    return null;
  };
  const base = new THREE.Color(ARENA.palette.floorA);
  const ring = new THREE.Color(0xffe2a0);
  const spawnPad = new Map<number, THREE.Color>();
  const tmp = new THREE.Color();

  const positions = new Float32Array(nx * nz * 4 * 3);
  const normals = new Float32Array(nx * nz * 4 * 3);
  const uvs = new Float32Array(nx * nz * 4 * 2);
  const colors = new Float32Array(nx * nz * 4 * 3);
  const index: number[] = [];
  let v = 0;
  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      const x0 = minX + ix;
      const z0 = minZ + iz;
      const cx = x0 + 0.5;
      const cz = z0 + 0.5;
      const zn = zoneAt(cx, cz);
      tmp.copy(zn ? tmp.setHex(zn.color) : base);
      if (zn) {
        // 구역 가장자리 띠: 이웃 칸이 다른 구역이면 조금 진하게
        const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => zoneAt(cx + dx!, cz + dz!) !== zn);
        if (edge) tmp.multiplyScalar(0.93);
      }
      // 중앙 원형 띠 (반지름 4.5~5.5m)
      const r = Math.hypot(cx, cz);
      if (r >= 4.5 && r < 5.5) tmp.copy(ring);
      // 스폰 자리: 진영 색 2×2 칸
      for (const s of spawns) {
        if (Math.abs(cx - s.x) < 1 && Math.abs(cz - s.z) < 1) {
          const c = zn?.color ?? ARENA.palette.floorA;
          let pad = spawnPad.get(c);
          if (!pad) spawnPad.set(c, (pad = new THREE.Color(c).multiplyScalar(0.86)));
          tmp.copy(pad);
        }
      }
      // 2m 체크 (아주 옅게)
      if ((Math.floor(x0 / 2) + Math.floor(z0 / 2)) % 2 === 0) tmp.multiplyScalar(0.975);

      const corners: Array<[number, number]> = [[x0, z0], [x0 + 1, z0], [x0, z0 + 1], [x0 + 1, z0 + 1]];
      for (const [x, z] of corners) {
        positions.set([x, 0, z], v * 3);
        normals.set([0, 1, 0], v * 3);
        uvs.set([x, -z], v * 2);
        colors.set([tmp.r, tmp.g, tmp.b], v * 3);
        v++;
      }
      const b = v - 4;
      index.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(index);
  geo.computeBoundingSphere();

  const tex = tileTexture(anisotropy);
  const mat = new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 0.8, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return { mesh, disposables: [geo, mat, tex] };
}

/** 1m 타일 한 장: 둥근 모서리 판 + 이음 홈 + 위·왼쪽 밝은 테 (회색조, 칸 색에 곱해짐) */
function tileTexture(anisotropy: number): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#d9d6dc';
  ctx.fillRect(0, 0, size, size);
  const inset = 3;
  const rad = 14;
  const rr = (x: number, y: number, w: number, h: number, r: number) => {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
  };
  ctx.fillStyle = '#ebe9ee';
  rr(inset, inset, size - inset * 2, size - inset * 2, rad);
  ctx.fillStyle = '#ffffff';
  rr(inset, inset, size - inset * 2 - 3, size - inset * 2 - 3, rad);
  ctx.fillStyle = '#fafafa';
  rr(inset + 4, inset + 4, size - inset * 2 - 9, size - inset * 2 - 9, rad - 4);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = anisotropy;
  return tex;
}
