import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { FormGroup } from '@angular/forms';
import { provideTaiga, TuiDialogService, TuiNotificationService } from '@taiga-ui/core';
import { TUI_CONFIRM } from '@taiga-ui/kit';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { type Observable, of } from 'rxjs';
import { ConfigService } from '../../../core/ipc/config';
import { KeyFilePicker } from '../../../core/ipc/key-file-picker';
import { KeyStore } from '../../../core/ipc/key-store';
import type { KeyView } from '../../../core/ipc/keys';
import { key } from '../../../core/ipc/keys.fixture';
import type { Host, HostInput, Project, VariableView } from '../../../core/ipc/config.models';
import { IpcError } from '../../../core/ipc/ipc-error';
import { HostTester, type HostTestOutcome, type HostTestRun } from '../../host-test/host-tester';
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
  variables: [
    plain('host', '127.0.0.1'),
    plain('port', '2223'),
    secret('db_pw'),
    secret('prod_pw'),
  ],
};

interface DialogApi {
  form: FormGroup;
  secretReferences(): string[];
  submit(): Promise<void>;
  pickKey(path: string): Promise<void>;
  testBlocker(): string | null;
}

interface FakeRun {
  run: HostTestRun;
  abort: ReturnType<typeof vi.fn>;
  finish(outcome: HostTestOutcome): Promise<void>;
}

function fakeRun(): FakeRun {
  let resolve: (outcome: HostTestOutcome) => void = () => undefined;
  const outcome = new Promise<HostTestOutcome>((r) => (resolve = r));
  const abort = vi.fn(() => resolve({ kind: 'aborted' }));
  return {
    run: { outcome, abort },
    abort,
    finish: async (o) => {
      resolve(o);
      await outcome;
    },
  };
}

