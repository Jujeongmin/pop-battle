// 첫 로딩 화면: index.html에 처음부터 있는 #loading(배경 그림·로고·진행 바)을 받아 진행률·단계 글·오류·사라지기를 맡음.
// - 배경 그림(Codex 원본 art-src/loading/)은 캐릭터가 모인 영역(SAFE)이 로고 아래·진행 바 위에 온전히 들어오게
//   크기·위치를 화면마다 계산. 화면을 다 덮을 수 있으면 덮고, 덮으면 캐릭터가 잘리는 비율이면 줄이고 남는 곳은 흐린 같은 그림
// - 글은 한국어/영어 직접 (번역기는 data-i18n-skip으로 건너뜀)
// - 한동안 진행이 멈추면 느린 연결 안내 + 다시 시도, 실패하면 이유별 안내 + 다시 시도(새로 고침)
import { getLang, type Lang } from '../../i18n/lang';
import type { LoadStage } from '../../core/loadProgress';

/** 원본 그림 크기와 캐릭터가 모인 영역 (가장자리 비율, 총구·모자·신발 끝 + 약간의 여유) */
const ART = { w: 1672, h: 941 };
const SAFE = { x0: 0.14, x1: 0.87, y0: 0.235, y1: 0.9 };
/** 이 시간 동안 진행률이 그대로면 느린 연결 안내 */
const STALL_MS = 15000;

type TextKey = LoadStage | 'boot' | 'done' | 'slow' | 'retry' | 'errTitle' | 'errNet' | 'errGl' | 'errLost' | 'errOther';
const TEXT: Record<Lang, Record<TextKey, string>> = {
  ko: {
    boot: '불러오는 중…',
    engine: '물리 엔진 준비 중…',
    assets: '캐릭터와 장난감 총 불러오는 중…',
    map: '장난감 마을 짓는 중…',
    setup: '친구들 모으는 중…',
    render: '화면 준비 중…',
    done: '준비 완료!',
    slow: '연결이 조금 느려요. 잠시만 기다려 주세요.',
    retry: '다시 시도',
    errTitle: '게임을 불러오지 못했어요',
    errNet: '게임 파일을 받지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.',
    errGl: '이 브라우저에서 3D 그래픽(WebGL)을 켤 수 없어요. 브라우저를 최신으로 업데이트하거나 하드웨어 가속을 켜 주세요.',
    errLost: '그래픽 장치가 초기화됐어요. 다시 시도해 주세요.',
    errOther: '게임을 준비하다 문제가 생겼어요. 다시 시도해 주세요.',
  },
  en: {
    boot: 'Loading…',
    engine: 'Starting physics…',
    assets: 'Loading characters & toy blasters…',
    map: 'Building toy town…',
    setup: 'Gathering players…',
    render: 'Getting the screen ready…',
    done: 'Ready!',
    slow: 'Connection is a little slow. Please wait…',
    retry: 'Try again',
    errTitle: "Couldn't load the game",
    errNet: "Couldn't download game files. Check your internet connection and try again.",
    errGl: "3D graphics (WebGL) aren't available in this browser. Update your browser or turn on hardware acceleration.",
    errLost: 'The graphics device was reset. Please try again.',
    errOther: 'Something went wrong while starting the game. Please try again.',
  },
};

export type LoadFailKind = 'net' | 'gl' | 'lost' | 'other';

/** 오류 종류 추정: WebGL 생성 실패 / 파일 받기 실패(오프라인·로드 실패·청크) / 그 밖 */
export function failKind(err: unknown): LoadFailKind {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  if (/webgl|context/i.test(msg)) return 'gl';
  if ((typeof navigator !== 'undefined' && navigator.onLine === false) || /fetch|network|load failed|로드 실패|404|dynamically imported/i.test(msg)) return 'net';
  return 'other';
}

export class LoadingScreen {
  private readonly lang = getLang();
  private readonly art: HTMLImageElement | null;
  private readonly logo: HTMLElement | null;
  private readonly foot: HTMLElement | null;
  private readonly text: HTMLElement | null;
  private readonly pct: HTMLElement | null;
  private readonly fill: HTMLElement | null;
  private readonly resizeObs: ResizeObserver | null;
  private shown = 0;
  private lastMove = performance.now();
  private stallTimer = 0;
  private slowEl: HTMLElement | null = null;
  private failed = false;
  private finished = false;

