import { TestBed } from '@angular/core/testing';
import { provideTaiga } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { Analytics, type AnalyticsRecent, type AnalyticsState } from '../../../core/ipc/analytics';
import { AnalyticsEventsDialog, localTime } from './analytics-events-dialog';

const SYSTEM = {
  appVersion: '0.4.0',
  os: 'Windows',
  osVersion: '11.0.26300',
  locale: 'fr-FR',
  sdkVersion: 'aptabase-tauri@1.0.0',
  sessionId: '17303125790123456',
};

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
    return { el, byId, completeWith };
  }

  it('shows the system properties and the events, newest first', async () => {
    const { byId } = await setup(
      { consent: 'granted', askNeeded: false, available: true, persisted: true },
      () =>
        Promise.resolve<AnalyticsRecent>({
          system: SYSTEM,
          events: [
            {
              time: '2026-11-03T14:02:11Z',
              name: 'connect_succeeded',
              props: { auth: 'key', duration: '1-3s' },
            },
            { time: '2026-11-03T14:01:58Z', name: 'app_started', props: { theme: 'system' } },
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
    expect(byId('analytics-event-0')?.textContent).toMatch(/\d\d:\d\d:\d\d/);
    expect(byId('analytics-event-1')?.dataset['event']).toBe('app_started');
    expect(byId('analytics-events-empty')).toBeNull();
    expect(byId('analytics-events-keyless')).toBeNull();
  });

  it('says when nothing was sent and usage data is off, in a keyless build', async () => {
    const { byId } = await setup(
      { consent: 'denied', askNeeded: false, available: false, persisted: true },
      () => Promise.resolve({ system: SYSTEM, events: [] }),
    );
    expect(byId('analytics-events')).toBeNull();
    expect(byId('analytics-events-empty')?.textContent).toContain('Nothing sent in this session.');
    expect(byId('analytics-events-empty')?.textContent).toContain('Usage data is off.');
    expect(byId('analytics-events-keyless')?.textContent).toContain(
      'This build does not send usage data.',
    );
  });

  it('formats times on the local clock and keeps an unreadable one as is', () => {
    const date = new Date(2026, 10, 3, 9, 5, 7);
    expect(localTime(date.toISOString())).toBe('09:05:07');
    expect(localTime('not a date')).toBe('not a date');
  });

  it('shows an error when the events cannot be read, and closes', async () => {
    const { byId, completeWith } = await setup(
      { consent: 'granted', askNeeded: false, available: true, persisted: true },
      () => Promise.reject(new Error('broken')),
    );
    expect(byId('analytics-events-error')).not.toBeNull();
    byId('analytics-events-close')!.click();
    expect(completeWith).toHaveBeenCalled();
  });
});
