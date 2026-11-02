import { TestBed } from '@angular/core/testing';
import { provideTaiga, TuiNotificationService } from '@taiga-ui/core';
import { of } from 'rxjs';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import type { Host, HostInput } from '../../../core/ipc/config.models';
import { SecretsService } from '../../../core/ipc/secrets';
import { HostDialog, type HostDialogData } from './host-dialog';

describe('HostDialog', () => {
  const completeWith = vi.fn();
  const save = vi.fn<HostDialogData['save']>();
  const order: string[] = [];
  const alerts = { open: vi.fn(() => of(undefined)) };
  const secrets = {
    set: vi.fn(() => {
      order.push('set');
      return Promise.resolve();
    }),
    delete: vi.fn(() => Promise.resolve()),
    has: vi.fn(() => Promise.resolve(false)),
  };

  async function setup(initial: HostInput | null = null, hostId: string | null = null) {
    await TestBed.configureTestingModule({
      imports: [HostDialog],
      providers: [
        provideTaiga(),
        {
          provide: POLYMORPHEUS_CONTEXT,
          useValue: { data: { initial, hostId, save }, completeWith, $implicit: {} },
        },
        { provide: SecretsService, useValue: secrets },
        { provide: TuiNotificationService, useValue: alerts },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(HostDialog);
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, el, dialog: fixture.componentInstance as unknown as DialogApi };
  }

  interface DialogApi {
    form: import('@angular/forms').FormGroup;
    submit(): Promise<void>;
    forget(): Promise<void>;
  }

  const byId = (el: HTMLElement, id: string): HTMLElement | null =>
    el.querySelector(`[data-testid="${id}"]`);

  const valid: HostInput = {
    name: 'web-1',
    hostname: 'web1.example.com',
    port: 22,
    username: 'deploy',
    auth: { kind: 'agent' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    secrets.has.mockResolvedValue(false);
    save.mockImplementation((host) => {
      order.push('save');
      return Promise.resolve({ ...host, id: 'h1' } as Host);
    });
  });

  it('defaults the port to 22 and password auth', async () => {
    const { dialog } = await setup();
    expect(dialog.form.value.port).toBe(22);
    expect(dialog.form.value.authKind).toBe('password');
  });

  it('is invalid until required fields are filled', async () => {
    const { dialog } = await setup();
    await dialog.submit();
    expect(save).not.toHaveBeenCalled();
    expect(dialog.form.get('name')!.invalid).toBe(true);
    expect(dialog.form.get('hostname')!.invalid).toBe(true);
    expect(dialog.form.get('username')!.invalid).toBe(true);
  });

  it('rejects whitespace and out-of-range values', async () => {
    const { dialog } = await setup(valid);
    dialog.form.patchValue({ hostname: 'a b', username: 'x y', port: 70000 });
    expect(dialog.form.get('hostname')!.invalid).toBe(true);
    expect(dialog.form.get('username')!.invalid).toBe(true);
    expect(dialog.form.get('port')!.invalid).toBe(true);
    dialog.form.patchValue({ hostname: 'h', username: 'u', port: 2222 });
    expect(dialog.form.valid).toBe(true);
  });

  it('requires a key path only for key auth', async () => {
    const { fixture, dialog } = await setup(valid);
    expect(dialog.form.valid).toBe(true);
    dialog.form.patchValue({ authKind: 'key' });
    await fixture.whenStable();
    expect(dialog.form.get('keyPath')!.invalid).toBe(true);
    dialog.form.patchValue({ keyPath: '~/.ssh/id_ed25519' });
    expect(dialog.form.valid).toBe(true);
  });

  it('submits the host input with the key auth method', async () => {
    const { fixture, dialog } = await setup(valid);
    dialog.form.patchValue({ authKind: 'key', keyPath: ' ~/.ssh/id ' });
    await fixture.whenStable();
    await dialog.submit();
    expect(save).toHaveBeenCalledWith({ ...valid, auth: { kind: 'key', keyPath: '~/.ssh/id' } });
    expect(completeWith).toHaveBeenCalledOnce();
  });

  describe('secret', () => {
    const passwordHost: HostInput = { ...valid, auth: { kind: 'password' } };
    const keyHost: HostInput = { ...valid, auth: { kind: 'key', keyPath: '~/.ssh/id' } };

    it('shows a password field for password auth, a passphrase field for key auth, none for agent', async () => {
      const { fixture, el, dialog } = await setup(passwordHost);
      expect((byId(el, 'host-password') as HTMLInputElement).type).toBe('password');
      dialog.form.patchValue({ authKind: 'key' });
      await fixture.whenStable();
      expect(byId(el, 'host-password')).toBeNull();
      expect(byId(el, 'host-passphrase')).not.toBeNull();
      dialog.form.patchValue({ authKind: 'agent' });
      await fixture.whenStable();
      expect(byId(el, 'host-passphrase')).toBeNull();
    });

    it('saves the host first, then the secret, and keeps it out of the host payload', async () => {
      const { dialog } = await setup(passwordHost);
      dialog.form.patchValue({ secret: 'pw' });
      await dialog.submit();
      expect(order).toEqual(['save', 'set']);
      expect(save).toHaveBeenCalledWith(passwordHost);
      expect(JSON.stringify(save.mock.calls[0][0])).not.toContain('pw');
      expect(secrets.set).toHaveBeenCalledWith('h1', 'password', 'pw');
      expect(dialog.form.get('secret')!.value).toBe('');
      expect(completeWith).toHaveBeenCalledOnce();
    });

    it('stores a passphrase for key auth', async () => {
      const { dialog } = await setup(keyHost, 'h1');
      dialog.form.patchValue({ secret: 'phrase' });
      await dialog.submit();
      expect(secrets.set).toHaveBeenCalledWith('h1', 'passphrase', 'phrase');
    });

    it('does not touch the keychain when the field is empty', async () => {
      const { dialog } = await setup(passwordHost);
      await dialog.submit();
      expect(save).toHaveBeenCalledOnce();
      expect(secrets.set).not.toHaveBeenCalled();
    });

    it('keeps the typed secret and skips the keychain when the host save fails', async () => {
      save.mockRejectedValue(new Error('boom'));
      const { dialog } = await setup(passwordHost);
      dialog.form.patchValue({ secret: 'pw' });
      await dialog.submit();
      expect(secrets.set).not.toHaveBeenCalled();
      expect(completeWith).not.toHaveBeenCalled();
    });

    it('still closes when the keychain write fails after the host was saved', async () => {
      secrets.set.mockRejectedValueOnce(new Error('keychain'));
      const { dialog } = await setup(passwordHost);
      dialog.form.patchValue({ secret: 'pw' });
      await dialog.submit();
      expect(completeWith).toHaveBeenCalledOnce();
      expect(dialog.form.get('secret')!.value).toBe('');
      expect(alerts.open).toHaveBeenCalledOnce();
    });

    it('shows the stored state on edit and forgets it', async () => {
      secrets.has.mockResolvedValue(true);
      const { fixture, el } = await setup(passwordHost, 'h1');
      expect(secrets.has).toHaveBeenCalledWith('h1', 'password');
      expect(byId(el, 'host-secret-stored')).not.toBeNull();
      byId(el, 'host-secret-forget')!.click();
      await fixture.whenStable();
      expect(secrets.delete).toHaveBeenCalledWith('h1', 'password');
      expect(byId(el, 'host-secret-stored')).toBeNull();
    });

    it('hides the stored state when the key path changes', async () => {
      secrets.has.mockResolvedValue(true);
      const { fixture, el, dialog } = await setup(keyHost, 'h1');
      expect(secrets.has).toHaveBeenCalledWith('h1', 'passphrase');
      expect(byId(el, 'host-secret-stored')).not.toBeNull();
      dialog.form.patchValue({ keyPath: '~/.ssh/other' });
      await fixture.whenStable();
      expect(byId(el, 'host-secret-stored')).toBeNull();
    });

    it('hides the stored password when the server changes', async () => {
      secrets.has.mockResolvedValue(true);
      const { fixture, el, dialog } = await setup(passwordHost, 'h1');
      expect(byId(el, 'host-secret-stored')).not.toBeNull();
      dialog.form.patchValue({ username: 'someone-else' });
      await fixture.whenStable();
      expect(byId(el, 'host-secret-stored')).toBeNull();
    });

    it('clears a typed secret when the auth kind changes', async () => {
      const { fixture, dialog } = await setup(passwordHost);
      dialog.form.patchValue({ secret: 'pw' });
      dialog.form.patchValue({ authKind: 'key', keyPath: '~/.ssh/id' });
      await fixture.whenStable();
      expect(dialog.form.get('secret')!.value).toBe('');
    });

    it('does not look up a secret for a new host', async () => {
      await setup(passwordHost);
      expect(secrets.has).not.toHaveBeenCalled();
    });
  });
});
