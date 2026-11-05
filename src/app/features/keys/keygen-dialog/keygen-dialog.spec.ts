import { TranslocoService } from '@jsverse/transloco';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { FormGroup } from '@angular/forms';
import { provideTaiga, TuiNotificationService } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { of } from 'rxjs';
import { IpcError } from '../../../core/ipc/ipc-error';
import { KeyStore } from '../../../core/ipc/key-store';
import type { KeyType, KeyView } from '../../../core/ipc/keys';
import { KEY } from '../../../core/ipc/keys.fixture';
import { KeyFilePicker } from '../../../core/ipc/key-file-picker';
import type { KeyLocation } from '../../../core/ipc/keys';
import { Settings } from '../../../core/settings/settings';
import { KeygenDialog, locationProblem, samePath } from './keygen-dialog';

const SHARED = {
  key: 'errors.keys.sharedFolder',
  message: 'Other users can open this folder.',
};

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
  const defaultKeyType = signal<KeyType>('ed25519');
  const keyFolder = signal<string | null>(null);
  const setKeyFolder = vi.fn();
  const checkLocation = vi.fn<(dir: string | null, fileName: string) => Promise<KeyLocation>>();
  const picking = signal(false);
  const pickFolder = vi.fn<(current: string | null) => Promise<string | null>>();

  async function setup() {
    await TestBed.configureTestingModule({
      imports: [KeygenDialog],
      providers: [
        provideTaiga(),
        {
          provide: POLYMORPHEUS_CONTEXT,
          useValue: { completeWith, $implicit: { complete: vi.fn() } },
        },
        {
          provide: KeyStore,
          useValue: { keys, generate, keysDir, loadKeysDir, checkLocation },
        },
        { provide: TuiNotificationService, useValue: alerts },
        { provide: Settings, useValue: { defaultKeyType, keyFolder, setKeyFolder } },
        { provide: KeyFilePicker, useValue: { picking, pickFolder } },
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
    defaultKeyType.set('ed25519');
    keyFolder.set(null);
    picking.set(false);
    loadKeysDir.mockImplementation(() => Promise.resolve());
    checkLocation.mockImplementation((dir) =>
      Promise.resolve({
        dir: dir ?? '/home/me/.carapace/keys',
        isDefault: dir === null,
        warning: null,
      }),
    );
  });

  it('names both files without repeating the folder', async () => {
    const { el } = await setup();
    expect(byId(el, 'keygen-path').textContent!.replace(/\s+/g, ' ').trim()).toBe(
      'Saved as id_ed25519 and id_ed25519.pub in this folder.',
    );
  });

  it('hides the file names while the folder has an error', async () => {
    const { fixture, el, c } = await setup();
    c['folder'].setValue('');
    await fixture.whenStable();
    expect(c['folder'].invalid).toBe(true);
    expect(byId(el, 'keygen-path')).toBeNull();
    c['folder'].setValue('/srv/keys');
    await fixture.whenStable();
    expect(byId(el, 'keygen-path')).not.toBeNull();
  });

  it('shows the real keys dir once loaded, the default before or on failure', async () => {
    loadKeysDir.mockRejectedValueOnce(new IpcError('io', 'boom'));
    const { fixture, c } = await setup();
    expect(loadKeysDir).toHaveBeenCalledOnce();
    expect(c['folder'].value).toBe('~/.carapace/keys');
    keysDir.set('D:\\home\\keys');
    await fixture.whenStable();
    expect(c['folder'].value).toBe('D:\\home\\keys');
  });

  it('starts with Ed25519 defaults and remember off', async () => {
    const { el, dialog } = await setup();
    expect(dialog.form.getRawValue()).toEqual({
      algorithm: 'ed25519',
      name: 'id_ed25519',
      folder: '~/.carapace/keys',
      fileName: 'id_ed25519',
      comment: 'carapace',
      passphrase: '',
      confirm: '',
      remember: false,
    });
    expect(byId<HTMLInputElement>(el, 'keygen-remember').disabled).toBe(true);
    expect(byId<HTMLInputElement>(el, 'keygen-passphrase').type).toBe('password');
    expect(byId<HTMLInputElement>(el, 'keygen-confirm').type).toBe('password');
    expect(byId(el, 'keygen-path').textContent).toContain('id_ed25519.pub');
  });

  it('starts with the default key type from the settings', async () => {
    defaultKeyType.set('rsa4096');
    const { el, dialog } = await setup();
    expect(dialog.form.getRawValue()).toEqual(
      expect.objectContaining({ algorithm: 'rsa4096', name: 'id_rsa', fileName: 'id_rsa' }),
    );
    expect(byId(el, 'keygen-type-rsa').querySelector('input')!.checked).toBe(true);
  });

  it('follows the type until the name is edited, and the file name follows the name', async () => {
    const { fixture, el, c } = await setup();
    byId<HTMLInputElement>(el, 'keygen-type-rsa').querySelector('input')!.click();
    await fixture.whenStable();
    expect(c['algorithm'].value).toBe('rsa4096');
    expect(c['name'].value).toBe('id_rsa');
    expect(c['fileName'].value).toBe('id_rsa');
    expect(byId(el, 'keygen-path').textContent).toContain('id_rsa.pub');

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
      dir: null,
    });
    expect(setKeyFolder).toHaveBeenCalledWith(null);
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
    expect(c['fileName'].errors?.['invalid']?.message).toBe(
      'id_ed25519 or id_ed25519.pub already exists in this folder.',
    );
    expect(completeWith).not.toHaveBeenCalled();

    c['fileName'].setValue('other');
    generate.mockRejectedValueOnce(new IpcError('io', 'Disk full'));
    await dialog.submit();
    expect(alerts.open).toHaveBeenCalledWith(
      expect.stringContaining('Disk full. '),
      expect.objectContaining({ appearance: 'negative' }),
    );
  });

  describe('folder', () => {
    const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
    const settle = async (fixture: { whenStable(): Promise<unknown> }) => {
      await tick();
      await fixture.whenStable();
      await tick();
    };

    it('compares paths ignoring trailing separators, and case on Windows', () => {
      expect(samePath('C:\\Keys\\', 'c:\\keys')).toBe(true);
      expect(samePath('/srv/Keys', '/srv/keys')).toBe(false);
      expect(samePath('/srv/keys/', '/srv/keys')).toBe(true);
    });

    it('maps location errors per field', () => {
      const msg = (code: string, message = 'x') =>
        locationProblem(new IpcError(code as never, message), 'id_work');
      expect(msg('not_found')).toEqual({
        field: 'folder',
        message: 'This folder does not exist. Create it, or choose another one.',
      });
      expect(msg('invalid_input', 'Links are not accepted. Choose the real folder.')).toEqual({
        field: 'folder',
        message: 'Links are not accepted. Choose the real folder.',
      });
      expect(msg('invalid_input', 'this is a file, not a folder')?.message).toBe(
        'This is a file, not a folder.',
      );
      expect(msg('permission_denied')?.message).toBe(
        'Carapace cannot write to this folder. Choose another one.',
      );
      expect(msg('already_exists')).toEqual({
        field: 'fileName',
        message: 'id_work or id_work.pub already exists in this folder.',
      });
      expect(msg('io')).toBeNull();
    });

    it('prefills the keys dir and checks it as the default', async () => {
      keysDir.set('/home/me/.carapace/keys');
      const { fixture, el, c } = await setup();
      await settle(fixture);
      expect(c['folder'].value).toBe('/home/me/.carapace/keys');
      expect(byId(el, 'keygen-folder-reset')).toBeNull();
      expect(checkLocation).toHaveBeenCalledWith(null, 'id_ed25519');
    });

    it('prefills the remembered folder, with Reset', async () => {
      keyFolder.set('/home/me/.ssh');
      const { fixture, el, c } = await setup();
      await settle(fixture);
      expect(c['folder'].value).toBe('/home/me/.ssh');
      expect(byId(el, 'keygen-folder-reset')).not.toBeNull();
      expect(checkLocation).toHaveBeenCalledWith('/home/me/.ssh', 'id_ed25519');
    });

    it('shows the fallback while the keys dir loads and checks once it is known', async () => {
      let resolve: () => void = () => undefined;
      loadKeysDir.mockImplementation(() => new Promise<void>((r) => (resolve = r)));
      const { fixture, c } = await setup();
      expect(c['folder'].value).toBe('~/.carapace/keys');
      expect(checkLocation).not.toHaveBeenCalled();
      keysDir.set('/home/me/.carapace/keys');
      resolve();
      await settle(fixture);
      expect(c['folder'].value).toBe('/home/me/.carapace/keys');
      expect(checkLocation).toHaveBeenCalledWith(null, 'id_ed25519');
    });

    it('sets a picked folder, focuses the input and checks it', async () => {
      const { fixture, el, c } = await setup();
      await settle(fixture);
      pickFolder.mockResolvedValue('/srv/keys');
      byId<HTMLButtonElement>(el, 'keygen-folder-browse').click();
      await settle(fixture);
      expect(pickFolder).toHaveBeenCalledWith('~/.carapace/keys');
      expect(c['folder'].value).toBe('/srv/keys');
      expect(document.activeElement).toBe(byId(el, 'keygen-folder'));
      expect(checkLocation).toHaveBeenLastCalledWith('/srv/keys', 'id_ed25519');
    });

    it('keeps the folder on a cancelled pick and focuses Browse', async () => {
      const { fixture, el, c } = await setup();
      await settle(fixture);
      pickFolder.mockResolvedValue(null);
      byId<HTMLButtonElement>(el, 'keygen-folder-browse').click();
      await settle(fixture);
      expect(c['folder'].value).toBe('~/.carapace/keys');
      expect(document.activeElement).toBe(byId(el, 'keygen-folder-browse'));
    });

    it('disables Browse while a picker is open', async () => {
      const { fixture, el } = await setup();
      picking.set(true);
      await fixture.whenStable();
      expect(byId<HTMLButtonElement>(el, 'keygen-folder-browse').disabled).toBe(true);
    });

    it('resets to the default folder and forgets the remembered one', async () => {
      keyFolder.set('/home/me/.ssh');
      keysDir.set('/home/me/.carapace/keys');
      const { fixture, el, c } = await setup();
      await settle(fixture);
      byId<HTMLButtonElement>(el, 'keygen-folder-reset').click();
      await settle(fixture);
      expect(c['folder'].value).toBe('/home/me/.carapace/keys');
      expect(setKeyFolder).toHaveBeenCalledWith(null);
      expect(byId(el, 'keygen-folder-reset')).toBeNull();
      expect(document.activeElement).toBe(byId(el, 'keygen-folder'));
    });

    it('checks a typed folder after a pause and blocks Generate on a missing folder', async () => {
      const { fixture, c, dialog } = await setup();
      await settle(fixture);
      checkLocation.mockRejectedValue(new IpcError('not_found', 'folder not found'));
      c['folder'].setValue('/nope');
      await tick(50);
      expect(checkLocation).not.toHaveBeenCalledWith('/nope', 'id_ed25519');
      await tick(450);
      await settle(fixture);
      expect(checkLocation).toHaveBeenLastCalledWith('/nope', 'id_ed25519');
      expect(c['folder'].errors?.['invalid']?.message).toBe(
        'This folder does not exist. Create it, or choose another one.',
      );
      expect(c['folder'].touched).toBe(true);
      c['passphrase'].setValue('pw');
      c['confirm'].setValue('pw');
      await dialog.submit();
      expect(generate).not.toHaveBeenCalled();
      expect(c['passphrase'].value).toBe('pw');
      c['folder'].setValue('/other');
      expect(c['folder'].errors).toBeNull();
    });

    it('rejects relative and empty folders locally', async () => {
      const { c } = await setup();
      c['folder'].setValue('keys');
      expect(c['folder'].errors?.['invalid']?.message).toBe(
        'Use a full path, or one starting with ~/.',
      );
      c['folder'].setValue('');
      expect(c['folder'].errors?.['invalid']?.message).toBe('Choose a folder for the key.');
    });

    it('shows a taken file name on File name when the folder is checked on blur', async () => {
      const { fixture, el, c } = await setup();
      await settle(fixture);
      checkLocation.mockRejectedValue(new IpcError('already_exists', 'exists'));
      byId(el, 'keygen-folder').dispatchEvent(new Event('blur'));
      await settle(fixture);
      expect(c['fileName'].errors?.['invalid']?.message).toBe(
        'id_ed25519 or id_ed25519.pub already exists in this folder.',
      );
      expect(c['folder'].errors).toBeNull();
      c['fileName'].setValue('id_other');
      expect(c['fileName'].errors).toBeNull();
    });

    it('shows the shared-folder warning for a custom folder only', async () => {
      keyFolder.set('/srv/shared');
      checkLocation.mockResolvedValue({ dir: '/srv/shared', isDefault: false, warning: SHARED });
      const { fixture, el } = await setup();
      await settle(fixture);
      expect(byId(el, 'keygen-folder-warning').textContent).toContain(
        'Other users can open this folder. The private key file stays readable only by you, but they may be able to replace or delete it.',
      );
      checkLocation.mockResolvedValue({ dir: '/k', isDefault: true, warning: SHARED });
      byId<HTMLButtonElement>(el, 'keygen-folder-reset').click();
      await settle(fixture);
      expect(byId(el, 'keygen-folder-warning')).toBeNull();
    });

    it('sends a custom folder and remembers it only after a success', async () => {
      const { fixture, dialog, c } = await setup();
      await settle(fixture);
      c['folder'].setValue('/srv/keys');
      generate.mockRejectedValueOnce(new IpcError('permission_denied', 'denied'));
      await dialog.submit();
      expect(generate).toHaveBeenLastCalledWith(expect.objectContaining({ dir: '/srv/keys' }));
      expect(setKeyFolder).not.toHaveBeenCalled();
      expect(c['folder'].errors?.['invalid']?.message).toBe(
        'Carapace cannot write to this folder. Choose another one.',
      );

      c['folder'].setValue('/srv/keys2');
      generate.mockResolvedValueOnce(KEY);
      await dialog.submit();
      expect(generate).toHaveBeenLastCalledWith(expect.objectContaining({ dir: '/srv/keys2' }));
      expect(setKeyFolder).toHaveBeenCalledWith('/srv/keys2');
      expect(completeWith).toHaveBeenCalledWith(KEY);
    });
  });

  it('renders in French', async () => {
    const { fixture, el } = await setup();
    TestBed.inject(TranslocoService).setActiveLang('fr');
    await fixture.whenStable();
    expect(el.textContent).toContain('Ed25519 est recommandé');
    expect(byId(el, 'keygen-submit').textContent).toContain('Générer');
  });
});
