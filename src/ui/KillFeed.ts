/**
 * 실시간 킬로그 (화면 우측 상단). 확정된 사망 이벤트만 받아 표시하는 HUD 전용 모듈 — 전투·점수 로직과 무관.
 * - 새 항목이 맨 위, 최대 4개 (넘치면 가장 오래된 것부터 제거), 5초 유지 후 0.3초 페이드아웃
 * - 타이머를 만들지 않고 Hud 매 프레임 update(now)에서 만료만 확인 (항목 ≤ 4개)
 */

/** 사망 원인: 무기 처치 / 자살(사망 테스트 키) / 낙사 / 그 밖의 처치자 없는 피해 */
export type DeathCause = 'weapon' | 'suicide' | 'fall' | 'environment';

export interface KillFeedEvent {
  /** 처치자 (없으면 자살·환경 사망) */
  killerId: string | null;
  killerName: string | null;
  victimId: string;
  victimName: string;
  /** 실제로 마지막 피해를 준 무기 id (WEAPONS 키). 원인이 무기가 아니면 null */
  weaponId: string | null;
  /** 마지막 피해가 헤드샷 배율 사격이었는지 (전투 판정 결과 그대로) */
  headshot: boolean;
  cause: DeathCause;
  /** 팀 (TDM 색 기준, 개인전은 NONE) */
  killerTeam: string | null;
  victimTeam: string;
  /** 이름 색 (게임이 모드에 맞게 정함: 개인전 = 캐릭터 색, TDM = 팀 색) */
  killerColor: string | null;
  victimColor: string;
  /** 로컬 플레이어가 처치자 / 사망자 (강조, 캐릭터가 아니라 참가자 id 기준) */
  localKiller: boolean;
  localVictim: boolean;
  /** 발생 시각 (performance.now, ms) */
  timestamp: number;
}

export const KILL_FEED = {
  maxRows: 4,
  /** 표시 시간 (ms, 페이드아웃 시작까지) */
  holdMs: 5000,
  fadeMs: 300,
};

/* 아이콘: 둥근 장난감 실루엣 SVG (currentColor), viewBox 48×20. 무기 GLB용 아이콘 에셋이 아직 없어서 코드로 그림 */
const svg = (body: string, label: string, w = 48) =>
  `<svg class="kf-icon" viewBox="0 0 ${w} 20" width="${w * 0.62}" height="${20 * 0.62}" role="img" aria-label="${label}" fill="currentColor">${body}</svg>`;

const ICONS: Record<string, string> = {
  rifle: svg(
    '<rect x="7" y="6" width="31" height="6" rx="3"/><rect x="37" y="7" width="10" height="3" rx="1.5"/><rect x="1" y="6" width="9" height="8" rx="3"/>' +
      '<rect x="22" y="10" width="5" height="8" rx="2"/><rect x="14" y="10" width="4" height="7" rx="2" transform="rotate(12 16 13)"/><rect x="17" y="2" width="12" height="3.5" rx="1.75"/>',
    '라이플',
  ),
  shotgun: svg(
    '<rect x="9" y="5" width="28" height="7" rx="3.5"/><rect x="36" y="5.5" width="11" height="4" rx="2"/><rect x="29" y="10" width="11" height="4" rx="2"/>' +
      '<rect x="1" y="6" width="10" height="8" rx="3.5"/><rect x="15" y="10" width="5" height="7" rx="2.5" transform="rotate(12 17 13)"/>',
    '샷건',
  ),
  sniper: svg(
    '<rect x="9" y="8" width="26" height="4.5" rx="2.25"/><rect x="34" y="8.6" width="14" height="2.6" rx="1.3"/><rect x="0.5" y="7" width="10" height="7.5" rx="3"/>' +
      '<rect x="14" y="2.5" width="16" height="4.5" rx="2.25"/><circle cx="14.5" cy="4.75" r="2.6"/><circle cx="29.5" cy="4.75" r="2.6"/>' +
      '<rect x="17" y="11" width="4" height="6" rx="2" transform="rotate(12 19 14)"/><path d="M31 12 l-3 7 M33 12 l3 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    '스나이퍼',
  ),
  pistol: svg(
    '<rect x="12" y="4" width="25" height="7" rx="3.5"/><rect x="36" y="5" width="5" height="3.5" rx="1.75"/><rect x="14" y="9" width="7" height="10" rx="3" transform="rotate(14 17 14)"/>' +
      '<path d="M22 11 q3 4 6 0" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>',
    '권총',
  ),
  melee: svg(
    '<rect x="2" y="8.5" width="28" height="3.5" rx="1.75"/><circle cx="3" cy="10.25" r="2.6"/><rect x="27" y="1" width="17" height="18" rx="5"/>' +
      '<path d="M35.5 5.5 l1.4 2.9 3.1.4 -2.3 2.2 .6 3.1 -2.8-1.5 -2.8 1.5 .6-3.1 -2.3-2.2 3.1-.4z" fill="rgba(30,36,64,.55)"/>',
    '뿅망치',
  ),
  // 투척무기는 아직 없음 (아이콘만 준비)
  throwable: svg('<circle cx="24" cy="12" r="7"/><rect x="21" y="2.5" width="6" height="4" rx="1.5"/><path d="M27 4 q5 -3 7 1" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>', '투척'),
  suicide: svg(
    '<path d="M16 10 a8 8 0 1 0 8-8" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M24 -1 l5 3 -5 3z"/>',
    '자멸',
    40,
  ),
  fall: svg('<path d="M20 2 v11" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/><path d="M14 10 l6 7 6-7z"/><rect x="8" y="18" width="24" height="2" rx="1"/>', '낙사', 40),
  unknown: svg('<circle cx="20" cy="10" r="7"/>', '처치', 40),
};

