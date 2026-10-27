import * as THREE from 'three';
import { ARENA } from '../../config/maps';
import { balloon, buildCity, CROSS_ROADS, type Keepout } from './arenaCity';
import { KitMerger, lighten, seededRandom, trs, type KitModels } from './kit';

/**
 * POP! ARENA 바깥 환경: 파스텔 하늘 · 구름 · 도시 바닥 · 장난감 도시 · 간판 · 랜드마크 탑.
 * 전부 충돌 없음, 그림자 없음 (그림자 카메라는 플레이어 주변 18m만 비춤).
 * 그리기 호출: 하늘 1 + 구름 1 + 바닥 2 + 도시(건물·나무·풍선·탑·간판 기둥 합침) 1 + 간판 판 2
 */
export class ArenaBackdrop {
  readonly group = new THREE.Group();
  private readonly clouds: THREE.Mesh;
  private readonly cityMesh: THREE.Mesh;
  private readonly cityMaterial: THREE.Material;
  /** 그래픽 '낮음'용 가벼운 도시 재질 (처음 쓸 때 만듦, 정점 색·텍스처는 같음) */
  private simpleCityMaterial: THREE.MeshLambertMaterial | null = null;
  private readonly disposables: Array<{ dispose(): void }> = [];
  readonly stats = { cityTriangles: 0, cloudTriangles: 0, meshes: 0 };

