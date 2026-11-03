import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { FormGroup } from '@angular/forms';
import { provideTaiga, TuiNotificationService } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { of } from 'rxjs';
import { IpcError } from '../../../core/ipc/ipc-error';
import { KeyFilePicker } from '../../../core/ipc/key-file-picker';
import { KeyStore } from '../../../core/ipc/key-store';
import type { KeyView } from '../../../core/ipc/keys';
import { key } from '../../../core/ipc/keys.fixture';
import { KeyImportDialog, type KeyImportDialogData } from './key-import-dialog';

interface DialogApi {
  form: FormGroup;
  submit(): Promise<void>;
}

describe('KeyImportDialog', () => {
  const completeWith = vi.fn();
  const importKey = vi.fn<(r: unknown) => Promise<KeyView>>();
  const alerts = { open: vi.fn(() => of(undefined)) };
  const imported = key({ id: 'k2', name: 'id_rsa', managed: false });

  const picking = signal(false);
  const pickFile = vi.fn<(current: string | null) => Promise<string | null>>();

  async function setup(data?: KeyImportDialogData) {
    await TestBed.configureTestingModule({
      imports: [KeyImportDialog],
      providers: [
        provideTaiga(),
        {
          provide: POLYMORPHEUS_CONTEXT,
          useValue: { data, completeWith, $implicit: { complete: vi.fn() } },
        },
        {
          provide: KeyStore,
          useValue: { keys: signal([key({ name: 'taken' })]), import: importKey },
        },
        { provide: TuiNotificationService, useValue: alerts },
        { provide: KeyFilePicker, useValue: { picking, pickFile } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(KeyImportDialog);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const dialog = fixture.componentInstance as unknown as DialogApi;
    return { fixture, el, dialog, c: dialog.form.controls };
  }

  const byId = <T extends HTMLElement>(el: HTMLElement, id: string): T =>
    el.querySelector<T>(`[data-testid="${id}"]`)!;

  const settle = async (fixture: { whenStable(): Promise<unknown> }) => {
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 50));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    picking.set(false);
  });

  it('renders empty with a masked passphrase and remember off', async () => {
    const { el, dialog } = await setup();
    expect(dialog.form.getRawValue()).toEqual({
      path: '',
      name: '',
      passphrase: '',
      remember: false,
    });
    expect(byId<HTMLInputElement>(el, 'keyimport-passphrase').type).toBe('password');
    expect(byId<HTMLInputElement>(el, 'keyimport-remember').disabled).toBe(true);
  });

  it('names the key after the file until the name is edited', async () => {
    const { c } = await setup();
    c['path'].setValue('~/.ssh/id_rsa');
    expect(c['name'].value).toBe('id_rsa');
    c['name'].setValue('work');
    c['name'].markAsDirty();
    c['path'].setValue('C:\\keys\\other');
    expect(c['name'].value).toBe('work');
  });

  it('requires an absolute or ~/ path', async () => {
    const { dialog, c } = await setup();
    c['path'].setValue('id_rsa');
    await dialog.submit();
    expect(importKey).not.toHaveBeenCalled();
  });

  it('imports, clears the passphrase and completes', async () => {
    const { dialog, c } = await setup();
    importKey.mockResolvedValue(imported);
    c['path'].setValue(' ~/.ssh/id_rsa ');
    c['passphrase'].setValue('pw');
    c['remember'].setValue(true);
    const pending = dialog.submit();
    expect(c['passphrase'].value).toBe('');
    await pending;
    expect(importKey).toHaveBeenCalledWith({
      name: 'id_rsa',
      path: '~/.ssh/id_rsa',
      passphrase: 'pw',
      rememberPassphrase: true,
    });
    expect(completeWith).toHaveBeenCalledWith(imported);
  });

  it('puts a wrong passphrase and a bad file on their fields', async () => {
    const { dialog, c } = await setup();
    c['path'].setValue('~/.ssh/id_rsa');
    importKey.mockRejectedValueOnce(new IpcError('invalid_passphrase', 'x'));
    await dialog.submit();
    expect(c['passphrase'].errors?.['invalid']?.message).toBe('Wrong passphrase');

    c['passphrase'].setValue('');
    importKey.mockRejectedValueOnce(new IpcError('invalid_input', 'Not an OpenSSH private key'));
    await dialog.submit();
    expect(c['path'].errors?.['invalid']?.message).toBe('Not an OpenSSH private key');
    expect(completeWith).not.toHaveBeenCalled();

    c['path'].setValue('~/.ssh/id_x');
    importKey.mockRejectedValueOnce(new IpcError('keychain_unavailable', 'No keychain'));
    await dialog.submit();
    expect(alerts.open).toHaveBeenCalledWith(
      expect.stringContaining('No keychain. '),
      expect.objectContaining({ label: 'Key not imported' }),
    );
  });

  it('fills the path from Browse; the name follows unless edited', async () => {
    const { fixture, el, c } = await setup();
    pickFile.mockResolvedValue('C:\\Users\\me\\.ssh\\id_work');
    byId<HTMLButtonElement>(el, 'keyimport-browse').click();
    await settle(fixture);
    expect(pickFile).toHaveBeenCalledWith(null);
    expect(c['path'].value).toBe('C:\\Users\\me\\.ssh\\id_work');
    expect(c['name'].value).toBe('id_work');
    expect(document.activeElement).toBe(byId(el, 'keyimport-path'));

    c['name'].setValue('Work');
    c['name'].markAsDirty();
    pickFile.mockResolvedValue('/home/me/.ssh/id_other');
    byId<HTMLButtonElement>(el, 'keyimport-browse').click();
    await settle(fixture);
    expect(pickFile).toHaveBeenLastCalledWith('C:\\Users\\me\\.ssh\\id_work');
    expect(c['name'].value).toBe('Work');
  });

  it('keeps the path on a cancelled pick and focuses Browse; disabled while picking', async () => {
    const { fixture, el, c } = await setup();
    await settle(fixture);
    pickFile.mockResolvedValue(null);
    byId<HTMLButtonElement>(el, 'keyimport-browse').click();
    await settle(fixture);
    expect(c['path'].value).toBe('');
    expect(document.activeElement).toBe(byId(el, 'keyimport-browse'));
    picking.set(true);
    await fixture.whenStable();
    expect(byId<HTMLButtonElement>(el, 'keyimport-browse').disabled).toBe(true);
  });

  it('prefills the path and name from the data and focuses Name', async () => {
    const { fixture, el, c } = await setup({ path: '/home/me/.ssh/id_work' });
    await settle(fixture);
    expect(c['path'].value).toBe('/home/me/.ssh/id_work');
    expect(c['path'].touched).toBe(true);
    expect(c['name'].value).toBe('id_work');
    expect(document.activeElement).toBe(byId(el, 'keyimport-name'));
  });
});
