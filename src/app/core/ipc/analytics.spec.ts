import { TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { Analytics, type AnalyticsRecent, type AnalyticsState } from './analytics';
import { IpcError } from './ipc-error';

describe('Analytics', () => {
  let service: Analytics;
  let calls: { cmd: string; args: unknown }[];
  let onCall: (cmd: string, args: unknown) => unknown;

  const unset: AnalyticsState = {
    consent: 'unset',
    askNeeded: true,
    available: false,
    persisted: true,
  };

  beforeEach(() => {
    calls = [];
    onCall = () => null;
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      return onCall(cmd, args);
    });
    service = TestBed.inject(Analytics);
  });

  afterEach(() => clearMocks());

  it('reads the state and keeps it', async () => {
    onCall = () => unset;
    expect(service.current()).toBeNull();
    expect(await service.state()).toEqual(unset);
    expect(service.current()).toEqual(unset);
    expect(calls).toEqual([{ cmd: 'analytics_state', args: {} }]);
  });

  it('saves the consent and keeps the returned state', async () => {
    const granted: AnalyticsState = {
      consent: 'granted',
      askNeeded: false,
      available: true,
      persisted: true,
    };
    onCall = () => granted;
    expect(await service.setConsent(true)).toEqual(granted);
    expect(service.current()).toEqual(granted);
    expect(calls).toEqual([{ cmd: 'set_analytics_consent', args: { granted: true } }]);
  });

  it('reads the state again when saving fails, then rethrows', async () => {
    let applied: AnalyticsState = unset;
    onCall = (cmd) => {
      if (cmd === 'set_analytics_consent') {
        applied = { consent: 'denied', askNeeded: false, available: false, persisted: false };
        throw { code: 'io', message: 'disk full' };
      }
      return applied;
    };
    await service.state();
    await expect(service.setConsent(false)).rejects.toBeInstanceOf(IpcError);
    expect(service.current()).toEqual(applied);
    expect(calls.map((c) => c.cmd)).toEqual([
      'analytics_state',
      'set_analytics_consent',
      'analytics_state',
    ]);
  });

  it('keeps the last state when saving and reading both fail', async () => {
    onCall = () => unset;
    await service.state();
    onCall = () => {
      throw { code: 'io', message: 'broken' };
    };
    await expect(service.setConsent(true)).rejects.toBeInstanceOf(IpcError);
    expect(service.current()).toEqual(unset);
  });

  it('reads the recent events', async () => {
    const recent: AnalyticsRecent = {
      system: {
        appVersion: '0.4.0',
        os: 'Windows',
        osVersion: '11',
        locale: 'fr-FR',
        sdkVersion: 'aptabase-tauri@1.0.0',
        sessionId: '17303125790123456',
      },
      events: [{ time: '2026-11-03T10:00:00Z', name: 'app_started', props: { theme: 'dark' } }],
    };
    onCall = () => recent;
    expect(await service.recent()).toEqual(recent);
    expect(calls[0].cmd).toBe('analytics_recent');
  });

  it('reports the start with the theme setting and opens the privacy page', async () => {
    await service.appStarted('system');
    await service.openPrivacyPage();
    expect(calls).toEqual([
      { cmd: 'analytics_app_started', args: { theme: 'system' } },
      { cmd: 'open_privacy_page', args: {} },
    ]);
  });
});
