// 유료 캐릭터 상점 (VXShop 공식 SDK @verse8/platform/vanilla): 상품 조회·결제창 열기만 클라이언트가, 지급은 서버($onItemPurchased)만.
// 보유 여부 = 서버 shopOwned 결과 (localStorage 저장 없음). 결제창이 닫히면 상품을 다시 받고, 결제했다고 해도
// 서버 보유 목록에 실제로 들어올 때까지 다시 조회 (클라이언트 이벤트만으로 지급 판단 안 함). 늦으면 '다시 확인' 안내.
// 가격·구매 가능 여부는 VXShop 조회값 우선 — 상품을 못 받으면(등록 전·연결 실패) 구매 버튼을 끔 (가짜 결제창 없음).
import { VXShop, type VXShopDialogClosedPayload, type VXShopItem } from '@verse8/platform/vanilla';
import { characterOfProduct, PAID_CHARACTER_PRODUCT } from './shared/shop';

/** 화면에 보여 줄 유료 캐릭터 상태 */
export interface CharacterOffer {
  charId: string;
  productId: string;
  /** VXShop 가격 (VX). 조회 전·실패면 null */
  price: number | null;
  owned: boolean;
  /** 구매 버튼을 누를 수 있음 */
  canBuy: boolean;
  /** 결제창이 열려 있거나 구매 확인 중 */
  busy: boolean;
  /** 결제는 끝났는데 서버 반영이 늦음 → '다시 확인' */
  delayed: boolean;
  /** 결제창 종료 뒤 브라우저가 자동 전체화면 복귀를 거부함 */
  returnFullscreen: boolean;
  /** 안내 한 줄 (구매 불가 이유·결과) */
  note: string;
}

/** 결제 후 서버 보유 목록 재확인 간격 (ms) — 합계 약 15초 */
const RECHECK_MS = [800, 1500, 2500, 4000, 6000];

export class CharacterShop {
  private started = false;
  private initError: string | null = null;
  private owned = new Set<string>();
  /** 서버 보유 목록을 한 번이라도 받았는지 (못 받으면 구매 버튼 끔: 이미 가진 걸 또 사지 않게) */
  private ownedKnown = false;
  private busy: string | null = null;
  /** 결제 전에 게임 전체화면이었으면 닫힘 뒤 복귀할 캐릭터 */
  private restoreFullscreenFor: string | null = null;
  /** 자동 requestFullscreen이 거부되어 사용자 클릭이 필요한 캐릭터 */
  private fullscreenReturnFor: string | null = null;
  private readonly notes = new Map<string, string>();
  private readonly delayed = new Set<string>();
  private readonly listeners = new Set<() => void>();

  /** fetchOwned: 서버 shopOwned (실패하면 null) */
  constructor(private readonly fetchOwned: () => Promise<string[] | null>) {}

