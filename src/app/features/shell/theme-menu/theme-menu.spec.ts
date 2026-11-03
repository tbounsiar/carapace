import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import { ThemeService } from '../../../core/theme/theme';
import { ThemeMenu } from './theme-menu';

@Component({
  imports: [ThemeMenu, TuiRoot],
  template: '<tui-root><app-theme-menu /></tui-root>',
})
class Host {}

describe('ThemeMenu', () => {
  const byId = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`);

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideTaiga()] });
  });

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
  });
});
