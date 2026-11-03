import { inject, Service } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import type { HostInput } from './config.models';
import { invokeCommand } from './ipc-error';
import { SshService } from './ssh';
import type { ConnectEvent, Credential, HostKeyPrompt } from './ssh.models';

/** The unsaved form values to test, in the scope of the dialog. */
export interface HostTestRequest {
  readonly host: HostInput;
  readonly projectId: string | null;
  /** Set when editing a saved host, so the backend can use its saved connection secret. */
  readonly hostId: string | null;
}

export type SecretSource = 'typed' | 'variable' | 'saved' | 'keyPassphrase';

export interface HostTestResult {
  address: string;
  authKind: 'password' | 'key' | 'agent';
  secretSource: SecretSource | null;
  durationMs: number;
}

/** A credential typed for a test is never remembered. */
export interface TestCredential {
  secret: string;
  remember: false;
}

/** `test_host` / `cancel_host_test`: a probe connection that registers no session. */
@Service()
export class HostTestService {
  private readonly ssh = inject(SshService);

  async test(
    request: HostTestRequest,
    testId: string,
    decide: (prompt: HostKeyPrompt) => Promise<boolean>,
    credential: TestCredential | null,
  ): Promise<HostTestResult> {
    const onEvent = new Channel<ConnectEvent>();
    // Changed keys come back as a `host_key_changed` error: a test never offers to replace them.
    onEvent.onmessage = (event) => {
      if (event.kind === 'hostKeyPrompt') {
        void this.answer(event, decide);
      }
    };
    return invokeCommand<HostTestResult>('test_host', {
      host: request.host,
      projectId: request.projectId,
      hostId: request.hostId,
      testId,
      onEvent,
      credential: credential satisfies Credential | null,
    });
  }

  async cancel(testId: string): Promise<void> {
    await invokeCommand<null>('cancel_host_test', { testId });
  }

  private async answer(
    prompt: HostKeyPrompt,
    decide: (prompt: HostKeyPrompt) => Promise<boolean>,
  ): Promise<void> {
    const accept = await decide(prompt).catch(() => false);
    try {
      await this.ssh.answerHostKey(prompt.requestId, accept);
    } catch {
      // test_host fails by itself once the request is gone
    }
  }
}
