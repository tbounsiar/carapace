import { translate } from '@jsverse/transloco';
import { localeOf } from '../../core/i18n/language';
import type { HostTestResult } from '../../core/ipc/host-test';
import type { IpcError } from '../../core/ipc/ipc-error';
import { errorText, sentence } from '../../shared/save-error';
import type { HostTestDraft, HostTestOutcome, SecretOrigin } from './host-tester';

/** A piece of copy; `mono` for addresses, paths and references, `strong` for names. */
export interface Part {
  readonly text: string;
  readonly mono?: boolean;
  readonly strong?: boolean;
}

export type HostTestState = 'testing' | 'success' | 'failure' | 'cancelled';

export interface HostTestView {
  readonly state: HostTestState;
  readonly code: string | null;
  readonly title: readonly Part[];
  readonly detail: readonly Part[];
}

const text = (value: string): Part => ({ text: value });
export const mono = (value: string): Part => ({ text: value, mono: true });

const MARK = '\u0001';

/**
 * Translates `key` and cuts it at the `parts` placeholders, so each one keeps its own style
 * wherever the language puts it. `plain` placeholders are interpolated as text.
 */
export function translateParts(
  key: string,
  parts: Readonly<Record<string, Part>>,
  plain: Readonly<Record<string, string>> = {},
): Part[] {
  const marked: Record<string, string> = { ...plain };
  for (const name of Object.keys(parts)) {
    marked[name] = `${MARK}${name}${MARK}`;
  }
  return translate<string>(key, marked)
    .split(MARK)
    .map((piece, i) => (i % 2 ? (parts[piece] ?? text(piece)) : text(piece)))
    .filter((part) => part.text !== '');
}

const t = (key: string, params?: Record<string, string>): Part =>
  text(translate<string>(`hostTest.${key}`, params));
const f = (name: string): string => `hostTest.failure.${name}`;

export function testingView(draft: HostTestDraft): HostTestView {
  return {
    state: 'testing',
    code: null,
    title: translateParts('hostTest.testing', { address: mono(draft.address) }),
    detail: [],
  };
}

export function cancelledView(): HostTestView {
  return { state: 'cancelled', code: null, title: [t('cancelled')], detail: [] };
}

/** Translated when read, so it never keeps the language active when the module loaded. */
export const CANCELLED_VIEW: HostTestView = {
  state: 'cancelled',
  code: null,
  get title(): readonly Part[] {
    return cancelledView().title;
  },
  detail: [],
};

/** Null for an aborted test: the values it was testing are gone, nothing is shown. */
export function outcomeView(outcome: HostTestOutcome, draft: HostTestDraft): HostTestView | null {
  switch (outcome.kind) {
    case 'aborted':
      return null;
    case 'cancelled':
      return cancelledView();
    case 'success':
      return {
        state: 'success',
        code: null,
        title: translateParts('hostTest.connectedAs', { address: mono(outcome.result.address) }),
        detail: [...authParts(outcome.result, draft), text(` · ${duration(outcome.durationMs)}`)],
      };
    case 'failure':
      return failureView(outcome.error, outcome.origin, draft);
  }
}

/** The `Intl` locale of the interface language, which `LanguageService` writes to `<html lang>`. */
function locale(): string {
  return localeOf(document.documentElement.lang);
}