describe('HostDialog', () => {
  const completeWith = vi.fn();
  const save = vi.fn<HostDialogData['save']>();
  const alerts = { open: vi.fn(() => of(undefined)) };
  const projects = signal<Project[]>([PROJECT]);
  const variables = signal<VariableView[]>([plain('user', 'carapace'), secret('global_pw')]);
  const keys = signal<KeyView[]>([key({ name: 'main', path: '/keys/main' })]);
  const ensureLoaded = vi.fn(() => Promise.resolve());
  const loaded = signal(true);
  const picking = signal(false);
  const pickFile = vi.fn<(current: string | null) => Promise<string | null>>();
  const dialogs = { open: vi.fn<(content: unknown, options: unknown) => Observable<unknown>>() };
  const tester = { start: vi.fn<HostTester['start']>() };
  let runs: FakeRun[] = [];

  async function setup(
    initial: HostInput | null = null,
    projectId: string | null = 'p1',
    hostId: string | null = null,
  ) {
    await TestBed.configureTestingModule({
      imports: [HostDialog],
      providers: [
        provideTaiga(),
        {
          provide: POLYMORPHEUS_CONTEXT,
          useValue: {
            data: { projectId, hostId, location: 'Shop / Backend', initial, save },
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
        { provide: KeyStore, useValue: { keys, ensureLoaded, loaded } },
        { provide: KeyFilePicker, useValue: { picking, pickFile } },
        { provide: TuiDialogService, useValue: dialogs },
        { provide: TuiNotificationService, useValue: alerts },
        { provide: HostTester, useValue: tester },
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
    keys.set([key({ name: 'main', path: '/keys/main' })]);
    loaded.set(true);
    picking.set(false);
    dialogs.open.mockReturnValue(of(false));
    save.mockImplementation((host) => Promise.resolve({ ...host, id: 'h1' } as Host));
    runs = [];
    tester.start.mockImplementation(() => {
      const run = fakeRun();
      runs.push(run);
      return run.run;
    });
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

    it('resolves the templates with project then global variables', async () => {
      const { el } = await setup(templated);
      expect(preview(el).trim()).toBe('Resolves to carapace@127.0.0.1:2223');
    });

    it('updates while typing and lists missing variables', async () => {
      const { fixture, el, dialog } = await setup(templated);
      dialog.form.patchValue({ hostname: '${nope}.${host}', password: '${gone}' });
      await fixture.whenStable();
      expect(preview(el).trim()).toBe('Missing: nope, gone');
    });

    it('lists a variable no level defines', async () => {
      projects.set([{ ...PROJECT, variables: [plain('host', 'example.com')] }]);
      const { fixture, el, dialog } = await setup(templated);
      expect(preview(el).trim()).toBe('Missing: port');
      dialog.form.patchValue({ port: '2200' });
      await fixture.whenStable();
      expect(preview(el).trim()).toBe('Resolves to carapace@example.com:2200');
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

    it('resolves with global variables only', async () => {
      const { fixture, el, dialog } = await setup(null, null);
      dialog.form.patchValue({ name: 'vps', hostname: 'vps.example.com', username: '${user}' });
      await fixture.whenStable();
      expect(preview(el).trim()).toBe('Resolves to carapace@vps.example.com:22');
      dialog.form.patchValue({ hostname: '${host}' });
      await fixture.whenStable();
      expect(preview(el)).toContain('Missing: host');
    });
  });

  describe('test connection', () => {
    const keyHost: HostInput = {
      name: 'ui',
      hostname: '${host}',
      port: '${port}',
      username: '${user}',
      auth: { kind: 'key', keyPath: '/keys/${user}', passphrase: null },
    };
    const button = (el: HTMLElement): HTMLButtonElement =>
      byId(el, 'host-test') as HTMLButtonElement;
    const region = (el: HTMLElement): HTMLElement => byId(el, 'host-test-result')!;
    const squash = (node: HTMLElement | null): string =>
      node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const title = (el: HTMLElement): string => squash(byId(el, 'host-test-title'));
    const detail = (el: HTMLElement): string => squash(byId(el, 'host-test-detail'));
    const success: HostTestOutcome = {
      kind: 'success',
      result: {
        address: 'carapace@127.0.0.1:2223',
        authKind: 'key',
        secretSource: null,
        durationMs: 5,
      },
      durationMs: 412,
    };

    async function started(initial: HostInput = keyHost, hostId: string | null = null) {
      const ctx = await setup(initial, 'p1', hostId);
      button(ctx.el).click();
      await ctx.fixture.whenStable();
      return ctx;
    }

    it('is the first footer button, a flat non-submit button', async () => {
      const { el } = await setup(keyHost);
      const footer = el.querySelector('footer')!;
      expect(footer.firstElementChild).toBe(button(el));
      expect(button(el).type).toBe('button');
      expect(button(el).getAttribute('data-appearance')).toBe('flat');
      expect(button(el).textContent?.trim()).toBe('Test connection');
      expect(byId(el, 'dialog-save')!.getAttribute('type')).toBe('submit');
      expect(el.querySelectorAll('button[type="submit"]')).toHaveLength(1);
      expect(button(el).getAttribute('aria-disabled')).toBeNull();
    });

    it('has an always present live region, empty when idle', async () => {
      const { el } = await setup(keyHost);
      expect(region(el).getAttribute('role')).toBe('status');
      expect(region(el).getAttribute('aria-live')).toBe('polite');
      expect(region(el).hasAttribute('data-result')).toBe(false);
      expect(region(el).querySelector('[tuiNotification]')).toBeNull();
    });

    it('is not testable with missing variables, and says why', async () => {
      const { fixture, el, dialog } = await setup(keyHost);
      dialog.form.patchValue({ hostname: '${nope}' });
      await fixture.whenStable();
      expect(button(el).getAttribute('aria-disabled')).toBe('true');
      expect(button(el).getAttribute('data-state')).toBe('disabled');
      expect(button(el).disabled).toBe(false);
      expect(dialog.testBlocker()).toBe('Define the missing variables to test the connection.');
      button(el).click();
      await fixture.whenStable();
      expect(tester.start).not.toHaveBeenCalled();
      expect(region(el).hasAttribute('data-result')).toBe(false);
    });

    it('is not testable with a preview error or an invalid field', async () => {
      const { fixture, el, dialog } = await setup(keyHost);
      const fix = 'Fix the highlighted fields to test the connection.';
      dialog.form.patchValue({ username: '${db_pw}' });
      await fixture.whenStable();
      expect(dialog.testBlocker()).toBe(fix);
      dialog.form.patchValue({ username: '${user}', hostname: 'a b' });
      await fixture.whenStable();
      expect(dialog.testBlocker()).toBe(fix);
      dialog.form.patchValue({ hostname: '${host}', keyPath: '' });
      await fixture.whenStable();
      expect(dialog.testBlocker()).toBe(fix);
      expect(button(el).getAttribute('aria-disabled')).toBe('true');
      dialog.form.patchValue({ authKind: 'agent' });
      await fixture.whenStable();
      expect(dialog.testBlocker()).toBeNull();
    });

    it('is not testable once the project is gone', async () => {
      const { fixture, dialog } = await setup(keyHost);
      projects.set([]);
      await fixture.whenStable();
      expect(dialog.testBlocker()).toBe('This project no longer exists.');
    });

    it('is testable without a name', async () => {
      const { dialog } = await setup({ ...keyHost, name: '' });
      expect(dialog.form.get('name')!.invalid).toBe(true);
      expect(dialog.testBlocker()).toBeNull();
    });

    it('tests the draft in the dialog scope, resolved like the preview', async () => {
      await started({ ...keyHost, name: ' ui ' }, 'h7');
      expect(tester.start).toHaveBeenCalledWith({
        host: { ...keyHost, name: 'ui' },
        projectId: 'p1',
        hostId: 'h7',
        address: 'carapace@127.0.0.1:2223',
        keyPath: '/keys/carapace',
      });
    });

    it('turns into Cancel test while testing and shows what is tested', async () => {
      const { el } = await started();
      expect(button(el).textContent?.trim()).toBe('Cancel test');
      expect(button(el).getAttribute('data-testing')).toBe('true');
      expect(button(el).getAttribute('aria-disabled')).toBeNull();
      expect(region(el).getAttribute('data-result')).toBe('testing');
      expect(title(el)).toBe('Testing carapace@127.0.0.1:2223...');
      expect(region(el).querySelector('tui-loader')).not.toBeNull();
    });

    it('cancels from the same button', async () => {
      const { fixture, el } = await started();
      button(el).click();
      await fixture.whenStable();
      expect(runs[0].abort).toHaveBeenCalledOnce();
      expect(region(el).getAttribute('data-result')).toBe('cancelled');
      expect(title(el)).toBe('Test cancelled.');
      expect(button(el).textContent?.trim()).toBe('Test connection');
      expect(button(el).hasAttribute('data-testing')).toBe(false);
    });

    it('shows a success', async () => {
      const { fixture, el } = await started();
      await runs[0].finish(success);
      await fixture.whenStable();
      expect(region(el).getAttribute('data-result')).toBe('success');
      expect(region(el).querySelector('[tuiNotification]')!.getAttribute('data-appearance')).toBe(
        'positive',
      );
      expect(title(el)).toBe('Connected as carapace@127.0.0.1:2223');
      expect(detail(el)).toBe('Private key file · 412 ms');
      expect(button(el).textContent?.trim()).toBe('Test connection');
    });

    it.each([
      ['network', 'Could not reach 127.0.0.1:2223'],
      ['auth_failed', 'The server refused the key'],
      ['host_key_rejected', 'Host key not accepted'],
      ['host_key_changed', 'Host key has changed'],
      ['timeout', 'No answer from 127.0.0.1:2223'],
    ] as const)('shows a %s failure', async (code, expected) => {
      const { fixture, el } = await started();
      await runs[0].finish({
        kind: 'failure',
        error: new IpcError(code, 'connection refused'),
        origin: 'stored',
      });
      await fixture.whenStable();
      expect(region(el).getAttribute('data-result')).toBe('failure');
      expect(region(el).getAttribute('data-code')).toBe(code);
      expect(region(el).querySelector('[tuiNotification]')!.getAttribute('data-appearance')).toBe(
        'negative',
      );
      expect(title(el)).toBe(expected);
      expect(detail(el)).not.toBe('');
    });

    it('shows a cancelled prompt as a cancelled test', async () => {
      const { fixture, el } = await started();
      await runs[0].finish({ kind: 'cancelled' });
      await fixture.whenStable();
      expect(region(el).getAttribute('data-result')).toBe('cancelled');
    });

    it('clears the result when a value changes', async () => {
      const { fixture, el, dialog } = await started();
      await runs[0].finish(success);
      await fixture.whenStable();
      dialog.form.patchValue({ port: '2224' });
      await fixture.whenStable();
      expect(region(el).hasAttribute('data-result')).toBe(false);
      expect(region(el).querySelector('[tuiNotification]')).toBeNull();
    });

    it('clears the result when the resolved address changes', async () => {
      const { fixture, el } = await started();
      await runs[0].finish(success);
      await fixture.whenStable();
      projects.set([
        { ...PROJECT, variables: [...PROJECT.variables.slice(1), plain('host', '::1')] },
      ]);
      await fixture.whenStable();
      expect(region(el).hasAttribute('data-result')).toBe(false);
    });

    it('keeps the result while the values stay the same', async () => {
      const { fixture, el, dialog } = await started();
      await runs[0].finish(success);
      await fixture.whenStable();
      dialog.form.patchValue({ port: '${port}' });
      await fixture.whenStable();
      expect(region(el).getAttribute('data-result')).toBe('success');
    });

    it('aborts a running test on an edit and shows no result', async () => {
      const { fixture, el, dialog } = await started();
      dialog.form.patchValue({ name: 'other' });
      await fixture.whenStable();
      expect(runs[0].abort).toHaveBeenCalledOnce();
      expect(region(el).hasAttribute('data-result')).toBe(false);
      expect(button(el).textContent?.trim()).toBe('Test connection');
    });

    it('aborts a running test before saving', async () => {
      const { dialog } = await started();
      save.mockImplementationOnce((host) => {
        expect(runs[0].abort).toHaveBeenCalledOnce();
        return Promise.resolve({ ...host, id: 'h1' } as Host);
      });
      await dialog.submit();
      expect(save).toHaveBeenCalledOnce();
      expect(completeWith).toHaveBeenCalledOnce();
    });

    it('aborts a running test when the dialog closes', async () => {
      const { fixture } = await started();
      fixture.destroy();
      expect(runs[0].abort).toHaveBeenCalledOnce();
    });

    it('ignores the outcome of a cancelled run', async () => {
      const { fixture, el } = await started();
      button(el).click();
      await runs[0].finish(success);
      await fixture.whenStable();
      expect(region(el).getAttribute('data-result')).toBe('cancelled');
    });
  });
  describe('key file browse', () => {
    const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
    const keyHost = (keyPath: string): HostInput => ({
      ...valid,
      auth: { kind: 'key', keyPath, passphrase: null },
    });
    async function open(keyPath: string) {
      const ctx = await setup(keyHost(keyPath));
      await tick();
      await ctx.fixture.whenStable();
      return ctx;
    }
    const settle = async (fixture: { whenStable(): Promise<unknown> }) => {
      await tick();
      await fixture.whenStable();
      await tick();
    };
    const confirmCalls = () =>
      dialogs.open.mock.calls.filter(([content]) => content === TUI_CONFIRM);

    it('fills a plain field from Browse, starting from its path, and focuses it', async () => {
      const { fixture, el, dialog } = await open('~/.ssh/id_old');
      const browse = byId(el, 'host-key-browse') as HTMLButtonElement;
      expect(browse.getAttribute('aria-label')).toBe('Choose a key file');
      pickFile.mockResolvedValue('C:\\Users\\me\\.ssh\\id_work');
      browse.click();
      await settle(fixture);
      expect(pickFile).toHaveBeenCalledWith('~/.ssh/id_old');
      expect(dialog.form.get('keyPath')!.value).toBe('C:\\Users\\me\\.ssh\\id_work');
      expect(dialog.form.get('keyPath')!.dirty).toBe(true);
      expect(confirmCalls()).toEqual([]);
      expect(document.activeElement).toBe(byId(el, 'host-key-path'));
    });

    it('changes nothing on a cancelled pick and focuses Browse', async () => {
      const { fixture, el, dialog } = await open('~/.ssh/id_old');
      pickFile.mockResolvedValue(null);
      byId(el, 'host-key-browse')!.click();
      await settle(fixture);
      expect(dialog.form.get('keyPath')!.value).toBe('~/.ssh/id_old');
      expect(document.activeElement).toBe(byId(el, 'host-key-browse'));
      expect(byId(el, 'host-key-register')).toBeNull();
    });

    it('disables Browse while a picker is open', async () => {
      const { fixture, el } = await open('');
      picking.set(true);
      await fixture.whenStable();
      expect((byId(el, 'host-key-browse') as HTMLButtonElement).disabled).toBe(true);
    });

    it('asks before replacing a template, then replaces or keeps it', async () => {
      const { fixture, el, dialog } = await open('${keys}/id');
      pickFile.mockResolvedValue('/home/me/.ssh/id_work');
      dialogs.open.mockReturnValueOnce(of(false));
      byId(el, 'host-key-browse')!.click();
      await settle(fixture);
      expect(pickFile).toHaveBeenCalledWith(null);
      const [, options] = confirmCalls()[0] as [
        unknown,
        { label: string; data: Record<string, string> },
      ];
      expect(options.label).toBe('Replace the template?');
      expect(options.data['yes']).toBe('Replace');
      expect(options.data['no']).toBe('Keep template');
      expect(options.data['content']).toContain('<code>${keys}</code>');
      expect(options.data['content']).toContain('<code>/home/me/.ssh/id_work</code>');
      expect(dialog.form.get('keyPath')!.value).toBe('${keys}/id');
      expect(document.activeElement).toBe(byId(el, 'host-key-browse'));
      expect(byId(el, 'host-key-register')).toBeNull();

      dialogs.open.mockReturnValueOnce(of(true));
      byId(el, 'host-key-browse')!.click();
      await settle(fixture);
      expect(dialog.form.get('keyPath')!.value).toBe('/home/me/.ssh/id_work');
    });

    it('also confirms a registered key picked over a template', async () => {
      const { dialog } = await open('${keys}/id');
      dialogs.open.mockReturnValueOnce(of(false));
      await dialog.pickKey('/keys/main');
      expect(confirmCalls().length).toBe(1);
      expect(dialog.form.get('keyPath')!.value).toBe('${keys}/id');
      dialogs.open.mockReturnValueOnce(of(true));
      await dialog.pickKey('/keys/main');
      expect(dialog.form.get('keyPath')!.value).toBe('/keys/main');
    });

    it('treats $$ alone as a plain path', async () => {
      const { dialog } = await open('/keys/a$$b');
      await dialog.pickKey('/keys/main');
      expect(confirmCalls()).toEqual([]);
      expect(dialog.form.get('keyPath')!.value).toBe('/keys/main');
    });

    it('offers to register an unregistered browsed key until the path changes', async () => {
      const { fixture, el, dialog } = await open('');
      pickFile.mockResolvedValue('/keys/MAIN');
      byId(el, 'host-key-browse')!.click();
      await settle(fixture);
      expect(byId(el, 'host-key-register')).not.toBeNull();
      expect(byId(el, 'host-key-register-link')!.textContent).toBe('Register this key');

      dialog.form.patchValue({ keyPath: '/keys/other' });
      await fixture.whenStable();
      expect(byId(el, 'host-key-register')).toBeNull();
      dialog.form.patchValue({ keyPath: '/keys/MAIN' });
      await fixture.whenStable();
      expect(byId(el, 'host-key-register')).toBeNull();
    });

    it('shows no hint for a registered path or when the key list did not load', async () => {
      const { fixture, el } = await open('');
      pickFile.mockResolvedValue('/keys/main');
      byId(el, 'host-key-browse')!.click();
      await settle(fixture);
      expect(byId(el, 'host-key-register')).toBeNull();

      loaded.set(false);
      pickFile.mockResolvedValue('/keys/new');
      byId(el, 'host-key-browse')!.click();
      await settle(fixture);
      expect(byId(el, 'host-key-register')).toBeNull();
    });

    it('opens the import dialog prefilled and hides the hint once registered', async () => {
      await import('../../keys/key-import-dialog/key-import-dialog');
      const { fixture, el, dialog } = await open('');
      pickFile.mockResolvedValue('/keys/new');
      byId(el, 'host-key-browse')!.click();
      await settle(fixture);

      dialogs.open.mockReturnValueOnce(of(undefined));
      byId(el, 'host-key-register-link')!.click();
      await settle(fixture);
      const [, options] = dialogs.open.mock.calls.at(-1) as [unknown, { data: unknown }];
      expect(options.data).toEqual({ path: '/keys/new' });
      expect(byId(el, 'host-key-register')).not.toBeNull();

      const registered = key({ id: 'k9', name: 'new', path: '/keys/new', origin: 'imported' });
      dialogs.open.mockReturnValueOnce(of(registered));
      byId(el, 'host-key-register-link')!.click();
      await settle(fixture);
      expect(alerts.open).toHaveBeenCalledWith(
        'new',
        expect.objectContaining({ label: 'Key registered' }),
      );
      expect(byId(el, 'host-key-register')).toBeNull();
      expect(dialog.form.get('keyPath')!.value).toBe('/keys/new');
      expect(document.activeElement).toBe(byId(el, 'host-key-path'));
    });

    it('rejects a public key path', async () => {
      const { dialog } = await open('~/.ssh/id_work.pub');
      expect(dialog.form.get('keyPath')!.errors?.['invalid']?.message).toBe(
        'This is a public key. Choose the file without .pub.',
      );
    });
  });
});
