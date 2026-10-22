// 첫 접속 창과 SETTINGS가 같은 닉네임 규칙·피드백을 쓰도록 묶은 작은 입력 UI.
import { NICK_LIMITS, sanitizeNick } from '../../net/shared/protocol';
import { button, el, type LobbyHost } from './lobbyDom';

export const NICKNAME_RULE = `${NICK_LIMITS.min}~${NICK_LIMITS.max}자 · 모든 언어의 글자, 숫자, 공백, _ - . 만 사용할 수 있어요.`;

interface NicknameEditorOptions {
  buttonLabel: string;
  initialValue?: string;
  onSuccess?(value: string): void;
}

export interface NicknameEditor {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
  submit(): void;
}

/** 저장 호출 전에도 protocol.ts와 같은 검사로 버튼 상태와 안내를 바로 갱신한다. */
export function nicknameEditor(host: LobbyHost, options: NicknameEditorOptions): NicknameEditor {
  const root = el('div', 'lb-nickname-editor');
  const row = el('div', 'lb-nickname-row');
  const input = el('input', 'lb-nickname-input');
  input.type = 'text';
  input.maxLength = 24;
  input.setAttribute('autocomplete', 'nickname');
  input.autocapitalize = 'off';
  input.spellcheck = false;
  input.placeholder = '닉네임 입력';
  input.value = options.initialValue ?? '';
  input.setAttribute('aria-label', '닉네임');

  const submitButton = button(options.buttonLabel, 'lb-nickname-submit', () => submit());
  const rule = el('p', 'lb-nickname-rule', NICKNAME_RULE);
  const feedback = el('p', 'lb-nickname-feedback');
  feedback.setAttribute('aria-live', 'polite');

  const validate = (): string | null => {
    const value = sanitizeNick(input.value);
    submitButton.disabled = value === null;
    input.setAttribute('aria-invalid', String(input.value.length > 0 && value === null));
    feedback.className = `lb-nickname-feedback ${value === null ? 'lb-nickname-invalid' : 'lb-nickname-valid'}`;
    feedback.textContent = value === null
      ? input.value.length === 0
        ? '닉네임을 입력해 주세요.'
        : '사용할 수 없는 닉네임이에요.'
      : `사용할 수 있어요: ${value}`;
    return value;
  };

  function submit(): void {
    const value = validate();
    if (value === null) {
      feedback.className = 'lb-nickname-feedback lb-nickname-invalid';
      feedback.textContent = NICKNAME_RULE;
      input.focus();
      return;
    }
    const result = host.setNickname(value);
    if (!result.ok) {
      feedback.className = 'lb-nickname-feedback lb-nickname-invalid';
      feedback.textContent = NICKNAME_RULE;
      input.focus();
      return;
    }
    const saved = result.value ?? value;
    input.value = saved;
    feedback.className = 'lb-nickname-feedback lb-nickname-valid';
    feedback.textContent = `변경했어요: ${saved}`;
    options.onSuccess?.(saved);
  }

  input.addEventListener('input', validate);
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submit();
  });
  input.addEventListener('keyup', (event) => event.stopPropagation());

  row.append(input, submitButton);
  root.append(row, rule, feedback);
  validate();
  return { root, input, submit };
}
