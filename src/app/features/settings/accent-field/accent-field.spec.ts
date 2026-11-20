import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import { Settings } from '../../../core/settings/settings';
import { ThemeService } from '../../../core/theme/theme';
import { AccentField } from './accent-field';

@Component({
  imports: [AccentField, TuiRoot],
  template: '<tui-root><app-accent-field /></tui-root>',
})
class Host {}

describe('AccentField', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('style');
    mockIPC((cmd, args) =>
      cmd === 'update_app_settings' ? (args as { patch: object }).patch : null,
    );
    TestBed.configureTestingModule({ providers: [provideTaiga()] });
  });

  afterEach(() => clearMocks());

  const byId = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.body.querySelector<T>(`[data-testid="${id}"]`);

  async function render() {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    return fixture;
  }

  it('prefills the dark accent of the set in dark mode and offers the four set accents', async () => {
    localStorage.setItem('carapace.theme', 'dark');
    localStorage.setItem('carapace.palette', 'plum');
    await render();
    expect(byId<HTMLInputElement>('settings-accent-input')?.value).toBe('#c49bff');
    const options = [...document.querySelectorAll('#settings-accent-colors option')].map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(options).toEqual(['#8aa2ff', '#9fb4ff', '#5cc8e6', '#c49bff']);
  });

  it('names both variants when the pick is adjusted in both', async () => {
    localStorage.setItem('carapace.accent', '#808080');
    await render();
    expect(byId('settings-accent-adjusted')?.textContent?.trim()).toBe(
      'Made darker in light mode and lighter in dark mode so text stays readable.',
    );
  });

  it('re-derives the applied colors when the set changes', async () => {
    localStorage.setItem('carapace.accent', '#000000');
    const fixture = await render();
    expect(byId('settings-accent-adjusted')?.textContent?.trim()).toBe(
      'Made lighter in dark mode so text stays readable.',
    );
    const before = byId('settings-accent-applied')?.textContent;
    TestBed.inject(Settings).setPalette('high-contrast');
    await fixture.whenStable();
    expect(byId('settings-accent-applied')?.textContent).not.toBe(before);
    const dark = TestBed.inject(ThemeService).accentColors()?.dark.accent;
    expect(byId('settings-accent-applied')?.textContent).toContain(dark);
  });
});
