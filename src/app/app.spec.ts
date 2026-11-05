import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { TuiThemeColorService } from '@taiga-ui/addon-mobile';
import { provideTaiga } from '@taiga-ui/core';
import { signal } from '@angular/core';
import { App } from './app';
import { ConfigService } from './core/ipc/config';
import { EditedFiles } from './core/ipc/edited-files';
import { editedFile } from './core/ipc/external-edits.fixture';
import { fakeConfig, project } from './core/ipc/config.fixture';
import { SshService } from './core/ipc/ssh';
import { ThemeService } from './core/theme/theme';
import { TranslocoService } from '@jsverse/transloco';

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
  });

  it('re-themes the header and aside with the app theme and sets the chrome colour', async () => {
    const color = TestBed.inject(TuiThemeColorService);
    const fixture = await setup();
    TestBed.inject(ThemeService).apply('light');
    await fixture.whenStable();
    expect(el().querySelector('header[tuiNavigationHeader]')?.getAttribute('tuiTheme')).toBe(
      'light',
    );
    expect(el().querySelector('aside[tuiNavigationAside]')?.getAttribute('tuiTheme')).toBe('light');
    expect(el().querySelector('tui-root')?.getAttribute('tuiTheme')).toBe('light');
    expect(typeof color.color).toBe('string');
  });

  it('names the project in the selector, with the filter and New in the aside header', async () => {
    config.projects.set([project('p1', 'Shop')]);
    const fixture = await setup();
    await TestBed.inject(Router).navigateByUrl('/projects/p1');
    await fixture.whenStable();
    expect(byId('project-select')?.textContent?.trim()).toBe('Shop');
    expect(byId('aside-project')).toBeNull();
    expect(byId('project-variables')).toBeNull();
    const header = el().querySelector('aside[tuiNavigationAside] > header')!;
    expect(header.querySelector('[data-testid="sidebar-filter"]')).not.toBeNull();
    expect(header.querySelector('[data-testid="aside-new"]')).not.toBeNull();
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

  it('shows Edited files first in the footer only while files are edited, with the attention badge', async () => {
    const fixture = await setup();
    expect(byId('aside-edited-files')).toBeNull();
    const store = TestBed.inject(EditedFiles);
    store.reset([editedFile('e1', 'h1', '/a'), editedFile('e2', 'h1', '/b')]);
    await fixture.whenStable();
    const item = byId('aside-edited-files')!;
    expect(el().querySelector('aside footer')?.firstElementChild).toBe(item);
    expect(item.getAttribute('href')).toBe('/edited-files');
    expect(byId('aside-edited-count')?.textContent?.trim()).toBe('2');
    expect(byId('aside-edited-attention')).toBeNull();
    expect(item.getAttribute('aria-label')).toBe('Edited files, 2 files');
    store.upsert(editedFile('e2', 'h1', '/b', { state: 'conflict', needsAttention: true }));
    await fixture.whenStable();
    expect(byId('aside-edited-attention')?.textContent?.trim()).toBe('1');
    expect(byId('aside-edited-attention')?.getAttribute('data-appearance')).toBe('warning');
    expect(item.getAttribute('aria-label')).toBe('Edited files, 2 files, 1 needs attention');
    store.reset([]);
    await fixture.whenStable();
    expect(byId('aside-edited-files')).toBeNull();
  });

  it('names the aside footer pages in French', async () => {
    const fixture = await setup();
    TestBed.inject(TranslocoService).setActiveLang('fr');
    await fixture.whenStable();
    expect(byId('settings')?.textContent?.trim()).toBe('Paramètres');
    expect(byId('ssh-keys')?.textContent?.trim()).toBe('Clés SSH');
    TestBed.inject(EditedFiles).reset([editedFile('e1', 'h1', '/a')]);
    await fixture.whenStable();
    expect(byId('aside-edited-files')?.getAttribute('aria-label')).toBe(
      'Fichiers édités, 1 fichier',
    );
  });
});
