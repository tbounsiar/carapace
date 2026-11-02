import { TestBed } from '@angular/core/testing';
import { provideTaiga } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import type { HostInput } from '../../../core/ipc/config.models';
import { HostDialog, type HostDialogData } from './host-dialog';

describe('HostDialog', () => {
  const completeWith = vi.fn();
  const save = vi.fn<HostDialogData['save']>();

  async function setup(initial: HostInput | null = null) {
    await TestBed.configureTestingModule({
      imports: [HostDialog],
      providers: [
        provideTaiga(),
        {
          provide: POLYMORPHEUS_CONTEXT,
          useValue: { data: { initial, save }, completeWith, $implicit: {} },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(HostDialog);
    await fixture.whenStable();
    return { fixture, dialog: fixture.componentInstance as unknown as DialogApi };
  }

  interface DialogApi {
    form: import('@angular/forms').FormGroup;
    submit(): Promise<void>;
  }

  const valid: HostInput = {
    name: 'web-1',
    hostname: 'web1.example.com',
    port: 22,
    username: 'deploy',
    auth: { kind: 'agent' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    save.mockResolvedValue(undefined);
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
});
