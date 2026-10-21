import * as THREE from 'three';
import type { Physics } from '../physics/Physics';
import type { ShotResult, ShotStage } from './hitscan';

/**
 * 개발용 사격 경로 디버그 (기본 꺼짐, 개발 서버에서만 켤 수 있음: 디버그 패널 ` 또는 콘솔 __game.setShotDebug(true)).
 * 발사한 탄마다 4초간 표시 (최근 24발):
 * - 하늘색 선: 카메라 조준 레이 (카메라 중앙선, 탄퍼짐 적용) → 하늘색 점: 카메라가 정한 조준 목표
 * - 초록 점: 실제 총구 (탄 시작)
 * - 주황 선: 총구에서 나간 실제 탄 경로 → 빨강 점(장애물) / 분홍 점(캐릭터): 실제 충돌 위치
 * - 회색 선: 탄이 막혀 못 간 나머지 (실제 충돌 위치 → 조준 목표)
 * - 노랑 선: 가슴 → 총구 구간에서 막힘 (총구가 장애물 안·뒤)
 * - 글자: 충돌한 물체 이름 · 총구에서 거리 · 막힌 구간
 * 매 프레임 미리보기 (탄퍼짐 없는 화면 중앙 기준): 옅은 하늘색·주황 선.
 * 깊이 무시로 벽 뒤에 있어도 보인다.
 */
export class ShotPathDebug {
  private readonly group = new THREE.Group();
  private readonly traces: Array<{ obj: THREE.Group; life: number }> = [];
  private readonly preview: { aim: THREE.Line; path: THREE.Line; aimPos: THREE.BufferAttribute; pathPos: THREE.BufferAttribute };
  private readonly dotGeo = new THREE.SphereGeometry(1, 10, 8);
  private readonly mats = {
    aim: lineMat(0x38d6ff),
    path: lineMat(0xff9a1f),
    rest: lineMat(0x9aa0aa, 0.6),
    muzzleBlock: lineMat(0xffe14d),
    previewAim: lineMat(0x38d6ff, 0.35),
    previewPath: lineMat(0xff9a1f, 0.45),
    aimDot: dotMat(0x38d6ff),
    muzzleDot: dotMat(0x22dd66),
    worldDot: dotMat(0xff3b3b),
    charDot: dotMat(0xff4dd2),
  };
  /** 최근 탄 기록 (테스트·콘솔 확인용, 최대 64개) */
  readonly history: Array<{ weapon: string; stage: ShotStage; target: string; muzzleDist: number; aimToEnd: number }> = [];

