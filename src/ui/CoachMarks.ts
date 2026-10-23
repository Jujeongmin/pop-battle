// 첫 플레이 안내 (짧은 단계별 말풍선): 해 보면 다음 단계로, 다 하면 사라지고 다시 안 나옴 (이 기기 저장).
// 로비 = 이동 → 점프, 첫 매치 = 이동 → 시점 → 사격 → 무기 교체. 전체 조작법은 일시정지 메뉴 '조작 안내'에 그대로.
// 조준점(화면 가운데)을 가리지 않게 아래쪽 가운데. 건너뛰기 가능. 상태 변화는 aria-live로 화면 읽기에도 전달.

export interface CoachStep {
  id: string;
  /** PC 안내 */
  pc: string;
  /** 터치 안내 */
  touch: string;
}

export type CoachDone = (stepId: string) => boolean;

const KEY = 'popbattle.coach';

function loadDone(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function saveDone(set: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...set]));
  } catch {
    // 저장 못 해도 이번 접속에서는 다시 안 띄움
  }
}

export class CoachMarks {
  private readonly root = document.createElement('div');
  private readonly text = document.createElement('b');
  private readonly dots = document.createElement('span');
  private readonly done = loadDone();
  private flow: { id: string; steps: CoachStep[]; i: number; shownFor: number } | null = null;

  constructor(parent: HTMLElement) {
    this.root.className = 'coach hidden';
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    this.dots.className = 'coach-dots';
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'coach-skip';
    skip.textContent = '건너뛰기';
    skip.setAttribute('aria-label', '안내 건너뛰기');
    skip.addEventListener('pointerdown', (e) => e.stopPropagation());
    skip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.finish();
    });
    this.root.append(this.dots, this.text, skip);
    parent.appendChild(this.root);
  }

  /** 아직 안 본 안내 흐름 시작 (이미 봤거나 진행 중이면 그대로) */
  start(id: string, steps: CoachStep[]): void {
    if (this.done.has(id) || this.flow?.id === id) return;
    this.flow = { id, steps, i: 0, shownFor: 0 };
  }

  /** 지금 흐름 그만 (화면 전환 등, 다음에 다시 시작) */
  stop(): void {
    this.flow = null;
    this.root.classList.add('hidden');
  }

  get active(): string | null {
    return this.flow?.id ?? null;
  }

  /** 매 프레임: 지금 단계를 해 봤으면(최소 0.6초 보인 뒤) 다음 단계 */
  update(dt: number, touch: boolean, did: CoachDone): void {
    const f = this.flow;
    if (!f) return;
    const step = f.steps[f.i]!;
    f.shownFor += dt;
    const label = touch ? step.touch : step.pc;
    if (this.text.textContent !== label) {
      this.text.textContent = label;
      this.dots.textContent = f.steps.map((_, i) => (i === f.i ? '●' : '○')).join(' ');
    }
    this.root.classList.remove('hidden');
    if (f.shownFor >= 0.6 && did(step.id)) {
      f.i++;
      f.shownFor = 0;
      if (f.i >= f.steps.length) this.finish();
    }
  }

  private finish(): void {
    if (!this.flow) return;
    this.done.add(this.flow.id);
    saveDone(this.done);
    this.stop();
  }
}
