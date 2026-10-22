import * as THREE from 'three';

/**
 * 사격 시각 효과 (총구 화염, 벽·적 피격 POP). 판정과 분리되어 ShotResult만 보고 그린다. 날아가는 탄환은 ToyBullets
 * 모든 오브젝트·머티리얼은 생성 시 한 번 만들어 풀로 재사용한다 (연사 중 할당 없음).
 * 최종 VFX 에셋이 오면 텍스처만 교체할 수 있게 캔버스 텍스처를 한 곳에서 만든다.
 */

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, c: number) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  draw(ctx, size / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function starPath(ctx: CanvasRenderingContext2D, c: number, spikes: number, outer: number, inner: number): void {
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
    ctx.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
  }
  ctx.closePath();
}

/** 만화풍 총구 화염: 주황 별 + 노란 안쪽 별 */
const makeFlashTexture = () =>
  canvasTexture(128, (ctx, c) => {
    ctx.fillStyle = '#ff9a2e';
    starPath(ctx, c, 8, c, c * 0.45);
    ctx.fill();
    ctx.fillStyle = '#ffe14d';
    starPath(ctx, c, 8, c * 0.68, c * 0.3);
    ctx.fill();
    ctx.fillStyle = '#fffbe6';
    ctx.beginPath();
    ctx.arc(c, c, c * 0.22, 0, Math.PI * 2);
    ctx.fill();
  });

/** 피격용 5각 별 (흰색, 머티리얼 색으로 칠함) */
const makeStarTexture = () =>
  canvasTexture(64, (ctx, c) => {
    ctx.fillStyle = '#ffffff';
    starPath(ctx, c, 5, c * 0.95, c * 0.42);
    ctx.fill();
  });

/** 부드러운 원 (벽 먼지) */
const makePuffTexture = () =>
  canvasTexture(64, (ctx, c) => {
    const g = ctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c * 2, c * 2);
  });

/** POP 링 */
const makeRingTexture = () =>
  canvasTexture(128, (ctx, c) => {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = c * 0.16;
    ctx.beginPath();
    ctx.arc(c, c, c * 0.78, 0, Math.PI * 2);
    ctx.stroke();
  });

interface SpriteFx {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  size0: number;
  size1: number;
  gravity: number;
  spin: number;
}

const FLASH_LIFE = 0.055;
const _mid = new THREE.Vector3();

/** 같은 종류 스프라이트 풀 */
class SpritePool {
  readonly items: SpriteFx[] = [];
  private cursor = 0;

  constructor(scene: THREE.Scene, count: number, texture: THREE.Texture, blending: THREE.Blending) {
    for (let i = 0; i < count; i++) {
      const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, blending });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.renderOrder = 20;
      scene.add(sprite);
      this.items.push({ sprite, mat, vel: new THREE.Vector3(), life: 0, maxLife: 1, size0: 0.1, size1: 0.1, gravity: 0, spin: 0 });
    }
  }

  spawn(pos: THREE.Vector3, color: THREE.ColorRepresentation, life: number, size0: number, size1: number): SpriteFx {
    const fx = this.items[this.cursor]!;
    this.cursor = (this.cursor + 1) % this.items.length;
    fx.sprite.position.copy(pos);
    fx.mat.color.set(color);
    fx.mat.rotation = Math.random() * Math.PI * 2;
    fx.vel.set(0, 0, 0);
    fx.life = fx.maxLife = life;
    fx.size0 = size0;
    fx.size1 = size1;
    fx.gravity = 0;
    fx.spin = 0;
    fx.sprite.visible = true;
    return fx;
  }

  update(dt: number): void {
    for (const fx of this.items) {
      if (fx.life <= 0) continue;
      fx.life -= dt;
      if (fx.life <= 0) {
        fx.sprite.visible = false;
        continue;
      }
      const t = 1 - fx.life / fx.maxLife;
      fx.vel.y -= fx.gravity * dt;
      fx.sprite.position.addScaledVector(fx.vel, dt);
      fx.sprite.scale.setScalar(THREE.MathUtils.lerp(fx.size0, fx.size1, t));
      fx.mat.rotation += fx.spin * dt;
      // 끝부분에서만 빠르게 사라짐
      fx.mat.opacity = Math.min(1, (1 - t) * 3);
    }
  }

  dispose(scene: THREE.Scene): void {
    for (const fx of this.items) {
      fx.mat.dispose();
      scene.remove(fx.sprite);
    }
  }
}

