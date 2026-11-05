import { TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { Analytics, type AnalyticsRecent, type AnalyticsState } from './analytics';
import { IpcError } from './ipc-error';

const OFF = { launch: false, features: false, connections: false, crashes: false };

describe('Analytics', () => {
  let service: Analytics;
  let calls: { cmd: string; args: unknown }[];
  let onCall: (cmd: string, args: unknown) => unknown;

  const unset: AnalyticsState = {
    categories: OFF,
    pending: ['launch', 'features', 'connections', 'crashes'],
    doNotTrack: false,
    askNeeded: true,
    available: false,
    persisted: true,
  };
  const answered = (
    categories: AnalyticsState['categories'],
    persisted = true,
  ): AnalyticsState => ({
    categories,
    pending: [],
    doNotTrack: false,
    askNeeded: false,
    available: true,
    persisted,
  });

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

  it('saves the four choices at once and keeps the returned state', async () => {
    const choices = { launch: true, features: false, connections: true, crashes: false };
    const saved = answered(choices);
    onCall = () => saved;
    expect(await service.setChoices(choices)).toEqual(saved);
    expect(service.current()).toEqual(saved);
    expect(calls).toEqual([{ cmd: 'set_analytics_choices', args: { choices } }]);
  });

  it('saves one category and keeps the returned state', async () => {
    const saved = answered({
      launch: true,
      features: true,
      connections: false,
      crashes: true,
    });
    onCall = () => saved;
    expect(await service.setCategory('features', true)).toEqual(saved);
    expect(service.current()).toEqual(saved);
    expect(calls).toEqual([
      { cmd: 'set_analytics_category', args: { category: 'features', granted: true } },
    ]);
  });

  it('reads the state again when saving fails, then rethrows', async () => {
    let applied: AnalyticsState = unset;
    onCall = (cmd) => {
      if (cmd === 'set_analytics_category') {
        applied = answered(OFF, false);
        throw { code: 'io', message: 'disk full' };
      }
      return applied;
    };
    await service.state();
    await expect(service.setCategory('launch', false)).rejects.toBeInstanceOf(IpcError);
    expect(service.current()).toEqual(applied);
    expect(calls.map((c) => c.cmd)).toEqual([
      'analytics_state',
      'set_analytics_category',
      'analytics_state',
    ]);
  });

  it('keeps the last state when saving and reading both fail', async () => {
    onCall = () => unset;
    await service.state();
    onCall = () => {
      throw { code: 'io', message: 'broken' };
    };
    await expect(
      service.setChoices({ launch: true, features: true, connections: true, crashes: true }),
    ).rejects.toBeInstanceOf(IpcError);
    expect(service.current()).toEqual(unset);
  });

  it('reads the recent events', async () => {
    const recent: AnalyticsRecent = {
      system: {
        appVersion: '0.4.0',
        os: 'Windows',
        osVersion: '11',
        locale: 'fr-FR',
        sdkVersion: 'carapace@0.4.0',
        sessionId: '0b0e7c2e-5d0f-4f3c-9a51-2a7f0c6f1d11',
      },
      events: [
        { time: '2026-11-03T10:00:01Z', name: 'app_started', props: { theme: 'dark' } },
        { time: '2026-11-03T10:00:00Z', name: 'session_started', props: {} },
        {
          time: '2026-11-02T09:58:40Z',
          name: 'crash',
          props: { type: 'panic:tauri', kind: 'crash', severity: 'fatal' },
          previousLaunch: true,
        },
      ],
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
