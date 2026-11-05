import { TranslocoService } from '@jsverse/transloco';
import { TestBed } from '@angular/core/testing';
import type { BackendText } from '../../core/ipc/backend-text';
import type { AuthMethod, CommandErrorCode } from '../../core/ipc/config.models';
import type { HostTestResult } from '../../core/ipc/host-test';
import { IpcError } from '../../core/ipc/ipc-error';
import { duration, outcomeView, testingView, type Part } from './host-test-view';
import type { HostTestDraft, SecretOrigin } from './host-tester';

function draft(auth: AuthMethod): HostTestDraft {
  return {
    host: { name: '', hostname: '${host}', port: '2223', username: 'carapace', auth },
    projectId: 'p1',
    hostId: null,
    address: 'carapace@127.0.0.1:2223',
    keyPath: '/home/me/.ssh/id_bad',
  };
}
const join = (parts: readonly Part[]): string => parts.map((p) => p.text).join('');
const key: AuthMethod = { kind: 'key', keyPath: '~/.ssh/id', passphrase: null };
const password: AuthMethod = { kind: 'password', password: null };

const KNOWN_HOSTS = {
  key: 'errors.ssh.userKnownHostsUnreadable',
  params: { kind: 'permission_denied' },
};

function failure(
  code: CommandErrorCode,
  auth: AuthMethod,
  message = 'connection refused',
  origin: SecretOrigin = 'stored',
  text: Pick<BackendText, 'key' | 'params'> = {},
) {
  const view = outcomeView(
    { kind: 'failure', error: new IpcError(code, message, text), origin },
    draft(auth),
  )!;
  return { view, title: join(view.title), detail: join(view.detail) };
}

