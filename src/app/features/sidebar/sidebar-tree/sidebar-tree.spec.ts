import { TranslocoService } from '@jsverse/transloco';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideTaiga, TuiNotificationService, TuiRoot } from '@taiga-ui/core';
import { TuiNavigation } from '@taiga-ui/layout';
import { of } from 'rxjs';
import { ConfigService } from '../../../core/ipc/config';
import { collection, fakeConfig, host, project } from '../../../core/ipc/config.fixture';
import { IpcError } from '../../../core/ipc/ipc-error';
import { SshService } from '../../../core/ipc/ssh';
import type { ConnectionState } from '../../../core/ipc/ssh.models';
import { HostConnector } from '../../host-connection/host-connector';
import { HostLauncher } from '../../host-connection/host-launcher';
import { Workspace } from '../../workspace/workspace';
import { MoveLauncher } from '../../project-tree/move-launcher';
import { ProjectActions } from '../../project-tree/project-actions';
import { SidebarDrag } from '../sidebar-drag';
import { SidebarFilter } from '../sidebar-filter';
import { SidebarState } from '../sidebar-state';
import { SidebarTree } from './sidebar-tree';

@Component({
  imports: [SidebarTree, TuiNavigation, TuiRoot],
  template: `<tui-root
    ><aside [tuiNavigationAside]="true"><app-sidebar-tree /></aside
  ></tui-root>`,
})
class Host {}

@Component({ template: '' })
class Blank {}

const DEPTH = 8;

