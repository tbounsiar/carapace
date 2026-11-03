import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTaiga } from '@taiga-ui/core';
import { App } from './app';
import { ConfigService } from './core/ipc/config';
import type { Project } from './core/ipc/config.models';
import { ThemeService } from './core/theme/theme';

const projects = signal<Project[]>([]);
const prodProject: Project = {
  id: 'p1',
  name: 'Shop',
  variables: [],
  environments: [{ id: 'e1', name: 'Production', variables: [] }],
  hosts: [],
  activeEnvironmentId: 'e1',
};

describe('App', () => {
  beforeEach(async () => {
    localStorage.clear();
    projects.set([]);
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([]),
        provideTaiga(),
        {
          provide: ConfigService,
          useValue: {
            projects,
            variables: signal([]),
            loading: signal(false),
            load: () => Promise.resolve(),
          },
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

  it('links the sidebar footer to the global variables', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const link = (fixture.nativeElement as HTMLElement).querySelector(
      'aside footer [data-testid="global-variables"]',
    );
    expect(link?.getAttribute('href')).toBe('/variables');
  });

  it('links the SSH keys page from the sidebar footer', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const link = (fixture.nativeElement as HTMLElement).querySelector(
      'aside footer [data-testid="ssh-keys"]',
    );
    expect(link?.getAttribute('href')).toBe('/keys');
    expect(link?.textContent).toContain('SSH keys');
  });

  it('links the settings page from the sidebar footer', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const link = (fixture.nativeElement as HTMLElement).querySelector(
      'aside footer [data-testid="settings"]',
    );
    expect(link?.getAttribute('href')).toBe('/settings');
    expect(link?.textContent).toContain('Settings');
  });

  it('keeps the header toggle in sync with a theme set elsewhere', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    TestBed.inject(ThemeService).setMode('dark');
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="theme-dark"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(el.querySelector('[data-testid="theme-system"]')?.getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('shows the environment selector and a prod accent on the header', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const header = el.querySelector('header[tuiNavigationHeader]')!;
    expect(header.classList).not.toContain('_prod');
    projects.set([prodProject]);
    await fixture.whenStable();
    expect(header.querySelector('[data-testid="env-select"]')).not.toBeNull();
    expect(header.classList).toContain('_prod');
  });
});