  constructor(private readonly root: HTMLElement) {
    this.art = root.querySelector<HTMLImageElement>('.ld-art');
    this.logo = root.querySelector<HTMLElement>('.ld-logo');
    this.foot = root.querySelector<HTMLElement>('.ld-foot');
    this.text = root.querySelector<HTMLElement>('.ld-text');
    this.pct = root.querySelector<HTMLElement>('.ld-pct');
    this.fill = root.querySelector<HTMLElement>('.ld-fill');
    this.say('boot');
    // index.html이 채우던 게임 코드 받기 진행을 이어받음 (그쪽은 이제 바를 건드리지 않음)
    const boot = (window as { __popBoot?: { frac: number; taken?: boolean } }).__popBoot;
    if (boot) boot.taken = true;
    this.shown = Number.parseFloat(this.fill?.style.width ?? '') / 100 || 0;
    // 그림 배치: 그림·로고가 준비되거나 화면 크기가 바뀔 때마다 (세로 기기 회전 포함)
    this.resizeObs = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.layout()) : null;
    this.resizeObs?.observe(root);
    if (this.art) {
      if (this.art.complete && this.art.naturalWidth > 0) this.layout();
      else this.art.addEventListener('load', () => this.layout(), { once: true });
      // 그림을 못 받아도 게임 로딩은 계속 (하늘색 바탕 + 로고 + 진행 바)
      this.art.addEventListener('error', () => root.classList.add('ld-noart'), { once: true });
      if (this.art.complete && this.art.naturalWidth === 0 && this.art.currentSrc) root.classList.add('ld-noart');
    }
    this.logo?.addEventListener('load', () => this.layout(), { once: true });
    this.stallTimer = window.setInterval(() => this.checkStall(), 1000);
  }

  /** 단계·진행률 (0~1, 줄어들지 않음). 끝나기 전에는 99%까지만 */
  update(value: number, stage: LoadStage): void {
    if (this.failed || this.finished) return;
    this.say(stage);
    this.setValue(Math.min(0.99, value));
  }

  /** 100% → 잠깐 보여 주고 서서히 사라짐 → 화면에서 제거 */
  async finish(): Promise<void> {
    if (this.failed || this.finished) return;
    this.finished = true;
    this.stopWatch();
    this.say('done');
    this.setValue(1);
    await wait(280);
    this.root.classList.add('ld-out');
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      this.root.addEventListener('transitionend', done, { once: true });
      setTimeout(done, 700);
    });
    this.resizeObs?.disconnect();
    this.root.remove();
  }

  /** 실패 안내 + 다시 시도 (새로 고침). 진행 바 자리에 안내 카드 */
  fail(err: unknown, kind: LoadFailKind = failKind(err)): void {
    if (this.finished || this.failed) return;
    this.failed = true;
    this.stopWatch();
    const t = TEXT[this.lang];
    this.root.classList.add('ld-failed');
    this.slowEl?.remove();
    const card = document.createElement('div');
    card.className = 'ld-err';
    card.setAttribute('role', 'alert');
    const title = document.createElement('b');
    title.className = 'ld-err-title';
    title.textContent = t.errTitle;
    const msg = document.createElement('p');
    msg.className = 'ld-err-msg';
    msg.textContent = kind === 'net' ? t.errNet : kind === 'gl' ? t.errGl : kind === 'lost' ? t.errLost : t.errOther;
    const detail = document.createElement('small');
    detail.className = 'ld-err-detail';
    detail.textContent = err instanceof Error ? err.message : String(err);
    card.append(title, msg, detail, this.retryButton());
    this.root.append(card);
  }

  private retryButton(): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ld-retry';
    b.textContent = TEXT[this.lang].retry;
    b.addEventListener('click', () => location.reload());
    return b;
  }

  private say(key: TextKey): void {
    const s = TEXT[this.lang][key];
    if (this.text && this.text.textContent !== s) this.text.textContent = s;
  }

  private setValue(v: number): void {
    if (v <= this.shown) return;
    this.shown = v;
    this.lastMove = performance.now();
    this.slowEl?.remove();
    this.slowEl = null;
    const p = Math.floor(v * 100);
    this.root.style.setProperty('--ld-p', String(v));
    this.root.setAttribute('aria-valuenow', String(p));
    if (this.pct) this.pct.textContent = `${p}%`;
    if (this.fill) this.fill.style.width = `${(v * 100).toFixed(1)}%`;
  }

  private checkStall(): void {
    if (this.slowEl || performance.now() - this.lastMove < STALL_MS) return;
    const box = document.createElement('div');
    box.className = 'ld-slow';
    const msg = document.createElement('span');
    msg.textContent = TEXT[this.lang].slow;
    box.append(msg, this.retryButton());
    this.foot?.append(box);
    this.slowEl = box;
  }

  private stopWatch(): void {
    clearInterval(this.stallTimer);
    this.slowEl?.remove();
    this.slowEl = null;
  }

  /**
   * 배경 그림 배치: 캐릭터 영역이 [로고 아래, 진행 바 위] × [좌우 1% 안]에 다 들어오는 가장 큰 크기 중 화면을 덮는 크기까지.
   * 위치는 덮을 수 있으면 덮고(빈틈 없음), 캐릭터가 잘리면 안전 우선. 빈틈이 생기는 축은 가장자리를 흐리게 → 뒤의 흐린 그림과 이어짐
   */
  private layout(): void {
    const art = this.art;
    if (!art || this.finished) return;
    const W = this.root.clientWidth;
    const H = this.root.clientHeight;
    if (W <= 0 || H <= 0) return;
    const top = this.logo ? this.logo.offsetTop + this.logo.offsetHeight + 4 : 0;
    const bottom = this.foot ? H - this.foot.offsetTop + 6 : 0;
    const sideX = W * 0.01;
    const boxW = (SAFE.x1 - SAFE.x0) * ART.w;
    const boxH = (SAFE.y1 - SAFE.y0) * ART.h;
    const cover = Math.max(W / ART.w, H / ART.h);
    const s = Math.max(0.05, Math.min(cover, (H - top - bottom + H * 0.03) / boxH, (W - 2 * sideX + W * 0.03) / boxW));
    const dw = ART.w * s;
    const dh = ART.h * s;
    const x = place(W, dw, SAFE.x0, SAFE.x1, sideX, sideX);
    const y = place(H, dh, SAFE.y0, SAFE.y1, top, bottom);
    const gapX = x > 0.5 || x + dw < W - 0.5;
    const gapY = y > 0.5 || y + dh < H - 0.5;
    const st = art.style;
    st.left = `${x}px`;
    st.top = `${y}px`;
    st.width = `${dw}px`;
    st.height = `${dh}px`;
    this.root.classList.add('ld-placed');
    this.root.classList.toggle('ld-gap-x', gapX);
    this.root.classList.toggle('ld-gap-y', gapY);
  }
}

/** 한 축 위치: 안전 영역을 남는 띠 가운데에 → 화면을 덮는 범위로 → 그래도 캐릭터가 띠를 벗어나면 안전 범위로 (안전 우선) */
function place(view: number, size: number, a0: number, a1: number, lo: number, hi: number): number {
  // 신발 끝·총구 끝이 띠를 몇 px 넘는 정도(화면의 2%)는 덮기를 우선 (16:9에서 가장자리 흐림이 생기지 않게)
  const tol = view * 0.02;
  const safeMin = lo - a0 * size - tol;
  const safeMax = view - hi - a1 * size + tol;
  let pos = lo + (view - lo - hi - (a1 - a0) * size) / 2 - a0 * size;
  if (size >= view) pos = Math.min(0, Math.max(view - size, pos));
  const safe = Math.min(Math.max(pos, safeMin), Math.max(safeMin, safeMax));
  // 덮을 수 있는 크기에서 몇 px만 어긋나면 덮기로 (가장자리 흐림 대신)
  if (size >= view && Math.abs(safe - pos) <= tol) return pos;
  return safe;
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