describe('SidebarTree', () => {
  let config: ReturnType<typeof fakeConfig>;
  let fixture: ComponentFixture<Host>;
  const states = signal<Record<string, ConnectionState>>({});
  const ssh = { states, loadConnections: vi.fn(() => Promise.resolve([])) };
  const connector = { connect: vi.fn(), disconnect: vi.fn() };
  const launcher = { openTerminal: vi.fn(), newTerminal: vi.fn(), openFiles: vi.fn() };
  const actions = {
    createProject: vi.fn(),
    renameProject: vi.fn(),
    deleteProject: vi.fn(),
    addHost: vi.fn(),
    editHost: vi.fn(),
    deleteHost: vi.fn(),
    addCollection: vi.fn(),
    renameCollection: vi.fn(),
    deleteCollection: vi.fn(),
  };
  const moves = { openDialog: vi.fn(), drop: vi.fn(), canDrop: vi.fn(() => true) };
  const alerts = { open: vi.fn(() => of(undefined)) };

  const byId = (id: string): HTMLElement | null =>
    document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const settle = async (): Promise<void> => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };
  const key = async (target: HTMLElement, k: string, init: KeyboardEventInit = {}) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
    await settle();
  };
  const go = async (url: string): Promise<void> => {
    await TestBed.inject(Router).navigateByUrl(url);
    await settle();
  };

  async function setup(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideTaiga(),
        provideRouter([{ path: '**', component: Blank }]),
        { provide: ConfigService, useValue: config },
        { provide: SshService, useValue: ssh },
        { provide: HostConnector, useValue: connector },
        { provide: HostLauncher, useValue: launcher },
        { provide: ProjectActions, useValue: actions },
        { provide: MoveLauncher, useValue: moves },
        { provide: TuiNotificationService, useValue: alerts },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    await settle();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    states.set({});
    config = fakeConfig();
    config.projects.set([project('p2', 'Shop'), project('p1', 'Payments')]);
    config.nodes.set([
      collection('c1', 'Lab'),
      host('h1', 'pi-hole', null, 'c1'),
      host('h2', 'my-vps'),
      collection('c2', 'Backend', 'p1'),
      host('h3', 'api-1', 'p1', 'c2'),
      host('h4', 'bastion', 'p1'),
      collection('c9', 'Empty', 'p1'),
    ]);
  });

  describe('at Home', () => {
    beforeEach(setup);

    it('loads the config and the connections', () => {
      expect(ssh.loadConnections).toHaveBeenCalledOnce();
      expect(byId('sidebar-tree')).not.toBeNull();
    });

    it('shows root collections and hosts, then the projects sorted', () => {
      expect(byId('tree-collection-Lab')?.getAttribute('aria-expanded')).not.toBe('true');
      expect(byId('tree-host-my-vps')).not.toBeNull();
      expect(byId('tree-host-api-1')).toBeNull();
      const section = byId('projects-section')!;
      expect(
        [...section.querySelectorAll('[data-testid^="tree-project-"]')].map((e) =>
          e.textContent?.trim(),
        ),
      ).toEqual(['Payments', 'Shop']);
    });

    it('toggles a collection by click and persists the state', async () => {
      byId('tree-collection-Lab')!.click();
      await settle();
      expect(byId('tree-collection-Lab')?.getAttribute('aria-expanded')).toBe('true');
      expect(TestBed.inject(SidebarState).isOpen('c1')).toBe(true);
      expect(byId('open-host-pi-hole')).not.toBeNull();
    });

    it('selects a project on click and enters it on double-click or the Open button', async () => {
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      const row = byId('tree-project-Payments')!;
      row.click();
      await settle();
      expect(navigate).not.toHaveBeenCalled();
      expect(row.hasAttribute('data-state')).toBe(false);
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      expect(navigate).toHaveBeenCalledWith(['/projects', 'p1']);
      byId('open-project-Shop')!.click();
      expect(navigate).toHaveBeenCalledWith(['/projects', 'p2']);
    });

    it('enters a project with Enter', async () => {
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      await key(byId('tree-project-Shop')!, 'Enter');
      expect(navigate).toHaveBeenCalledWith(['/projects', 'p2']);
    });

    it('marks a project with open connections', async () => {
      states.set({ h3: 'connected' });
      await settle();
      expect(
        byId('tree-project-Payments')?.querySelector('[role="img"]')?.getAttribute('aria-label'),
      ).toBe('1 open connection');
    });

    it('has a single tab stop and moves with the arrow keys', async () => {
      const lab = byId('tree-collection-Lab')!;
      expect(lab.tabIndex).toBe(0);
      expect(byId('open-host-my-vps')!.tabIndex).toBe(-1);
      lab.focus();
      await key(lab, 'ArrowRight');
      expect(lab.getAttribute('aria-expanded')).toBe('true');
      await key(lab, 'ArrowDown');
      expect(document.activeElement).toBe(byId('open-host-pi-hole'));
      await key(document.activeElement as HTMLElement, 'ArrowLeft');
      expect(document.activeElement).toBe(lab);
      await key(lab, 'End');
      expect(document.activeElement).toBe(byId('tree-project-Shop'));
    });

    it('runs the item shortcuts', async () => {
      const lab = byId('tree-collection-Lab')!;
      await key(lab, 'F2');
      expect(actions.renameCollection).toHaveBeenCalledWith(config.findNode('c1'));
      await key(lab, 'Delete');
      expect(actions.deleteCollection).toHaveBeenCalled();
      await key(lab, 'F6');
      expect(moves.openDialog).toHaveBeenCalledWith(config.findNode('c1'));
      await key(lab, 'n', { ctrlKey: true });
      expect(actions.addHost).toHaveBeenCalledWith({ projectId: null, parentId: 'c1' });
      await key(byId('open-host-my-vps')!, 'N', { ctrlKey: true, shiftKey: true });
      expect(actions.addCollection).toHaveBeenCalledWith({ projectId: null, parentId: null });
      await key(byId('tree-project-Shop')!, 'F2');
      expect(actions.renameProject).toHaveBeenCalledWith(config.findProject('p2'));
    });

    it('opens the item menu from the keyboard', async () => {
      await key(byId('open-host-my-vps')!, 'F10', { shiftKey: true });
      expect(byId('menu-connect')).not.toBeNull();
      byId('menu-move')!.click();
      expect(moves.openDialog).toHaveBeenCalledWith(config.findNode('h2'));
    });

    it('offers New host here and New collection here in a collection menu', async () => {
      byId('menu-collection-Lab')!.click();
      await settle();
      expect(byId('tree-collection-Lab')?.getAttribute('aria-expanded')).not.toBe('true');
      byId('menu-add')!.click();
      expect(actions.addHost).toHaveBeenCalledWith({ projectId: null, parentId: 'c1' });
      await settle();
      byId('menu-collection-Lab')!.click();
      await settle();
      byId('menu-add-collection')!.click();
      expect(actions.addCollection).toHaveBeenCalledWith({ projectId: null, parentId: 'c1' });
    });

    it('starts the host menu with New terminal and Browse files', async () => {
      byId('menu-host-my-vps')!.click();
      await settle();
      const ids = [...document.body.querySelectorAll('tui-data-list [data-testid]')].map((e) =>
        e.getAttribute('data-testid'),
      );
      expect(ids.slice(0, 3)).toEqual(['menu-new-terminal', 'menu-open-files', 'menu-connect']);
      byId('menu-new-terminal')!.click();
      expect(launcher.newTerminal).toHaveBeenCalledWith(config.findNode('h2'));
      await settle();
      byId('menu-host-my-vps')!.click();
      await settle();
      byId('menu-open-files')!.click();
      expect(launcher.openFiles).toHaveBeenCalledWith(config.findNode('h2'));
    });

    it('opens a single menu on right click, also with the "…" menu already open', async () => {
      const menus = () => document.body.querySelectorAll('[data-testid="menu-new-terminal"]');
      const rightClick = async (id: string) => {
        byId(id)!.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 20,
            clientY: 20,
          }),
        );
        await settle();
      };
      await rightClick('open-host-my-vps');
      expect(menus().length).toBe(1);
      expect(byId('menu-host-my-vps')?.getAttribute('aria-expanded')).not.toBe('true');
      expect(byId('tree-host-my-vps')?.classList).not.toContain('_menu');

      byId('menu-new-terminal')!.click();
      expect(launcher.newTerminal).toHaveBeenCalledWith(config.findNode('h2'));
      await settle();
      expect(menus().length).toBe(0);

      byId('menu-host-my-vps')!.click();
      await settle();
      expect(menus().length).toBe(1);
      await rightClick('open-host-my-vps');
      await settle();
      expect(menus().length).toBe(1);
      expect(byId('menu-host-my-vps')?.getAttribute('aria-expanded')).not.toBe('true');
    });

    it('focuses or opens the terminal on a host double-click', async () => {
      byId('open-host-my-vps')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      expect(launcher.openTerminal).toHaveBeenCalledWith(config.findNode('h2'));
    });

    it('marks the host of the active tab selected and reveals it', async () => {
      const tab = TestBed.inject(Workspace).add({
        key: 'files:h1',
        kind: 'files',
        hostId: 'h1',
        label: 'Files',
        status: signal({ kind: 'connected' as const, word: 'Connected' }),
      });
      await go(`/tabs/${tab.id}`);
      expect(byId('tree-host-pi-hole')?.classList).toContain('_selected');
      expect(byId('open-host-pi-hole')?.classList).toContain('_active');
      expect(byId('tree-collection-Lab')?.getAttribute('aria-expanded')).toBe('true');
      expect(byId('tree-host-my-vps')?.classList).not.toContain('_selected');
      expect(byId('open-host-my-vps')?.classList).not.toContain('_active');
      expect(document.activeElement).not.toBe(byId('open-host-pi-hole'));
    });

    it('connects a host from its row', async () => {
      byId('connect-host-my-vps')!.click();
      expect(connector.connect).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: null, connectionId: 'h2' }),
      );
    });

    it('drops a host on a project and on a collection', async () => {
      const drag = TestBed.inject(SidebarDrag);
      drag.start('h2');
      const over = new MouseEvent('dragover', { bubbles: true, cancelable: true });
      byId('tree-project-Payments')!.dispatchEvent(over);
      await settle();
      expect(over.defaultPrevented).toBe(true);
      expect(byId('tree-project-Payments')!.closest('[data-drop-target="true"]')).not.toBeNull();
      byId('tree-project-Payments')!.dispatchEvent(
        new MouseEvent('drop', { bubbles: true, cancelable: true }),
      );
      expect(moves.drop).toHaveBeenCalledWith(config.findNode('h2'), {
        projectId: 'p1',
        parentId: null,
      });
      expect(drag.nodeId()).toBeNull();

      drag.start('h2');
      byId('tree-collection-Lab')!.dispatchEvent(
        new MouseEvent('drop', { bubbles: true, cancelable: true }),
      );
      expect(moves.drop).toHaveBeenLastCalledWith(config.findNode('h2'), {
        projectId: null,
        parentId: 'c1',
      });
    });

    it('refuses a drop the rules forbid', async () => {
      moves.canDrop.mockReturnValue(false);
      TestBed.inject(SidebarDrag).start('c1');
      const over = new MouseEvent('dragover', { bubbles: true, cancelable: true });
      byId('tree-collection-Lab')!.dispatchEvent(over);
      expect(over.defaultPrevented).toBe(false);
      moves.canDrop.mockReturnValue(true);
    });
  });

  describe('filtered', () => {
    let filter: SidebarFilter;

    beforeEach(async () => {
      await setup();
      filter = TestBed.inject(SidebarFilter);
    });

    it('shows matches with their collections open, without saving the expanded state', async () => {
      filter.set('pi');
      await settle();
      expect(byId('tree-collection-Lab')?.getAttribute('aria-expanded')).toBe('true');
      expect(byId('open-host-pi-hole')).not.toBeNull();
      expect(byId('tree-host-my-vps')).toBeNull();
      expect(byId('projects-section')).toBeNull();
      expect(TestBed.inject(SidebarState).isOpen('c1')).toBe(false);

      byId('tree-collection-Lab')!.click();
      await settle();
      expect(byId('tree-collection-Lab')?.getAttribute('aria-expanded')).not.toBe('true');
      expect(TestBed.inject(SidebarState).isOpen('c1')).toBe(false);

      filter.clear();
      await settle();
      expect(byId('tree-collection-Lab')?.getAttribute('aria-expanded')).not.toBe('true');
      expect(byId('tree-host-my-vps')).not.toBeNull();
    });

    it('keeps the projects whose name matches', async () => {
      filter.set('shop');
      await settle();
      const section = byId('projects-section')!;
      expect(section.querySelectorAll('[data-testid^="tree-project-"]').length).toBe(1);
      expect(byId('tree-project-Shop')).not.toBeNull();
      expect(byId('tree-collection-Lab')).toBeNull();
    });

    it('shows the no-match state and clears the filter from it', async () => {
      filter.set('zzz');
      await settle();
      expect(byId('sidebar-no-match')?.textContent).toContain('No host matches “zzz”');
      const before = filter.fieldFocus();
      byId('sidebar-clear-filter')!.click();
      await settle();
      expect(filter.query()).toBe('');
      expect(filter.fieldFocus()).toBe(before + 1);
      expect(byId('tree-collection-Lab')).not.toBeNull();
    });

    it('renders in French after a language switch', async () => {
      TestBed.inject(TranslocoService).setActiveLang('fr');
      filter.set('zzz');
      await settle();
      expect(byId('sidebar-no-match')?.textContent).toContain('Aucun hôte ne correspond à « zzz »');
      expect(byId('sidebar-clear-filter')?.textContent?.trim()).toBe('Effacer le filtre');
    });

    it('moves between the field and the first row', async () => {
      filter.set('pi');
      await settle();
      filter.focusTree();
      await settle();
      expect(document.activeElement).toBe(byId('tree-collection-Lab'));
      const before = filter.fieldFocus();
      await key(byId('tree-collection-Lab')!, 'ArrowUp');
      expect(filter.fieldFocus()).toBe(before + 1);
    });
  });

  describe('in a project', () => {
    beforeEach(async () => {
      await setup();
      await go('/projects/p1');
    });

    it('shows only the project nodes, an empty collection with Add host', async () => {
      expect(byId('projects-section')).toBeNull();
      expect(byId('tree-collection-Lab')).toBeNull();
      expect(byId('tree-host-bastion')).not.toBeNull();
      byId('tree-collection-Empty')!.click();
      await settle();
      byId('empty-add-Empty')!.click();
      expect(actions.addHost).toHaveBeenCalledWith({ projectId: 'p1', parentId: 'c9' });
    });

    it('leaves the project with Alt+ArrowUp', async () => {
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      await key(byId('open-host-bastion')!, 'ArrowUp', { altKey: true });
      expect(navigate).toHaveBeenCalledWith(['/']);
    });

    it('expands the ancestors of the open host', async () => {
      await go('/hosts/h3');
      expect(byId('tree-collection-Backend')?.getAttribute('aria-expanded')).toBe('true');
      expect(byId('open-host-api-1')!.tabIndex).toBe(0);
    });

    it('marks a collapsed collection that holds the open host', async () => {
      await go('/hosts/h3');
      const head = byId('tree-collection-Backend')!;
      expect(head.classList).not.toContain('_holds-active');
      head.click();
      await settle();
      expect(head.classList).toContain('_holds-active');
    });

    it('selects the left project back at Home', async () => {
      await go('/');
      expect(byId('tree-project-Payments')?.tabIndex).toBe(0);
      expect(document.activeElement).toBe(byId('tree-project-Payments'));
    });
  });

  it('nests collections at any depth', async () => {
    const chain = Array.from({ length: DEPTH }, (_, i) =>
      collection(`d${i}`, `level-${i}`, null, i ? `d${i - 1}` : null),
    );
    config.nodes.set([...chain, host('deep', 'deep-host', null, `d${DEPTH - 1}`)]);
    localStorage.setItem('carapace.expanded', JSON.stringify(chain.map((c) => c.id)));
    await setup();
    const leaf = byId('open-host-deep-host')!;
    expect(leaf).not.toBeNull();
    let groups = 0;
    for (let el: Element | null = leaf; el; el = el.parentElement) {
      groups += el.tagName === 'TUI-ASIDE-GROUP' ? 1 : 0;
    }
    expect(groups).toBe(DEPTH);
    expect(document.body.querySelectorAll('.level._indent').length).toBe(5);
  });

  it('shows the empty and error states', async () => {
    config.projects.set([]);
    config.nodes.set([]);
    await setup();
    expect(byId('sidebar-empty')?.textContent).toContain('Nothing here yet');
    expect(byId('sidebar-empty')?.querySelector('h2')).toBeNull();
    byId('sidebar-empty-new-host')!.click();
    expect(actions.addHost).toHaveBeenCalledWith({ projectId: null, parentId: null });
    config.loaded.set(false);
    vi.spyOn(config, 'load').mockRejectedValueOnce(new IpcError('io', 'disk gone'));
    fixture.destroy();
    fixture = TestBed.createComponent(Host);
    await settle();
    expect(byId('projects-error')?.textContent).toContain('Hosts could not be loaded');
    byId('projects-retry')!.click();
    await settle();
    expect(byId('projects-error')).toBeNull();
  });
});
