import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { TuiThemeColorService } from '@taiga-ui/addon-mobile';
import { provideTaiga } from '@taiga-ui/core';
import { signal } from '@angular/core';
import { App } from './app';
import { ConfigService } from './core/ipc/config';
import { fakeConfig, project } from './core/ipc/config.fixture';
import { SshService } from './core/ipc/ssh';
import { ThemeService } from './core/theme/theme';

@Component({ template: '' })
class Blank {}

describe('App', () => {
  let config: ReturnType<typeof fakeConfig>;

  const el = (): HTMLElement => document.body;
  const byId = (id: string): HTMLElement | null => el().querySelector(`[data-testid="${id}"]`);

  async function setup() {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    return fixture;
  }

  beforeEach(async () => {
    localStorage.clear();
    config = fakeConfig();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([
          { path: '', component: Blank },
          { path: 'projects/:projectId', component: Blank },
          { path: '**', component: Blank },
        ]),
        provideTaiga(),
        { provide: ConfigService, useValue: config },
        {
          provide: SshService,
          useValue: { states: signal({}), loadConnections: () => Promise.resolve([]) },
        },
      ],
    }).compileComponents();
  });

  it('lays out the full navigation: header, aside header/tree/footer and main subheader', async () => {
    await setup();
    expect(el().querySelector('header[tuiNavigationHeader]')?.textContent).toContain('Carapace');
    expect(
      el().querySelector('aside[tuiNavigationAside] > header app-aside-header'),
    ).not.toBeNull();
    expect(el().querySelector('aside[tuiNavigationAside] app-sidebar-tree')).not.toBeNull();
    expect(
      el().querySelector('main[tuiNavigationMain] nav[tuiSubheader] app-location-bar'),
    ).not.toBeNull();
    expect(el().querySelector('main[tuiNavigationMain] router-outlet')).not.toBeNull();
    expect(byId('project-select')?.textContent?.trim()).toBe('Home');
    expect(byId('env-select')).toBeNull();
  });

  it('re-themes the header and aside with the app theme and sets the chrome colour', async () => {
    const color = TestBed.inject(TuiThemeColorService);
    const fixture = await setup();
    TestBed.inject(ThemeService).setMode('light');
    await fixture.whenStable();
    expect(el().querySelector('header[tuiNavigationHeader]')?.getAttribute('tuiTheme')).toBe(
      'light',
    );
    expect(el().querySelector('aside[tuiNavigationAside]')?.getAttribute('tuiTheme')).toBe('light');
    expect(el().querySelector('tui-root')?.getAttribute('tuiTheme')).toBe('light');
    expect(typeof color.color).toBe('string');
  });

  it('shows the environment item only inside a project', async () => {
    config.projects.set([project('p1', 'Shop')]);
    const fixture = await setup();
    await TestBed.inject(Router).navigateByUrl('/projects/p1');
    await fixture.whenStable();
    expect(byId('project-select')?.textContent?.trim()).toBe('Shop');
    expect(byId('env-select')?.textContent?.trim()).toBe('No environment');
    expect(byId('aside-project')?.textContent).toContain('Shop');
  });

  it('links the global pages from the aside footer', async () => {
    await setup();
    const footer = el().querySelector('aside footer')!;
    expect(footer.querySelector('[data-testid="global-variables"]')?.getAttribute('href')).toBe(
      '/variables',
    );
    expect(footer.querySelector('[data-testid="ssh-keys"]')?.getAttribute('href')).toBe('/keys');
    expect(footer.querySelector('[data-testid="settings"]')?.getAttribute('href')).toBe(
      '/settings',
    );
  });
});