/** 헤드샷 표시: 작은 머리 + 조준 원 (노랑) */
const HEADSHOT_ICON =
  '<svg class="kf-head" viewBox="0 0 20 20" width="13" height="13" role="img" aria-label="헤드샷"><circle cx="10" cy="10" r="8.2" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '<circle cx="10" cy="10" r="3.6" fill="currentColor"/><path d="M10 0 v4 M10 16 v4 M0 10 h4 M16 10 h4" stroke="currentColor" stroke-width="2"/></svg>';

const WEAPON_ICON: Record<string, string> = {
  rifle: 'rifle',
  shotgun: 'shotgun',
  sniper: 'sniper',
  pistol: 'pistol',
  melee: 'melee',
};

/** HUD 무기 카드·슬롯용 무기 아이콘 SVG (킬로그와 같은 그림, 크기는 CSS) */
export function weaponIconSvg(weaponId: string): string {
  return ICONS[WEAPON_ICON[weaponId] ?? 'unknown']!;
}

/** 무기 id → 아이콘 키 (모르는 무기는 기본 처치 아이콘) */
export function killIconKey(e: Pick<KillFeedEvent, 'cause' | 'weaponId'>): string {
  if (e.cause === 'suicide') return 'suicide';
  if (e.cause === 'fall') return 'fall';
  return (e.weaponId && WEAPON_ICON[e.weaponId]) || 'unknown';
}

interface Row {
  el: HTMLDivElement;
  expireAt: number;
  /** 페이드아웃 시작 후 제거 시각 (0 = 아직 표시 중) */
  removeAt: number;
}

export class KillFeed {
  readonly root: HTMLDivElement;
  private readonly rows: Row[] = [];

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'killfeed';
    this.root.setAttribute('aria-live', 'polite');
    parent.appendChild(this.root);
  }

  /** 확정된 사망 1건 → 맨 위에 추가 */
  push(e: KillFeedEvent): void {
    const el = document.createElement('div');
    el.className = 'kf-row';
    el.classList.toggle('local-kill', e.localKiller);
    el.classList.toggle('local-death', e.localVictim);
    const name = (cls: string, text: string, color: string | null) => {
      const s = document.createElement('span');
      s.className = `kf-name ${cls}`;
      s.textContent = text;
      if (color) s.style.color = color;
      s.title = text;
      return s;
    };
    if (e.killerName && e.cause === 'weapon') el.appendChild(name('kf-killer', e.killerName, e.killerColor));
    const icons = document.createElement('span');
    icons.className = 'kf-icons';
    icons.innerHTML = ICONS[killIconKey(e)]! + (e.headshot && e.cause === 'weapon' ? HEADSHOT_ICON : '');
    el.appendChild(icons);
    el.appendChild(name('kf-victim', e.victimName, e.victimColor));
    this.root.prepend(el);
    this.rows.unshift({ el, expireAt: e.timestamp + KILL_FEED.holdMs, removeAt: 0 });
    // 넘치면 가장 오래된 것부터 바로 제거 (표시 중인 줄만 세고, 이미 사라지는 중인 줄은 제거)
    while (this.rows.length > KILL_FEED.maxRows) this.rows.pop()!.el.remove();
  }

  /** 매 프레임 (Hud.update). 만료된 줄 페이드아웃 → 제거 */
  update(now: number): void {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i]!;
      if (r.removeAt === 0 && now >= r.expireAt) {
        r.removeAt = now + KILL_FEED.fadeMs;
        r.el.classList.add('out');
      } else if (r.removeAt > 0 && now >= r.removeAt) {
        r.el.remove();
        this.rows.splice(i, 1);
      }
    }
  }

  /** 새 매치: 이전 매치 킬로그 비우기 */
  clear(): void {
    for (const r of this.rows) r.el.remove();
    this.rows.length = 0;
  }

  /** 디버그: 지금 보이는 줄 수 */
  get count(): number {
    return this.rows.length;
  }

  dispose(): void {
    this.clear();
    this.root.remove();
  }
}
