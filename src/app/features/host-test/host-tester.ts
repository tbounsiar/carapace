import { inject, Service } from '@angular/core';
import {
  HostTestService,
  type HostTestRequest,
  type HostTestResult,
  type TestCredential,
} from '../../core/ipc/host-test';
import { IpcError } from '../../core/ipc/ipc-error';
import type { HostKeyPrompt } from '../../core/ipc/ssh.models';
import type { CredentialDialogData } from '../credential-dialog/credential-dialog';
import { CredentialPrompter } from '../credential-dialog/credential-prompter';
import { HostKeyPrompter } from '../host-key-dialog/host-key-prompter';

export interface HostTestDraft extends HostTestRequest {
  /** Resolved `user@host:port`, as the preview shows it. */
  readonly address: string;
  /** Resolved key path (key auth), the subject of the passphrase prompt. */
  readonly keyPath: string;
}

/** Where a refused secret came from: typed in the test prompt, a secret variable, or the keychain. */
export type SecretOrigin = 'typed' | 'variable' | 'stored';

export type HostTestOutcome =
  | { readonly kind: 'success'; readonly result: HostTestResult; readonly durationMs: number }
  | { readonly kind: 'failure'; readonly error: IpcError; readonly origin: SecretOrigin }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'aborted' };

export interface HostTestRun {
  readonly outcome: Promise<HostTestOutcome>;
  /** Stops the probe; `outcome` resolves `aborted` at once. */
  abort(): void;
}

interface Prompt {
  readonly label: string;
  readonly data: CredentialDialogData;
}

/** Runs a draft through the connect path with the test variants of the prompts. Shows no toast. */
@Service()
export class HostTester {
  private readonly ipc = inject(HostTestService);
  private readonly hostKeys = inject(HostKeyPrompter);
  private readonly credentials = inject(CredentialPrompter);

  start(draft: HostTestDraft): HostTestRun {
    let aborted = false;
    let testId: string | null = null;
    let resolveAborted: (outcome: HostTestOutcome) => void = () => undefined;
    const abortedOutcome = new Promise<HostTestOutcome>((resolve) => (resolveAborted = resolve));
    let promptMs = 0;
    const timed = async <T>(open: () => Promise<T>): Promise<T> => {
      const opened = performance.now();
      try {
        return await open();
      } finally {
        promptMs += performance.now() - opened;
      }
    };
    const decide = (prompt: HostKeyPrompt): Promise<boolean> =>
      timed(() => this.hostKeys.ask(prompt, { acceptLabel: 'Accept and test' }));

    const run = async (): Promise<HostTestOutcome> => {
      const startedAt = performance.now();
      let credential: TestCredential | null = null;
      for (;;) {
        const id = crypto.randomUUID();
        testId = id;
        try {
          const result = await this.ipc.test(draft, id, decide, credential);
          testId = null;
          const durationMs = Math.max(0, performance.now() - startedAt - promptMs);
          return { kind: 'success', result, durationMs };
        } catch (raw) {
          testId = null;
          if (aborted) {
            return { kind: 'aborted' };
          }
          const error = raw instanceof IpcError ? raw : new IpcError('unknown', 'Unexpected error');
          if (error.code === 'cancelled') {
            return { kind: 'cancelled' };
          }
          const typed = credential !== null;
          const prompt = this.credentialPrompt(draft, error, typed);
          if (!prompt) {
            return { kind: 'failure', error, origin: this.origin(draft, typed) };
          }
          const answer = await timed(() => this.credentials.ask(prompt.label, prompt.data));
          if (aborted) {
            return { kind: 'aborted' };
          }
          if (!answer) {
            return { kind: 'cancelled' };
          }
          credential = { secret: answer.secret, remember: false };
        }
      }
    };

    return {
      outcome: Promise.race([run(), abortedOutcome]),
      abort: () => {
        if (aborted) {
          return;
        }
        aborted = true;
        if (testId) {
          this.ipc.cancel(testId).catch(() => undefined);
        }
        resolveAborted({ kind: 'aborted' });
      },
    };
  }

  /** A secret typed in the prompt is asked again when refused; a stored one is what is being tested. */
  private credentialPrompt(draft: HostTestDraft, err: IpcError, typed: boolean): Prompt | null {
    const auth = draft.host.auth;
    const asked = err.code === 'secret_required';
    if (auth.kind === 'password' && (asked || (typed && err.code === 'auth_failed'))) {
      const error = asked ? null : 'The server rejected the password. Try again.';
      return {
        label: 'Password',
        data: { kind: 'password', subject: draft.address, error, forTest: true },
      };
    }
    if (auth.kind === 'key' && (asked || (typed && err.code === 'invalid_passphrase'))) {
      const error = asked ? null : 'Wrong passphrase. Try again.';
      return {
        label: 'Key passphrase',
        data: { kind: 'passphrase', subject: draft.keyPath, error, forTest: true },
      };
    }
    return null;
  }

  /** Mirrors the backend order: typed, else the secret variable, else the keychain. */
  private origin(draft: HostTestDraft, typed: boolean): SecretOrigin {
    if (typed) {
      return 'typed';
    }
    const auth = draft.host.auth;
    const reference =
      auth.kind === 'password' ? auth.password : auth.kind === 'key' ? auth.passphrase : null;
    return reference ? 'variable' : 'stored';
  }
}
