// 그래픽 품질 (설정 > 일반 > 그래픽 품질): 낮음 / 보통 / 높음. 이 기기에 기억, 바꾸면 바로 적용 (Game.applyGraphics).
// 전투에 필요한 것(캐릭터·무기·탄 궤적·피격 연출·캐릭터 그림자)은 모든 단계에서 그대로.
import { RENDER } from './gameConfig';

export type GraphicsQuality = 'low' | 'medium' | 'high';

export interface GraphicsPreset {
  /** 렌더 해상도 배율 상한 (기기 devicePixelRatio보다 크게는 안 씀) — PC / 터치 기기 */
  maxPixelRatio: number;
  mobileMaxPixelRatio: number;
  /** 해 그림자 맵 크기 (그림자 범위는 같음 → 작을수록 그림자 경계가 흐려짐) */
  shadowMapSize: number;
  /** 맵 구조물(엄폐물·벽 장식·로비 섬)도 그림자를 드리울지. 캐릭터 그림자는 항상 */
  staticShadows: boolean;
  /** 배경 도시를 가벼운 조명 재질로 (반사광 없음, 모양·색은 같음) */
  simpleBackdrop: boolean;
}

export const GRAPHICS_PRESETS: Record<GraphicsQuality, GraphicsPreset> = {
  // 높음 = 기존 그래픽 그대로
  high: {
    maxPixelRatio: RENDER.maxPixelRatio,
    mobileMaxPixelRatio: RENDER.mobileMaxPixelRatio,
    shadowMapSize: RENDER.shadowMapSize,
    staticShadows: true,
    simpleBackdrop: false,
  },
  medium: { maxPixelRatio: 1.5, mobileMaxPixelRatio: 1.25, shadowMapSize: 1024, staticShadows: true, simpleBackdrop: false },
  low: { maxPixelRatio: 1, mobileMaxPixelRatio: 1, shadowMapSize: 512, staticShadows: false, simpleBackdrop: true },
};

const KEY = 'popbattle.graphics';
const listeners = new Set<(q: GraphicsQuality) => void>();

function saved(): GraphicsQuality | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'low' || v === 'medium' || v === 'high' ? v : null;
  } catch {
    return null;
  }
}

let current: GraphicsQuality = saved() ?? 'medium';

export function getGraphicsQuality(): GraphicsQuality {
  return current;
}

/** 품질 바꾸기 (기억 + 바로 적용) */
export function setGraphicsQuality(q: GraphicsQuality): void {
  if (q === current) return;
  current = q;
  try {
    localStorage.setItem(KEY, q);
  } catch {
    // 저장 못 해도 이번에는 적용
  }
  for (const cb of listeners) cb(q);
}

export function onGraphicsQualityChange(cb: (q: GraphicsQuality) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
