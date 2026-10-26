/**
 * Touch/pen activation that remains stable when the handler immediately hides its button.
 * Cancelling pointerdown prevents a compatibility click from being retargeted
 * to the newly revealed UI, while pointer capture guarantees that the matching pointerup arrives.
 */
export function bindButtonActivation(button: HTMLButtonElement, activate: () => void): void {
  let activePointer: number | null = null;
  let pointerActivatedAt = -Infinity;

  const release = (pointerId: number) => {
    if (button.hasPointerCapture?.(pointerId)) {
      try {
        button.releasePointerCapture(pointerId);
      } catch {
        // The browser can release capture itself when the element becomes hidden.
      }
    }
  };

  button.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
    if ((event.pointerType !== 'touch' && event.pointerType !== 'pen') || activePointer !== null || button.disabled) return;
    // pointerup.preventDefault() is too late to reliably suppress a mobile compatibility click.
    event.preventDefault();
    activePointer = event.pointerId;
    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      // Older embedded browsers can omit pointer capture; pointerup still works when it stays over the button.
    }
  });

  // Chromium 기반 모바일 웹뷰는 pointerdown 취소 뒤에도 TouchEvent에서 호환 click을 만들 수 있다.
  // source button이 사라지는 전환에서는 그 click이 새 backdrop으로 재지정되므로 touchstart도 취소한다.
  button.addEventListener('touchstart', (event) => {
    event.preventDefault();
    event.stopPropagation();
  }, { passive: false });

  button.addEventListener('pointercancel', (event) => {
    if (event.pointerId !== activePointer) return;
    activePointer = null;
    release(event.pointerId);
  });

  button.addEventListener('pointerup', (event) => {
    if (event.pointerId !== activePointer || (event.pointerType !== 'touch' && event.pointerType !== 'pen')) return;
    event.preventDefault();
    event.stopPropagation();
    activePointer = null;
    release(event.pointerId);
    if (button.disabled) return;
    pointerActivatedAt = performance.now();
    activate();
  });

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    // Keyboard/programmatic clicks have detail 0 and must remain available.
    if (event.detail > 0 && performance.now() - pointerActivatedAt < 800) return;
    activate();
  });
}
