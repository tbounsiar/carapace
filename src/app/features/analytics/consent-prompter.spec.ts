import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { provideTaiga, TUI_DIALOGS_CLOSE, TuiDialogService, TuiRoot } from '@taiga-ui/core';
import { Subject } from 'rxjs';
import type { AnalyticsChoices, AnalyticsState } from '../../core/ipc/analytics';
import { ConfigService } from '../../core/ipc/config';
import { provideOpenDialogs } from '../../shared/open-dialogs';
import { ConsentPrompter } from './consent-prompter';

@Component({ imports: [TuiRoot], template: '<tui-root />' })
class Shell {}

const OFF: AnalyticsChoices = {
  launch: false,
  features: false,
  connections: false,
  crashes: false,
};

const UNSET: AnalyticsState = {
  categories: OFF,
  pending: ['launch', 'features', 'connections', 'crashes'],
  doNotTrack: false,
  askNeeded: true,
  available: false,
  persisted: true,
};

describe('ConsentPrompter', () => {
  let fixture: ComponentFixture<Shell>;
  let prompter: ConsentPrompter;
  let loaded: ReturnType<typeof signal<boolean>>;
  let calls: { cmd: string; args: unknown }[];
  let state: AnalyticsState;
  let saveFails: boolean;
  let closeAll: Subject<void>;

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) {
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r));
    }
  };
  const dialog = (): HTMLElement | null =>
    document.body.querySelector<HTMLElement>('[data-testid="consent-dialog"]');
  const byId = <T extends HTMLElement = HTMLButtonElement>(id: string): T =>
    document.body.querySelector<T>(`[data-testid="${id}"]`)!;
  const saved = () => calls.filter((c) => c.cmd === 'set_analytics_choices').map((c) => c.args);

  beforeAll(() => import('./consent-dialog/consent-dialog'), 60_000);

  beforeEach(async () => {
    calls = [];
    state = UNSET;
    saveFails = false;
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'analytics_state') {
        return state;
      }
      if (cmd === 'set_analytics_choices') {
        if (saveFails) {
          throw { code: 'io', message: 'disk full' };
        }
        const { choices } = args as { choices: AnalyticsChoices };
        return { ...UNSET, categories: choices, pending: [], askNeeded: false };
      }
      return null;
    });
    loaded = signal(false);
    closeAll = new Subject<void>();
    await TestBed.configureTestingModule({
      imports: [Shell],
      providers: [
        provideTaiga(),
        provideOpenDialogs(),
        { provide: ConfigService, useValue: { loaded } },
        { provide: TUI_DIALOGS_CLOSE, useFactory: () => closeAll },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Shell);
    prompter = TestBed.inject(ConsentPrompter);
    await settle();
  });

  afterEach(() => clearMocks());

  it('reports the start with the theme setting, waits for the config, then asks', async () => {
    const done = prompter.start();
    await settle();
    expect(calls[0]).toEqual({ cmd: 'analytics_app_started', args: { theme: 'system' } });
    expect(dialog()).toBeNull();

    loaded.set(true);
    await settle();
    expect(dialog()).not.toBeNull();
    // Taiga's default autofocus handler focuses asynchronously.
    await vi.waitFor(() => expect(document.activeElement).toBe(byId('consent-launch')));
    expect(byId<HTMLInputElement>('consent-launch').checked).toBe(true);
    expect(byId<HTMLInputElement>('consent-features').checked).toBe(true);
    expect(byId<HTMLInputElement>('consent-connections').checked).toBe(true);
    expect(byId<HTMLInputElement>('consent-crashes').checked).toBe(true);
    expect(document.body.querySelector('tui-dialog')?.textContent).toContain(
      'Anonymous usage data',
    );
    expect(document.body.querySelector('tui-dialog')?.getAttribute('data-size')).toBe('m');
    byId('consent-save').click();
    await done;
    expect(saved()).toEqual([
      { choices: { launch: true, features: true, connections: true, crashes: true } },
    ]);
  });

  it('waits until no other dialog is open', async () => {
    loaded.set(true);
    const other = TestBed.inject(TuiDialogService).open('Host key').subscribe();
    const done = prompter.start();
    await settle();
    expect(dialog()).toBeNull();

    other.unsubscribe();
    await settle();
    expect(dialog()).not.toBeNull();
    byId('consent-save').click();
    await done;
    expect(saved()).toEqual([
      { choices: { launch: true, features: true, connections: true, crashes: true } },
    ]);
  });

  it('saves the switches as shown on Escape, in one call', async () => {
    loaded.set(true);
    const done = prompter.start();
    await settle();
    byId('consent-launch').click();
    byId('consent-features').click();
    await settle();
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await done;
    expect(saved()).toEqual([
      { choices: { launch: false, features: false, connections: true, crashes: true } },
    ]);
  });

  it('saves the switches as shown on a backdrop click', async () => {
    loaded.set(true);
    const done = prompter.start();
    await settle();
    byId('consent-connections').click();
    await settle();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 1 }));
    document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 1 }));
    await done;
    expect(saved()).toEqual([
      { choices: { launch: true, features: true, connections: false, crashes: true } },
    ]);
  });

  it('saves nothing when the dialog is closed without a user action', async () => {
    loaded.set(true);
    const done = prompter.start();
    await settle();
    expect(dialog()).not.toBeNull();
    // What Taiga does on a router navigation (ActivationStart).
    closeAll.next();
    await done;
    await settle();
    expect(dialog()).toBeNull();
    expect(saved()).toEqual([]);
    expect(document.body.textContent).not.toContain('Setting not saved');
  });

  it('starts a re-ask with pending categories on and the others as stored', async () => {
    state = {
      ...UNSET,
      categories: { launch: false, features: false, connections: false, crashes: false },
      pending: ['features', 'connections'],
    };
    loaded.set(true);
    const done = prompter.start();
    await settle();
    expect(byId<HTMLInputElement>('consent-launch').checked).toBe(false);
    expect(byId<HTMLInputElement>('consent-features').checked).toBe(true);
    expect(byId<HTMLInputElement>('consent-connections').checked).toBe(true);
    expect(byId<HTMLInputElement>('consent-crashes').checked).toBe(false);
    expect(byId('consent-reask')).not.toBeNull();
    byId('consent-save').click();
    await done;
  });

  it('asks an upgrading user about crash reports only, switched on', async () => {
    state = {
      ...UNSET,
      categories: { launch: true, features: false, connections: true, crashes: false },
      pending: ['crashes'],
    };
    loaded.set(true);
    const done = prompter.start();
    await settle();
    expect(byId<HTMLInputElement>('consent-features').checked).toBe(false);
    expect(byId<HTMLInputElement>('consent-crashes').checked).toBe(true);
    expect(byId('consent-reask')).not.toBeNull();
    byId('consent-save').click();
    await done;
    expect(saved()).toEqual([
      { choices: { launch: true, features: false, connections: true, crashes: true } },
    ]);
  });

  it('starts crash reports off when the three other categories were refused', async () => {
    state = { ...UNSET, categories: OFF, pending: ['crashes'] };
    loaded.set(true);
    const done = prompter.start();
    await settle();
    expect(byId<HTMLInputElement>('consent-crashes').checked).toBe(false);
    byId('consent-save').click();
    await done;
    expect(saved()).toEqual([{ choices: OFF }]);
  });

  it('has no close button', async () => {
    loaded.set(true);
    void prompter.start();
    await settle();
    expect(document.body.querySelector('tui-dialog [tuiIconButton]')).toBeNull();
    expect(dialog()!.querySelectorAll('footer button').length).toBe(1);
  });

  it('does not ask when everything is answered, and asks only once', async () => {
    state = { ...UNSET, pending: [], askNeeded: false };
    loaded.set(true);
    await prompter.start();
    await prompter.start();
    await settle();
    expect(dialog()).toBeNull();
    expect(calls.filter((c) => c.cmd === 'analytics_state').length).toBe(1);
  });

  it('does not ask under DO_NOT_TRACK', async () => {
    state = { ...UNSET, doNotTrack: true, askNeeded: false };
    loaded.set(true);
    await prompter.start();
    await settle();
    expect(dialog()).toBeNull();
    expect(saved()).toEqual([]);
  });

  it('reads the state again and says when a refusal is kept in memory only', async () => {
    saveFails = true;
    loaded.set(true);
    const done = prompter.start();
    await settle();
    state = { ...UNSET, pending: [], askNeeded: false, persisted: false };
    byId('consent-save').click();
    await done;
    await settle();
    expect(calls.filter((c) => c.cmd === 'analytics_state').length).toBe(2);
    expect(document.body.textContent).toContain(
      'Off for this session. The setting could not be saved; Carapace will try again.',
    );
    expect(document.body.textContent).not.toContain('Disk full');
  });

  it('shows a toast when the choices are not saved', async () => {
    saveFails = true;
    loaded.set(true);
    const done = prompter.start();
    await settle();
    byId('consent-save').click();
    await done;
    await settle();
    expect(document.body.textContent).toContain('Setting not saved');
  });
});
