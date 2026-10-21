import type { WeaponMount } from '../config/weapons';

type Vec3Key = { [K in keyof WeaponMount]-?: WeaponMount[K] extends [number, number, number] ? K : never }[keyof WeaponMount];
type NumKey = { [K in keyof WeaponMount]-?: WeaponMount[K] extends number ? K : never }[keyof WeaponMount];
type BoolKey = { [K in keyof WeaponMount]-?: WeaponMount[K] extends boolean ? K : never }[keyof WeaponMount];
type Swing = NonNullable<WeaponMount['swing']>;
type SwingNumKey = { [K in keyof Swing]-?: NonNullable<Swing[K]> extends number ? K : never }[keyof Swing];
/** 선택 필드 포함 3성분 값 (rightElbowPole 등) */
type AnyVec3Key = { [K in keyof WeaponMount]-?: NonNullable<WeaponMount[K]> extends [number, number, number] ? K : never }[keyof WeaponMount];

interface Field {
  label: string;
  min: number;
  max: number;
  step: number;
}

const VEC_FIELDS: Array<[Vec3Key, Field]> = [
  ['modelFixDeg', { label: '모델 보정 회전(도)', min: -180, max: 180, step: 1 }],
  ['holdOffset', { label: '그립 위치 (오른쪽/위/앞, m)', min: -0.4, max: 0.4, step: 0.005 }],
  ['rightGrip', { label: '오른손 그립 (총 공간)', min: -0.6, max: 0.6, step: 0.005 }],
  ['supportGrip', { label: '왼손 지지점 (총 공간)', min: -0.6, max: 0.6, step: 0.005 }],
  ['muzzle', { label: '총구 (총 공간)', min: -0.6, max: 0.6, step: 0.005 }],
  ['rightFingerDir', { label: '오른손 손가락 방향', min: -1, max: 1, step: 0.05 }],
  ['rightPalmDir', { label: '오른손 손바닥 방향', min: -1, max: 1, step: 0.05 }],
  ['leftFingerDir', { label: '왼손 손가락 방향', min: -1, max: 1, step: 0.05 }],
  ['leftPalmDir', { label: '왼손 손바닥 방향', min: -1, max: 1, step: 0.05 }],
];
const NUM_FIELDS: Array<[NumKey, Field]> = [
  ['scale', { label: '총 크기', min: 0.2, max: 1.2, step: 0.01 }],
  ['shoulderAssist', { label: '쇄골 보조', min: 0, max: 1, step: 0.05 }],
  ['armStretchMax', { label: '팔 늘림 최대', min: 1, max: 2.5, step: 0.05 }],
];
const BOOL_FIELDS: Array<[BoolKey, string]> = [
  ['ikEnabled', '팔 IK 사용'],
  ['leftHandIk', '왼손 IK 사용'],
];

/** 근접무기(뿅망치) 평소 자세 */
const MELEE_POSE_VECS: Array<[AnyVec3Key, Field]> = [
  ['holdOffset', { label: '손 위치 (가슴 기준 오른쪽/위/앞, m)', min: -0.2, max: 0.5, step: 0.005 }],
  ['rightElbowPole', { label: '팔꿈치 방향 (오른쪽/위/앞)', min: -1.5, max: 1.5, step: 0.05 }],
];
const MELEE_POSE_NUMS: Array<[SwingNumKey, Field]> = [
  // 90° 이상은 코드에서 잘리고 손잡이 축 회전이 뒤집힘 → 뒤로 눕히기는 방향(yaw) 90° 이상으로
  ['restPitchDeg', { label: '손잡이 세움(도)', min: 0, max: 85, step: 1 }],
  ['restYawDeg', { label: '눕힐 방향(도, +오른쪽 90 / 뒤 180)', min: -180, max: 180, step: 1 }],
  ['headClearance', { label: '얼굴과 최소 간격(m)', min: 0, max: 0.15, step: 0.005 }],
];
const MELEE_GRIP_VECS: Array<[Vec3Key, Field]> = [
  ['rightGrip', { label: '손목 위치 (망치 공간, z = 쥐는 높이)', min: -0.5, max: 0.5, step: 0.005 }],
  ['rightFingerDir', { label: '손가락 방향 (망치 공간)', min: -1, max: 1, step: 0.05 }],
  ['rightPalmDir', { label: '손바닥 방향 (망치 공간)', min: -1, max: 1, step: 0.05 }],
];
const MELEE_SWING_NUMS: Array<[SwingNumKey, Field]> = [
  ['overheadWindupDeg', { label: '내려찍기: 들어 올림 각(도, 90 = 수직)', min: 60, max: 170, step: 1 }],
  ['overheadStrikeDeg', { label: '내려찍기: 찍는 각(도, 0 = 정면)', min: -80, max: 30, step: 1 }],
  ['overheadPlaneOutDeg', { label: '내려찍기: 바깥 기울임(도)', min: 0, max: 60, step: 1 }],
  ['windupPitchDeg', { label: '들어 올림 세움(도)', min: 0, max: 89, step: 1 }],
  ['windupYawDeg', { label: '들어 올림 방향(도)', min: -180, max: 180, step: 1 }],
  ['strikePitchDeg', { label: '내려침 세움(도)', min: -60, max: 89, step: 1 }],
  ['strikeYawDeg', { label: '내려침 방향(도)', min: -180, max: 180, step: 1 }],
  ['swingRollDeg', { label: '휘두를 때 손목 돌림(도)', min: -180, max: 180, step: 1 }],
  ['windupAt', { label: '들어 올림 끝 (0~1)', min: 0.05, max: 0.9, step: 0.01 }],
  ['strikeAt', { label: '내려침 끝 (0~1)', min: 0.1, max: 0.95, step: 0.01 }],
];
/** 기존 기본 팔꿈치 방향 (PlayerAvatar.solveArm 기본값과 같음, 몸 기준 오른쪽/위/앞) */
const DEFAULT_RIGHT_ELBOW_POLE: [number, number, number] = [0.6, -1, -0.35];

