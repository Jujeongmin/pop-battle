/**
 * Touch/pen activation that remains stable when the handler immediately hides its button.
 * Pointer capture guarantees a short tap's pointerup. A capture-phase guard consumes only the
 * compatibility click that follows activation, before it can be retargeted to newly revealed UI.
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
    activePointer = event.pointerId;
    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      // Older embedded browsers can omit pointer capture; pointerup still works when it stays over the button.
    }
  });

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
    const suppressCompatibilityClick = (click: MouseEvent) => {
      if (click.detail === 0 || performance.now() - pointerActivatedAt >= 800) return;
      click.preventDefault();
      click.stopImmediatePropagation();
      window.removeEventListener('click', suppressCompatibilityClick, true);
    };
    window.addEventListener('click', suppressCompatibilityClick, true);
    window.setTimeout(() => window.removeEventListener('click', suppressCompatibilityClick, true), 800);
    activate();
  });

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    // Keyboard/programmatic clicks have detail 0 and must remain available.
    if (event.detail > 0 && performance.now() - pointerActivatedAt < 800) return;
    activate();
  });
}
