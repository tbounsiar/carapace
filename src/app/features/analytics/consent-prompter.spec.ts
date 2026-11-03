import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { provideTaiga, TuiDialogService, TuiRoot } from '@taiga-ui/core';
import type { AnalyticsState } from '../../core/ipc/analytics';
import { ConfigService } from '../../core/ipc/config';
import { provideOpenDialogs } from '../../shared/open-dialogs';
import { ConsentPrompter } from './consent-prompter';

@Component({ imports: [TuiRoot], template: '<tui-root />' })
class Shell {}

const UNSET: AnalyticsState = {
  consent: 'unset',
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

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) {
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r));
    }
  };
  const dialog = (): HTMLElement | null =>
    document.body.querySelector<HTMLElement>('[data-testid="consent-dialog"]');
  const byId = (id: string): HTMLButtonElement =>
    document.body.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
  const saved = () => calls.filter((c) => c.cmd === 'set_analytics_consent').map((c) => c.args);

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
      if (cmd === 'set_analytics_consent') {
        if (saveFails) {
          throw { code: 'io', message: 'disk full' };
        }
        const granted = (args as { granted: boolean }).granted;
        return {
          consent: granted ? 'granted' : 'denied',
          askNeeded: false,
          available: false,
          persisted: true,
        };
      }
      return null;
    });
    loaded = signal(false);
    await TestBed.configureTestingModule({
      imports: [Shell],
      providers: [
        provideTaiga(),
        provideOpenDialogs(),
        { provide: ConfigService, useValue: { loaded } },
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
    expect(document.activeElement).toBe(byId('consent-decline'));
    expect(document.body.querySelector('tui-dialog')?.textContent).toContain(
      'Share anonymous usage data?',
    );
    byId('consent-share').click();
    await done;
    expect(saved()).toEqual([{ granted: true }]);
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
    byId('consent-decline').click();
    await done;
    expect(saved()).toEqual([{ granted: false }]);
  });

  it('declines on Escape', async () => {
    loaded.set(true);
    const done = prompter.start();
    await settle();
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await done;
    expect(saved()).toEqual([{ granted: false }]);
  });

  it('has no close button', async () => {
    loaded.set(true);
    void prompter.start();
    await settle();
    expect(document.body.querySelector('tui-dialog [tuiIconButton]')).toBeNull();
    expect(dialog()!.querySelectorAll('footer button').length).toBe(2);
  });

  it('does not ask when the decision is made, and asks only once', async () => {
    state = { consent: 'denied', askNeeded: false, available: false, persisted: true };
    loaded.set(true);
    await prompter.start();
    await prompter.start();
    await settle();
    expect(dialog()).toBeNull();
    expect(calls.filter((c) => c.cmd === 'analytics_state').length).toBe(1);
  });

  it('reads the state again and says when a refusal is kept in memory only', async () => {
    saveFails = true;
    loaded.set(true);
    const done = prompter.start();
    await settle();
    state = { consent: 'denied', askNeeded: false, available: false, persisted: false };
    byId('consent-decline').click();
    await done;
    await settle();
    expect(calls.filter((c) => c.cmd === 'analytics_state').length).toBe(2);
    expect(document.body.textContent).toContain(
      'Off for this session. The setting could not be saved; Carapace will try again.',
    );
    expect(document.body.textContent).not.toContain('Disk full');
  });

  it('shows a toast when the decision is not saved', async () => {
    saveFails = true;
    loaded.set(true);
    const done = prompter.start();
    await settle();
    byId('consent-share').click();
    await done;
    await settle();
    expect(document.body.textContent).toContain('Setting not saved');
  });
});
