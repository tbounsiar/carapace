import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslocoService } from '@jsverse/transloco';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import { ConfigService } from '../../../core/ipc/config';
import { collection, fakeConfig, host, project } from '../../../core/ipc/config.fixture';
import { SshService } from '../../../core/ipc/ssh';
import { HostConnector } from '../../host-connection/host-connector';
import { HostLauncher } from '../../host-connection/host-launcher';
import { MoveLauncher } from '../../project-tree/move-launcher';
import { scopeTree } from '../../project-tree/node-tree';
import { ProjectActions } from '../../project-tree/project-actions';
import { type HostGroup, hostGroups } from '../board';
import { HostGroups } from './host-groups';

const NODES = [
  collection('b', 'Backend', 'p1'),
  collection('l', 'Legacy', 'p1', 'b'),
  host('h1', 'api-1', 'p1', 'b'),
  host('h2', 'api-2', 'p1', 'b'),
  host('h3', 'old', 'p1', 'l'),
  host('h4', 'bastion', 'p1'),
];
const groups = signal<HostGroup[]>([]);
let emptied = 0;

@Component({
  imports: [HostGroups, TuiRoot],
  template:
    '<tui-root><app-host-groups [groups]="groups()" (lastRemoved)="onEmptied()" /></tui-root>',
})
class Shell {
  protected readonly groups = groups;
  protected onEmptied(): void {
    emptied++;
  }
}

describe('HostGroups', () => {
  let fixture: ComponentFixture<Shell>;
  let config: ReturnType<typeof fakeConfig>;
  const actions = { editHost: vi.fn(), deleteHost: vi.fn(() => Promise.resolve(true)) };
  const byId = (id: string): HTMLElement | null =>
    document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const settle = async () => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };
  const remove = async (name: string, nodes: typeof NODES) => {
    byId(`card-menu-${name}`)!.click();
    await settle();
    byId('menu-delete')!.click();
    config.nodes.set(nodes);
    groups.set(hostGroups(scopeTree(nodes, 'p1'), 'Payments'));
    await settle();
    await new Promise((r) => setTimeout(r));
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    emptied = 0;
    config = fakeConfig();
    config.projects.set([project('p1', 'Payments')]);
    config.nodes.set(NODES);
    await TestBed.configureTestingModule({
      imports: [Shell],
      providers: [
        provideTaiga(),
        provideRouter([]),
        { provide: ConfigService, useValue: config },
        { provide: SshService, useValue: { states: signal({}) } },
        { provide: HostConnector, useValue: { connect: vi.fn(), disconnect: vi.fn() } },
        { provide: HostLauncher, useValue: { open: vi.fn() } },
        { provide: ProjectActions, useValue: actions },
        { provide: MoveLauncher, useValue: { openDialog: vi.fn() } },
      ],
    }).compileComponents();
    // The global `translate` behind `uiText` needs the service to exist.
    TestBed.inject(TranslocoService);
    groups.set(hostGroups(scopeTree(NODES, 'p1'), 'Payments'));
    fixture = TestBed.createComponent(Shell);
    await settle();
  });

  it('renders one labelled section per path, root first, with its cards', () => {
    const sections = [...document.body.querySelectorAll<HTMLElement>('section')];
    expect(sections.map((s) => s.getAttribute('data-testid'))).toEqual([
      'host-group-Payments',
      'host-group-Payments/Backend',
      'host-group-Payments/Backend/Legacy',
    ]);
    const heading = document.getElementById(sections[2].getAttribute('aria-labelledby')!);
    expect(heading?.textContent?.trim()).toBe('Backend / Legacy');
    expect(sections[0].textContent).toContain('Payments (top level)');
    expect(
      [...sections[1].querySelectorAll('[data-testid^="card-host-"]')].map((c) =>
        c.getAttribute('data-testid'),
      ),
    ).toEqual(['card-host-api-1', 'card-host-api-2']);
  });

  it('moves focus to the next card after a delete, else the previous one', async () => {
    await remove(
      'api-1',
      NODES.filter((n) => n.id !== 'h1'),
    );
    expect(document.activeElement).toBe(byId('card-open-api-2'));
  });

  it('reports when the last card is gone', async () => {
    const only = [host('h4', 'bastion', 'p1')];
    config.nodes.set(only);
    groups.set(hostGroups(scopeTree(only, 'p1'), 'Payments'));
    await settle();
    await remove('bastion', []);
    expect(emptied).toBe(1);
  });
});