  constructor(
    private readonly scene: THREE.Scene,
    private readonly physics: Physics,
  ) {
    const mk = (mat: THREE.LineBasicMaterial) => {
      const pos = new THREE.BufferAttribute(new Float32Array(6), 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', pos);
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      line.renderOrder = 31;
      this.group.add(line);
      return { line, pos };
    };
    const a = mk(this.mats.previewAim);
    const p = mk(this.mats.previewPath);
    this.preview = { aim: a.line, path: p.line, aimPos: a.pos, pathPos: p.pos };
    this.group.visible = false;
    scene.add(this.group);
  }

  get enabled(): boolean {
    return this.group.visible;
  }

  set enabled(v: boolean) {
    this.group.visible = v;
    if (!v) this.clear();
  }

  /** 발사한 탄 1발 기록 */
  add(r: ShotResult): void {
    if (!this.group.visible) return;
    const g = new THREE.Group();
    const from = r.from;
    if (r.aimDebug) g.add(this.line(r.aimDebug.origin, r.aimPoint, this.mats.aim));
    g.add(this.dot(r.aimPoint, 0.04, this.mats.aimDot));
    g.add(this.dot(from, 0.03, this.mats.muzzleDot));
    if (r.stage === 'muzzle' && r.aimDebug) g.add(this.line(r.aimDebug.chest, from, this.mats.muzzleBlock));
    else g.add(this.line(from, r.end, this.mats.path));
    if (r.stage !== 'clear') g.add(this.line(r.end, r.aimPoint, this.mats.rest));
    const target = r.hit ? this.physics.labelOf(r.hit.collider) : '없음 (사거리 끝)';
    if (r.hit) g.add(this.dot(r.end, 0.05, r.hit.hitbox ? this.mats.charDot : this.mats.worldDot));
    const dist = from.distanceTo(r.end);
    const stageText = r.stage === 'clear' ? '조준점 도달' : r.stage === 'muzzle' ? '총구가 장애물 안·뒤' : '총구→조준점 막힘';
    g.add(label(`${target} · ${dist.toFixed(1)}m · ${stageText}`, r.end));
    this.group.add(g);
    this.traces.push({ obj: g, life: 4 });
    while (this.traces.length > 24) this.remove(this.traces.shift()!);
    this.history.push({ weapon: r.weapon?.id ?? '-', stage: r.stage, target, muzzleDist: dist, aimToEnd: r.end.distanceTo(r.aimPoint) });
    if (this.history.length > 64) this.history.shift();
  }

  /** 매 프레임: 오래된 표시 정리 + 화면 중앙 미리보기 (예측 경로, 없으면 숨김) */
  update(dt: number, predicted: ShotResult | null): void {
    if (!this.group.visible) return;
    for (let i = this.traces.length - 1; i >= 0; i--) {
      const t = this.traces[i]!;
      t.life -= dt;
      if (t.life <= 0) {
        this.remove(t);
        this.traces.splice(i, 1);
      }
    }
    const show = !!predicted?.aimDebug;
    this.preview.aim.visible = this.preview.path.visible = show;
    if (!show) return;
    const p = predicted!;
    set(this.preview.aimPos, p.aimDebug!.origin, p.aimPoint);
    set(this.preview.pathPos, p.from, p.end);
  }

  private line(a: THREE.Vector3, b: THREE.Vector3, mat: THREE.LineBasicMaterial): THREE.Line {
    const geo = new THREE.BufferGeometry().setFromPoints([a.clone(), b.clone()]);
    const l = new THREE.Line(geo, mat);
    l.frustumCulled = false;
    l.renderOrder = 31;
    return l;
  }

  private dot(p: THREE.Vector3, r: number, mat: THREE.MeshBasicMaterial): THREE.Mesh {
    const m = new THREE.Mesh(this.dotGeo, mat);
    m.position.copy(p);
    m.scale.setScalar(r);
    m.renderOrder = 32;
    return m;
  }

  private remove(t: { obj: THREE.Group }): void {
    t.obj.removeFromParent();
    t.obj.traverse((o) => {
      if ((o as THREE.Line).isLine) (o as THREE.Line).geometry.dispose();
      const s = o as THREE.Sprite;
      if (s.isSprite) {
        s.material.map?.dispose();
        s.material.dispose();
      }
    });
  }

  private clear(): void {
    for (const t of this.traces) this.remove(t);
    this.traces.length = 0;
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.group);
    this.preview.aim.geometry.dispose();
    this.preview.path.geometry.dispose();
    this.dotGeo.dispose();
    Object.values(this.mats).forEach((m) => m.dispose());
  }
}

function lineMat(color: number, opacity = 1): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity });
}

function dotMat(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
}

function set(attr: THREE.BufferAttribute, a: THREE.Vector3, b: THREE.Vector3): void {
  attr.setXYZ(0, a.x, a.y, a.z);
  attr.setXYZ(1, b.x, b.y, b.z);
  attr.needsUpdate = true;
}

/** 화면 크기 고정 글자 (깊이 무시) */
function label(text: string, at: THREE.Vector3): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 48;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 26px sans-serif';
  const w = Math.min(512, ctx.measureText(text).width + 20);
  ctx.fillStyle = 'rgba(20, 24, 40, 0.75)';
  ctx.fillRect(0, 4, w, 40);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 10, 25);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false });
  const s = new THREE.Sprite(mat);
  s.center.set(0, 0);
  s.scale.set(0.32, 0.03, 1);
  s.position.copy(at);
  s.renderOrder = 33;
  return s;
}
