import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import { TuiNavigation } from '@taiga-ui/layout';
import { ConfigService } from '../../../core/ipc/config';
import { collection, fakeConfig, host, project } from '../../../core/ipc/config.fixture';
import { HostLauncher } from '../../host-connection/host-launcher';
import { ProjectActions } from '../../project-tree/project-actions';
import { SidebarFilter } from '../sidebar-filter';
import { SidebarState } from '../sidebar-state';
import { AsideHeader } from './aside-header';

@Component({
  imports: [AsideHeader, TuiNavigation, TuiRoot],
  template: `<tui-root>
    <aside [tuiNavigationAside]="true">
      <header><app-aside-header /></header>
    </aside>
    <div class="terminal-host"><textarea data-testid="xterm-input"></textarea></div>
  </tui-root>`,
})
class Host {}

@Component({ template: '' })
class Blank {}

describe('AsideHeader', () => {
  let fixture: ComponentFixture<Host>;
  let config: ReturnType<typeof fakeConfig>;
  const actions = { addHost: vi.fn(), addCollection: vi.fn(), createProject: vi.fn() };
  const launcher = { openTerminal: vi.fn(() => Promise.resolve()) };
  const byId = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
    document.body.querySelector<T>(`[data-testid="${id}"]`);
  const field = () => byId<HTMLInputElement>('sidebar-filter')!;
  const settle = async () => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };
  const openNew = async () => {
    byId('aside-new')!.click();
    await settle();
  };
  const type = async (value: string) => {
    field().value = value;
    field().dispatchEvent(new Event('input'));
    await settle();
  };
  const press = (key: string, target: Element = field(), init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    config = fakeConfig();
    config.projects.set([project('p1', 'Payments')]);
    config.nodes.set([
      collection('c1', 'Lab'),
      host('h1', 'pi-hole', null, 'c1'),
      host('h2', 'vps'),
    ]);
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideTaiga(),
        provideRouter([{ path: '**', component: Blank }]),
        { provide: ConfigService, useValue: config },
        { provide: ProjectActions, useValue: actions },
        { provide: HostLauncher, useValue: launcher },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    await settle();
  });

  it('has one toolbar row: the filter and the New menu, with New project at Home', async () => {
    expect(byId('aside-project')).toBeNull();
    expect(byId('project-variables')).toBeNull();
    expect(field().placeholder).toBe('Filter hosts');
    expect(byId('aside-new')?.getAttribute('aria-label')).toBe('New');
    await openNew();
    byId('new-project')!.click();
    expect(actions.createProject).toHaveBeenCalledOnce();
    await settle();
    await openNew();
    byId('new-host')!.click();
    expect(actions.addHost).toHaveBeenCalledWith({ projectId: null, parentId: null });
  });

  it('creates at the project root inside a project, without New project', async () => {
    await TestBed.inject(Router).navigateByUrl('/projects/p1');
    await settle();
    await openNew();
    expect(byId('new-project')).toBeNull();
    byId('new-collection')!.click();
    expect(actions.addCollection).toHaveBeenCalledWith({ projectId: 'p1', parentId: null });
  });

  it('filters as the user types and clears with Escape', async () => {
    const filter = TestBed.inject(SidebarFilter);
    await type('pi');
    expect(filter.query()).toBe('pi');
    expect(press('Escape').defaultPrevented).toBe(true);
    await settle();
    expect(filter.query()).toBe('');
    expect(field().value).toBe('');
    expect(press('Escape').defaultPrevented).toBe(false);
  });

  it('empties the field on Enter when the text was typed and cleared before a render', async () => {
    field().value = 'pi';
    field().dispatchEvent(new Event('input'));
    press('Enter');
    await settle();
    expect(launcher.openTerminal).toHaveBeenCalledWith(expect.objectContaining({ id: 'h1' }));
    expect(TestBed.inject(SidebarFilter).query()).toBe('');
    expect(field().value).toBe('');
  });

  it('opens, connects and opens a terminal on the first match with Enter', async () => {
    await type('PI');
    press('Enter');
    await settle();
    expect(launcher.openTerminal).toHaveBeenCalledWith(expect.objectContaining({ id: 'h1' }));
    expect(TestBed.inject(SidebarFilter).query()).toBe('');
    const state = TestBed.inject(SidebarState);
    expect(state.isOpen('c1')).toBe(true);
    // The focus goes into the terminal; the sidebar only reveals the row.
    expect(state.focusRequest()).toBeNull();
  });

  it('enters the first matching project when no host matches', async () => {
    await type('pay');
    press('Enter');
    await settle();
    expect(launcher.openTerminal).not.toHaveBeenCalled();
    expect(TestBed.inject(Router).url).toBe('/projects/p1');
  });

  it('asks the tree for focus with ArrowDown', async () => {
    const filter = TestBed.inject(SidebarFilter);
    const before = filter.treeFocus();
    press('ArrowDown');
    expect(filter.treeFocus()).toBe(before + 1);
  });

  it('focuses the filter with Ctrl+K, except inside a terminal', async () => {
    const terminal = byId('xterm-input')!;
    terminal.focus();
    expect(press('k', terminal, { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(terminal);
    expect(press('k', document.body, { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(field());
  });

  it('disables the filter when the scope has nothing to filter', async () => {
    config.nodes.set([]);
    config.projects.set([]);
    await settle();
    expect(field().disabled).toBe(true);
  });
});
