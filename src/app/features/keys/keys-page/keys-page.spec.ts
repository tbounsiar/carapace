import { TranslocoService } from '@jsverse/transloco';
import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga, TuiNotificationService, TuiRoot } from '@taiga-ui/core';
import { of } from 'rxjs';
import { IpcError } from '../../../core/ipc/ipc-error';
import { KeyStore } from '../../../core/ipc/key-store';
import type { KeyView } from '../../../core/ipc/keys';
import { key, KEY } from '../../../core/ipc/keys.fixture';
import { KeyActions } from '../key-actions';
import { KeysPage } from './keys-page';

@Component({
  imports: [KeysPage, TuiRoot],
  template: '<tui-root><app-keys-page /></tui-root>',
})
class Host {}

describe('KeysPage', () => {
  const keys = signal<KeyView[]>([]);
  const load = vi.fn(() => Promise.resolve());
  const actions = {
    generate: vi.fn(),
    import: vi.fn(),
    copyPublicKey: vi.fn(),
    deploy: vi.fn(),
    rename: vi.fn(),
    forgetPassphrase: vi.fn(),
    remove: vi.fn(),
  };
  const alerts = { open: vi.fn(() => of(undefined)) };
  let fixture: ComponentFixture<Host>;

  const byId = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
    document.body.querySelector<T>(`[data-testid="${id}"]`);
  const settle = async (): Promise<void> => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };
  const click = async (id: string): Promise<void> => {
    byId(id)!.click();
    await settle();
  };

  async function setup(list: KeyView[]): Promise<void> {
    keys.set(list);
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideTaiga(),
        { provide: KeyStore, useValue: { keys, load } },
        { provide: KeyActions, useValue: actions },
        { provide: TuiNotificationService, useValue: alerts },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    await settle();
  }

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => fixture?.destroy());

  it('loads the keys and shows the empty state with both actions', async () => {
    await setup([]);
    expect(load).toHaveBeenCalledOnce();
    expect(byId('keys-empty')).not.toBeNull();
    await click('keys-generate');
    expect(actions.generate).toHaveBeenCalledOnce();
    await click('keys-import');
    expect(actions.import).toHaveBeenCalledOnce();
  });

  it('shows a failed load as an error with a retry, not as an empty list', async () => {
    load.mockRejectedValueOnce(new IpcError('io', 'Cannot read config'));
    await setup([]);
    expect(alerts.open).toHaveBeenCalledWith(
      expect.stringContaining('Cannot read config. '),
      expect.objectContaining({ label: 'Keys unavailable' }),
    );
    expect(byId('keys-empty')).toBeNull();
    expect(byId('keys-error')?.textContent).toContain('Cannot read config.');
    load.mockResolvedValueOnce(undefined);
    await click('keys-retry');
    expect(load).toHaveBeenCalledTimes(2);
    expect(byId('keys-error')).toBeNull();
    expect(byId('keys-empty')).not.toBeNull();
  });

  it('lists keys with type, fingerprint and badges', async () => {
    await setup([
      KEY,
      key({
        id: 'k2',
        name: 'legacy',
        algorithm: 'rsa',
        bits: 4096,
        managed: false,
        origin: 'imported',
        encrypted: true,
        hasPassphrase: true,
        warning: 'Readable by other users',
        fingerprint: 'SHA256:xyz',
      }),
      key({ id: 'k3', name: 'work', managed: false, path: '/home/me/.ssh/work' }),
    ]);
    expect(byId('keys-empty')).toBeNull();
    const plain = byId('key-row-id_ed25519')!;
    expect(plain.textContent).toContain('Ed25519');
    expect(byId('key-fingerprint-id_ed25519')!.textContent!.trim()).toBe('SHA256:abc');
    expect(byId('key-badge-encrypted-id_ed25519')).toBeNull();
    expect(byId('key-badge-external-id_ed25519')).toBeNull();
    expect(byId('key-badge-folder-id_ed25519')).toBeNull();
    expect(byId('key-badge-folder-work')!.textContent).toContain('Custom folder');
    expect(byId('key-badge-folder-work')!.getAttribute('tabindex')).toBe('0');
    expect(byId('key-badge-external-work')).toBeNull();
    expect(byId('key-badge-folder-legacy')).toBeNull();

    expect(byId('key-row-legacy')!.textContent).toContain('RSA 4096');
    expect(byId('key-badge-encrypted-legacy')!.textContent).toContain('Encrypted');
    expect(byId('key-badge-saved-legacy')!.textContent).toContain('Passphrase saved');
    expect(byId('key-badge-external-legacy')!.textContent).toContain('External');
    expect(byId('key-warning-legacy')!.getAttribute('aria-label')).toBe('Readable by other users');
  });

  it('runs the row menu actions', async () => {
    await setup([KEY]);
    for (const [id, fn] of [
      ['key-copy', actions.copyPublicKey],
      ['key-deploy', actions.deploy],
      ['key-rename', actions.rename],
      ['key-delete', actions.remove],
    ] as const) {
      await click('key-menu-id_ed25519');
      expect(byId('key-forget')).toBeNull();
      await click(id);
      expect(fn).toHaveBeenCalledWith(KEY);
    }
  });

  it('offers to forget a saved passphrase', async () => {
    const saved = key({ hasPassphrase: true });
    await setup([saved]);
    await click('key-menu-id_ed25519');
    await click('key-forget');
    expect(actions.forgetPassphrase).toHaveBeenCalledWith(saved);
  });

  it('renders in French', async () => {
    await setup([]);
    TestBed.inject(TranslocoService).setActiveLang('fr');
    await settle();
    expect(byId('keys-empty')?.textContent).toContain('Aucune clé SSH pour l’instant');
    expect(byId('keys-generate')?.textContent).toContain('Générer une clé');
  });
});
