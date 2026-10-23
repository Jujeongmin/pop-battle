// 유료 캐릭터 상품 (서버·클라이언트 공용). VXShop 대시보드 Product ID ↔ 게임 캐릭터 id (config/characters.ts의 id 그대로).
// SHONI = 'white' (character_white.glb), BAM = 'black' (character_black.glb) — 표시 이름이 아니라 CHARACTERS[id].name으로 확인한 값.
// 보유 원본 = 서버 계정별 글로벌 사용자 상태 chars (구매는 서버 $onItemPurchased만 기록, 클라이언트는 읽기만).

/** Product ID → 캐릭터 id */
export const CHARACTER_PRODUCTS = {
  'character-shoni': 'white',
  'character-bam': 'black',
} as const;

export type CharacterProductId = keyof typeof CHARACTER_PRODUCTS;

/** 캐릭터 id → Product ID */
export const PAID_CHARACTER_PRODUCT: Readonly<Record<string, CharacterProductId>> = {
  white: 'character-shoni',
  black: 'character-bam',
};

/** 대시보드 등록 가격 (표시 기본값 — 실제 가격·구매 가능 여부는 VXShop 조회값이 우선, 조회 못 하면 구매 버튼 끔) */
export const CHARACTER_PRICE_VX = 300;

export function isPaidCharacter(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(PAID_CHARACTER_PRODUCT, id);
}

export function characterOfProduct(productId: string): string | null {
  return Object.prototype.hasOwnProperty.call(CHARACTER_PRODUCTS, productId) ? CHARACTER_PRODUCTS[productId as CharacterProductId] : null;
}

/** 계정 글로벌 상태 → 보유한 유료 캐릭터 id (모르는 값·중복 제거) */
export function ownedCharacters(state: unknown): string[] {
  const raw = (state as { chars?: unknown } | null)?.chars;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((c): c is string => typeof c === 'string' && isPaidCharacter(c)))];
}

/** 이 캐릭터를 쓸 수 있는지 (무료 캐릭터는 항상, 유료는 보유했을 때만) */
export function canUseCharacter(id: string, owned: readonly string[]): boolean {
  return !isPaidCharacter(id) || owned.includes(id);
}
