import { TestBed } from '@angular/core/testing';
import { provideTaiga } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { Analytics, type AnalyticsRecent, type AnalyticsState } from '../../../core/ipc/analytics';
import { LanguageService } from '../../../core/i18n/language';
import { AnalyticsEventsDialog, localTime } from './analytics-events-dialog';

const SYSTEM = {
  appVersion: '0.4.0',
  os: 'Windows',
  osVersion: '11.0.26300',
  locale: 'fr-FR',
  sdkVersion: 'aptabase-tauri@1.0.0',
  sessionId: '17303125790123456',
};

const ON = { launch: true, features: true, connections: true, crashes: true };
const OFF = { launch: false, features: false, connections: false, crashes: false };

function stateOf(
  categories: AnalyticsState['categories'],
  extra: Partial<AnalyticsState> = {},
): AnalyticsState {
  return {
    categories,
    pending: [],
    doNotTrack: false,
    askNeeded: false,
    available: true,
    persisted: true,
    ...extra,
  };
}

describe('AnalyticsEventsDialog', () => {
  async function setup(state: AnalyticsState, recent: () => Promise<AnalyticsRecent>) {
    const completeWith = vi.fn();
    await TestBed.configureTestingModule({
      imports: [AnalyticsEventsDialog],
      providers: [
        provideTaiga(),
        { provide: POLYMORPHEUS_CONTEXT, useValue: { completeWith, data: state } },
        { provide: Analytics, useValue: { recent } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(AnalyticsEventsDialog);
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const byId = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    return { el, byId, completeWith, fixture };
  }

  it('shows the system properties and the events, newest first', async () => {
    const { byId } = await setup(stateOf(ON), () =>
      Promise.resolve<AnalyticsRecent>({
        system: SYSTEM,
        events: [
          {
            time: '2026-11-03T14:02:11Z',
            name: 'connect_succeeded',
            props: { auth: 'key', duration: '1-3s' },
          },
          { time: '2026-11-03T14:01:58Z', name: 'app_started', props: { theme: 'system' } },
          { time: '2026-11-03T14:01:57Z', name: 'session_started', props: {} },
        ],
      }),
    );
    expect(byId('analytics-system')?.textContent).toContain('fr-FR');
    expect(byId('analytics-system')?.textContent).toContain('Windows 11.0.26300');
    expect(byId('analytics-system')?.textContent).toContain('SDK version');
    expect(byId('analytics-system')?.textContent).toContain('aptabase-tauri@1.0.0');
    expect(byId('analytics-system')?.textContent).toContain('Session ID');
    expect(byId('analytics-system')?.textContent).toContain(
      'Random, new at each launch, not linked to you.',
    );
    expect(byId('analytics-system')?.textContent).toContain('17303125790123456');
    expect(byId('analytics-event-0')?.dataset['event']).toBe('connect_succeeded');
    expect(byId('analytics-event-0')?.textContent).toContain('auth=key');
    expect(byId('analytics-event-0')?.textContent).toContain('duration=1-3s');
    expect(byId('analytics-event-0')?.textContent).toMatch(/\d{1,2}:\d\d:\d\d/);
    expect(byId('analytics-event-1')?.dataset['event']).toBe('app_started');
    expect(byId('analytics-event-2')?.dataset['event']).toBe('session_started');
    expect(byId('analytics-event-2')?.querySelectorAll('td')[2].textContent?.trim()).toBe('None');
    expect(byId('analytics-country-note')?.textContent).toContain(
      'The country and region are not sent',
    );
    const cells = Array.from(byId('analytics-event-1')!.querySelectorAll('td'));
    expect(cells.map((td) => getComputedStyle(td).verticalAlign)).toEqual(['top', 'top', 'top']);
    expect(byId('analytics-events-empty')).toBeNull();
    expect(byId('analytics-events-keyless')).toBeNull();
    expect(byId('analytics-crash-note')).toBeNull();
  });

  it('lists crash reports as crash rows, with the previous launch noted', async () => {
    const { byId } = await setup(stateOf(ON), () =>
      Promise.resolve<AnalyticsRecent>({
        system: SYSTEM,
        events: [
          {
            time: '2026-11-03T14:03:12Z',
            name: 'crash',
            props: {
              type: 'panic:ssh',
              message: 'panic:ssh:unwrap_none',
              kind: 'taskException',
              severity: 'error',
              line: 'src/ssh/session.rs:214',
              session: '5b0e7c2e-5d0f-4f3c-9a51-2a7f0c6f1d11',
            },
          },
          {
            time: '2026-11-03T09:58:40Z',
            name: 'crash',
            props: {
              type: 'panic:tauri',
              message: 'panic:tauri:other',
              kind: 'crash',
              severity: 'fatal',
              session: '1c7a0b2e-5d0f-4f3c-9a51-2a7f0c6f1d11',
            },
            previousLaunch: true,
          },
          { time: '2026-11-03T14:01:57Z', name: 'session_started', props: {} },
        ],
      }),
    );
    const props = (i: number) =>
      Array.from(byId(`analytics-event-${i}`)!.querySelectorAll('td')[2].children).map((d) =>
        d.textContent?.trim(),
      );
    const time = (i: number) => byId(`analytics-event-${i}`)!.querySelectorAll('td')[0];
    expect(byId('analytics-event-0')?.dataset['event']).toBe('crash');
    expect(props(0)).toEqual([
      'type=panic:ssh',
      'message=panic:ssh:unwrap_none',
      'kind=taskException',
      'severity=error',
      'line=src/ssh/session.rs:214',
      'session=5b0e7c2e-5d0f-4f3c-9a51-2a7f0c6f1d11',
    ]);
    expect(time(0).textContent).not.toContain('Previous launch');
    expect(byId('analytics-event-1')?.dataset['event']).toBe('crash');
    expect(props(1)).not.toContain(expect.stringMatching(/^line=/));
    expect(time(1).querySelector('.note')?.textContent?.trim()).toBe('Previous launch');
    expect(time(2).textContent).not.toContain('Previous launch');
    expect(byId('analytics-crash-note')?.textContent?.trim()).toBe(
      'Crash reports carry the app version and OS but not the language, and use their own random ID so they cannot be linked to the other events in this list.',
    );
  });

  it('says when nothing was sent and usage data is off, in a keyless build', async () => {
    const { byId } = await setup(stateOf(OFF, { available: false }), () =>
      Promise.resolve({ system: SYSTEM, events: [] }),
    );
    expect(byId('analytics-events')).toBeNull();
    expect(byId('analytics-events-empty')?.textContent).toContain('Nothing sent in this session.');
    expect(byId('analytics-events-empty')?.textContent).toContain('Usage data is off.');
    expect(byId('analytics-events-keyless')?.textContent).toContain(
      'This build does not send usage data.',
    );
  });

  it('gives no reason for an empty log when a category is on', async () => {
    const { byId } = await setup(stateOf({ ...OFF, launch: true }), () =>
      Promise.resolve({ system: SYSTEM, events: [] }),
    );
    expect(byId('analytics-events-empty')?.textContent?.trim()).toBe(
      'Nothing sent in this session.',
    );
  });

  it('names DO_NOT_TRACK as the reason nothing was sent', async () => {
    const { byId } = await setup(stateOf(ON, { doNotTrack: true }), () =>
      Promise.resolve({ system: SYSTEM, events: [] }),
    );
    expect(byId('analytics-events-empty')?.textContent).toContain(
      'DO_NOT_TRACK is set on this computer.',
    );
    expect(byId('analytics-events-empty')?.textContent).not.toContain('Usage data is off.');
  });

  it('formats times on the local clock in the locale and keeps an unreadable one as is', () => {
    const date = new Date(2026, 10, 3, 9, 5, 7);
    expect(localTime(date.toISOString(), 'en-US')).toMatch(/^9:05:07\sAM$/);
    expect(localTime(date.toISOString(), 'fr-FR')).toBe('09:05:07');
    expect(localTime('not a date', 'en-US')).toBe('not a date');
  });

  it('shows an error when the events cannot be read, and closes', async () => {
    const { byId, completeWith } = await setup(stateOf(ON), () =>
      Promise.reject(new Error('broken')),
    );
    expect(byId('analytics-events-error')).not.toBeNull();
    byId('analytics-events-close')!.click();
    expect(completeWith).toHaveBeenCalled();
  });

  it('follows a switch to French, times included', async () => {
    const { byId, fixture } = await setup(stateOf(ON), () =>
      Promise.resolve<AnalyticsRecent>({
        system: SYSTEM,
        events: [{ time: '2026-11-03T14:02:11Z', name: 'app_started', props: {} }],
      }),
    );
    TestBed.inject(LanguageService).apply('fr');
    await fixture.whenStable();
    expect(byId('analytics-system')?.textContent).toContain('Version de l’application');
    const cells = byId('analytics-event-0')!.querySelectorAll('td');
    expect(cells[0].textContent?.trim()).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(cells[2].textContent?.trim()).toBe('Aucune');
    expect(byId('analytics-events-close')?.textContent?.trim()).toBe('Fermer');
    TestBed.inject(LanguageService).apply('system');
  });
});
