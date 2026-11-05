import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import type { AnalyticsCategory, AnalyticsState } from '../../../core/ipc/analytics';
import { LanguageService } from '../../../core/i18n/language';
import { Settings } from '../../../core/settings/settings';
import { ThemeService } from '../../../core/theme/theme';
import { SettingsPage } from './settings-page';

@Component({
  imports: [TuiRoot, SettingsPage],
  template: '<tui-root><app-settings-page /></tui-root>',
})
class Host {}

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

describe('SettingsPage', () => {
  let state: AnalyticsState | 'fail';
  let saveFails: boolean;
  let onSave: ((category: AnalyticsCategory, granted: boolean) => unknown) | null;
  let calls: { cmd: string; args: unknown }[];
  let prefsFail: boolean;

  beforeAll(
    () => import('../../analytics/analytics-events-dialog/analytics-events-dialog'),
    60_000,
  );

  beforeEach(() => {
    localStorage.clear();
    state = stateOf(OFF, {
      pending: ['launch', 'features', 'connections', 'crashes'],
      askNeeded: true,
    });
    saveFails = false;
    prefsFail = false;
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
      if (cmd === 'set_analytics_category') {
        if (saveFails) {
          throw { code: 'io', message: 'disk full' };
        }
        const { category, granted } = args as { category: AnalyticsCategory; granted: boolean };
        if (onSave) {
          return onSave(category, granted);
        }
        const current = state === 'fail' ? stateOf(OFF) : state;
        state = stateOf({ ...current.categories, [category]: granted });
        return state;
      }
      if (cmd === 'update_app_settings') {
        if (prefsFail) {
          throw { code: 'io', message: 'disk full' };
        }
        return {
          theme: 'system',
          language: 'system',
          defaultKeyType: 'ed25519',
          terminalFontSize: 13,
          keyFolder: null,
          ...(args as { patch: object }).patch,
        };
      }
      if (cmd === 'list_keys') {
        return [];
      }
      if (cmd === 'get_external_editor') {
        return { mode: 'system', appPath: null, noticeSeen: false };
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
    const saves = () => calls.filter((c) => c.cmd === 'set_analytics_category').map((c) => c.args);

    it('shows the four categories: granted is on, unset and denied are off', async () => {
      const first = await setup();
      for (const id of ['launch', 'features', 'connections', 'crashes']) {
        const sw = first.byId<HTMLInputElement>(`settings-analytics-${id}`)!;
        expect(sw.checked).toBe(false);
        expect(sw.disabled).toBe(false);
        expect(sw.getAttribute('aria-describedby')).toBe(
          `settings-analytics-${id}-note settings-analytics-common`,
        );
      }
      expect(first.byId('settings-analytics-launch-note')?.textContent?.trim()).toBe(
        'One event when Carapace starts.',
      );
      expect(first.byId('settings-analytics-common')?.textContent).toContain(
        'Sent with every event:',
      );
      expect(first.byId('settings-analytics-never')?.textContent).toContain('Never sent:');
      expect(first.byId('settings-analytics-unavailable')).toBeNull();
      expect(first.byId('settings-analytics-dnt')).toBeNull();
      TestBed.resetTestingModule();

      state = stateOf({ launch: true, features: false, connections: true, crashes: true });
      const second = await setup();
      expect(second.byId<HTMLInputElement>('settings-analytics-launch')!.checked).toBe(true);
      expect(second.byId<HTMLInputElement>('settings-analytics-features')!.checked).toBe(false);
      expect(second.byId<HTMLInputElement>('settings-analytics-connections')!.checked).toBe(true);
      expect(second.byId<HTMLInputElement>('settings-analytics-crashes')!.checked).toBe(true);
      expect(second.byId('settings-analytics-crashes-note')?.textContent?.trim()).toBe(
        'If Carapace crashes: crash type, app area and, in its own code, the source line. No messages or paths.',
      );
    });

    it('saves the crash reports switch for that category only', async () => {
      const { fixture, byId } = await setup();
      byId<HTMLInputElement>('settings-analytics-crashes')!.click();
      await settle(fixture);
      expect(saves()).toEqual([{ category: 'crashes', granted: true }]);
      expect(byId<HTMLInputElement>('settings-analytics-crashes')!.checked).toBe(true);
    });

    it('saves each switch at once, for its own category only', async () => {
      const { fixture, byId } = await setup();
      byId<HTMLInputElement>('settings-analytics-features')!.click();
      await settle(fixture);
      byId<HTMLInputElement>('settings-analytics-launch')!.click();
      await settle(fixture);
      expect(saves()).toEqual([
        { category: 'features', granted: true },
        { category: 'launch', granted: true },
      ]);
      expect(byId<HTMLInputElement>('settings-analytics-features')!.checked).toBe(true);
      expect(byId<HTMLInputElement>('settings-analytics-launch')!.checked).toBe(true);
      expect(byId<HTMLInputElement>('settings-analytics-connections')!.checked).toBe(false);
    });

    it('reverts a grant that could not be saved', async () => {
      saveFails = true;
      const { fixture, byId } = await setup();
      byId<HTMLInputElement>('settings-analytics-connections')!.click();
      await settle(fixture);
      expect(calls.filter((c) => c.cmd === 'analytics_state').length).toBe(2);
      expect(byId<HTMLInputElement>('settings-analytics-connections')!.checked).toBe(false);
      expect(document.body.textContent).toContain('Setting not saved');
      expect(byId('settings-analytics-unsaved')).toBeNull();
    });

    it('shows a refusal kept in memory only, without the generic toast', async () => {
      state = stateOf({ launch: true, features: true, connections: false, crashes: true });
      saveFails = true;
      const { fixture, byId } = await setup();
      state = stateOf(
        { launch: true, features: false, connections: false, crashes: true },
        { persisted: false },
      );
      byId<HTMLInputElement>('settings-analytics-features')!.click();
      await settle(fixture);
      expect(byId<HTMLInputElement>('settings-analytics-features')!.checked).toBe(false);
      expect(byId<HTMLInputElement>('settings-analytics-launch')!.checked).toBe(true);
      expect(byId('settings-analytics-unsaved')?.textContent).toContain(
        'Off for this session. The setting could not be saved; Carapace will try again.',
      );
      expect(document.body.textContent).not.toContain('Disk full');
    });

    it('saves one change at a time and keeps the last choice per category', async () => {
      const pending: (() => void)[] = [];
      let saved: AnalyticsState['categories'] = OFF;
      onSave = (category, granted) =>
        new Promise((resolve) =>
          pending.push(() => {
            saved = { ...saved, [category]: granted };
            resolve(stateOf(saved));
          }),
        );
      const { fixture, byId } = await setup();
      const sw = (id: string) => byId<HTMLInputElement>(`settings-analytics-${id}`)!;
      sw('launch').click();
      await settle(fixture);
      sw('launch').click();
      await settle(fixture);
      sw('features').click();
      await settle(fixture);
      expect(saves()).toEqual([{ category: 'launch', granted: true }]);
      expect(sw('launch').checked).toBe(false);

      pending.shift()!();
      await settle(fixture);
      expect(saves()).toEqual([
        { category: 'launch', granted: true },
        { category: 'launch', granted: false },
      ]);
      expect(sw('launch').checked).toBe(false);
      expect(sw('features').checked).toBe(true);

      pending.shift()!();
      await settle(fixture);
      pending.shift()!();
      await settle(fixture);
      expect(saves().length).toBe(3);
      expect(saves()[2]).toEqual({ category: 'features', granted: true });
      expect(sw('launch').checked).toBe(false);
      expect(sw('features').checked).toBe(true);
    });

    it('turns every switch off and disables it under DO_NOT_TRACK', async () => {
      state = stateOf(
        { launch: true, features: true, connections: true, crashes: true },
        { doNotTrack: true, available: false },
      );
      const { el, byId } = await setup();
      for (const id of ['launch', 'features', 'connections', 'crashes']) {
        const sw = byId<HTMLInputElement>(`settings-analytics-${id}`)!;
        expect(sw.checked).toBe(false);
        expect(sw.disabled).toBe(true);
        expect(sw.getAttribute('aria-describedby')).toBe(
          `settings-analytics-${id}-note settings-analytics-common settings-analytics-dnt`,
        );
      }
      expect(byId('settings-analytics-dnt')?.textContent).toContain(
        'Off because DO_NOT_TRACK is set on this computer. Nothing is sent.',
      );
      const notes = Array.from(el.querySelectorAll('[tuiNotification]')).map(
        (n) => (n as HTMLElement).dataset['testid'],
      );
      expect(notes).toEqual(['settings-analytics-dnt', 'settings-analytics-unavailable']);
      // The cause is read before the disabled switches.
      const legend = byId('settings-analytics-dnt')!.closest('fieldset')!.querySelector('legend')!;
      expect(legend.textContent).toBe('Privacy');
      expect(legend.nextElementSibling).toBe(byId('settings-analytics-dnt'));
      expect(
        byId('settings-analytics-dnt')!.compareDocumentPosition(
          byId('settings-analytics-launch')!,
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it('says when the build does not send usage data', async () => {
      state = stateOf(OFF, { available: false });
      const { byId } = await setup();
      expect(byId('settings-analytics-unavailable')?.textContent).toContain(
        'This build does not send usage data. Changes are still saved.',
      );
      expect(byId<HTMLInputElement>('settings-analytics-launch')!.disabled).toBe(false);
    });

    it('disables the switches when the setting cannot be read', async () => {
      state = 'fail';
      const { byId } = await setup();
      for (const id of ['launch', 'features', 'connections', 'crashes']) {
        const sw = byId<HTMLInputElement>(`settings-analytics-${id}`)!;
        expect(sw.disabled).toBe(true);
        expect(sw.getAttribute('aria-describedby')).toBe('settings-analytics-error');
        expect(byId(`settings-analytics-${id}-note`)).toBeNull();
      }
      expect(byId('settings-analytics-common')).toBeNull();
      expect(byId('settings-analytics-error')?.textContent).toContain(
        'Could not read this setting. Restart the app.',
      );
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
    expect(radio('settings-ext-system').checked).toBe(true);
  });

  const prefSaves = () => calls.filter((c) => c.cmd === 'update_app_settings').map((c) => c.args);

  it('changes and saves the theme', async () => {
    const { fixture, radio } = await setup();
    radio('settings-theme-light').click();
    await settle(fixture);
    expect(TestBed.inject(ThemeService).mode()).toBe('light');
    expect(localStorage.getItem('carapace.theme')).toBe('light');
    expect(prefSaves()).toEqual([{ patch: { theme: 'light' } }]);
  });

  it('follows a theme changed from the header toggle', async () => {
    const { fixture, radio, settings } = await setup();
    settings.setTheme('dark');
    await fixture.whenStable();
    expect(radio('settings-theme-dark').checked).toBe(true);
  });

  describe('language', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      document.documentElement.lang = 'en';
    });

    const label = (el: HTMLElement, id: string) =>
      el.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

    it('sits right after Theme with the three options', async () => {
      const { el } = await setup();
      const group = label(el, 'settings-language');
      expect(group.tagName).toBe('FIELDSET');
      expect(group.querySelector('legend')?.textContent?.trim()).toBe('Language');
      expect(group.previousElementSibling?.querySelector('legend')?.textContent?.trim()).toBe(
        'Theme',
      );
      const texts = ['system', 'en', 'fr'].map((v) => {
        const option = label(el, `settings-language-${v}`);
        return [option.textContent?.trim(), option.getAttribute('lang')];
      });
      expect(texts).toEqual([
        ['System (English)', 'en'],
        ['English', 'en'],
        ['Français', 'fr'],
      ]);
      expect(group.textContent).toContain('System follows the language of the operating system.');
    });

    it('switches the page to French at once and saves the preference', async () => {
      const { fixture, el, radio } = await setup();
      expect(radio('settings-language-system').checked).toBe(true);
      radio('settings-language-fr').click();
      await settle(fixture);
      expect(prefSaves()).toEqual([{ patch: { language: 'fr' } }]);
      expect(localStorage.getItem('carapace.language')).toBe('fr');
      expect(document.documentElement.lang).toBe('fr');
      expect(radio('settings-language-fr').checked).toBe(true);
      expect(label(el, 'settings-language').querySelector('legend')?.textContent?.trim()).toBe(
        'Langue',
      );
      expect(label(el, 'settings-theme-light').textContent?.trim()).toBe('Clair');
      expect(label(el, 'settings-language-system').textContent?.trim()).toBe('Système (English)');
      expect(label(el, 'settings-language-system').getAttribute('lang')).toBe('fr');
      expect(label(el, 'settings-language-en').textContent?.trim()).toBe('English');
    });

    it('names the system language as the OS reports it', async () => {
      vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-FR']);
      const { el } = await setup();
      expect(label(el, 'settings-language-system').textContent?.trim()).toBe('Système (Français)');
    });

    it('shows the previous language again when the save fails', async () => {
      prefsFail = true;
      const { fixture, radio } = await setup();
      radio('settings-language-fr').click();
      await settle(fixture);
      expect(TestBed.inject(LanguageService).preference()).toBe('system');
      expect(radio('settings-language-system').checked).toBe(true);
      expect(document.documentElement.lang).toBe('en');
      expect(document.body.textContent).toContain('Setting not saved');
    });
  });

  it('changes and saves the default key type', async () => {
    const { fixture, radio, settings } = await setup();
    radio('settings-key-type-rsa4096').click();
    await settle(fixture);
    expect(settings.defaultKeyType()).toBe('rsa4096');
    expect(prefSaves()).toEqual([{ patch: { defaultKeyType: 'rsa4096' } }]);
  });

  it('shows the previous key type again and a toast when the save fails', async () => {
    prefsFail = true;
    const { fixture, radio, settings } = await setup();
    radio('settings-key-type-rsa4096').click();
    await settle(fixture);
    expect(settings.defaultKeyType()).toBe('ed25519');
    expect(radio('settings-key-type-ed25519').checked).toBe(true);
    expect(document.body.textContent).toContain('Setting not saved');
  });

  it('changes the terminal font size within the range', async () => {
    const { fixture, fontSize, settings } = await setup();
    expect(fontSize.getAttribute('aria-describedby')).toBe('settings-font-size-hint');
    fontSize.value = '18';
    fontSize.dispatchEvent(new Event('input'));
    fontSize.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(settings.terminalFontSize()).toBe(18);
    await settle(fixture);
    expect(prefSaves()).toEqual([{ patch: { terminalFontSize: 18 } }]);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="settings-font-size-value"]',
      )?.textContent,
    ).toContain('18 px');
  });
});