/** "N ms" under one second, else "N.N s". */
export function duration(ms: number): string {
  if (ms < 1000) {
    const value = new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(ms);
    return translate<string>('hostTest.duration.ms', { value });
  }
  const value = new Intl.NumberFormat(locale(), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(Math.round(ms / 100) / 10);
  return translate<string>('hostTest.duration.s', { value });
}

function reference(draft: HostTestDraft): string {
  const auth = draft.host.auth;
  return (
    (auth.kind === 'password' ? auth.password : auth.kind === 'key' ? auth.passphrase : '') ?? ''
  );
}

function authParts(result: HostTestResult, draft: HostTestDraft): Part[] {
  const source = result.secretSource;
  const ref = { ref: mono(reference(draft)) };
  if (result.authKind === 'agent') {
    return [t('auth.agent')];
  }
  if (result.authKind === 'password') {
    if (source === 'typed') {
      return [t('auth.passwordTyped')];
    }
    if (source === 'variable') {
      return translateParts('hostTest.auth.passwordFrom', ref);
    }
    return [t(source ? 'auth.passwordSaved' : 'auth.password')];
  }
  if (source === 'typed') {
    return [t('auth.keyTyped')];
  }
  if (source === 'variable') {
    return translateParts('hostTest.auth.keyFrom', ref);
  }
  return [t(source ? 'auth.keySaved' : 'auth.key')];
}

function split(address: string): { user: string; hostPort: string } {
  const at = address.lastIndexOf('@');
  return { user: address.slice(0, Math.max(at, 0)), hostPort: address.slice(at + 1) };
}

function origin(
  secret: 'password' | 'passphrase',
  from: SecretOrigin,
  draft: HostTestDraft,
): Part[] {
  if (from === 'variable') {
    const ref = { ref: mono(reference(draft)) };
    return [...translateParts(`hostTest.origin.${secret}Variable`, ref), text(' ')];
  }
  return from === 'stored' ? [t(`origin.${secret}Stored`), text(' ')] : [];
}

function failure(code: string, title: Part[], detail: Part[]): HostTestView {
  return { state: 'failure', code, title, detail };
}

function failureView(err: IpcError, from: SecretOrigin, draft: HostTestDraft): HostTestView {
  const { user, hostPort } = split(draft.address);
  const auth = draft.host.auth.kind;
  const detail = err.message.trim() ? `${sentence(err.message)} ` : '';
  const host = { host: mono(hostPort) };
  const path = { path: mono(draft.keyPath) };
  switch (err.code) {
    case 'network':
      return failure(err.code, translateParts(f('network.title'), host), [
        t('failure.network.detail', { detail }),
      ]);
    case 'timeout':
      return failure(err.code, translateParts(f('timeout.title'), host), [
        t('failure.timeout.detail'),
      ]);
    case 'auth_failed':
      if (auth === 'password') {
        return failure(
          err.code,
          [t('failure.passwordRejected.title')],
          [...origin('password', from, draft), t('failure.passwordRejected.detail')],
        );
      }
      if (auth === 'key') {
        return failure(
          err.code,
          [t('failure.keyRefused.title')],
          translateParts(f('keyRefused.detail'), {
            file: mono('~/.ssh/authorized_keys'),
            user: mono(user),
          }),
        );
      }
      return failure(
        err.code,
        [t('failure.agentRefused.title')],
        [t('failure.agentRefused.detail', { detail })],
      );
    case 'invalid_passphrase':
      if (auth === 'key') {
        return failure(err.code, translateParts(f('wrongPassphrase.title'), path), [
          ...origin('passphrase', from, draft),
          t('failure.wrongPassphrase.detail'),
        ]);
      }
      break;
    case 'host_key_rejected':
      return failure(
        err.code,
        [t('failure.hostKeyRejected.title')],
        [t('failure.hostKeyRejected.detail')],
      );
    case 'host_key_changed':
      return failure(
        err.code,
        [t('failure.hostKeyChanged.title')],
        translateParts(f('hostKeyChanged.detail'), host),
      );
    case 'host_key_revoked':
      return failure(
        err.code,
        [t('failure.hostKeyRevoked.title')],
        translateParts(f('hostKeyRevoked.detail'), host),
      );
    case 'invalid_input':
      if (auth === 'key') {
        return failure(
          err.code,
          [t('failure.keyUnusable.title')],
          [t('failure.keyUnusable.detail', { detail })],
        );
      }
      break;
    case 'io':
    case 'not_found':
      if (/known_hosts/i.test(err.message)) {
        return failure(err.code, [t('failure.knownHostsUnreadable.title')], [text(detail.trim())]);
      }
      if (auth === 'key') {
        return failure(err.code, translateParts(f('keyUnreadable.title'), path), [
          t('failure.keyUnreadable.detail', { detail }),
        ]);
      }
      break;
    case 'keychain_unavailable':
      return failure(err.code, [t('failure.keychain.title')], [t('failure.keychain.detail')]);
    case 'missing_variables':
      return failure(
        err.code,
        [t('failure.missingVariables.title')],
        [t('failure.missingVariables.detail', { detail })],
      );
    case 'busy':
      return failure(err.code, [t('failure.busy.title')], [t('failure.busy.detail')]);
  }
  return failure(err.code, [t('failure.failed.title')], [text(errorText(err))]);
}