interface FlashFx {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  life: number;
  scale: number;
  follow: THREE.Vector3 | null;
}

const FLASH_POOL = 6;

export class WeaponEffects {
  private readonly textures = {
    flash: makeFlashTexture(),
    star: makeStarTexture(),
    puff: makePuffTexture(),
    ring: makeRingTexture(),
  };
  /** 총구 화염 풀 (사수마다 따로). 조명은 하나만 두고 가장 최근 발사를 따라감 (조명 수가 바뀌면 셰이더 재컴파일) */
  private readonly flashes: FlashFx[] = [];
  private flashCursor = 0;
  private readonly flashLight = new THREE.PointLight(0xffc062, 0, 3, 2);
  private lightFlash: FlashFx | null = null;
  private readonly stars: SpritePool;
  private readonly puffs: SpritePool;
  private readonly rings: SpritePool;
  private readonly chips: SpritePool;

  constructor(private readonly scene: THREE.Scene) {
    for (let i = 0; i < FLASH_POOL; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.textures.flash,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.renderOrder = 21;
      scene.add(sprite);
      this.flashes.push({ sprite, mat, life: 0, scale: 0.25, follow: null });
    }
    scene.add(this.flashLight);

    this.stars = new SpritePool(scene, 64, this.textures.star, THREE.NormalBlending);
    this.puffs = new SpritePool(scene, 32, this.textures.puff, THREE.NormalBlending);
    this.rings = new SpritePool(scene, 12, this.textures.ring, THREE.NormalBlending);
    this.chips = new SpritePool(scene, 64, this.textures.puff, THREE.NormalBlending);
  }

  /**
   * 총구 화염: 매 발사마다 다시 시작.
   * @param follow 사수가 매 프레임 갱신하는 총구 위치 벡터 (수명 동안 화염이 따라감). 같은 사수는 같은 화염 칸을 재사용
   */
  muzzleFlash(pos: THREE.Vector3, follow: THREE.Vector3 | null = null, scale = 1): void {
    if (scale <= 0) return;
    let f = follow ? this.flashes.find((x) => x.follow === follow && x.life > 0) : undefined;
    if (!f) {
      f = this.flashes[this.flashCursor]!;
      this.flashCursor = (this.flashCursor + 1) % this.flashes.length;
    }
    f.follow = follow;
    f.sprite.position.copy(pos);
    // 장난감 POP 톤: 작고 짧게, 조명도 약하게 (번쩍이는 실총 화염처럼 보이지 않게)
    f.scale = (0.17 + Math.random() * 0.05) * scale;
    f.mat.rotation = Math.random() * Math.PI;
    f.sprite.visible = true;
    f.life = FLASH_LIFE;
    this.lightFlash = f;
    this.flashLight.position.copy(pos);
    this.flashLight.intensity = 1.4;
  }

  /**
   * 장난감 탄환 탄착 (벽·바닥): 탄환 색 링 (납작한 방울은 ToyBullets.splat, 튀는 방울은 ToyBullets.burst).
   * scale = 무기별 탄착 크기 (config/bulletVfx.ts impactScale)
   */
  toyImpact(point: THREE.Vector3, normal: THREE.Vector3, color: THREE.ColorRepresentation, scale = 1): void {
    const base = _mid.copy(point).addScaledVector(normal, 0.02);
    const ring = this.rings.spawn(base, color, 0.16, 0.05 * scale, 0.26 * scale);
    ring.spin = 0;
  }

  /** 벽·바닥: 작은 파편 + 먼지 (근접무기 벽 타격) */
  worldImpact(point: THREE.Vector3, normal: THREE.Vector3): void {
    const base = _mid.copy(point).addScaledVector(normal, 0.02);
    const puff = this.puffs.spawn(base, 0xf2ead8, 0.35, 0.08, 0.28);
    puff.vel.copy(normal).multiplyScalar(0.4);
    for (let i = 0; i < 5; i++) {
      const chip = this.chips.spawn(base, i % 2 ? 0xffffff : 0xd9cdb8, 0.3 + Math.random() * 0.15, 0.05, 0.02);
      chip.vel
        .set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        .multiplyScalar(2)
        .addScaledVector(normal, 1.6 + Math.random());
      chip.gravity = 9;
    }
  }

