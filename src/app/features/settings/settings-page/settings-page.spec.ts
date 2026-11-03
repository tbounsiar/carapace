import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import type { AnalyticsState } from '../../../core/ipc/analytics';
import { Settings } from '../../../core/settings/settings';
import { ThemeService } from '../../../core/theme/theme';
import { SettingsPage } from './settings-page';

@Component({
  imports: [TuiRoot, SettingsPage],
  template: '<tui-root><app-settings-page /></tui-root>',
})
class Host {}

describe('SettingsPage', () => {
  let state: AnalyticsState | 'fail';
  let saveFails: boolean;
  let onSave: ((granted: boolean) => unknown) | null;
  let calls: { cmd: string; args: unknown }[];

  beforeAll(
    () => import('../../analytics/analytics-events-dialog/analytics-events-dialog'),
    60_000,
  );

  beforeEach(() => {
    localStorage.clear();
    state = { consent: 'unset', askNeeded: true, available: true, persisted: true };
    saveFails = false;
    onSave = null;
    calls = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'analytics_state') {
        if (state === 'fail') {
          throw { code: 'io', message: 'broken' };
        }
        return state;
      }
      if (cmd === 'set_analytics_consent') {
        if (saveFails) {
          throw { code: 'io', message: 'disk full' };
        }
        const granted = (args as { granted: boolean }).granted;
        if (onSave) {
          return onSave(granted);
        }
        return {
          consent: granted ? 'granted' : 'denied',
          askNeeded: false,
          available: true,
          persisted: true,
        };
      }
      if (cmd === 'analytics_recent') {
        return {
          system: {
            appVersion: '0.4.0',
            os: 'Windows',
            osVersion: '11',
            locale: 'fr-FR',
            sdkVersion: 'aptabase-tauri@1.0.0',
            sessionId: '17303125790123456',
          },
          events: [],
        };
      }
      return null;
    });
  });

  afterEach(() => clearMocks());

  const settle = async (fixture: { whenStable(): Promise<unknown> }): Promise<void> => {
    for (let i = 0; i < 3; i++) {
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r));
    }
  };

  async function setup() {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideTaiga()],
    }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const radio = (id: string) =>
      el.querySelector<HTMLInputElement>(`[data-testid="${id}"] input[type="radio"]`)!;
    const fontSize = el.querySelector<HTMLInputElement>('[data-testid="settings-font-size"]')!;
    const byId = <T extends HTMLElement = HTMLElement>(id: string) =>
      document.body.querySelector<T>(`[data-testid="${id}"]`);
    return { fixture, el, radio, fontSize, byId, settings: TestBed.inject(Settings) };
  }

  describe('privacy', () => {
    it('shows the consent: unset and denied are off, granted is on', async () => {
      const first = await setup();
      const sw = first.byId<HTMLInputElement>('settings-analytics')!;
      expect(sw.checked).toBe(false);
      expect(sw.disabled).toBe(false);
      expect(sw.getAttribute('aria-describedby')).toBe('settings-analytics-note');
      expect(first.byId('settings-analytics-note')?.textContent).toContain('No install ID');
      expect(first.byId('settings-analytics-unavailable')).toBeNull();
      TestBed.resetTestingModule();

      state = { consent: 'granted', askNeeded: false, available: true, persisted: true };
      const second = await setup();
      expect(second.byId<HTMLInputElement>('settings-analytics')!.checked).toBe(true);
    });

    it('saves the switch at once', async () => {
      const { fixture, byId } = await setup();
      byId<HTMLInputElement>('settings-analytics')!.click();
      await settle(fixture);
      expect(calls.filter((c) => c.cmd === 'set_analytics_consent')).toEqual([
        { cmd: 'set_analytics_consent', args: { granted: true } },
      ]);
      expect(byId<HTMLInputElement>('settings-analytics')!.checked).toBe(true);
    });

    it('shows the state the backend applies when saving fails', async () => {
      saveFails = true;
      const { fixture, byId } = await setup();
      state = { consent: 'unset', askNeeded: true, available: true, persisted: true };
      byId<HTMLInputElement>('settings-analytics')!.click();
      await settle(fixture);
      expect(calls.filter((c) => c.cmd === 'analytics_state').length).toBe(2);
      expect(byId<HTMLInputElement>('settings-analytics')!.checked).toBe(false);
      expect(document.body.textContent).toContain('Setting not saved');
      expect(byId('settings-analytics-unsaved')).toBeNull();
    });

    it('shows a refusal kept in memory only, without the generic toast', async () => {
      state = { consent: 'granted', askNeeded: false, available: true, persisted: true };
      saveFails = true;
      const { fixture, byId } = await setup();
      state = { consent: 'denied', askNeeded: false, available: true, persisted: false };
      byId<HTMLInputElement>('settings-analytics')!.click();
      await settle(fixture);
      expect(byId<HTMLInputElement>('settings-analytics')!.checked).toBe(false);
      expect(byId('settings-analytics-unsaved')?.textContent).toContain(
        'Off for this session. The setting could not be saved; Carapace will try again.',
      );
      expect(document.body.textContent).not.toContain('Disk full');
    });

    it('saves one change at a time and keeps the last choice', async () => {
      const pending: (() => void)[] = [];
      onSave = (granted) =>
        new Promise((resolve) =>
          pending.push(() =>
            resolve({
              consent: granted ? 'granted' : 'denied',
              askNeeded: false,
              available: true,
              persisted: true,
            }),
          ),
        );
      const { fixture, byId } = await setup();
      const sw = () => byId<HTMLInputElement>('settings-analytics')!;
      const saves = () => calls.filter((c) => c.cmd === 'set_analytics_consent').map((c) => c.args);
      sw().click();
      await settle(fixture);
      sw().click();
      await settle(fixture);
      expect(saves()).toEqual([{ granted: true }]);
      expect(sw().checked).toBe(false);

      pending.shift()!();
      await settle(fixture);
      expect(saves()).toEqual([{ granted: true }, { granted: false }]);
      expect(sw().checked).toBe(false);

      pending.shift()!();
      await settle(fixture);
      expect(sw().checked).toBe(false);
      expect(saves().length).toBe(2);
    });

    it('says when the build does not send usage data', async () => {
      state = { consent: 'denied', askNeeded: false, available: false, persisted: true };
      const { byId } = await setup();
      expect(byId('settings-analytics-unavailable')?.textContent).toContain(
        'This build does not send usage data. Changes are still saved.',
      );
      expect(byId<HTMLInputElement>('settings-analytics')!.disabled).toBe(false);
    });

    it('disables the switch when the setting cannot be read', async () => {
      state = 'fail';
      const { byId } = await setup();
      const sw = byId<HTMLInputElement>('settings-analytics')!;
      expect(sw.disabled).toBe(true);
      expect(byId('settings-analytics-note')).toBeNull();
      expect(byId('settings-analytics-error')?.textContent).toContain(
        'Could not read this setting. Restart the app.',
      );
      expect(sw.getAttribute('aria-describedby')).toBe('settings-analytics-error');
    });

    it('opens the privacy page through the backend', async () => {
      const { fixture, byId } = await setup();
      byId('settings-privacy-link')!.click();
      await settle(fixture);
      expect(calls.some((c) => c.cmd === 'open_privacy_page')).toBe(true);
    });

    it('opens the recent events dialog', async () => {
      const { fixture, byId } = await setup();
      byId('settings-analytics-events')!.click();
      await settle(fixture);
      expect(document.body.querySelector('tui-dialog')?.textContent).toContain(
        'Recent usage events',
      );
      expect(byId('analytics-events-empty')).not.toBeNull();
    });
  });

  it('shows the current preferences', async () => {
    localStorage.setItem('carapace.theme', 'dark');
    localStorage.setItem('carapace.keyType', 'rsa4096');
    localStorage.setItem('carapace.terminalFontSize', '16');
    const { radio, fontSize } = await setup();
    expect(radio('settings-theme-dark').checked).toBe(true);
    expect(radio('settings-theme-system').checked).toBe(false);
    expect(radio('settings-key-type-rsa4096').checked).toBe(true);
    expect(fontSize.value).toBe('16');
    expect(fontSize.getAttribute('aria-valuetext')).toBe('16 pixels');
  });

  it('changes the theme through the theme service', async () => {
    const { fixture, radio } = await setup();
    radio('settings-theme-light').click();
    await fixture.whenStable();
    expect(TestBed.inject(ThemeService).mode()).toBe('light');
    expect(localStorage.getItem('carapace.theme')).toBe('light');
  });

  it('follows a theme changed from the header toggle', async () => {
    const { fixture, radio } = await setup();
    TestBed.inject(ThemeService).setMode('dark');
    await fixture.whenStable();
    expect(radio('settings-theme-dark').checked).toBe(true);
  });

  it('changes the default key type', async () => {
    const { fixture, radio, settings } = await setup();
    radio('settings-key-type-rsa4096').click();
    await fixture.whenStable();
    expect(settings.defaultKeyType()).toBe('rsa4096');
    expect(localStorage.getItem('carapace.keyType')).toBe('rsa4096');
  });

  it('changes the terminal font size within the range', async () => {
    const { fixture, fontSize, settings } = await setup();
    expect(fontSize.getAttribute('aria-describedby')).toBe('settings-font-size-hint');
    fontSize.value = '18';
    fontSize.dispatchEvent(new Event('input'));
    fontSize.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(settings.terminalFontSize()).toBe(18);
    expect(localStorage.getItem('carapace.terminalFontSize')).toBe('18');
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="settings-font-size-value"]',
      )?.textContent,
    ).toContain('18 px');
  });
});
