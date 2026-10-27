import * as THREE from 'three';
import type { CrosshairDef } from '../config/weapons';
import type { BotLabel } from '../bots/BotManager';
import { COMBAT } from '../config/combat';
import type { MatchState } from '../match/Match';
import { KILL_FEED, KillFeed, weaponIconSvg, type KillFeedEvent } from './KillFeed';
import { viewerLang } from '../net/shared/roomTitles';

/** 재장전 표시 글자 (브라우저 언어: 한국어면 한글) */
const RELOAD_TEXT = viewerLang() === 'ko' ? { busy: '재장전', done: '완료!' } : { busy: 'RELOADING', done: 'READY!' };

/** 매치 정보 (상단 매치 카드·카운트다운) */
export interface MatchHudInfo {
  state: MatchState;
  timeLeft: number;
  countdown: number;
  kills: number;
  deaths: number;
  rank: number;
  players: number;
  scoreToWin: number;
  label: string;
  /** 멀티플레이 매치 점수판 (서버 값). 있으면 개인 킬/데스·순위 대신 표시 */
  net?: NetScoreHud;
}

/** 멀티플레이 점수판: TDM = BLUE 08 — 06 RED, FFA = MY KILLS 07 / 15, 남은 시간 (null = 제한 없음) */
export interface NetScoreHud {
  mode: 'tdm' | 'ffa' | 'test';
  blue: number;
  red: number;
  myTeam: 'BLUE' | 'RED' | null;
  leader: number;
  goal: number;
  mine: number;
  myDeaths: number;
  rank: number;
  players: number;
  timeLeft: number | null;
}

export interface HudFrame {
  dt: number;
  fps: number;
  magazine: number;
  magazineSize: number;
  reserve: number;
  reloadProgress: number;
  reloading: boolean;
  aiming: boolean;
  aimBlend: number;
  /** 실제 탄 퍼짐 반지름을 화면 px로 바꾼 값 (WeaponSystem.lastSpreadDeg, 카메라 FOV·화면 높이 반영) */
  spreadPx: number;
  /** 현재 무기 (조준선 모양 교체·크기 초기화) */
  weaponId: string;
  crosshair?: CrosshairDef;
  /** 0..1 스코프 원형 화면 표시 정도 */
  scopeOverlay: number;
  /** 총구 경로가 가까운 장애물에 막혔을 때 실제 탄착 지점 (아니면 null) */
  blockedAt: THREE.Vector3 | null;
  /** 지금 쏘면 적 피격 부위에 맞음 → 조준선 빨간색 */
  enemyTargeted: boolean;
  dead: boolean;
  respawnIn: number;
  /** 쓰러뜨린 상대 이름 (없으면 null) */
  killedBy: string | null;
  match: MatchHudInfo;
  hp: number;
  maxHp: number;
  /** 리스폰 보호 남은 시간 */
  protection: number;
  /** 카메라 수평 회전 (피해 방향 표시 기준) */
  cameraYaw: number;
  /** 플레이어 위치 (피해 방향 표시 기준) */
  playerPos: THREE.Vector3;
  botLabels: readonly BotLabel[];
  /** 현재 무기 */
  weaponName: string;
  /** 근접무기: 탄약 표시 숨김 */
  melee: boolean;
  /** 1/2/3 슬롯 (실제 로드아웃) */
  slots: ReadonlyArray<{ key: string; id: string; name: string; active: boolean }>;
  /** 개발용 수치(FPS·디버그 줄) 표시: 개발 서버에서 디버그 패널(`)을 열었을 때만 */
  debug: boolean;
  debugLines: string[];
}

interface DamageIndicator {
  el: HTMLDivElement;
  source: THREE.Vector3;
  life: number;
}

interface Popup {
  el: HTMLDivElement;
  world: THREE.Vector3;
  life: number;
  /** 연속 피해 숫자가 겹치지 않게 화면 오프셋 (px) */
  offsetX: number;
  offsetY: number;
}

/** 조준선 표시가 실제 탄 퍼짐을 따라가는 속도 (지수 감쇠 계수) */
const CROSSHAIR_SHARPNESS = 25;
const DEFAULT_CROSSHAIR: CrosshairDef = { style: 'cross', lineLength: 11, lineWidth: 3.5, dotSize: 4.5, minGap: 4 };

const POPUP_LIFE = 0.6;
const POPUP_POOL = 24;
const INDICATOR_POOL = 6;
/** 체력 경고 (최대 체력 대비) */
const LOW_HP = 0.3;
/** 탄약 경고 (탄창 대비) */
const LOW_AMMO = 0.25;

/** 상단 매치 카드의 모드 이름 */
const MODE_TITLE: Record<NetScoreHud['mode'], string> = { tdm: '팀 데스매치', ffa: '개인전', test: '자유 테스트' };

const HEART_SVG =
  '<svg viewBox="0 0 24 22" aria-hidden="true"><path d="M12 21 C 5 16 1 12 1 7.2 A 5.6 5.6 0 0 1 12 4.6 A 5.6 5.6 0 0 1 23 7.2 C 23 12 19 16 12 21 Z" fill="currentColor"/>' +
  '<ellipse cx="7" cy="7" rx="2.4" ry="1.6" fill="#fff" opacity=".55" transform="rotate(-30 7 7)"/></svg>';

const _v = new THREE.Vector3();

const pad2 = (n: number) => String(Math.max(0, Math.floor(n))).padStart(2, '0');
const clock = (sec: number) => {
  const t = Math.max(0, Math.ceil(sec));
  return `${pad2(t / 60)}:${pad2(t % 60)}`;
};

/** 시작 화면 캐릭터 카드 1장 */
export interface CharacterCard {
  id: string;
  name: string;
  role: string;
  color: string;
  maxHp: number;
  speed: number;
  hitSize: number;
  /** 잠김 표시 (자물쇠) */
  locked: boolean;
  /** 이 빌드에서 고를 수 있음 (개발 서버는 잠겨도 true) */
  selectable: boolean;
}

/**
 * 게임 HUD (HTML/CSS). 화면 구역:
 * - 상단 중앙: 매치 카드 (모드·남은 시간·팀 점수 / 내 킬·순위) · 카운트다운
 * - 상단 우측: 킬로그 (KillFeed)
 * - 중앙: 조준선(일반·적 조준·ADS) · 히트마커(명중·헤드샷·처치) · 피해 숫자 · 피격 방향
 * - 좌측 하단: 체력 카드 / 하단 중앙: 무기 슬롯 / 우측 하단: 무기·탄약 카드
 * - 개발용 수치(FPS·디버그 줄)는 debug일 때만
 * 크기는 화면에 맞춰 --u(0.6~1.2)로 조절, 가장자리는 safe area. 모바일 터치 버튼이 생기면 .hud.touch에서
 * --touch-lift-l / --touch-lift-r 만큼 좌·우 하단 카드를 올려 버튼 자리를 비움 (CSS만 바꾸면 됨).
 */
