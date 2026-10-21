import * as THREE from 'three';
import type { CrosshairDef } from '../config/weapons';
import type { BotLabel } from '../bots/BotManager';
import { COMBAT } from '../config/combat';
import type { MatchRules } from '../config/match';
import type { MatchResult, MatchState } from '../match/Match';
import { KillFeed, type KillFeedEvent } from './KillFeed';

/** 매치 정보 (상단 바·카운트다운) */
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
  /** 1/2/3 슬롯 */
  slots: ReadonlyArray<{ key: string; name: string; active: boolean }>;
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

const _v = new THREE.Vector3();

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

/** HTML/CSS HUD: 크로스헤어, 탄약, 재장전, ADS 표시, 히트마커, 피해 숫자, FPS. */
export class Hud {
  private readonly root: HTMLDivElement;
  private readonly crosshair: HTMLDivElement;
  private readonly scope: HTMLDivElement;
  private readonly blocked: HTMLDivElement;
  private readonly hitmarker: HTMLDivElement;
  private readonly ammo: HTMLDivElement;
  private readonly reload: HTMLDivElement;
  private readonly reloadBar: HTMLDivElement;
  private readonly adsTag: HTMLDivElement;
  private readonly fps: HTMLDivElement;
  private readonly debug: HTMLPreElement;
  private readonly death: HTMLDivElement;
  private readonly lockOverlay: HTMLDivElement;
  private readonly popups: Popup[] = [];
  private readonly popupPool: HTMLDivElement[] = [];
  private popupSeq = 0;
  private readonly killConfirm: HTMLDivElement;
  private hitAnim: Animation | null = null;
  private crosshairWeapon = '';
  private crosshairKey = '';
  private spreadShown = 0;
  private lastFpsText = '';
  private readonly hpBar: HTMLDivElement;
  private readonly hpFill: HTMLDivElement;
  private readonly hpText: HTMLSpanElement;
  private readonly protectTag: HTMLDivElement;
  private readonly hurtFlash: HTMLDivElement;
  private readonly labelHost: HTMLDivElement;
  private readonly indicators: DamageIndicator[] = [];
  private readonly labelEls: HTMLDivElement[] = [];
  private lastHp = -1;
  private readonly weaponName: HTMLDivElement;
  private readonly slotsEl: HTMLDivElement;
  private readonly loadoutButtons: HTMLDivElement;
  private readonly loadoutNote: HTMLDivElement;
  private readonly charCards: HTMLDivElement;
  private readonly charNote: HTMLDivElement;
  private lastWeaponText = '';
  private lastSlotsKey = '';
  private readonly matchBar: HTMLDivElement;
  private readonly countdownEl: HTMLDivElement;
  private readonly resultEl: HTMLDivElement;
  private lastMatchKey = '';
  private lastCountdown = '';
  private resultShown = false;
  private locked = false;
  /** 결과 화면 "다시 플레이" 버튼 */
  onReplay: (() => void) | null = null;
  /** 우측 상단 실시간 킬로그 */
  private readonly killFeed: KillFeed;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="scope"><div class="scope-lens"><i class="h"></i><i class="v"></i><i class="c"></i></div></div>
      <div class="crosshair" data-style="cross"><i class="ring"></i><i class="t"></i><i class="b"></i><i class="l"></i><i class="r"></i><i class="dot"></i></div>
      <div class="blocked-marker"></div>
      <div class="hitmarker"><i></i><i></i><i></i><i></i></div>
      <div class="kill-confirm">KO!</div>
      <div class="weapon-hud"><div class="weapon-name"></div><div class="slots"></div></div>
      <div class="ammo"><b class="mag">30</b><span class="res">/ 120</span></div>
      <div class="reload"><span>재장전</span><div class="bar"><div></div></div></div>
      <div class="ads-tag">ADS</div>
      <div class="fps">-- FPS</div>
      <pre class="debug-lines"></pre>
      <div class="death"><b>쓰러짐!</b> <span></span></div>
      <div class="hurt-flash"></div>
      <div class="damage-dirs"></div>
      <div class="labels"></div>
      <div class="hp"><span class="hp-text">100</span><div class="hp-bar"><div></div></div></div>
      <div class="protect-tag">보호 중</div>
      <div class="match-bar hidden">
        <div class="mb-kd"><span><b class="mb-k">0</b>킬</span><span><b class="mb-d">0</b>데스</span></div>
        <div class="mb-center"><div class="mb-time">3:00</div><div class="mb-goal">개인전 · 15킬 먼저</div></div>
        <div class="mb-rank"><b>1</b>위<small>/ 4</small></div>
      </div>
      <div class="countdown"></div>
      <div class="result hidden">
        <div class="result-card">
          <div class="res-title"></div>
          <div class="res-reason"></div>
          <table class="res-table"><thead><tr><th>순위</th><th>이름</th><th>킬</th><th>데스</th></tr></thead><tbody></tbody></table>
          <button type="button" class="res-replay">다시 플레이</button>
        </div>
      </div>
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
          <p>화면을 클릭해서 시작</p>
          <ul>
            <li><b>WASD</b> 이동 · <b>W 두 번</b> 달리기 · <b>Shift</b> 슬라이딩 · <b>Space</b> 점프</li>
            <li><b>좌클릭</b> 사격 · <b>우클릭</b> 조준 켜기/끄기 · <b>R</b> 재장전</li>
            <li><b>1</b> 주무기 · <b>2</b> 권총 · <b>3</b> 뿅망치 · <b>휠</b> 무기 순환</li>
            <li><b>K</b> 사망 테스트 · <b>\`</b> 디버그 패널</li>
          </ul>
          <ul class="touch-guide">
            <li>모바일: <b>가상 조이스틱</b> 이동 · <b>조이스틱 전방 유지</b> 달리기 · <b>슬라이딩 버튼</b> 슬라이딩</li>
          </ul>
        </div>
      </div>`;
    parent.appendChild(this.root);
    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector(sel) as T;
    this.crosshair = q('.crosshair');
    this.scope = q('.scope');
    this.blocked = q('.blocked-marker');
    this.hitmarker = q('.hitmarker');
    this.killConfirm = q('.kill-confirm');
    for (let i = 0; i < POPUP_POOL; i++) {
      const el = document.createElement('div');
      el.className = 'dmg';
      el.style.display = 'none';
      this.root.appendChild(el);
      this.popupPool.push(el);
    }
    this.ammo = q('.ammo');
    this.reload = q('.reload');
    this.reloadBar = q('.reload .bar div');
    this.adsTag = q('.ads-tag');
    this.fps = q('.fps');
    this.debug = q('.debug-lines');
    this.death = q('.death');
    this.lockOverlay = q('.lock-overlay');
    this.weaponName = q('.weapon-name');
    this.slotsEl = q('.slots');
    this.loadoutButtons = q('.lo-buttons');
    this.loadoutNote = q('.loadout:not(.char-select) .lo-note');
    this.charCards = q('.cs-cards');
    this.charNote = q('.cs-note');
    this.hpBar = q('.hp');
    this.hpFill = q('.hp-bar div');
    this.hpText = q('.hp-text');
    this.protectTag = q('.protect-tag');
    this.hurtFlash = q('.hurt-flash');
    this.labelHost = q('.labels');
    this.matchBar = q('.match-bar');
    this.countdownEl = q('.countdown');
    this.resultEl = q('.result');
    q<HTMLButtonElement>('.res-replay').addEventListener('click', (e) => {
      e.stopPropagation();
      this.onReplay?.();
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

  /** 플레이어 피격: 화면 가장자리 빨간 섬광 + 공격 방향 표시 */
  showDamage(source: THREE.Vector3 | null, amount: number): void {
    this.hurtFlash.animate([{ opacity: Math.min(0.85, 0.35 + amount / 40) }, { opacity: 0 }], { duration: 380, easing: 'ease-out' });
    if (!source) return;
    // 같은 방향(가까운 지점) 표시는 갱신, 아니면 가장 오래된 칸 재사용
    let slot = this.indicators.find((d) => d.life > 0 && d.source.distanceTo(source) < 2);
    if (!slot) slot = this.indicators.reduce((a, b) => (a.life <= b.life ? a : b));
    slot.source.copy(source);
    slot.life = COMBAT.damageIndicatorTime;
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

  /** 시작 카드의 모드 안내 문구 (네트워크 테스트 모드 등) */
  setModeLine(text: string): void {
    this.root.querySelector('.mode-line')!.textContent = text;
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
    // 결과 화면이 떠 있으면 시작 안내 카드는 숨김 (결과 화면의 버튼으로 다시 시작)
    this.lockOverlay.classList.toggle('hidden', locked || this.resultShown);
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

  /** 매치 결과 화면: 승리/패배/무승부, 종료 사유, 순위표, 다시 플레이 */
  showResult(r: MatchResult, rules: MatchRules): void {
    const title = this.resultEl.querySelector<HTMLDivElement>('.res-title')!;
    const outcome = { win: '승리!', draw: '무승부', lose: '패배' }[r.localOutcome];
    title.textContent = outcome;
    title.dataset.outcome = r.localOutcome;
    const reason = r.reason === 'score' ? `${rules.scoreToWin}킬 달성으로 종료` : '시간 종료';
    const draw = r.draw ? ' · 공동 1위' : '';
    this.resultEl.querySelector('.res-reason')!.textContent = `${rules.label} · ${reason}${draw}`;
    const body = this.resultEl.querySelector('tbody')!;
    body.textContent = '';
    for (const s of r.standings) {
      const tr = document.createElement('tr');
      tr.classList.toggle('me', s.isLocal);
      tr.classList.toggle('first', r.winners.includes(s.id));
      for (const v of [`${s.rank}위`, s.name, String(s.kills), String(s.deaths)]) {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    this.resultShown = true;
    this.resultEl.classList.remove('hidden');
    this.root.classList.add('match-over');
    this.setLocked(this.locked);
  }

  hideResult(): void {
    this.resultShown = false;
    this.resultEl.classList.add('hidden');
    this.root.classList.remove('match-over');
    this.setLocked(this.locked);
  }

  /** 상단 매치 바 (남은 시간·킬/데스·순위·목표) + 카운트다운 숫자 */
  private updateMatch(m: MatchHudInfo): void {
    this.matchBar.classList.toggle('hidden', m.state === 'WAITING');
    const t = Math.ceil(m.timeLeft);
    const time = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    const key = `${time}|${m.kills}|${m.deaths}|${m.rank}|${m.players}|${m.scoreToWin}|${m.state}`;
    if (key !== this.lastMatchKey) {
      this.lastMatchKey = key;
      this.matchBar.querySelector('.mb-time')!.textContent = time;
      this.matchBar.querySelector('.mb-k')!.textContent = String(m.kills);
      this.matchBar.querySelector('.mb-d')!.textContent = String(m.deaths);
      this.matchBar.querySelector('.mb-rank b')!.textContent = String(m.rank);
      this.matchBar.querySelector('.mb-rank small')!.textContent = `/ ${m.players}`;
      this.matchBar.querySelector('.mb-goal')!.textContent = `${m.label} · ${m.scoreToWin}킬 먼저`;
      this.matchBar.classList.toggle('hurry', m.state === 'PLAYING' && m.timeLeft <= 10);
    }
    if (m.state === 'COUNTDOWN') {
      const n = String(Math.max(1, Math.ceil(m.countdown)));
      if (n !== this.lastCountdown) {
        this.lastCountdown = n;
        const el = this.countdownEl;
        el.classList.remove('go');
        el.textContent = n;
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

  /** 히트마커: 실제 피해가 들어갔을 때만 호출. 일반 흰색 / 헤드샷 노란색 / 처치 빨간색 + KO 표시. 연속 명중마다 다시 시작 */
  showHit(headshot: boolean, killed: boolean): void {
    const hm = this.hitmarker;
    hm.classList.toggle('head', headshot && !killed);
    hm.classList.toggle('kill', killed);
    this.hitAnim?.cancel();
    const s0 = killed ? 1.7 : headshot ? 1.5 : 1.3;
    this.hitAnim = hm.animate(
      [
        { opacity: 1, transform: `scale(${s0})` },
        { opacity: 1, transform: 'scale(1)', offset: 0.35 },
        { opacity: 0, transform: 'scale(0.9)' },
      ],
      { duration: killed ? 380 : 240, easing: 'ease-out' },
    );
    if (killed) {
      this.killConfirm.animate(
        [
          { opacity: 0, transform: 'translate(-50%, 0) scale(0.6)' },
          { opacity: 1, transform: 'translate(-50%, -6px) scale(1.15)', offset: 0.2 },
          { opacity: 1, transform: 'translate(-50%, -10px) scale(1)', offset: 0.7 },
          { opacity: 0, transform: 'translate(-50%, -16px) scale(1)' },
        ],
        { duration: 700, easing: 'ease-out' },
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
    this.killFeed.update(performance.now());
    this.updateMatch(f.match);
    this.updateCrosshair(f, height);
    this.crosshair.classList.toggle('hidden', f.dead || f.scopeOverlay > 0.5);
    this.scope.style.opacity = f.scopeOverlay.toFixed(3);
    // 빨간색 = 실제 사격 판정 기준으로 적에게 맞음. 총구 막힘은 조준선 색이 아니라 탄착 표시로만 알림
    this.crosshair.classList.toggle('enemy', f.enemyTargeted);
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
    this.ammo.querySelector('.mag')!.textContent = String(f.magazine);
    this.ammo.querySelector('.res')!.textContent = `/ ${f.reserve}`;
    this.ammo.classList.toggle('low', f.magazine <= Math.ceil(f.magazineSize * 0.2));
    this.reload.classList.toggle('show', f.reloading);
    this.reloadBar.style.width = `${(f.reloadProgress * 100).toFixed(0)}%`;
    this.adsTag.classList.toggle('show', f.aiming);
    this.death.classList.toggle('show', f.dead);
    if (f.dead) {
      this.death.querySelector('b')!.textContent = f.killedBy ? `${f.killedBy}에게 쓰러짐!` : '쓰러짐!';
      this.death.querySelector('span')!.textContent = `${f.respawnIn.toFixed(1)}초 후 부활`;
    }
    this.updateHealth(f);
    this.updateIndicators(f);
    this.updateLabels(f, camera, width, height);

    const fpsText = `${f.fps.toFixed(0)} FPS`;
    if (fpsText !== this.lastFpsText) {
      this.fps.textContent = fpsText;
      this.lastFpsText = fpsText;
    }
    this.debug.textContent = f.debugLines.join('\n');


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

  private updateWeapon(f: HudFrame): void {
    if (f.weaponName !== this.lastWeaponText) {
      this.weaponName.textContent = f.weaponName;
      this.lastWeaponText = f.weaponName;
    }
    const key = f.slots.map((s) => `${s.key}${s.name}${s.active ? '*' : ''}`).join('|');
    if (key !== this.lastSlotsKey) {
      this.lastSlotsKey = key;
      this.slotsEl.textContent = '';
      for (const s of f.slots) {
        const el = document.createElement('div');
        el.className = `slot${s.active ? ' active' : ''}`;
        el.innerHTML = '<b></b><span></span>';
        el.querySelector('b')!.textContent = s.key;
        el.querySelector('span')!.textContent = s.name;
        this.slotsEl.appendChild(el);
      }
    }
    this.ammo.style.display = f.melee ? 'none' : '';
  }

  private updateHealth(f: HudFrame): void {
    const hp = Math.ceil(f.hp);
    if (hp !== this.lastHp) {
      this.lastHp = hp;
      this.hpText.textContent = String(hp);
      this.hpFill.style.width = `${((f.hp / f.maxHp) * 100).toFixed(1)}%`;
      this.hpBar.classList.toggle('low', f.hp <= f.maxHp * 0.3);
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