describe('host test copy', () => {
  beforeEach(() => TestBed.inject(TranslocoService));

  it('formats durations', () => {
    expect(duration(412.4)).toBe('412 ms');
    expect(duration(1000)).toBe('1.0 s');
    expect(duration(2345)).toBe('2.3 s');
  });

  it('shows the address being tested in mono', () => {
    const view = testingView(draft(key));
    expect(view.state).toBe('testing');
    expect(join(view.title)).toBe('Testing carapace@127.0.0.1:2223...');
    expect(view.title.find((p) => p.mono)?.text).toBe('carapace@127.0.0.1:2223');
  });

  it('shows nothing for an aborted test and a short line when cancelled', () => {
    expect(outcomeView({ kind: 'aborted' }, draft(key))).toBeNull();
    expect(join(outcomeView({ kind: 'cancelled' }, draft(key))!.title)).toBe('Test cancelled.');
  });

  describe('success', () => {
    const success = (r: Partial<HostTestResult>, auth: AuthMethod = key): string => {
      const result: HostTestResult = {
        address: 'carapace@127.0.0.1:2223',
        authKind: 'key',
        secretSource: null,
        durationMs: 0,
        ...r,
      };
      const view = outcomeView({ kind: 'success', result, durationMs: 412 }, draft(auth))!;
      expect(view.state).toBe('success');
      expect(join(view.title)).toBe('Connected as carapace@127.0.0.1:2223');
      return join(view.detail);
    };

    it('names the auth method and where the secret came from', () => {
      expect(success({})).toBe('Private key file · 412 ms');
      expect(success({ secretSource: 'typed' })).toBe(
        'Private key file, passphrase typed for this test · 412 ms',
      );
      expect(
        success({ secretSource: 'variable' }, { ...key, passphrase: '${key_pw}' } as AuthMethod),
      ).toBe('Private key file, passphrase from ${key_pw} · 412 ms');
      expect(success({ secretSource: 'keyPassphrase' })).toBe(
        'Private key file, saved passphrase · 412 ms',
      );
      expect(success({ authKind: 'password', secretSource: 'typed' }, password)).toBe(
        'Password (typed for this test) · 412 ms',
      );
      expect(
        success(
          { authKind: 'password', secretSource: 'variable' },
          { kind: 'password', password: '${db_pw}' },
        ),
      ).toBe('Password from ${db_pw} · 412 ms');
      expect(success({ authKind: 'password', secretSource: 'saved' }, password)).toBe(
        'Password saved in the keychain · 412 ms',
      );
      expect(success({ authKind: 'agent' }, { kind: 'agent' })).toBe('SSH agent · 412 ms');
    });
  });

  describe('failures', () => {
    it('network and timeout name the host and port', () => {
      const network = failure('network', key);
      expect(network.view).toMatchObject({ state: 'failure', code: 'network' });
      expect(network.title).toBe('Could not reach 127.0.0.1:2223');
      expect(network.detail).toBe(
        'Connection refused. Check the hostname, the port and your network.',
      );
      expect(failure('timeout', key).title).toBe('No answer from 127.0.0.1:2223');
      expect(failure('timeout', key).detail).toContain('within 15 seconds');
    });

    it('auth failures depend on the method', () => {
      const refused = failure('auth_failed', key);
      expect(refused.title).toBe('The server refused the key');
      expect(refused.detail).toBe(
        'Check that its public key is in ~/.ssh/authorized_keys of carapace on the server, or pick another key.',
      );
      expect(failure('auth_failed', { kind: 'agent' }).title).toBe(
        'The SSH agent offered no accepted key',
      );
      const pw = failure('auth_failed', password);
      expect(pw.title).toBe('The server rejected the password');
      expect(pw.detail).toBe(
        'The password came from the keychain. Check the username, then the password or the secret variable it uses.',
      );
      expect(
        failure('auth_failed', { kind: 'password', password: '${db_pw}' }, 'x', 'variable').detail,
      ).toMatch(/^The password came from \$\{db_pw\}\. Check the username/);
    });

    it('a stored wrong passphrase names the key and its source', () => {
      const wrong = failure(
        'invalid_passphrase',
        { ...key, passphrase: '${k}' } as AuthMethod,
        'x',
        'variable',
      );
      expect(wrong.title).toBe('Wrong passphrase for /home/me/.ssh/id_bad');
      expect(wrong.detail).toMatch(/^The passphrase came from \$\{k\}\. Check the secret variable/);
    });

    it('host key failures', () => {
      expect(failure('host_key_rejected', key).title).toBe('Host key not accepted');
      const changed = failure('host_key_changed', key);
      expect(changed.title).toBe('Host key has changed');
      expect(changed.detail).toContain('stored for 127.0.0.1:2223');
      expect(changed.detail).toContain('save the host and connect');
      const revoked = failure('host_key_revoked', key);
      expect(revoked.title).toBe('Host key is revoked');
      expect(revoked.detail).toContain('127.0.0.1:2223 is marked as revoked');
    });

    it('key file and known_hosts problems', () => {
      expect(failure('invalid_input', key, 'not a private key').title).toBe('Key file not usable');
      expect(failure('invalid_input', key, 'not a private key').detail).toBe(
        'Not a private key. Check the key path.',
      );
      expect(failure('not_found', key, 'no such file').title).toBe(
        'Could not read /home/me/.ssh/id_bad',
      );
      const knownHosts = failure(
        'io',
        key,
        'Could not read ~/.ssh/known_hosts to verify the host key: permission denied. Fix or move that file, then retry.',
        'stored',
        KNOWN_HOSTS,
      );
      expect(knownHosts.title).toBe('Could not read known_hosts');
      expect(knownHosts.detail).toBe(
        'Could not read ~/.ssh/known_hosts to verify the host key: permission denied. Fix or move that file, then retry.',
      );
    });

    it('translates the known_hosts problem into French', () => {
      TestBed.inject(TranslocoService).setActiveLang('fr');
      try {
        const { detail } = failure('io', key, 'english', 'stored', KNOWN_HOSTS);
        expect(detail).toContain('Impossible de lire ~/.ssh/known_hosts');
        expect(detail).toContain('accès refusé');
      } finally {
        TestBed.inject(TranslocoService).setActiveLang('en');
      }
    });

    it('keychain, missing variables and anything else', () => {
      expect(failure('keychain_unavailable', key).title).toBe('System keychain unavailable');
      expect(failure('missing_variables', key, 'missing variables: host').detail).toBe(
        'Missing variables: host. Define them in the global or project variables.',
      );
      const keyed = { key: 'errors.config.missingVariables', params: { names: 'host' } };
      const one = failure('missing_variables', key, 'missing variables: host', 'stored', keyed);
      expect(one.title).toBe('Missing variables');
      expect(one.detail).toBe('host: define it in the global or project variables.');
      expect(one.view.detail.find((part) => part.mono)?.text).toBe('host');
      const two = failure('missing_variables', key, 'x', 'stored', {
        ...keyed,
        params: { names: 'host, port' },
      });
      expect(two.detail).toBe('host, port: define them in the global or project variables.');
      const busy = failure('busy', key, 'too many connection tests are running');
      expect(busy.view).toMatchObject({ state: 'failure', code: 'busy' });
      expect(busy.title).toBe('Too many tests are running');
      expect(busy.detail).toBe('Wait for one to finish, then test again.');
      const other = failure('permission_denied', key, 'denied');
      expect(other.title).toBe('Test failed');
      expect(other.detail).toBe('Denied. Check the permissions of the file or folder.');
      expect(failure('invalid_input', password, 'bad').title).toBe('Test failed');
    });
  });

  it('translates the copy and the durations into French', () => {
    TestBed.inject(TranslocoService).setActiveLang('fr');
    document.documentElement.lang = 'fr';
    try {
      expect(duration(1500)).toBe('1,5 s');
      const view = testingView(draft(key));
      expect(join(view.title)).toBe('Test de carapace@127.0.0.1:2223 en cours…');
      expect(view.title.find((p) => p.mono)?.text).toBe('carapace@127.0.0.1:2223');
      const missing = (names: string) =>
        failure('missing_variables', key, 'x', 'stored', {
          key: 'errors.config.missingVariables',
          params: { names },
        }).detail;
      expect(missing('host')).toBe(
        'host : définissez-la dans les variables globales ou celles du projet.',
      );
      expect(missing('host, port')).toBe(
        'host, port : définissez-les dans les variables globales ou celles du projet.',
      );
    } finally {
      document.documentElement.lang = '';
    }
  });
});