  /**
   * 적: 만화풍 POP (링 + 별, 방울 터짐은 ToyBullets.burst). 일반 = 탄환 색 링·작은 별 몇 개, 헤드샷 = 노란 링·노란 별 더 많고 크게.
   * scale = 무기별 명중 크기 (config/bulletVfx.ts hitScale)
   */
  enemyHit(point: THREE.Vector3, normal: THREE.Vector3, headshot: boolean, killed: boolean, color: THREE.ColorRepresentation = 0xffffff, scale = 1): void {
    const base = _mid.copy(point).addScaledVector(normal, 0.03);
    const ring = this.rings.spawn(base, headshot ? 0xffd23f : color, 0.16, 0.06 * scale, (headshot ? 0.48 : 0.3) * scale);
    ring.spin = 0;
    const count = headshot ? 7 : 3;
    const colors = headshot ? [0xffd23f, 0xffb02e, 0xffffff] : [color, 0xffffff, color];
    for (let i = 0; i < count; i++) {
      const s = this.stars.spawn(base, colors[i % colors.length]!, 0.28 + Math.random() * 0.1, (headshot ? 0.12 : 0.08) * scale, 0.03);
      s.vel
        .set(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5)
        .multiplyScalar(2.6)
        .addScaledVector(normal, 1.4);
      s.gravity = 5;
      s.spin = (Math.random() - 0.5) * 12;
    }
    if (killed) {
      // 처치: 큰 링 하나 더
      this.rings.spawn(base, 0xff5d7a, 0.32, 0.15, 0.9);
    }
  }

  /**
   * 리스폰 등장: 파스텔 링 두 개가 퍼지고 반짝이 별이 위로 톡톡 (화면 번쩍임 없음, 기존 풀 재사용).
   * feet = 발 위치, height = 캐릭터 키 (m)
   */
  spawnSparkle(feet: THREE.Vector3, height: number): void {
    const mid = _mid.copy(feet);
    mid.y += height * 0.45;
    // 링은 몸보다 크게 퍼져야 3인칭 뒤에서도 보임
    this.rings.spawn(mid, 0x9fe6ff, 0.45, 0.3 * height, 1.7 * height).spin = 0;
    this.rings.spawn(mid, 0xffb3d1, 0.55, 0.2 * height, 1.25 * height).spin = 0;
    const colors = [0xffd45e, 0x9fe6ff, 0xffb3d1, 0xb6f0c8];
    for (let i = 0; i < 8; i++) {
      const s = this.stars.spawn(mid, colors[i % colors.length]!, 0.5 + Math.random() * 0.2, 0.12, 0.04);
      const a = (i / 8) * Math.PI * 2;
      s.vel.set(Math.cos(a) * 1.4, 1.6 + Math.random() * 0.8, Math.sin(a) * 1.4);
      s.gravity = 3;
      s.spin = (Math.random() - 0.5) * 10;
    }
  }

  update(dt: number): void {
    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.follow) f.sprite.position.copy(f.follow);
      const t = 1 - Math.max(0, f.life) / FLASH_LIFE;
      // 짧게 커졌다가 줄어듦 (과한 번쩍임 방지)
      f.sprite.scale.setScalar(f.scale * (1 + 0.4 * Math.sin(t * Math.PI)));
      if (f === this.lightFlash) {
        this.flashLight.position.copy(f.sprite.position);
        this.flashLight.intensity = 1.4 * (1 - t);
      }
      if (f.life <= 0) {
        f.sprite.visible = false;
        f.follow = null;
        if (f === this.lightFlash) {
          this.flashLight.intensity = 0;
          this.lightFlash = null;
        }
      }
    }
    this.stars.update(dt);
    this.puffs.update(dt);
    this.rings.update(dt);
    this.chips.update(dt);
  }

  dispose(): void {
    for (const f of this.flashes) {
      f.mat.dispose();
      this.scene.remove(f.sprite);
    }
    this.scene.remove(this.flashLight);
    for (const pool of [this.stars, this.puffs, this.rings, this.chips]) pool.dispose(this.scene);
    for (const tex of Object.values(this.textures)) tex.dispose();
  }
}
