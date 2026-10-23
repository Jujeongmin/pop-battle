// 첫 접속 창과 SETTINGS 변경 창이 같은 닉네임 규칙·피드백을 쓰도록 묶은 작은 입력 UI.
// 입력 중 1차 검사는 서버와 같은 checkNickname(nickFilter.ts), 최종 승인은 host.setNickname(서버 nickSet).
import { checkNickname, NICK_RULE, tidyNick, type NickFailReason } from '../../net/shared/nickFilter';
import { button, el, type LobbyHost, type NicknameResult } from './lobbyDom';

export const NICKNAME_RULE = `${NICK_RULE.min}~${NICK_RULE.max}자 · 한글, 영문, 숫자만 사용할 수 있어요.`;

/** 실패 이유별 안내 (금칙어는 어떤 말에 걸렸는지 알려 주지 않음) */
export function nicknameMessage(reason: NickFailReason | 'rate' | 'taken' | 'server' | undefined, retryMs?: number): string {
  switch (reason) {
    case 'empty':
      return '닉네임을 입력해 주세요.';
    case 'length':
      return `${NICK_RULE.min}~${NICK_RULE.max}자로 입력해 주세요.`;
    case 'chars':
      return '한글, 영문, 숫자만 사용할 수 있어요.';
    case 'blocked':
      return '사용할 수 없는 닉네임입니다. 다른 이름을 입력해 주세요.';
    case 'taken':
      return '이미 다른 플레이어가 쓰는 닉네임이에요. 다른 이름을 입력해 주세요.';
    case 'rate':
      // 서버(또는 이 기기 저장)가 알려 준 남은 시간만 표시, 모르면 시간 없이
      return retryMs !== undefined && retryMs > 0 ? `${Math.ceil(retryMs / 1000)}초 뒤에 다시 변경할 수 있어요.` : '잠시 후 다시 변경해 주세요.';
    default:
      return '서버 확인에 실패했어요. 잠시 후 다시 시도해 주세요.';
  }
}

interface NicknameEditorOptions {
  buttonLabel: string;
  initialValue?: string;
  /** 처음 값과 같으면 저장 버튼을 끔 (변경 창) */
  requireChange?: boolean;
  /** 저장 버튼 옆에 둘 버튼 (변경 창의 취소) */
  extraButton?: HTMLButtonElement;
  onSuccess?(value: string): void;
}

export interface NicknameEditor {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
  submit(): void;
  /** 처음 값으로 되돌리고 안내 지움 */
  reset(value: string): void;
}

export function nicknameEditor(host: LobbyHost, options: NicknameEditorOptions): NicknameEditor {
  const root = el('div', 'lb-nickname-editor');
  const row = el('div', 'lb-nickname-row');
  const field = el('div', 'lb-nickname-field');
  const input = el('input', 'lb-nickname-input');
  input.type = 'text';
  // 공백 정리 전 입력은 조금 넉넉히 (글자 수 검사는 정리한 뒤)
  input.maxLength = NICK_RULE.max + 8;
  input.setAttribute('autocomplete', 'off');
  input.autocapitalize = 'off';
  input.spellcheck = false;
  input.placeholder = '닉네임 입력';
  input.value = options.initialValue ?? '';
  input.setAttribute('aria-label', '닉네임');
  const counter = el('span', 'lb-nickname-counter');
  field.append(input, counter);

  const submitButton = button(options.buttonLabel, 'lb-nickname-submit', () => submit());
  const rule = el('p', 'lb-nickname-rule', NICKNAME_RULE);
  const feedback = el('p', 'lb-nickname-feedback');
  feedback.setAttribute('aria-live', 'polite');
  let initial = tidyNick(options.initialValue ?? '');
  let busy = false;
  /** 서버가 거절한 값 (같은 값이면 안내 유지) */
  let rejected: { value: string; text: string } | null = null;

  const show = (text: string, ok: boolean | null): void => {
    feedback.className = `lb-nickname-feedback${ok === null ? '' : ok ? ' lb-nickname-valid' : ' lb-nickname-invalid'}`;
    feedback.textContent = text;
  };

  /** 입력할 때마다: 글자 수·형식·금칙어 1차 검사 → 버튼 상태와 안내 */
  const validate = (): string | null => {
    const tidy = tidyNick(input.value);
    const len = [...tidy].length;
    counter.textContent = `${len}/${NICK_RULE.max}`;
    counter.classList.toggle('lb-nickname-counter-over', len > NICK_RULE.max);
    const r = checkNickname(input.value);
    const same = options.requireChange && r.ok && r.value === initial;
    submitButton.disabled = busy || !r.ok || !!same;
    input.setAttribute('aria-invalid', String(input.value.length > 0 && !r.ok));
    if (busy) return r.ok ? r.value : null;
    if (rejected && tidy === rejected.value) show(rejected.text, false);
    else if (input.value.length === 0) show('', null);
    else if (!r.ok) show(nicknameMessage(r.reason), false);
    else if (same) show('지금 쓰는 닉네임이에요.', null);
    else show('사용할 수 있는 형식이에요. 서버에서 한 번 더 확인해요.', true);
    return r.ok ? r.value : null;
  };

  const setBusy = (on: boolean): void => {
    busy = on;
    input.disabled = on;
    root.classList.toggle('lb-nickname-busy', on);
    submitButton.textContent = on ? '확인 중…' : options.buttonLabel;
    if (options.extraButton) options.extraButton.disabled = on;
  };

  function submit(): void {
    if (busy) return;
    const value = validate();
    if (value === null || submitButton.disabled) {
      input.focus();
      return;
    }
    setBusy(true);
    show('서버에서 확인하는 중…', null);
    host
      .setNickname(value)
      .catch((): NicknameResult => ({ ok: false, reason: 'server' }))
      .then((result) => {
        setBusy(false);
        if (!result.ok) {
          rejected = { value, text: nicknameMessage(result.reason, result.retryMs) };
          validate();
          input.focus();
          return;
        }
        const saved = result.value ?? value;
        rejected = null;
        initial = saved;
        input.value = saved;
        validate();
        show(`저장했어요: ${saved}`, true);
        options.onSuccess?.(saved);
      });
  }

  input.addEventListener('input', () => validate());
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    submit();
  });
  input.addEventListener('keyup', (event) => event.stopPropagation());

  row.append(field, submitButton);
  if (options.extraButton) row.append(options.extraButton);
  root.append(row, rule, feedback);
  validate();
  return {
    root,
    input,
    submit,
    reset(value: string) {
      initial = tidyNick(value);
      input.value = value;
      rejected = null;
      validate();
    },
  };
}
