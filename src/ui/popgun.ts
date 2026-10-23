// 팝건 계급 아이콘 (로비·대기실·상황판·결과 화면 공용). 레벨 → 단계 → public/assets/ui/popgun/popgun_lv_XXX.png
// 이미지는 단계마다 개별 파일 → 특정 단계 PNG만 바꿔 넣어도 그대로 적용. 매핑은 net/shared/progression.ts (POPGUN_TIERS)
import { popgunTier, rankName } from '../net/shared/progression';

export function popgunUrl(level: number): string {
  return `${import.meta.env.BASE_URL}assets/ui/popgun/${popgunTier(level).file}`;
}

/** 계급 아이콘 img (alt = 계급 이름) */
export function popgunImg(level: number, cls = 'popgun-icon'): HTMLImageElement {
  const img = document.createElement('img');
  img.className = cls;
  img.src = popgunUrl(level);
  img.alt = rankName(level);
  img.title = `${rankName(level)} · Lv.${level}`;
  img.draggable = false;
  img.decoding = 'async';
  return img;
}

/** 아이콘 + "Lv.N" 작은 표시 (대기실·상황판) */
export function levelBadge(level: number, cls = 'popgun-badge'): HTMLSpanElement {
  const b = document.createElement('span');
  b.className = cls;
  const lv = document.createElement('b');
  lv.textContent = `Lv.${level}`;
  b.append(popgunImg(level), lv);
  return b;
}
