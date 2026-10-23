// 첫 플레이 안내 (짧은 단계별 말풍선): 해 보면 다음 단계로, 다 하면 사라지고 다시 안 나옴 (이 기기 저장).
// 로비 = 이동 → 점프, 첫 매치 = 이동 → 시점 → 사격 → 무기 교체. 전체 조작법은 일시정지 메뉴 '조작 안내'에 그대로.
// 진행 표시 = "1/2 이동". 안내 건너뛰기 = 모든 안내를 즉시 끄고 저장 (완료와 구분해 'skip'으로 기록, 다음 접속·매치 복귀에도 안 나옴).
// 상태 변화는 aria-live로 화면 읽기에도 전달.

export interface CoachStep {
  id: string;
  /** PC 안내 */
  pc: string;
  /** 터치 안내 */
  touch: string;
  /** 진행 표시에 쓰는 짧은 이름 ("1/2 이동") */
  label: string;
}

export type CoachDone = (stepId: string) => boolean;

const KEY = 'popbattle.coach';
/** 저장 목록에 이 값이 있으면 사용자가 건너뜀 (모든 안내 끔). 흐름 id(lobby·match)는 끝까지 해 본 것 */
const SKIPPED = 'skip';

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
  private readonly skipButton = document.createElement('button');
  private readonly done = loadDone();
  private flow: { id: string; steps: CoachStep[]; i: number; shownFor: number } | null = null;

  constructor(parent: HTMLElement) {
    this.root.className = 'coach hidden';
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    this.dots.className = 'coach-dots';
    const skip = this.skipButton;
    skip.type = 'button';
    skip.className = 'coach-skip';
    skip.textContent = '안내 건너뛰기';
    for (const t of ['pointerdown', 'mousedown', 'touchstart'] as const) skip.addEventListener(t, (e) => e.stopPropagation());
    skip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.skipAll();
    });
    this.root.append(this.dots, this.text, skip);
    parent.appendChild(this.root);
  }

  /** 아직 안 본 안내 흐름 시작 (이미 봤거나 진행 중이면 그대로) */
  start(id: string, steps: CoachStep[]): void {
    if (this.done.has(SKIPPED) || this.done.has(id) || this.flow?.id === id) return;
    this.flow = { id, steps, i: 0, shownFor: 0 };
  }

  /** 안내 상태: 건너뜀 / 이 흐름 끝까지 함 / 아직 */
  status(id: string): 'skipped' | 'done' | 'pending' {
    return this.done.has(SKIPPED) ? 'skipped' : this.done.has(id) ? 'done' : 'pending';
  }

  /** 지금 단계 id (단계가 바뀌었는지 게임이 알 수 있게) */
  get step(): string | null {
    const f = this.flow;
    return f ? `${f.id}:${f.steps[f.i]?.id ?? ''}` : null;
  }

  /** 다른 화면(패널·모달)이 위에 있는 동안 잠깐 숨김 — 흐름·단계는 그대로 */
  hold(): void {
    this.root.classList.add('hidden');
  }

  /** 로비(아래 가운데)와 매치(위쪽) 위치 */
  setPlace(place: 'lobby' | 'match'): void {
    this.root.classList.toggle('coach-lobby', place === 'lobby');
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
      this.dots.textContent = `${f.i + 1}/${f.steps.length} ${step.label}`;
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

  /** 건너뛰기: 즉시 숨기고 모든 안내 끔 (저장) */
  private skipAll(): void {
    this.done.add(SKIPPED);
    saveDone(this.done);
    this.stop();
  }
}
