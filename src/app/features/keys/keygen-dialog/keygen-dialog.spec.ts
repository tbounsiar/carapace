import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { FormGroup } from '@angular/forms';
import { provideTaiga, TuiNotificationService } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { of } from 'rxjs';
import { IpcError } from '../../../core/ipc/ipc-error';
import { KeyStore } from '../../../core/ipc/key-store';
import type { KeyView } from '../../../core/ipc/keys';
import { KEY } from '../../../core/ipc/keys.fixture';
import { KeygenDialog, keyFilePreview } from './keygen-dialog';

interface DialogApi {
  form: FormGroup;
  submit(): Promise<void>;
}

describe('KeygenDialog', () => {
  const completeWith = vi.fn();
  const generate = vi.fn<(r: unknown) => Promise<KeyView>>();
  const alerts = { open: vi.fn(() => of(undefined)) };
  const keys = signal<KeyView[]>([{ ...KEY, name: 'taken' }]);
  const keysDir = signal<string | null>(null);
  const loadKeysDir = vi.fn(() => Promise.resolve());

  async function setup() {
    await TestBed.configureTestingModule({
      imports: [KeygenDialog],
      providers: [
        provideTaiga(),
        {
          provide: POLYMORPHEUS_CONTEXT,
          useValue: { completeWith, $implicit: { complete: vi.fn() } },
        },
        { provide: KeyStore, useValue: { keys, generate, keysDir, loadKeysDir } },
        { provide: TuiNotificationService, useValue: alerts },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(KeygenDialog);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const dialog = fixture.componentInstance as unknown as DialogApi;
    return { fixture, el, dialog, c: dialog.form.controls };
  }

  const byId = <T extends HTMLElement>(el: HTMLElement, id: string): T =>
    el.querySelector<T>(`[data-testid="${id}"]`)!;

  beforeEach(() => {
    vi.clearAllMocks();
    keysDir.set(null);
  });

  it('builds the preview with the separator of the keys dir', () => {
    expect(keyFilePreview(null, 'id')).toBe('~/.carapace/keys/id');
    expect(keyFilePreview('C:\\Users\\me\\.carapace\\keys', 'id')).toBe(
      'C:\\Users\\me\\.carapace\\keys\\id',
    );
    expect(keyFilePreview('/home/me/.carapace/keys', 'id')).toBe('/home/me/.carapace/keys/id');
    expect(keyFilePreview('/srv/keys/', 'id')).toBe('/srv/keys/id');
  });

  it('shows the real keys dir once loaded, the default before or on failure', async () => {
    loadKeysDir.mockRejectedValueOnce(new IpcError('io', 'boom'));
    const { fixture, el } = await setup();
    expect(loadKeysDir).toHaveBeenCalledOnce();
    expect(byId(el, 'keygen-path').textContent).toContain('~/.carapace/keys/id_ed25519');
    keysDir.set('D:\\home\\keys');
    await fixture.whenStable();
    const text = byId(el, 'keygen-path').textContent!;
    expect(text).toContain('D:\\home\\keys\\id_ed25519');
    expect(text).toContain('D:\\home\\keys\\id_ed25519.pub');
  });

  it('starts with Ed25519 defaults and remember off', async () => {
    const { el, dialog } = await setup();
    expect(dialog.form.getRawValue()).toEqual({
      algorithm: 'ed25519',
      name: 'id_ed25519',
      fileName: 'id_ed25519',
      comment: 'carapace',
      passphrase: '',
      confirm: '',
      remember: false,
    });
    expect(byId<HTMLInputElement>(el, 'keygen-remember').disabled).toBe(true);
    expect(byId<HTMLInputElement>(el, 'keygen-passphrase').type).toBe('password');
    expect(byId<HTMLInputElement>(el, 'keygen-confirm').type).toBe('password');
    expect(byId(el, 'keygen-path').textContent).toContain('~/.carapace/keys/id_ed25519');
  });

  it('follows the type until the name is edited, and the file name follows the name', async () => {
    const { fixture, el, c } = await setup();
    byId<HTMLInputElement>(el, 'keygen-type-rsa').querySelector('input')!.click();
    await fixture.whenStable();
    expect(c['algorithm'].value).toBe('rsa4096');
    expect(c['name'].value).toBe('id_rsa');
    expect(c['fileName'].value).toBe('id_rsa');
    expect(byId(el, 'keygen-path').textContent).toContain('~/.carapace/keys/id_rsa');

    c['name'].setValue('deploy key');
    c['name'].markAsDirty();
    c['algorithm'].setValue('ed25519');
    expect(c['name'].value).toBe('deploy key');
    expect(c['fileName'].value).toBe('deploy-key');
  });

  it('stops following the name once the file name is edited', async () => {
    const { c } = await setup();
    c['fileName'].setValue('custom');
    c['fileName'].markAsDirty();
    c['name'].setValue('other');
    expect(c['fileName'].value).toBe('custom');
  });

  it('enables remember only with a passphrase', async () => {
    const { c } = await setup();
    c['passphrase'].setValue('pw');
    expect(c['remember'].enabled).toBe(true);
    c['remember'].setValue(true);
    c['passphrase'].setValue('');
    expect(c['remember'].disabled).toBe(true);
    expect(c['remember'].value).toBe(false);
  });

  it('rejects a mismatched confirmation and a taken name', async () => {
    const { dialog, c } = await setup();
    c['passphrase'].setValue('pw');
    c['confirm'].setValue('px');
    await dialog.submit();
    expect(generate).not.toHaveBeenCalled();
    c['confirm'].setValue('pw');
    c['name'].setValue('TAKEN');
    await dialog.submit();
    expect(generate).not.toHaveBeenCalled();
  });

  it('generates, clears the passphrase fields and completes with the key', async () => {
    const { dialog, c } = await setup();
    generate.mockResolvedValue(KEY);
    c['passphrase'].setValue('s3cret');
    c['confirm'].setValue('s3cret');
    c['remember'].setValue(true);
    const pending = dialog.submit();
    expect(c['passphrase'].value).toBe('');
    expect(c['confirm'].value).toBe('');
    await pending;
    expect(generate).toHaveBeenCalledWith({
      name: 'id_ed25519',
      fileName: 'id_ed25519',
      algorithm: 'ed25519',
      comment: 'carapace',
      passphrase: 's3cret',
      rememberPassphrase: true,
    });
    expect(completeWith).toHaveBeenCalledWith(KEY);
    expect(c['remember'].value).toBe(false);
  });

  it('sends a null passphrase when none is typed', async () => {
    const { dialog } = await setup();
    generate.mockResolvedValue(KEY);
    await dialog.submit();
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ passphrase: null, rememberPassphrase: false }),
    );
  });

  it('shows a taken file name on the field and other errors as a notification', async () => {
    const { dialog, c } = await setup();
    generate.mockRejectedValueOnce(
      new IpcError('already_exists', 'A key file with this name exists'),
    );
    await dialog.submit();
    expect(c['fileName'].errors?.['invalid']?.message).toBe('A key file with this name exists');
    expect(completeWith).not.toHaveBeenCalled();

    c['fileName'].setValue('other');
    generate.mockRejectedValueOnce(new IpcError('io', 'Disk full'));
    await dialog.submit();
    expect(alerts.open).toHaveBeenCalledWith(
      'Disk full',
      expect.objectContaining({ appearance: 'negative' }),
    );
  });
});
