import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { FormGroup } from '@angular/forms';
import { provideTaiga, TuiNotificationService } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { of } from 'rxjs';
import { ConfigService } from '../../../core/ipc/config';
import { KeyStore } from '../../../core/ipc/key-store';
import type { KeyView } from '../../../core/ipc/keys';
import { key } from '../../../core/ipc/keys.fixture';
import type { Host, HostInput, Project, VariableView } from '../../../core/ipc/config.models';
import { HostDialog, type HostDialogData } from './host-dialog';

const plain = (name: string, value: string): VariableView => ({
  name,
  kind: 'plain',
  value,
  hasValue: true,
});
const secret = (name: string): VariableView => ({
  name,
  kind: 'secret',
  value: null,
  hasValue: true,
});

const PROJECT: Project = {
  id: 'p1',
  name: 'Shop',
  variables: [plain('host', 'example.com'), secret('db_pw')],
  environments: [
    { id: 'e1', name: 'Dev', variables: [plain('host', '127.0.0.1'), plain('port', '2223')] },
    { id: 'e2', name: 'Prod', variables: [secret('prod_pw')] },
  ],
  activeEnvironmentId: 'e1',
};

interface DialogApi {
  form: FormGroup;
  secretReferences(): string[];
  submit(): Promise<void>;
  pickKey(path: string): void;
}

