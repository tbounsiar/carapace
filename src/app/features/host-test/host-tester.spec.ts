import { TestBed } from '@angular/core/testing';
import { TuiNotificationService } from '@taiga-ui/core';
import type { AuthMethod } from '../../core/ipc/config.models';
import { HostTestService, type HostTestResult } from '../../core/ipc/host-test';
import { IpcError } from '../../core/ipc/ipc-error';
import type { CommandErrorCode } from '../../core/ipc/config.models';
import type { HostKeyPrompt } from '../../core/ipc/ssh.models';
import { CredentialPrompter } from '../credential-dialog/credential-prompter';
import { HostKeyPrompter } from '../host-key-dialog/host-key-prompter';
import { HostTester, type HostTestDraft } from './host-tester';

const result: HostTestResult = {
  address: 'carapace@127.0.0.1:2223',
  authKind: 'password',
  secretSource: 'typed',
  durationMs: 40,
};
const prompt: HostKeyPrompt = {
  kind: 'hostKeyPrompt',
  requestId: 'r1',
  status: 'unknown',
  hostname: '127.0.0.1',
  port: 2223,
  algorithm: 'ssh-ed25519',
  fingerprint: 'SHA256:abc',
};

function draft(auth: AuthMethod): HostTestDraft {
  return {
    host: { name: '', hostname: '${host}', port: '2223', username: 'carapace', auth },
    projectId: 'p1',
    hostId: null,
    address: 'carapace@127.0.0.1:2223',
    keyPath: '/home/me/.ssh/id_enc',
  };
}

const fail = (code: CommandErrorCode): IpcError => new IpcError(code, 'safe message');