  /** VXShop 초기화 (한 번만). Verse8 iframe 안에서는 auth 토큰으로 verse·계정이 정해짐 */
  start(): void {
    if (this.started) return;
    this.started = true;
    try {
      VXShop.onClose((p) => void this.afterClose(p));
      VXShop.subscribe(() => this.emit());
      VXShop.init();
    } catch (e) {
      this.initError = e instanceof Error ? e.message : String(e);
      this.emit();
    }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** 서버 보유 목록 반영 */
  setOwned(chars: readonly string[]): void {
    this.owned = new Set(chars);
    this.ownedKnown = true;
    for (const c of chars) this.delayed.delete(c);
    this.emit();
  }

  owns(charId: string): boolean {
    return this.owned.has(charId);
  }

  /** 서버 보유 목록 다시 받기 (실패하면 false) */
  async syncOwned(): Promise<boolean> {
    const list = await this.fetchOwned();
    if (!list) return false;
    this.setOwned(list);
    return true;
  }

  /** 상점 전체 상태 한 줄 (상품을 못 받았을 때 이유) */
  status(): { loading: boolean; error: string | null } {
    const s = VXShop.getState();
    if (this.initError) return { loading: false, error: '상점을 시작하지 못했어요' };
    if (window.parent === window) return { loading: false, error: 'Verse8 게임 화면에서만 구매할 수 있어요' };
    if (s.error) return { loading: false, error: '상품 정보를 불러오지 못했어요' };
    return { loading: s.isLoading, error: null };
  }

  offer(charId: string): CharacterOffer | null {
    const productId = PAID_CHARACTER_PRODUCT[charId];
    if (!productId) return null;
    const owned = this.owned.has(charId);
    const item: VXShopItem | undefined = this.started ? VXShop.getItem(productId) : undefined;
    const busy = this.busy === productId;
    const st = this.status();
    let note = this.notes.get(charId) ?? '';
    let canBuy = false;
    if (owned) note = note || '보유 중 · 장착할 수 있어요';
    else if (busy) note = note || '결제창에서 진행해 주세요';
    else if (st.error) note = note || st.error;
    else if (st.loading && !item) note = note || '상품 정보를 불러오는 중…';
    else if (!item) note = note || '아직 판매 중인 상품이 아니에요';
    else if (!this.ownedKnown) note = note || '보유 정보를 확인하는 중…';
    else if (item.purchaseLimitReached) note = note || '이미 구매한 상품이에요 · 반영을 다시 확인해 주세요';
    // SDK의 원문 사유(예: "User not found")를 그대로 노출하지 않는다. 로그인/상품 상태가
    // 바뀌면 subscribe/refresh가 다시 그리므로, 화면에는 일관된 사용자 안내만 보여 준다.
    else if (!item.purchasable) note = note || '지금은 구매할 수 없어요 · 잠시 후 다시 확인해 주세요';
    else canBuy = !this.busy && this.fullscreenReturnFor !== charId;
    return {
      charId,
      productId,
      price: item ? item.price : null,
      owned,
      canBuy,
      busy,
      delayed: this.delayed.has(charId) && !owned,
      returnFullscreen: this.fullscreenReturnFor === charId,
      note,
    };
  }

  /** 구매 버튼: 공식 결제창 열기 (지급은 서버만). 중복 클릭·이미 보유·조회 실패는 열지 않음 */
  async buy(charId: string): Promise<void> {
    const o = this.offer(charId);
    if (!o || !o.canBuy) return;
    this.busy = o.productId;
    this.fullscreenReturnFor = null;
    this.restoreFullscreenFor = document.fullscreenElement ? charId : null;
    this.notes.delete(charId);
    this.emit();
    if (this.restoreFullscreenFor) {
      try {
        await document.exitFullscreen();
      } catch {
        this.busy = null;
        this.restoreFullscreenFor = null;
        this.notes.set(charId, '전체화면을 닫지 못해 결제창을 열 수 없어요 · 다시 시도해 주세요');
        return this.emit();
      }
    }
    try {
      VXShop.buyItem(o.productId);
    } catch {
      this.busy = null;
      this.notes.set(charId, '결제창을 열지 못했어요 · 잠시 후 다시 시도해 주세요');
      await this.restoreFullscreen(charId);
      this.emit();
    }
  }

  /** 자동 복귀가 거부됐을 때 사용자 클릭 안에서 다시 요청 */
  async returnToFullscreen(charId: string): Promise<void> {
    if (this.fullscreenReturnFor !== charId) return;
    await this.restoreFullscreen(charId);
    this.emit();
  }

  /** 결제 뒤 반영이 늦을 때 '다시 확인' */
  async recheck(charId: string): Promise<void> {
    this.notes.set(charId, '서버 보유 정보를 다시 확인하는 중…');
    this.emit();
    const ok = await this.syncOwned();
    if (this.owned.has(charId)) this.notes.set(charId, '구매 완료! 이제 장착할 수 있어요');
    else this.notes.set(charId, ok ? '아직 반영되지 않았어요 · 잠시 후 다시 확인해 주세요' : '서버에 연결하지 못했어요 · 다시 확인해 주세요');
    this.emit();
  }

  /** 결제창 닫힘: 상품 다시 받기 → 결제했다면 서버 보유 목록에 들어올 때까지 재확인 */
  private async afterClose(p: VXShopDialogClosedPayload): Promise<void> {
    if (this.busy !== p.productId) return;
    const charId = characterOfProduct(p.productId);
    this.busy = null;
    void VXShop.refresh().catch(() => undefined);
    if (!charId) return this.emit();
    await this.restoreFullscreen(charId);
    if (!p.purchased) {
      this.notes.set(charId, '결제를 취소했어요 · 캐릭터는 지급되지 않았어요');
      return this.emit();
    }
    this.notes.set(charId, '구매 확인 중…');
    this.emit();
    for (const ms of RECHECK_MS) {
      await new Promise((r) => window.setTimeout(r, ms));
      await this.syncOwned();
      if (this.owned.has(charId)) {
        this.notes.set(charId, '구매 완료! 이제 장착할 수 있어요');
        return this.emit();
      }
    }
    this.delayed.add(charId);
    this.notes.set(charId, '결제는 끝났지만 아직 반영되지 않았어요 · 잠시 후 다시 확인해 주세요');
    this.emit();
  }

  /** 결제 전 전체화면이었던 경우 복귀. 사용자 제스처가 필요하면 버튼 상태를 남긴다. */
  private async restoreFullscreen(charId: string): Promise<void> {
    if (this.restoreFullscreenFor !== charId && this.fullscreenReturnFor !== charId) return;
    this.restoreFullscreenFor = null;
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      this.fullscreenReturnFor = null;
    } catch {
      this.fullscreenReturnFor = charId;
    }
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }
}