describe('HostDialog', () => {
  const completeWith = vi.fn();
  const save = vi.fn<HostDialogData['save']>();
  const alerts = { open: vi.fn(() => of(undefined)) };
  const projects = signal<Project[]>([PROJECT]);
  const variables = signal<VariableView[]>([plain('user', 'carapace'), secret('global_pw')]);
  const keys = signal<KeyView[]>([key({ name: 'main', path: '/keys/main' })]);
  const ensureLoaded = vi.fn(() => Promise.resolve());

  async function setup(initial: HostInput | null = null, projectId: string | null = 'p1') {
    await TestBed.configureTestingModule({
      imports: [HostDialog],
      providers: [
        provideTaiga(),
        {
          provide: POLYMORPHEUS_CONTEXT,
          useValue: {
            data: { projectId, location: 'Shop / Backend', initial, save },
            completeWith,
            $implicit: {},
          },
        },
        {
          provide: ConfigService,
          useValue: {
            projects,
            variables,
            findProject: (id: string) => projects().find((p) => p.id === id) ?? null,
          },
        },
        { provide: KeyStore, useValue: { keys, ensureLoaded } },
        { provide: TuiNotificationService, useValue: alerts },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(HostDialog);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, el, dialog: fixture.componentInstance as unknown as DialogApi };
  }

  const byId = (el: HTMLElement, id: string): HTMLElement | null =>
    el.querySelector(`[data-testid="${id}"]`);

  const valid: HostInput = {
    name: 'web-1',
    hostname: 'web1.example.com',
    port: '22',
    username: 'deploy',
    auth: { kind: 'agent' },
  };
  const templated: HostInput = {
    name: 'ui',
    hostname: '${host}',
    port: '${port}',
    username: '${user}',
    auth: { kind: 'password', password: null },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    projects.set([PROJECT]);
    save.mockImplementation((host) => Promise.resolve({ ...host, id: 'h1' } as Host));
  });

  it('defaults the port to 22 and password auth asked when connecting', async () => {
    const { dialog } = await setup();
    expect(dialog.form.value.port).toBe('22');
    expect(dialog.form.value.authKind).toBe('password');
    expect(dialog.form.value.password).toBeNull();
  });

  it('is invalid until required fields are filled', async () => {
    const { dialog } = await setup();
    await dialog.submit();
    expect(save).not.toHaveBeenCalled();
    expect(dialog.form.get('name')!.invalid).toBe(true);
    expect(dialog.form.get('hostname')!.invalid).toBe(true);
    expect(dialog.form.get('username')!.invalid).toBe(true);
  });

  it('checks literal values but accepts templates', async () => {
    const { dialog } = await setup(valid);
    dialog.form.patchValue({ hostname: 'a b', username: 'x y', port: '70000' });
    expect(dialog.form.get('hostname')!.invalid).toBe(true);
    expect(dialog.form.get('username')!.invalid).toBe(true);
    expect(dialog.form.get('port')!.invalid).toBe(true);
    dialog.form.patchValue({ hostname: '${host}', username: '${user}', port: '${port}' });
    expect(dialog.form.valid).toBe(true);
    dialog.form.patchValue({ hostname: '${bad name}', port: '22${x}' });
    expect(dialog.form.get('hostname')!.invalid).toBe(true);
    expect(dialog.form.get('port')!.invalid).toBe(true);
  });

  it('requires a key path only for key auth', async () => {
    const { fixture, dialog } = await setup(valid);
    expect(dialog.form.valid).toBe(true);
    dialog.form.patchValue({ authKind: 'key' });
    await fixture.whenStable();
    expect(dialog.form.get('keyPath')!.invalid).toBe(true);
    dialog.form.patchValue({ keyPath: '${keys}/id_ed25519' });
    expect(dialog.form.valid).toBe(true);
  });

  it('submits trimmed templates with the key auth method', async () => {
    const { fixture, dialog } = await setup(valid);
    dialog.form.patchValue({ authKind: 'key', keyPath: ' ~/.ssh/id ', hostname: ' ${host} ' });
    await fixture.whenStable();
    await dialog.submit();
    expect(save).toHaveBeenCalledWith({
      ...valid,
      hostname: '${host}',
      auth: { kind: 'key', keyPath: '~/.ssh/id', passphrase: null },
    });
    expect(completeWith).toHaveBeenCalledOnce();
  });

  it('inserts a registered key path from the picker, typing still works', async () => {
    const { fixture, el, dialog } = await setup(valid);
    expect(ensureLoaded).toHaveBeenCalled();
    expect(byId(el, 'host-key-pick')).toBeNull();
    dialog.form.patchValue({ authKind: 'key' });
    await fixture.whenStable();
    expect(byId(el, 'host-key-pick')!.getAttribute('aria-label')).toBe('Pick a registered key');
    dialog.pickKey('/keys/main');
    expect(dialog.form.get('keyPath')!.value).toBe('/keys/main');
    expect(dialog.form.get('keyPath')!.dirty).toBe(true);
    await dialog.submit();
    expect(save).toHaveBeenLastCalledWith({
      ...valid,
      auth: { kind: 'key', keyPath: '/keys/main', passphrase: null },
    });
    dialog.form.patchValue({ keyPath: '${keys}/id' });
    expect(dialog.form.valid).toBe(true);
  });

  it('keeps the dialog open when the save fails', async () => {
    save.mockRejectedValue(new Error('boom'));
    const { dialog } = await setup(valid);
    await dialog.submit();
    expect(completeWith).not.toHaveBeenCalled();
    expect(alerts.open).toHaveBeenCalledOnce();
  });

  describe('secret picker', () => {
    it('shows a password field for password auth, a passphrase field for key auth, none for agent', async () => {
      const { fixture, el, dialog } = await setup(templated);
      expect(byId(el, 'host-password')).not.toBeNull();
      dialog.form.patchValue({ authKind: 'key' });
      await fixture.whenStable();
      expect(byId(el, 'host-password')).toBeNull();
      expect(byId(el, 'host-passphrase')).not.toBeNull();
      dialog.form.patchValue({ authKind: 'agent' });
      await fixture.whenStable();
      expect(byId(el, 'host-passphrase')).toBeNull();
    });

    it('offers the secret variables of every level as references', async () => {
      const { dialog } = await setup(templated);
      expect(dialog.secretReferences()).toEqual(['${db_pw}', '${global_pw}', '${prod_pw}']);
    });

    it('keeps a reference to a variable that no longer exists in the list', async () => {
      const { dialog } = await setup({
        ...templated,
        auth: { kind: 'password', password: '${removed}' },
      });
      expect(dialog.form.value.password).toBe('${removed}');
      expect(dialog.secretReferences()).toContain('${removed}');
    });

    it('saves a picked reference, never a value', async () => {
      const { dialog } = await setup(templated);
      dialog.form.patchValue({ password: '${db_pw}' });
      await dialog.submit();
      expect(save).toHaveBeenCalledWith({
        ...templated,
        auth: { kind: 'password', password: '${db_pw}' },
      });
    });

    it('saves an empty field as "ask when connecting"', async () => {
      const { dialog } = await setup({
        ...templated,
        auth: { kind: 'password', password: '${db_pw}' },
      });
      dialog.form.patchValue({ password: '  ' });
      await dialog.submit();
      expect(save.mock.calls[0][0].auth).toEqual({ kind: 'password', password: null });
    });

    it('rejects a typed password instead of a reference', async () => {
      const { dialog } = await setup(templated);
      dialog.form.patchValue({ password: 'hunter2' });
      await dialog.submit();
      expect(dialog.form.get('password')!.invalid).toBe(true);
      expect(save).not.toHaveBeenCalled();
    });

    it('keeps the passphrase reference of a key host', async () => {
      const { dialog } = await setup({
        ...valid,
        auth: { kind: 'key', keyPath: '~/.ssh/id', passphrase: '${db_pw}' },
      });
      await dialog.submit();
      expect(save.mock.calls[0][0].auth).toEqual({
        kind: 'key',
        keyPath: '~/.ssh/id',
        passphrase: '${db_pw}',
      });
    });
  });

  it('shows where the host goes', async () => {
    const { el } = await setup();
    expect(byId(el, 'host-location')?.textContent).toContain('In: Shop / Backend');
  });

  describe('preview', () => {
    const preview = (el: HTMLElement): string => byId(el, 'host-preview')?.textContent ?? '';

    it('resolves the templates in the active environment', async () => {
      const { el } = await setup(templated);
      expect(preview(el)).toContain('Resolves to');
      expect(preview(el)).toContain('carapace@127.0.0.1:2223');
      expect(preview(el)).toContain('in Dev');
    });

    it('updates while typing and lists missing variables', async () => {
      const { fixture, el, dialog } = await setup(templated);
      dialog.form.patchValue({ hostname: '${nope}.${host}', password: '${gone}' });
      await fixture.whenStable();
      expect(preview(el)).toContain('Missing in Dev: nope, gone');
    });

    it('resolves without an environment', async () => {
      projects.set([{ ...PROJECT, activeEnvironmentId: null }]);
      const { fixture, el, dialog } = await setup(templated);
      expect(preview(el)).toContain('Missing with no environment: port');
      dialog.form.patchValue({ port: '2200' });
      await fixture.whenStable();
      expect(preview(el)).toContain('carapace@example.com:2200 with no environment');
    });

    it('reports a secret variable used in a plain field', async () => {
      const { fixture, el, dialog } = await setup(templated);
      dialog.form.patchValue({ username: '${db_pw}' });
      await fixture.whenStable();
      expect(preview(el)).toContain('secret variable db_pw used in a non-secret field');
    });
  });

  describe('at Home', () => {
    const preview = (el: HTMLElement): string => byId(el, 'host-preview')?.textContent ?? '';

    it('offers global secret variables only', async () => {
      const { dialog } = await setup(null, null);
      expect(dialog.secretReferences()).toEqual(['${global_pw}']);
    });

    it('resolves with global variables and no environment phrase', async () => {
      const { fixture, el, dialog } = await setup(null, null);
      dialog.form.patchValue({ name: 'vps', hostname: 'vps.example.com', username: '${user}' });
      await fixture.whenStable();
      expect(preview(el).trim()).toBe('Resolves to carapace@vps.example.com:22');
      dialog.form.patchValue({ hostname: '${host}' });
      await fixture.whenStable();
      expect(preview(el)).toContain('Missing: host');
    });
  });
});
