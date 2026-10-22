// LOADOUT: 주무기 선택 (라이플·샷건·스나이퍼, 고르면 가운데 캐릭터가 바로 들고 있음) + 고정 보조·근접무기. 스킨은 준비 중
import { toGame } from '../../core/screenRotation';
import { button, comingSoon, el, type LobbyHost, type LobbyPanel, type LobbyWeapon } from './lobbyDom';

export class LoadoutPanel implements LobbyPanel {
  readonly id = 'loadout';
  readonly title = '장비';
  private stopPreview: (() => void) | null = null;
  private previewBody: HTMLElement | null = null;
  private inactive = false;

  constructor(private readonly host: LobbyHost) {}

  render(body: HTMLElement): void {
    // 같은 패널을 다시 그릴 때 이전 캔버스의 관찰자와 애니메이션을 먼저 정리한다.
    this.stopPreview?.();
    this.stopPreview = null;
    this.previewBody = body;
    this.inactive = false;

    const primaryWeapons = this.host.primaryWeapons();
    const selected = primaryWeapons.find((weapon) => weapon.id === this.host.currentPrimary()) ?? primaryWeapons[0];
    const preview = this.createPreview(selected);
    body.appendChild(preview.element);
    this.stopPreview = preview.stop;
    if (selected) preview.show(selected);

    body.appendChild(el('div', 'lb-section', '1 · 주무기'));
    const grid = el('div', 'lb-weapon-grid');
    const cards: HTMLButtonElement[] = [];
    const mark = () => {
      const cur = this.host.currentPrimary();
      for (const card of cards) {
        const isSelected = card.dataset.id === cur;
        card.classList.toggle('lb-selected', isSelected);
        card.setAttribute('aria-pressed', String(isSelected));
      }
    };
    for (const weapon of primaryWeapons) {
      const card = button('', 'lb-weapon', () => {
        this.host.selectPrimary(weapon.id);
        mark();
        preview.show(weapon);
      });
      card.appendChild(this.weaponContent(weapon, '주무기'));
      card.dataset.id = weapon.id;
      card.setAttribute('aria-pressed', 'false');
      cards.push(card);
      grid.appendChild(card);
    }
    body.appendChild(grid);
    mark();

    const fixed = this.host.fixedWeapons();
    body.appendChild(el('div', 'lb-section', '2 · 보조무기 / 3 · 근접무기 (고정)'));
    const row = el('div', 'lb-weapon-grid lb-two');
    for (const [weapon, slot] of [[fixed.secondary, '보조무기'], [fixed.melee, '근접무기']] as const) {
      const card = el('div', 'lb-weapon lb-fixed');
      card.appendChild(this.weaponContent(weapon, slot));
      row.appendChild(card);
    }
    body.appendChild(row);
    body.appendChild(comingSoon('무기 스킨', '무기 색·꾸미기는 정비소 단계에서 열려요. 무기 능력치는 바뀌지 않아요.'));
  }

  deactivate(): void {
    this.stopPreview?.();
    this.stopPreview = null;
    this.inactive = true;
  }

  activate(): void {
    if (!this.inactive || !this.previewBody?.isConnected) return;
    this.previewBody.textContent = '';
    this.previewBody.scrollTop = 0;
    this.render(this.previewBody);
  }

  dispose(): void {
    this.deactivate();
    this.previewBody = null;
  }