export interface ExtraSlider extends Field {
  get: () => number;
  set: (v: number) => void;
}

export interface MeleeSection {
  mount: WeaponMount;
  /** 손목 자동 맞춤 1회 (지금 프레임 아래팔 방향 기준). 근접무기를 들고 있지 않으면 false */
  solveGrip: () => boolean;
  /** 지금 근접무기를 들고 있는지 */
  equipped: () => boolean;
}

/** 개발자용 무기 장착 조절 패널 (` 키). 값은 실시간 반영, "값 복사"로 config에 붙여 넣는다. */
export class DebugPanel {
  private readonly root: HTMLDivElement;
  private readonly status: HTMLPreElement;
  /** 입력칸을 현재 값으로 다시 맞추는 함수들 (자동 맞춤 등 코드가 값을 바꾼 뒤) */
  private readonly syncs: Array<() => void> = [];
  visible = false;

  constructor(
    parent: HTMLElement,
    private readonly mount: WeaponMount,
    private readonly onChange: () => void,
    extraToggles: Array<{ label: string; get: () => boolean; set: (v: boolean) => void }> = [],
    melee?: MeleeSection,
    extraSliders: ExtraSlider[] = [],
  ) {
    this.root = document.createElement('div');
    this.root.className = 'debug-panel hidden';
    const title = document.createElement('div');
    title.className = 'dp-title';
    title.textContent = '무기 장착 디버그 ( ` 로 닫기 )';
    this.root.appendChild(title);

    for (const t of extraToggles) this.root.appendChild(this.checkbox(t.label, t.get, t.set));
    for (const s of extraSliders) this.root.appendChild(this.slider(s, s.get, s.set, s.label));

    if (melee) this.root.appendChild(this.meleeSection(melee));

    const rifle = this.section('라이플 장착', false);
    for (const [key, label] of BOOL_FIELDS) {
      rifle.appendChild(this.checkbox(label, () => this.mount[key], (v) => (this.mount[key] = v)));
    }
    for (const [key, f] of NUM_FIELDS) {
      rifle.appendChild(this.slider(f, () => this.mount[key], (v) => (this.mount[key] = v), f.label));
    }
    for (const [key, f] of VEC_FIELDS) rifle.appendChild(this.vecGroup(this.mount, key, f));
    rifle.appendChild(this.copyButton('값 복사 (JSON)', () => JSON.stringify(this.mount, null, 2), '[WeaponMount]'));
    this.root.appendChild(rifle);

    this.status = document.createElement('pre');
    this.status.className = 'dp-status';
    this.root.appendChild(this.status);
    parent.appendChild(this.root);
  }

  /** 제목 바로 아래에 섹션 추가 (CHARACTER DEBUG 등 외부 섹션) */
  prepend(el: HTMLElement): void {
    this.root.insertBefore(el, this.root.children[1] ?? null);
  }

  toggle(): boolean {
    this.visible = !this.visible;
    this.root.classList.toggle('hidden', !this.visible);
    if (this.visible) this.refresh();
    return this.visible;
  }

  /** 입력칸을 현재 값으로 다시 맞춤 */
  refresh(): void {
    for (const s of this.syncs) s();
  }

  setStatus(text: string): void {
    if (this.visible) this.status.textContent = text;
  }