  constructor(kit: KitModels, cityMaterial: THREE.Material, anisotropy: number) {
    this.group.name = 'arena-backdrop';
    this.addSky();
    this.addGround(anisotropy);

    // ---------- 도시 + 랜드마크 + 간판 기둥 (지오메트리 하나) ----------
    const city = new KitMerger();
    const EAST_TOWER = new THREE.Vector3(56, 0, 20);
    const WEST_TOWER = new THREE.Vector3(-56, 0, -20);
    const keepouts: Keepout[] = [
      { x: EAST_TOWER.x, z: EAST_TOWER.z, r: 9 },
      { x: WEST_TOWER.x, z: WEST_TOWER.z, r: 9 },
    ];
    candyTower(kit, city, EAST_TOWER);
    blockTower(kit, city, WEST_TOWER);
    this.addSign(kit, city, 'north', anisotropy);
    this.addSign(kit, city, 'south', anisotropy);
    // 광장 네 모서리 풍선 기둥
    const [px, pz] = ARENA.ground.plazaHalf;
    const colors = [ARENA.palette.pink, ARENA.palette.yellow, ARENA.palette.blue, ARENA.palette.mint, ARENA.palette.orange];
    let ci = 0;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const x = sx * (px - 6);
        const z = sz * (pz - 6);
        city.addKit(kit.boxRound, trs(x, 0, z, 0, [3, 3.4 / 0.096, 3]), 0xfffaf2);
        const anchor = new THREE.Vector3(x, 3.4, z);
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2 + sx;
          balloon(city, x + Math.sin(a) * 0.9, 6.2 + i * 0.6, z + Math.cos(a) * 0.9, 0.55, colors[ci++ % colors.length]!, anchor);
        }
      }
    }
    buildCity(kit, city, keepouts);
    const cityGeo = city.build()!;
    this.stats.cityTriangles = city.triangles;
    const cityMesh = new THREE.Mesh(cityGeo, cityMaterial);
    cityMesh.name = 'toy-city';
    cityMesh.matrixAutoUpdate = false;
    this.group.add(cityMesh);
    this.cityMesh = cityMesh;
    this.cityMaterial = cityMaterial;
    this.disposables.push(cityGeo);

    // ---------- 구름 ----------
    this.clouds = this.makeClouds();
    this.group.add(this.clouds);
    this.stats.meshes = this.group.children.length;
  }

  update(dt: number): void {
    this.clouds.rotation.y += dt * ARENA.sky.cloudDrift;
  }

  /**
   * 그래픽 '낮음': 도시(화면의 큰 면적, 11만 삼각형)를 반사광 없는 Lambert 재질로 그려 픽셀 계산을 줄임.
   * 모양·색·텍스처·안개는 같고, 해의 반짝임만 빠짐
   */
  setSimple(on: boolean): void {
    if (on && !this.simpleCityMaterial) {
      const src = this.cityMaterial as THREE.MeshStandardMaterial;
      this.simpleCityMaterial = new THREE.MeshLambertMaterial({ color: src.color, map: src.map, vertexColors: src.vertexColors });
    }
    this.cityMesh.material = on ? this.simpleCityMaterial! : this.cityMaterial;
  }

  // ---------------- 하늘 ----------------

  /** 반구 그라데이션 하늘 (셰이더 하나, 텍스처 없음). 수평선 색 = 안개 색 → 먼 건물·땅이 하늘에 자연스럽게 녹음 */
  private addSky(): void {
    const sky = ARENA.sky;
    const geo = new THREE.SphereGeometry(350, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        zenith: { value: new THREE.Color(sky.zenith) },
        upper: { value: new THREE.Color(sky.upper) },
        horizon: { value: new THREE.Color(sky.horizon) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 zenith;
        uniform vec3 upper;
        uniform vec3 horizon;
        varying vec3 vDir;
        void main() {
          float h = normalize(vDir).y;
          vec3 c = mix(horizon, upper, smoothstep(0.0, 0.2, h));
          c = mix(c, zenith, smoothstep(0.15, 0.7, h));
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'sky';
    mesh.renderOrder = -10;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.disposables.push(geo, mat);
  }

  /** 솜사탕 구름: 공 여러 개 뭉치 (아래는 납작). 흰색·크림색, 안개 없음, 그림자 없음 */
  private makeClouds(): THREE.Mesh {
    const rnd = seededRandom(7);
    const puff = new THREE.SphereGeometry(1, 12, 8);
    const m = new KitMerger();
    const count = 18;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + (rnd() - 0.5) * 0.25;
      const dist = 245 + rnd() * 70;
      const y = 58 + rnd() * 62;
      const size = 9 + rnd() * 9;
      const cx = Math.sin(a) * dist;
      const cz = Math.cos(a) * dist;
      // 구름 방향(접선)으로 길게
      const tx = Math.cos(a);
      const tz = -Math.sin(a);
      const color = rnd() < 0.5 ? 0xffffff : 0xfff6e8;
      const puffs = 5 + Math.floor(rnd() * 3);
      for (let p = 0; p < puffs; p++) {
        const t = (p / (puffs - 1) - 0.5) * 2;
        const r = size * (1 - Math.abs(t) * 0.45) * (0.75 + rnd() * 0.3);
        const ox = t * size * 1.25;
        const oy = (1 - Math.abs(t)) * size * 0.35 + rnd() * size * 0.15;
        m.addBasic(puff, trs(cx + tx * ox, y + oy, cz + tz * ox, a, [r, r * 0.78, r]), color);
      }
      // 납작한 바닥
      m.addBasic(puff, trs(cx, y - size * 0.1, cz, a + Math.PI / 2, [size * 0.75, size * 0.35, size * 1.9]), color);
    }
    puff.dispose();
    const geo = m.build()!;
    this.stats.cloudTriangles = m.triangles;
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, emissive: 0xfff4e4, emissiveIntensity: 0.55, fog: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'clouds';
    mesh.renderOrder = -5;
    this.disposables.push(geo, mat);
    return mesh;
  }

  // ---------------- 바닥 ----------------

  /** 도시 바닥: 440m 정사각형 캔버스 한 장 (잔디·광장·순환 도로·큰길·격자 도로) + 바깥 잔디 고리 */
  private addGround(anisotropy: number): void {
    const g = ARENA.ground;
    const SIZE = 440;
    const PX = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = PX;
    const ctx = canvas.getContext('2d')!;
    const k = PX / SIZE;
    const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
    /** 월드 사각형 (x0..x1, z0..z1) 채우기 */
    const rect = (x0: number, z0: number, x1: number, z1: number, color: string, r = 0) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect((x0 + SIZE / 2) * k, (z0 + SIZE / 2) * k, (x1 - x0) * k, (z1 - z0) * k, r * k);
      ctx.fill();
    };
    ctx.fillStyle = hex(g.grass);
    ctx.fillRect(0, 0, PX, PX);
    // 잔디 매트 무늬 (가까운 곳만, 옅은 점)
    ctx.fillStyle = hex(lighten(g.grass, 0.25));
    for (let x = -150; x <= 150; x += 6) {
      for (let z = -150; z <= 150; z += 6) {
        ctx.beginPath();
        ctx.arc((x + SIZE / 2 + ((z / 6) % 2) * 3) * k, (z + SIZE / 2) * k, 0.6 * k, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const sidewalk = hex(0xf6efe4);
    const road = hex(g.road);
    const H = SIZE / 2;
    const roadBand = (horizontal: boolean, c: number, w: number) => {
      if (horizontal) {
        rect(-H, c - w - 1.2, H, c + w + 1.2, sidewalk);
        rect(-H, c - w, H, c + w, road);
      } else {
        rect(c - w - 1.2, -H, c + w + 1.2, H, sidewalk);
        rect(c - w, -H, c + w, H, road);
      }
    };
    // 바깥 격자 도로
    for (const c of CROSS_ROADS) {
      for (const s of [-1, 1]) {
        roadBand(true, s * c, 3);
        roadBand(false, s * c, 3);
      }
    }
    // 큰길 (남북·동서)
    roadBand(false, 0, g.avenueHalfWidth);
    roadBand(true, 0, g.avenueHalfWidth);
    // 순환 도로 + 광장
    const [rx, rz] = g.ringRoadHalf;
    const [px, pz] = g.plazaHalf;
    rect(-rx - 1.2, -rz - 1.2, rx + 1.2, rz + 1.2, sidewalk, 6);
    rect(-rx, -rz, rx, rz, road, 5);
    rect(-px - 1.2, -pz - 1.2, px + 1.2, pz + 1.2, sidewalk, 4);
    rect(-px, -pz, px, pz, hex(g.plaza), 3);
    // 광장 타일 줄 (2m)
    ctx.strokeStyle = hex(0xe8dccb);
    ctx.lineWidth = Math.max(1, 0.12 * k);
    ctx.beginPath();
    for (let x = -px + 2; x < px; x += 2) {
      ctx.moveTo((x + H) * k, (-pz + H) * k);
      ctx.lineTo((x + H) * k, (pz + H) * k);
    }
    for (let z = -pz + 2; z < pz; z += 2) {
      ctx.moveTo((-px + H) * k, (z + H) * k);
      ctx.lineTo((px + H) * k, (z + H) * k);
    }
    ctx.stroke();
    // 도로 가운데 점선
    ctx.strokeStyle = hex(g.roadLine);
    ctx.lineWidth = 0.35 * k;
    ctx.setLineDash([2.5 * k, 2.5 * k]);
    ctx.beginPath();
    const mid = (a: number, b: number) => (a + b) / 2;
    const ringX = mid(px + 1.2, rx);
    const ringZ = mid(pz + 1.2, rz);
    ctx.roundRect((-ringX + H) * k, (-ringZ + H) * k, ringX * 2 * k, ringZ * 2 * k, 5 * k);
    for (const s of [-1, 1]) {
      ctx.moveTo((H) * k, (s * rz + H) * k);
      ctx.lineTo((H) * k, (s * H + H) * k);
      ctx.moveTo((s * rx + H) * k, (H) * k);
      ctx.lineTo((s * H + H) * k, (H) * k);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = anisotropy;
    const geo = new THREE.PlaneGeometry(SIZE, SIZE);
    const mat = new THREE.MeshLambertMaterial({ map: tex });
    const ground = new THREE.Mesh(geo, mat);
    ground.rotation.x = -Math.PI / 2;
    // 경기장 바닥(y=0) 아래. 경기장 안은 경기장 바닥이 덮음
    ground.position.y = -0.03;
    ground.name = 'city-ground';
    this.group.add(ground);
    // 바깥 잔디 고리 (수평선까지, 안개로 하늘색에 녹음)
    const ringGeo = new THREE.RingGeometry(200, 420, 48, 1);
    const ringMat = new THREE.MeshLambertMaterial({ color: g.grass });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.6;
    ring.name = 'horizon-ground';
    this.group.add(ring);
    this.disposables.push(tex, geo, mat, ringGeo, ringMat);
  }

  // ---------------- 간판 ----------------

  /**
   * 경기장 간판: 벽 뒤 광장에 브릭 기둥 두 개 + 글자 판 (캔버스 텍스처).
   * 판 아래 끝 4.8m → 경기장 안 어디서 봐도 적 머리(1.25m)보다 위에 보여 적을 가리지 않음.
   */
  private addSign(kit: KitModels, city: KitMerger, which: 'north' | 'south', anisotropy: number): void {
    const P = ARENA.palette;
    const north = which === 'north';
    const s = north ? 1 : -1;
    const z = s * 31.5;
    const width = north ? 17 : 13;
    const height = north ? 4.4 : 3.6;
    const legScale = 10;
    const lv = 0.096 * legScale;
    const legs = 5;
    const bottom = legs * lv;
    const team = north ? P.pink : P.blue;
    for (const lx of [-width * 0.32, width * 0.32]) {
      for (let l = 0; l < legs; l++) city.addKit(l < legs - 1 ? kit.box2x2 : kit.brick2x2, trs(lx, l * lv, z + s * 0.6, 0, legScale), l % 2 === 0 ? team : 0xfffaf2);
    }
    // 판 위 장식: 둥근 브릭 스터드 줄 + 양끝 풍선
    const topY = bottom + height;
    for (let i = 0; i < 5; i++) {
      const x = (i - 2) * (width / 5.5);
      city.addKit(kit.round1x1, trs(x, topY, z, 0, 9), [P.yellow, P.pink, P.blue, P.mint, P.orange][i]!);
    }
    for (const ex of [-1, 1]) {
      const anchor = new THREE.Vector3(ex * (width / 2 - 0.3), topY, z);
      for (let i = 0; i < 3; i++) {
        const a = i * 2.1 + ex;
        balloon(city, anchor.x + Math.sin(a) * 1.1 + ex * 0.6, topY + 2.6 + i * 0.7, z + Math.cos(a) * 0.8, 0.75, [P.pink, P.yellow, P.blue, P.mint][(i + (ex > 0 ? 1 : 0)) % 4]!, anchor);
      }
    }

    // 글자 판
    const tex = signTexture(north ? 'POP! BATTLE' : 'POP! ARENA', north, anisotropy);
    const face = new THREE.MeshLambertMaterial({ map: tex });
    const side = new THREE.MeshLambertMaterial({ color: lighten(team, 0.2) });
    // BoxGeometry 면 순서: +x, -x, +y, -y, +z, -z. 경기장 쪽 면에 글자
    const mats = [side, side, side, side, north ? side : face, north ? face : side];
    const geo = new THREE.BoxGeometry(width, height, 0.5);
    const board = new THREE.Mesh(geo, mats);
    board.position.set(0, bottom + height / 2, z);
    board.name = `sign-${which}`;
    this.group.add(board);
    this.disposables.push(tex, face, side, geo);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.disposables.forEach((d) => d.dispose());
    // 텍스처는 원래 도시 재질과 공유 → 재질만 해제
    this.simpleCityMaterial?.dispose();
  }
}

/** 간판 글자 그림: 둥근 테두리 판 + 글자마다 다른 색 + 두꺼운 남색 외곽선 + 흰 하이라이트 */
function signTexture(text: string, north: boolean, anisotropy: number): THREE.CanvasTexture {
  const W = 1024;
  const H = north ? 265 : 284;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const P = ARENA.palette;
  const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
  ctx.fillStyle = hex(north ? 0xffb8d6 : 0xa9cdff);
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = hex(0xfffaf0);
  ctx.beginPath();
  ctx.roundRect(22, 22, W - 44, H - 44, 40);
  ctx.fill();
  // 테두리 점 장식
  const dots = [P.yellow, P.blue, P.pink, P.mint, P.orange];
  for (let i = 0; i < 18; i++) {
    ctx.fillStyle = hex(dots[i % dots.length]!);
    const x = 50 + (i * (W - 100)) / 17;
    for (const y of [11, H - 11]) {
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const font = `900 ${north ? 150 : 140}px "Arial Rounded MT Bold", "Arial Black", "Segoe UI Black", sans-serif`;
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const letters = [...text];
  const widths = letters.map((ch) => ctx.measureText(ch).width + (ch === ' ' ? 0 : 4));
  const total = widths.reduce((a, b) => a + b, 0);
  const scale = Math.min(1, (W - 120) / total);
  ctx.save();
  ctx.translate(W / 2 - (total * scale) / 2, H / 2 + 6);
  ctx.scale(scale, scale);
  const colors = [P.pink, P.orange, P.yellow, P.mint, P.blue, P.lavender];
  let x = 0;
  letters.forEach((ch, i) => {
    if (ch !== ' ') {
      const bob = (i % 2 === 0 ? -1 : 1) * 6;
      ctx.lineWidth = 26;
      ctx.strokeStyle = '#2f3d6b';
      ctx.strokeText(ch, x, bob);
      ctx.fillStyle = hex(colors[i % colors.length]!);
      ctx.fillText(ch, x, bob);
      // 하이라이트
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(x + widths[i]! * 0.32, bob - 38, widths[i]! * 0.16, 12, -0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    x += widths[i]!;
  });
  ctx.restore();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  return tex;
}

/** 동쪽 랜드마크: 사탕 줄무늬 둥근 탑 (1x1 둥근 브릭 확대 6단 + 발코니 + 반구 지붕 + 풍선) */
function candyTower(kit: KitModels, m: KitMerger, at: THREE.Vector3): void {
  const P = ARENA.palette;
  const k = 46;
  const lv = 0.096 * k;
  const r = 0.04 * k;
  const win = new THREE.BoxGeometry(1, 1, 1);
  for (let l = 0; l < 6; l++) {
    m.addKit(kit.boxRound, trs(at.x, l * lv, at.z, l * 0.4, k), l % 2 === 0 ? 0xfffaf2 : 0xff9c8a);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + l * 0.5;
      m.addBasic(win, trs(at.x + Math.sin(a) * r, l * lv + lv * 0.4, at.z + Math.cos(a) * r, a, [0.7, 1.1, 0.2]), 0xe3f1ff);
    }
  }
  const top = 6 * lv;
  // 발코니 (둥근 브릭을 넓고 납작하게)
  m.addKit(kit.round1x1, trs(at.x, top, at.z, 0, [k * 1.35, k * 0.25, k * 1.35]), P.yellow);
  const dome = new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  m.addBasic(dome, trs(at.x, top + 0.9, at.z, 0, r * 0.95), P.pink);
  win.dispose();
  dome.dispose();
  const anchor = new THREE.Vector3(at.x, top + 0.9 + r * 0.9, at.z);
  const colors = [P.yellow, P.blue, P.mint, P.orange, P.lavender];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    balloon(m, at.x + Math.sin(a) * 1.6, anchor.y + 3.2 + (i % 2) * 1.1, at.z + Math.cos(a) * 1.6, 0.95, colors[i]!, anchor);
  }
  m.addKit(kit.flag, trs(at.x, anchor.y, at.z, 0, 2.2), P.pink, true);
}

/** 서쪽 랜드마크: 층마다 조금씩 돌아간 2x2 블록 탑 (7단) + 큰 공 + 풍선 */
function blockTower(kit: KitModels, m: KitMerger, at: THREE.Vector3): void {
  const P = ARENA.palette;
  const k = 36;
  const lv = 0.096 * k;
  const colors = [P.blue, P.yellow, P.pink, P.mint, P.orange, P.lavender, P.blue];
  for (let l = 0; l < 7; l++) {
    m.addKit(kit.brick2x2, trs(at.x, l * lv, at.z, l * 0.21, k), lighten(colors[l]!, 0.1));
  }
  const top = 7 * lv + 0.018 * k;
  const ball = new THREE.SphereGeometry(1, 18, 12);
  m.addBasic(ball, trs(at.x, top + 2.2, at.z, 0, 2.6), P.pink);
  ball.dispose();
  const anchor = new THREE.Vector3(at.x, top + 4.6, at.z);
  const bc = [P.yellow, P.blue, P.mint, P.orange];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    balloon(m, at.x + Math.sin(a) * 1.4, anchor.y + 3 + (i % 2) * 0.9, at.z + Math.cos(a) * 1.4, 0.9, bc[i]!, anchor);
  }
}
