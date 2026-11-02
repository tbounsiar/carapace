import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTaiga } from '@taiga-ui/core';
import { App } from './app';
import { ConfigService } from './core/ipc/config';
import { ThemeService } from './core/theme/theme';

describe('App', () => {
  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([]),
        provideTaiga(),
        {
          provide: ConfigService,
          useValue: { projects: signal([]), loading: signal(false), load: () => Promise.resolve() },
        },
      ],
    }).compileComponents();
  });

  it('renders the navigation header, sidebar tree and router outlet inside tui-root', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('tui-root header[tuiNavigationHeader]')?.textContent).toContain(
      'Carapace',
    );
    expect(el.querySelector('tui-root aside app-project-tree')).not.toBeNull();
    expect(el.querySelector('tui-root main router-outlet')).not.toBeNull();
  });

  it('changes the theme mode from the toggle', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('button[aria-label="Dark theme"]')!.click();
    await fixture.whenStable();
    expect(TestBed.inject(ThemeService).mode()).toBe('dark');
    expect(el.querySelector('tui-root')?.getAttribute('tuiTheme')).toBe('dark');
  });

  it('re-themes the navigation header and aside with the app theme', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('[data-testid="theme-light"]')!.click();
    await fixture.whenStable();
    expect(el.querySelector('header[tuiNavigationHeader]')?.getAttribute('tuiTheme')).toBe('light');
    expect(el.querySelector('aside[tuiNavigationAside]')?.getAttribute('tuiTheme')).toBe('light');
    expect(el.querySelector('[data-testid="theme-toggle"]')).not.toBeNull();
  });
});
