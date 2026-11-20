import { signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga } from '@taiga-ui/core';
import { IpcError } from '../../../core/ipc/ipc-error';
import type { UpdateState } from '../../../core/ipc/updates';
import { type RestartImpact, UpdateFlow } from '../../updates/update-flow';
import { UpdateStore } from '../../updates/update-store';
import { lastCheckedText, UpdateSettings } from './update-settings';

const STATE: UpdateState = {
  current: '0.2.0',
  autoCheck: true,
  skippedVersion: null,
  lastCheck: null,
  available: null,
  downloaded: false,
  installKind: 'inPlace',
};

describe('UpdateSettings', () => {
  let fixture: ComponentFixture<UpdateSettings>;
  let store: UpdateStore;
  let saved: boolean;
  const flow = {
    impact: signal<RestartImpact>({ connections: 1, transfers: 0, dialog: false }),
    windows: false,
    start: vi.fn(() => Promise.resolve()),
    check: vi.fn(() => Promise.resolve()),
    setAutoCheck: vi.fn(() => Promise.resolve(saved)),
    update: vi.fn(),
    skip: vi.fn(),
    cancel: vi.fn(),
    restartNow: vi.fn(),
    openReleasePage: vi.fn(),
  };
  const el = () => fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement = HTMLElement>(id: string) =>
    el().querySelector<T>(`[data-testid="${id}"]`);
  const text = (id: string) => q(id)?.textContent?.replace(/\s+/g, ' ').trim();
  const settle = () => new Promise((r) => setTimeout(r));

  beforeEach(async () => {
    vi.clearAllMocks();
    saved = true;
    await TestBed.configureTestingModule({
      imports: [UpdateSettings],
      providers: [provideTaiga(), { provide: UpdateFlow, useValue: flow }],
    }).compileComponents();
    store = TestBed.inject(UpdateStore);
    fixture = TestBed.createComponent(UpdateSettings);
    await fixture.whenStable();
  });

  async function show(patch: Partial<UpdateState> = {}): Promise<void> {
    store.state.set({ ...STATE, ...patch });
    await fixture.whenStable();
  }

  function offer(phase: NonNullable<ReturnType<UpdateStore['phase']>> = 'available'): void {
    store.offer.set({ version: '0.3.0', date: null });
    store.phase.set(phase);
  }

  it('starts the flow; the switch waits for the state', async () => {
    expect(flow.start).toHaveBeenCalled();
    expect(q<HTMLInputElement>('settings-updates-auto')!.disabled).toBe(true);
    await show();
    const auto = q<HTMLInputElement>('settings-updates-auto')!;
    expect(auto.disabled).toBe(false);
    expect(auto.checked).toBe(true);
    expect(auto.getAttribute('aria-describedby')).toBe('settings-updates-auto-note');
    expect(text('settings-updates-version')).toBe('Carapace 0.2.0');
    expect(q('settings-updates')!.id).toBe('settings-updates');
  });

  it('saves the switch; a failed save shows the stored value again', async () => {
    await show();
    const auto = q<HTMLInputElement>('settings-updates-auto')!;
    auto.click();
    await settle();
    expect(flow.setAutoCheck).toHaveBeenCalledWith(false);
    saved = false;
    store.state.set({ ...STATE, autoCheck: false });
    await fixture.whenStable();
    auto.click();
    await settle();
    await fixture.whenStable();
    expect(flow.setAutoCheck).toHaveBeenLastCalledWith(true);
    expect(auto.checked).toBe(false);
  });

  it('Check now: loading, then up to date with the last check time', async () => {
    await show();
    q('settings-updates-check')!.click();
    expect(flow.check).toHaveBeenCalledOnce();
    store.check.set('checking');
    await fixture.whenStable();
    expect(q('settings-updates-status')!.dataset['state']).toBe('checking');
    expect(text('settings-updates-status')).toBe('Checking…');
    store.check.set('upToDate');
    await show({ lastCheck: new Date().toISOString() });
    expect(q('settings-updates-status')!.dataset['state']).toBe('upToDate');
    expect(text('settings-updates-status')).toContain('Carapace is up to date.');
    expect(text('settings-updates-last-checked')).toMatch(/^Last checked: /);
  });

  it('Check now is disabled with a reason while an update runs', async () => {
    await show();
    offer('downloading');
    await fixture.whenStable();
    const check = q('settings-updates-check')!;
    expect(check.getAttribute('aria-disabled')).toBe('true');
    check.click();
    expect(flow.check).not.toHaveBeenCalled();
  });

  it('offer: Update and Skip; a skipped version reads as skipped', async () => {
    await show();
    offer();
    await fixture.whenStable();
    expect(q('settings-updates-offer')!.dataset['phase']).toBe('available');
    q('settings-updates-install')!.click();
    q('settings-updates-skip')!.click();
    expect(flow.update).toHaveBeenCalled();
    expect(flow.skip).toHaveBeenCalled();
    await show({ skippedVersion: '0.3.0' });
    expect(q('settings-updates-skip')).toBeNull();
    expect(text('settings-updates-skipped')).toBe(
      'You skipped this version. It is not announced again.',
    );
    expect(q('settings-updates-install')).not.toBeNull();
  });

  it('download-only offers Download', async () => {
    await show({ installKind: 'downloadOnly' });
    offer();
    await fixture.whenStable();
    expect(q('settings-updates-install')).toBeNull();
    q('settings-updates-download')!.click();
    expect(flow.update).toHaveBeenCalled();
  });

  it('downloading shows progress and Cancel; ready shows the impact and Restart now', async () => {
    await show();
    offer('downloading');
    store.progress.set({ downloaded: 10, total: 100 });
    await fixture.whenStable();
    expect(q('settings-updates-progress')).not.toBeNull();
    q('settings-updates-cancel')!.click();
    expect(flow.cancel).toHaveBeenCalled();
    store.phase.set('ready');
    await fixture.whenStable();
    expect(el().querySelector('[data-impact="connections"]')!.textContent).toContain(
      '1 open connection and its terminals will be closed.',
    );
    q('settings-updates-restart')!.click();
    expect(flow.restartNow).toHaveBeenCalled();
  });

  it('errors are inline; a download error keeps the offer, a refusal replaces it', async () => {
    await show();
    store.failure.set({ kind: 'check', error: new IpcError('network', 'could not reach it') });
    await fixture.whenStable();
    expect(q('settings-updates-error')!.dataset['kind']).toBe('check');
    expect(text('settings-updates-error')).toContain('Could not check for updates');
    offer();
    store.failure.set({ kind: 'download', error: new IpcError('network', 'offline') });
    await fixture.whenStable();
    expect(q('settings-updates-error')!.dataset['kind']).toBe('download');
    expect(q('settings-updates-offer')).not.toBeNull();
    store.failure.set({ kind: 'signature', error: null });
    await fixture.whenStable();
    expect(text('settings-updates-error')).toContain('Update refused');
    expect(q('settings-updates-offer')).toBeNull();
  });

  it('an unsupported build says so and disables Check now', async () => {
    await show();
    store.unsupported.set(true);
    await fixture.whenStable();
    expect(text('settings-updates-unavailable')).toBe('This build does not check for updates.');
    expect(q('settings-updates-check')!.getAttribute('aria-disabled')).toBe('true');
  });

  it('formats the last check as a time today, a date and time otherwise', () => {
    const now = new Date('2026-11-20T15:00:00');
    expect(lastCheckedText(new Date('2026-11-20T14:03:00').toISOString(), 'en-GB', now)).toBe(
      '14:03',
    );
    expect(lastCheckedText(new Date('2026-11-03T14:03:00').toISOString(), 'en-GB', now)).toBe(
      '3 Nov, 14:03',
    );
  });
});