  private meleeSection(melee: MeleeSection): HTMLDetailsElement {
    const m = melee.mount;
    const sw = m.swing!;
    const box = this.section('뿅망치 자세 (3번 무기를 들고 조절)', true);
    const hint = document.createElement('div');
    hint.className = 'dp-hint';
    hint.textContent = '값을 바꾸면 바로 적용. 손 위치·각도를 바꾼 뒤 "손목 자동 맞춤"을 누르면 손목이 꺾이지 않게 손 방향을 다시 맞춤.';
    box.appendChild(hint);

    for (const [key, f] of MELEE_POSE_VECS) {
      if (key === 'rightElbowPole' && !m.rightElbowPole) m.rightElbowPole = [...DEFAULT_RIGHT_ELBOW_POLE];
      box.appendChild(this.vecGroup(m, key, f));
    }
    for (const [key, f] of MELEE_POSE_NUMS) {
      box.appendChild(this.slider(f, () => sw[key] ?? 0, (v) => (sw[key] = v), f.label));
    }
    box.appendChild(this.slider({ label: '망치 크기', min: 0.2, max: 0.6, step: 0.01 }, () => m.scale, (v) => (m.scale = v), '망치 크기'));

    const solve = document.createElement('button');
    solve.textContent = '손목 자동 맞춤';
    solve.onclick = async () => {
      if (!melee.equipped()) {
        solve.textContent = '먼저 3번(뿅망치)을 드세요';
        setTimeout(() => (solve.textContent = '손목 자동 맞춤'), 1500);
        return;
      }
      // 손 방향을 바꾸면 팔 자세도 조금 바뀌므로 몇 프레임에 걸쳐 반복
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        if (!melee.solveGrip()) break;
      }
      this.refresh();
    };
    box.appendChild(solve);

    const grip = this.section('손 쥐는 방향 (고급)', false);
    for (const [key, f] of MELEE_GRIP_VECS) grip.appendChild(this.vecGroup(m, key, f));
    box.appendChild(grip);

    const swing = this.section('공격 동작', false);
    for (const [key, f] of MELEE_SWING_NUMS) {
      swing.appendChild(this.slider(f, () => sw[key] ?? 0, (v) => (sw[key] = v), f.label));
    }
    box.appendChild(swing);

    box.appendChild(
      this.copyButton(
        '뿅망치 값 복사 (config용)',
        () => {
          const pick = {
            scale: m.scale,
            rightGrip: m.rightGrip,
            rightFingerDir: m.rightFingerDir,
            rightPalmDir: m.rightPalmDir,
            holdOffset: m.holdOffset,
            rightElbowPole: m.rightElbowPole,
            swing: sw,
          };
          return JSON.stringify(pick, null, 2);
        },
        '[MELEE_MOUNT]',
      ),
    );
    return box;
  }

  private section(title: string, open: boolean): HTMLDetailsElement {
    const d = document.createElement('details');
    d.className = 'dp-section';
    d.open = open;
    const s = document.createElement('summary');
    s.textContent = title;
    d.appendChild(s);
    return d;
  }

  private vecGroup(mount: WeaponMount, key: AnyVec3Key, f: Field): HTMLFieldSetElement {
    const group = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = f.label;
    group.appendChild(legend);
    ['x', 'y', 'z'].forEach((axis, i) => {
      group.appendChild(this.slider(f, () => mount[key]?.[i] ?? 0, (v) => {
        const vec = mount[key];
        if (vec) vec[i] = v;
      }, axis));
    });
    return group;
  }

  private copyButton(text: string, json: () => string, tag: string): HTMLButtonElement {
    const copy = document.createElement('button');
    copy.textContent = text;
    copy.onclick = () => {
      const s = json();
      void navigator.clipboard?.writeText(s).catch(() => undefined);
      console.info(tag, s);
      copy.textContent = '복사됨 (콘솔에도 출력)';
      setTimeout(() => (copy.textContent = text), 1200);
    };
    return copy;
  }

  private checkbox(label: string, get: () => boolean, set: (v: boolean) => void): HTMLLabelElement {
    const row = document.createElement('label');
    row.className = 'dp-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = get();
    input.onchange = () => {
      set(input.checked);
      this.onChange();
    };
    this.syncs.push(() => (input.checked = get()));
    row.append(input, document.createTextNode(` ${label}`));
    return row;
  }

  private slider(f: Field, get: () => number, set: (v: number) => void, label: string): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'dp-row';
    const name = document.createElement('span');
    name.textContent = label;
    name.title = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(f.min);
    input.max = String(f.max);
    input.step = String(f.step);
    const num = document.createElement('input');
    num.type = 'number';
    num.step = String(f.step);
    const show = (v: number) => {
      input.value = String(v);
      num.value = String(Number(v.toFixed(4)));
    };
    show(get());
    this.syncs.push(() => show(get()));
    const apply = (v: number) => {
      if (!Number.isFinite(v)) return;
      set(v);
      show(v);
      this.onChange();
    };
    input.oninput = () => apply(Number(input.value));
    num.onchange = () => apply(Number(num.value));
    row.append(name, input, num);
    return row;
  }

  dispose(): void {
    this.root.remove();
  }
}