describe('HostTester', () => {
  const ipc = {
    test: vi.fn<HostTestService['test']>(),
    cancel: vi.fn(() => Promise.resolve()),
  };
  const hostKeys = { ask: vi.fn(() => Promise.resolve(true)), confirmReplace: vi.fn() };
  const credentials = { ask: vi.fn<CredentialPrompter['ask']>() };
  const alerts = { open: vi.fn() };
  let tester: HostTester;

  beforeEach(() => {
    vi.clearAllMocks();
    ipc.test.mockResolvedValue(result);
    TestBed.configureTestingModule({
      providers: [
        { provide: HostTestService, useValue: ipc },
        { provide: HostKeyPrompter, useValue: hostKeys },
        { provide: CredentialPrompter, useValue: credentials },
        { provide: TuiNotificationService, useValue: alerts },
      ],
    });
    tester = TestBed.inject(HostTester);
  });

  afterEach(() => expect(alerts.open).not.toHaveBeenCalled());

  it('tests the draft with no credential and reports the result', async () => {
    const d = draft({ kind: 'agent' });
    const outcome = await tester.start(d).outcome;
    expect(outcome).toMatchObject({ kind: 'success', result });
    const [request, testId, , credential] = ipc.test.mock.calls[0];
    expect(request).toBe(d);
    expect(testId).toMatch(/\S+/);
    expect(credential).toBeNull();
    expect(credentials.ask).not.toHaveBeenCalled();
  });

  it('asks about an unknown key with the test label', async () => {
    ipc.test.mockImplementation(async (_d, _id, decide) => {
      expect(await decide(prompt)).toBe(true);
      return result;
    });
    await tester.start(draft({ kind: 'agent' })).outcome;
    expect(hostKeys.ask).toHaveBeenCalledWith(prompt, { acceptLabel: 'Accept and test' });
  });

  it('prompts in test mode when a secret is required, then retries with it unremembered', async () => {
    ipc.test.mockRejectedValueOnce(fail('secret_required'));
    credentials.ask.mockResolvedValueOnce({ secret: 'pw', remember: true });
    const outcome = await tester.start(draft({ kind: 'password', password: null })).outcome;
    expect(credentials.ask).toHaveBeenCalledWith('Password', {
      kind: 'password',
      subject: 'carapace@127.0.0.1:2223',
      error: null,
      forTest: true,
    });
    expect(ipc.test.mock.calls[1][3]).toEqual({ secret: 'pw', remember: false });
    expect(ipc.test.mock.calls[1][1]).not.toBe(ipc.test.mock.calls[0][1]);
    expect(outcome.kind).toBe('success');
  });

  it('asks again for a refused typed password', async () => {
    ipc.test
      .mockRejectedValueOnce(fail('secret_required'))
      .mockRejectedValueOnce(fail('auth_failed'));
    credentials.ask
      .mockResolvedValueOnce({ secret: 'wrong', remember: false })
      .mockResolvedValueOnce({ secret: 'right', remember: false });
    const outcome = await tester.start(draft({ kind: 'password', password: null })).outcome;
    expect(credentials.ask.mock.calls[1][1].error).toBe(
      'The server rejected the password. Try again.',
    );
    expect(ipc.test.mock.calls[2][3]).toEqual({ secret: 'right', remember: false });
    expect(outcome.kind).toBe('success');
  });

  it('asks again for a wrong typed passphrase, with the key path as subject', async () => {
    ipc.test
      .mockRejectedValueOnce(fail('secret_required'))
      .mockRejectedValueOnce(fail('invalid_passphrase'));
    credentials.ask
      .mockResolvedValueOnce({ secret: 'wrong', remember: false })
      .mockResolvedValueOnce({ secret: 'right', remember: false });
    const d = draft({ kind: 'key', keyPath: '~/.ssh/id_enc', passphrase: null });
    await tester.start(d).outcome;
    expect(credentials.ask).toHaveBeenLastCalledWith('Key passphrase', {
      kind: 'passphrase',
      subject: '/home/me/.ssh/id_enc',
      error: 'Wrong passphrase. Try again.',
      forTest: true,
    });
  });

  it('does not ask again for a refused secret variable', async () => {
    ipc.test.mockRejectedValueOnce(fail('auth_failed'));
    const outcome = await tester.start(draft({ kind: 'password', password: '${db_pw}' })).outcome;
    expect(credentials.ask).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: 'failure', origin: 'variable' });
  });

  it('does not ask again for a refused saved secret', async () => {
    ipc.test.mockRejectedValueOnce(fail('invalid_passphrase'));
    const d = draft({ kind: 'key', keyPath: '~/.ssh/id_enc', passphrase: null });
    const outcome = await tester.start(d).outcome;
    expect(credentials.ask).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: 'failure', origin: 'stored' });
  });

  it('never prompts for an agent host or a refused key', async () => {
    ipc.test.mockRejectedValueOnce(fail('auth_failed'));
    expect((await tester.start(draft({ kind: 'agent' })).outcome).kind).toBe('failure');
    ipc.test.mockRejectedValueOnce(fail('auth_failed'));
    const d = draft({ kind: 'key', keyPath: '~/.ssh/id', passphrase: null });
    expect((await tester.start(d).outcome).kind).toBe('failure');
    expect(credentials.ask).not.toHaveBeenCalled();
  });

  it('reports a changed key without opening the replace dialog', async () => {
    ipc.test.mockRejectedValueOnce(fail('host_key_changed'));
    const outcome = await tester.start(draft({ kind: 'agent' })).outcome;
    expect(outcome).toMatchObject({ kind: 'failure', error: { code: 'host_key_changed' } });
    expect(hostKeys.confirmReplace).not.toHaveBeenCalled();
  });

  it('is cancelled when the credential prompt is closed', async () => {
    ipc.test.mockRejectedValueOnce(fail('secret_required'));
    credentials.ask.mockResolvedValueOnce(null);
    const outcome = await tester.start(draft({ kind: 'password', password: null })).outcome;
    expect(outcome.kind).toBe('cancelled');
    expect(ipc.test).toHaveBeenCalledOnce();
  });

  it('is cancelled when the backend says so', async () => {
    ipc.test.mockRejectedValueOnce(fail('cancelled'));
    expect((await tester.start(draft({ kind: 'agent' })).outcome).kind).toBe('cancelled');
  });

  it('aborts a running probe by its test id', async () => {
    let reject: (err: unknown) => void = () => undefined;
    ipc.test.mockImplementationOnce(() => new Promise((_, r) => (reject = r)));
    const run = tester.start(draft({ kind: 'agent' }));
    await Promise.resolve();
    run.abort();
    expect(await run.outcome).toEqual({ kind: 'aborted' });
    expect(ipc.cancel).toHaveBeenCalledWith(ipc.test.mock.calls[0][1]);
    reject(fail('cancelled'));
    run.abort();
    expect(ipc.cancel).toHaveBeenCalledOnce();
  });

  it('does not retry after an abort while the prompt was open', async () => {
    ipc.test.mockRejectedValueOnce(fail('secret_required'));
    let answer: (value: { secret: string; remember: boolean } | null) => void = () => undefined;
    credentials.ask.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const run = tester.start(draft({ kind: 'password', password: null }));
    await new Promise((r) => setTimeout(r));
    run.abort();
    expect(ipc.cancel).not.toHaveBeenCalled();
    answer({ secret: 'pw', remember: false });
    await new Promise((r) => setTimeout(r));
    expect(await run.outcome).toEqual({ kind: 'aborted' });
    expect(ipc.test).toHaveBeenCalledOnce();
  });

  it('excludes the time spent in prompts from the duration', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    ipc.test.mockImplementationOnce(async () => {
      now += 100;
      throw fail('secret_required');
    });
    credentials.ask.mockImplementationOnce(async () => {
      now += 5000;
      return { secret: 'pw', remember: false };
    });
    ipc.test.mockImplementationOnce(async () => {
      now += 300;
      return result;
    });
    const outcome = await tester.start(draft({ kind: 'password', password: null })).outcome;
    expect(outcome).toMatchObject({ kind: 'success', durationMs: 400 });
    vi.restoreAllMocks();
  });
});
