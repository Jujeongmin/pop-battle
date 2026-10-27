// 첫 로딩 진행률: 단계별 비중 × 단계 안 진행도. 파일 단계(에셋·맵)는 받은 바이트로 채움.
// 진행률은 줄어들지 않음 (단계가 넘어가면 앞 단계는 다 찬 것으로).
// 바의 앞부분(bootShare)은 게임 코드(JS 청크) 받기 — index.html이 채우고, 게임 코드가 시작되면 여기서 이어받음
export type LoadStage = 'engine' | 'assets' | 'map' | 'setup' | 'render';

/** 게임 코드 받기 뒤 단계 비중 (합 100): 실제 체감 시간 비율에 맞춤 — 파일 받기(에셋·맵)가 대부분, 첫 화면 준비(셰이더)가 그다음 */
const WEIGHTS: Record<LoadStage, number> = { engine: 8, assets: 44, map: 20, setup: 12, render: 16 };
const ORDER = Object.keys(WEIGHTS) as LoadStage[];
const TOTAL = ORDER.reduce((s, k) => s + WEIGHTS[k], 0);

/** 파일 하나 진행 (로더 onProgress에 progress, 끝나면 done) */
export interface FileTrack {
  progress(e: ProgressEvent): void;
  done(): void;
}
/** 파일 단계에서 받을 파일마다 하나씩 */
export type TrackFile = (url: string) => FileTrack;

export interface LoadReporter {
  /** 다음 단계 시작 (앞 단계는 다 찬 것으로) */
  stage(s: LoadStage): void;
  /** 지금 단계 안 진행도 0~1 */
  part(f: number): void;
  /** 지금 단계를 파일 바이트로 채우는 추적기 (같은 틱에 모든 파일을 등록해야 비율이 맞음) */
  files(): TrackFile;
}

export class LoadProgress implements LoadReporter {
  private current: LoadStage = 'engine';
  private frac = 0;

  constructor(
    private readonly onChange: (value: number, stage: LoadStage) => void,
    private readonly bootShare = 0,
  ) {}

  get value(): number {
    let done = 0;
    for (const s of ORDER) {
      if (s === this.current) return this.bootShare + ((1 - this.bootShare) * (done + WEIGHTS[s] * this.frac)) / TOTAL;
      done += WEIGHTS[s];
    }
    return 1;
  }

  stage(s: LoadStage): void {
    if (ORDER.indexOf(s) <= ORDER.indexOf(this.current) && s !== 'engine') return;
    this.current = s;
    this.frac = 0;
    this.onChange(this.value, s);
  }

  part(f: number): void {
    const v = Math.min(1, Math.max(0, f));
    if (v <= this.frac) return;
    this.frac = v;
    this.onChange(this.value, this.current);
  }

  files(): TrackFile {
    const stage = this.current;
    const list: { got: number; done: boolean }[] = [];
    const update = (): void => {
      if (this.current !== stage || list.length === 0) return;
      let sum = 0;
      for (const f of list) sum += f.done ? 1 : f.got;
      // 마지막 조금은 다음 단계 시작 때 (받은 뒤 해석·텍스처 준비 몫)
      this.part((0.96 * sum) / list.length);
    };
    return () => {
      const f = { got: 0, done: false };
      list.push(f);
      return {
        // gzip 응답은 total(압축 크기)보다 loaded(푼 크기)가 커질 수 있음 → 0.98에서 멈추고 done에서 채움
        progress: (e) => {
          if (!e.lengthComputable || e.total <= 0) return;
          f.got = Math.max(f.got, Math.min(0.98, e.loaded / e.total));
          update();
        },
        done: () => {
          f.done = true;
          update();
        },
      };
    };
  }
}