  private weaponContent(weapon: LobbyWeapon, slot: string): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const visual = el('span', 'lb-weapon-icon');
    const source = this.host.weaponImage(weapon.id);
    if (source) {
      const image = el('img');
      image.src = source;
      image.alt = weapon.name;
      image.draggable = false;
      visual.appendChild(image);
    }
    fragment.append(el('span', 'lb-weapon-slot', slot), visual, el('b', '', weapon.name));
    return fragment;
  }

  private createPreview(initial: LobbyWeapon | undefined): {
    element: HTMLElement;
    show: (weapon: LobbyWeapon) => void;
    stop: () => void;
  } {
    const element = el('section', 'lb-weapon-preview');
    const stage = el('div', 'lb-weapon-preview-stage');
    const canvas = el('canvas', 'lb-weapon-preview-canvas');
    const name = el('b', 'lb-weapon-preview-name', initial?.name ?? '무기 미리보기');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', initial ? `${initial.name} 3D 미리보기` : '무기 3D 미리보기');
    stage.append(canvas, el('span', 'lb-weapon-preview-hint', '좌우로 드래그해서 돌려 보기'));
    element.append(stage, name);

    // 실시간 3D: 게임 렌더러가 이 캔버스에 실제 무기 모델을 그림 (각도가 바뀐 프레임에만)
    const preview = this.host.weaponPreview(canvas);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    /** 지금 무기 id (없으면 '') / 회전 각도 (rad, 0 = 옆모습) */
    let weaponId = '';
    let angle = 0;
    let animationFrame = 0;
    let lastTime: number | null = null;
    let resumeAt = 0;
    let pointerId: number | null = null;
    let pointerX = 0;
    let stopped = false;

    const resizeBackingStore = () => {
      // 레이아웃 크기 (화면을 돌려 그릴 때 getBoundingClientRect는 가로·세로가 바뀜)
      const rect = { width: canvas.clientWidth, height: canvas.clientHeight };
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(rect.width * ratio));
      const height = Math.max(1, Math.round(rect.height * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      return { width: rect.width, height: rect.height, ratio };
    };

    const draw = () => {
      if (!weaponId) return;
      const before = canvas.width * 100000 + canvas.height;
      resizeBackingStore();
      if (canvas.width * 100000 + canvas.height !== before) preview.redraw();
      preview.show(weaponId, angle);
    };

    const tick = (time: number) => {
      animationFrame = 0;
      if (stopped || !canvas.isConnected) {
        stop();
        return;
      }
      if (lastTime === null) lastTime = time;
      const elapsed = Math.min(time - lastTime, 100);
      lastTime = time;
      if (pointerId === null && time >= resumeAt && !reducedMotion.matches && weaponId) {
        // 6초에 한 바퀴, 프레임 시간 기준 (끊김 없이 일정한 속도)
        angle = (angle + (elapsed / 6000) * Math.PI * 2) % (Math.PI * 2);
        draw();
      }
      if (!reducedMotion.matches) animationFrame = requestAnimationFrame(tick);
    };

    const startAnimation = () => {
      if (stopped || animationFrame || reducedMotion.matches || !canvas.isConnected) return;
      lastTime = null;
      animationFrame = requestAnimationFrame(tick);
    };

    const show = (weapon: LobbyWeapon) => {
      if (stopped) return;
      weaponId = weapon.id;
      angle = 0;
      lastTime = null;
      name.textContent = weapon.name;
      canvas.setAttribute('aria-label', `${weapon.name} 3D 미리보기`);
      draw();
      startAnimation();
    };

    const onPointerDown = (event: PointerEvent) => {
      event.stopPropagation();
      if (pointerId !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
      pointerId = event.pointerId;
      pointerX = toGame(event.clientX, event.clientY).x;
      canvas.classList.add('lb-dragging');
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      event.stopPropagation();
      if (event.pointerId !== pointerId || !weaponId) return;
      const x = toGame(event.clientX, event.clientY).x;
      const distance = x - pointerX;
      pointerX = x;
      angle += (distance / Math.max(canvas.clientWidth, 280)) * Math.PI * 2;
      draw();
    };
    const releasePointer = (event: PointerEvent) => {
      event.stopPropagation();
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      canvas.classList.remove('lb-dragging');
      resumeAt = performance.now() + 1500;
      lastTime = null;
      startAnimation();
    };
    const stopEvent = (event: Event) => event.stopPropagation();
    const onMotionChange = () => {
      if (reducedMotion.matches) {
        if (animationFrame) cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      } else {
        startAnimation();
      }
    };
    const observer = new ResizeObserver(draw);

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', releasePointer);
    canvas.addEventListener('pointercancel', releasePointer);
    canvas.addEventListener('lostpointercapture', releasePointer);
    for (const type of ['mousedown', 'touchstart', 'wheel'] as const) canvas.addEventListener(type, stopEvent);
    reducedMotion.addEventListener('change', onMotionChange);
    observer.observe(canvas);

    function stop() {
      if (stopped) return;
      stopped = true;
      preview.dispose();
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      observer.disconnect();
      reducedMotion.removeEventListener('change', onMotionChange);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', releasePointer);
      canvas.removeEventListener('pointercancel', releasePointer);
      canvas.removeEventListener('lostpointercapture', releasePointer);
      for (const type of ['mousedown', 'touchstart', 'wheel'] as const) canvas.removeEventListener(type, stopEvent);
    }

    return { element, show, stop };
  }
}
