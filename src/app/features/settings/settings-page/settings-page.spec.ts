import { TestBed } from '@angular/core/testing';
import { provideTaiga } from '@taiga-ui/core';
import { Settings } from '../../../core/settings/settings';
import { ThemeService } from '../../../core/theme/theme';
import { SettingsPage } from './settings-page';

describe('SettingsPage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  async function setup() {
    await TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [provideTaiga()],
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsPage);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const radio = (id: string) =>
      el.querySelector<HTMLInputElement>(`[data-testid="${id}"] input[type="radio"]`)!;
    const fontSize = el.querySelector<HTMLInputElement>('[data-testid="settings-font-size"]')!;
    return { fixture, el, radio, fontSize, settings: TestBed.inject(Settings) };
  }

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
