import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import { ThemeService } from '../../../core/theme/theme';
import { ThemeMenu } from './theme-menu';
import { TranslocoService } from '@jsverse/transloco';

@Component({
  imports: [ThemeMenu, TuiRoot],
  template: '<tui-root><app-theme-menu /></tui-root>',
})
class Host {}

describe('ThemeMenu', () => {
  const byId = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`);

  let saves: unknown[];
  let fail: boolean;

  beforeEach(() => {
    localStorage.clear();
    saves = [];
    fail = false;
    mockIPC((cmd, args) => {
      if (cmd !== 'update_app_settings') {
        return null;
      }
      if (fail) {
        throw { code: 'io', message: 'disk full' };
      }
      const { patch } = args as { patch: object };
      saves.push(patch);
      return {
        theme: 'system',
        defaultKeyType: 'ed25519',
        terminalFontSize: 13,
        keyFolder: null,
        ...patch,
      };
    });
    TestBed.configureTestingModule({ providers: [provideTaiga()] });
  });

  afterEach(() => clearMocks());

  const settle = async (fixture: { whenStable(): Promise<unknown> }) => {
    for (let i = 0; i < 3; i++) {
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r));
    }
  };

  it('shows the current mode and changes it from the menu', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const toggle = byId('theme-toggle')!;
    expect(toggle.getAttribute('aria-label')).toBe('Theme: System');

    toggle.click();
    await fixture.whenStable();
    expect(byId('theme-system')?.getAttribute('aria-checked')).toBe('true');
    byId('theme-dark')!.click();
    await fixture.whenStable();

    expect(TestBed.inject(ThemeService).mode()).toBe('dark');
    expect(toggle.getAttribute('aria-label')).toBe('Theme: Dark');
    expect(byId('theme-dark')).toBeNull();
    await settle(fixture);
    expect(saves).toEqual([{ theme: 'dark' }]);
    expect(localStorage.getItem('carapace.theme')).toBe('dark');
  });

  it('goes back to the saved mode when the save fails', async () => {
    fail = true;
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    byId('theme-toggle')!.click();
    await fixture.whenStable();
    byId('theme-light')!.click();
    await settle(fixture);
    expect(TestBed.inject(ThemeService).mode()).toBe('system');
    expect(byId('theme-toggle')?.getAttribute('aria-label')).toBe('Theme: System');
    expect(document.body.textContent).toContain('Setting not saved');
  });

  it('reads in French', async () => {
    const fixture = TestBed.createComponent(Host);
    TestBed.inject(TranslocoService).setActiveLang('fr');
    await fixture.whenStable();
    expect(byId('theme-toggle')?.getAttribute('aria-label')).toBe('Thème : Système');
    byId('theme-toggle')!.click();
    await fixture.whenStable();
    expect(byId('theme-dark')?.textContent?.trim()).toBe('Sombre');
  });
});