export class Hud {
  private readonly root: HTMLDivElement;
  private readonly crosshair: HTMLDivElement;
  private readonly scope: HTMLDivElement;
  private readonly blocked: HTMLDivElement;
  private readonly hitmarker: HTMLDivElement;
  private readonly popEl: HTMLDivElement;
  private popAnim: Animation | null = null;
  private readonly weaponCard: HTMLDivElement;
  private readonly weaponIcon: HTMLDivElement;
  private readonly weaponName: HTMLDivElement;
  private readonly magEl: HTMLElement;
  private readonly resEl: HTMLElement;
  private readonly weaponState: HTMLDivElement;
  private readonly cardReloadBar: HTMLDivElement;
  private readonly reload: HTMLDivElement;
  /** 원형 게이지 채움 (stroke-dashoffset 100 → 0) */
  private readonly reloadRing: SVGCircleElement;
  private readonly reloadLabel: HTMLSpanElement;
  /** 직전 프레임 재장전 상태 (완료 판정: 같은 무기에서 재장전이 끝나며 탄창이 늘었을 때) */
  private reloadPrev = { on: false, weaponId: '', magazine: 0 };
  /** 완료 표시 남은 시간 (s) */
  private reloadDone = 0;
  private readonly adsTag: HTMLDivElement;
  private readonly fps: HTMLDivElement;
  private readonly debug: HTMLPreElement;
  private readonly death: HTMLDivElement;
  private readonly lockOverlay: HTMLDivElement;
  private readonly popups: Popup[] = [];
  private readonly popupPool: HTMLDivElement[] = [];
  private popupSeq = 0;
  private killRingAnim: Animation | null = null;
  /** 무기 카드 그림 원본 (실제 무기 모델 옆모습, assets/weaponArt). 게임이 무기 모델을 불러온 뒤 설정 */
  weaponImage: ((weaponId: string) => string | null) | null = null;
  private hitAnim: Animation | null = null;
  /** 피격 연출 (겹치지 않게 이전 것을 끊고 새로) */
  private hurtAnim: Animation | null = null;
  private hpPopAnim: Animation | null = null;
  private shakeAnim: Animation | null = null;
  private lastHurtAt = -Infinity;
  private crosshairWeapon = '';
  private crosshairKey = '';
  private spreadShown = 0;
  private lastFpsText = '';
  private readonly hpCard: HTMLDivElement;
  private readonly hpFill: HTMLDivElement;
  private readonly hpLag: HTMLDivElement;
  private readonly hpText: HTMLElement;
  private readonly hpMax: HTMLElement;
  private readonly protectTag: HTMLDivElement;
  private readonly hurtFlash: HTMLDivElement;
  private readonly labelHost: HTMLDivElement;
  private readonly indicators: DamageIndicator[] = [];
  private readonly labelEls: HTMLDivElement[] = [];
  private lastHp = -1;
  private lastMaxHp = -1;
  private readonly slotsEl: HTMLDivElement;
  private readonly loadoutButtons: HTMLDivElement;
  private readonly loadoutNote: HTMLDivElement;
  private readonly charCards: HTMLDivElement;
  private readonly charNote: HTMLDivElement;
  private lastWeaponId = '';
  private lastWeaponKey = '';
  private lastSlotsKey = '';
  private lastActiveSlot = '';
  private readonly matchBar: HTMLDivElement;
  private readonly countdownEl: HTMLDivElement;
  private readonly noticeEl: HTMLDivElement;
  private noticeTimer = 0;
  private lastMatchKey = '';
  private lastCountdown = '';
  private lastScale = '';
  private locked = false;
  /** 시작 카드 "Multiplayer" 버튼 */
  onMultiplayer: (() => void) | null = null;
  /** 터치 모드: 무기 슬롯을 눌렀을 때 (0부터) */
  onSlotTap: ((index: number) => void) | null = null;
  /** 시작 카드 "터치 설정" 버튼 (터치 모드에서만 보임) */
  onTouchSettings: (() => void) | null = null;
  /** 터치 모드: 시작 카드 자체(버튼 밖)를 눌러 시작·재개 (작은 화면에서 카드가 화면을 거의 덮음) */
  onTouchStart: (() => void) | null = null;
  /** 터치 모드: 상단 점수판(시간·점수)을 눌렀을 때 (상황판 열기·닫기) */
  onMatchBarTap: (() => void) | null = null;
  /** 우측 상단 실시간 킬로그 */
  private readonly killFeed: KillFeed;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="scope"><div class="scope-lens"><i class="h"></i><i class="v"></i><i class="c"></i></div></div>
      <div class="crosshair" data-style="cross"><i class="ring"></i><i class="t"></i><i class="b"></i><i class="l"></i><i class="r"></i><i class="dot"></i></div>
      <div class="blocked-marker"></div>
      <div class="hitmarker"><i></i><i></i><i></i><i></i><b></b></div>
      <div class="pop-burst" aria-hidden="true">POP!</div>
      <div class="portrait-hint" role="note">가로 화면으로 돌리면 더 넓게 볼 수 있어요</div>
      <div class="low-vignette" aria-hidden="true"></div>
      <div class="reload"><svg class="rl-ring" viewBox="0 0 36 36" aria-hidden="true"><circle class="rl-track" cx="18" cy="18" r="14"/><circle class="rl-fill" cx="18" cy="18" r="14" pathLength="100"/><path class="rl-check" d="M11.5 18.5l4.5 4.5 8.5-9"/></svg><span class="rl-label"></span></div>
      <div class="fps">-- FPS</div>
      <pre class="debug-lines"></pre>
      <div class="death"><b>쓰러짐!</b><span></span></div>
      <div class="hurt-flash"></div>
      <div class="damage-dirs"></div>
      <div class="labels"></div>
      <div class="hp">
        <div class="hp-icon">${HEART_SVG}</div>
        <div class="hp-main">
          <div class="hp-nums"><b class="hp-text">100</b><span class="hp-max">/ 100</span><span class="protect-tag">보호 중</span></div>
          <div class="hp-bar"><div class="hp-lag"></div><div class="hp-fill"></div><i class="hp-shine"></i></div>
        </div>
      </div>
      <div class="slots"></div>
      <div class="weapon-card">
        <div class="ads-tag">ADS</div>
        <div class="wc-icon"></div>
        <div class="wc-body">
          <div class="wc-name"></div>
          <div class="ammo"><b class="mag">30</b><span class="res">/ 120</span></div>
          <div class="wc-state"></div>
          <div class="wc-reload"><div></div></div>
        </div>
      </div>
      <div class="match-bar hidden">
        <div class="mb-mode"></div>
        <div class="mb-row">
          <div class="mb-side blue"><span class="mb-tname">BLUE</span><b class="mb-score">00</b></div>
          <div class="mb-time">03:00</div>
          <div class="mb-side red"><b class="mb-score">00</b><span class="mb-tname">RED</span></div>
        </div>
        <div class="mb-sub">
          <span class="mb-pill mb-kills"></span>
          <span class="mb-pill mb-rank"></span>
          <span class="mb-pill mb-goal"></span>
        </div>
      </div>
      <div class="countdown"></div>
      <div class="hud-notice"></div>
      <div class="lock-overlay">
        <div class="lock-card">
          <h1>POP! BATTLE</h1>
          <div class="loadout char-select">
            <div class="lo-title cs-title">캐릭터 선택</div>
            <div class="cs-cards"></div>
            <div class="lo-note cs-note"></div>
          </div>
          <div class="loadout">
            <div class="lo-title">주무기 선택</div>
            <div class="lo-buttons"></div>
            <div class="lo-note"></div>
          </div>
          <p class="mode-line">개인전 4인 · 3분 · 15킬 먼저 달성하면 승리</p>
          <div><button type="button" class="mp-open">Multiplayer</button><button type="button" class="touch-settings-open">터치 설정</button></div>
          <p><span class="pc-only">화면을 클릭해서 시작</span><span class="touch-only">화면을 터치해서 시작</span></p>
          <ul>
            <li><b>WASD</b> 이동 · <b>W 두 번</b> 달리기 · <b>Shift</b> 슬라이딩 · <b>Space</b> 점프</li>
            <li><b>좌클릭</b> 사격 · <b>우클릭</b> 조준 켜기/끄기 · <b>R</b> 재장전</li>
            <li><b>1</b> 주무기 · <b>2</b> 권총 · <b>3</b> 뿅망치 · <b>휠</b> 무기 순환</li>
            <li><b>K</b> 사망 테스트 · <b>\`</b> 디버그 패널</li>
          </ul>
          <ul class="touch-guide">
            <li><b>왼쪽</b> 조이스틱 이동(앞으로 계속 밀면 달리기) · <b>오른쪽</b> 드래그 시점</li>
            <li><b>●</b> 사격(끌면 조준 이동) · <b>ADS</b> · <b>▲</b> 점프 · 슬라이딩 · <b>↻</b> 재장전 · 아래 슬롯 무기 · <b>II</b> 일시정지</li>
          </ul>
        </div>
      </div>`;
    parent.appendChild(this.root);
    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector(sel) as T;
    this.crosshair = q('.crosshair');
    this.scope = q('.scope');
    this.blocked = q('.blocked-marker');
    this.hitmarker = q('.hitmarker');
    this.popEl = q('.pop-burst');
    for (let i = 0; i < POPUP_POOL; i++) {
      const el = document.createElement('div');
      el.className = 'dmg';
      el.style.display = 'none';
      this.root.appendChild(el);
      this.popupPool.push(el);
    }
    this.weaponCard = q('.weapon-card');
    this.weaponIcon = q('.wc-icon');
    this.weaponName = q('.wc-name');
    this.magEl = q('.ammo .mag');
    this.resEl = q('.ammo .res');
    this.weaponState = q('.wc-state');
    this.cardReloadBar = q('.wc-reload div');
    this.reload = q('.reload');
    this.reloadRing = this.root.querySelector('.rl-fill') as SVGCircleElement;
    this.reloadLabel = q('.rl-label');
    this.adsTag = q('.ads-tag');
    this.fps = q('.fps');
    this.debug = q('.debug-lines');
    this.death = q('.death');
    this.lockOverlay = q('.lock-overlay');
    this.slotsEl = q('.slots');
    this.loadoutButtons = q('.lo-buttons');
    this.loadoutNote = q('.loadout:not(.char-select) .lo-note');
    this.charCards = q('.cs-cards');
    this.charNote = q('.cs-note');
    this.hpCard = q('.hp');
    this.hpFill = q('.hp-fill');
    this.hpLag = q('.hp-lag');
    this.hpText = q('.hp-text');
    this.hpMax = q('.hp-max');
    this.protectTag = q('.protect-tag');
    this.hurtFlash = q('.hurt-flash');
    this.labelHost = q('.labels');
    this.matchBar = q('.match-bar');
    // 터치: 점수판 누르기 → 상황판 (아래 시점 회전·사격으로 내려가지 않게)
    this.matchBar.addEventListener('pointerdown', (e) => {
      if (!this.root.classList.contains('touch')) return;
      e.preventDefault();
      e.stopPropagation();
      this.onMatchBarTap?.();
    });
    this.countdownEl = q('.countdown');
    this.noticeEl = q('.hud-notice');
    q<HTMLButtonElement>('.mp-open').addEventListener('click', (e) => {
      e.stopPropagation();
      this.onMultiplayer?.();
    });
    // click = 끌지 않고 톡 누름 (카드를 스크롤하는 동작으로는 시작하지 않음)
    q<HTMLDivElement>('.lock-card').addEventListener('click', (e) => {
      if (!this.root.classList.contains('touch')) return;
      if ((e.target as HTMLElement).closest('button, input, select')) return;
      this.onTouchStart?.();
    });
    q<HTMLButtonElement>('.touch-settings-open').addEventListener('click', (e) => {
      e.stopPropagation();
      this.onTouchSettings?.();
    });
    this.killFeed = new KillFeed(this.root);
    const dirs = q<HTMLDivElement>('.damage-dirs');
    for (let i = 0; i < INDICATOR_POOL; i++) {
      const el = document.createElement('div');
      el.className = 'damage-dir';
      el.style.opacity = '0';
      dirs.appendChild(el);
      this.indicators.push({ el, source: new THREE.Vector3(), life: 0 });
    }
  }

  /**
   * 플레이어 피격 (실제로 체력이 줄었을 때만 — 보호 중 0 피해는 표시 안 함):
   * 화면 가장자리 붉은 섬광 0.32초 (피해량 비례, 연속 피격은 약하게 다시 시작해 화면이 계속 붉지 않게),
   * 공격 방향 쐐기(최근 공격으로 갱신), 체력 숫자 튐 + 체력 카드 흔들림(연속 피격 땐 생략)
   */
  showDamage(source: THREE.Vector3 | null, amount: number): void {
    if (amount <= 0) return;
    const now = performance.now();
    const repeat = now - this.lastHurtAt < 250;
    this.lastHurtAt = now;
    const peak = repeat ? 0.5 : Math.min(0.9, 0.55 + amount / 60);
    this.hurtAnim?.cancel();
    this.hurtAnim = this.hurtFlash.animate([{ opacity: peak }, { opacity: 0 }], { duration: 320, easing: 'ease-out' });
    this.hpPopAnim?.cancel();
    this.hpPopAnim = this.hpText.animate(
      [{ transform: 'scale(1.35)', color: '#ff4d6d' }, { transform: 'scale(1)', color: '#ff4d6d', offset: 0.5 }, { transform: 'scale(1)' }],
      { duration: 380, easing: 'ease-out' },
    );
    if (!repeat) {
      this.shakeAnim?.cancel();
      this.shakeAnim = this.hpCard.animate(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(-5px) rotate(-1.5deg)' }, { transform: 'translateX(4px) rotate(1deg)' }, { transform: 'translateX(-2px)' }, { transform: 'translateX(0)' }],
        { duration: 260, easing: 'ease-out' },
      );
    }
    if (!source) return;
    // 같은 방향(가까운 지점) 표시는 갱신, 아니면 가장 오래된 칸 재사용. 피해량이 크면 쐐기도 진하게
    let slot = this.indicators.find((d) => d.life > 0 && d.source.distanceTo(source) < 2);
    if (!slot) slot = this.indicators.reduce((a, b) => (a.life <= b.life ? a : b));
    slot.source.copy(source);
    slot.life = COMBAT.damageIndicatorTime;
    slot.el.classList.toggle('big', amount >= 30);
  }

  /** 사망·리스폰·화면 전환: 남은 피격 연출 즉시 끝 */
  clearDamage(): void {
    this.hurtAnim?.cancel();
    this.hpPopAnim?.cancel();
    this.shakeAnim?.cancel();
    for (const d of this.indicators) {
      d.life = 0;
      d.el.style.opacity = '0';
    }
  }

  /** 화면 위쪽 알림 (입장·퇴장·연결 끊김 등, 약 4초) */
  notify(text: string): void {
    this.noticeEl.textContent = text;
    this.noticeEl.classList.add('show');
    this.noticeEl.animate([{ transform: 'translate(-50%, -8px) scale(.9)', opacity: 0 }, { transform: 'translate(-50%, 0) scale(1)', opacity: 1 }], { duration: 200, easing: 'ease-out' });
    this.noticeTimer = 4;
  }

  /**
   * 시작 화면 캐릭터 카드 (한 번만 만든다). 잠긴 캐릭터는 자물쇠 표시, selectable이 false면 눌러도 선택 안 됨
   * (개발 서버는 잠겨 있어도 selectable = true)
   */
  setCharacterOptions(options: ReadonlyArray<CharacterCard>, onSelect: (id: string) => void): void {
    this.charCards.textContent = '';
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    for (const o of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cs-card';
      b.dataset.id = o.id;
      b.classList.toggle('locked', o.locked);
      b.style.setProperty('--cs-color', o.color);
      b.innerHTML =
        `<span class="cs-swatch"></span><b class="cs-name"></b><span class="cs-role"></span>` +
        `<span class="cs-stats"><span>HP <b></b></span><span>속도 <b></b></span><span>크기 <b></b></span></span>` +
        (o.locked ? `<span class="cs-lock" aria-label="잠김">🔒</span>` : '');
      b.querySelector('.cs-name')!.textContent = o.name;
      b.querySelector('.cs-role')!.textContent = o.role;
      const stats = b.querySelectorAll('.cs-stats b');
      stats[0]!.textContent = String(o.maxHp);
      stats[1]!.textContent = pct(o.speed);
      stats[2]!.textContent = pct(o.hitSize);
      b.title = o.locked ? `${o.name}: 상위 캐릭터 (잠김)` : o.name;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!o.selectable) {
          this.charNote.textContent = `${o.name}은(는) 상위 캐릭터예요 · 해금 방법은 준비 중`;
          return;
        }
        onSelect(o.id);
      });
      this.charCards.appendChild(b);
    }
  }

  /** 선택된 캐릭터 표시. locked = 게임 시작 후 (변경 불가), loading = 모델 불러오는 중 */
  setCharacter(selectedId: string, locked: boolean, loading = false): void {
    for (const b of this.charCards.querySelectorAll<HTMLButtonElement>('.cs-card')) {
      const sel = b.dataset.id === selectedId;
      b.classList.toggle('selected', sel);
      b.disabled = locked || loading;
      b.style.display = locked && !sel ? 'none' : '';
    }
    this.charNote.textContent = loading ? '불러오는 중…' : locked ? '전투 중에는 캐릭터를 바꿀 수 없어요' : '능력치: 최대 HP · 이동 속도 · 피격 크기';
    this.root.querySelector('.cs-title')!.textContent = locked ? '캐릭터 (고정)' : '캐릭터 선택';
  }

  /** 로드아웃 주무기 버튼 (시작 화면 카드, 한 번만 만든다) */
  setLoadoutOptions(options: ReadonlyArray<{ id: string; name: string }>, onSelect: (id: string) => void): void {
    this.loadoutButtons.textContent = '';
    for (const o of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lo-btn';
      b.dataset.id = o.id;
      b.textContent = o.name;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        onSelect(o.id);
      });
      this.loadoutButtons.appendChild(b);
    }
  }

  /** 선택된 주무기 표시. locked = 게임 시작 후 (변경 불가) */
  setLoadout(selectedId: string, locked: boolean): void {
    for (const b of this.loadoutButtons.querySelectorAll<HTMLButtonElement>('.lo-btn')) {
      const sel = b.dataset.id === selectedId;
      b.classList.toggle('selected', sel);
      b.disabled = locked;
      b.style.display = locked && !sel ? 'none' : '';
    }
    this.loadoutNote.textContent = locked ? '전투 중에는 주무기를 바꿀 수 없어요' : '2번 권총 · 3번 뿅망치는 고정';
    this.root.querySelector('.loadout:not(.char-select) .lo-title')!.textContent = locked ? '주무기 (고정)' : '주무기 선택';
  }

  /** 메인 로비가 떠 있는 동안: 전투 HUD·시작 카드 숨김 (로비가 화면을 맡음) */
  setLobby(on: boolean): void {
    this.root.classList.toggle('in-lobby', on);
  }

  /** 모바일 터치 조작: 터치 버튼 자리를 비운 배치 + 슬롯 터치 + 시작 카드 안내·설정 버튼 */
  setTouchMode(on: boolean): void {
    this.root.classList.toggle('touch', on);
    // 모바일 가로: 킬로그는 2줄 (전투 시야 확보)
    this.killFeed.maxRows = on ? 2 : KILL_FEED.maxRows;
    this.lastWeaponKey = '';
  }

  /** 멀티플레이 화면이 덮고 있으면 시작 카드 숨김 */
  setMultiplayerCovered(covered: boolean): void {
    this.lockOverlay.classList.toggle('mp-covered', covered);
  }

  /** 시작 카드의 모드 안내 문구 */
  setModeLine(text: string): void {
    this.root.querySelector('.mode-line')!.textContent = text;
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
    // 조작 중 (터치 모드 슬롯 바 입력은 이때만)
    this.root.classList.toggle('playing', locked);
    // 옛 시작 안내 카드(프로토타입)는 쓰지 않음: 시작은 메인 로비, 매치 중 조작을 놓치면 정식 일시정지 메뉴(ui/lobby/PauseMenu)
    this.lockOverlay.classList.add('hidden');
  }

  /** 카운트다운이 끝나 전투 시작 */
  flashGo(): void {
    const el = this.countdownEl;
    el.textContent = 'GO!';
    el.classList.add('go');
    el.animate(
      [
        { opacity: 1, transform: 'translate(-50%, -50%) scale(1.4)' },
        { opacity: 1, transform: 'translate(-50%, -50%) scale(1)', offset: 0.3 },
        { opacity: 0, transform: 'translate(-50%, -50%) scale(1.1)' },
      ],
      { duration: 800, easing: 'ease-out', fill: 'forwards' },
    );
    this.lastCountdown = '';
  }

  /** 매치 종료 (결과 화면은 ResultScreen): 조준선·체력·무기 카드 등 전투 HUD 숨김 */
  setMatchOver(on: boolean): void {
    this.root.classList.toggle('match-over', on);
    this.setLocked(this.locked);
  }

  /**
   * 상단 매치 카드. 같은 틀에 모드별 내용:
   * TDM = 모드 · BLUE 08 ⏱ 06 RED · 목표 / FFA = 모드 · ⏱ · MY KILLS 07 / 15 · 순위 / 자유 테스트 = 시간 없음 · K/D
   */
  private updateMatch(m: MatchHudInfo): void {
    this.matchBar.classList.toggle('hidden', m.state === 'WAITING');
    // 매치 종료(싱글 결과 카드·멀티 결과 화면): 하단 카드·슬롯 숨김
    this.root.classList.toggle('match-done', m.state === 'FINISHED');
    const n = m.net;
    const mode: NetScoreHud['mode'] = n ? n.mode : 'ffa';
    const time = n ? (n.timeLeft === null ? '∞' : clock(n.timeLeft)) : clock(m.timeLeft);
    const secs = n ? n.timeLeft : m.timeLeft;
    const kills = n ? n.mine : m.kills;
    const deaths = n ? n.myDeaths : m.deaths;
    const goal = n ? n.goal : m.scoreToWin;
    const rank = n ? n.rank : m.rank;
    const players = n ? n.players : m.players;
    const key = `${mode}|${time}|${n?.blue}|${n?.red}|${n?.myTeam}|${kills}|${deaths}|${goal}|${rank}|${players}|${m.state}|${!!n}`;
    if (key !== this.lastMatchKey) {
      this.lastMatchKey = key;
      const mb = this.matchBar;
      mb.classList.toggle('tdm', mode === 'tdm');
      mb.classList.toggle('solo', mode !== 'tdm');
      mb.querySelector('.mb-mode')!.textContent = n ? MODE_TITLE[mode] : `${MODE_TITLE.ffa} · 연습전`;
      mb.querySelector('.mb-time')!.textContent = time;
      const pill = (sel: string, html: string | null) => {
        const el = mb.querySelector(sel) as HTMLElement;
        el.style.display = html === null ? 'none' : '';
        if (html !== null) el.innerHTML = html;
      };
      if (mode === 'tdm') {
        const [blue, red] = mb.querySelectorAll<HTMLElement>('.mb-side');
        blue!.querySelector('.mb-score')!.textContent = pad2(n!.blue);
        red!.querySelector('.mb-score')!.textContent = pad2(n!.red);
        blue!.classList.toggle('mine', n!.myTeam === 'BLUE');
        red!.classList.toggle('mine', n!.myTeam === 'RED');
        blue!.classList.toggle('lead', n!.blue > n!.red);
        red!.classList.toggle('lead', n!.red > n!.blue);
        pill('.mb-kills', null);
        pill('.mb-rank', null);
        pill('.mb-goal', `목표 <b>${goal}</b>킬${n!.myTeam ? ` · 내 팀 <b class="t-${n!.myTeam.toLowerCase()}">${n!.myTeam}</b>` : ''}`);
      } else if (mode === 'test') {
        pill('.mb-kills', `K <b>${kills}</b> · D <b>${deaths}</b>`);
        pill('.mb-rank', `<b>${rank}</b>위 / ${players}`);
        pill('.mb-goal', null);
      } else {
        pill('.mb-kills', `내 킬 <b>${pad2(kills)}</b> / ${goal}`);
        pill('.mb-rank', `<b>${rank}</b>위 / ${players}`);
        pill('.mb-goal', null);
      }
      mb.classList.toggle('hurry', m.state === 'PLAYING' && secs !== null && secs <= 10);
    }
    if (m.state === 'COUNTDOWN') {
      const c = String(Math.max(1, Math.ceil(m.countdown)));
      if (c !== this.lastCountdown) {
        this.lastCountdown = c;
        const el = this.countdownEl;
        el.classList.remove('go');
        el.textContent = c;
        el.animate(
          [
            { opacity: 1, transform: 'translate(-50%, -50%) scale(1.5)' },
            { opacity: 1, transform: 'translate(-50%, -50%) scale(1)', offset: 0.25 },
            { opacity: 0.9, transform: 'translate(-50%, -50%) scale(1)' },
          ],
          { duration: 1000, easing: 'ease-out', fill: 'forwards' },
        );
      }
    }
  }

  /**
   * 히트마커 (글자 없음, 색·크기로만 구분): 일반 = 짧은 흰색, 헤드샷 = 노랑-주황·조금 크게, 처치 = 빨강·가장 크게 + 고리.
   * 확정된 명중만 (연습전 = 로컬 판정, 멀티 = 서버 결과). 연속 명중마다 다시 시작
   */
  showHit(headshot: boolean, killed: boolean): void {
    const hm = this.hitmarker;
    hm.classList.toggle('head', headshot);
    hm.classList.toggle('kill', killed);
    this.hitAnim?.cancel();
    const s0 = killed ? 1.6 : headshot ? 1.45 : 1.25;
    this.hitAnim = hm.animate(
      [
        { opacity: 1, transform: `scale(${s0})` },
        { opacity: 1, transform: 'scale(1)', offset: killed ? 0.3 : 0.4 },
        { opacity: 0, transform: 'scale(0.92)' },
      ],
      { duration: killed ? 380 : headshot ? 240 : 170, easing: 'ease-out' },
    );
    if (killed) {
      // 처치: 화면 가운데 짧은 "POP!" (버블이 터지듯 커졌다 사라짐, 260ms · 조준점 위쪽이라 시야를 오래 가리지 않음)
      this.popAnim?.cancel();
      this.popAnim = this.popEl.animate(
        [
          { opacity: 0, transform: 'translate(-50%, -50%) scale(.6)' },
          { opacity: 1, transform: 'translate(-50%, -50%) scale(1.15)', offset: 0.35 },
          { opacity: 0, transform: 'translate(-50%, -50%) scale(1.3)' },
        ],
        { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 260, easing: 'ease-out' },
      );
      this.killRingAnim?.cancel();
      this.killRingAnim = hm.querySelector('b')!.animate(
        [
          { opacity: 0.95, transform: 'scale(0.55)' },
          { opacity: 0, transform: 'scale(1.6)' },
        ],
        { duration: 360, easing: 'ease-out' },
      );
    }
  }

  /** 피해 숫자: 요소를 풀에서 재사용, 연속 명중은 좌우·위로 엇갈려 배치 */
  damagePopup(world: THREE.Vector3, damage: number, headshot: boolean): void {
    let el = this.popupPool.pop();
    if (!el) {
      const oldest = this.popups.shift();
      if (!oldest) return;
      el = oldest.el;
    }
    el.className = `dmg${headshot ? ' head' : ''}`;
    el.textContent = String(Math.round(damage));
    el.style.display = '';
    const seq = this.popupSeq++;
    this.popups.push({
      el,
      world: world.clone(),
      life: POPUP_LIFE,
      // 5칸 × 3줄로 엇갈려 배치 (10발/초 연사에서도 숫자가 덜 겹치게)
      offsetX: (((seq * 3) % 5) - 2) * 24,
      offsetY: -(seq % 3) * 16,
    });
  }

  /**
   * 무기별 조준선. 모양·선 길이는 무기 설정(CrosshairDef), 크기(선 간격·원 반지름)는 실제 탄 퍼짐 px.
   * 표시값은 실제 값으로 빠르게 따라감(0.1초에 약 92%) → 이동·점프처럼 즉시 바뀌는 퍼짐도 튀지 않고 실제와 거의 같음.
   * 무기를 바꾸면 이전 무기 값을 끌고 오지 않도록 바로 맞춤.
   */
  private updateCrosshair(f: HudFrame, height: number): void {
    const ch = f.crosshair ?? DEFAULT_CROSSHAIR;
    const el = this.crosshair;
    if (f.weaponId !== this.crosshairWeapon) {
      this.crosshairWeapon = f.weaponId;
      this.spreadShown = f.spreadPx;
      el.dataset.style = ch.style;
    } else {
      this.spreadShown += (f.spreadPx - this.spreadShown) * (1 - Math.exp(-CROSSHAIR_SHARPNESS * f.dt));
    }
    // 선 길이·굵기·점은 화면 높이에 비례 (1080p 기준), 간격·원은 실제 각도를 투영한 px 그대로
    const ui = THREE.MathUtils.clamp(height / 1080, 0.75, 1.6);
    const gap = Math.max(ch.minGap * ui, this.spreadShown);
    const key = `${ch.style}|${(ch.lineLength * ui).toFixed(1)}|${(ch.lineWidth * ui).toFixed(1)}|${(ch.dotSize * ui).toFixed(1)}`;
    if (key !== this.crosshairKey) {
      this.crosshairKey = key;
      el.style.setProperty('--len', `${(ch.lineLength * ui).toFixed(1)}px`);
      el.style.setProperty('--w', `${(ch.lineWidth * ui).toFixed(1)}px`);
      el.style.setProperty('--dot', `${(ch.dotSize * ui).toFixed(1)}px`);
    }
    el.style.setProperty('--gap', `${gap.toFixed(1)}px`);
  }

  /** 디버그·검증용: 지금 화면에 그린 조준선 크기 (px) */
  get crosshairShownPx(): number {
    return this.spreadShown;
  }

  /** 확정된 사망 1건을 킬로그에 추가 */
  pushKill(e: KillFeedEvent): void {
    this.killFeed.push(e);
  }

  /** 새 매치: 킬로그 비우기 */
  clearKillFeed(): void {
    this.killFeed.clear();
  }

  /** 디버그: 킬로그에 보이는 줄 수 */
  get killFeedCount(): number {
    return this.killFeed.count;
  }

  update(f: HudFrame, camera: THREE.Camera, width: number, height: number): void {
    // 화면 크기 → HUD 배율 (1280×720 기준, 작은 모바일 가로 0.6 ~ 큰 화면 1.2)
    const scale = THREE.MathUtils.clamp(Math.min(width / 1280, height / 720), 0.6, 1.2).toFixed(2);
    if (scale !== this.lastScale) {
      this.lastScale = scale;
      this.root.style.setProperty('--u', scale);
    }
    this.root.classList.toggle('show-debug', f.debug);
    this.killFeed.update(performance.now());
    this.updateMatch(f.match);
    this.updateCrosshair(f, height);
    this.crosshair.classList.toggle('hidden', f.dead || f.scopeOverlay > 0.5);
    this.scope.style.opacity = f.scopeOverlay.toFixed(3);
    // 빨간색 = 실제 사격 판정 기준으로 적에게 맞음. 총구 막힘은 조준선 색이 아니라 탄착 표시로만 알림
    this.crosshair.classList.toggle('enemy', f.enemyTargeted);
    // ADS: 가운데 점 강조 (모양·크기는 실제 탄 퍼짐 그대로)
    this.crosshair.classList.toggle('ads', f.aiming && !f.melee);
    if (f.blockedAt) {
      _v.copy(f.blockedAt).project(camera);
      const visible = _v.z < 1;
      this.blocked.style.display = visible ? '' : 'none';
      this.blocked.style.transform = `translate(${((_v.x + 1) / 2) * width}px, ${((1 - _v.y) / 2) * height}px) translate(-50%, -50%)`;
    } else {
      this.blocked.style.display = 'none';
    }
    this.scope.style.display = f.scopeOverlay > 0 ? '' : 'none';
    this.updateWeapon(f);
    this.updateReload(f);
    this.adsTag.classList.toggle('show', f.aiming);
    this.death.classList.toggle('show', f.dead);
    // 쓰러진 동안 적 이름·체력 표시(.labels)는 숨김 → 쓰러짐 패널을 가리지 않게
    this.root.classList.toggle('player-dead', f.dead);
    if (f.dead) {
      this.death.querySelector('b')!.textContent = f.killedBy ? `${f.killedBy}에게 쓰러짐!` : '쓰러짐!';
      this.death.querySelector('span')!.textContent = `${f.respawnIn.toFixed(1)}초 후 부활`;
    }
    this.updateHealth(f);
    this.updateIndicators(f);
    this.updateLabels(f, camera, width, height);
    if (this.noticeTimer > 0) {
      this.noticeTimer -= f.dt;
      if (this.noticeTimer <= 0) this.noticeEl.classList.remove('show');
    }

    if (f.debug) {
      const fpsText = `${f.fps.toFixed(0)} FPS`;
      if (fpsText !== this.lastFpsText) {
        this.fps.textContent = fpsText;
        this.lastFpsText = fpsText;
      }
      this.debug.textContent = f.debugLines.join('\n');
    }

    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i]!;
      p.life -= f.dt;
      const t = 1 - p.life / POPUP_LIFE;
      _v.copy(p.world).project(camera);
      const visible = _v.z < 1 && p.life > 0;
      p.el.style.display = visible ? '' : 'none';
      const x = ((_v.x + 1) / 2) * width + p.offsetX;
      const y = ((1 - _v.y) / 2) * height + p.offsetY - t * 42;
      const pop = t < 0.15 ? 1 + (1 - t / 0.15) * 0.5 : 1;
      p.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${pop.toFixed(3)})`;
      p.el.style.opacity = String(Math.min(1, p.life / 0.3));
      if (p.life <= 0) {
        p.el.style.display = 'none';
        this.popupPool.push(p.el);
        this.popups.splice(i, 1);
      }
    }
  }

  /**
   * 우측 하단 무기 카드 (아이콘·이름·탄창/예비·재장전·탄약 경고) + 하단 중앙 슬롯 바.
   * 근접무기는 탄약 줄을 숨김. 투척무기는 아직 없어 슬롯·탄약 모두 표시하지 않음
   */
  /**
   * 조준선 아래 재장전 표시: 원형 게이지(실제 무기 재장전 시간 기준 진행률) + '재장전'.
   * 같은 무기에서 재장전이 끝나고 탄창이 늘면 짧게 '완료!'. 취소·무기 교체·사망·경기 종료는 바로 숨김
   */
  private updateReload(f: HudFrame): void {
    const prev = this.reloadPrev;
    const finished = prev.on && !f.reloading && prev.weaponId === f.weaponId && f.magazine > prev.magazine && !f.dead;
    if (finished) this.reloadDone = 0.55;
    // 무기 교체·사망·재장전 다시 시작은 완료 표시를 바로 지움
    else if (f.dead || f.reloading || prev.weaponId !== f.weaponId) this.reloadDone = 0;
    else this.reloadDone = Math.max(0, this.reloadDone - f.dt);
    const busy = f.reloading && !f.dead && !f.melee;
    const done = !busy && this.reloadDone > 0;
    this.reload.classList.toggle('show', busy || done);
    if (this.reload.classList.contains('done') !== done) {
      this.reload.classList.toggle('done', done);
      // 완료 순간 한 번 톡 (표시 요소 크기만, 버튼 아님)
      if (done) this.reload.animate([{ scale: '1.25' }, { scale: '1' }], { duration: 260, easing: 'cubic-bezier(.2,1.6,.4,1)' });
    }
    const label = done ? RELOAD_TEXT.done : RELOAD_TEXT.busy;
    if (this.reloadLabel.textContent !== label) this.reloadLabel.textContent = label;
    const p = done ? 1 : busy ? f.reloadProgress : 0;
    this.reloadRing.style.strokeDashoffset = (100 - p * 100).toFixed(2);
    this.reloadPrev = { on: busy, weaponId: f.weaponId, magazine: f.magazine };
  }

  private updateWeapon(f: HudFrame): void {
    if (f.weaponId !== this.lastWeaponId) {
      this.lastWeaponId = f.weaponId;
      // 실제 무기 모델 그림 (없으면 기존 SVG)
      const src = f.weaponId ? this.weaponImage?.(f.weaponId) : null;
      this.weaponIcon.classList.toggle('has-img', !!src);
      if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = f.weaponName;
        img.draggable = false;
        this.weaponIcon.replaceChildren(img);
      } else {
        this.weaponIcon.innerHTML = weaponIconSvg(f.weaponId);
      }
      this.weaponName.textContent = f.weaponName;
      this.weaponCard.animate([{ transform: 'translateY(6px) scale(.96)', opacity: 0.6 }, { transform: 'none', opacity: 1 }], { duration: 180, easing: 'ease-out' });
    }
    const empty = !f.melee && f.magazine === 0 && f.reserve === 0;
    const low = !f.melee && !f.reloading && f.magazine <= Math.ceil(f.magazineSize * LOW_AMMO);
    // 터치: PC 키(R) 안내 없음, 재장전 중은 조준선 아래 재장전 표시가 대신함 (중복 글자 없음)
    const touch = this.root.classList.contains('touch');
    const state = f.melee
      ? '근접 무기'
      : f.reloading
        ? touch ? '' : '재장전 중…'
        : empty
          ? '탄약 없음'
          : f.magazine === 0
            ? touch ? '재장전' : 'R 재장전'
            : low
              ? touch ? '탄약 부족' : '탄약 부족 · R'
              : '';
    const key = `${f.magazine}|${f.reserve}|${f.melee}|${f.reloading}|${state}|${low}`;
    if (key !== this.lastWeaponKey) {
      this.lastWeaponKey = key;
      this.magEl.textContent = String(f.magazine);
      this.resEl.textContent = `/ ${f.reserve}`;
      this.weaponState.textContent = state;
      this.weaponCard.classList.toggle('melee', f.melee);
      this.weaponCard.classList.toggle('reloading', f.reloading);
      this.weaponCard.classList.toggle('low', low);
      this.weaponCard.classList.toggle('empty', empty);
    }
    // 무기 카드 막대도 같은 진행률 (탄약 숫자는 완료 프레임에 같이 바뀜 — Weapon.update에서 같은 순간)
    this.cardReloadBar.style.transform = `scaleX(${f.reloading ? f.reloadProgress.toFixed(3) : 0})`;

    const slotsKey = f.slots.map((s) => `${s.key}${s.id}${s.name}`).join('|');
    if (slotsKey !== this.lastSlotsKey) {
      this.lastSlotsKey = slotsKey;
      this.lastActiveSlot = '';
      this.slotsEl.textContent = '';
      for (const s of f.slots) {
        const el = document.createElement('div');
        el.className = 'slot';
        el.dataset.key = s.key;
        el.innerHTML = `<b></b><span class="slot-icon">${weaponIconSvg(s.id)}</span><span class="slot-name"></span>`;
        el.querySelector('b')!.textContent = s.key;
        el.querySelector('.slot-name')!.textContent = s.name;
        el.title = s.name;
        // 터치 모드에서만 눌림 (PC는 HUD가 입력을 받지 않음)
        el.addEventListener('pointerdown', (e) => {
          if (!this.root.classList.contains('touch')) return;
          e.preventDefault();
          e.stopPropagation();
          el.classList.add('down');
          this.onSlotTap?.(Number(s.key) - 1);
        });
        for (const t of ['pointerup', 'pointercancel', 'pointerleave'] as const) el.addEventListener(t, () => el.classList.remove('down'));
        this.slotsEl.appendChild(el);
      }
    }
    const active = f.slots.find((s) => s.active)?.key ?? '';
    if (active !== this.lastActiveSlot) {
      const first = this.lastActiveSlot === '';
      this.lastActiveSlot = active;
      for (const el of this.slotsEl.children as HTMLCollectionOf<HTMLElement>) {
        const on = el.dataset.key === active;
        el.classList.toggle('active', on);
        if (on && !first) el.animate([{ transform: 'translateY(0) scale(1)' }, { transform: 'translateY(-6px) scale(1.12)', offset: 0.4 }, { transform: 'translateY(-3px) scale(1)' }], { duration: 220, easing: 'ease-out' });
      }
    }
  }

  /** 좌측 하단 체력 카드: 하트·현재/최대(캐릭터별)·둥근 바. 깎이면 흰 잔상이 늦게 따라옴, 낮으면 경고 */
  private updateHealth(f: HudFrame): void {
    const hp = Math.max(0, Math.ceil(f.hp));
    if (hp !== this.lastHp || f.maxHp !== this.lastMaxHp) {
      const dropped = this.lastHp >= 0 && hp < this.lastHp;
      this.lastHp = hp;
      this.lastMaxHp = f.maxHp;
      const pct = `${((Math.max(0, f.hp) / f.maxHp) * 100).toFixed(1)}%`;
      this.hpText.textContent = String(hp);
      this.hpMax.textContent = `/ ${f.maxHp}`;
      this.hpFill.style.width = pct;
      // 피해: 잔상 바는 잠깐 머물렀다 줄어듦 (CSS transition-delay) / 회복: 바로 맞춤
      this.hpLag.classList.toggle('instant', !dropped);
      this.hpLag.style.width = pct;
      this.hpCard.classList.toggle('low', f.hp > 0 && f.hp <= f.maxHp * LOW_HP);
      // 중간 체력(60% 이하): 막대를 주황으로 (낮음 30% 이하는 빨강)
      this.hpCard.classList.toggle('mid', f.hp > f.maxHp * LOW_HP && f.hp <= f.maxHp * 0.6);
      // 줄어든 만큼 잔상 바가 잠깐 반짝임
      if (dropped) this.hpLag.animate([{ filter: 'brightness(1.6)' }, { filter: 'brightness(1)' }], { duration: 300, easing: 'ease-out' });
      // 체력 낮음: 숫자·막대(hp low)와 함께 화면 가장자리도 붉게
      this.root.classList.toggle('low-hp', f.hp > 0 && f.hp <= f.maxHp * LOW_HP);
      this.hpCard.classList.toggle('empty', f.hp <= 0);
    }
    this.protectTag.classList.toggle('show', f.protection > 0 && !f.dead);
  }

  /** 공격 방향: 카메라 기준 각도로 화면 중앙 둘레에 호 표시 (위 = 정면, 오른쪽 = 오른쪽) */
  private updateIndicators(f: HudFrame): void {
    for (const d of this.indicators) {
      if (d.life <= 0) continue;
      d.life = f.dead ? 0 : d.life - f.dt;
      const a = Math.atan2(d.source.x - f.playerPos.x, d.source.z - f.playerPos.z);
      // 카메라 정면 방향의 yaw = cameraYaw + π (TpsCamera 규칙). 이 각도 기준 시계 방향이 화면 오른쪽
      const rel = -(a - (f.cameraYaw + Math.PI));
      d.el.style.transform = `rotate(${Math.atan2(Math.sin(rel), Math.cos(rel)).toFixed(3)}rad)`;
      d.el.style.opacity = d.life > 0 ? Math.min(1, d.life / 0.4).toFixed(2) : '0';
    }
  }

  private updateLabels(f: HudFrame, camera: THREE.Camera, width: number, height: number): void {
    while (this.labelEls.length < f.botLabels.length) {
      const el = document.createElement('div');
      el.className = 'bot-label';
      el.innerHTML = '<b></b><div class="bl-bar"><div></div></div>';
      this.labelHost.appendChild(el);
      this.labelEls.push(el);
    }
    for (let i = 0; i < this.labelEls.length; i++) {
      const el = this.labelEls[i]!;
      const l = f.botLabels[i];
      if (!l || !l.visible || l.dead) {
        el.style.display = 'none';
        continue;
      }
      _v.copy(l.world).project(camera);
      if (_v.z > 1) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      el.style.transform = `translate(${((_v.x + 1) / 2) * width}px, ${((1 - _v.y) / 2) * height}px) translate(-50%, -100%)`;
      const name = el.firstChild as HTMLElement;
      const text = l.protected ? `${l.name} · 보호` : l.name;
      if (name.textContent !== text) name.textContent = text;
      (el.querySelector('.bl-bar div') as HTMLDivElement).style.width = `${((l.hp / l.maxHp) * 100).toFixed(0)}%`;
      el.classList.toggle('protected', l.protected);
      el.classList.toggle('ally', l.ally);
    }
  }

  dispose(): void {
    this.killFeed.dispose();
    this.root.remove();
  }
}
